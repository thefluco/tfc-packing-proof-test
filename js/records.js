// Box records: one shipment (order) holds one or more boxes; each box holds its readings, the numbers to book,
// the label scan and its photos. The Sheet gets one row per box (rowSnapshot).
import * as db from './store.js';
import { newId, bookNumbers, checkReading, isoLocal, istMonth, checksLine, photoName } from './logic.js';
import { BOX_KINDS } from './config.js';

const FIELDS = ['weight', 'length', 'height', 'breadth'];

function newBox(s, n) {
  return {
    id: `${s.id}-b${n}`, shipment_id: s.id, n,
    readings: { weight: '', length: '', height: '', breadth: '' }, readings_at: null, book: null,
    label: null, photos: { 'label': [], 'breadth': [], 'length-height': [], 'scale': [] },
    remeasures: [], completed_at: null,
  };
}

export async function createShipment(settings) {
  const s = {
    id: newId('S'), created_at: isoLocal(), station: settings.station || 'Station 1', test: !!settings.test,
    order_ref: '', awb: null, awb_source: null, awb_at: null, month: null,
    boxes: [], booked_at: null, boxes_photo: [], completed_at: null, cancelled_at: null, cancel_reason: '',
  };
  const b = newBox(s, 1);
  s.boxes.push(b.id);
  await db.putMany([['shipments', s], ['boxes', b]]);
  return { s, b };
}

export async function addBox(s) {
  if (s.booked_at) throw new Error('This order is already booked. Start a new record for another box.');
  const b = newBox(s, s.boxes.length + 1);
  s.boxes.push(b.id);
  await db.putMany([['shipments', s], ['boxes', b]]);
  return b;
}

export async function removeLastBox(s) {
  if (s.booked_at || s.boxes.length < 2) return;
  const id = s.boxes.pop();
  await db.put('shipments', s);
  await db.del('boxes', id);
}

export function readingsDone(b) { return FIELDS.every((f) => !checkReading(f, b.readings[f])); }

export async function saveReadings(b, readings) {
  b.readings = { ...b.readings, ...readings };
  if (readingsDone(b)) { b.book = bookNumbers(b.readings); b.readings_at = b.readings_at || isoLocal(); }
  else b.book = null;
  await db.put('boxes', b);
  return b;
}

export async function load(sid) {
  const s = await db.get('shipments', sid);
  if (!s) return null;
  const boxes = (await db.byIndex('boxes', 'shipment', sid)).sort((a, b) => a.n - b.n);
  const photos = await db.byIndex('photos', 'shipment', sid);
  const byId = Object.fromEntries(photos.map((p) => [p.id, p]));
  return { s, boxes, byId };
}

export function finalPhoto(ids, byId) { return ids.length ? byId[ids[ids.length - 1]] || null : null; }

export function boxDone(b) { return BOX_KINDS.every((k) => b.photos[k].length > 0); }
export function photosTaken(b) { return BOX_KINDS.filter((k) => b.photos[k].length > 0).length; }

export function boxStatus(s, b) {
  if (s.cancelled_at) return 'cancelled';
  if (!readingsDone(b)) return 'measuring';
  if (!s.booked_at) return 'to book';
  if (boxDone(b)) return 'complete';
  return `photos ${photosTaken(b)}/4`;
}

export function shipmentDone(s, boxes) {
  return boxes.length > 0 && boxes.every(boxDone) && (boxes.length < 2 || s.boxes_photo.length > 0);
}

export function shipmentStatus(s, boxes) {
  if (s.cancelled_at) return 'cancelled';
  if (!boxes.every(readingsDone)) return 'measuring';
  if (!s.booked_at) return 'to book';
  if (shipmentDone(s, boxes)) return 'complete';
  return 'photos';
}

// What comes next for this order: {screen, box, kind}
export function nextStep(s, boxes) {
  if (s.cancelled_at) return { screen: 'done' };
  const open = boxes.find((b) => !readingsDone(b));
  if (open) return { screen: 'measure', box: open };
  if (!s.booked_at) return { screen: 'book' };
  for (const b of boxes) for (const k of BOX_KINDS) if (!b.photos[k].length) return { screen: 'capture', box: b, kind: k };
  if (boxes.length > 1 && !s.boxes_photo.length) return { screen: 'capture', box: null, kind: 'boxes' };
  return { screen: 'done' };
}

export async function markBooked(s) {
  s.booked_at = s.booked_at || isoLocal();
  await db.put('shipments', s);
}

