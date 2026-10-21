// Records (v2). One record per parcel and stage, one or more boxes per record, the photos of each box. The Sheet
// gets one row per box: MEASURE boxes in "Pre-booking", PROOF boxes in "Boxes" (rowSnapshot).
//  MEASURE record M-...: boxes are added as the team goes ("Next box of THIS order"); photos <record>[-b<n>]-pre-...
//  PROOF record S-...: the boxes come from the booking (the Pre-booking tab); photos <AWB>[-b<n>]-ours-...
// v1.4 records (no stage) are PROOF records and keep working.
import * as db from './store.js';
import { newId, isoLocal, istMonth, istDay, checksLine, photoName, prePhotoName } from './logic.js';
import { MEASURE_KINDS, PROOF_KINDS, STAGE_KINDS } from './config.js';

export const stageOf = (s) => s.stage || 'proof';
export const kindsOf = (s) => STAGE_KINDS[stageOf(s)];

function newBox(s, n, extra = {}) {
  return {
    id: `${s.id}-b${n}`, shipment_id: s.id, n,
    photos: Object.fromEntries(kindsOf(s).map((k) => [k, []])),
    fails: {},             // failed tries per kind (quality, slip not read, barcode not read): "Use this photo" after 2
    flags: [],             // for the supervisor; every flag lands in the Sheet
    completed_at: null,
    // MEASURE
    order_hint: '', slip_read: '',          // slip_read: 'read' | 'not read' | 'not available'
    // PROOF
    label: null, pre_box_id: '', box_awb: '', slip_check: '', check_fails: 0, check_seen: '', check_why: '',
    slip_order: '', slip_order_via: '',    // what the slip next to the label says (its barcode, or the text reader)
    ...extra,
  };
}

