// Asset form, home list and departments (Phase 2). Photo/audio modules are mounted into slots.
import * as db from './db.js';
import { FLOORS, newDraft, saveAsset, nowIso, todayKey, isPending, mediaCounts, deleteAsset } from './data.js';
import { parseDepartmentsCsv, csvEscape } from './csv.js';
import { mountPhotos } from './photos.js';
import { mountAudio } from './audio.js';

let cleanup = null;
export function leave() { if (cleanup) { const c = cleanup; cleanup = null; try { c(); } catch (e) { console.error(e); } } }

const normSearch = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const floorLabel = (f) => (/^\d+$/.test(f) ? `Piso ${f}` : f);

// ---------- searchable picker (dialog) ----------
// items: [{value,label,sub}]. Resolves {value} | {created:text} | null.
function pick(h, { title, items, newLabel, current }) {
  return new Promise((resolve) => {
    const d = h.$dlg;
    d.innerHTML = `<h2 style="margin-top:0">${h.esc(title)}</h2>
      <input id="pk-q" type="search" placeholder="Buscar…" autocomplete="off" aria-label="Buscar">
      <div class="scroll pk-list" id="pk-list"></div>
      <div class="actions"><button class="btn" id="pk-cancel">Cancelar</button></div>`;
    const $q = d.querySelector('#pk-q');
    const $list = d.querySelector('#pk-list');
    let result = null;
    let shown = [];
    const draw = () => {
      const q = normSearch($q.value).trim();
      shown = items.filter((i) => !q || normSearch(i.label + ' ' + (i.sub || '')).includes(q));
      const exact = items.some((i) => normSearch(i.label).trim() === q);
      let html = shown.map((i, n) => `<button type="button" class="btn pk-item${i.value === current ? ' sel' : ''}" data-n="${n}"><span>${h.esc(i.label)}</span>${i.sub ? `<small>${h.esc(i.sub)}</small>` : ''}</button>`).join('');
      if (newLabel && q && !exact) html += `<button type="button" class="btn primary pk-item" data-new="1">+ ${h.esc(newLabel)}: “${h.esc($q.value.trim())}”</button>`;
      if (!html) html = '<p class="muted">Sin resultados.</p>';
      $list.innerHTML = html;
    };
    $q.addEventListener('input', draw);
    $list.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.new) result = { created: $q.value.trim() };
      else result = { value: shown[Number(b.dataset.n)].value };
      d.close();
    });
    d.querySelector('#pk-cancel').onclick = () => d.close();
    d.onclose = () => resolve(result);
    draw();
    d.showModal();
  });
}

// ---------- departments ----------
export async function addDepartment(name) {
  const clean = db.cleanText(name);
  const key = db.normKey(clean);
  if (!key) return null;
  const existing = await db.get('departments', key);
  if (existing) return existing.name;
  await db.put('departments', { key, name: clean });
  return clean;
}
const listDepartments = async () => (await db.getAll('departments')).sort((a, b) => a.name.localeCompare(b.name, 'es'));

export async function viewDepartments(h) {
  leave();
  const rows = await listDepartments();
  h.$app.innerHTML = `
    <h1>Departamentos</h1>
    <div class="card">
      <p class="muted">CSV de 1 columna (<code>DEPARTMENT</code>). También se pueden crear al vuelo desde el formulario del activo.</p>
      <div class="row">
        <button class="btn primary" id="d-import">Importar CSV</button>
        <button class="btn" id="d-add">+ Agregar</button>
        <button class="btn" id="d-export"${rows.length ? '' : ' disabled'}>Exportar CSV</button>
      </div>
      <input id="d-file" class="sr" type="file" accept=".csv,text/csv,text/plain" tabindex="-1">
    </div>
    <div class="card"><strong>${rows.length} departamento${rows.length === 1 ? '' : 's'}</strong>
      ${rows.length ? `<ul class="list">${rows.map((r) => `<li><span class="name">${h.esc(r.name)}</span><button class="btn danger" data-del="${h.esc(r.key)}">Borrar</button></li>`).join('')}</ul>` : '<p class="muted">Aún no hay departamentos.</p>'}
    </div>`;
  const $file = h.$app.querySelector('#d-file');
  h.$app.querySelector('#d-import').onclick = () => { $file.value = ''; $file.click(); };
  $file.onchange = async () => {
    const f = $file.files[0]; if (!f) return;
    try {
      const res = parseDepartmentsCsv(await f.arrayBuffer());
      if (res.errors.length && !res.names.length) { await h.ask('No se pudo importar', `<ul>${res.errors.map((e) => `<li>${h.esc(e)}</li>`).join('')}</ul>`, [{ label: 'Cerrar', value: null, cls: 'primary' }]); return; }
      for (const n of res.names) await addDepartment(n);
      h.showBanner('imp', 'info', `Se procesaron ${res.names.length} departamentos ✓ (los existentes no se duplican)`, [{ label: 'OK', onClick: () => h.hideBanner('imp') }]);
      await viewDepartments(h);
    } catch (e) { h.reportError(e); }
  };
  h.$app.querySelector('#d-add').onclick = async () => {
    const r = await pick(h, { title: 'Nuevo departamento', items: [], newLabel: 'Crear departamento' });
    if (r?.created) { await addDepartment(r.created); await viewDepartments(h); }
  };
  h.$app.querySelector('#d-export').onclick = () => h.download('departamentos.csv', new Blob(['﻿DEPARTMENT\r\n' + rows.map((r) => csvEscape(r.name)).join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' }));
  h.$app.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
    if (await h.confirmDlg('Borrar departamento', '<p>Los activos ya registrados conservan su departamento.</p>', 'Borrar', 'danger')) { await db.del('departments', b.dataset.del); await viewDepartments(h); }
  }));
}

