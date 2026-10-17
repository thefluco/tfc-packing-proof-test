// The reader: sends a reading photo to the backend's "read" action, which asks Claude (vision) for the numbers.
// The phone never holds the production AI key; the backend keeps it in Script Properties.
import { APP_VERSION } from './config.js';
import { blobToBase64, transport } from './uploader.js';
import { breadthFrom, toThousandths } from './logic.js';
import { inBay } from './overlay.js';

const clamp = (v) => Math.max(0, Math.min(1, v));
function rectAround(pts, pad) {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [clamp(Math.min(...xs) - pad), clamp(Math.min(...ys) - pad), clamp(Math.max(...xs) + pad), clamp(Math.max(...ys) + pad)];
}
const fits = (c, aspect) => !!(c && c.pts && Math.abs(c.aspect - aspect) / aspect < 0.05);

// Close-ups of the printed scales, from the calibrated mount outline (normalised preview coordinates).
// Without a calibration the reader gets the whole photo only.
export function readCrops(kind, calib, aspect) {
  if (/^measure-(length|breadth|height)$/.test(kind)) return [];   // v1.3 tape close-ups: the whole photo is the close-up
  const base = kind.replace(/^measure-/, '');
  calib = calib || {};
  if ((base === 'length-height' || base === 'breadth') && fits(calib.bay, aspect)) {
    const q = calib.bay.pts, strip = (u0, u1, v0, v1) => rectAround([inBay(q, u0, v0), inBay(q, u1, v0), inBay(q, u1, v1), inBay(q, u0, v1)], 0.02);
    if (base === 'length-height') {
      return [
        { label: 'close-up of scale L along the front edge, left half', rect: strip(-0.02, 0.56, 0.8, 1.12) },
        { label: 'close-up of scale L along the front edge, right half', rect: strip(0.44, 1.03, 0.8, 1.12) },
      ];
    }
    return [
      { label: 'close-up of scale B1 at the left end', rect: strip(-0.07, 0.14, -0.03, 1.1) },
      { label: 'close-up of scale B2 at the right end', rect: strip(0.86, 1.07, -0.03, 1.1) },
    ];
  }
  if (base === 'scale' && fits(calib.scale, aspect) && calib.scale.display) {
    return [{ label: 'close-up of the scale display', rect: rectAround(calib.scale.display, 0.05) }];
  }
  return [];
}

// -> {ok, values:{weight|length,height|breadth}, confidence, flags, notes, split} or {ok:false, code, error}
export async function requestRead(st, kind, images, demoTruth) {
  if (!st.scriptUrl) return { ok: false, code: 'no_backend', error: 'no backend set (Settings)' };
  const payload = {
    v: 1, action: 'read', key: st.key, station: st.station, app: APP_VERSION, phone: st.phoneModel || '', test: !!st.test, kind,
    images: await Promise.all(images.map(async (im) => ({ label: im.label, b64: await blobToBase64(im.blob) }))),
  };
  if (st.demo && demoTruth) payload.demo_truth = demoTruth;
  let r;
  try { r = await transport.post(st.scriptUrl, payload, 150000); } catch (e) { r = { ok: false, code: 'network', error: String((e && e.message) || e) }; }
  if (!r) return { ok: false, code: 'reader_error', error: 'no reply' };
  if (r.ok) {
    const v = r.values || (r.values = {});
    if (v.b1 || v.b2) {
      v.breadth = breadthFrom(v.b1, v.b2);
      const t1 = toThousandths(v.b1), t2 = toThousandths(v.b2);
      r.split = t1 !== null && t2 !== null && Math.abs(t1 - t2) > 1000 ? `B1 reads ${v.b1}, B2 reads ${v.b2}: the fence is not square` : '';
    }
    r.confidence = r.confidence || {};
  }
  return r;
}
