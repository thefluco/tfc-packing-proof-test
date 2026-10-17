// Still worker: decodes the full-size photo, re-runs the checks on it, and encodes the largest JPEG under
// the size cap with our EXIF (capture time, phone model). Runs off the main thread so the camera stays smooth.
// Two replies per job: {phase:'checked'} as soon as the checks are done (with a small preview), then
// {phase:'done'} with the final JPEG. A job whose checks failed can be cancelled before it encodes.
import { measure, edgeVariance, toGray } from './quality.js';
import { buildExif, insertExif } from './exif.js';

const cancelled = new Set();

// Outlines and crops are set on the live preview (usually 16:9); the still is usually 4:3, and the preview shows
// the middle of it. Map a preview point (0..1) onto the still.
function mapper(previewAspect, stillW, stillH) {
  const sa = stillW / stillH, pa = previewAspect || sa;
  if (Math.abs(sa - pa) < 0.01) return (p) => p;
  if (sa < pa) { const k = sa / pa; return ([x, y]) => [x, 0.5 + (y - 0.5) * k]; }   // still is taller
  const k = pa / sa;
  return ([x, y]) => [0.5 + (x - 0.5) * k, y];                                         // still is wider
}

// Images for the reader: the whole still (at most `long` px) and close-ups of the printed scales.
async function readImages(bitmap, read, map) {
  const W = bitmap.width, H = bitmap.height, out = [];
  const enc = async (sx, sy, sw, sh, label) => {
    const s = Math.min(1, read.long / Math.max(sw, sh)), w = Math.max(1, Math.round(sw * s)), h = Math.max(1, Math.round(sh * s));
    const c = new OffscreenCanvas(w, h), ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, w, h);
    out.push({ label, blob: await c.convertToBlob({ type: 'image/jpeg', quality: read.quality || 0.85 }) });
  };
  await enc(0, 0, W, H, 'the whole photo');
  for (const cr of read.crops || []) {
    const [a, b] = [map([cr.rect[0], cr.rect[1]]), map([cr.rect[2], cr.rect[3]])];
    const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0]) * W)), y0 = Math.max(0, Math.floor(Math.min(a[1], b[1]) * H));
    const x1 = Math.min(W, Math.ceil(Math.max(a[0], b[0]) * W)), y1 = Math.min(H, Math.ceil(Math.max(a[1], b[1]) * H));
    if (x1 - x0 > 32 && y1 - y0 > 32) await enc(x0, y0, x1 - x0, y1 - y0, cr.label);
  }
  return out;
}

// Largest size first: keep the resolution and the best quality that fits; only if even MIN_QUALITY is too
// big, shrink the image (JPEG size grows roughly with the pixel count) and try again.
async function fitJpeg(bitmap, maxLong, budget, minQ, stop) {
  let scale = Math.min(1, maxLong / Math.max(bitmap.width, bitmap.height));
  let encodes = 0;
  for (let round = 0; round < 6; round++) {
    const w = Math.max(1, Math.round(bitmap.width * scale)), h = Math.max(1, Math.round(bitmap.height * scale));
    const c = new OffscreenCanvas(w, h), ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, w, h);
    const enc = async (q) => { if (stop()) throw new Error('cancelled'); encodes++; return c.convertToBlob({ type: 'image/jpeg', quality: q }); };
    const top = 0.92;
    const first = await enc(top);
    if (first.size <= budget) return { blob: first, w, h, q: top, encodes };
    const low = await enc(minQ);
    if (low.size <= budget) {
      let best = { blob: low, q: minQ }, lo = minQ, hi = top;
      for (let i = 0; i < 2; i++) {
        const mid = Math.round(((lo + hi) / 2) * 100) / 100;
        if (mid <= lo || mid >= hi) break;
        const b = await enc(mid);
        if (b.size <= budget) { best = { blob: b, q: mid }; lo = mid; } else hi = mid;
      }
      return { blob: best.blob, w, h, q: best.q, encodes };
    }
    scale *= Math.sqrt(budget / low.size) * 0.97;
  }
  throw new Error('could not get the photo under the size cap');
}