// Every change to a box is a fresh read-modify-write, one at a time per box, so a screen holding an old copy never
// writes it back over a newer one.
const locks = new Map();
export function withBoxLock(id, fn) {
  const next = (locks.get(id) || Promise.resolve()).then(fn, fn);
  locks.set(id, next.catch(() => {}));
  return next;
}
export function upgradeBox(b) {
  if (!b) return b;
  b.photos = b.photos || {};
  for (const k of [...PROOF_KINDS, ...MEASURE_KINDS]) b.photos[k] = b.photos[k] || [];
  b.fails = b.fails || {}; b.flags = b.flags || []; b.redo = b.redo || [];
  return b;
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
export async function saveRecord(s) { await db.put('shipments', s); return s; }

function baseRecord(stage, settings, extra) {
  const now = isoLocal(), d = new Date();
  return {
    id: newId(stage === 'measure' ? 'M' : 'S'), v: 2, stage, created_at: now, day: istDay(d), month: istMonth(d),
    station: settings.station || 'Station 1', test: !!settings.test, stage_source: '',
    boxes: [], boxes_photo: [], completed_at: null, cancelled_at: null, cancel_reason: '',
    kept_aside: null, released: null, flags: [],
    order_hint: '', awb: null, awb_source: null, awb_at: null, order_no: '', order_source: '', label_order: '', lookup: null,
    booked_at: stage === 'proof' ? now : null,
    ...extra,
  };
}

// MEASURE: a record with box 1.
export async function createMeasure(settings, extra = {}) {
  const s = baseRecord('measure', settings, extra);
  const b = newBox(s, 1);
  s.boxes.push(b.id);
  await db.putMany([['shipments', s], ['boxes', b]]);
  return { s, b };
}

// MEASURE: "Next box of THIS order" (no box-count lock at this stage).
export async function addMeasureBox(s) {
  const b = newBox(s, s.boxes.length + 1);
  s.boxes.push(b.id);
  await db.putMany([['shipments', s], ['boxes', b]]);
  return b;
}

// PROOF: the boxes come from the booking lookup ({boxes: [{n, box_id, box_awb}]}); without one, a single box.
export async function createProof(settings, { awb, awbSource, lookup, extra = {} }) {
  const now = isoLocal();
  const s = baseRecord('proof', settings, { awb: awb || null, awb_source: awb ? awbSource : null, awb_at: awb ? now : null, lookup: lookup || null, ...extra });
  if (lookup && lookup.found) { s.order_no = lookup.order || ''; s.order_source = lookup.order ? 'booking' : ''; }
  const list = lookup && lookup.found && lookup.boxes && lookup.boxes.length ? lookup.boxes : [{ n: 1 }];
  const boxes = list.map((x, i) => newBox(s, i + 1, { pre_box_id: x.box_id || '', box_awb: x.box_awb || '' }));
  s.boxes = boxes.map((b) => b.id);
  if (!(lookup && lookup.found)) s.flags.push(awb ? 'AWB not in the Pre-booking tab: label-slip check skipped unless the label carries its order number' : 'no AWB yet');
  await db.putMany([['shipments', s], ...boxes.map((b) => ['boxes', b])]);
  return { s, boxes };
}

// Supervisor: add or remove a box by hand. A PROOF box can be added at any time: a box-1 photo already named
// without "-b1" stays valid (the backend accepts it). Only a box with no photos can be removed.
export async function addBoxByHand(s) {
  const b = newBox(s, s.boxes.length + 1);
  s.boxes.push(b.id);
  await db.putMany([['shipments', s], ['boxes', b]]);
  return b;
}
export async function removeLastBox(s) {
  if (s.boxes.length < 2) throw new Error('A record keeps at least one box');
  const id = s.boxes[s.boxes.length - 1];
  const b = upgradeBox(await db.get('boxes', id));
  if (b && Object.values(b.photos).some((l) => l.length)) throw new Error(`Box ${b.n} already has photos`);
  s.boxes.pop();
  await db.put('shipments', s);
  await db.del('boxes', id);
}

export async function load(sid) {
  const s = await db.get('shipments', sid);
  if (!s) return null;
  const boxes = (await db.byIndex('boxes', 'shipment', sid)).map(upgradeBox).sort((a, b) => a.n - b.n);
  const photos = await db.byIndex('photos', 'shipment', sid);
  const byId = Object.fromEntries(photos.map((p) => [p.id, p]));
  return { s, boxes, byId };
}

// (v1.1-1.3 reading photos lived in b.measure; an old phone's queue may still hold one)
export function listFor(s, b, kind) { return kind === 'boxes' ? s.boxes_photo : b.photos[kind] || (b.measure && b.measure[kind]) || []; }
export function finalPhoto(ids, byId) { return ids && ids.length ? byId[ids[ids.length - 1]] || null : null; }
export function nextNn(list, byId) { return list.reduce((m, id) => Math.max(m, (byId[id] && byId[id].nn) || 0), 0) + 1; }

// A step still to do: no photo yet, or marked to be taken again ("redo": the new photo becomes the final one, the
// old ones stay in Drive and the Sheet as retakes).
export function needs(b, k) { return !(b.photos[k] && b.photos[k].length) || (b.redo || []).includes(k); }
export function boxDone(s, b) { return kindsOf(s).every((k) => !needs(b, k)); }
export function photosTaken(s, b) { return kindsOf(s).filter((k) => !needs(b, k)).length; }
export function needsBoxesPhoto(s, boxes) { return stageOf(s) === 'proof' && boxes.length > 1; }
const boxesPhotoDue = (s, boxes) => needsBoxesPhoto(s, boxes) && (!s.boxes_photo.length || !!s.boxes_redo);
export function recordDone(s, boxes) {
  return boxes.length > 0 && boxes.every((b) => boxDone(s, b)) && !boxesPhotoDue(s, boxes);
}
export const isOpen = (s) => !s.cancelled_at && !s.completed_at && !s.kept_aside;

// What comes next: {screen: 'step', box, kind} | {screen: 'boxdone', box} (MEASURE) | {screen: 'done'} |
// {screen: 'aside'} | {screen: 'cancelled'}. Steps marked to redo come first, box by box, in the step order.
export function nextStep(s, boxes) {
  if (s.cancelled_at) return { screen: 'cancelled' };
  if (s.kept_aside) return { screen: 'aside' };
  const kinds = kindsOf(s);
  for (const b of boxes) {
    const k = kinds.find((x) => (b.redo || []).includes(x));
    if (k) return { screen: 'step', box: b, kind: k };
  }
  if (stageOf(s) === 'measure') {
    const b = boxes[boxes.length - 1];
    const k = MEASURE_KINDS.find((x) => needs(b, x));
    return k ? { screen: 'step', box: b, kind: k } : s.completed_at ? { screen: 'done' } : { screen: 'boxdone', box: b };
  }
  // PROOF: the box whose label is being taken first, then its photos; the label of the next box after that
  for (const b of boxes) {
    if (!b.photos.label.length) continue;
    const k = PROOF_KINDS.find((x) => needs(b, x));
    if (k) return { screen: 'step', box: b, kind: k };
  }
  const nolabel = boxes.find((b) => !b.photos.label.length);
  if (nolabel) return { screen: 'step', box: nolabel, kind: 'label' };
  if (boxesPhotoDue(s, boxes)) return { screen: 'step', box: null, kind: 'boxes' };
  return { screen: 'done' };
}

// "Redo": take some steps again - one photo, a whole box, or every box (and the all-boxes photo). The record opens
// again; a redone label runs the label-slip check again. items: [{box, kinds}]. Every redo is noted on the box.
export async function markRedo(s, items, { boxesPhoto = false } = {}) {
  const at = isoLocal().slice(11, 16), all = kindsOf(s);
  for (const it of items) {
    if (!it.kinds.length) continue;
    await updateBox(it.box.id, (x) => {
      x.redo = all.filter((k) => (x.redo || []).includes(k) || it.kinds.includes(k));
      x.completed_at = null;
      for (const k of it.kinds) x.fails[k] = 0;
      if (it.kinds.includes('label')) { x.slip_check = ''; x.check_fails = 0; x.check_seen = ''; x.check_why = ''; }
      if (it.kinds.includes('slip')) { x.slip_read = ''; }
      const what = it.kinds.length === all.length ? 'the whole box' : it.kinds.join(', ');
      x.flags.push(`redo ${what} (${at})`);
    });
  }
  if (boxesPhoto) { s.boxes_redo = true; flagRecord(s, `redo the all-boxes photo (${at})`); }
  s.completed_at = null;
  await db.put('shipments', s);
}

// The Sheet status of a box.
// A PROOF box whose set is complete stays "complete" when another box of the parcel is kept aside.
export function boxStatus(s, b) {
  if (s.cancelled_at) return `cancelled ${s.cancel_reason || ''}`.trim();
  const n = photosTaken(s, b), all = kindsOf(s).length;
  if (s.kept_aside && !(stageOf(s) === 'proof' && n >= all && b.slip_check !== 'no match')) return `kept aside: ${s.kept_aside.reason}`;
  if (stageOf(s) === 'measure') return n >= all ? 'photos in' : `photos ${n}/${all}`;
  return n >= all ? 'complete' : `photos ${n}/${all}`;
}

export async function setAwb(s, awb, source) {
  s.awb = awb; s.awb_source = source; s.awb_at = isoLocal();
  await db.put('shipments', s);
  // photos taken before the AWB was known (a label whose barcode would not read) get their names now
  const boxes = (await db.byIndex('boxes', 'shipment', s.id)).map(upgradeBox);
  for (const p of await db.byIndex('photos', 'shipment', s.id)) {
    if (p.name) continue;
    const b = boxes.find((x) => x.id === p.box_id);
    p.name = photoName({ awb, box: b ? b.n : null, boxes: s.boxes.length, kind: p.kind, nn: p.nn });
    await db.put('photos', p);
    await db.enqueue({ type: 'photo', photo_id: p.id });
  }
}

export function flagRecord(s, text) { if (!s.flags.includes(text)) s.flags.push(text); }

// Store an accepted photo (passed, or used after the failed tries) and queue its upload. A PROOF photo taken before
// the AWB is known waits, unnamed, until it is (setAwb).
export async function addPhoto(s, b, kind, data, byId) {
  const list = listFor(s, b, kind);
  const nn = nextNn(list, byId);
  const measure = stageOf(s) === 'measure';
  const name = measure ? prePhotoName({ record: s.id, box: b.n, kind, nn })
    : s.awb ? photoName({ awb: s.awb, box: b ? b.n : null, boxes: s.boxes.length, kind, nn }) : null;
  const p = {
    id: data.id, shipment_id: s.id, box_id: b ? b.id : null, box_n: b ? b.n : null, kind, nn, name, stage: stageOf(s),
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
      x.redo = (x.redo || []).filter((k) => k !== kind);   // a redone step is done again
      if (boxDone(s, x) && !x.completed_at) x.completed_at = isoLocal();
    });
    Object.assign(b, fresh);
  } else {
    list.push(p.id);
    s.boxes_redo = false;
    await db.putMany([['photos', p], ['shipments', s]]);
  }
  if (p.name) await db.enqueue({ type: 'photo', photo_id: p.id });
  return p;
}

