// Service worker: keeps the app working with no network (the upload queue lives in IndexedDB), and holds the
// order-number reader (Tesseract.js, about 7 MB) so it is downloaded once.
// Bump VERSION with every release so phones pick up the new files.
const VERSION = 'pp-live-20261017-2229';
const VENDOR = 'pp-vendor';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/main.js', 'js/config.js', 'js/logic.js', 'js/quality.js', 'js/exif.js', 'js/still-worker.js', 'js/store.js',
  'js/records.js', 'js/uploader.js', 'js/barcode.js', 'js/demo.js', 'js/ocr.js', 'js/sound.js', 'js/strings.js', 'js/drawings.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];
// The reader: stored with the app, kept across releases (its own cache), fetched once at install. The plain-LSTM
// core is only for phones without WebAssembly SIMD; it is cached the first time such a phone asks for it.
const READER = [
  'vendor/tesseract/tesseract.esm.min.js', 'vendor/tesseract/worker.min.js',
  'vendor/tesseract/tesseract-core-simd-lstm.wasm.js', 'vendor/tesseract/lang/eng.traineddata.gz',
];

self.addEventListener('install', (e) => {
  // 'reload' skips the browser's HTTP cache (Pages allows 10 min), so a release never caches an old file beside new ones
  const fresh = SHELL.map((u) => new Request(u, { cache: 'reload' }));
  e.waitUntil(Promise.all([
    caches.open(VERSION).then((c) => c.addAll(fresh)),
    caches.open(VENDOR).then(async (c) => {
      for (const u of READER) if (!(await c.match(u))) await c.add(new Request(u, { cache: 'reload' }));
    }),
  ]).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== VENDOR).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const fromVendor = (req) => caches.open(VENDOR).then(async (c) => {
  const hit = await c.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) c.put(req, res.clone());
  return res;
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;   // uploads (POST to Apps Script) always go straight to the network
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (url.pathname.includes('/vendor/')) { e.respondWith(fromVendor(req)); return; }
    e.respondWith(caches.match(req, { ignoreSearch: req.mode === 'navigate' }).then((hit) => hit || fetch(req)));
  } else if (/(^|\.)jsdelivr\.net$/.test(url.hostname)) {
    e.respondWith(fromVendor(req));   // the fallback barcode library and its WebAssembly file
  }
});
