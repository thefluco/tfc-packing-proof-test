// TFC Packing Proof - settings that are safe to publish.
// The station key is NOT here and must never be: it is typed once on the phone (Settings).

export const APP_VERSION = '1.3.0';

// The Apps Script web-app URL (.../exec). Not a secret: the script refuses anything without the station key.
// Fill it in before uploading to GitHub Pages, or paste it in Settings on the phone (Settings wins).
export const DEFAULT_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzGZBe_9-SrDzbniZrZ2Afjspl8IZpLGvm-Fxr9gXqBM-wiFeV8H5-0JLWWrxXCl3eX/exec';

// PROOF photos: Shipmozo takes at most 4 images of 2 MB each. Stay a little under 2,000,000 bytes.
export const MAX_JPEG_BYTES = 1990000;
export const MAX_LONG_SIDE = 4000;      // SOP: about 3,000 to 4,000 px on the long side
export const MIN_QUALITY = 0.80;        // below this the photo shrinks instead of losing more quality
// READING photos never go to Shipmozo: kept at the camera's full resolution. A camera JPEG up to this size is
// kept exactly as the camera made it (with the camera's own EXIF); a bigger one is re-saved to fit.
export const READ_MAX_BYTES = 6000000;

// Image-first (v1.1): before the label, READING photos per box; the numbers to book are read from them -
// in the app when the backend has a reader (API key), otherwise later from the saved photos (v1.2).
// v1.3: four close-ups, one number each (a tape measure until the measuring station exists).
export const MEASURE_KINDS = ['measure-scale', 'measure-length', 'measure-breadth', 'measure-height'];
export const MEASURE_FIELD = { 'measure-scale': 'weight', 'measure-length': 'length', 'measure-breadth': 'breadth', 'measure-height': 'height' };
export const FIELD_KIND = { weight: 'measure-scale', length: 'measure-length', breadth: 'measure-breadth', height: 'measure-height' };
// After booking and labelling, the PROOF photos per box (SOP steps 7-9): label (photo 1), breadth (photo 4),
// length-height (photo 3), weight (photo 2). Every proof photo shows the label.
export const BOX_KINDS = ['label', 'breadth', 'length-height', 'scale'];
export const ALL_KINDS = ['label', 'scale', 'length-height', 'breadth', 'boxes'];
export const READ_LONG_SIDE = 2576;   // the reader's largest useful image size

export const KIND_INFO = {
  'measure-scale': {
    photo: 'R1', title: 'Weight reading', mount: 'scale', step: 1,
    place: 'Put the box on the scale, resting only on the platform with both ends clear of the floor. Wait until the number stops changing.',
    shows: 'Close to the display: the settled weight large and sharp, with the box on the platform in the picture. The weight is read from this photo.',
  },
  'measure-length': {
    photo: 'R2', title: 'Length reading', mount: null, step: 2,
    place: 'Tape along the longest side, at its longest point. Hold the tape\'s zero exactly at one end (press a flat board against the end if it is round or soft).',
    shows: 'A close-up where the tape meets the OTHER end of the box: the cm number and the marks around it sharp and readable. The length is read from this photo.',
  },
  'measure-breadth': {
    photo: 'R3', title: 'Breadth reading', mount: null, step: 3,
    place: 'Tape across the box at its widest point. Zero exactly at one side (a flat board against a bulge helps).',
    shows: 'A close-up where the tape meets the other side: the cm number and the marks around it sharp and readable. The breadth is read from this photo.',
  },
  'measure-height': {
    photo: 'R4', title: 'Height reading', mount: null, step: 4,
    place: 'Box on a flat surface. Tape standing upright beside it, zero on the surface. Lay a flat board across the highest point of the box so it touches the tape.',
    shows: 'A close-up where the board (or the top of the box) meets the tape: the cm number and the marks around it sharp and readable. The height is read from this photo.',
  },
  'label': {
    photo: 1, title: 'Label', mount: null,
    place: 'Hold the phone about 25 cm above the new label.',
    shows: 'The whole label readable: AWB, barcode, order number, Box x/y, with some of the box around it.',
  },
  'breadth': {
    photo: 4, title: 'Breadth', mount: 'bay',
    place: 'Snap the phone onto the BAY mount. Keep the low fence where it is.',
    shows: 'The low fence touching the widest bulge, its readings on B1 and B2, and the label.',
  },
  'length-height': {
    photo: 3, title: 'Length and height', mount: 'bay',
    place: 'Swap the fence for the end panel and the gauge. Phone stays on the BAY mount.',
    shows: 'The left wall, the end panel at the far end and its reading on scale L, the gauge arm on the highest point and its reading, and the label.',
  },
  'scale': {
    photo: 2, title: 'Weight', mount: 'scale',
    place: 'Put the box back on the scale. Snap the phone onto the SCALE mount.',
    shows: 'The box resting only on the platform, both ends clear of the floor, the settled reading, and the label.',
  },
  'boxes': {
    photo: 5, title: 'All boxes', mount: null,
    place: 'Put every box side by side, each label facing the camera.',
    shows: 'Every box of this order in one photo, every label facing the camera.',
  },
};

// Starting levels for the automatic checks. Calibrate on day one (Settings shows the live numbers).
// Sharpness uses the same score as the 15 Oct frame trial: variance of an edge map on a 540x960 grey copy.
export const DEFAULT_LEVELS = {
  sharp: {
    'label': 300, 'breadth': 150, 'length-height': 150, 'scale': 120, 'boxes': 120,
    'measure-scale': 120, 'measure-length': 150, 'measure-breadth': 150, 'measure-height': 150,
  },
  peakRatio: 0.85,        // a frame must be at least this share of the sharpest frame in the last 3 s
  stillRatio: 0.70,       // the full-size still must keep at least this share of the trigger frame's score
  steadyMs: 500,          // "the picture barely changes for half a second"
  steadyChange: 0.02,     // share of pixels allowed to change between two frames and still count as steady
  brightMin: 50,          // mean brightness 0-255
  brightMax: 225,
  glareSpot: 0.40,        // a block this full of burnt-out pixels is a glare spot
  glareFrame: 0.03,       // share of burnt-out pixels allowed in the checked area
  forceAfterS: 20,        // "Take anyway" appears after this many seconds of failed checks
};

// Fallback barcode reader when Chrome has no built-in BarcodeDetector (MIT, github.com/Sec-ant/barcode-detector).
export const BARCODE_FALLBACK_URL = 'https://cdn.jsdelivr.net/npm/barcode-detector@3.2.2/dist/es/ponyfill.min.js';
export const BARCODE_FORMATS = ['code_128', 'code_39', 'code_93', 'codabar', 'itf', 'ean_13', 'qr_code'];

export const DEMO_AWB = '99001610201601';   // demo camera only (desktop testing); never a real shipment

// Test backend: Code.gs run in the browser on a fake Drive and Sheet (nothing reaches Google).
// In the workspace it is used only with ?harness=1. tests/make_test_site.py builds a TEST site where it is always on.
export const TEST_SITE = false;
export const TEST_BACKEND = '../../tests/gas-harness.js';   // relative to js/main.js
