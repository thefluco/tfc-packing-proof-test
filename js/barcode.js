// Barcode reading: Chrome's built-in BarcodeDetector (Android 83+ with Google Play services), else the
// MIT-licensed `barcode-detector` library (ZXing compiled to WebAssembly), loaded only when needed.
import { BARCODE_FALLBACK_URL, BARCODE_FORMATS } from './config.js';

let detectorP = null;
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

// [{rawValue, format, box:{x,y,w,h} normalised to the source size}]
export async function detect(source, sw, sh) {
  const d = await getDetector();
  const found = await d.detect(source);
  return found.map((b) => ({
    rawValue: b.rawValue,
    format: b.format,
    box: b.boundingBox ? { x: b.boundingBox.x / sw, y: b.boundingBox.y / sh, w: b.boundingBox.width / sw, h: b.boundingBox.height / sh } : null,
  }));
}
