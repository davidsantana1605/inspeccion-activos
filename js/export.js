// Export screen: batched ZIP export (brief section 8), delete-exported, full backup / restore.
// Notes on design:
//  - A first pass reads only blob sizes (Blob objects are lazy references in IndexedDB) so parts are
//    planned up front and manifest.json can carry the real total_parts.
//  - Each part is built with fflate's streaming Zip (STORE for photos/audio, deflate for text) reading ONE
//    asset at a time; output chunks of the part are kept in memory and turned into a Blob when the part ends.
//  - IndexedDB rule: inside db.tx() callbacks we only await IndexedDB requests.
import { Zip, ZipPassThrough, ZipDeflate, unzipSync, strToU8, strFromU8 } from '../vendor/fflate.esm.js';
import * as db from './db.js';
import { APP_VERSION } from './version.js';
import { csvEscape, buildingsToCsv } from './csv.js';
import { getSavedAssets, getMedia, isPending, deleteAsset, folderName, blobId, nowIso } from './data.js';

const PART_OVERHEAD = 4096; // estimated bytes of JSON/CSV/txt per asset for partition planning
const CSV_COLUMNS = ['id', 'seq', 'inspector', 'created_at', 'building_code', 'building_name', 'floor', 'department', 'notes', 'n_photos', 'n_audios', 'folder', 'gps_lat', 'gps_lon', 'gps_accuracy_m'];

// ---------------------------------------------------------------- pure helpers (testable in Node)

export const pad2 = (n) => String(n).padStart(2, '0');
export const fileStamp = (d = new Date()) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;

const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif', 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3' };
const extOf = (rec, fallback) => String(rec.ext || MIME_EXT[String(rec.mime_type || '').split(';')[0]] || fallback).replace(/[^\w]/g, '') || fallback;

// File names for the media of one asset. Photos with source 'gallery' + is_screenshot -> captura_NN, others foto_NN.
// Inputs must already be sorted by `order`. Returns arrays of names aligned with the inputs.
export function mediaNames(photos, audios) {
  let f = 0; let c = 0; let a = 0;
  const num = (n) => String(n).padStart(2, '0');
  const photoNames = photos.map((p) => (p.source === 'gallery' && p.is_screenshot ? `captura_${num(++c)}.${extOf(p, 'png')}` : `foto_${num(++f)}.${extOf(p, 'jpg')}`));
  const audioNames = audios.map((x) => `audio_${num(++a)}.${extOf(x, 'webm')}`);
  return { photoNames, audioNames };
}

// activo.json document (brief section 8).
export function buildAssetDoc(asset, photos, audios, names, exportedAt, deviceId) {
  return {
    schema_version: 1,
    id: asset.id,
    seq: asset.seq ?? null,
    inspector: asset.inspector ?? '',
    device_id: asset.device_id || deviceId || null,
    app_version: asset.app_version || APP_VERSION,
    created_at: asset.created_at,
    updated_at: asset.updated_at,
    building_code: asset.building_code ?? '',
    building_name: asset.building_name ?? '',
    floor: asset.floor ?? '',
    department: asset.department ?? '',
    notes: asset.notes ?? '',
    gps: asset.gps || { lat: null, lon: null, accuracy_m: null },
    photos: photos.map((p, i) => ({
      file: names.photoNames[i], source: p.source ?? 'camera', is_screenshot: !!p.is_screenshot,
      width: p.width ?? null, height: p.height ?? null, bytes: p.bytes ?? p.blob?.size ?? null,
      resized: !!p.resized, captured_at: p.captured_at ?? null
    })),
    audios: audios.map((x, i) => ({
      file: names.audioNames[i], mime_type: x.mime_type ?? null, duration_s: x.duration_s ?? null,
      recorded_at: x.recorded_at ?? null, transcript: x.transcript ?? null
    })),
    exported_at: exportedAt
  };
}

