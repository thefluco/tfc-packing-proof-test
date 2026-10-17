// TFC Packing Proof - the station app. Runs the SOP routine, image-first (v1.1): new box -> three READING photos
// (weight, length-height, breadth) from which the reader (Claude, via the backend) takes the numbers -> check and
// book (one tap; typing only to fix) -> scan the new label (attaches the AWB) -> label photo -> breadth ->
// length-height -> weight PROOF photos, each re-read and compared with the booking.
// The reader is optional (v1.2): without an API key nothing is read in the app; the team books with what the scale
// and tapes show, every photo is saved and uploaded as usual, and the numbers are read from the photos later.
// Photos are taken automatically only when the frame is sharp, steady and well lit, re-checked on the full-size
// still, saved on the phone first and uploaded from a queue.
import { APP_VERSION, DEFAULT_SCRIPT_URL, DEFAULT_LEVELS, KIND_INFO, BOX_KINDS, MEASURE_KINDS, FIELD_KIND, READING_ROUTINE, READ_LONG_SIDE, READ_MAX_BYTES, MAX_JPEG_BYTES, MAX_LONG_SIDE, MIN_QUALITY, DEMO_AWB, TEST_SITE, TEST_BACKEND } from './config.js';
import * as db from './store.js';
import * as R from './records.js';
import { checkReading, readingWarnings, readCodes, normCode, AWB_OK, isoLocal, istDay, istParts, uuid, checksLine, bookNumbers, bookFor } from './logic.js';
import { readCrops, requestRead } from './reader.js';
import { measure, shrink, changeFraction, judge } from './quality.js';
import { Camera, listCameras } from './camera.js';
import { DemoCamera } from './demo.js';
import * as barcode from './barcode.js';
import { videoRect, drawOverlay, glareZone, CALIB_STEPS, calibFromTaps, drawTaps, DEFAULT_BAY, DEFAULT_PLATFORM, DEFAULT_DISPLAY } from './overlay.js';
import { Uploader, transport } from './uploader.js';

const app = { settings: null, uploader: null, camera: null, camKey: '', camInfo: null, cleanup: null, q: { pending: 0 } };
window.ppApp = app;   // for diagnostics and tests

// ---------------------------------------------------------------- small helpers
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const view = (html) => { $('#app').innerHTML = html; };
const go = (hash) => { if (location.hash === hash) render(); else location.hash = hash; };
const fmtAwb = (a) => String(a || '').replace(/(.{4})(?=.)/g, '$1 ');
const time = (iso) => (iso ? iso.slice(11, 16) : '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let toastT = 0;
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg; t.className = 'show ' + kind;
  clearTimeout(toastT); toastT = setTimeout(() => { t.className = ''; }, 3800);
}

function modal(html, setup) {
  const m = $('#modal');
  m.innerHTML = `<div class="sheet">${html}</div>`;
  m.classList.remove('hidden');
  return new Promise((res) => {
    const close = (v) => { m.classList.add('hidden'); m.innerHTML = ''; m.onclick = null; res(v); };
    m.onclick = (e) => { if (e.target === m) close(null); };
    setup(m, close);
  });
}

function beep() {
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)(), o = ac.createOscillator(), g = ac.createGain();
    o.frequency.value = 1320; g.gain.value = 0.08; o.connect(g); g.connect(ac.destination);
    o.start(); o.stop(ac.currentTime + 0.12); setTimeout(() => ac.close(), 300);
  } catch { /* no sound */ }
  if (navigator.vibrate) navigator.vibrate(80);
}

// ---------------------------------------------------------------- settings
const DEFAULTS = {
  scriptUrl: DEFAULT_SCRIPT_URL, key: '', station: 'Station 1', test: true, demo: false, cameraId: '',
  cameraMode: 'app',   // v1.3: 'app' = the phone's own camera app; 'live' = the in-app camera that shoots by itself
  phoneMake: '', phoneModel: '', levels: DEFAULT_LEVELS, calib: {}, setupDone: false,
};
const HARNESS_URL = 'http://localhost/demo-backend';   // the in-browser test backend's stand-in address
const mergeLevels = (l = {}) => ({ ...DEFAULT_LEVELS, ...l, sharp: { ...DEFAULT_LEVELS.sharp, ...(l.sharp || {}) } });

async function loadSettings() {
  const s = await db.getKV('settings', {});
  const out = { ...DEFAULTS, ...s, levels: mergeLevels(s.levels) };
  // A phone that ran the in-browser TEST site keeps its stand-in address: a real build replaces it.
  if (!out.scriptUrl || (out.scriptUrl === HARNESS_URL && DEFAULT_SCRIPT_URL && !TEST_SITE)) out.scriptUrl = DEFAULT_SCRIPT_URL;
  return out;
}
async function saveSettings(patch) {
  app.settings = { ...app.settings, ...patch };
  await db.setKV('settings', app.settings);
}

async function detectPhone() {
  try {
    if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
      const v = await navigator.userAgentData.getHighEntropyValues(['model', 'platformVersion']);
      return v.model || '';
    }
  } catch { /* not available */ }
  return '';
}

// ---------------------------------------------------------------- still worker
let worker = null, wseq = 0;
const wjobs = new Map();
// { checked, done, cancel }: `checked` resolves as soon as the still's checks are known, `done` with the JPEG.
function stillJob(job) {
  if (!worker) {
    worker = new Worker(new URL('./still-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const j = wjobs.get(e.data.id);
      if (!j) return;
      j.checked(e.data);
      if (e.data.phase !== 'checked') { j.done(e.data); wjobs.delete(e.data.id); }
    };
    worker.onerror = (e) => {
      for (const [id, j] of wjobs) { const err = { id, ok: false, error: e.message || 'photo worker failed' }; j.checked(err); j.done(err); }
      wjobs.clear(); worker = null;
    };
  }
  const id = ++wseq, j = {};
  const checked = new Promise((r) => { j.checked = r; }), done = new Promise((r) => { j.done = r; });
  wjobs.set(id, j);
  worker.postMessage({ ...job, id });
  return { checked, done, cancel: () => { if (worker) worker.postMessage({ cancel: id }); } };
}

// ---------------------------------------------------------------- camera
async function ensureCamera(video) {
  const st = app.settings, want = st.demo ? 'demo' : st.cameraId || 'auto';
  if (app.camera && app.camera.live && app.camKey === want) { await app.camera.attach(video); return app.camera; }
  stopCamera();
  app.camera = st.demo ? new DemoCamera() : new Camera();
  app.camKey = want;
  app.camInfo = await app.camera.start(video, st.cameraId || undefined);
  return app.camera;
}
function stopCamera() { if (app.camera) { app.camera.stop(); app.camera = null; } }

function demoScene(kind, s, b, boxes) {
  if (!(app.camera instanceof DemoCamera)) return;
  const code = !b || b.n === 1 ? DEMO_AWB : DEMO_AWB.slice(0, -1) + b.n;
  app.camera.setScene({ kind, code, code2: DEMO_AWB.slice(0, -1) + '2', truth: b ? b.demo_truth : null, label: !kind.startsWith('measure-') });
}

// Demo camera only: the "true" size and weight of a pretend box, which the drawn station shows.
function demoTruth() {
  const r = (lo, hi, step) => Math.round((lo + Math.random() * (hi - lo)) / step) * step;
  const f = (v, d) => v.toFixed(d).replace(/\.0+$/, '');
  return { weight: r(3, 24, 0.05).toFixed(2), length: f(r(60, 150, 0.5), 1), breadth: f(r(15, 34, 0.5), 1), height: f(r(14, 32, 0.5), 1) };
}

// ---------------------------------------------------------------- reading the numbers (background)
// Box records are only changed through R.updateBox (one writer at a time, always on a fresh copy).
const liveReads = new Set();
const rereadListeners = new Map();

// The reader is optional. The backend says whether it has an API key (ping -> reader); without one the app does
// not read: the reading photos are saved as usual and the numbers are read from them later, outside the app.
// Unknown (no answer yet) counts as on, so a failed read still shows "Read again".
const readerOff = () => app.settings.reader === false;
async function refreshReader() {
  const st = app.settings;
  if (!st.scriptUrl || !st.key) return;
  try {
    const r = await transport.post(st.scriptUrl, { v: 1, action: 'ping', key: st.key, station: st.station, app: APP_VERSION, phone: st.phoneModel, test: st.test }, 15000);
    if (r && r.ok && app.settings.reader !== !!r.reader) await saveSettings({ reader: !!r.reader });
  } catch { /* offline: keep the last answer */ }
}

function readsChanged(sid) {
  const [r, a] = parts();
  if (!$('#modal').classList.contains('hidden')) return;   // never redraw under an open question
  if ((r === 'book' || r === 's' || r === 'done') && a === sid) render();
  else if (r === 'mb' && String(a).startsWith(sid)) render();
}

async function startMeasureRead(sid, boxId, kind, photoId, images) {
  if (readerOff() || !images) {   // no reader: nothing to wait for, the photo is read later
    await R.updateBox(boxId, (b) => R.applyRead(b, kind, photoId, { ok: false, code: 'no_reader' }));
    readsChanged(sid);
    return;
  }
  const key = `${boxId}|${kind}`;
  liveReads.add(key);
  try {
    await R.updateBox(boxId, (b) => { b.read_jobs[kind] = { status: 'reading', at: isoLocal(), photo_id: photoId }; });
    readsChanged(sid);
    const truth = (await db.get('boxes', boxId) || {}).demo_truth;
    const r = await requestRead(app.settings, kind, images, truth);
    if (r.code === 'no_reader') await saveSettings({ reader: false });
    else if (r.ok && app.settings.reader !== true) await saveSettings({ reader: true });
    await R.updateBox(boxId, (b) => {
      R.applyRead(b, kind, photoId, r);
      if (r.ok && r.split) b.read_jobs[kind].warn = r.split;
      if (r.ok && kind === 'measure-scale' && r.flags && (r.flags.on_platform_only === false || r.flags.display_steady === false)) {
        b.read_jobs[kind].warn = [r.flags.on_platform_only === false ? 'the box may not be resting only on the platform' : '',
          r.flags.display_steady === false ? 'the display may not have settled' : ''].filter(Boolean).join('; ');
      }
    });
    const d = await R.load(sid);
    if (d) await rowsChanged(d.s, d.boxes.filter((x) => x.id === boxId));
  } finally {
    liveReads.delete(key);
    readsChanged(sid);
  }
}

// "Read again" from the stored reading photo.
async function rereadFromPhoto(sid, boxId, kind) {
  const d = await R.load(sid);
  const b = d && d.boxes.find((x) => x.id === boxId);
  const p = b && R.finalPhoto(b.measure[kind], d.byId);
  if (readerOff()) { toast('No reader is set up: the numbers are read from the photos later'); return; }
  if (!p || !p.blob) { toast('That reading photo is no longer on the phone - retake it', 'bad'); return; }
  const aspect = (p.checks && p.checks.preview_aspect) || p.width / p.height;
  const res = await stillJob({ readOnly: { long: READ_LONG_SIDE, quality: 0.85, crops: readCrops(kind, app.settings.calib, aspect) }, blob: p.blob, previewAspect: aspect }).done;
  if (!res.ok) { toast('Could not prepare the photo: ' + res.error, 'bad'); return; }
  startMeasureRead(sid, boxId, kind, p.id, res.read);
}

// The proof photos are read again and compared with what was booked (a warning, never a block).
async function startRecheck(sid, boxId, kind, photoId, images) {
  const b0 = await db.get('boxes', boxId);
  const r = await requestRead(app.settings, kind, images, b0 && b0.demo_truth);
  const p = await db.get('photos', photoId), b = R.upgradeBox(await db.get('boxes', boxId));
  if (!p || !b) return;
  const fields = kind === 'scale' ? ['weight'] : kind === 'length-height' ? ['length', 'height'] : kind === 'length' || kind === 'height' ? [kind] : ['breadth'];
  if (r.code === 'no_reader') { await saveSettings({ reader: false }); p.reread = { status: 'skipped', at: isoLocal() }; }
  else if (!r.ok) p.reread = { status: 'failed', error: r.error || r.code, at: isoLocal() };
  else {
    const diffs = [];
    for (const f of fields) {
      const v = r.values[f];
      if (!v) { diffs.push(`${f} not readable in this photo`); continue; }
      const nb = bookFor(f, v);
      if (b.book && String(nb) !== String(b.book[f])) diffs.push(`${f} reads ${v} (books as ${nb}) but ${b.book[f]} was booked`);
    }
    p.reread = { status: 'done', values: r.values, mismatch: diffs.join('; '), at: isoLocal() };
  }
  await db.put('photos', p);
  const d = await R.load(sid);
  if (d) await rowsChanged(d.s, d.boxes.filter((x) => x.id === boxId));
  const fn = rereadListeners.get(photoId);
  if (fn) fn(p.reread);
  readsChanged(sid);
}

function fieldLine(b, f) {
  const unit = f === 'weight' ? 'kg' : 'cm', v = b.readings[f], src = b.reads[f];
  const job = b.read_jobs[FIELD_KIND[f]];
  if (v && !checkReading(f, v)) {
    const how = src && src.source === 'typed' ? `typed${src.read_value ? `, read ${esc(src.read_value)}` : ''}` : `read${src && src.confidence ? ', ' + esc(src.confidence) : ''}`;
    return { ok: true, html: `<b>${esc(v)} ${unit}</b> <span class="small muted">(${how})</span>`, conf: src && src.confidence, typed: src && src.source === 'typed' };
  }
  if (job && job.status === 'reading') return { html: '<span class="muted">reading…</span>', pending: true };
  if (job && job.status === 'later') return { html: '<span class="muted">read later from the photo</span>', later: true };
  if (job && (job.status === 'failed' || job.status === 'partial')) return { html: `<span style="color:var(--bad)">not read</span> <span class="small muted">${esc(job.error || 'unclear in the photo')}</span>`, failed: true };
  return { html: '<span class="muted">no photo yet</span>' };
}

// ---------------------------------------------------------------- uploads
function qText() {
  const q = app.q || {};
  if (q.paused) return 'uploads paused';
  if (!navigator.onLine) return `offline${q.pending ? ' · ' + q.pending + ' waiting' : ''}`;
  if (q.pending) return `uploading · ${q.pending}`;
  return 'all sent';
}
function queueBox() {
  const q = app.q || {};
  if (q.paused) return `<div class="card bad"><b>Uploads paused:</b> ${esc(q.paused)}. <a href="#/settings">Settings</a></div>`;
  if (q.pending && q.error) return `<div class="card warn"><b>${q.pending} waiting to upload.</b> ${esc(q.error)} <button id="retry" class="wide" style="margin-top:8px">Retry now</button></div>`;
  if (q.pending) return `<div class="card">${q.pending} uploading${q.sending ? ': ' + esc(q.sending) : ''}...</div>`;
  return '';
}
function onQ(state) {
  app.q = state;
  const el = $('#qpill');
  if (el) { el.textContent = qText(); el.className = 'pill ' + (state.paused ? 'bad' : state.pending ? '' : 'ok'); }
  const box = $('#qbox');
  if (box) { box.innerHTML = queueBox(); const r = $('#retry'); if (r) r.onclick = () => app.uploader.retryNow(); }
}
async function rowsChanged(s, boxes) { await R.queueRows(s, boxes); app.uploader.kick(); }

function bar(title, back = '#/') {
  return `<div class="bar">${back ? `<a href="${back}" aria-label="Back">&#8249;</a>` : ''}<h1>${esc(title)}</h1>` +
    `${app.settings.test ? '<span class="pill test">TEST</span>' : ''}<span class="pill" id="qpill">${qText()}</span></div>`;
}

// ---------------------------------------------------------------- router
function parts() { return location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent); }

