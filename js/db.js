// Minimal promise wrapper over IndexedDB. No external dependencies.
export const DB_NAME = 'inspeccion-activos';
export const DB_VERSION = 1;

let dbPromise = null;
const listeners = { error: [], versionchange: [] };

export function onDbEvent(type, fn) { listeners[type].push(fn); }
function emit(type, detail) { listeners[type].forEach((fn) => { try { fn(detail); } catch (_) { /* ignore */ } }); }

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in self)) { reject(new Error('Este navegador no soporta IndexedDB.')); return; }
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('settings', { keyPath: 'key' });
      db.createObjectStore('buildings', { keyPath: 'code' });
      db.createObjectStore('departments', { keyPath: 'key' });
      const assets = db.createObjectStore('assets', { keyPath: 'id' });
      assets.createIndex('created_at', 'created_at');
      assets.createIndex('building_code', 'building_code');
      assets.createIndex('exported_at', 'exported_at');
      assets.createIndex('status', 'status'); // 'draft' | 'saved'
      const blobs = db.createObjectStore('blobs', { keyPath: 'id' });
      blobs.createIndex('asset_id', 'asset_id');
      blobs.createIndex('kind', 'kind'); // 'photo' | 'thumb' | 'audio'
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; emit('versionchange'); };
      db.onclose = () => { dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error || new Error('No se pudo abrir la base de datos.'));
    req.onblocked = () => emit('error', new Error('La base de datos está bloqueada por otra pestaña de la app. Ciérrala y recarga.'));
  });
  dbPromise.catch((e) => { dbPromise = null; emit('error', e); });
  return dbPromise;
}

// Runs fn(stores) inside a transaction; resolves with fn's value once the transaction commits.
export async function tx(storeNames, mode, fn) {
  const db = await openDb();
  const names = Array.isArray(storeNames) ? storeNames : [storeNames];
  return new Promise((resolve, reject) => {
    const t = db.transaction(names, mode);
    const stores = {};
    names.forEach((n) => { stores[n] = t.objectStore(n); });
    let result;
    Promise.resolve(fn(names.length === 1 ? stores[names[0]] : stores)).then((r) => { result = r; }, (e) => { try { t.abort(); } catch (_) { /* noop */ } reject(e); });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transacción cancelada'));
  });
}

const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export const get = (store, key) => tx(store, 'readonly', (s) => wrap(s.get(key)));
export const getAll = (store) => tx(store, 'readonly', (s) => wrap(s.getAll()));
export const put = (store, value) => tx(store, 'readwrite', (s) => wrap(s.put(value)));
export const del = (store, key) => tx(store, 'readwrite', (s) => wrap(s.delete(key)));
export const clear = (store) => tx(store, 'readwrite', (s) => wrap(s.clear()));
export const count = (store) => tx(store, 'readonly', (s) => wrap(s.count()));

export async function putMany(store, values, { clearFirst = false } = {}) {
  return tx(store, 'readwrite', async (s) => {
    if (clearFirst) s.clear();
    for (const v of values) s.put(v);
  });
}

// ---- Settings (key/value) ----
export async function getSetting(key, fallback = null) {
  const r = await get('settings', key);
  return r ? r.value : fallback;
}
export const setSetting = (key, value) => put('settings', { key, value });

export async function ensureDeviceId() {
  let id = await getSetting('device_id');
  if (!id) { id = crypto.randomUUID(); await setSetting('device_id', id); }
  return id;
}

// ---- Normalization helpers (shared by buildings and departments) ----
export const normKey = (s) => String(s ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().toUpperCase();
export const cleanText = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
