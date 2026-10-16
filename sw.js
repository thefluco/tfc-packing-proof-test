// Service worker: keeps the app working with no network (the upload queue lives in IndexedDB).
// Bump VERSION with every release so phones pick up the new files.
const VERSION = 'pp-test-20261016-2058';
const VENDOR = 'pp-vendor';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/main.js', 'js/config.js', 'js/logic.js', 'js/quality.js', 'js/exif.js', 'js/still-worker.js', 'js/store.js',
  'js/records.js', 'js/uploader.js', 'js/barcode.js', 'js/camera.js', 'js/demo.js', 'js/overlay.js', 'js/reader.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'test-backend/gas-harness.js', 'apps-script/Code.gs',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== VENDOR).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;   // uploads (POST to Apps Script) always go straight to the network
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    e.respondWith(caches.match(req, { ignoreSearch: req.mode === 'navigate' }).then((hit) => hit || fetch(req)));
  } else if (/(^|\.)jsdelivr\.net$/.test(url.hostname)) {
    // the fallback barcode library and its WebAssembly file: cache after the first use
    e.respondWith(caches.open(VENDOR).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    }));
  }
});