// Renders run one after another and only the latest request runs, so a slow screen can never paint over a
// newer one (e.g. a tap on "New box" while the home list is still loading).
let renderWant = 0, renderChain = Promise.resolve();
function render() {
  const my = ++renderWant;
  renderChain = renderChain.then(() => (my === renderWant ? doRender() : undefined)).catch((e) => console.error(e));
  return renderChain;
}

async function doRender() {
  const [r, a, b, c] = parts();
  if (app.cleanup) { try { app.cleanup(); } catch { /* ignore */ } app.cleanup = null; }
  if (r !== 'cap' && r !== 'calib') stopCamera();
  window.scrollTo(0, 0);
  try {
    switch (r) {
      case 'settings': return await screenSettings();
      case 's': return await screenShipment(a);
      case 'm': return await screenMeasure(a, b);
      case 'mb': return await screenBoxReadings(a);
      case 'book': return await screenBook(a);
      case 'cap': return await screenCapture(a, b, c);
      case 'done': return await screenDone(a);
      case 'shift': return await screenShift();
      case 'scale-test': return await screenScaleTest();
      case 'calib': return await screenCalib(a);
      case 'queue': return await screenQueue();
      case 'demo': return await screenDemo();
      default: return await screenHome();
    }
  } catch (e) {
    console.error(e);
    view(`${bar('Problem')}<main><div class="card bad"><h3>Something went wrong</h3><p>${esc(e.message)}</p></div><button class="wide" onclick="location.hash='#/'">Home</button></main>`);
  }
}

// ---------------------------------------------------------------- home
async function screenHome() {
  const st = app.settings;
  if (!st.setupDone) return go('#/settings');
  const ships = (await db.all('shipments')).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const boxes = await db.all('boxes');
  const boxesOf = (s) => boxes.filter((b) => b.shipment_id === s.id).sort((a, b) => a.n - b.n);
  const today = istDay();
  const open = ships.filter((s) => !s.cancelled_at && !s.completed_at);
  const done = ships.filter((s) => (s.completed_at || s.cancelled_at) && istDay(new Date(s.created_at)) === today);
  const logs = await db.all('logs');
  const shift = logs.find((l) => l.type === 'shift-start' && l.day === today);
  const scaleTest = logs.filter((l) => l.type === 'scale-test' && l.day === today).pop();
  const monday = istParts().dow === 1;
  const item = (s) => {
    const bx = boxesOf(s), stt = R.shipmentStatus(s, bx);
    return `<a class="item" href="#/s/${encodeURIComponent(s.id)}"><b>${s.awb ? '<span class="awb">' + fmtAwb(s.awb) + '</span>' : 'No AWB yet'}</b>` +
      `<div class="sub">${bx.length} box${bx.length > 1 ? 'es' : ''} · ${esc(stt)} · started ${time(s.created_at)}${s.test ? ' · TEST' : ''}</div></a>`;
  };
  view(`${bar('Packing Proof', '')}<main>
    ${st.test ? '<div class="card warn"><b>TEST mode.</b> Files go to Packing Proof/TEST and the "TEST boxes" tab. Turn it off in Settings to go live.</div>' : ''}
    ${st.demo ? '<div class="card warn"><b>Demo camera.</b> A drawn picture instead of the real camera (Settings to switch).</div>' : ''}
    ${TEST_SITE ? '<div class="card warn"><b>TEST SITE.</b> Photos and Sheet rows stay on this device, in a stand-in for Drive and the Sheet. Nothing is sent to Google.</div>' : ''}
    ${app.harness ? '<a class="item card go" href="#/demo"><b>Demo: see what reached Drive and the Sheet</b><div class="sub">Test copies on this device only - nothing goes to your real Google Drive.</div></a>' : ''}
    <button class="big primary" id="new">New box</button>
    <a class="item card ${shift ? 'go' : 'warn'}" href="#/shift"><b>${shift ? 'Shift started ' + time(shift.at) + ' ✓' : 'Start of shift: ZERO the scale and check the bay'}</b>
      <div class="sub">${shift ? 'Scale zeroed, bay checked.' : 'Tap to tick both and log it.'}</div></a>
    ${monday || scaleTest ? `<a class="item card ${scaleTest ? (scaleTest.result === 'pass' ? 'go' : 'bad') : 'warn'}" href="#/scale-test"><b>${scaleTest ? `10 kg test weight read ${esc(scaleTest.reading)} kg - ${scaleTest.result === 'pass' ? 'OK ✓' : 'STOP using the scale'}` : 'Monday: weigh the 10 kg test weight'}</b><div class="sub">Log the reading.</div></a>` : ''}
    <div id="qbox">${queueBox()}</div>
    <h2>Open (${open.length})</h2>
    <div class="list">${open.map(item).join('') || '<p class="muted">Nothing open.</p>'}</div>
    <h2>Finished today (${done.length})</h2>
    <div class="list">${done.map(item).join('') || '<p class="muted">None yet.</p>'}</div>
    <p class="small muted" style="margin-top:24px">v${APP_VERSION} · <a href="#/settings">Settings</a> · <a href="#/queue">Uploads</a>${monday ? '' : ' · <a href="#/scale-test">Scale test</a>'}</p>
  </main>`);
  $('#new').onclick = startNewBox;
  const r = $('#retry'); if (r) r.onclick = () => app.uploader.retryNow();
}

// ---------------------------------------------------------------- new box / another box: straight to the first photo
// (v1.4: the label scan; in the before-booking reading routine: the first reading photo)
async function startNewBox() {
  const { s, b } = await R.createShipment(app.settings);
  if (app.settings.demo) { b.demo_truth = demoTruth(); await db.put('boxes', b); }
  go(`#/cap/${encodeURIComponent(s.id)}/${encodeURIComponent(b.id)}/${READING_ROUTINE ? 'measure-scale' : BOX_KINDS[0]}`);
}
async function addAnotherBox(s) {
  const b = await R.addBox(s);
  if (app.settings.demo) { b.demo_truth = demoTruth(); await db.put('boxes', b); }
  if (READING_ROUTINE) go(`#/cap/${encodeURIComponent(s.id)}/${encodeURIComponent(b.id)}/measure-scale`);
  else { toast(`Box ${b.n} added - ${s.boxes.length} boxes in this order`, 'go'); go(`#/s/${encodeURIComponent(s.id)}`); render(); }
}
function measureNextHash(s, b) {
  const k = MEASURE_KINDS.find((x) => !(b.measure[x] || []).length);
  return k ? `#/cap/${encodeURIComponent(s.id)}/${encodeURIComponent(b.id)}/${k}` : `#/mb/${encodeURIComponent(b.id)}`;
}

// ---------------------------------------------------------------- one order (shipment)
function bookGrid(b) {
  const k = b.book || {};
  return `<div class="book"><div><small>Length</small><b>${k.length ?? '-'}</b><span>cm</span></div>` +
    `<div><small>Breadth</small><b>${k.breadth ?? '-'}</b><span>cm</span></div>` +
    `<div><small>Height</small><b>${k.height ?? '-'}</b><span>cm</span></div>` +
    `<div><small>Weight</small><b>${k.weight ?? '-'}</b><span>kg</span></div></div>`;
}
const measuredLine = (b) => `Readings: L ${esc(b.readings.length || '-')} · B ${esc(b.readings.breadth || '-')} · H ${esc(b.readings.height || '-')} cm · ${esc(b.readings.weight || '-')} kg`;
const allLater = (b) => R.measureDone(b) && MEASURE_KINDS.every((k) => (b.read_jobs[k] || {}).status === 'later');

async function screenShipment(sid) {
  const d = await R.load(sid);
  if (!d) return go('#/');
  const { s, boxes } = d, stt = R.shipmentStatus(s, boxes), nx = R.nextStep(s, boxes), multi = boxes.length > 1;
  const kindMark = (b, k) => (b.photos[k].length ? '✓' : '·');
  const boxCard = (b) => `<div class="card"><h3>Box ${b.n}${multi ? ' of ' + boxes.length : ''} · ${esc(R.boxStatus(s, b))}</h3>
      ${R.readingsDone(b) ? bookGrid(b) + `<div class="small muted">${measuredLine(b)}</div>` : `<p class="muted">${allLater(b) || !READING_ROUTINE ? 'Numbers: read later from the photos' : measuredLine(b)}</p>`}
      ${s.booked_at ? `<div class="small" style="margin-top:6px">Photos: ${BOX_KINDS.map((k) => `${KIND_INFO[k].title.toLowerCase()} ${kindMark(b, k)}`).join(' · ')}${b.label && b.label.child ? ` · box label <span class="awb">${esc(b.label.code)}</span>` : ''}</div>` : ''}
      ${READING_ROUTINE && !s.booked_at && !s.cancelled_at ? `<div class="row" style="margin-top:8px"><button data-meas="${esc(b.id)}">${R.measureDone(b) ? 'Reading photos of this box' : 'Take the reading photos'}</button>${readerOff() ? '' : `<button data-edit="${esc(b.id)}">Type readings</button>`}</div>` : ''}
    </div>`;
  let main = '';
  if (s.cancelled_at) main = `<div class="card bad"><b>Cancelled</b> ${esc(s.cancel_reason)}</div>`;
  else if (nx.screen === 'book') main = `<button class="big primary" id="next">${readerOff() ? 'Book' : 'Check readings and book'}</button>`;
  else if (nx.screen === 'capture') main = `<button class="big primary" id="next">Continue: ${nx.kind === 'boxes' ? 'photo of all boxes' : `box ${nx.box.n} ${KIND_INFO[nx.kind].title.toLowerCase()} photo`}</button>`;
  else main = `<div class="card go"><b>All photos taken ✓</b></div>`;
  view(`${bar(s.awb ? 'AWB ' + fmtAwb(s.awb) : 'New order record')}<main>
    <div class="card"><dl class="kv"><dt>Status</dt><dd>${esc(stt)}</dd><dt>Started</dt><dd>${esc(s.created_at.slice(0, 16).replace('T', ' '))}</dd>
      <dt>AWB</dt><dd>${s.awb ? `<span class="awb">${esc(s.awb)}</span> (${esc(s.awb_source)})` : 'attached when the new label is scanned'}</dd></dl>
      <label class="field">Order no. <span class="hint">Optional. Filled in when the label's order barcode is read.</span>
      <input type="text" id="oref" value="${esc(s.order_ref)}" placeholder="TFC-001513299" autocomplete="off" ${s.cancelled_at ? 'disabled' : ''}></label></div>
    ${main}
    <h2>Boxes</h2>${boxes.map(boxCard).join('')}
    ${R.canAddBox(s) ? `<div class="row"><button id="add">+ Add another box to this order</button>${multi ? `<button id="remove">Remove box ${boxes.length}</button>` : ''}</div>` : ''}
    ${!s.completed_at && !s.cancelled_at ? '<button class="danger wide" id="cancel" style="margin-top:22px">Cancel this record</button>' : ''}
  </main>`);
  const nextBtn = $('#next');
  if (nextBtn) nextBtn.onclick = () => {
    if (nx.screen === 'book') go(`#/book/${encodeURIComponent(sid)}`);
    else go(`#/cap/${encodeURIComponent(sid)}/${nx.box ? encodeURIComponent(nx.box.id) : 'all'}/${nx.kind}`);
  };
  for (const btn of document.querySelectorAll('[data-edit]')) btn.onclick = () => go(`#/m/${encodeURIComponent(btn.dataset.edit)}`);
  for (const btn of document.querySelectorAll('[data-meas]')) btn.onclick = () => go(measureNextHash(s, boxes.find((x) => x.id === btn.dataset.meas)));
  const oref = $('#oref');
  if (oref) oref.onchange = async () => { s.order_ref = oref.value.trim().toUpperCase(); await db.put('shipments', s); await rowsChanged(s, boxes); toast('Order no. saved'); };
  const add = $('#add');
  if (add) add.onclick = () => addAnotherBox(s);
  const rm = $('#remove');
  if (rm) rm.onclick = async () => { await R.removeLastBox(s); render(); };
  const cancel = $('#cancel');
  if (cancel) cancel.onclick = async () => {
    const why = await modal(`<h3>Cancel this record?</h3><p>Use this when the box is re-packed or re-booked: peel off the old label and start a new record. Photos already uploaded stay in Drive.</p>
      <label class="field">Reason<input type="text" id="why" placeholder="e.g. re-packed"></label>
      <div class="row"><button id="no">Keep it</button><button class="danger" id="yes">Cancel record</button></div>`,
    (m, close) => { $('#no', m).onclick = () => close(null); $('#yes', m).onclick = () => close($('#why', m).value.trim() || 'cancelled'); });
    if (why === null) return;
    await R.cancelShipment(s, why); await rowsChanged(s, boxes); go('#/');
  };
}

