// Pure logic: file names, barcodes, order numbers, the stage pick, IST times. No DOM, no storage.

// ---------------------------------------------------------------- file names
// PROOF (after booking): <AWB>[-b<box>]-ours-<label|scale|length|breadth|height|boxes>-<nn>.jpg, "-b<box>" only for a
// multi-box order and never on "boxes". The retired kinds (length-height, measure-*) are still accepted by the backend
// so an old phone's queue can finish.
export const NAME_RE = /^([A-Z0-9]{6,20})(?:-b(\d{1,2}))?-ours-(label|scale|length|breadth|height|length-height|boxes|measure-scale|measure-length|measure-breadth|measure-height)-(\d{2})\.jpg$/;

export function photoName({ awb, box, boxes, kind, nn }) {
  if (!(nn >= 1 && nn <= 99)) throw new Error('photo number out of range: ' + nn);
  const b = boxes > 1 && kind !== 'boxes' ? `-b${box}` : '';
  return `${awb}${b}-ours-${kind}-${String(nn).padStart(2, '0')}.jpg`;
}

// MEASURE (before booking): <record>[-b<box>]-pre-<slip|scale|length|breadth|height>-<nn>.jpg. Named by record,
// never by order number (a misread can never misfile a photo); "-pre-" keeps them out of the dispute agents'
// "-ours-" pattern. The box count is not known while measuring, so box 1 has no "-b" and boxes 2+ have one.
export const PRE_NAME_RE = /^(M-\d{8}-\d{6}-[0-9a-z]{6})(?:-b(\d{1,2}))?-pre-(slip|scale|length|breadth|height)-(\d{2})\.jpg$/;

export function prePhotoName({ record, box, kind, nn }) {
  if (!(nn >= 1 && nn <= 99)) throw new Error('photo number out of range: ' + nn);
  return `${record}${box > 1 ? `-b${box}` : ''}-pre-${kind}-${String(nn).padStart(2, '0')}.jpg`;
}

// ---------------------------------------------------------------- barcodes -> AWB
export function normCode(v) {
  return String(v ?? '').replace(/\s+/g, '').toUpperCase();
}

// What looks like an AWB: up to 4 letters then 8-16 digits (Delhivery/Shipmozo/Cargo AWBs are 14 digits).
export const AWB_LIKE = /^[A-Z]{0,4}\d{8,16}$/;
export const AWB_OK = /^[A-Z0-9]{6,20}$/;   // what the backend accepts (typed AWBs included)
// Product barcodes: never an AWB, never a reason to switch the stage.
export const PRODUCT_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];

// The packing slip's own barcode: Code 39 carrying "TFC-" + 9 digits (Shopify template, 21 Oct 2026). A barcode with
// an order number in any other format is the courier label's own.
export const SLIP_FORMAT = 'code_39';
const ORDER_IN_CODE = /TFC-?0*\d{6,}/i;
export const isSlipCode = (b) => !!b && b.format === SLIP_FORMAT && ORDER_IN_CODE.test(String(b.rawValue ?? ''));

// From a list of decoded barcodes: AWB-like candidates (unique, in order; product barcodes left out), the order
// number when the label carries one as a barcode (Shipmozo's "Ref ID"), and the slip's own order barcode(s).
export function readCodes(barcodes) {
  const all = [], cands = [], slipOrders = [];
  let orderRef = '';
  for (const b of barcodes || []) {
    const raw = String(b.rawValue ?? b ?? '').trim();
    if (!raw) continue;
    const v = normCode(raw);
    if (!all.includes(v)) all.push(v);
    if (PRODUCT_FORMATS.includes(b.format)) continue;
    if (isSlipCode(b)) { const o = normOrder(raw.match(ORDER_IN_CODE)[0]); if (o && !slipOrders.includes(o)) slipOrders.push(o); continue; }
    if (AWB_LIKE.test(v)) { if (!cands.includes(v)) cands.push(v); continue; }
    const m = raw.match(ORDER_IN_CODE);
    if (m && !orderRef) orderRef = normOrder(m[0]);
    if (b.format === 'qr_code') {   // a QR may carry the AWB inside a URL or text
      for (const x of raw.matchAll(/(?<!\d)(\d{10,14})(?!\d)/g)) if (!cands.includes(x[1])) cands.push(x[1]);
    }
  }
  return { all, cands, orderRef, slipOrders };
}

