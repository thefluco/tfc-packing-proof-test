// Barcode reading: Chrome's built-in BarcodeDetector (Android 83+ with Google Play services), else the
// MIT-licensed `barcode-detector` library (ZXing compiled to WebAssembly), loaded only when needed.
import { BARCODE_FALLBACK_URL, BARCODE_FORMATS } from './config.js';

let detectorP = null, libraryP = null;
export let engine = 'none';

export function getDetector() {
  if (detectorP) return detectorP;
  detectorP = (async () => {
    if ('BarcodeDetector' in self) {
      try {
        const have = await self.BarcodeDetector.getSupportedFormats();
        if (have.includes('code_128')) {
          engine = 'built-in';
          return new self.BarcodeDetector({ formats: BARCODE_FORMATS.filter((f) => have.includes(f)) });
        }
      } catch { /* fall through to the library */ }
    }
    const mod = await import(BARCODE_FALLBACK_URL);
    engine = 'zxing';
    return new mod.BarcodeDetector({ formats: BARCODE_FORMATS });
  })();
  detectorP.catch(() => { detectorP = null; engine = 'none'; });
  return detectorP;
}

// The library alone (ZXing), for a second look when the built-in reader found nothing.
function getLibrary() {
  if (!libraryP) {
    libraryP = import(BARCODE_FALLBACK_URL).then((mod) => new mod.BarcodeDetector({ formats: BARCODE_FORMATS }));
    libraryP.catch(() => { libraryP = null; });
  }
  return libraryP;
}

// Fetches the library (and its WebAssembly) once in the background on a phone with the built-in reader, so the
// second look is quick when it is needed; the service worker keeps both.
export function warmLibrary() {
  getDetector().then(() => {
    if (engine === 'built-in') getLibrary().then((d) => d.detect(new ImageData(8, 8))).catch(() => {});
  }).catch(() => {});
}

const norm = (found, sw, sh) => found.map((b) => ({
  rawValue: b.rawValue,
  format: b.format,
  box: b.boundingBox ? { x: b.boundingBox.x / sw, y: b.boundingBox.y / sh, w: b.boundingBox.width / sw, h: b.boundingBox.height / sh } : null,
}));

// [{rawValue, format, box:{x,y,w,h} normalised to the source size}]
export async function detect(source, sw, sh) {
  const d = await getDetector();
  return norm(await d.detect(source), sw, sh);
}
async function detectLibrary(source, sw, sh) {
  return norm(await (await getLibrary()).detect(source), sw, sh);
}

// A photo of the whole parcel leaves the label's barcode small, and the phone's built-in reader works on a smaller
// copy of the picture, so it can miss it (19 Oct: a Delhivery label next to the slip was not seen; ZXing read it
// at every size). When `want(found)` is not met: the reader again on overlapping quarters of the photo (and its
// middle), then - only if the built-in reader is in use - the ZXing library on the whole photo.
// -> {found (boxes normalised to the whole photo), how: 'whole photo'|'a part of the photo'|'second reader'|''}
// `primary`/`library` are swapped in by the tests.
export async function detectHard(bitmap, want, { primary = detect, library = detectLibrary, useLibrary = () => engine === 'built-in' } = {}) {
  const W = bitmap.width, H = bitmap.height;
  const safe = async (fn) => { try { return await fn(); } catch { return []; } };
  let found = await safe(() => primary(bitmap, W, H));
  if (want(found)) return { found, how: 'whole photo' };
  const tw = Math.round(W * 0.6), th = Math.round(H * 0.6);
  const at = [[0, 0], [W - tw, 0], [0, H - th], [W - tw, H - th], [Math.round((W - tw) / 2), Math.round((H - th) / 2)]];
  for (const [x, y] of at) {
    const part = await createImageBitmap(bitmap, x, y, tw, th);
    const f = await safe(() => primary(part, tw, th));
    part.close();
    found = found.concat(f.map((b) => ({ ...b, box: b.box && { x: (x + b.box.x * tw) / W, y: (y + b.box.y * th) / H, w: (b.box.w * tw) / W, h: (b.box.h * th) / H } })));
    if (want(found)) return { found, how: 'a part of the photo' };
  }
  if (useLibrary()) {
    found = found.concat(await safe(() => library(bitmap, W, H)));
    if (want(found)) return { found, how: 'second reader' };
  }
  return { found, how: '' };
}