// activos.csv text: UTF-8 BOM, CRLF, RFC 4180 quoting (commas, quotes, newlines).
export function assetsToCsv(docs) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const d of docs) {
    const row = { ...d, n_photos: d.photos.length, n_audios: d.audios.length, folder: folderName(d), gps_lat: d.gps?.lat ?? '', gps_lon: d.gps?.lon ?? '', gps_accuracy_m: d.gps?.accuracy_m ?? '' };
    lines.push(CSV_COLUMNS.map((k) => csvEscape(row[k])).join(','));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

// notas.txt content.
export const notesText = (a) => String(a.notes ?? '').replace(/\r?\n/g, '\r\n') + '\r\n';

// Split items [{id, size}] into consecutive groups whose summed size stays <= limit.
// A single item bigger than the limit goes alone in its own group. Order is preserved.
export function partitionBySize(items, limit) {
  const parts = [];
  let cur = []; let sum = 0;
  for (const it of items) {
    if (cur.length && sum + it.size > limit) { parts.push(cur); cur = []; sum = 0; }
    cur.push(it); sum += it.size;
  }
  if (cur.length) parts.push(cur);
  return parts;
}

// Scope filter. scope: { type:'pending'|'all'|'building'|'dates', building_code, from, to } (from/to 'YYYY-MM-DD')
export function filterAssets(assets, scope) {
  return assets.filter((a) => {
    if (a.status !== 'saved') return false;
    switch (scope.type) {
      case 'pending': return isPending(a);
      case 'building': return a.building_code === scope.building_code;
      case 'dates': {
        const d = String(a.created_at || '').slice(0, 10);
        return (!scope.from || d >= scope.from) && (!scope.to || d <= scope.to);
      }
      default: return true;
    }
  });
}

export const partFileName = (device8, stamp, n) => `inspeccion_${device8}_${stamp}_parte${n}.zip`;

// Streaming zip writer around fflate. Chunks are accumulated; finish() returns them.
export function createZipWriter() {
  const chunks = [];
  let size = 0;
  let settle;
  const finished = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  finished.catch(() => {});
  const zip = new Zip((err, chunk, final) => {
    if (err) { settle.reject(err); return; }
    chunks.push(chunk); size += chunk.length;
    if (final) settle.resolve();
  });
  return {
    get size() { return size; },
    addStored(name, u8) { const f = new ZipPassThrough(name); zip.add(f); f.push(u8, true); },
    addText(name, text) { const f = new ZipDeflate(name, { level: 6 }); zip.add(f); f.push(strToU8(text), true); },
    async finish() { zip.end(); await finished; return chunks; }
  };
}

const isMemoryError = (e) => !!e && (e instanceof RangeError || e.name === 'QuotaExceededError' || /memory|allocation|quota/i.test(String(e.message || '')));

// ---------------------------------------------------------------- IndexedDB helpers

const wrapReq = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

// Mark exported_at WITHOUT touching updated_at. Skips assets edited after the snapshot we exported.
async function markExported(entries, exportedAt) {
  // entries: [{id, updated_at}] (updated_at = value of the record when read for export)
  await db.tx('assets', 'readwrite', (s) => new Promise((resolve, reject) => {
    let left = entries.length;
    if (!left) { resolve(); return; }
    for (const e of entries) {
      const g = s.get(e.id);
      g.onsuccess = () => {
        const r = g.result;
        if (r && r.updated_at === e.updated_at) s.put({ ...r, exported_at: exportedAt });
        if (--left === 0) resolve();
      };
      g.onerror = () => reject(g.error);
    }
  }));
}

async function readBlobBytes(rec) { return new Uint8Array(await rec.blob.arrayBuffer()); }

async function sizesOf(asset) {
  const [ph, au] = await Promise.all([getMedia(asset.id, 'photo'), getMedia(asset.id, 'audio')]);
  let size = PART_OVERHEAD;
  for (const m of ph) size += m.blob?.size || 0;
  for (const m of au) size += m.blob?.size || 0;
  return size;
}

// ---------------------------------------------------------------- ZIP export

// opts: { scope, maxPartBytes, onProgress(done,total,label), onPart({n, total, name, blob, nAssets}) }
export async function exportZip(h, opts) {
  const { scope, maxPartBytes, onProgress, onPart } = opts;
  const all = await getSavedAssets();
  const assets = filterAssets(all, scope).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || (a.seq ?? 0) - (b.seq ?? 0));
  if (!assets.length) return { parts: 0, assets: 0 };

  const total = assets.length;
  const items = [];
  for (let i = 0; i < total; i++) {
    onProgress?.(i, total, 'Calculando tamaños…');
    items.push({ asset: assets[i], size: await sizesOf(assets[i]) });
  }
  const groups = partitionBySize(items, maxPartBytes);
  const totalParts = groups.length;

  const [inspector, buildings] = await Promise.all([db.getSetting('inspector', ''), db.getAll('buildings')]);
  const buildingsCsv = buildingsToCsv(buildings.map((b) => ({ code: b.code, name: b.name })).sort((a, b) => a.code.localeCompare(b.code, 'es', { numeric: true })));
  const device8 = String(h.state.deviceId || 'sin-id').slice(0, 8);
  const startedAt = new Date();
  const stamp = fileStamp(startedAt);
  const exportedAt = nowIso(startedAt);
  let done = 0;

  for (let p = 0; p < totalParts; p++) {
    const group = groups[p];
    const w = createZipWriter();
    const docs = [];
    const marks = [];
    w.addText('manifest.json', JSON.stringify({
      schema_version: 1, app_version: APP_VERSION, device_id: h.state.deviceId, inspector, exported_at: exportedAt,
      part: p + 1, total_parts: totalParts, n_assets: group.length, filter: scope
    }, null, 2));
    w.addText('edificios.csv', buildingsCsv);
    for (const { asset } of group) {
      onProgress?.(done, total, `Parte ${p + 1} de ${totalParts}`);
      const [photos, audios] = await Promise.all([getMedia(asset.id, 'photo'), getMedia(asset.id, 'audio')]);
      const names = mediaNames(photos, audios);
      const doc = buildAssetDoc(asset, photos, audios, names, exportedAt, h.state.deviceId);
      const dir = `activos/${folderName(asset)}/`;
      w.addText(dir + 'activo.json', JSON.stringify(doc, null, 2));
      w.addText(dir + 'notas.txt', notesText(asset));
      for (let i = 0; i < photos.length; i++) w.addStored(dir + names.photoNames[i], await readBlobBytes(photos[i]));
      for (let i = 0; i < audios.length; i++) w.addStored(dir + names.audioNames[i], await readBlobBytes(audios[i]));
      docs.push(doc);
      marks.push({ id: asset.id, updated_at: asset.updated_at });
      done++;
      onProgress?.(done, total, `Parte ${p + 1} de ${totalParts}`);
    }
    w.addText('activos.csv', assetsToCsv(docs));
    w.addText('activos.json', JSON.stringify(docs, null, 2));
    const chunks = await w.finish();
    const blob = new Blob(chunks, { type: 'application/zip' });
    chunks.length = 0;
    // Only after the part was generated successfully: mark as exported (updated_at untouched).
    await markExported(marks, exportedAt);
    onPart?.({ n: p + 1, total: totalParts, name: partFileName(device8, stamp, p + 1), blob, nAssets: group.length });
    await new Promise((r) => setTimeout(r)); // let the UI breathe between parts
  }
  return { parts: totalParts, assets: total };
}

