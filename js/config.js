// TFC Packing Proof - settings that are safe to publish.
// The station key is NOT here and must never be: it is typed once on the phone (supervisor Settings).

export const APP_VERSION = '2.0.0';

// The Apps Script web-app URL (.../exec). Not a secret: the script refuses anything without the station key.
// Fill it in before uploading to GitHub Pages, or paste it in Settings on the phone (Settings wins).
export const DEFAULT_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzGZBe_9-SrDzbniZrZ2Afjspl8IZpLGvm-Fxr9gXqBM-wiFeV8H5-0JLWWrxXCl3eX/exec';

// v2 (owner, 17 Oct): two stages, and the first photo picks the stage.
//  MEASURE (blue), before booking: per box the packing slip, then weight, length, breadth, height. The numbers are
//          read later in the office (the batch read); the phone only checks the slip's order number.
//  PROOF (green), after booking: per box the courier label (stuck next to the slip), then weight, length, breadth,
//          height, each with the label in view; plus all boxes in one photo for a multi-box order. The label photo
//          also checks that the label belongs to the slip's order.
export const MEASURE_KINDS = ['slip', 'scale', 'length', 'breadth', 'height'];
export const PROOF_KINDS = ['label', 'scale', 'length', 'breadth', 'height'];
export const STAGE_KINDS = { measure: MEASURE_KINDS, proof: PROOF_KINDS };

// Every photo is kept at the camera's full resolution: a camera JPEG up to this size is kept exactly as the camera
// made it (with the camera's own EXIF); a bigger one is re-saved to fit. The Shipmozo agent makes its own copies
// under 2 MB when it uploads proof photos.
export const READ_MAX_BYTES = 6000000;
export const MIN_QUALITY = 0.80;        // below this the photo shrinks instead of losing more quality

// The automatic checks on each photo (the same score as the 15 Oct frame trial: variance of an edge map on a
// 540x960 grey copy). "first" is the photo from the home screen, before the stage is known.
export const DEFAULT_LEVELS = {
  sharp: { first: 300, slip: 300, label: 300, scale: 120, length: 150, breadth: 150, height: 150, boxes: 120 },
  brightMin: 50,          // mean brightness 0-255
  brightMax: 225,
  glareSpot: 0.40,        // a block this full of burnt-out pixels is a glare spot
  glareFrame: 0.03,       // share of burnt-out pixels allowed in the checked area
  tries: 2,               // "Use this photo" (flagged for the supervisor) appears after this many failed tries
  oldPhotoMin: 30,        // a photo older than this (minutes) is refused
};

// The order-number reader (Tesseract.js, Apache-2.0), stored with the app and cached by the service worker. It is
// tuned to read only "TFC-" and digits, and tries a larger copy of the photo when the first pass finds nothing.
export const OCR = {
  base: '../vendor/tesseract/',     // relative to js/
  whitelist: 'TFC-0123456789',
  passes: [1600, 2600],             // long side (px) of the copy that is read, in order
};

// Barcode reading: Chrome's built-in BarcodeDetector, else this MIT library (ZXing in WebAssembly), loaded once.
export const BARCODE_FALLBACK_URL = 'https://cdn.jsdelivr.net/npm/barcode-detector@3.2.2/dist/es/ponyfill.min.js';
// data_matrix / pdf417: courier labels (Delhivery) carry the AWB in a square 2D code too, which survives a far photo
export const BARCODE_FORMATS = ['code_128', 'code_39', 'code_93', 'codabar', 'itf', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'qr_code', 'data_matrix', 'pdf417'];

export const DEMO_AWB = '99001610201601';     // demo camera only (desktop testing); never a real shipment
export const DEMO_ORDER = 'TFC-001599991';    // the made-up slip of the demo camera and the tests

// Test backend: Code.gs run in the browser on a fake Drive and Sheet (nothing reaches Google).
// In the workspace it is used only with ?harness=1. tests/make_test_site.py builds a TEST site where it is always on.
export const TEST_SITE = false;
export const TEST_BACKEND = '../../tests/gas-harness.js';   // relative to js/main.js