// ---------------------------------------------------------------- measuring (SOP steps 2-5)
const MSTEPS = ['weigh', 'bay', 'lh', 'breadth', 'sum'];
function firstMissing(b) {
  if (checkReading('weight', b.readings.weight)) return 'weigh';
  if (checkReading('length', b.readings.length) || checkReading('height', b.readings.height)) return 'bay';
  if (checkReading('breadth', b.readings.breadth)) return 'breadth';
  return 'sum';
}

// Typing the readings: the fallback when a reading photo cannot be read (or for a quick fix).
async function screenMeasure(boxId, step) {
  const b = R.upgradeBox(await db.get('boxes', boxId));
  if (!b) return go('#/');
  const s = await db.get('shipments', b.shipment_id);
  if (s.booked_at || s.cancelled_at) return go(`#/s/${encodeURIComponent(s.id)}`);
  step = MSTEPS.includes(step) ? step : firstMissing(b);
  const multi = s.boxes.length > 1, head = `Box ${b.n}${multi ? ' of ' + s.boxes.length : ''}`;
  const stepNo = { weigh: 1, bay: 2, lh: 3, breadth: 4, sum: 5 }[step];
  const input = (f, label, unit, hint) => `<label class="field">${label} <span class="hint">${hint}</span>
      <input class="reading" type="text" inputmode="decimal" autocomplete="off" enterkeyhint="next" id="f-${f}" value="${esc(b.readings[f])}" placeholder="${unit}">
      <div class="err" id="e-${f}"></div></label>`;
  let body = '', fields = [];
  if (step === 'weigh') {
    fields = ['weight'];
    body = `<div class="instr"><b>Weigh.</b> Put the box on the scale, resting only on the platform with both ends clear of the floor. When the number stops changing, type it.</div>
      ${input('weight', 'Weight', 'kg', 'As the scale shows it, e.g. 16.85')}`;
  } else if (step === 'bay') {
    body = `<div class="instr"><b>Into the bay.</b> Lay the box in the back-left corner: one end against the left wall, its side against the back wall, resting as it naturally lies. Never squeeze it into shape.</div>`;
  } else if (step === 'lh') {
    fields = ['length', 'height'];
    body = `<div class="instr"><b>Length and height.</b> Slide the end panel against the far end (a loose bag tail counts). Lower the gauge arm onto the highest point. Boards touch, never press.</div>
      ${input('length', 'Length (scale L at the end panel)', 'cm', 'e.g. 103.5')}${input('height', 'Height (the gauge)', 'cm', 'e.g. 27')}`;
  } else if (step === 'breadth') {
    fields = ['breadth'];
    body = `<div class="instr"><b>Breadth.</b> Lift the panel and gauge away. Slide the low fence against the widest bulge until B1 and B2 read the same.</div>
      ${input('breadth', 'Breadth (B1 = B2 at the fence)', 'cm', 'e.g. 26')}`;
  } else {
    const warns = readingWarnings(b.readings);
    body = `<div class="instr"><b>Readings saved.</b></div>${bookGrid(b)}<p class="small muted">${measuredLine(b)}</p>
      ${warns.map((w) => `<div class="card warn">${esc(w)}</div>`).join('')}
      <button class="big primary" id="tobook">All boxes measured: check and book</button>
      <button class="wide" id="another" style="margin-top:10px">+ Another box in this order</button>
      <button class="wide" id="redo" style="margin-top:10px">Edit these readings</button>`;
  }
  view(`${bar(head + ' · type readings', `#/s/${encodeURIComponent(s.id)}`)}<main><div class="step">Typing instead of reading · step ${stepNo} of 5 · ${head}</div>${body}
    ${step !== 'sum' ? `<div class="row" style="margin-top:18px"><button id="back">Back</button><button class="primary" id="ok">${step === 'bay' ? 'It is in the bay' : 'Next'}</button></div>` : ''}
  </main>`);
  const idx = MSTEPS.indexOf(step);
  const goStep = (st) => go(`#/m/${encodeURIComponent(b.id)}/${st}`);
  if (fields.length) {
    const first = $('#f-' + fields[0]);
    setTimeout(() => first && first.focus(), 60);
    fields.forEach((f, i) => {
      $('#f-' + f).addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        if (i + 1 < fields.length) $('#f-' + fields[i + 1]).focus(); else $('#ok').click();
      });
    });
  }
  const ok = $('#ok');
  if (ok) ok.onclick = async () => {
    const vals = {};
    let bad = false;
    for (const f of fields) {
      const el = $('#f-' + f), v = el.value.trim().replace(',', '.'), err = checkReading(f, v);
      $('#e-' + f).textContent = err; el.classList.toggle('bad', !!err);
      if (err) bad = true; else vals[f] = v;
    }
    if (bad) return;
    if (fields.length) await R.saveReadings(b, vals);
    const nextStep = step === 'breadth' || idx + 1 >= MSTEPS.length ? 'sum' : MSTEPS[idx + 1];
    if (nextStep === 'sum') {
      const all = (await db.byIndex('boxes', 'shipment', s.id)).sort((x, y) => x.n - y.n);
      await rowsChanged(s, [all.find((x) => x.id === b.id)]);
    }
    goStep(nextStep);
  };
  const back = $('#back');
  if (back) back.onclick = () => (idx > 0 ? goStep(MSTEPS[idx - 1]) : go(`#/s/${encodeURIComponent(s.id)}`));
  const tb = $('#tobook');
  if (tb) tb.onclick = async () => {
    const all = (await db.byIndex('boxes', 'shipment', s.id)).sort((x, y) => x.n - y.n);
    const open = all.map(R.upgradeBox).find((x) => !R.readingsDone(x) && !R.measureDone(x));
    if (open) { toast(`Box ${open.n} still needs its readings`, 'bad'); return go(measureNextHash(s, open)); }
    go(`#/book/${encodeURIComponent(s.id)}`);
  };
  const an = $('#another');
  if (an) an.onclick = () => addAnotherBox(s);
  const redo = $('#redo');
  if (redo) redo.onclick = () => goStep('weigh');
}

// ---------------------------------------------------------------- the readings of a box (read from its photos)
const FIELD_NAMES = { weight: 'Weight', length: 'Length', breadth: 'Breadth', height: 'Height' };
const KIND_SHORT = { 'measure-scale': 'weight', 'measure-length': 'length', 'measure-breadth': 'breadth', 'measure-height': 'height' };

function readingsCard(s, b, byId, urls) {
  const rows = ['weight', 'length', 'breadth', 'height'].map((f) => {
    const L = fieldLine(b, f), check = L.ok && !L.typed && L.conf && L.conf !== 'high';
    return `<tr><th>${FIELD_NAMES[f]}</th><td>${L.html}${check ? ' <span class="chip wait">check the photo</span>' : ''}</td>` +
      `<td>${s.booked_at || readerOff() ? '' : `<button class="mini" data-fix="${esc(b.id)}|${f}">${L.ok ? 'Fix' : 'Type'}</button>`}</td></tr>`;
  }).join('');
  const photos = MEASURE_KINDS.map((k) => {
    const p = R.finalPhoto(b.measure[k] || [], byId), j = b.read_jobs[k] || {};
    let img = '<div class="noimg">no photo</div>';
    if (p && p.blob) { const u = URL.createObjectURL(p.blob); urls.push(u); img = `<img src="${u}" alt="" data-full="${u}">`; }
    const again = !s.booked_at && p && (j.status === 'failed' || j.status === 'partial') ? `<button class="mini" data-again="${esc(b.id)}|${k}">Read again</button>` : '';
    const retake = !s.booked_at ? `<button class="mini" data-retake="${esc(b.id)}|${k}">${p ? 'Retake' : 'Take'}</button>` : '';
    return `<figure>${img}<figcaption>${KIND_SHORT[k]}${j.status === 'reading' ? ' · reading…' : ''}<br>${again}${retake}</figcaption></figure>`;
  }).join('');
  const warns = MEASURE_KINDS.map((k) => (b.read_jobs[k] || {}).warn).filter(Boolean);
  return `<table class="readings">${rows}</table>${warns.map((w) => `<div class="card warn small">${esc(w)}</div>`).join('')}<div class="thumbs">${photos}</div>`;
}

function wireReadings(sid) {
  for (const btn of document.querySelectorAll('[data-fix]')) btn.onclick = async () => {
    const [boxId, f] = btn.dataset.fix.split('|'), b = R.upgradeBox(await db.get('boxes', boxId)), unit = f === 'weight' ? 'kg' : 'cm';
    const v = await modal(`<h3>${FIELD_NAMES[f]} (${unit})</h3><p class="small muted">Type what the ${f === 'weight' ? 'scale display' : 'scale'} shows in the photo. The reading is kept beside it.</p>
      <input class="reading" type="text" inputmode="decimal" id="fixv" value="${esc(b.readings[f])}"><div class="err" id="fixe"></div>
      <div class="row"><button id="no">Back</button><button class="primary" id="yes">Save</button></div>`,
    (m, close) => {
      setTimeout(() => $('#fixv', m).select(), 50);
      $('#no', m).onclick = () => close(null);
      $('#yes', m).onclick = () => { const x = $('#fixv', m).value.trim().replace(',', '.'), e = checkReading(f, x); if (e) { $('#fixe', m).textContent = e; return; } close(x); };
    });
    if (v === null) return;
    await R.saveReadings(R.upgradeBox(await db.get('boxes', boxId)), { [f]: v });
    const d = await R.load(sid); await rowsChanged(d.s, d.boxes.filter((x) => x.id === boxId));
    render();
  };
  for (const btn of document.querySelectorAll('[data-again]')) btn.onclick = () => { const [boxId, k] = btn.dataset.again.split('|'); rereadFromPhoto(sid, boxId, k); toast('Reading again…'); };
  for (const btn of document.querySelectorAll('[data-retake]')) btn.onclick = () => { const [boxId, k] = btn.dataset.retake.split('|'); go(`#/cap/${encodeURIComponent(sid)}/${encodeURIComponent(boxId)}/${k}`); };
  for (const img of document.querySelectorAll('.thumbs img')) img.onclick = () => modal(`<img src="${img.dataset.full}" alt="" style="width:100%;border-radius:10px"><div class="row"><button id="x">Close</button></div>`, (m, close) => { $('#x', m).onclick = () => close(); });
}