// AWB from the first label scan of the order; later boxes keep it (their own label code is stored per box).
export async function attachAwb(s, awb, source) {
  s.awb = awb; s.awb_source = source; s.awb_at = isoLocal(); s.month = istMonth();
  await db.put('shipments', s);
}

export async function clearAwb(s, byId) {
  const used = Object.values(byId).some((p) => p.shipment_id === s.id);
  if (used) throw new Error('Photos are already saved with this AWB. Cancel this record and start again instead.');
  s.awb = null; s.awb_source = null; s.awb_at = null; s.month = null;
  await db.put('shipments', s);
}

export async function setLabel(b, label) {
  b.label = { ...label, at: isoLocal() };
  await db.put('boxes', b);
}

export function nextNn(list, byId) {
  return list.reduce((m, id) => Math.max(m, (byId[id] && byId[id].nn) || 0), 0) + 1;
}

// Store an accepted photo (passed, or taken anyway) and queue its upload.
export async function addPhoto(s, b, kind, data, byId) {
  const list = kind === 'boxes' ? s.boxes_photo : b.photos[kind];
  const nn = nextNn(list, byId);
  const p = {
    id: data.id, shipment_id: s.id, box_id: b ? b.id : null, box_n: b ? b.n : null, kind, nn,
    name: photoName({ awb: s.awb, box: b ? b.n : null, boxes: s.boxes.length, kind, nn }),
    blob: data.blob, bytes: data.blob.size, width: data.width, height: data.height, quality: data.quality,
    captured_at: data.captured_at, checks: data.checks,
    upload: { state: 'queued', tries: 0, error: '', url: '', file_id: '', at: null },
  };
  list.push(p.id);
  byId[p.id] = p;
  if (b && boxDone(b) && !b.completed_at) b.completed_at = isoLocal();
  const writes = [['photos', p], ['shipments', s]];
  if (b) writes.push(['boxes', b]);
  await db.putMany(writes);
  await db.enqueue({ type: 'photo', photo_id: p.id });
  return p;
}

export async function addRemeasure(b, field, to) {
  b.remeasures.push({ at: isoLocal(), field, from: b.readings[field], to });
  await db.put('boxes', b);
}

export async function cancelShipment(s, reason) {
  s.cancelled_at = isoLocal(); s.cancel_reason = reason || '';
  await db.put('shipments', s);
}

export async function markComplete(s) {
  s.completed_at = s.completed_at || isoLocal();
  await db.put('shipments', s);
}

// Queue a Sheet row update for every box of the order (coalesced: one pending row item per box).
export async function queueRows(s, boxes) {
  const q = await db.all('queue');
  for (const b of boxes) {
    if (!q.some((i) => i.type === 'row' && i.box_id === b.id)) await db.enqueue({ type: 'row', box_id: b.id, shipment_id: s.id });
  }
}

// The Sheet row for one box, built at send time so it is always current.
export function rowSnapshot(s, b, byId) {
  const photos = {};
  for (const k of [...BOX_KINDS, 'boxes']) {
    const ids = k === 'boxes' ? (s.boxes.length > 1 ? s.boxes_photo : []) : b.photos[k];
    const list = ids.map((id) => byId[id]).filter(Boolean);
    const fin = list[list.length - 1];
    photos[k] = fin ? {
      final: fin.name, url: (fin.upload && fin.upload.url) || '', retakes: list.slice(0, -1).map((p) => p.name),
      checks: checksLine(fin.checks),
    } : null;
  }
  const lab = b.label;
  return {
    box_id: b.id, shipment_id: s.id, awb: s.awb || '', box: b.n, boxes: s.boxes.length, status: boxStatus(s, b),
    order_ref: s.order_ref || '', readings: b.readings, book: b.book || {}, photos,
    label_codes: lab ? lab.codes.join(' ') + (lab.child ? ' (this box label differs from the AWB)' : '') : '',
    awb_source: s.awb_source || '',
    remeasured: b.remeasures.map((r) => `${r.at.slice(11, 16)} ${r.field} ${r.from} -> ${r.to}`).join('; '),
    created_at: s.created_at, readings_at: b.readings_at, booked_at: s.booked_at, label_at: lab ? lab.at : null,
    completed_at: b.completed_at, cancelled: s.cancelled_at ? `cancelled ${s.cancelled_at.slice(0, 16)} ${s.cancel_reason}` : '',
    station: s.station,
  };
}