export async function keepAside(s, reason) {
  s.kept_aside = { at: isoLocal(), reason }; s.released = null;
  flagRecord(s, `kept aside: ${reason}`);
  await db.put('shipments', s);
}
export async function release(s, reason) {
  s.released = { at: isoLocal(), reason, from: s.kept_aside ? s.kept_aside.reason : '' };
  flagRecord(s, `released by the supervisor: ${reason}`);
  s.kept_aside = null;
  await db.put('shipments', s);
}
export async function cancelRecord(s, reason) {
  s.cancelled_at = isoLocal(); s.cancel_reason = reason || '';
  await db.put('shipments', s);
}
export async function markComplete(s) {
  s.completed_at = s.completed_at || isoLocal();
  await db.put('shipments', s);
}

// Queue a Sheet row update for every box of the record (coalesced: one pending row item per box).
export async function queueRows(s, boxes) {
  const q = await db.all('queue');
  for (const b of boxes) {
    if (!q.some((i) => i.type === 'row' && i.box_id === b.id)) await db.enqueue({ type: 'row', box_id: b.id, shipment_id: s.id });
  }
}

function photoSet(s, b, byId, kinds) {
  const photos = {}, finals = [];
  for (const k of kinds) {
    const ids = k === 'boxes' ? (s.boxes.length > 1 ? s.boxes_photo : []) : listFor(s, b, k) || [];
    const list = ids.map((id) => byId[id]).filter((p) => p && p.name);
    const fin = list[list.length - 1];
    photos[k] = fin ? { final: fin.name, url: (fin.upload && fin.upload.url) || '', retakes: list.slice(0, -1).map((p) => p.name), checks: checksLine(fin.checks) } : null;
    if (fin) finals.push(`${k}: ${checksLine(fin.checks)}`);
  }
  return { photos, finals };
}