async function screenBoxReadings(boxId) {
  const b0 = await db.get('boxes', boxId);
  if (!b0) return go('#/');
  const d = await R.load(b0.shipment_id), { s, boxes, byId } = d, b = boxes.find((x) => x.id === boxId);
  if (s.booked_at || s.cancelled_at) return go(`#/s/${encodeURIComponent(s.id)}`);
  const urls = [];
  app.cleanup = () => urls.forEach((u) => URL.revokeObjectURL(u));
  view(`${bar(`Box ${b.n}${boxes.length > 1 ? ' of ' + boxes.length : ''} · readings`, `#/s/${encodeURIComponent(s.id)}`)}<main>
    <div class="instr"><b>Reading photos taken.</b> ${readerOff() ? 'The numbers are read from them later. Retake a photo if it does not show the scales clearly.' : R.readsPending(b) ? 'The numbers are being read from them - a few seconds.' : 'Check the numbers below.'}</div>
    <div class="card">${readingsCard(s, b, byId, urls)}</div>
    <button class="big primary" id="tobook">${readerOff() ? 'All boxes photographed: book' : 'All boxes measured: check and book'}</button>
    <button class="wide" id="another" style="margin-top:10px">+ Another box in this order</button>
  </main>`);
  wireReadings(s.id);
  $('#tobook').onclick = () => go(`#/book/${encodeURIComponent(s.id)}`);
  $('#another').onclick = () => addAnotherBox(s);
}

// ---------------------------------------------------------------- check readings and book (SOP step 6)
async function screenBook(sid) {
  const d = await R.load(sid);
  if (!d) return go('#/');
  const { s, boxes, byId } = d, multi = boxes.length > 1;
  if (s.booked_at) return go(`#/s/${encodeURIComponent(sid)}`);
  const noPhotos = boxes.find((b) => !R.readingsDone(b) && !R.measureDone(b));
  if (noPhotos) return go(measureNextHash(s, noPhotos));
  // Booking never waits for numbers: without a reader (or when one could not be read) they are read from the
  // reading photos later. With a reader, the numbers it read are shown to book with.
  const allDone = boxes.every(R.readingsDone), pending = boxes.some(R.readsPending), later = readerOff();
  const urls = [];
  app.cleanup = () => urls.forEach((u) => URL.revokeObjectURL(u));
  const instr = later && !allDone
    ? `<b>Book the courier with what the scale and the tapes show.</b> Each side up to the next whole cm, the weight up to the next 0.1 kg.${multi ? ' Book once, with each box\'s own numbers.' : ''} The numbers are read from the reading photos later.`
    : `<b>Check the readings, then book with exactly these numbers.</b> Each side is rounded up to the next whole cm and the weight to the next 0.1 kg.${multi ? ' Book once, with each box\'s own numbers.' : ''}`;
  view(`${bar(later ? 'Book' : 'Check and book', `#/s/${encodeURIComponent(sid)}`)}<main>
    <div class="instr">${instr}</div>
    ${boxes.map((b) => `<div class="card">${multi ? `<h3>Box ${b.n} of ${boxes.length}</h3>` : ''}${readingsCard(s, b, byId, urls)}${R.readingsDone(b) ? bookGrid(b) : ''}</div>`).join('')}
    <div class="card warn">Print the label and stick it <b>centred on the top face</b>, with the box still in the bay and the fence in place. Do not edit the booking after the label prints.</div>
    <button class="big go" id="booked" ${pending ? 'disabled' : ''}>${pending ? 'Reading the photos…' : allDone ? 'Booked with these numbers - the label is on' : 'Booked - the label is on'}</button>
  </main>`);
  wireReadings(sid);
  $('#booked').onclick = async () => {
    const checks = [];
    for (const b of boxes) {
      for (const f of ['weight', 'length', 'breadth', 'height']) {
        const r = b.reads[f];
        if (r && r.source === 'read' && r.confidence && r.confidence !== 'high') checks.push(`${multi ? `Box ${b.n} ` : ''}${f}: ${b.readings[f]} (read with ${r.confidence} confidence)`);
      }
      for (const k of MEASURE_KINDS) if ((b.read_jobs[k] || {}).warn) checks.push(`${multi ? `Box ${b.n} ` : ''}${b.read_jobs[k].warn}`);
      // A reader that could not read a photo: say so once (the number is read from the photo later).
      if (!later && !R.readingsDone(b) && R.readFailed(b)) {
        const miss = ['weight', 'length', 'breadth', 'height'].filter((f) => checkReading(f, b.readings[f]));
        checks.push(`${multi ? `Box ${b.n} ` : ''}not read: ${miss.join(', ')} - book with what the scale and tapes show; it is read from the photo later`);
      }
    }
    if (checks.length) {
      const okd = await modal(`<h3>Please look at the photos for these</h3><ul>${checks.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
        <p class="small muted">If a number is wrong, go back and Fix it, or Retake the photo, before booking.</p><div class="row"><button id="no">Back</button><button class="go" id="yes">Booked - the label is on</button></div>`,
      (m, close) => { $('#no', m).onclick = () => close(false); $('#yes', m).onclick = () => close(true); });
      if (!okd) return;
    }
    await R.markBooked(s);
    await rowsChanged(s, boxes);
    go(`#/cap/${encodeURIComponent(sid)}/${encodeURIComponent(boxes[0].id)}/label`);
  };
}

// ---------------------------------------------------------------- photos (SOP steps 7-9)
async function screenCapture(sid, bid, kind) {
  const d = await R.load(sid);
  if (!d) return go('#/');
  let { s, boxes, byId } = d;
  if (!KIND_INFO[kind]) return go(`#/s/${encodeURIComponent(sid)}`);
  if (s.cancelled_at) return go(`#/s/${encodeURIComponent(sid)}`);
  const multi = boxes.length > 1;
  let b = bid === 'all' ? null : boxes.find((x) => x.id === bid) || null;
  // Reading photos come before booking (no label yet); proof photos after it.
  const isMeasure = kind.startsWith('measure-'), look = isMeasure ? kind.slice(8) : kind;
  const recheck = ['scale', 'length', 'breadth', 'height', 'length-height'].includes(kind);
  if (isMeasure) {
    if (s.booked_at || !b) return go(`#/s/${encodeURIComponent(sid)}`);
  } else {
    if (!s.booked_at) return go(`#/book/${encodeURIComponent(sid)}`);
    if (kind !== 'boxes' && !b) return go(`#/s/${encodeURIComponent(sid)}`);
    if (kind !== 'label' && !s.awb) return go(`#/cap/${encodeURIComponent(sid)}/${encodeURIComponent(boxes[0].id)}/label`);
    if (kind !== 'label' && kind !== 'boxes' && !b.photos.label.length) return go(`#/cap/${encodeURIComponent(sid)}/${encodeURIComponent(b.id)}/label`);
  }

  const st = app.settings, lv = st.levels, info = KIND_INFO[kind];
  // Multi-box: the team taps the box number printed on the label (Box x/y) before each label photo.
  let picked = !(multi && kind === 'label');
  // v1.3: by default the photo is taken with the phone's own camera app (full resolution, its own focus and
  // framing) and checked when it comes back; 'live' is the in-app camera that takes the photo by itself.
  const fileMode = st.cameraMode !== 'live';
  view(`<div class="cam${fileMode ? ' file' : ''}"><div class="stage"><video playsinline muted></video><canvas class="ov"></canvas>
      ${fileMode ? `<div class="fileph"><div class="big">Take this photo with the phone's camera</div>
        <div class="small">Get close: what is read should fill a good part of the picture. Tap to focus, hold still.</div>
        <button id="snap">Open the camera</button><button id="gallery" class="ghost">Choose a photo from the gallery</button></div>` : ''}
      <input type="file" accept="image/*" capture="environment" id="fcam" hidden><input type="file" accept="image/*" id="fgal" hidden>
      <div class="top"><div class="t1"><b id="ttl"></b>${st.test ? '<span class="pill test">TEST</span>' : ''}<button class="x" id="close">Close</button></div>
        <div class="t2" id="awbline"></div><div class="boxchips" id="boxchips"></div></div>
      <svg class="ring" viewBox="0 0 54 54"><circle cx="27" cy="27" r="22" stroke="rgba(255,255,255,.25)" stroke-width="6" fill="none"/>
        <circle id="ringv" cx="27" cy="27" r="22" stroke="#3ddc84" stroke-width="6" fill="none" stroke-dasharray="0 999" transform="rotate(-90 27 27)"/></svg>
      <div class="busy hidden" id="busy"></div><div class="review hidden" id="review"></div></div>
    <div class="panel"><div class="chips" id="chips"></div><div class="say" id="say"></div><div class="shows">${esc(info.shows)}</div>
      <div class="rec" id="rec"></div><div class="actions" id="acts"></div><div class="actions" id="democtl"></div></div></div>`);
  const video = $('.cam video'), ov = $('.cam canvas.ov'), octx = ov.getContext('2d');
  const ring = $('#ringv'), busyEl = $('#busy'), review = $('#review');
  const actx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const run = { alive: true };
  let wake = null;
  app.cleanup = () => { run.alive = false; if (wake) wake.release().catch(() => {}); };
  $('#close').onclick = () => go(`#/s/${encodeURIComponent(sid)}`);

  // Screen state (the analysis loop below reads and writes these).
  let typed = !!(b && b.label && b.label.typed), showTake = false, showType = false;
  let prev = null, steadySince = 0, peaks = [], busy = false, hist = [], lastGood = 0, lastBars = [], scanBusy = false, tick = 0;
  let readingNow = false;   // this photo goes to the reader (set per capture)
  let chooser = false, lastSharp = 0, lastSteady = 0, started = performance.now(), scanFrom = 0, warnedAt = 0;

  const expected = () => (b && b.label ? b.label.code : s.awb);
  function header() {
    if (isMeasure) {
      $('#ttl').textContent = `${multi ? `Box ${b.n}/${boxes.length} · ` : ''}Reading ${info.step}/${MEASURE_KINDS.length}: ${info.title}`;
      $('#awbline').textContent = 'Before booking: the numbers are read from this photo';
    } else {
      // After booking: the photos Shipmozo gets in a dispute, each showing the label (v1.4: the only round).
      const n = BOX_KINDS.indexOf(kind) + 1, word = READING_ROUTINE ? 'Proof photo' : 'Photo';
      const step = kind === 'boxes' || !n ? `${word}: ` : `${word} ${n}/${BOX_KINDS.length}: `;
      $('#ttl').textContent = `${multi && b && picked ? `Box ${b.n}/${boxes.length} · ` : ''}${step}${info.title}${kind === 'label' || kind === 'boxes' ? '' : ' (with the label)'}`;
      $('#awbline').innerHTML = s.awb
        ? `AWB <span class="awb">${esc(fmtAwb(s.awb))}</span>${b && b.label && b.label.child ? ` · box label <span class="awb">${esc(b.label.code)}</span>` : ''}${b && b.label && b.label.typed ? ' · typed' : ''}`
        : 'Scan the new label: the AWB attaches to this record';
    }
    $('#say').textContent = multi && kind === 'label' && !picked ? 'Which box is this label on? Tap the number printed as "Box x/y".' : info.place;
    const chips = $('#boxchips');
    chips.innerHTML = multi && kind === 'label'
      ? boxes.map((x) => `<button data-n="${x.n}" class="${picked && b && b.id === x.id ? 'on' : ''} ${x.photos.label.length ? 'done' : ''}" ${x.photos.label.length ? 'disabled' : ''}>Box ${x.n}${x.photos.label.length ? ' ✓' : ''}</button>`).join('')
      : '';
    for (const btn of chips.querySelectorAll('button')) btn.onclick = async () => {
      b = boxes.find((x) => x.n === Number(btn.dataset.n)); picked = true; typed = !!(b.label && b.label.typed);
      hist = []; lastGood = 0; scanFrom = performance.now() + 700;   // only reads made after the tap count
      demoScene(kind, s, b, boxes); header();
    };
    const bk = b && b.book, r = b && b.readings;
    const rec = $('#rec');
    if (isMeasure) {
      const done = ['weight', 'length', 'breadth', 'height'].map((f) => `${FIELD_NAMES[f]}: ${fieldLine(b, f).html}`);
      rec.innerHTML = `<span class="small">${done.join(' · ')}</span>`;
    } else if (kind === 'label') rec.innerHTML = bk && picked ? `Booked: ${bk.length} × ${bk.breadth} × ${bk.height} cm, ${bk.weight} kg - the label should show these.` : '';
    else if (kind !== 'boxes' && !bk) rec.innerHTML = `<span class="small">${READING_ROUTINE ? 'The numbers for this box are read from its reading photos later.' : 'Keep the label and the reading both in the picture: the number is read from this photo later.'}</span>`;
    else if (kind === 'breadth') rec.innerHTML = `Recorded breadth <b>${esc(r.breadth)} cm</b> (booked ${bk.breadth}). If the fence now reads differently, measure again.`;
    else if (kind === 'length-height') rec.innerHTML = `Recorded length <b>${esc(r.length)} cm</b> (booked ${bk.length}) · height <b>${esc(r.height)} cm</b> (booked ${bk.height}).`;
    else if (kind === 'scale') rec.innerHTML = `Recorded weight <b>${esc(r.weight)} kg</b> (booked ${bk.weight}).`;
    else rec.innerHTML = `${boxes.length} boxes in this order.`;
    actions();
  }

  function actions() {
    const acts = $('#acts'), btns = [];
    if (['breadth', 'length-height', 'scale'].includes(kind) && b && b.book) btns.push('<button id="differs">Reading differs?</button>');
    if (kind === 'label' && picked && showType && !typed) btns.push('<button id="typeawb">Type the AWB</button>');
    if (kind === 'label' && s.awb && !Object.keys(byId).length) btns.push('<button id="wrongawb">Wrong AWB? Rescan</button>');
    if (showTake) btns.push('<button id="take">Take anyway</button>');
    acts.innerHTML = btns.join('');
    const on = (id, fn) => { const e = $('#' + id); if (e) e.onclick = fn; };
    on('differs', remeasure);
    on('typeawb', typeAwb);
    on('wrongawb', async () => {
      try { await R.clearAwb(s, byId); for (const x of boxes) if (x.label) await R.setLabel(x, null); typed = false; hist = []; header(); toast('AWB cleared - scan the label again'); }
      catch (e) { toast(e.message, 'bad'); }
    });
    on('take', () => capture(lastSharp, lastSteady, true));
  }

  async function attach(code, source, codes) {
    if (!s.awb) await R.attachAwb(s, code, source);
    if (b && !b.label) await R.setLabel(b, { code, codes, child: code !== s.awb, typed: source === 'typed' });
    await rowsChanged(s, b ? [b] : boxes);
    toast((code === s.awb ? 'AWB ' : 'Box label ') + fmtAwb(code) + ' attached', 'go');
    header();
  }

  async function choose(cands, codes) {
    chooser = true;
    const pick = await modal(`<h3>Which one is the AWB?</h3><p>The label has more than one number that looks like an AWB.</p>
      ${cands.map((c) => `<button class="wide" data-c="${esc(c)}" style="margin-top:8px"><span class="awb">${esc(fmtAwb(c))}</span></button>`).join('')}
      <button class="wide" id="none" style="margin-top:14px">None of these</button>`,
    (m, close) => { for (const x of m.querySelectorAll('[data-c]')) x.onclick = () => close(x.dataset.c); $('#none', m).onclick = () => close(null); });
    if (pick) await attach(pick, 'scan', codes);
    hist = []; chooser = false;
  }

  async function typeAwb() {
    const v = await modal(`<h3>Type the AWB</h3><p>Only when the barcode will not scan. The Sheet will show it was typed.</p>
      <label class="field">AWB<input type="text" id="awbin" autocomplete="off" inputmode="text" placeholder="e.g. 55130010176993"></label><div class="err" id="awberr"></div>
      <div class="row"><button id="no">Back</button><button class="primary" id="yes">Use this AWB</button></div>`,
    (m, close) => {
      setTimeout(() => $('#awbin', m).focus(), 50);
      $('#no', m).onclick = () => close(null);
      $('#yes', m).onclick = () => { const x = normCode($('#awbin', m).value); if (!AWB_OK.test(x)) { $('#awberr', m).textContent = '6-20 letters or digits'; return; } close(x); };
    });
    if (!v) return;
    typed = true;
    await attach(v, 'typed', []);
  }

  async function remeasure() {
    const fields = kind === 'breadth' ? ['breadth'] : kind === 'length-height' ? ['length', 'height'] : ['weight'];
    const unit = (f) => (f === 'weight' ? 'kg' : 'cm');
    const res = await modal(`<h3>Measure again</h3><p>Type what it reads now. Both readings are kept in the record.</p>
      ${fields.map((f) => `<label class="field">${f[0].toUpperCase() + f.slice(1)} (${unit(f)}) <span class="hint">recorded ${esc(b.readings[f])}</span>
        <input class="reading" type="text" inputmode="decimal" id="r-${f}" value="${esc(b.readings[f])}"><div class="err" id="re-${f}"></div></label>`).join('')}
      <div class="row"><button id="no">Back</button><button class="primary" id="yes">Save</button></div>`,
    (m, close) => {
      $('#no', m).onclick = () => close(null);
      $('#yes', m).onclick = () => {
        const out = {}; let bad = false;
        for (const f of fields) { const v = $('#r-' + f, m).value.trim().replace(',', '.'), e = checkReading(f, v); $('#re-' + f, m).textContent = e; if (e) bad = true; else out[f] = v; }
        if (!bad) close(out);
      };
    });
    if (!res) return;
    let changedBooking = false;
    for (const f of fields) {
      if (res[f] === b.readings[f]) continue;
      await R.addRemeasure(b, f, res[f]);
      const nb = bookNumbers({ ...b.readings, [f]: res[f] });
      if (b.book && String(nb[f]) !== String(b.book[f])) changedBooking = true;
    }
    await rowsChanged(s, [b]);
    if (!changedBooking) { toast('Re-measure saved; the booked numbers still hold'); return; }
    const act = await modal(`<h3>The booking no longer matches</h3><p>The new reading rounds to a different number than the one booked. The SOP says: peel off the label and redo the box from step 1 with a new record.</p>
      <div class="row"><button id="keep">Keep going (both readings recorded)</button><button class="danger" id="redo">Cancel this record</button></div>`,
    (m, close) => { $('#keep', m).onclick = () => close('keep'); $('#redo', m).onclick = () => close('redo'); });
    if (act === 'redo') { await R.cancelShipment(s, 're-measure changed the booking'); await rowsChanged(s, boxes); go('#/'); }
  }

  // -- the phone's camera app (v1.3): no live picture and no analysis loop. The photo comes back as a file and
  // goes through the same checks, naming and upload as an in-app photo; a photo that fails is shown with why.
  let lastInput = null, pickAt = 0;
  function openCamera(from) {
    if (!picked) { toast('Tap the box number printed on the label first', 'bad'); return; }
    if (busy) return;
    if (st.demo) { demoFileShot().then((f) => useFile(f, 'demo camera app')); return; }
    lastInput = from === 'gallery' ? $('#fgal') : $('#fcam');
    lastInput.value = '';
    pickAt = Date.now();
    lastInput.click();
  }
  async function demoFileShot() {   // computer demo: a drawn photo stands in for the camera app
    const dc = new DemoCamera();
    dc.setScene({ kind, code: !b || b.n === 1 ? DEMO_AWB : DEMO_AWB.slice(0, -1) + b.n, code2: DEMO_AWB.slice(0, -1) + '2', truth: b ? b.demo_truth : null, label: !isMeasure });
    dc.shakeUntil = 0;
    const r = await dc.takePhoto();
    return new File([r.blob], 'demo.jpg', { type: 'image/jpeg', lastModified: Date.now() });
  }
  async function useFile(file, via) {
    pickAt = 0;
    if (!file || busy) return;
    const t = file.lastModified && file.lastModified <= Date.now() + 60000 ? new Date(file.lastModified) : new Date();
    const agoMin = Math.max(0, Math.round((Date.now() - t.getTime()) / 60000));
    await capture(null, null, false, { blob: file, via, when: via === 'gallery' ? t : new Date(), agoMin: via === 'gallery' ? agoMin : 0 });
  }
  if (fileMode) {
    stopCamera();   // the camera app needs the camera to itself
    // Back from the camera with no photo (cancelled, or Android closed this page while the camera was open):
    // say so, instead of silently waiting.
    const onBack = () => {
      if (document.hidden || !pickAt) return;
      const at = pickAt;
      setTimeout(() => {
        if (pickAt === at && run.alive && !busy) toast('No photo came back from the camera. Take it again, or use "Choose a photo from the gallery".', 'bad');
      }, 3000);
    };
    document.addEventListener('visibilitychange', onBack);
    const before = app.cleanup;
    app.cleanup = () => { document.removeEventListener('visibilitychange', onBack); before(); };
    header();
    $('#snap').onclick = () => openCamera('camera');
    $('#gallery').onclick = () => openCamera('gallery');
    $('#fcam').onchange = (ev) => useFile(ev.target.files[0], 'camera app');
    $('#fgal').onchange = (ev) => useFile(ev.target.files[0], 'gallery');
    if (kind === 'label') barcode.getDetector().catch((e) => toast('Barcode reader failed to load: ' + e.message, 'bad'));
    return;
  }

  // -- camera
  try {
    await ensureCamera(video);
  } catch (e) {
    $('#say').innerHTML = `<b>Camera not available:</b> ${esc(e.message || e.name)}. Allow camera access for this site in Chrome, then <a href="#" id="again" style="color:#ffd54a">try again</a>.`;
    const a = $('#again'); if (a) a.onclick = (ev) => { ev.preventDefault(); render(); };
    return;
  }
  if (!run.alive) return;
  try { wake = navigator.wakeLock ? await navigator.wakeLock.request('screen') : null; } catch { wake = null; }
  demoScene(kind, s, b, boxes);
  if (kind === 'label') barcode.getDetector().catch((e) => toast('Barcode reader failed to load: ' + e.message, 'bad'));
  header();
  started = performance.now();
  scanFrom = started + 700;
  if (app.camera instanceof DemoCamera) {
    // Demo only: make the picture fail a check on purpose, to see the app wait instead of taking a bad photo.
    app.camera.ctrl = { shake: false, glare: false, cover: false };
    const names = { shake: 'Demo: shake the phone', glare: 'Demo: glare spot', cover: 'Demo: hand over the label' };
    const dc = $('#democtl');
    const paint = () => {
      dc.innerHTML = Object.keys(names).map((k) => `<button data-k="${k}" class="${app.camera.ctrl[k] ? 'go' : ''}">${names[k]}${app.camera.ctrl[k] ? ' - ON' : ''}</button>`).join('');
      for (const btn of dc.querySelectorAll('button')) btn.onclick = () => { app.camera.ctrl[btn.dataset.k] = !app.camera.ctrl[btn.dataset.k]; paint(); };
    };
    paint();
  }

  function sizeOverlay() {
    const r = ov.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    if (ov.width !== Math.round(r.width * dpr) || ov.height !== Math.round(r.height * dpr)) { ov.width = Math.round(r.width * dpr); ov.height = Math.round(r.height * dpr); }
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return videoRect(r.width, r.height, video.videoWidth, video.videoHeight);
  }

  async function scan(vw, vh) {
    let found;
    try { found = await barcode.detect(video, vw, vh); } catch { return; }
    if (!run.alive || busy) return;
    const rc = readCodes(found), now = performance.now();
    const want0 = expected();
    lastBars = found.map((f) => ({ box: f.box, good: !!want0 && normCode(f.rawValue) === want0 }));
    if (now < scanFrom) return;   // the picture may still be the previous box: wait for it to settle
    hist.push({ t: now, c: rc.cands });
    hist = hist.filter((h) => now - h.t < 1500);
    // A code counts once it is read twice in a row-ish (1.5 s), and never if another box already owns it.
    const stable = rc.cands.filter((c) => hist.filter((h) => h.c.includes(c)).length >= 2);
    const ownedByOther = (c) => boxes.find((o) => b && o.id !== b.id && o.label && o.label.child && o.label.code === c);
    const mine = stable.filter((c) => !ownedByOther(c));
    if (rc.orderRef && !s.order_ref) { s.order_ref = rc.orderRef; await db.put('shipments', s); }
    if (picked && !chooser && b) {
      if (!s.awb) {
        if (mine.length === 1) await attach(mine[0], 'scan', rc.all);
        else if (mine.length > 1) await choose(mine, rc.all);
      } else if (!b.label) {
        if (mine.includes(s.awb)) await attach(s.awb, 'scan', rc.all);
        else if (mine.length === 1) await attach(mine[0], 'scan', rc.all);
        else if (mine.length > 1) await choose(mine, rc.all);
        else if (stable.length && now - warnedAt > 4000) { warnedAt = now; toast(`That is box ${ownedByOther(stable[0]).n}'s label. Show box ${b.n}'s label.`, 'bad'); }
      }
    }
    const want = expected();
    lastBars = found.map((f) => ({ box: f.box, good: !!want && normCode(f.rawValue) === want }));
    if (want && rc.cands.includes(want)) lastGood = now;
  }

  function chip(label, ok, wait) { return `<span class="chip ${ok ? 'ok' : wait ? 'wait' : 'no'}">${label} ${ok ? '✓' : wait ? '…' : '✗'}</span>`; }

  // Camera app: the label photo itself attaches the AWB (one read of the full photo; no live scanning).
  async function attachFromPhoto(rc) {
    if (rc.orderRef && !s.order_ref) { s.order_ref = rc.orderRef; await db.put('shipments', s); }
    if (!picked || !b) return;
    const ownedByOther = (c) => boxes.find((o) => o.id !== b.id && o.label && o.label.child && o.label.code === c);
    const mine = rc.cands.filter((c) => !ownedByOther(c));
    if (!s.awb) {
      if (mine.length === 1) await attach(mine[0], 'scan', rc.all);
      else if (mine.length > 1) await choose(mine, rc.all);
    } else if (!b.label) {
      if (mine.includes(s.awb)) await attach(s.awb, 'scan', rc.all);
      else if (mine.length === 1) await attach(mine[0], 'scan', rc.all);
      else if (mine.length > 1) await choose(mine, rc.all);
    }
  }

  // Camera app: a photo that failed a check is shown with the reason; retake it or use it anyway.
  function showFailed(preview, reasons, given) {
    const url = URL.createObjectURL(preview);
    const needAwb = kind === 'label' && !(s.awb && b && b.label);
    review.innerHTML = `<img src="${url}" alt="photo just taken"><div class="ok bad">Not saved: ${esc(reasons.join('; '))}</div>
      <div class="line">${needAwb ? 'The AWB comes from this label photo: retake it closer and sharper, or type the AWB.' : 'Retake it, or use it anyway (the Sheet marks it "taken anyway").'}</div>
      <div class="actions"><button id="fretake" class="go">Retake</button>${needAwb ? '<button id="ftype">Type the AWB</button>' : '<button id="fuse">Use it anyway</button>'}</div>`;
    review.classList.remove('hidden');
    const close = () => { URL.revokeObjectURL(url); review.classList.add('hidden'); review.innerHTML = ''; };
    $('#fretake').onclick = () => { close(); openCamera(given.via === 'gallery' ? 'gallery' : 'camera'); };
    const use = $('#fuse');
    if (use) use.onclick = () => { close(); capture(null, null, true, given); };
    const ty = $('#ftype');
    if (ty) ty.onclick = async () => { await typeAwb(); if (s.awb && b && b.label) { close(); capture(null, null, false, given); } };
  }

  async function frame() {
    if (busy || !video.videoWidth || !review.classList.contains('hidden')) return;
    const vw = video.videoWidth, vh = video.videoHeight, now = performance.now();
    const zone = glareZone(look, st.calib, vw / vh);
    const m = measure(actx, video, vw, vh, zone, lv.glareSpot);
    const small = shrink(m.g, m.w, m.h, 4);
    const change = changeFraction(prev, small.g);
    prev = small.g;
    if (change <= lv.steadyChange) { if (!steadySince) steadySince = now; } else steadySince = 0;
    peaks.push({ t: now, v: m.sharp });
    peaks = peaks.filter((p) => now - p.t < 3000);
    const peak = Math.max(...peaks.map((p) => p.v));
    if (kind === 'label' && picked && !scanBusy && tick++ % (barcode.engine === 'zxing' ? 2 : 1) === 0) {
      scanBusy = true;
      scan(vw, vh).finally(() => { scanBusy = false; });
    }
    const need = lv.sharp[kind] ?? 150;
    const sharpOk = m.sharp >= need && m.sharp >= lv.peakRatio * peak;
    const glareSeen = !!m.spot || m.glare > lv.glareFrame;
    const lightOk = m.bright >= lv.brightMin && m.bright <= lv.brightMax && !(zone && glareSeen);
    const steadyMs = steadySince ? now - steadySince : 0, steadyOk = steadyMs >= lv.steadyMs;
    const codeOk = kind !== 'label' || typed || now - lastGood < 700;
    const awbOk = kind !== 'label' || !!(s.awb && b && b.label);
    lastSharp = m.sharp; lastSteady = steadyMs;
    const lightText = m.bright < lv.brightMin ? 'Too dark' : m.bright > lv.brightMax ? 'Too bright'
      : zone && glareSeen ? 'Glare on a reading' : glareSeen ? 'Light (bright patch)' : 'Light';
    $('#chips').innerHTML = (kind === 'label' ? chip(typed ? 'AWB typed' : 'Barcode', codeOk && awbOk, picked && !lastGood) : '') +
      chip(`Sharp ${Math.round(m.sharp)}/${need}`, sharpOk, false) + chip('Steady', steadyOk, steadySince > 0) + chip(lightText, lightOk, false);
    const ready = picked && !chooser && sharpOk && lightOk && steadyOk && codeOk && awbOk;
    const preReady = picked && !chooser && sharpOk && lightOk && codeOk && awbOk;
    const frac = preReady ? Math.min(1, steadyMs / lv.steadyMs) : 0;
    ring.setAttribute('stroke-dasharray', `${(frac * 138).toFixed(1)} 999`);
    drawOverlay(octx, sizeOverlay(), look, st.calib, { barcodes: kind === 'label' ? lastBars : [], spot: m.spot, ready: preReady });
    const waited = (now - started) / 1000;
    const wantTake = waited > lv.forceAfterS && picked && !chooser && awbOk;
    const wantType = kind === 'label' && picked && waited > 15 && !typed && !(b && b.label) && now - lastGood > 3000;
    if (wantTake !== showTake || wantType !== showType) { showTake = wantTake; showType = wantType; actions(); }
    if (ready) await capture(m.sharp, steadyMs, false);
  }

  // `given`: a photo from the phone's camera app or the gallery ({blob, via, when, agoMin}); otherwise the
  // in-app camera takes it now.
  async function capture(trigger, steadyMs, forced, given) {
    if (busy) return;
    busy = true;
    busyEl.textContent = given ? 'Checking the photo...' : 'Taking photo...'; busyEl.classList.remove('hidden');
    const when = given ? given.when : new Date(), id = uuid();
    try {
      // Photos the numbers are read from keep the camera's full resolution (v1.4: every photo); in the reading
      // routine the proof photos are cut to 2 MB at about 4,000 px.
      const keepFull = isMeasure || !READING_ROUTINE;
      const shot = given || await app.camera.takePhoto({ full: keepFull });
      if (!run.alive) return;
      busyEl.textContent = 'Checking the photo...';
      // Outlines, glare zones and close-ups come from the calibrated mounts: only for the in-app camera.
      const aspect = given ? null : video.videoWidth / video.videoHeight, zone = given ? null : glareZone(look, st.calib, aspect);
      // Images for the reader only when there is one (and, for a proof photo, a booking to compare with).
      readingNow = !readerOff() && (isMeasure || (recheck && !!(b && b.book)));
      const job = stillJob({
        blob: shot.blob, zone, spotShare: lv.glareSpot, previewAspect: aspect,
        maxLong: keepFull ? 20000 : MAX_LONG_SIDE, maxBytes: keepFull ? READ_MAX_BYTES : MAX_JPEG_BYTES, minQuality: MIN_QUALITY,
        keepOriginal: keepFull ? READ_MAX_BYTES : 0, probeLong: kind === 'label' ? (given ? 2400 : 1800) : 0,
        read: readingNow ? { long: READ_LONG_SIDE, quality: 0.85, crops: given ? [] : readCrops(kind, st.calib, aspect) } : null,
        exif: {
          make: st.phoneMake, model: st.phoneModel, software: `TFC Packing Proof ${APP_VERSION}`, dateMs: when.getTime(), uniqueId: id,
          description: `TFC packing proof | AWB ${s.awb || 'not yet booked'} | ${b ? `box ${b.n} of ${boxes.length}` : `${boxes.length} boxes`} | ${kind}`,
        },
      });
      const c = await job.checked;
      if (!run.alive) { job.cancel(); return; }
      if (!c.ok) throw new Error(c.error);
      const sj = judge(c.metrics, kind, lv, !!zone), reasons = [...sj.reasons];
      if (trigger && c.metrics.sharp < lv.stillRatio * trigger) reasons.push(`still less sharp than the preview (${Math.round(c.metrics.sharp)} vs ${Math.round(trigger)})`);
      if (given && given.agoMin > 30) reasons.push(`this photo was taken ${given.agoMin} minutes ago`);
      let note = '';
      if (kind === 'label') {
        if (typed) note = 'AWB typed, barcode not read';
        else {
          let seen = false;
          try {
            const f = await barcode.detect(c.probe, c.probe.width, c.probe.height), rc = readCodes(f);
            if (given) await attachFromPhoto(rc);   // camera app: the label photo itself attaches the AWB
            seen = rc.cands.includes(expected());
          } catch { seen = false; }
          note = seen ? 'barcode read on the still' : 'barcode NOT read on the still';
          if (!seen) reasons.push('barcode not readable in the photo');
        }
      }
      if (c.probe && c.probe.close) c.probe.close();
      const pass = reasons.length === 0;
      if (!pass && !forced) {
        job.cancel();
        busyEl.classList.add('hidden');
        if (given) { showFailed(c.preview, reasons, given); busy = false; return; }
        toast('Not saved: ' + reasons[0] + '. Hold steady - it tries again.', 'bad');
        steadySince = 0; await sleep(700); busy = false;
        return;
      }
      busyEl.classList.add('hidden');
      // Reading photo: the numbers are read now, in the background, while the team moves to the next step
      // (no reader: the photo is marked to be read later).
      if (isMeasure) startMeasureRead(sid, b.id, kind, id, c.read);
      const rv = showReview(c.preview, pass);
      const res = await job.done;   // the JPEG under 2 MB, with EXIF
      if (!res.ok) throw new Error(res.error);
      const checks = {
        captured_at: isoLocal(when), pass, forced: !!forced && !pass, reasons, level: sj.need, trigger: trigger ? Math.round(trigger) : null,
        steady_ms: given ? null : Math.round(steadyMs), still: c.metrics, barcode: note, size: `${res.width}x${res.height}`, quality: res.quality,
        bytes: res.bytes, via: shot.via, src: `${c.src.w}x${c.src.h}`, encodes: res.encodes, ms: res.ms, preview_aspect: aspect,
        engine: kind === 'label' ? barcode.engine : undefined, camera: given ? '' : app.camInfo ? app.camInfo.label : '',
        taken_ago_min: given && given.agoMin ? given.agoMin : undefined,
      };
      const p = await R.addPhoto(s, b, kind, { id, blob: res.jpeg, width: res.width, height: res.height, quality: res.quality, captured_at: checks.captured_at, checks }, byId);
      app.uploader.kick();
      beep();
      showTake = false; actions();   // e.g. "Wrong AWB?" is gone once a photo is saved
      rv.saved(p, checks);
      // Proof photo: read it again and compare with the booking (a warning only).
      if (recheck && c.read) startRecheck(sid, b.id, kind, p.id, c.read);
    } catch (e) {
      busyEl.classList.add('hidden');
      review.classList.add('hidden'); review.innerHTML = '';
      toast('Photo failed: ' + e.message, 'bad');
      await sleep(800);
      busy = false;
    }
  }

  // The photo shows as soon as its checks pass; Next unlocks once it is saved on the phone.
  function showReview(preview, pass) {
    const url = URL.createObjectURL(preview);
    review.innerHTML = `<img src="${url}" alt="photo just taken"><div class="ok" id="rvok">${pass ? 'Checks passed' : 'Taken anyway'} · saving...</div>
      <div class="line" id="rvline"></div>
      <div class="actions"><button id="retake" disabled>Retake</button><button class="go" id="nextp" disabled>Saving...</button></div>`;
    review.classList.remove('hidden');
    let timer = 0;
    const done = () => { clearInterval(timer); URL.revokeObjectURL(url); };
    return {
      saved(p, checks) {
        $('#rvok').textContent = `${checks.pass ? 'Saved ✓' : 'Saved - taken anyway'} · ${p.name || `${KIND_INFO[kind].title} (named when the label is scanned)`}`;
        $('#rvline').textContent = checksLine(checks) + (isMeasure ? (readingNow ? ' · reading the numbers…' : ' · the numbers are read from this photo later')
          : recheck && readingNow ? ' · re-reading against the booking…' : '');
        if (recheck && readingNow) {
          rereadListeners.set(p.id, (rr) => {
            const line = $('#rvline');
            if (!line) return;
            line.textContent = checksLine(checks) + (rr.status !== 'done' ? ` · re-read failed: ${rr.error}` : rr.mismatch ? ` · CHECK: ${rr.mismatch}` : ' · re-read matches the booking ✓');
          });
        }
        const nb = $('#nextp'), rb = $('#retake');
        nb.disabled = false; rb.disabled = false;
        let n = 4;
        nb.textContent = `Next (${n})`;
        timer = setInterval(() => { n -= 1; nb.textContent = `Next (${n})`; if (n <= 0) next(); }, 1000);
        rb.onclick = () => {
          done(); review.classList.add('hidden'); review.innerHTML = '';
          steadySince = 0; peaks = []; started = performance.now(); showTake = false; actions(); busy = false;
          toast('Retake: the new photo is saved as the next number and marked final');
          if (fileMode) openCamera(checks.via === 'gallery' ? 'gallery' : 'camera');
        };
        nb.onclick = next;
      },
    };
    async function next() {
      done();
      if (!run.alive) return;
      run.alive = false;
      const d2 = await R.load(sid);
      const cur = b && d2.boxes.find((x) => x.id === b.id);
      if (isMeasure) return go(measureNextHash(d2.s, cur));   // the next reading photo, then the box's readings
      const k = cur && BOX_KINDS.find((x) => !cur.photos[x].length);
      if (k) return go(`#/cap/${encodeURIComponent(sid)}/${encodeURIComponent(cur.id)}/${k}`);
      const nx = R.nextStep(d2.s, d2.boxes);
      if (nx.screen === 'capture') return go(`#/cap/${encodeURIComponent(sid)}/${nx.box ? encodeURIComponent(nx.box.id) : 'all'}/${nx.kind}`);
      if (nx.screen === 'done') { await R.markComplete(d2.s); await rowsChanged(d2.s, d2.boxes); return go(`#/done/${encodeURIComponent(sid)}`); }
      go(`#/s/${encodeURIComponent(sid)}`);
    }
  }

  (async function loop() {
    while (run.alive) {
      try { await frame(); } catch (e) { console.warn(e); }
      await sleep(150);
    }
  })();
}

// ---------------------------------------------------------------- done (SOP step 10)
async function screenDone(sid) {
  const d = await R.load(sid);
  if (!d) return go('#/');
  const { s, boxes, byId } = d;
  // The proof photos were read again: anything that does not match the booking is shown before handover.
  const rr = [];
  for (const b of boxes) for (const k of BOX_KINDS) {
    const p = R.finalPhoto(b.photos[k], byId);
    if (p && p.reread) rr.push({ b, k, r: p.reread });
  }
  const bad = rr.filter((x) => x.r.status === 'done' && x.r.mismatch);
  // Re-reads only run with a reader and a box that has numbers to compare with.
  const pendingRe = !readerOff() && boxes.some((b) => b.book && BOX_KINDS.some((k) => { const p = R.finalPhoto(b.photos[k], byId); return p && ['breadth', 'length-height', 'scale'].includes(k) && !p.reread; }));
  const later = boxes.filter((b) => !R.readingsDone(b));
  view(`${bar('Done')}<main>
    <div class="card go"><h3>All photos taken ✓</h3><p>Take the phone off the mount and hand the box over.</p></div>
    ${bad.length ? `<div class="card bad"><h3>Check before handing over</h3>${bad.map((x) => `<p>${boxes.length > 1 ? `Box ${x.b.n} ` : ''}${esc(KIND_INFO[x.k].title)} photo: ${esc(x.r.mismatch)}</p>`).join('')}<p class="small">If the booking is wrong, peel the label and redo the box from the start.</p></div>`
    : pendingRe ? '<div class="card small">Re-reading the proof photos against the booking…</div>' : rr.some((x) => x.r.status === 'done') ? '<div class="card go small">The proof photos read the same as the booking ✓</div>' : ''}
    ${later.length ? `<div class="card small">${boxes.length > 1 ? `Box ${later.map((b) => b.n).join(', ')}: n` : 'N'}umbers to be read from ${READING_ROUTINE ? 'the reading photos' : 'these photos'} later.</div>` : ''}
    <div class="card"><dl class="kv"><dt>AWB</dt><dd><span class="awb">${esc(s.awb)}</span></dd><dt>Boxes</dt><dd>${boxes.length}</dd>
      <dt>Uploaded</dt><dd id="sent">...</dd></dl></div>
    <button class="big primary" id="new">New box</button>
    <button class="wide" id="home" style="margin-top:10px">Home</button></main>`);
  $('#new').onclick = startNewBox;
  $('#home').onclick = () => go('#/');
  const run = { alive: true };
  app.cleanup = () => { run.alive = false; };
  (async () => {
    while (run.alive) {
      const ph = await db.byIndex('photos', 'shipment', sid);
      const el = $('#sent');
      if (!el || !run.alive) break;
      const ok = ph.filter((p) => p.upload.state === 'done').length;
      el.textContent = `${ok} of ${ph.length} photos${ok === ph.length ? ' ✓' : ' (the rest upload in the background)'}`;
      await sleep(2000);
    }
  })();
}

// ---------------------------------------------------------------- station log: shift start, scale test
async function addLog(entry) {
  const e = { id: uuid(), at: isoLocal(), day: istDay(), station: app.settings.station, test: app.settings.test, phone: app.settings.phoneModel, ...entry };
  await db.put('logs', e);
  await db.enqueue({ type: 'log', log_id: e.id });
  app.uploader.kick();
  return e;
}

async function screenShift() {
  view(`${bar('Start of shift')}<main>
    <label class="check"><input type="checkbox" id="c1"><span>Pressed <b>ZERO</b> on the empty scale and it reads zero.</span></label>
    <label class="check"><input type="checkbox" id="c2"><span>Bay checked: walls tight, every scale at 0 against its wall, the end panel square.</span></label>
    <label class="field">Notes <input type="text" id="notes" placeholder="optional"></label>
    <button class="big primary" id="log" disabled>Log start of shift</button></main>`);
  const upd = () => { $('#log').disabled = !($('#c1').checked && $('#c2').checked); };
  $('#c1').onchange = upd; $('#c2').onchange = upd;
  $('#log').onclick = async () => { await addLog({ type: 'shift-start', result: 'checked', reading: '', notes: $('#notes').value.trim() }); toast('Shift start logged', 'go'); go('#/'); };
}

async function screenScaleTest() {
  view(`${bar('Scale test')}<main><div class="instr">Put the <b>10 kg test weight</b> on the empty scale and type the reading.</div>
    <label class="field">Reading <input class="reading" type="text" inputmode="decimal" id="rd" placeholder="kg"><div class="err" id="er"></div></label>
    <button class="big primary" id="log">Log reading</button><div id="out"></div></main>`);
  setTimeout(() => $('#rd').focus(), 60);
  $('#log').onclick = async () => {
    const v = $('#rd').value.trim().replace(',', '.'), g = Number(v);
    if (!/^\d{1,3}(\.\d{1,3})?$/.test(v)) { $('#er').textContent = 'Type the reading, e.g. 10.00'; return; }
    const pass = Math.abs(g - 10) <= 0.05 + 1e-9;   // the scale steps in 0.05 kg: more than one step off = stop
    await addLog({ type: 'scale-test', reading: v, result: pass ? 'pass' : 'fail', notes: pass ? '' : 'more than one 0.05 kg step off' });
    $('#out').innerHTML = pass ? '<div class="card go"><b>OK ✓</b> The scale is within one step.</div>'
      : '<div class="card bad"><b>STOP using this scale.</b> It is more than one step (0.05 kg) off. Do not weigh boxes on it until it is fixed.</div>';
    $('#log').disabled = true;
  };
}

// ---------------------------------------------------------------- settings
async function screenSettings() {
  const st = app.settings, lv = st.levels;
  const cams = await listCameras();
  const lvl = (k) => `<label class="field">${k} <input type="number" data-sharp="${k}" value="${lv.sharp[k]}" min="0" step="10"></label>`;
  view(`${bar('Settings', st.setupDone ? '#/' : '')}<main>
    ${st.setupDone ? '' : '<div class="card warn"><b>First time on this phone.</b> Paste the backend URL, type the station key once, test the connection, then Save.</div>'}
    <label class="field">Backend URL <span class="hint">The Apps Script web-app address ending in /exec.</span><input type="url" id="url" value="${esc(st.scriptUrl)}" placeholder="https://script.google.com/macros/s/.../exec" autocomplete="off"></label>
    <label class="field">Station key <span class="hint">Typed once. It stays on this phone and is never in the app's code.</span><input type="password" id="key" value="${esc(st.key)}" autocomplete="off"></label>
    <label class="check"><input type="checkbox" id="showkey"><span class="small">Show the key</span></label>
    <button class="wide" id="test">Test connection</button><div id="testout" class="small" style="margin:8px 0 4px"></div>
    <label class="field">Station name<input type="text" id="station" value="${esc(st.station)}"></label>
    <label class="check"><input type="checkbox" id="testmode" ${st.test ? 'checked' : ''}><span><b>TEST mode</b><br><span class="small muted">Files go to Packing Proof/TEST and rows to the "TEST boxes" tab. Turn off to go live.</span></span></label>
    <h2>Camera</h2>
    <label class="field">How photos are taken <span class="hint">The phone's camera app: you frame, focus and tap the shutter, at the camera's full resolution; the app checks each photo when it comes back. In-app camera: the app takes the photo by itself once the picture is sharp, steady and well lit.</span>
      <select id="cammode"><option value="app" ${st.cameraMode !== 'live' ? 'selected' : ''}>The phone's camera app (recommended)</option><option value="live" ${st.cameraMode === 'live' ? 'selected' : ''}>In-app camera (takes the photo by itself)</option></select></label>
    <label class="field">In-app camera lens <span class="hint">Only for the in-app camera: the main rear camera, not the wide-angle. Names appear after the first photo screen allows the camera.</span>
      <select id="cam"><option value="">Automatic (rear camera)</option>${cams.map((c) => `<option value="${esc(c.id)}" ${c.id === st.cameraId ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select></label>
    <div class="row"><label class="field">Phone make<input type="text" id="make" value="${esc(st.phoneMake)}" placeholder="e.g. Samsung"></label>
      <label class="field">Phone model<input type="text" id="model" value="${esc(st.phoneModel)}" placeholder="e.g. SM-A356E"></label></div>
    <div class="row"><button id="calbay">Calibrate bay mount</button><button id="calscale">Calibrate scale mount</button></div>
    <p class="small muted">Calibrated: bay ${st.calib.bay ? '✓' : 'no'} · scale ${st.calib.scale ? '✓' : 'no'}. The calibration screen also shows the live sharpness and light numbers.</p>
    <details><summary>Check levels (advanced)</summary>
      <p class="small muted">Sharpness is the frame-trial score (edge variance on a 540x960 grey copy). Set each level a little below what a good photo scores at the station.</p>
      <div class="row">${['label', 'scale', 'length', 'breadth', 'height', 'boxes'].map(lvl).join('')}</div>
      <div class="row"><label class="field">Steady (ms)<input type="number" id="steadyMs" value="${lv.steadyMs}" step="100"></label>
        <label class="field">Dark below<input type="number" id="brightMin" value="${lv.brightMin}"></label>
        <label class="field">Bright above<input type="number" id="brightMax" value="${lv.brightMax}"></label></div>
      <div class="row"><label class="field">Glare allowed (%)<input type="number" id="glare" value="${(lv.glareFrame * 100).toFixed(1)}" step="0.5"></label>
        <label class="field">"Take anyway" after (s)<input type="number" id="force" value="${lv.forceAfterS}"></label></div>
      <button class="wide" id="resetlv">Reset levels</button>
    </details>
    <label class="check"><input type="checkbox" id="demo" ${st.demo ? 'checked' : ''}><span>Demo camera <span class="small muted">(computer testing only; forces TEST mode)</span></span></label>
    <h2>Reading the numbers</h2>
    <p class="small">${st.reader === false ? 'Later, from the photos: no reader is set up, so the app leaves the numbers empty and the reading photos are read afterwards.'
      : st.reader ? 'In the app: the numbers are read from each reading photo straight away.' : 'Not known yet: Test connection to find out.'}</p>
    ${app.harness ? `<label class="field">Anthropic API key for this test (optional) <span class="hint">Only on this test site, which has no backend: the key stays on this device and goes straight to Anthropic. Use a separate key with a low spending limit and delete it after the test. The real backend keeps its key in the Apps Script instead.</span>
      <input type="password" id="aikey" value="${esc(st.testAiKey || '')}" autocomplete="off" placeholder="sk-ant-..."></label>
    <p class="small muted">Without a key everything works the same, except that the numbers stay empty: the reading photos are kept and the numbers are read from them later.</p>` : ''}
    <button class="big primary" id="save" style="margin-top:12px">Save</button>
    <h2>About this phone</h2>
    <dl class="kv small"><dt>App</dt><dd>v${APP_VERSION}</dd><dt>Barcode reader</dt><dd id="eng">${esc(barcode.engine)}</dd><dt>Storage</dt><dd id="stor">...</dd>
      <dt>Uploads</dt><dd>${app.q.pending || 0} waiting · <a href="#/queue">details</a></dd></dl>
  </main>`);
  $('#showkey').onchange = () => { $('#key').type = $('#showkey').checked ? 'text' : 'password'; };
  db.usage().then((u) => { const el = $('#stor'); if (el && u) el.textContent = `${(u.usage / 1e6).toFixed(0)} MB used of ${(u.quota / 1e9).toFixed(1)} GB`; });
  barcode.getDetector().then(() => { const el = $('#eng'); if (el) el.textContent = barcode.engine; }).catch(() => {});
  const collect = () => {
    const sharp = {};
    for (const el of document.querySelectorAll('[data-sharp]')) sharp[el.dataset.sharp] = Math.max(0, Number(el.value) || 0);
    return {
      scriptUrl: $('#url').value.trim(), key: $('#key').value.trim(), station: $('#station').value.trim() || 'Station 1',
      test: $('#testmode').checked || $('#demo').checked, demo: $('#demo').checked, cameraId: $('#cam').value, cameraMode: $('#cammode').value,
      phoneMake: $('#make').value.trim(), phoneModel: $('#model').value.trim(),
      testAiKey: $('#aikey') ? $('#aikey').value.trim() : st.testAiKey || '',
      levels: mergeLevels({ ...st.levels, sharp, steadyMs: Number($('#steadyMs').value) || 500, brightMin: Number($('#brightMin').value) || 0,
        brightMax: Number($('#brightMax').value) || 255, glareFrame: (Number($('#glare').value) || 0) / 100, forceAfterS: Number($('#force').value) || 20 }),
    };
  };
  $('#test').onclick = async () => {
    const c = collect(), out = $('#testout');
    if (!c.scriptUrl) { out.textContent = 'Paste the backend URL first.'; return; }
    out.textContent = 'Testing...';
    try {
      const r = await transport.post(c.scriptUrl, { v: 1, action: 'ping', key: c.key, station: c.station, app: APP_VERSION, phone: c.phoneModel, test: c.test });
      if (r.ok) {
        await saveSettings({ reader: !!r.reader });
        out.innerHTML = `<div class="card go"><b>Connected.</b> This page can read the script's reply, and the key was accepted. Script v${esc(r.version)}.<br>` +
          `Drive: <a href="${esc(r.root && r.root.url)}" target="_blank" rel="noopener">${esc(r.root && r.root.name)}</a> · Sheet: <a href="${esc(r.sheet && r.sheet.url)}" target="_blank" rel="noopener">open</a><br>` +
          `Numbers: ${r.reader ? 'read in the app (the script has an API key)' : 'read later from the photos (no API key - that is fine)'}</div>`;
      }
      else if (r.code === 'bad_key') out.innerHTML = '<div class="card warn"><b>Reply readable, key refused.</b> The page can read the script (CORS is fine), but the station key is wrong.</div>';
      else out.innerHTML = `<div class="card warn">Reply: ${esc(r.code)} ${esc(r.error || '')}</div>`;
    } catch (e) {
      let reached = false;
      try { await fetch(c.scriptUrl, { method: 'POST', mode: 'no-cors', body: '{"v":1,"action":"ping"}', headers: { 'Content-Type': 'text/plain' } }); reached = true; } catch { reached = false; }
      out.innerHTML = reached
        ? '<div class="card bad"><b>The script answered, but this page cannot read its reply (CORS).</b> Use the Google sign-in fallback described in the README.</div>'
        : `<div class="card bad"><b>Cannot reach the script.</b> ${esc(e.message)}</div>`;
    }
  };
  $('#resetlv').onclick = async () => { await saveSettings({ levels: mergeLevels({}) }); toast('Levels reset'); render(); };
  const toCalib = (m) => async () => { await saveSettings(collect()); go(`#/calib/${m}`); };
  $('#calbay').onclick = toCalib('bay');
  $('#calscale').onclick = toCalib('scale');
  $('#save').onclick = async () => {
    const c = collect();
    if (!c.scriptUrl || !/^https:\/\/|^http:\/\/localhost/.test(c.scriptUrl)) { toast('Paste the backend URL (https://...)', 'bad'); return; }
    if (c.key.length < 8) { toast('Type the station key (8 characters or more)', 'bad'); return; }
    if (c.cameraId !== st.cameraId || c.demo !== st.demo) stopCamera();
    await saveSettings({ ...c, setupDone: true });
    if (app.harness) app.harness.setReaderKey(c.testAiKey);
    await refreshReader();
    app.uploader.retryNow();
    toast('Saved', 'go');
    go('#/');
  };
}

// ---------------------------------------------------------------- calibration (and live check numbers)
async function screenCalib(mount) {
  if (!CALIB_STEPS[mount]) return go('#/settings');
  const steps = CALIB_STEPS[mount], kind = mount === 'bay' ? 'breadth' : 'scale';
  view(`<div class="cam"><div class="stage"><video playsinline muted></video><canvas class="ov"></canvas>
      <div class="top"><div class="t1"><b>Calibrate the ${mount} mount</b><button class="x" id="close">Close</button></div><div class="t2" id="live"></div></div></div>
    <div class="panel"><div class="say" id="say"></div><div class="shows">Put the phone on its mount first. Tap exactly on the corners in the picture.</div>
      <div class="actions"><button id="undo">Undo</button><button id="clear">Clear saved</button><button class="go" id="save" disabled>Save</button></div></div></div>`);
  const video = $('.cam video'), ov = $('.cam canvas.ov'), octx = ov.getContext('2d');
  const actx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const run = { alive: true };
  app.cleanup = () => { run.alive = false; };
  $('#close').onclick = () => go('#/settings');
  try { await ensureCamera(video); } catch (e) { $('#say').textContent = 'Camera not available: ' + (e.message || e.name); return; }
  demoScene(kind, null, null, []);
  let taps = [], prev = null;
  const rect = () => {
    const r = ov.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    ov.width = Math.round(r.width * dpr); ov.height = Math.round(r.height * dpr); octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { box: r, vr: videoRect(r.width, r.height, video.videoWidth, video.videoHeight) };
  };
  const upd = () => {
    $('#say').textContent = taps.length < steps.length ? `${taps.length + 1}/${steps.length}: ${steps[taps.length]}` : 'All corners set. Save to keep this outline.';
    $('#save').disabled = taps.length < steps.length;
    drawTaps(octx, rect().vr, taps);
  };
  ov.addEventListener('click', (e) => {
    if (taps.length >= steps.length) return;
    const { box, vr } = rect(), x = (e.clientX - box.left - vr.x) / vr.w, y = (e.clientY - box.top - vr.y) / vr.h;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    taps.push([Number(x.toFixed(4)), Number(y.toFixed(4))]);
    upd();
  });
  $('#undo').onclick = () => { taps.pop(); upd(); };
  $('#clear').onclick = async () => { const c = { ...app.settings.calib }; delete c[mount]; await saveSettings({ calib: c }); toast('Calibration cleared'); taps = []; upd(); };
  $('#save').onclick = async () => {
    const c = { ...app.settings.calib, [mount]: calibFromTaps(mount, taps, video.videoWidth / video.videoHeight) };
    await saveSettings({ calib: c }); toast('Outline saved', 'go'); go('#/settings');
  };
  upd();
  (async () => {
    while (run.alive) {
      const live = $('#live');
      if (video.videoWidth && live) {
        const m = measure(actx, video, video.videoWidth, video.videoHeight, null, app.settings.levels.glareSpot);
        const small = shrink(m.g, m.w, m.h, 4), ch = changeFraction(prev, small.g); prev = small.g;
        live.textContent = `Live: sharp ${Math.round(m.sharp)} · light ${Math.round(m.bright)} · glare ${(m.glare * 100).toFixed(1)}%${m.spot ? ' SPOT' : ''} · movement ${(ch * 100).toFixed(1)}% · ${app.camInfo ? app.camInfo.preview : ''}`;
      }
      await sleep(300);
    }
  })();
}

// ---------------------------------------------------------------- upload details
async function screenQueue() {
  const q = (await db.all('queue')).sort((a, b) => a.seq - b.seq);
  const photos = (await db.all('photos')).sort((a, b) => (b.captured_at || '').localeCompare(a.captured_at || '')).slice(0, 60);
  const when = (ms) => (ms ? new Date(ms).toTimeString().slice(0, 8) : 'now');
  view(`${bar('Uploads')}<main>
    <button class="wide primary" id="retry">Retry all now</button>
    <h2>Waiting (${q.length})</h2>
    ${q.map((i) => `<div class="card small"><b>${esc(i.type)}</b> ${esc(i.photo_id || i.box_id || i.log_id || '')}<br>tries ${i.tries || 0} · next ${when(i.next)}${i.error ? `<br><span style="color:var(--bad)">${esc(i.error)}</span>` : ''}</div>`).join('') || '<p class="muted">Nothing waiting.</p>'}
    <h2>Recent photos</h2>
    ${photos.map((p) => `<div class="card small"><b>${esc(p.name)}</b> · ${Math.round((p.bytes || 0) / 1024)} KB · ${esc(p.upload.state)}${p.upload.url ? ` · <a href="${esc(p.upload.url)}" target="_blank" rel="noopener">Drive</a>` : ''}${p.upload.error ? ` · ${esc(p.upload.error)}` : ''}</div>`).join('') || '<p class="muted">No photos yet.</p>'}
  </main>`);
  $('#retry').onclick = async () => { await app.uploader.retryNow(); render(); };
}

// ---------------------------------------------------------------- demo: what reached the (emulated) Drive and Sheet
async function screenDemo() {
  const h = app.harness;
  if (!h) return go('#/');
  const files = h.filesUnder('Packing Proof').map((f) => ({ f, path: h.pathOf(f.id) })).sort((a, b) => a.path.localeCompare(b.path));
  const folders = new Map();
  for (const x of files) {
    const dir = x.path.split('/').slice(0, -1).join('/');
    if (!folders.has(dir)) folders.set(dir, []);
    folders.get(dir).push(x.f);
  }
  const urls = [];
  const thumb = (f) => {
    const u = URL.createObjectURL(new Blob([f.bytes], { type: 'image/jpeg' }));
    urls.push(u);
    return `<figure><img src="${u}" alt="" data-full="${u}"><figcaption>${esc(f.name)}<br>${Math.round(f.bytes.length / 1024)} KB</figcaption></figure>`;
  };
  const tabs = ['TEST boxes', 'Boxes'].map((t) => ({ t, rows: h.rows(t) })).filter((x) => x.rows.length);
  const cols = ['AWB', 'Box', 'Boxes', 'Status', 'Weight kg', 'Length cm', 'Breadth cm', 'Height cm', 'Book weight kg', 'Book L cm', 'Book B cm', 'Book H cm', 'Label codes read', 'Booked', 'Complete'];
  const photoCols = ['Label photo', 'Breadth photo', 'Length-height photo', 'Scale photo', 'Boxes photo'];
  const table = (rows) => `<div class="tablewrap"><table><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}<th>Photos</th><th>Checks (label)</th></tr>` +
    rows.map((r) => `<tr>${cols.map((c) => `<td>${esc(r[c])}</td>`).join('')}<td>${photoCols.filter((c) => r[c]).length}</td><td class="wrap">${esc(r['Checks label'])}</td></tr>`).join('') + '</table></div>';
  const log = h.rows('Station log');
  view(`${bar('Demo: Drive and Sheet')}<main>
    <div class="card warn">These are test copies kept on this device by the demo backend. Your real Google Drive and Sheets are not touched.</div>
    <h2>Drive: Packing Proof/ (${files.length} photos)</h2>
    ${[...folders].map(([dir, fs]) => `<div class="card"><b>${esc(dir)}/</b><div class="thumbs">${fs.map(thumb).join('')}</div></div>`).join('') || '<p class="muted">No photos yet. Do a box first.</p>'}
    ${tabs.map((x) => `<h2>Sheet "Packing Proof" · tab ${esc(x.t)} (${x.rows.length} rows, one per box)</h2>${table(x.rows)}`).join('') || '<h2>Sheet "Packing Proof"</h2><p class="muted">No rows yet.</p>'}
    <h2>Station log (${log.length})</h2>
    ${log.length ? `<div class="tablewrap"><table><tr><th>Logged</th><th>Type</th><th>Reading</th><th>Result</th></tr>${log.map((r) => `<tr><td>${esc(r['Logged'])}</td><td>${esc(r['Type'])}</td><td>${esc(r['Reading'])}</td><td>${esc(r['Result'])}</td></tr>`).join('')}</table></div>` : '<p class="muted">Nothing logged.</p>'}
    <button class="danger wide" id="reset" style="margin-top:22px">Start the demo again (clears the demo data)</button>
  </main>`);
  app.cleanup = () => urls.forEach((u) => URL.revokeObjectURL(u));
  for (const img of document.querySelectorAll('.thumbs img')) img.onclick = () => modal(`<img src="${img.dataset.full}" alt="" style="width:100%;border-radius:10px"><div class="row"><button id="x">Close</button></div>`, (m, close) => { $('#x', m).onclick = () => close(); });
  $('#reset').onclick = async () => {
    const ok = await modal('<h3>Start the demo again?</h3><p>This clears the demo boxes, photos and the test Sheet on this device. Nothing else.</p><div class="row"><button id="no">Keep them</button><button class="danger" id="yes">Clear and restart</button></div>',
      (m, close) => { $('#no', m).onclick = () => close(false); $('#yes', m).onclick = () => close(true); });
    if (!ok) return;
    await h.reset();
    await db.wipe();
    location.hash = '#/';
    location.reload();
  };
}

// ---------------------------------------------------------------- housekeeping + start
async function prune() {
  const now = Date.now(), DAY = 864e5;
  for (const p of await db.all('photos')) {
    if (p.blob && p.upload && p.upload.state === 'done' && p.upload.at && now - Date.parse(p.upload.at) > 7 * DAY) { p.blob = null; await db.put('photos', p); }
  }
  const q = await db.all('queue');
  for (const s of await db.all('shipments')) {
    const end = s.completed_at || s.cancelled_at;
    if (!end || now - Date.parse(end) < 45 * DAY || q.some((i) => i.shipment_id === s.id)) continue;
    const ph = await db.byIndex('photos', 'shipment', s.id);
    if (ph.some((p) => p.upload.state !== 'done')) continue;
    for (const p of ph) await db.del('photos', p.id);
    for (const b of await db.byIndex('boxes', 'shipment', s.id)) await db.del('boxes', b.id);
    await db.del('shipments', s.id);
  }
}

function registerSW() {
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if (!('serviceWorker' in navigator) || local) return;
  navigator.serviceWorker.register('sw.js').catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    toast('App updated - it uses the new version from the next screen');
  });
}