// ---------- asset form ----------
async function loadOrCreate(h, id) {
  if (id) { const a = await db.get('assets', id); if (a) return a; }
  const drafts = (await db.getAll('assets')).filter((a) => a.status === 'draft').sort((x, y) => (y.updated_at || '').localeCompare(x.updated_at || ''));
  if (drafts.length && !id) return drafts[0];
  const [inspector, context] = await Promise.all([db.getSetting('inspector', ''), db.getSetting('last_context', null)]);
  const a = newDraft({ inspector, deviceId: h.state.deviceId, context });
  await db.put('assets', a); // durable immediately (Android may kill the page while the camera is open)
  return a;
}

export async function viewAssetForm(h, id) {
  leave();
  const a = await loadOrCreate(h, id);
  const wasSaved = a.status === 'saved';
  const openCounts = await mediaCounts(a.id);
  const quality = await db.getSetting('photo_quality', 'alta');
  const buildings = await db.getAll('buildings');
  let chain = Promise.resolve();
  let gone = false;     // set before deleting: no late write may recreate the asset
  let changed = false;  // user edits in this session
  let dirtyNotes = false;
  let timer = null;
  const mounts = [];

  const persist = () => {
    if (gone) return chain;
    changed = true;
    chain = chain.then(() => (gone ? null : db.put('assets', { ...a, updated_at: nowIso() }))).catch((e) => h.reportError(e));
    return chain;
  };
  const flushNotes = () => { clearTimeout(timer); if (dirtyNotes) { dirtyNotes = false; return persist(); } return chain; };

  h.$app.innerHTML = `
    <h1>${a.seq ? `Activo #${a.seq}` : 'Nuevo activo'}${wasSaved ? '' : ' <span class="muted tag">borrador</span>'}</h1>
    <div class="card ctx">
      <button type="button" class="ctx-btn" id="c-b"></button>
      <button type="button" class="ctx-btn" id="c-f"></button>
      <button type="button" class="ctx-btn" id="c-d"></button>
    </div>
    <div class="card" id="slot-photos"></div>
    <div class="card" id="slot-audio"></div>
    <div class="card"><label for="notes">Notas</label><textarea id="notes" rows="4" placeholder="Opcional">${h.esc(a.notes)}</textarea></div>
    <p id="f-msg" class="bad" role="alert"></p>
    <div class="savebar">
      ${wasSaved
        ? '<button class="btn primary" id="s-save">Listo</button><button class="btn danger" id="s-del">Borrar activo</button>'
        : '<button class="btn primary" id="s-next">Guardar y siguiente</button><button class="btn" id="s-save">Guardar</button><button class="btn danger" id="s-discard">Descartar</button>'}
    </div>`;
  const $ = (s) => h.$app.querySelector(s);
  const msg = (t) => { $('#f-msg').textContent = t || ''; };

  const paintCtx = () => {
    const b = $('#c-b'), f = $('#c-f'), d = $('#c-d');
    b.innerHTML = `<small>🏢 Edificio</small><strong>${a.building_code ? h.esc(a.building_code) : 'Elegir edificio'}</strong><span>${h.esc(a.building_name)}</span>`;
    f.innerHTML = `<small>🪜 Piso</small><strong>${a.floor ? h.esc(floorLabel(a.floor)) : 'Elegir piso'}</strong>`;
    d.innerHTML = `<small>🧰 Departamento</small><strong>${a.department ? h.esc(a.department) : 'Elegir'}</strong>`;
    b.classList.toggle('empty', !a.building_code); f.classList.toggle('empty', !a.floor); d.classList.toggle('empty', !a.department);
  };
  paintCtx();

  $('#c-b').onclick = async () => {
    if (!buildings.length) { msg('No hay edificios cargados. Impórtalos en Edificios.'); return; }
    const items = buildings.sort((x, y) => x.code.localeCompare(y.code, 'es', { numeric: true })).map((x) => ({ value: x.code, label: x.code, sub: x.name }));
    const r = await pick(h, { title: 'Edificio', items, current: a.building_code });
    if (r?.value) { const b = buildings.find((x) => x.code === r.value); a.building_code = b.code; a.building_name = b.name; paintCtx(); msg(''); await persist(); }
  };
  $('#c-f').onclick = async () => {
    const r = await pick(h, { title: 'Piso', items: FLOORS.map((f) => ({ value: f, label: floorLabel(f) })), current: a.floor });
    if (r?.value) { a.floor = r.value; paintCtx(); msg(''); await persist(); }
  };
  $('#c-d').onclick = async () => {
    const deps = await listDepartments();
    const r = await pick(h, { title: 'Departamento', items: deps.map((x) => ({ value: x.name, label: x.name })), newLabel: 'Nuevo departamento', current: a.department });
    let name = null;
    if (r?.created) name = await addDepartment(r.created); else if (r?.value) name = r.value;
    if (name) { a.department = name; paintCtx(); await persist(); }
  };

  const $notes = $('#notes');
  $notes.addEventListener('input', () => { a.notes = $notes.value; dirtyNotes = true; clearTimeout(timer); timer = setTimeout(flushNotes, 400); });
  const onHide = () => { if (document.visibilityState === 'hidden') flushNotes(); };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', flushNotes);

  // Media slots (never write the asset record themselves).
  try { mounts.push(await mountPhotos($('#slot-photos'), a, { quality })); } catch (e) { $('#slot-photos').innerHTML = `<p class="bad">No se pudo cargar el módulo de fotos: ${h.esc(e.message)}</p>`; }
  try { mounts.push(await mountAudio($('#slot-audio'), a)); } catch (e) { $('#slot-audio').innerHTML = `<p class="bad">No se pudo cargar el módulo de audio: ${h.esc(e.message)}</p>`; }

  // GPS (optional, never blocks).
  if (!a.gps?.lat && !wasSaved && await db.getSetting('gps_enabled', false) && navigator.geolocation) {
    navigator.geolocation.getCurrentPosition((p) => { if (gone) return; a.gps = { lat: p.coords.latitude, lon: p.coords.longitude, accuracy_m: p.coords.accuracy }; persist(); }, () => {}, { timeout: 5000, maximumAge: 60000 });
  }

  cleanup = () => {
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', flushNotes);
    flushNotes();
    mounts.forEach((m) => { try { m?.destroy?.(); } catch (_) { /* ignore */ } });
    if (wasSaved && !gone && !changed) { // media-only edits must still mark the asset as pending export
      mediaCounts(a.id).then((c) => { if (!gone && (c.photo !== openCounts.photo || c.audio !== openCounts.audio)) return chain.then(() => (gone ? null : db.put('assets', { ...a, updated_at: nowIso() }))); }).catch(() => {});
    }
  };

  const save = async (next) => {
    msg('');
    await flushNotes();
    if (!a.building_code) { msg('Elige un edificio.'); return; }
    if (!a.floor) { msg('Elige un piso.'); return; }
    const c = await mediaCounts(a.id);
    if (!a.notes.trim() && !c.photo && !c.audio) { msg('Agrega al menos una foto, nota de voz o nota de texto.'); return; }
    try {
      await chain;
      if (wasSaved && !changed && c.photo === openCounts.photo && c.audio === openCounts.audio) { leave(); h.navigate(next ? '#/nuevo' : '#/'); return; } // nothing edited: don't touch updated_at
      a.inspector = await db.getSetting('inspector', '') || a.inspector;
      const saved = await saveAsset(a);
      Object.assign(a, saved);
      leave();
      h.showBanner('saved', 'info', `Activo #${saved.seq} guardado ✓`, [{ label: 'OK', onClick: () => h.hideBanner('saved') }]);
      setTimeout(() => h.hideBanner('saved'), 2500);
      h.navigate(next ? '#/nuevo' : '#/');
    } catch (e) { h.reportError(e); }
  };
  $('#s-save').onclick = () => save(false);
  const sn = $('#s-next'); if (sn) sn.onclick = () => save(true);
  const sd = $('#s-discard'); if (sd) sd.onclick = async () => {
    if (await h.confirmDlg('Descartar borrador', '<p>Se borrarán el borrador y sus fotos y audios. No se puede deshacer.</p>', 'Descartar', 'danger')) { gone = true; leave(); await chain; await deleteAsset(a.id); h.navigate('#/'); }
  };
  const del = $('#s-del'); if (del) del.onclick = async () => {
    if (await h.confirmDlg('Borrar activo', `<p>¿Borrar el activo #${a.seq} con todas sus fotos y audios? No se puede deshacer.</p>`, 'Borrar', 'danger')) { gone = true; leave(); await chain; await deleteAsset(a.id); h.navigate('#/'); }
  };
}

