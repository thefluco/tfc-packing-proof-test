// The order-number check on the phone. Tesseract.js (Apache-2.0) is stored with the app in vendor/tesseract/ and
// cached by the service worker: it runs on the phone, needs no key, and sends nothing anywhere. It is tuned to read
// only "TFC-" and digits, and it never decides anything on its own:
//  - MEASURE: any order number on the slip is a hint (the office's batch read is the one that counts) and a blur
//    catcher (no number = a slip the office could not read either: retake);
//  - PROOF: verify only - is the one booked order number on the slip next to the label? (logic.js slipCheck)
// Each number found comes with where it is in the photo, because a courier label prints its own order number too:
// the label-slip check only counts numbers outside the label.
import { OCR } from './config.js';
import { orderNumbersIn } from './logic.js';

export const state = { status: 'idle', error: '', loadMs: 0 };
let workerP = null;

const vendor = () => new URL(OCR.base, import.meta.url).href;

export function getWorker() {
  if (workerP) return workerP;
  state.status = 'loading';
  const t0 = performance.now();
  workerP = (async () => {
    const mod = await import(vendor() + 'tesseract.esm.min.js');
    const T = mod.default || mod;
    const w = await T.createWorker('eng', 1 /* LSTM only */, {
      workerPath: vendor() + 'worker.min.js', corePath: vendor(), langPath: vendor() + 'lang',
      cacheMethod: 'none', gzip: true, workerBlobURL: false,   // the service worker caches the files instead
    });
    await w.setParameters({ tessedit_char_whitelist: OCR.whitelist, tessedit_pageseg_mode: '11', user_defined_dpi: '300' });
    state.status = 'ready'; state.loadMs = Math.round(performance.now() - t0);
    return w;
  })();
  workerP.catch((e) => { workerP = null; state.status = 'failed'; state.error = String((e && e.message) || e); });
  return workerP;
}

// Load the reader in the background (after start-up, when online), so the service worker caches it before the
// first slip and it answers quickly then.
export function warm() { getWorker().catch(() => {}); }

// The tilt of the text in a grey image (degrees, clockwise positive), from its dark pixels: the angle at which they
// line up best into rows. -15..15; 0 when there is too little text to tell. Tesseract reads tilted small print
// badly, so the copy it reads is turned straight first.
export function skewOf(g, w, h) {
  let sum = 0;
  for (let i = 0; i < g.length; i++) sum += g[i];
  const thr = Math.min(110, (sum / g.length) * 0.6), xs = [], ys = [];
  const step = Math.max(1, Math.round(Math.sqrt((w * h) / 250000)));
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) if (g[y * w + x] < thr) { xs.push(x); ys.push(y); }
  if (xs.length < 400) return 0;
  // rows one sample step tall: finer bins would favour 0 degrees, where every sample lands on every other bin
  const bins = new Int32Array(Math.ceil((w + h) / step) + 4), off = Math.ceil(w / step) + 2;
  let best = 0, bestScore = -1;
  for (let a = -15; a <= 15.001; a += 0.5) {
    const r = (a * Math.PI) / 180, s = Math.sin(r), c = Math.cos(r);
    bins.fill(0);
    for (let i = 0; i < xs.length; i++) bins[Math.round((ys[i] * c - xs[i] * s) / step) + off]++;
    let score = 0;
    for (let i = 0; i < bins.length; i++) score += bins[i] * bins[i];
    if (score > bestScore) { bestScore = score; best = a; }
  }
  return Math.round(best * 10) / 10;
}

function grey(bitmap, long) {
  const s = Math.min(1, long / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * s)), h = Math.max(1, Math.round(bitmap.height * s));
  const c = new OffscreenCanvas(w, h), ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data, g = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
  return { g, w, h };
}

// A grey copy with its long side at `long` px, turned by -`tilt` degrees (canvas grown to fit, white around), as a
// JPEG for the reader. Returns the copy's size and how to map its points back onto the photo (0..1).
async function copyAt(bitmap, long, tilt = 0) {
  const s = Math.min(1, long / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * s)), h = Math.max(1, Math.round(bitmap.height * s));
  const r = (-tilt * Math.PI) / 180, cs = Math.abs(Math.cos(r)), sn = Math.abs(Math.sin(r));
  const W = Math.ceil(w * cs + h * sn), H = Math.ceil(w * sn + h * cs);
  const c = new OffscreenCanvas(W, H), ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  ctx.filter = 'grayscale(1) contrast(1.25)';
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.translate(W / 2, H / 2); ctx.rotate(r); ctx.drawImage(bitmap, -w / 2, -h / 2, w, h);
  // a point (X, Y) of the copy back onto the photo: undo the turn about the centre
  const back = (X, Y) => {
    const dx = X - W / 2, dy = Y - H / 2, c0 = Math.cos(-r), s0 = Math.sin(-r);
    return { x: (dx * c0 - dy * s0 + w / 2) / w, y: (dx * s0 + dy * c0 + h / 2) / h };
  };
  return { blob: await c.convertToBlob({ type: 'image/jpeg', quality: 0.95 }), w: W, h: H, back };
}

// Order numbers in one recognised page, each at the centre of its text line (0..1 of the photo).
function hitsOf(data, back) {
  const hits = [];
  for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) {
    for (const order of orderNumbersIn(l.text)) {
      const bb = l.bbox || {}, at = back((bb.x0 + bb.x1) / 2, (bb.y0 + bb.y1) / 2);
      hits.push({ order, x: at.x, y: at.y });
    }
  }
  // a number the line layout split up is still a hit, without a known place
  for (const order of orderNumbersIn(data.text)) if (!hits.some((x) => x.order === order)) hits.push({ order, x: null, y: null });
  return hits;
}

// Reads a photo (Blob or ImageBitmap) for order numbers, one pass per size in OCR.passes, until `until(hits)` says
// it has its answer (default: any order number).
// -> {ok, hits: [{order, x, y, pass}], orders: [unique], ms, long, error}
export async function readOrders(source, { until = (hits) => hits.length > 0, passes = OCR.passes } = {}) {
  const t0 = performance.now();
  let bitmap = null;
  const own = source instanceof Blob;
  try {
    const w = await getWorker();
    bitmap = own ? await createImageBitmap(source) : source;
    const sk = grey(bitmap, 1000), tilt = skewOf(sk.g, sk.w, sk.h), turn = Math.abs(tilt) >= 1.5 ? tilt : 0;
    const hits = [];
    let long = 0;
    for (const L of passes) {
      long = L;
      const img = await copyAt(bitmap, L, turn);
      const { data } = await w.recognize(img.blob, {}, { text: true, blocks: true });
      for (const x of hitsOf(data, img.back)) hits.push({ ...x, pass: L });
      if (until(hits)) break;
    }
    const orders = [...new Set(hits.map((x) => x.order))];
    return { ok: true, hits, orders, ms: Math.round(performance.now() - t0), long, tilt };
  } catch (e) {
    return { ok: false, hits: [], orders: [], ms: Math.round(performance.now() - t0), error: String((e && e.message) || e) };
  } finally {
    if (own && bitmap) bitmap.close();
  }
}