async function boot() {
  app.settings = await loadSettings();
  const qs = new URLSearchParams(location.search);
  if (qs.has('demo')) await saveSettings({ demo: qs.get('demo') !== '0', test: true });
  if (TEST_SITE || qs.has('harness')) {
    // Demo / TEST site only: uploads go to an emulator of the Apps Script, Drive and Sheet in this browser.
    try {
      const h = await import(TEST_BACKEND);
      await h.load({ persist: true });
      transport.post = h.post; app.harness = h;
      h.setReaderKey(app.settings.testAiKey || '');
      // The computer demo answers the drawn camera with the numbers it drew (?reader=off to try it without).
      // The phone TEST site has no such stand-in: a key typed in Settings, or the numbers are read later.
      h.setDemoReader(!TEST_SITE && qs.get('reader') !== 'off');
      if (!app.settings.setupDone) {
        // ?demo=1: the drawn demo camera, whose bay and scale match the default outlines. Without it (a phone test),
        // the real camera is used and the mounts are calibrated by hand.
        const demo = qs.has('demo') && qs.get('demo') !== '0', aspect = 1280 / 720;
        await saveSettings({
          scriptUrl: HARNESS_URL, key: h.state.key, station: 'Demo station', test: true, demo, setupDone: true,
          phoneModel: app.settings.phoneModel || (demo ? 'Demo phone' : ''),
          calib: demo ? { bay: { pts: DEFAULT_BAY, aspect }, scale: { pts: DEFAULT_PLATFORM, display: DEFAULT_DISPLAY, aspect } } : {},
        });
      }
    } catch (e) { console.warn('test harness not loaded', e); }
  }
  if (!app.settings.phoneModel) { const model = await detectPhone(); if (model) await saveSettings({ phoneModel: model }); }
  db.persist();
  app.uploader = new Uploader(async () => app.settings, onQ);
  window.addEventListener('online', () => app.uploader.kick());
  window.addEventListener('offline', () => onQ(app.q));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { stopCamera(); return; }
    const r = parts()[0];
    // Only the in-app camera needs its picture restarted. With the phone's camera app the page is hidden while the
    // photo is taken: redrawing then would throw away the screen that is waiting for that photo.
    if ((r === 'cap' && app.settings.cameraMode === 'live') || r === 'calib') render();
    app.uploader.kick();
  });
  window.addEventListener('hashchange', render);
  setInterval(() => app.uploader.kick(), 30000);
  prune().catch(() => {});
  // A reading still marked "reading" from before the app was closed will never answer: offer "Read again".
  for (const b of await db.all('boxes')) {
    const jobs = Object.values(b.read_jobs || {}).filter((j) => j.status === 'reading');
    if (!jobs.length) continue;
    for (const j of jobs) { j.status = 'failed'; j.error = 'interrupted - tap Read again'; }
    await db.put('boxes', b);
  }
  registerSW();
  await Promise.race([refreshReader(), sleep(1500)]);   // never hold the start up for long; the last answer is kept
  await render();
  app.uploader.kick();
}

boot();