self.onmessage = async (ev) => {
  const job = ev.data;
  if (job.cancel) { cancelled.add(job.cancel); return; }
  if (job.readOnly) {   // "read again": the reader images from a stored photo, nothing else
    try {
      const bitmap = await createImageBitmap(job.blob);
      const read = await readImages(bitmap, job.readOnly, mapper(job.previewAspect, bitmap.width, bitmap.height));
      bitmap.close();
      self.postMessage({ id: job.id, phase: 'done', ok: true, read });
    } catch (err) { self.postMessage({ id: job.id, phase: 'error', ok: false, error: String((err && err.message) || err) }); }
    return;
  }
  const t0 = performance.now();
  let bitmap = null;
  try {
    bitmap = await createImageBitmap(job.blob);   // honours the camera's EXIF orientation
    const srcW = bitmap.width, srcH = bitmap.height;

    // Checks on the still, at the same 540x960 analysis size as the preview.
    const map = mapper(job.previewAspect, srcW, srcH);
    const actx = new OffscreenCanvas(540, 960).getContext('2d', { willReadFrequently: true });
    const m = measure(actx, bitmap, srcW, srcH, job.zone ? job.zone.map(map) : null, job.spotShare);
    // Extra: sharpness of a 1080 px centre crop at full size (for the record; not a gate).
    const cs = Math.min(1080, srcW, srcH), cx = Math.round((srcW - cs) / 2), cy = Math.round((srcH - cs) / 2);
    const cctx = new OffscreenCanvas(cs, cs).getContext('2d', { willReadFrequently: true });
    cctx.drawImage(bitmap, cx, cy, cs, cs, 0, 0, cs, cs);
    const hiSharp = edgeVariance(toGray(cctx.getImageData(0, 0, cs, cs).data), cs, cs);

    let probe = null;   // a smaller copy for the barcode re-check on the main thread (label photo)
    if (job.probeLong) {
      const s = Math.min(1, job.probeLong / Math.max(srcW, srcH));
      probe = await createImageBitmap(bitmap, { resizeWidth: Math.round(srcW * s), resizeHeight: Math.round(srcH * s), resizeQuality: 'high' });
    }
    const ps = Math.min(1, 1280 / Math.max(srcW, srcH)), pc = new OffscreenCanvas(Math.round(srcW * ps), Math.round(srcH * ps));
    pc.getContext('2d').drawImage(bitmap, 0, 0, pc.width, pc.height);
    const preview = await pc.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
    const read = job.read ? await readImages(bitmap, job.read, map) : null;
    self.postMessage({
      id: job.id, phase: 'checked', ok: true, src: { w: srcW, h: srcH }, probe, preview, read,
      metrics: { sharp: m.sharp, bright: m.bright, glare: m.glare, spot: m.spot, worst: m.worst, hiSharp }, ms: Math.round(performance.now() - t0),
    }, probe ? [probe] : []);

    // Reading photos: a camera JPEG that already fits is kept exactly as the camera made it (full resolution,
    // the camera's own EXIF with its capture time and phone model).
    if (job.keepOriginal && job.blob.type === 'image/jpeg' && job.blob.size <= job.keepOriginal) {
      if (cancelled.has(job.id)) throw new Error('cancelled');
      self.postMessage({
        id: job.id, phase: 'done', ok: true, jpeg: job.blob, width: srcW, height: srcH, quality: 'original', bytes: job.blob.size, encodes: 0,
        ms: Math.round(performance.now() - t0),
      });
      return;
    }
    const ex = job.exif;
    const exifFor = (w, h) => buildExif({ ...ex, date: new Date(ex.dateMs), width: w, height: h });
    const budget = job.maxBytes - exifFor(0, 0).length;
    let fit;
    try {
      fit = await fitJpeg(bitmap, job.maxLong, budget, job.minQuality, () => cancelled.has(job.id));
    } catch (err) {
      // A very large photo can run the phone out of memory while encoding: try again at 6,000 px.
      if (cancelled.has(job.id) || Math.max(srcW, srcH) <= 6000) throw err;
      fit = await fitJpeg(bitmap, 6000, budget, job.minQuality, () => cancelled.has(job.id));
    }
    const bytes = insertExif(new Uint8Array(await fit.blob.arrayBuffer()), exifFor(fit.w, fit.h));
    const jpeg = new Blob([bytes], { type: 'image/jpeg' });
    self.postMessage({
      id: job.id, phase: 'done', ok: true, jpeg, width: fit.w, height: fit.h, quality: fit.q, bytes: jpeg.size, encodes: fit.encodes,
      ms: Math.round(performance.now() - t0),
    });
  } catch (err) {
    self.postMessage({ id: job.id, phase: 'error', ok: false, error: String((err && err.message) || err) });
  } finally {
    if (bitmap) bitmap.close();
    cancelled.delete(job.id);
  }
};