// ---------------------------------------------------------------- full backup

const settingsKeys = ['inspector', 'photo_quality', 'gps_enabled', 'seq_counter', 'last_context'];

// Strips the Blob and adds file names; keeps uid, order and all metadata.
const metaOf = (rec, file) => { const { blob, ...rest } = rec; return { ...rest, file }; };

export async function exportBackup(h, onProgress) {
  const nowD = new Date();
  const device8 = String(h.state.deviceId || 'sin-id').slice(0, 8);
  const [buildings, departments, assets] = await Promise.all([db.getAll('buildings'), db.getAll('departments'), db.getAll('assets')]);
  const settings = {};
  for (const k of settingsKeys) { const v = await db.getSetting(k, undefined); if (v !== undefined) settings[k] = v; }
  const w = createZipWriter();
  w.addText('backup.json', JSON.stringify({
    schema_version: 1, app_version: APP_VERSION, exported_at: nowIso(nowD), n_assets: assets.length,
    edificios: buildings, departamentos: departments, settings
  }, null, 2));
  assets.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  for (let i = 0; i < assets.length; i++) {
    const a = assets[i];
    onProgress?.(i, assets.length, 'Respaldo');
    const dir = `activos/${a.id}/`;
    const [photos, thumbs, audios] = await Promise.all([getMedia(a.id, 'photo'), getMedia(a.id, 'thumb'), getMedia(a.id, 'audio')]);
    const thumbByUid = new Map(thumbs.map((t) => [t.uid, t]));
    const pMeta = []; const tMeta = []; const aMeta = [];
    const files = [];
    for (const p of photos) { const f = `photo_${p.uid}.${extOf(p, 'jpg')}`; pMeta.push(metaOf(p, f)); files.push([dir + f, p]); thumbByUid.delete(p.uid); }
    for (const t of thumbs) { const f = `thumb_${t.uid}.jpg`; tMeta.push(metaOf(t, f)); files.push([dir + f, t]); }
    for (const x of audios) { const f = `audio_${x.uid}.${extOf(x, 'webm')}`; aMeta.push(metaOf(x, f)); files.push([dir + f, x]); }
    w.addText(dir + 'activo.json', JSON.stringify({ asset: a, photos: pMeta, thumbs: tMeta, audios: aMeta }, null, 2));
    for (const [name, rec] of files) w.addStored(name, await readBlobBytes(rec));
    onProgress?.(i + 1, assets.length, 'Respaldo');
  }
  const chunks = await w.finish();
  const blob = new Blob(chunks, { type: 'application/zip' });
  chunks.length = 0;
  return { blob, name: `respaldo_${device8}_${fileStamp(nowD)}.zip`, nAssets: assets.length };
}

