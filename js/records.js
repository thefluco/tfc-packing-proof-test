// Box records: one shipment (order) holds one or more boxes; each box holds its reading photos and the numbers
// read from them (or typed), the numbers to book, the label scan and its proof photos. The Sheet gets one row per
// box (rowSnapshot).
import * as db from './store.js';
import { newId, bookNumbers, checkReading, isoLocal, istMonth, checksLine, photoName, sourcesLine } from './logic.js';
import { BOX_KINDS, MEASURE_KINDS } from './config.js';

const FIELDS = ['weight', 'length', 'height', 'breadth'];

function newBox(s, n) {
  return {
    id: `${s.id}-b${n}`, shipment_id: s.id, n,
    readings: { weight: '', length: '', height: '', breadth: '' }, readings_at: null, book: null,
    reads: {},        // per field: {source:'read'|'typed', value, confidence, photo_id, at, read_value}
    read_jobs: {},    // per reading photo kind: {status:'reading'|'done'|'partial'|'failed'|'later', error, notes, flags, missing, at}
                      // 'later': no reader (no API key) - the numbers are read from the photo afterwards
    measure: { 'measure-scale': [], 'measure-length-height': [], 'measure-breadth': [] },
    label: null, photos: { 'label': [], 'breadth': [], 'length-height': [], 'scale': [] },
    remeasures: [], completed_at: null,
  };
}

// Every change to a box is a fresh read-modify-write, one at a time per box: readings arrive in the background
// while a photo screen holds its own copy of the box, and a stale copy must never be written back over them.
const locks = new Map();
export function withBoxLock(id, fn) {
  const next = (locks.get(id) || Promise.resolve()).then(fn, fn);
  locks.set(id, next.catch(() => {}));
  return next;
}
export function updateBox(id, mutate) {
  return withBoxLock(id, async () => {
    const b = upgradeBox(await db.get('boxes', id));
    if (!b) throw new Error('box not found: ' + id);
    await mutate(b);
    await db.put('boxes', b);
    return b;
  });
}