// A label photographed sideways: its main 1D barcode is taller than wide in the photo (the text reader then needs the
// copy turned by 90 degrees; barcodes read at any angle).
export function sideways(barcodes) {
  const b = (barcodes || []).filter((x) => x && x.box && !['qr_code', 'data_matrix', 'pdf417'].includes(x.format) && !PRODUCT_FORMATS.includes(x.format))
    .sort((p, q) => Math.max(q.box.w, q.box.h) - Math.max(p.box.w, p.box.h))[0];
  return !!b && b.box.h > b.box.w * 1.5;
}

// ---------------------------------------------------------------- order numbers ("TFC-" + 9 digits)
// "TFC-001512345", "#TFC-001512345", "tfc 1512345", "1512345" -> "TFC-001512345"; anything else -> "".
export function normOrder(v) {
  const t = String(v ?? '').toUpperCase().replace(/[#\s]/g, '').replace(/^ORDER/, '');
  const m = /^(?:TFC)?-?0*(\d{1,9})$/.exec(t);
  return m ? 'TFC-' + m[1].padStart(9, '0') : '';
}

// The reader's text with look-alike dashes made plain. A reader may put a single space inside a number, so the
// patterns below allow one between digits (but never join two numbers that stand apart).
function cleanText(text) {
  return String(text ?? '').toUpperCase().replace(/[‐‑‒–—―_=~]/g, '-');
}

// Every order number in a text read from a photo (MEASURE: the slip, cold). Only "TFC-" + 9 digits counts, with
// what a reader makes of the letters and the dash (TF-, FC-, a dropped dash); never a bare run of digits.
export function orderNumbersIn(text) {
  const out = [];
  for (const m of cleanText(text).matchAll(/(?:TFC|TF|FC|TC)\s*[-.:]?\s*((?:\d ?){8}\d)(?!\d)/g)) {
    const o = 'TFC-' + m[1].replace(/ /g, '');
    if (!out.includes(o)) out.push(o);
  }
  return out;
}

// PROOF (verify only): is this one expected order number in the text? Its 9 digits must stand on their own (a
// 10-digit phone number that happens to contain them does not count).
export function hasOrder(text, expected) {
  const d = normOrder(expected).slice(4);
  if (!d) return false;
  return new RegExp(`(?<!\\d)${d.split('').join(' ?')}(?!\\d)`).test(cleanText(text));
}

// ---------------------------------------------------------------- the label-slip check (PROOF)
// The courier label prints its own order number too, so a number read on the label proves nothing about the slip.
// The label's band in the photo comes from its barcodes (boxes 0..1 of the photo): along the main barcode's long
// axis, a little wider than the barcodes, right across the photo. The slip goes right next to the label (owner,
// 17 Oct), so text in the band is the label's and text outside it is the slip's.
export function labelZone(barcodes) {
  const boxes = (barcodes || []).filter((b) => b && b.box && !PRODUCT_FORMATS.includes(b.format) && !isSlipCode(b)).map((b) => b.box);
  if (!boxes.length) return null;
  const x0 = Math.min(...boxes.map((b) => b.x)), x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y0 = Math.min(...boxes.map((b) => b.y)), y1 = Math.max(...boxes.map((b) => b.y + b.h));
  const main = boxes.reduce((a, b) => (Math.max(b.w, b.h) > Math.max(a.w, a.h) ? b : a));
  return main.w >= main.h ? { axis: 'x', lo: x0 - 0.2 * (x1 - x0), hi: x1 + 0.2 * (x1 - x0) }
    : { axis: 'y', lo: y0 - 0.2 * (y1 - y0), hi: y1 + 0.2 * (y1 - y0) };
}

// The reader's hits outside the label's band (all of them when no label was located). A hit with no known place
// counts as the label's when there is a label.
export function outsideLabel(hits, zone) {
  const inLabel = (h) => !!zone && (h.x == null || (zone.axis === 'x' ? h.x >= zone.lo && h.x <= zone.hi : h.y >= zone.lo && h.y <= zone.hi));
  return (hits || []).filter((h) => !inLabel(h));
}

// MEASURE: the slip's order number, read cold. Exactly one number read (outside the label) -> that number. Two or
// more different ones (a misread digit, another order's paper in the photo) -> no guess: `cands`, most-read first,
// for the staff to pick from (19 Oct: the phone read ...448 and ...449 off one slip and kept the wrong one).
export function slipOrderOf(hits, zone) {
  const n = new Map();
  for (const h of outsideLabel(hits, zone)) n.set(h.order, (n.get(h.order) || 0) + 1);
  const cands = [...n.keys()].sort((a, b) => n.get(b) - n.get(a));
  return { order: cands.length === 1 ? cands[0] : '', cands };
}

// Verify only: the expected order number must be read outside the label, in a pass that read no other order
// number there. hits: [{order, x, y, pass}] from the reader (x/y null = place unknown, counted as the label's when
// the label was located). -> {result: 'match'|'no match', why: ''|'different'|'not found', seen}
export function slipCheck(expected, hits, zone) {
  const exp = normOrder(expected);
  const out = outsideLabel(hits, zone);
  for (const p of [...new Set(out.map((h) => h.pass))]) {
    const ph = out.filter((h) => h.pass === p);
    if (ph.some((h) => h.order === exp) && ph.every((h) => h.order === exp)) return { result: 'match', why: '', seen: exp };
  }
  const other = out.find((h) => h.order !== exp);
  if (other) return { result: 'no match', why: 'different', seen: other.order };
  return { result: 'no match', why: 'not found', seen: '' };
}

// What the phone read on the slip: from the slip's barcode when there is one (exact; two different slip barcodes in
// one photo are never guessed between), else from the text reader (slipOrderOf).
// o = {bar: [orders] | undefined, hits} -> {order, cands, via: 'barcode'|'reader'}
export function slipRead(o, zone) {
  if (o && o.bar && o.bar.length) return { order: o.bar.length === 1 ? o.bar[0] : '', cands: [...o.bar], via: 'barcode' };
  return { ...slipOrderOf((o && o.hits) || [], zone), via: 'reader' };
}

// The label-slip check: on the slip's barcode when there is one (every slip barcode in the photo must be the expected
// order), else on the text reader's hits (slipCheck).
export function labelSlipCheck(expected, o, zone) {
  if (o && o.bar && o.bar.length) {
    const exp = normOrder(expected), other = o.bar.find((x) => x !== exp);
    return other ? { result: 'no match', why: 'different', seen: other } : { result: 'match', why: '', seen: exp };
  }
  return slipCheck(expected, (o && o.hits) || [], zone);
}

// ---------------------------------------------------------------- the stage pick (design note section 2)
// The first photo picks the stage, on positive evidence only:
//  - a courier barcode whose AWB is booked in the Pre-booking tab -> PROOF (with a slip too: the same photo runs the
//    label-slip check);
//  - a slip order number and no courier barcode -> MEASURE;
//  - anything else (nothing readable, a courier barcode that is not booked, no internet for the check) -> ask.
// A stage is never picked because nothing was found. Product barcodes never count (readCodes leaves them out).
// A supervisor can lock the phone to one stage; a booked label on a MEASURE-only phone is "booked" (stick the label
// first: that parcel needs PROOF).
//   e = {codes: [AWB-like codes], booked: code or '', lookupFailed: bool, slipOrder: 'TFC-...' or '', lock: ''|'measure'|'proof'}
export function pickStage(e) {
  if (e.lock === 'measure') return e.booked ? { stage: 'booked', why: 'a booked label on a MEASURE-only phone' } : { stage: 'measure', why: 'phone locked to MEASURE' };
  if (e.lock === 'proof') return { stage: 'proof', why: 'phone locked to PROOF' };
  if (e.booked) return { stage: 'proof', why: e.slipOrder ? 'booked label and the slip' : 'booked label' };
  if (e.codes && e.codes.length) return { stage: 'ask', why: e.lookupFailed ? 'no internet for the booking check' : 'a courier barcode that is not booked' };
  if (e.slipOrder) return { stage: 'measure', why: 'slip order number, no courier barcode' };
  return { stage: 'ask', why: 'nothing readable' };
}

// ---------------------------------------------------------------- time (the station runs on IST)
const IST_MS = 330 * 60000;
const p2 = (n) => String(n).padStart(2, '0');

export function istParts(d = new Date()) {
  const t = new Date(d.getTime() + IST_MS);
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes(), s: t.getUTCSeconds(), dow: t.getUTCDay() };
}
export function istMonth(d = new Date()) { const p = istParts(d); return `${p.y}-${p2(p.mo)}`; }
export function istDay(d = new Date()) { const p = istParts(d); return `${p.y}-${p2(p.mo)}-${p2(p.d)}`; }
export function istClock(d = new Date()) { const p = istParts(d); return `${p2(p.h)}:${p2(p.mi)}:${p2(p.s)}`; }
export function istStamp(d = new Date()) { return `${istDay(d)} ${istClock(d)}`; }

// ISO 8601 with the phone's own offset, e.g. 2026-10-16T10:12:03.120+05:30
export function isoLocal(d = new Date()) {
  const off = -d.getTimezoneOffset(), sign = off >= 0 ? '+' : '-', a = Math.abs(off);
  const z = new Date(d.getTime() + off * 60000);
  return z.toISOString().replace('Z', '') + `${sign}${p2(Math.floor(a / 60))}:${p2(a % 60)}`;
}

// ---------------------------------------------------------------- ids
// S-... a PROOF record, M-... a MEASURE record: <prefix>-YYYYMMDD-HHMMSS-<6 hex> (IST).
export function newId(prefix) {
  const p = istParts();
  const rnd = Array.from(crypto.getRandomValues(new Uint8Array(3)), (x) => x.toString(16).padStart(2, '0')).join('');
  return `${prefix}-${p.y}${p2(p.mo)}${p2(p.d)}-${p2(p.h)}${p2(p.mi)}${p2(p.s)}-${rnd}`;
}

export function uuid() {
  return crypto.randomUUID ? crypto.randomUUID()
    : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16));
}