// Restores a backup ZIP (whole file read in memory). Returns { assets, skipped, buildings, departments, settings, errors[] }.
export async function importBackup(file, h, onProgress) {
  const res = { assets: 0, skipped: 0, buildings: 0, departments: 0, settings: 0, errors: [] };
  let files;
  try { files = unzipSync(new Uint8Array(await file.arrayBuffer())); } catch (e) {
    if (isMemoryError(e)) throw new Error('No hay memoria suficiente para abrir este respaldo. Genera respaldos más pequeños o usa un dispositivo con más memoria.');
    throw new Error('El archivo no es un ZIP válido o está dañado.');
  }
  if (!files['backup.json']) throw new Error('El ZIP no contiene backup.json: no es un respaldo de esta app.');
  let backup;
  try { backup = JSON.parse(strFromU8(files['backup.json'])); } catch (_) { throw new Error('backup.json está dañado.'); }
  if (!backup || backup.schema_version !== 1) throw new Error('Versión de respaldo no compatible (schema_version ' + backup?.schema_version + ').');

  // Buildings (merge: add the missing ones, keep existing names).
  const haveB = new Set((await db.getAll('buildings')).map((b) => db.normKey(b.code)));
  const newB = (backup.edificios || []).filter((b) => b && b.code && !haveB.has(db.normKey(b.code)));
  if (newB.length) await db.putMany('buildings', newB.map((b) => ({ code: b.code, name: b.name })));
  res.buildings = newB.length;
  // Departments (merge by key).
  const haveD = new Set((await db.getAll('departments')).map((d) => d.key));
  const newD = (backup.departamentos || []).filter((d) => d && d.key && !haveD.has(d.key));
  if (newD.length) await db.putMany('departments', newD);
  res.departments = newD.length;

  // Assets (merge by id; most recent updated_at wins).
  const dirs = Object.keys(files).filter((k) => /^activos\/[^/]+\/activo\.json$/.test(k));
  let maxSeq = 0;
  for (let i = 0; i < dirs.length; i++) {
    onProgress?.(i, dirs.length, 'Restaurando');
    const key = dirs[i];
    const dir = key.slice(0, key.lastIndexOf('/') + 1);
    try {
      const doc = JSON.parse(strFromU8(files[key]));
      const a = doc.asset;
      if (!a || !a.id || (a.status !== 'saved' && a.status !== 'draft')) throw new Error('registro inválido');
      if (a.seq > maxSeq) maxSeq = a.seq;
      const cur = await db.get('assets', a.id);
      if (cur && String(cur.updated_at) >= String(a.updated_at)) { res.skipped++; continue; }
      const blobs = [];
      for (const [kind, list] of [['photo', doc.photos], ['thumb', doc.thumbs], ['audio', doc.audios]]) {
        for (const m of list || []) {
          const bytes = files[dir + m.file];
          if (!bytes) { res.errors.push(`${a.id.slice(0, 8)}: falta el archivo ${m.file}.`); continue; }
          const { file: _f, ...rec } = m;
          blobs.push({ ...rec, id: blobId(kind, a.id, m.uid), asset_id: a.id, kind, blob: new Blob([bytes], { type: m.mime_type || '' }) });
        }
      }
      await db.tx(['assets', 'blobs'], 'readwrite', async (st) => { st.assets.put(a); for (const b of blobs) st.blobs.put(b); });
      res.assets++;
    } catch (e) {
      res.errors.push(`${key}: ${e.message}`);
      if (isMemoryError(e)) { res.errors.push('Memoria insuficiente: se detuvo la restauración.'); break; }
    }
  }
  // Settings: fill in the missing ones; seq_counter = max of everything. NEVER touch device_id.
  const sett = backup.settings || {};
  for (const k of settingsKeys) {
    if (k === 'seq_counter') continue;
    if (sett[k] !== undefined && (await db.getSetting(k, undefined)) === undefined) { await db.setSetting(k, sett[k]); res.settings++; }
  }
  const seq = Math.max(Number(await db.getSetting('seq_counter', 0)) || 0, Number(sett.seq_counter) || 0, maxSeq);
  if (seq > 0 && seq !== (await db.getSetting('seq_counter', 0))) { await db.setSetting('seq_counter', seq); res.settings++; }
  return res;
}