// ---------- home list ----------
const filters = { b: '', f: '', d: '', q: '', limit: 50 };

export async function viewHome(h) {
  leave();
  const [nB, inspector, info, all] = await Promise.all([db.count('buildings'), db.getSetting('inspector', ''), h.storageInfo(), db.getAll('assets')]);

  // Drafts: drop empty ones, offer to continue the rest.
  let draft = null;
  for (const dr of all.filter((x) => x.status === 'draft').sort((x, y) => (y.updated_at || '').localeCompare(x.updated_at || ''))) {
    const c = await mediaCounts(dr.id);
    if (!dr.notes.trim() && !c.photo && !c.audio && !c.chunk) { await deleteAsset(dr.id); continue; }
    if (!draft) draft = dr;
  }
  const saved = all.filter((x) => x.status === 'saved').sort((x, y) => (y.created_at || '').localeCompare(x.created_at || ''));
  const today = saved.filter((x) => (x.created_at || '').slice(0, 10) === todayKey()).length;
  const pending = saved.filter(isPending).length;

  if (info.quota && info.usage != null) {
    const free = info.quota - info.usage;
    if (free < 1073741824 || free / info.quota < 0.1) h.showBanner('space', 'warn', `Queda poco espacio (${h.fmtBytes(free)} libres). Exporta y borra lo ya exportado.`, [{ label: 'Exportar', onClick: () => h.navigate('#/exportar') }]);
  }

  const todo = [];
  if (!inspector) todo.push('<li>Escribe tu nombre de inspector en <a href="#/ajustes">Ajustes</a>.</li>');
  if (!nB) todo.push('<li>Importa la lista de edificios en <a href="#/edificios">Edificios</a>.</li>');
  const buildingsSeen = [...new Set(saved.map((x) => x.building_code))].sort((x, y) => x.localeCompare(y, 'es', { numeric: true }));
  const floorsSeen = FLOORS.filter((f) => saved.some((x) => x.floor === f));
  const deptsSeen = [...new Set(saved.map((x) => x.department).filter(Boolean))].sort((x, y) => x.localeCompare(y, 'es'));
  const opt = (arr, cur, lab = (v) => v) => arr.map((v) => `<option value="${h.esc(v)}"${v === cur ? ' selected' : ''}>${h.esc(lab(v))}</option>`).join('');

  h.$app.innerHTML = `
    <h1>Inicio</h1>
    ${inspector ? `<p class="hello">Hola, ${h.esc(inspector)} 👋</p>` : ''}
    ${todo.length ? `<div class="card"><strong>Configuración pendiente</strong><ul>${todo.join('')}</ul></div>` : ''}
    ${draft ? `<div class="card draft"><strong>Tienes un borrador sin guardar</strong><p class="muted">${h.esc([draft.building_code, draft.floor && floorLabel(draft.floor), draft.department].filter(Boolean).join(' · ') || 'Sin contexto')}</p>
      <div class="row"><a class="btn primary" href="#/activo?id=${h.esc(draft.id)}">Continuar</a></div></div>` : ''}
    <a class="btn big primary" href="#/nuevo" id="new-asset">+ Nuevo activo</a>
    <div class="card stats">
      <div><strong>${today}</strong><span>hoy</span></div>
      <div><strong>${saved.length}</strong><span>total</span></div>
      <div><strong>${pending}</strong><span>por exportar</span></div>
    </div>
    <div class="section-title">Activos registrados</div>
    <div class="card">
      <input id="f-q" type="search" placeholder="Buscar en notas, edificio, departamento…" aria-label="Buscar" value="${h.esc(filters.q)}">
      <div class="row filters">
        <select id="f-b" aria-label="Filtrar por edificio"><option value="">Edificio</option>${opt(buildingsSeen, filters.b)}</select>
        <select id="f-f" aria-label="Filtrar por piso"><option value="">Piso</option>${opt(floorsSeen, filters.f, floorLabel)}</select>
        <select id="f-d" aria-label="Filtrar por departamento"><option value="">Departamento</option>${opt(deptsSeen, filters.d)}</select>
      </div>
    </div>
    <div id="list"></div>
    <div class="card">${h.storageHtml(info)}</div>`;

  const $list = h.$app.querySelector('#list');
  let urls = [];
  const drawList = () => {
    urls.forEach((u) => URL.revokeObjectURL(u)); urls = [];
    const q = normSearch(filters.q).trim();
    const rows = saved.filter((x) => (!filters.b || x.building_code === filters.b) && (!filters.f || x.floor === filters.f) && (!filters.d || x.department === filters.d)
      && (!q || normSearch([x.notes, x.building_code, x.building_name, x.department, x.floor, '#' + x.seq].join(' ')).includes(q)));
    if (!rows.length) { $list.innerHTML = `<div class="card empty-state"><span class="big-emoji">${saved.length ? '🔍' : '📋'}</span><strong>${saved.length ? 'Ningún activo coincide' : 'Aún no hay activos'}</strong><p class="muted">${saved.length ? 'Prueba con otros filtros o borra la búsqueda.' : 'Toca “+ Nuevo activo” para registrar el primero.'}</p></div>`; return; }
    const page = rows.slice(0, filters.limit);
    $list.innerHTML = `<ul class="assets">${page.map((x) => `<li><a class="asset-item" href="#/activo?id=${h.esc(x.id)}" data-id="${h.esc(x.id)}">
      <span class="thumb" aria-hidden="true"></span>
      <span class="info"><strong>#${x.seq} · ${h.esc(x.building_code)} · ${h.esc(floorLabel(x.floor))}</strong>
      <span>${h.esc(x.department || '—')}</span>
      <span class="chips meta"></span>
      ${x.notes ? `<span class="muted note">${h.esc(x.notes.slice(0, 90))}</span>` : ''}</span></a></li>`).join('')}</ul>
      ${rows.length > page.length ? `<button class="btn big" id="more">Mostrar más (${rows.length - page.length})</button>` : ''}`;
    const more = $list.querySelector('#more'); if (more) more.onclick = () => { filters.limit += 50; drawList(); };
    const byId = new Map(page.map((x) => [x.id, x]));
    $list.querySelectorAll('.asset-item').forEach(async (el) => {
      try {
        const x = byId.get(el.dataset.id);
        const c = await mediaCounts(x.id);
        if (!el.isConnected) return;
        el.querySelector('.meta').innerHTML = `<span class="chip">📷 ${c.photo}</span><span class="chip">🎙 ${c.audio}</span>${isPending(x) ? '<span class="chip pending">por exportar</span>' : '<span class="chip done">exportado ✓</span>'}`;
        if (c.thumbKey) {
          const t = await db.get('blobs', c.thumbKey);
          if (t && el.isConnected) { const u = URL.createObjectURL(t.blob); urls.push(u); el.querySelector('.thumb').style.backgroundImage = `url(${u})`; }
        }
      } catch (_) { /* list stays usable without thumbnails */ }
    });
  };
  const bind = (sel, key, ev = 'change') => h.$app.querySelector(sel).addEventListener(ev, (e) => { filters[key] = e.target.value; filters.limit = 50; drawList(); });
  bind('#f-b', 'b'); bind('#f-f', 'f'); bind('#f-d', 'd'); bind('#f-q', 'q', 'input');
  drawList();
  cleanup = () => { urls.forEach((u) => URL.revokeObjectURL(u)); urls = []; };
}