// The Sheet row for one box, built at send time so it is always current.
export function rowSnapshot(s, b, byId) {
  upgradeBox(b);
  const flags = [...(s.flags || []), ...(b.flags || [])];
  const common = {
    box_id: b.id, shipment_id: s.id, record: s.id, box: b.n, boxes: s.boxes.length, status: boxStatus(s, b), station: s.station,
    created_at: s.created_at, completed_at: b.completed_at, flags,
    cancelled: s.cancelled_at ? `cancelled ${s.cancelled_at.slice(0, 16)} ${s.cancel_reason}` : '',
  };
  if (stageOf(s) === 'measure') {
    const { photos, finals } = photoSet(s, b, byId, MEASURE_KINDS);
    const read = b.slip_read === 'read' ? `order no. read on the phone: ${b.order_hint}`
      : b.slip_read === 'not read' ? 'order no. not read on the phone' : b.slip_read === 'not available' ? 'order no. not checked (reader not available)' : '';
    return { ...common, stage: 'measure', order_hint: b.order_hint || '', photos, checks: [read, ...finals].filter(Boolean).join(' | ') };
  }
  const { photos } = photoSet(s, b, byId, [...PROOF_KINDS, 'boxes']);
  const lab = b.label;
  return {
    // "Order no.": the booking's, else the label's own order barcode, else what the slip says (21 Oct: PROOF rows
    // with no booking kept no order number at all); the label photo's checks say where each one came from
    ...common, stage: 'proof', awb: s.awb || '', order_ref: s.label_order || '', order_no: s.order_no || s.label_order || b.slip_order || '',
    slip_check: b.slip_check || '', pre_box_id: b.pre_box_id || '', box_code: lab && lab.child ? lab.code : '',
    readings: {}, book: {}, photos,
    label_codes: lab ? (lab.codes || []).join(' ') + (lab.child ? ' (this box label differs from the AWB)' : '') : '',
    awb_source: s.awb_source || '', remeasured: '', readings_at: null, booked_at: s.booked_at, label_at: lab ? lab.at : null,
    readings_source: '', reread: '',
  };
}
