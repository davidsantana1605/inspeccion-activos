// Shared data contracts. FROZEN: photo/audio/export modules depend on these shapes.
import * as db from './db.js';
import { APP_VERSION } from './version.js';

// ---- Floors (fixed list, order as in brief section 3.2) ----
export const FLOORS = (() => {
  const l = ['BASEMENT 4', 'BASEMENT 3', 'BASEMENT 2', 'BASEMENT 1', '1', 'MEZZANINE 1', '2', 'MEZZANINE 2', '3', 'MEZZANINE 3', '4', 'MEZZANINE 4'];
  for (let i = 5; i <= 30; i++) l.push(String(i));
  return l;
})();

// ISO 8601 with local offset (e.g. 2026-11-12T10:42:13-06:00), never 'Z'.
export function nowIso(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(a / 60))}:${p(a % 60)}`;
}
export const todayKey = (d = new Date()) => nowIso(d).slice(0, 10);

/*
Asset record (store 'assets', keyPath 'id'):
{ schema_version:1, id, status:'draft'|'saved', seq:number|null (assigned on first save),
  inspector, device_id, app_version, created_at, updated_at,
  building_code, building_name, floor, department, notes,
  gps:{lat,lon,accuracy_m}, exported_at:null|iso }
NOTE: photos[] and audios[] are NOT stored on the asset record. Media modules never write the
asset record (avoids write races with the form). They live in the 'blobs' store and are
assembled at export time.

Blob record (store 'blobs', keyPath 'id', indexes asset_id, kind):
  id = `${kind}:${assetId}:${uuid}`   kind in 'photo' | 'thumb' | 'audio'
  photo: { id, asset_id, kind:'photo', uid, blob:Blob, mime_type, ext:'jpg'|'png'|..., source:'camera'|'gallery',
           is_screenshot:boolean, width, height, bytes, resized:boolean, captured_at:iso, order:number }
  thumb: { id, asset_id, kind:'thumb', uid, blob:Blob, mime_type:'image/jpeg', order }  (same uid and order as its photo)
  audiochunk: transient pieces of a recording in progress (audio.js); recovered at boot by recoverOrphanAudio().
  audio: { id, asset_id, kind:'audio', uid, blob:Blob, mime_type, ext:'webm'|'m4a', duration_s, recorded_at:iso, transcript:null, order:number }
`order` = Date.now() at creation; sort ascending for foto_01, foto_02... numbering.
*/
export const blobId = (kind, assetId, uid) => `${kind}:${assetId}:${uid}`;

// Count media of an asset without loading blobs (primary keys only).
export async function mediaCounts(assetId) {
  const out = { photo: 0, audio: 0, chunk: 0, thumbKey: null };
  await db.tx('blobs', 'readonly', (s) => new Promise((resolve, reject) => {
    const req = s.index('asset_id').openKeyCursor(IDBKeyRange.only(assetId));
    req.onsuccess = () => {
      const c = req.result;
      if (!c) { resolve(); return; }
      const kind = String(c.primaryKey).split(':', 1)[0];
      if (kind === 'photo' || kind === 'audio') out[kind]++;
      else if (kind === 'audiochunk') out.chunk++; // unfinished recording: counts as content
      else if (kind === 'thumb' && !out.thumbKey) out.thumbKey = c.primaryKey;
      c.continue();
    };
    req.onerror = () => reject(req.error);
  }));
  return out;
}

// All blob records (full, with Blob) of an asset filtered by kind, ordered. Use only for ONE asset at a time.
export async function getMedia(assetId, kind) {
  const all = await db.tx('blobs', 'readonly', (s) => new Promise((resolve, reject) => {
    const req = s.index('asset_id').getAll(IDBKeyRange.only(assetId));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
  return all.filter((b) => b.kind === kind).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

// Delete one media item (and its thumb, if a photo) by uid.
export async function deleteMedia(assetId, kinds, uid) {
  await db.tx('blobs', 'readwrite', async (s) => { for (const k of kinds) s.delete(blobId(k, assetId, uid)); });
}

// Delete an asset and ALL its blobs in a single transaction.
export async function deleteAsset(assetId) {
  await db.tx(['assets', 'blobs'], 'readwrite', (st) => new Promise((resolve, reject) => {
    st.assets.delete(assetId);
    const req = st.blobs.index('asset_id').openKeyCursor(IDBKeyRange.only(assetId));
    req.onsuccess = () => { const c = req.result; if (!c) { resolve(); return; } st.blobs.delete(c.primaryKey); c.continue(); };
    req.onerror = () => reject(req.error);
  }));
}

// A saved asset is pending export if never exported or edited after export.
export const isPending = (a) => a.status === 'saved' && (!a.exported_at || a.updated_at > a.exported_at);

export function newDraft({ inspector, deviceId, context }) {
  const now = nowIso();
  return {
    schema_version: 1, id: crypto.randomUUID(), status: 'draft', seq: null,
    inspector: inspector || '', device_id: deviceId, app_version: APP_VERSION,
    created_at: now, updated_at: now,
    building_code: context?.building_code || '', building_name: context?.building_name || '',
    floor: context?.floor || '', department: context?.department || '', notes: '',
    gps: { lat: null, lon: null, accuracy_m: null }, exported_at: null
  };
}

// Atomically: assign seq (first save only), store asset as 'saved', update last_context.
export async function saveAsset(asset) {
  return db.tx(['settings', 'assets'], 'readwrite', async (st) => {
    const wrap = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const a = { ...asset, status: 'saved', updated_at: nowIso(), app_version: APP_VERSION };
    if (!a.seq) {
      const cur = await wrap(st.settings.get('seq_counter'));
      a.seq = ((cur && cur.value) || 0) + 1;
      a.created_at = a.updated_at; // stamp on first save so reused drafts don't keep an old date
      st.settings.put({ key: 'seq_counter', value: a.seq });
    }
    st.settings.put({ key: 'last_context', value: { building_code: a.building_code, building_name: a.building_name, floor: a.floor, department: a.department } });
    st.assets.put(a);
    return a;
  });
}

export const folderName = (a) => `${String(a.building_code || 'SIN-EDIF').replace(/[^\w.-]+/g, '-')}_${String(a.seq ?? 0).padStart(4, '0')}_${a.id.slice(0, 8)}`;

// All saved assets (never drafts).
export async function getSavedAssets() {
  return (await db.getAll('assets')).filter((a) => a.status === 'saved');
}