// ---------------------------------------------------------------- check results as one short line for the Sheet
export function checksLine(c) {
  if (!c) return '';
  const s = c.still || {}, parts = [];
  if (c.captured_at) parts.push(c.captured_at.slice(11, 19));
  if (c.forced) parts.push(`FORCED (used after ${c.tries || 2} tries)`);
  parts.push(c.pass ? 'pass' : 'FAIL: ' + (c.reasons || []).join('; '));
  if (s.sharp != null) parts.push(`sharp ${Math.round(s.sharp)}/${c.level ?? '?'}`);
  if (s.bright != null) parts.push(`light ${Math.round(s.bright)}`);
  if (s.glare != null) parts.push(`glare ${(s.glare * 100).toFixed(1)}%` + (s.spot ? ' SPOT' : ''));
  if (c.barcode) parts.push(c.barcode);
  if (c.ocr) parts.push(c.ocr);
  if (c.size) parts.push(`${c.size} px ${c.quality === 'original' ? 'as the camera saved it' : 'q' + c.quality} ${Math.round((c.bytes || 0) / 1024)} KB`);
  if (c.via) parts.push(`from ${c.via}${c.src && c.src !== c.size ? ` (camera ${c.src})` : ''}`);
  if (c.taken_ago_min) parts.push(`taken ${c.taken_ago_min} min before it was added`);
  return parts.join(' · ');
}
