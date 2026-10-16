// Still worker: decodes the full-size photo, re-runs the checks on it, and encodes the largest JPEG under
// the size cap with our EXIF (capture time, phone model). Runs off the main thread so the camera stays smooth.
// Two replies per job: {phase:'checked'} as soon as the checks are done (with a small preview), then
// {phase:'done'} with the final JPEG. A job whose checks failed can be cancelled before it encodes.
import { measure, edgeVariance, toGray } from './quality.js';
import { buildExif, insertExif } from './exif.js';

const cancelled = new Set();

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
  const t0 = performance.now();
  let bitmap = null;
  try {
    bitmap = await createImageBitmap(job.blob);   // honours the camera's EXIF orientation
    const srcW = bitmap.width, srcH = bitmap.height;

    // Checks on the still, at the same 540x960 analysis size as the preview.
    const actx = new OffscreenCanvas(540, 960).getContext('2d', { willReadFrequently: true });
    const m = measure(actx, bitmap, srcW, srcH, job.zone, job.spotShare);
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
    self.postMessage({
      id: job.id, phase: 'checked', ok: true, src: { w: srcW, h: srcH }, probe, preview,
      metrics: { sharp: m.sharp, bright: m.bright, glare: m.glare, spot: m.spot, worst: m.worst, hiSharp }, ms: Math.round(performance.now() - t0),
    }, probe ? [probe] : []);

    const ex = job.exif;
    const exifFor = (w, h) => buildExif({ ...ex, date: new Date(ex.dateMs), width: w, height: h });
    const budget = job.maxBytes - exifFor(0, 0).length;
    const fit = await fitJpeg(bitmap, job.maxLong, budget, job.minQuality, () => cancelled.has(job.id));
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