// Boxes created before v1.1 have no reading-photo lists.
export function upgradeBox(b) {
  if (!b) return b;
  b.reads = b.reads || {};
  b.read_jobs = b.read_jobs || {};
  b.measure = b.measure || { 'measure-scale': [], 'measure-length-height': [], 'measure-breadth': [] };
  return b;
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
export function measureDone(b) { return MEASURE_KINDS.every((k) => (b.measure[k] || []).length > 0); }
export function readsPending(b) { return Object.values(b.read_jobs || {}).some((j) => j.status === 'reading'); }
// A reader tried and could not read a photo (not the same as "no reader": that is 'later').
export function readFailed(b) { return Object.values(b.read_jobs || {}).some((j) => j.status === 'failed' || j.status === 'partial'); }
// The reading photos are taken but (some of) the numbers are not in the app: they are read from the photos later.
export function numbersLater(b) { return measureDone(b) && !readingsDone(b) && !readsPending(b); }

function refreshBook(b) {
  if (readingsDone(b)) { b.book = bookNumbers(b.readings); b.readings_at = b.readings_at || isoLocal(); }
  else b.book = null;
}

// Typed readings (the fallback): kept as typed, with what the reader said beside it.
export async function saveReadings(b, readings) {
  const fresh = await updateBox(b.id, (x) => {
    for (const [f, v] of Object.entries(readings)) {
      const prev = x.reads[f];
      if (v !== x.readings[f] || !prev) {
        x.reads[f] = { source: 'typed', value: v, at: isoLocal(), read_value: prev && prev.source === 'read' ? prev.value : (prev && prev.read_value) || '' };
      }
    }
    x.readings = { ...x.readings, ...readings };
    refreshBook(x);
  });
  return Object.assign(b, fresh);
}

// A reader result for one reading photo. A value someone typed is never overwritten; the read value is kept beside it.
export function applyRead(b, kind, photoId, r) {
  const later = !r.ok && r.code === 'no_reader';
  const job = { status: r.ok ? 'done' : later ? 'later' : 'failed', error: r.ok || later ? '' : r.error || r.code || 'failed', code: r.ok ? '' : r.code || '',
    notes: r.notes || '', flags: r.flags || {}, at: isoLocal(), photo_id: photoId, missing: [] };
  if (r.ok) {
    const want = kind === 'measure-scale' ? ['weight'] : kind === 'measure-length-height' ? ['length', 'height'] : ['breadth'];
    for (const f of want) {
      const v = r.values[f];
      if (!v || checkReading(f, v)) { job.missing.push(f); continue; }
      const prev = b.reads[f];
      if (prev && prev.source === 'typed') { prev.read_value = v; continue; }
      b.readings[f] = v;
      b.reads[f] = { source: 'read', value: v, confidence: r.confidence[f] || r.confidence.breadth || '', photo_id: photoId, at: isoLocal() };
    }
    if (job.missing.length) job.status = 'partial';
  }
  b.read_jobs[kind] = job;
  refreshBook(b);
  return b;
}

export async function load(sid) {
  const s = await db.get('shipments', sid);
  if (!s) return null;
  const boxes = (await db.byIndex('boxes', 'shipment', sid)).map(upgradeBox).sort((a, b) => a.n - b.n);
  const photos = await db.byIndex('photos', 'shipment', sid);
  const byId = Object.fromEntries(photos.map((p) => [p.id, p]));
  return { s, boxes, byId };
}

export function listFor(s, b, kind) {
  if (kind === 'boxes') return s.boxes_photo;
  if (kind.startsWith('measure-')) return b.measure[kind];
  return b.photos[kind];
}

export function finalPhoto(ids, byId) { return ids.length ? byId[ids[ids.length - 1]] || null : null; }

export function boxDone(b) { return BOX_KINDS.every((k) => b.photos[k].length > 0); }
export function photosTaken(b) { return BOX_KINDS.filter((k) => b.photos[k].length > 0).length; }

// A box can be booked once its reading photos are taken, with or without the numbers (no reader: read later).
export function boxStatus(s, b) {
  if (s.cancelled_at) return 'cancelled';
  if (!s.booked_at) {
    if (!readingsDone(b) && !measureDone(b)) return 'measuring';
    if (readsPending(b)) return 'reading';
    return !readingsDone(b) && readFailed(b) ? 'check readings' : 'to book';
  }
  if (boxDone(b)) return 'complete';
  return `photos ${photosTaken(b)}/4`;
}

export function shipmentDone(s, boxes) {
  return boxes.length > 0 && boxes.every(boxDone) && (boxes.length < 2 || s.boxes_photo.length > 0);
}

export function shipmentStatus(s, boxes) {
  if (s.cancelled_at) return 'cancelled';
  if (!s.booked_at) {
    if (boxes.some((b) => !readingsDone(b) && !measureDone(b))) return 'measuring';
    if (boxes.some(readsPending)) return 'reading';
    return boxes.some((b) => !readingsDone(b) && readFailed(b)) ? 'check readings' : 'to book';
  }
  if (shipmentDone(s, boxes)) return 'complete';
  return 'photos';
}

// What comes next for this order: {screen, box, kind}
export function nextStep(s, boxes) {
  if (s.cancelled_at) return { screen: 'done' };
  for (const b of boxes) {
    if (readingsDone(b)) continue;
    const k = MEASURE_KINDS.find((x) => !(b.measure[x] || []).length);
    if (k) return { screen: 'capture', box: b, kind: k };
  }
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
// The reading photos taken before the label get their names now, and join the upload queue.
export async function attachAwb(s, awb, source) {
  s.awb = awb; s.awb_source = source; s.awb_at = isoLocal(); s.month = istMonth();
  await db.put('shipments', s);
  const boxes = (await db.byIndex('boxes', 'shipment', s.id)).map(upgradeBox);
  const photos = await db.byIndex('photos', 'shipment', s.id);
  for (const p of photos) {
    if (p.name || !p.kind.startsWith('measure-')) continue;
    const b = boxes.find((x) => x.id === p.box_id);
    p.name = photoName({ awb, box: b.n, boxes: s.boxes.length, kind: p.kind, nn: p.nn });
    await db.put('photos', p);
    await db.enqueue({ type: 'photo', photo_id: p.id });
  }
}

export async function clearAwb(s, byId) {
  const used = Object.values(byId).some((p) => p.shipment_id === s.id && !p.kind.startsWith('measure-'));
  if (used) throw new Error('Photos are already saved with this AWB. Cancel this record and start again instead.');
  const q = await db.all('queue');
  if (Object.values(byId).some((p) => p.kind.startsWith('measure-') && p.upload.state === 'done')) {
    throw new Error('Reading photos already went to Drive under this AWB. Cancel this record and start again instead.');
  }
  for (const p of Object.values(byId)) {
    if (!p.kind.startsWith('measure-') || !p.name) continue;
    for (const i of q) if (i.photo_id === p.id) await db.del('queue', i.seq);
    p.name = null;
    await db.put('photos', p);
  }
  s.awb = null; s.awb_source = null; s.awb_at = null; s.month = null;
  await db.put('shipments', s);
}

export async function setLabel(b, label) {
  const fresh = await updateBox(b.id, (x) => { x.label = label ? { ...label, at: isoLocal() } : null; });
  return Object.assign(b, fresh);
}

export function nextNn(list, byId) {
  return list.reduce((m, id) => Math.max(m, (byId[id] && byId[id].nn) || 0), 0) + 1;
}

// Store an accepted photo (passed, or taken anyway) and queue its upload. A reading photo taken before the
// label has no AWB yet: it waits, unnamed, until the label scan (attachAwb).
export async function addPhoto(s, b, kind, data, byId) {
  const list = listFor(s, b, kind);
  const nn = nextNn(list, byId);
  const p = {
    id: data.id, shipment_id: s.id, box_id: b ? b.id : null, box_n: b ? b.n : null, kind, nn,
    name: s.awb ? photoName({ awb: s.awb, box: b ? b.n : null, boxes: s.boxes.length, kind, nn }) : null,
    blob: data.blob, bytes: data.blob.size, width: data.width, height: data.height, quality: data.quality,
    captured_at: data.captured_at, checks: data.checks,
    upload: { state: 'queued', tries: 0, error: '', url: '', file_id: '', at: null },
  };
  byId[p.id] = p;
  if (b) {
    await db.put('photos', p);
    const fresh = await updateBox(b.id, (x) => {
      const l = listFor(s, x, kind);
      if (!l.includes(p.id)) l.push(p.id);
      if (boxDone(x) && !x.completed_at) x.completed_at = isoLocal();
    });
    Object.assign(b, fresh);
  } else {
    list.push(p.id);
    await db.putMany([['photos', p], ['shipments', s]]);
  }
  if (p.name) await db.enqueue({ type: 'photo', photo_id: p.id });
  return p;
}

export async function addRemeasure(b, field, to) {
  const fresh = await updateBox(b.id, (x) => { x.remeasures.push({ at: isoLocal(), field, from: x.readings[field], to }); });
  return Object.assign(b, fresh);
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
  upgradeBox(b);
  const photos = {};
  for (const k of [...MEASURE_KINDS, ...BOX_KINDS, 'boxes']) {
    const ids = k === 'boxes' ? (s.boxes.length > 1 ? s.boxes_photo : []) : listFor(s, b, k);
    const list = ids.map((id) => byId[id]).filter((p) => p && p.name);
    const fin = list[list.length - 1];
    photos[k] = fin ? {
      final: fin.name, url: (fin.upload && fin.upload.url) || '', retakes: list.slice(0, -1).map((p) => p.name),
      checks: checksLine(fin.checks),
    } : null;
  }
  const rereads = BOX_KINDS.map((k) => finalPhoto(b.photos[k], byId)).filter((p) => p && p.reread && p.reread.status === 'done')
    .map((p) => `${p.kind}: ${p.reread.mismatch || 'matches the booking'}`);
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
    readings_source: Object.keys(b.reads).length ? sourcesLine(b.reads) : '',
    reread: rereads.join('; '),
  };
}