// ---------------------------------------------------------------- view

export async function viewExport($app, h) {
  const { esc, ask, confirmDlg, download, fmtBytes, reportError, showBanner, hideBanner } = h;
  const canShare = (blob, name) => { try { return !!(navigator.canShare && navigator.canShare({ files: [new File([blob], name, { type: 'application/zip' })] })); } catch (_) { return false; } };
  let busy = false;

  const stats = async () => {
    const saved = await getSavedAssets();
    const pending = saved.filter(isPending).length;
    return { saved, total: saved.length, pending, exported: saved.filter((a) => a.exported_at && !isPending(a)).length };
  };
  const s0 = await stats();
  const buildings = new Map();
  for (const a of s0.saved) if (a.building_code && !buildings.has(a.building_code)) buildings.set(a.building_code, a.building_name);
  const today = nowIso().slice(0, 10);
  const nDrafts = (await db.getAll('assets')).length - s0.total;

  $app.innerHTML = `
    <h1>Exportar</h1>
    <div class="card">
      <dl class="kv">
        <dt>Activos guardados</dt><dd id="x-total">${s0.total}</dd>
        <dt>Pendientes de exportar</dt><dd id="x-pending"><strong>${s0.pending}</strong></dd>
        <dt>Ya exportados</dt><dd id="x-done">${s0.exported}</dd>
      </dl>
      ${nDrafts ? `<p class="muted">${nDrafts} borrador${nDrafts === 1 ? '' : 'es'} sin guardar no se exportan en el ZIP (sí van en el respaldo completo).</p>` : ''}
    </div>
    <div class="card">
      <h2 class="x-h">Exportar a ZIP</h2>
      <label for="x-scope">Alcance</label>
      <select id="x-scope">
        <option value="pending">Solo pendientes (no exportados o editados)</option>
        <option value="all">Todos</option>
        <option value="building">Un edificio</option>
        <option value="dates">Rango de fechas</option>
      </select>
      <div id="x-bld" hidden>
        <label for="x-bsel">Edificio</label>
        <select id="x-bsel">${[...buildings].sort((a, b) => a[0].localeCompare(b[0], 'es', { numeric: true })).map(([c, n]) => `<option value="${esc(c)}">${esc(c)} — ${esc(n)}</option>`).join('') || '<option value="">(sin edificios en los activos)</option>'}</select>
      </div>
      <div id="x-dates" class="row" hidden>
        <div class="x-field"><label for="x-from">Desde</label><input id="x-from" type="date" max="${today}"></div>
        <div class="x-field"><label for="x-to">Hasta</label><input id="x-to" type="date" max="${today}" value="${today}"></div>
      </div>
      <label for="x-max">Tamaño máximo por parte</label>
      <select id="x-max"><option value="200">200 MB</option><option value="500" selected>500 MB</option></select>
      <p id="x-count" class="muted" role="status"></p>
      <div class="row"><button class="btn primary big" id="x-go">Exportar ZIP</button></div>
      <div id="x-prog" class="x-prog" hidden>
        <progress id="x-bar" value="0" max="1"></progress>
        <div id="x-ptext" class="muted" role="status"></div>
      </div>
      <p id="x-msg" role="status"></p>
      <ul id="x-parts" class="x-parts"></ul>
    </div>
    <div class="card">
      <h2 class="x-h">Respaldo completo</h2>
      <p class="muted">Incluye todos los activos (también borradores y exportados), edificios, departamentos y ajustes. Sirve para pasar los datos a otro teléfono o recuperarlos tras reinstalar. Se arma en un solo archivo: con muchas fotos puede requerir bastante memoria.</p>
      <div class="row">
        <button class="btn" id="x-backup">Crear respaldo completo</button>
        <button class="btn" id="x-restore">Restaurar respaldo…</button>
      </div>
      <input id="x-file" class="sr" type="file" accept=".zip,application/zip" tabindex="-1">
      <div id="x-bprog" class="x-prog" hidden><progress id="x-bbar" value="0" max="1"></progress><div id="x-bptext" class="muted"></div></div>
      <p id="x-bmsg" role="status"></p>
      <ul id="x-bparts" class="x-parts"></ul>
    </div>
    <div class="card">
      <h2 class="x-h">Borrar activos ya exportados</h2>
      <p class="muted">Libera espacio. Solo borra activos exportados que no se hayan editado después. Esta acción no se puede deshacer.</p>
      <div class="row"><button class="btn danger" id="x-del">Borrar activos ya exportados</button></div>
      <p id="x-dmsg" role="status"></p>
    </div>`;

  const $ = (id) => document.getElementById(id);
  const buttons = ['x-go', 'x-backup', 'x-restore', 'x-del'];
  const setBusy = (b) => { busy = b; buttons.forEach((i) => { $(i).disabled = b; }); };
  const say = (id, cls, text) => { const el = $(id); el.className = cls || ''; el.textContent = text; };

  const refreshStats = async () => {
    const s = await stats();
    $('x-total').textContent = s.total; $('x-pending').innerHTML = `<strong>${s.pending}</strong>`; $('x-done').textContent = s.exported;
    updateCount();
  };

  const currentScope = () => {
    const type = $('x-scope').value;
    const sc = { type };
    if (type === 'building') sc.building_code = $('x-bsel').value;
    if (type === 'dates') { sc.from = $('x-from').value || null; sc.to = $('x-to').value || null; }
    return sc;
  };
  async function updateCount() {
    try {
      const n = filterAssets(await getSavedAssets(), currentScope()).length;
      $('x-count').textContent = `Se exportarán ${n} activo${n === 1 ? '' : 's'}.`;
    } catch (_) { /* ignore */ }
  }
  const onScope = () => {
    const t = $('x-scope').value;
    $('x-bld').hidden = t !== 'building'; $('x-dates').hidden = t !== 'dates';
    updateCount();
  };
  ['x-scope', 'x-bsel', 'x-from', 'x-to'].forEach((i) => $(i).addEventListener('change', onScope));
  updateCount();

  const addPartRow = (ul, name, blob, extra = '') => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="x-pname">${esc(name)}</span><span class="muted">${fmtBytes(blob.size)}${extra ? ' · ' + esc(extra) : ''}</span>`;
    const dl = document.createElement('button'); dl.className = 'btn'; dl.textContent = 'Descargar';
    dl.onclick = () => download(name, blob);
    li.append(dl);
    if (canShare(blob, name)) {
      const sh = document.createElement('button'); sh.className = 'btn'; sh.textContent = 'Compartir';
      sh.onclick = async () => {
        try { await navigator.share({ files: [new File([blob], name, { type: 'application/zip' })], title: name }); } catch (e) { if (e && e.name !== 'AbortError') reportError(e); }
      };
      li.append(sh);
    }
    ul.append(li);
  };

  const failText = (e) => (isMemoryError(e)
    ? 'No hay memoria o espacio suficiente para generar el archivo. Elige un tamaño máximo por parte más chico (200 MB), exporta un edificio o un rango de fechas menor, y cierra otras pestañas.'
    : 'Error al exportar: ' + (e && e.message ? e.message : e));

  // ---- export ZIP
  $('x-go').onclick = async () => {
    if (busy) return;
    $('x-parts').innerHTML = ''; say('x-msg', '', '');
    const scope = currentScope();
    if (scope.type === 'building' && !scope.building_code) { say('x-msg', 'bad', 'Elige un edificio.'); return; }
    if (scope.type === 'dates' && scope.from && scope.to && scope.from > scope.to) { say('x-msg', 'bad', 'La fecha "Desde" es posterior a "Hasta".'); return; }
    setBusy(true);
    $('x-prog').hidden = false;
    const bar = $('x-bar');
    let nParts = 0;
    try {
      const r = await exportZip(h, {
        scope, maxPartBytes: Number($('x-max').value) * 1048576,
        onProgress: (d, t, label) => { bar.max = t; bar.value = d; $('x-ptext').textContent = d >= t ? `Activo ${t} de ${t}` : `Activo ${Math.min(d + 1, t)} de ${t} · ${label}`; },
        onPart: (p) => { nParts++; addPartRow($('x-parts'), p.name, p.blob, `${p.nAssets} activo${p.nAssets === 1 ? '' : 's'} · parte ${p.n} de ${p.total}`); }
      });
      if (!r.assets) say('x-msg', 'muted', 'No hay activos que coincidan con el alcance elegido.');
      else {
        bar.value = bar.max;
        say('x-msg', 'ok', `Listo: ${r.assets} activo${r.assets === 1 ? '' : 's'} en ${r.parts} parte${r.parts === 1 ? '' : 's'}. Descarga o comparte cada parte (se marcaron como exportados).`);
      }
    } catch (e) {
      console.error(e);
      say('x-msg', 'bad', failText(e) + (nParts ? ` Las ${nParts} parte(s) anteriores quedaron listas abajo.` : ''));
    } finally {
      setBusy(false);
      await refreshStats().catch(() => {});
    }
  };

  // ---- backup
  const bprog = (d, t, label) => { $('x-bprog').hidden = false; $('x-bbar').max = Math.max(t, 1); $('x-bbar').value = d; $('x-bptext').textContent = `${label}: activo ${Math.min(d + 1, t)} de ${t}`; };
  $('x-backup').onclick = async () => {
    if (busy) return;
    setBusy(true); $('x-bparts').innerHTML = ''; say('x-bmsg', '', '');
    try {
      const r = await exportBackup(h, bprog);
      say('x-bmsg', 'ok', `Respaldo listo (${r.nAssets} activos).`);
      addPartRow($('x-bparts'), r.name, r.blob);
    } catch (e) { console.error(e); say('x-bmsg', 'bad', failText(e)); } finally { setBusy(false); }
  };
  $('x-restore').onclick = () => { if (!busy) { $('x-file').value = ''; $('x-file').click(); } };
  $('x-file').onchange = async () => {
    const f = $('x-file').files[0];
    if (!f || busy) return;
    if (!(await confirmDlg('Restaurar respaldo', `<p>Se fusionará <strong>${esc(f.name)}</strong> (${fmtBytes(f.size)}) con los datos de este dispositivo. Si un activo ya existe se conserva la versión más reciente. No se cambia el ID de este dispositivo.</p>`, 'Restaurar'))) return;
    setBusy(true); say('x-bmsg', '', '');
    try {
      const r = await importBackup(f, h, bprog);
      $('x-bprog').hidden = true;
      const lines = [`Activos restaurados: ${r.assets}`, `Activos omitidos (ya tenías una versión igual o más reciente): ${r.skipped}`, `Edificios agregados: ${r.buildings}`, `Departamentos agregados: ${r.departments}`, `Ajustes restaurados: ${r.settings}`];
      say('x-bmsg', r.errors.length ? 'bad' : 'ok', lines.join(' · '));
      if (r.errors.length) await ask('Restauración con avisos', `<p>${lines.map(esc).join('<br>')}</p><p class="bad">Problemas:</p><ul>${r.errors.slice(0, 30).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`, [{ label: 'Cerrar', value: null, cls: 'primary' }]);
    } catch (e) { console.error(e); say('x-bmsg', 'bad', e && e.message ? e.message : String(e)); } finally {
      setBusy(false);
      await refreshStats().catch(() => {});
    }
  };

  // ---- delete exported
  $('x-del').onclick = async () => {
    if (busy) return;
    setBusy(true); say('x-dmsg', '', '');
    try {
      const targets = (await getSavedAssets()).filter((a) => a.exported_at && !isPending(a));
      if (!targets.length) { say('x-dmsg', 'muted', 'No hay activos exportados para borrar.'); return; }
      const ok1 = await confirmDlg('Borrar activos exportados', `<p>Se borrarán <strong>${targets.length}</strong> activo${targets.length === 1 ? '' : 's'} ya exportado${targets.length === 1 ? '' : 's'} de este dispositivo, con sus fotos y audios.</p><p class="muted">Los activos editados después de exportar o sin exportar no se tocan.</p>`, 'Continuar', 'danger');
      if (!ok1) return;
      const ok2 = await confirmDlg('Última confirmación', `<p class="bad"><strong>Esto es irreversible.</strong> Se eliminarán de forma permanente ${targets.length} activo${targets.length === 1 ? '' : 's'} con todas sus fotos y audios. Asegúrate de haber descargado o compartido los ZIP exportados.</p>`, 'Sí, borrar definitivamente', 'danger');
      if (!ok2) return;
      let n = 0;
      for (const a of targets) {
        // Re-check right before deleting: skip if edited meanwhile.
        const cur = await db.get('assets', a.id);
        if (!cur || !cur.exported_at || isPending(cur)) continue;
        await deleteAsset(a.id); n++;
      }
      say('x-dmsg', 'ok', `Se borraron ${n} activo${n === 1 ? '' : 's'}.`);
    } catch (e) { console.error(e); say('x-dmsg', 'bad', 'No se pudo borrar: ' + (e && e.message ? e.message : e)); } finally {
      setBusy(false);
      await refreshStats().catch(() => {});
    }
  };
}
