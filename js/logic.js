// Pure logic: readings, numbers to book, file names, barcode -> AWB, IST times. No DOM, no storage.

// ---------------------------------------------------------------- readings and the numbers to book
// A typed reading ("16.85", "16,85", " 103.5 ") as an exact integer count of thousandths (grams for kg,
// hundredths of a mm for cm). Integer maths avoids float surprises such as 16.85 * 10 = 168.49999.
export function toThousandths(s) {
  const t = String(s ?? '').trim().replace(',', '.');
  if (!/^\d{1,4}(\.\d{1,3})?$/.test(t)) return null;
  const [i, f = ''] = t.split('.');
  return Number(i) * 1000 + Number((f + '000').slice(0, 3));
}

export const LIMITS = {
  weight: [0.05, 150, 'kg'],
  length: [5, 300, 'cm'],
  breadth: [1, 200, 'cm'],
  height: [1, 200, 'cm'],
};

// '' when fine, else a short reason.
export function checkReading(field, s) {
  const t = toThousandths(s);
  if (t === null) return 'Type a number, e.g. ' + (field === 'weight' ? '16.85' : '103.5');
  const [lo, hi, unit] = LIMITS[field];
  if (t < lo * 1000 || t > hi * 1000) return `Must be between ${lo} and ${hi} ${unit}`;
  return '';
}

// Each side rounded up to the next whole cm (120 stays 120, 120.01 becomes 121).
export function bookCm(s) {
  const t = toThousandths(s);
  return t === null ? null : Math.floor((t + 999) / 1000);
}

// Weight rounded up to the next 0.1 kg, as text with one decimal (16.85 -> "16.9", 16.8 -> "16.8").
export function bookKg(s) {
  const t = toThousandths(s);
  if (t === null) return null;
  const tenths = Math.floor((t + 99) / 100);
  return `${Math.floor(tenths / 10)}.${tenths % 10}`;
}

export function bookNumbers(r) {
  return { weight: bookKg(r.weight), length: bookCm(r.length), breadth: bookCm(r.breadth), height: bookCm(r.height) };
}

// Warnings that do not block (the SOP measures soft rolls as they lie, so these are only hints).
export function readingWarnings(r) {
  const w = [];
  const L = toThousandths(r.length), B = toThousandths(r.breadth), H = toThousandths(r.height);
  if (L !== null && B !== null && H !== null && L < Math.max(B, H)) w.push('Length is shorter than breadth or height - check the end panel reading.');
  return w;
}

// ---------------------------------------------------------------- readings from the photo reader
// The fence is read on B1 and B2; book the larger (errs on the bigger side, as the courier's machine would).
export function breadthFrom(b1, b2) {
  const t1 = toThousandths(b1), t2 = toThousandths(b2);
  if (t1 === null) return t2 === null ? '' : b2;
  if (t2 === null) return b1;
  return t2 > t1 ? b2 : b1;
}

// Book number for one field, from a reading string.
export function bookFor(field, s) { return field === 'weight' ? bookKg(s) : bookCm(s); }

// "weight read (high) · length read (medium) · breadth typed (read 25) · height read (high)"
export function sourcesLine(reads) {
  return ['weight', 'length', 'breadth', 'height'].map((f) => {
    const r = reads && reads[f];
    if (!r) return `${f} -`;
    if (r.source === 'typed') return `${f} typed${r.read_value ? ` (read ${r.read_value})` : ''}`;
    return `${f} read (${r.confidence || '?'})`;
  }).join(' · ');
}

// ---------------------------------------------------------------- file names
// <AWB>[-b<box>]-ours-<label|scale|length-height|breadth|boxes>-<nn>.jpg  (box only for multi-box; never for "boxes").
// Reading photos (taken before the label) are -ours-measure-<scale|length-height|breadth>-<nn>.jpg: kept as the basis
// of the booked numbers, and on purpose NOT matched by sync.py's dispute-photo pattern.
export const NAME_RE = /^([A-Z0-9]{6,20})(?:-b(\d{1,2}))?-ours-(label|scale|length-height|breadth|boxes|measure-scale|measure-length|measure-breadth|measure-height)-(\d{2})\.jpg$/;

export function photoName({ awb, box, boxes, kind, nn }) {
  if (!(nn >= 1 && nn <= 99)) throw new Error('photo number out of range: ' + nn);
  const b = boxes > 1 && kind !== 'boxes' ? `-b${box}` : '';
  return `${awb}${b}-ours-${kind}-${String(nn).padStart(2, '0')}.jpg`;
}

// ---------------------------------------------------------------- barcodes -> AWB
export function normCode(v) {
  return String(v ?? '').replace(/\s+/g, '').toUpperCase();
}

// What looks like an AWB: up to 4 letters then 8-16 digits (Delhivery/Shipmozo/Cargo AWBs are 14 digits).
export const AWB_LIKE = /^[A-Z]{0,4}\d{8,16}$/;
export const AWB_OK = /^[A-Z0-9]{6,20}$/;   // what the backend accepts (typed AWBs included)

// From a list of decoded barcodes: AWB-like candidates (unique, in order) and an order ref if one is printed.
export function readCodes(barcodes) {
  const all = [], cands = [];
  let orderRef = '';
  for (const b of barcodes || []) {
    const raw = String(b.rawValue ?? b ?? '').trim();
    if (!raw) continue;
    const v = normCode(raw);
    if (!all.includes(v)) all.push(v);
    if (AWB_LIKE.test(v)) { if (!cands.includes(v)) cands.push(v); continue; }
    const m = raw.match(/TFC-?0*\d{6,}/i);
    if (m && !orderRef) orderRef = m[0].toUpperCase();
    if (b.format === 'qr_code') {   // a QR may carry the AWB inside a URL or text
      for (const x of raw.matchAll(/(?<!\d)(\d{10,14})(?!\d)/g)) if (!cands.includes(x[1])) cands.push(x[1]);
    }
  }
  return { all, cands, orderRef };
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
  if (c.forced) parts.push('FORCED (taken anyway)');
  parts.push(c.pass ? 'pass' : 'FAIL: ' + (c.reasons || []).join('; '));
  if (s.sharp != null) parts.push(`sharp ${Math.round(s.sharp)}/${c.level ?? '?'}` + (c.trigger ? ` (preview ${Math.round(c.trigger)})` : ''));
  if (c.steady_ms != null) parts.push(`steady ${(c.steady_ms / 1000).toFixed(1)}s`);
  if (s.bright != null) parts.push(`light ${Math.round(s.bright)}`);
  if (s.glare != null) parts.push(`glare ${(s.glare * 100).toFixed(1)}%` + (s.spot ? ' SPOT' : ''));
  if (c.barcode) parts.push(c.barcode);
  if (c.size) parts.push(`${c.size} px ${c.quality === 'original' ? 'as the camera saved it' : 'q' + c.quality} ${Math.round((c.bytes || 0) / 1024)} KB`);
  if (c.via) parts.push(`from ${c.via === 'imagecapture' ? 'in-app camera' : c.via}${c.src && c.src !== c.size ? ` (camera ${c.src})` : ''}`);
  if (c.taken_ago_min) parts.push(`taken ${c.taken_ago_min} min before it was added`);
  return parts.join(' · ');
}
