/* Service worker (classic script). Bump VERSION on every release: it changes this file's bytes,
   which is what makes the browser install the new worker. Keep in sync with js/version.js
   (tools/check-precache.mjs verifies it). */
const VERSION = '0.2.1';
const CACHE = 'inspeccion-activos-' + VERSION;

// Paths are relative to this file. Exact lowercase names: GitHub Pages is case-sensitive.
const PRECACHE = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'js/app.js',
  'js/db.js',
  'js/csv.js',
  'js/version.js',
  'js/data.js',
  'js/assets.js',
  'js/photos.js',
  'js/audio.js',
  'js/export.js',
  'vendor/fflate.esm.js',
  'css/photos.css',
  'css/audio.css',
  'css/export.css',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-192.png',
  'icons/maskable-512.png',
  'icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // cache:'reload' bypasses the HTTP cache so a stale GitHub Pages copy is never baked in.
    await Promise.all(PRECACHE.map(async (path) => {
      const res = await fetch(new Request(path, { cache: 'reload' }));
      if (!res.ok) throw new Error('Precache failed: ' + path + ' (' + res.status + ')');
      await cache.put(path, res);
    }));
    // No skipWaiting here: the page asks for it after the user taps "actualizar".
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('inspeccion-activos-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data && event.data.type === 'GET_VERSION' && event.source) event.source.postMessage({ type: 'VERSION', version: VERSION });
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch third parties
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (req.mode === 'navigate') {
      const shell = await cache.match('index.html');
      if (shell) return shell;
      try { return await fetch(req); } catch (_) { return new Response('Sin conexión', { status: 503 }); }
    }
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try { return await fetch(req); } catch (_) { return new Response('', { status: 504 }); }
  })());
});
