// TFC Packing Proof - the station app. Runs the SOP routine: new box record -> typed readings -> numbers to book
// -> scan the new label (attaches the AWB) -> label photo -> breadth -> length-height -> weight photo.
// Photos are taken automatically only when the frame is sharp, steady and well lit, re-checked on the full-size
// still, saved on the phone first and uploaded from a queue.
import { APP_VERSION, DEFAULT_SCRIPT_URL, DEFAULT_LEVELS, KIND_INFO, BOX_KINDS, MAX_JPEG_BYTES, MAX_LONG_SIDE, MIN_QUALITY, DEMO_AWB, TEST_SITE, TEST_BACKEND } from './config.js';
import * as db from './store.js';
import * as R from './records.js';
import { checkReading, readingWarnings, readCodes, normCode, AWB_OK, isoLocal, istDay, istParts, uuid, checksLine, bookNumbers } from './logic.js';
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
  phoneMake: '', phoneModel: '', levels: DEFAULT_LEVELS, calib: {}, setupDone: false,
};
const mergeLevels = (l = {}) => ({ ...DEFAULT_LEVELS, ...l, sharp: { ...DEFAULT_LEVELS.sharp, ...(l.sharp || {}) } });

async function loadSettings() {
  const s = await db.getKV('settings', {});
  const out = { ...DEFAULTS, ...s, levels: mergeLevels(s.levels) };
  if (!out.scriptUrl) out.scriptUrl = DEFAULT_SCRIPT_URL;
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
  app.camera.setScene({ kind, code, code2: DEMO_AWB.slice(0, -1) + '2', weight: b ? b.readings.weight : '' });
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
  $('#new').onclick = async () => { const { b } = await R.createShipment(app.settings); go(`#/m/${encodeURIComponent(b.id)}`); };
  const r = $('#retry'); if (r) r.onclick = () => app.uploader.retryNow();
}

// ---------------------------------------------------------------- one order (shipment)
function bookGrid(b) {
  const k = b.book || {};
  return `<div class="book"><div><small>Length</small><b>${k.length ?? '-'}</b><span>cm</span></div>` +
    `<div><small>Breadth</small><b>${k.breadth ?? '-'}</b><span>cm</span></div>` +
    `<div><small>Height</small><b>${k.height ?? '-'}</b><span>cm</span></div>` +
    `<div><small>Weight</small><b>${k.weight ?? '-'}</b><span>kg</span></div></div>`;
}
const measuredLine = (b) => `Measured: L ${esc(b.readings.length || '-')} · B ${esc(b.readings.breadth || '-')} · H ${esc(b.readings.height || '-')} cm · ${esc(b.readings.weight || '-')} kg`;

async function screenShipment(sid) {
  const d = await R.load(sid);
  if (!d) return go('#/');
  const { s, boxes } = d, stt = R.shipmentStatus(s, boxes), nx = R.nextStep(s, boxes), multi = boxes.length > 1;
  const kindMark = (b, k) => (b.photos[k].length ? '✓' : '·');
  const boxCard = (b) => `<div class="card"><h3>Box ${b.n}${multi ? ' of ' + boxes.length : ''} · ${esc(R.boxStatus(s, b))}</h3>
      ${R.readingsDone(b) ? bookGrid(b) + `<div class="small muted">${measuredLine(b)}</div>` : `<p class="muted">${measuredLine(b)}</p>`}
      ${s.booked_at ? `<div class="small" style="margin-top:6px">Photos: label ${kindMark(b, 'label')} · breadth ${kindMark(b, 'breadth')} · length-height ${kindMark(b, 'length-height')} · weight ${kindMark(b, 'scale')}${b.label && b.label.child ? ` · box label <span class="awb">${esc(b.label.code)}</span>` : ''}</div>` : ''}
      ${!s.booked_at && !s.cancelled_at ? `<button class="wide" style="margin-top:8px" data-edit="${esc(b.id)}">${R.readingsDone(b) ? 'Edit readings' : 'Measure this box'}</button>` : ''}
    </div>`;
  let main = '';
  if (s.cancelled_at) main = `<div class="card bad"><b>Cancelled</b> ${esc(s.cancel_reason)}</div>`;
  else if (nx.screen === 'measure') main = `<button class="big primary" id="next">Measure box ${nx.box.n}</button>`;
  else if (nx.screen === 'book') main = `<button class="big primary" id="next">Numbers to book</button>`;
  else if (nx.screen === 'capture') main = `<button class="big primary" id="next">Continue: ${nx.kind === 'boxes' ? 'photo of all boxes' : `box ${nx.box.n} ${KIND_INFO[nx.kind].title.toLowerCase()} photo`}</button>`;
  else main = `<div class="card go"><b>All photos taken ✓</b></div>`;
  view(`${bar(s.awb ? 'AWB ' + fmtAwb(s.awb) : 'New order record')}<main>
    <div class="card"><dl class="kv"><dt>Status</dt><dd>${esc(stt)}</dd><dt>Started</dt><dd>${esc(s.created_at.slice(0, 16).replace('T', ' '))}</dd>
      <dt>AWB</dt><dd>${s.awb ? `<span class="awb">${esc(s.awb)}</span> (${esc(s.awb_source)})` : 'attached when the new label is scanned'}</dd></dl>
      <label class="field">Order no. <span class="hint">Optional. Filled in when the label's order barcode is read.</span>
      <input type="text" id="oref" value="${esc(s.order_ref)}" placeholder="TFC-001513299" autocomplete="off" ${s.cancelled_at ? 'disabled' : ''}></label></div>
    ${main}
    <h2>Boxes</h2>${boxes.map(boxCard).join('')}
    ${!s.booked_at && !s.cancelled_at ? `<div class="row"><button id="add">+ Add another box to this order</button>${multi ? `<button id="remove">Remove box ${boxes.length}</button>` : ''}</div>` : ''}
    ${!s.completed_at && !s.cancelled_at ? '<button class="danger wide" id="cancel" style="margin-top:22px">Cancel this record</button>' : ''}
  </main>`);
  const nextBtn = $('#next');
  if (nextBtn) nextBtn.onclick = () => {
    if (nx.screen === 'measure') go(`#/m/${encodeURIComponent(nx.box.id)}`);
    else if (nx.screen === 'book') go(`#/book/${encodeURIComponent(sid)}`);
    else go(`#/cap/${encodeURIComponent(sid)}/${nx.box ? encodeURIComponent(nx.box.id) : 'all'}/${nx.kind}`);
  };
  for (const btn of document.querySelectorAll('[data-edit]')) btn.onclick = () => go(`#/m/${encodeURIComponent(btn.dataset.edit)}`);
  const oref = $('#oref');
  if (oref) oref.onchange = async () => { s.order_ref = oref.value.trim().toUpperCase(); await db.put('shipments', s); await rowsChanged(s, boxes); toast('Order no. saved'); };
  const add = $('#add');
  if (add) add.onclick = async () => { const b = await R.addBox(s); go(`#/m/${encodeURIComponent(b.id)}`); };
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

async function screenMeasure(boxId, step) {
  const b = await db.get('boxes', boxId);
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
      <button class="big primary" id="tobook">All boxes measured: numbers to book</button>
      <button class="wide" id="another" style="margin-top:10px">+ Another box in this order</button>
      <button class="wide" id="redo" style="margin-top:10px">Edit these readings</button>`;
  }
  view(`${bar(head, `#/s/${encodeURIComponent(s.id)}`)}<main><div class="step">Step ${stepNo} of 5 · ${head}</div>${body}
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
    const open = all.find((x) => !R.readingsDone(x));
    if (open) { toast(`Box ${open.n} still needs its readings`, 'bad'); return go(`#/m/${encodeURIComponent(open.id)}`); }
    go(`#/book/${encodeURIComponent(s.id)}`);
  };
  const an = $('#another');
  if (an) an.onclick = async () => { const nb = await R.addBox(s); go(`#/m/${encodeURIComponent(nb.id)}`); };
  const redo = $('#redo');
  if (redo) redo.onclick = () => goStep('weigh');
}

// ---------------------------------------------------------------- numbers to book (SOP step 6)
async function screenBook(sid) {
  const d = await R.load(sid);
  if (!d) return go('#/');
  const { s, boxes } = d, multi = boxes.length > 1;
  const open = boxes.find((b) => !R.readingsDone(b));
  if (open) return go(`#/m/${encodeURIComponent(open.id)}`);
  if (s.booked_at) return go(`#/s/${encodeURIComponent(sid)}`);
  view(`${bar('Numbers to book', `#/s/${encodeURIComponent(sid)}`)}<main>
    <div class="instr"><b>Book with exactly these numbers.</b> Each side is rounded up to the next whole cm and the weight to the next 0.1 kg.${multi ? ' Book once, with each box\'s own numbers.' : ''}</div>
    ${boxes.map((b) => `<div class="card">${multi ? `<h3>Box ${b.n} of ${boxes.length}</h3>` : ''}${bookGrid(b)}<div class="small muted">${measuredLine(b)}</div></div>`).join('')}
    <div class="card warn">Print the label and stick it <b>centred on the top face</b>, with the box still in the bay. Do not edit the booking after the label prints.</div>
    <button class="big go" id="booked">Booked - the label is on the box</button>
    <button class="wide" id="edit" style="margin-top:10px">Edit readings</button>
  </main>`);
  $('#booked').onclick = async () => {
    await R.markBooked(s);
    await rowsChanged(s, boxes);
    go(`#/cap/${encodeURIComponent(sid)}/${encodeURIComponent(boxes[0].id)}/label`);
  };
  $('#edit').onclick = () => go(`#/s/${encodeURIComponent(sid)}`);
}

// ---------------------------------------------------------------- photos (SOP steps 7-9)
async function screenCapture(sid, bid, kind) {
  const d = await R.load(sid);
  if (!d) return go('#/');
  let { s, boxes, byId } = d;
  if (!KIND_INFO[kind]) return go(`#/s/${encodeURIComponent(sid)}`);
  if (s.cancelled_at) return go(`#/s/${encodeURIComponent(sid)}`);
  if (!s.booked_at) return go(`#/book/${encodeURIComponent(sid)}`);
  const multi = boxes.length > 1;
  let b = bid === 'all' ? null : boxes.find((x) => x.id === bid) || null;
  if (kind !== 'boxes' && !b) return go(`#/s/${encodeURIComponent(sid)}`);
  if (kind !== 'label' && !s.awb) return go(`#/cap/${encodeURIComponent(sid)}/${encodeURIComponent(boxes[0].id)}/label`);
  if (kind !== 'label' && kind !== 'boxes' && !b.photos.label.length) return go(`#/cap/${encodeURIComponent(sid)}/${encodeURIComponent(b.id)}/label`);

  const st = app.settings, lv = st.levels, info = KIND_INFO[kind];
  // Multi-box: the team taps the box number printed on the label (Box x/y) before each label photo.
  let picked = !(multi && kind === 'label');
  view(`<div class="cam"><div class="stage"><video playsinline muted></video><canvas class="ov"></canvas>
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
  let chooser = false, lastSharp = 0, lastSteady = 0, started = performance.now(), scanFrom = 0, warnedAt = 0;

  const expected = () => (b && b.label ? b.label.code : s.awb);
  function header() {
    const step = kind === 'boxes' ? '' : `Step ${BOX_KINDS.indexOf(kind) + 1}/4 · `;
    $('#ttl').textContent = `${multi && b && picked ? `Box ${b.n}/${boxes.length} · ` : ''}${step}Photo ${info.photo}: ${info.title}`;
    $('#awbline').innerHTML = s.awb
      ? `AWB <span class="awb">${esc(fmtAwb(s.awb))}</span>${b && b.label && b.label.child ? ` · box label <span class="awb">${esc(b.label.code)}</span>` : ''}${b && b.label && b.label.typed ? ' · typed' : ''}`
      : 'Scan the new label: the AWB attaches to this record';
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
    if (kind === 'label') rec.innerHTML = bk && picked ? `Booked: ${bk.length} × ${bk.breadth} × ${bk.height} cm, ${bk.weight} kg - the label should show these.` : '';
    else if (kind === 'breadth') rec.innerHTML = `Recorded breadth <b>${esc(r.breadth)} cm</b> (booked ${bk.breadth}). If the fence now reads differently, measure again.`;
    else if (kind === 'length-height') rec.innerHTML = `Recorded length <b>${esc(r.length)} cm</b> (booked ${bk.length}) · height <b>${esc(r.height)} cm</b> (booked ${bk.height}).`;
    else if (kind === 'scale') rec.innerHTML = `Recorded weight <b>${esc(r.weight)} kg</b> (booked ${bk.weight}).`;
    else rec.innerHTML = `${boxes.length} boxes in this order.`;
    actions();
  }

  function actions() {
    const acts = $('#acts'), btns = [];
    if (['breadth', 'length-height', 'scale'].includes(kind)) btns.push('<button id="differs">Reading differs?</button>');
    if (kind === 'label' && picked && showType && !typed) btns.push('<button id="typeawb">Type the AWB</button>');
    if (kind === 'label' && s.awb && !Object.keys(byId).length) btns.push('<button id="wrongawb">Wrong AWB? Rescan</button>');
    if (showTake) btns.push('<button id="take">Take anyway</button>');
    acts.innerHTML = btns.join('');
    const on = (id, fn) => { const e = $('#' + id); if (e) e.onclick = fn; };
    on('differs', remeasure);
    on('typeawb', typeAwb);
    on('wrongawb', async () => {
      try { await R.clearAwb(s, byId); for (const x of boxes) if (x.label) { x.label = null; await db.put('boxes', x); } typed = false; hist = []; header(); toast('AWB cleared - scan the label again'); }
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
      if (String(nb[f]) !== String(b.book[f])) changedBooking = true;
    }
    await rowsChanged(s, [b]);
    if (!changedBooking) { toast('Re-measure saved; the booked numbers still hold'); return; }
    const act = await modal(`<h3>The booking no longer matches</h3><p>The new reading rounds to a different number than the one booked. The SOP says: peel off the label and redo the box from step 1 with a new record.</p>
      <div class="row"><button id="keep">Keep going (both readings recorded)</button><button class="danger" id="redo">Cancel this record</button></div>`,
    (m, close) => { $('#keep', m).onclick = () => close('keep'); $('#redo', m).onclick = () => close('redo'); });
    if (act === 'redo') { await R.cancelShipment(s, 're-measure changed the booking'); await rowsChanged(s, boxes); go('#/'); }
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

  async function frame() {
    if (busy || !video.videoWidth || !review.classList.contains('hidden')) return;
    const vw = video.videoWidth, vh = video.videoHeight, now = performance.now();
    const zone = glareZone(kind, st.calib, vw / vh);
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
    drawOverlay(octx, sizeOverlay(), kind, st.calib, { barcodes: kind === 'label' ? lastBars : [], spot: m.spot, ready: preReady });
    const waited = (now - started) / 1000;
    const wantTake = waited > lv.forceAfterS && picked && !chooser && awbOk;
    const wantType = kind === 'label' && picked && waited > 15 && !typed && !(b && b.label) && now - lastGood > 3000;
    if (wantTake !== showTake || wantType !== showType) { showTake = wantTake; showType = wantType; actions(); }
    if (ready) await capture(m.sharp, steadyMs, false);
  }

  async function capture(trigger, steadyMs, forced) {
    if (busy) return;
    busy = true;
    busyEl.textContent = 'Taking photo...'; busyEl.classList.remove('hidden');
    const when = new Date(), id = uuid();
    try {
      const shot = await app.camera.takePhoto();
      if (!run.alive) return;
      busyEl.textContent = 'Checking the photo...';
      const vw = video.videoWidth, vh = video.videoHeight, zone = glareZone(kind, st.calib, vw / vh);
      const job = stillJob({
        blob: shot.blob, zone, spotShare: lv.glareSpot,
        maxLong: MAX_LONG_SIDE, maxBytes: MAX_JPEG_BYTES, minQuality: MIN_QUALITY, probeLong: kind === 'label' ? 1800 : 0,
        exif: {
          make: st.phoneMake, model: st.phoneModel, software: `TFC Packing Proof ${APP_VERSION}`, dateMs: when.getTime(), uniqueId: id,
          description: `TFC packing proof | AWB ${s.awb} | ${b ? `box ${b.n} of ${boxes.length}` : `${boxes.length} boxes`} | ${kind}`,
        },
      });
      const c = await job.checked;
      if (!run.alive) { job.cancel(); return; }
      if (!c.ok) throw new Error(c.error);
      const sj = judge(c.metrics, kind, lv, !!zone), reasons = [...sj.reasons];
      if (trigger && c.metrics.sharp < lv.stillRatio * trigger) reasons.push(`still less sharp than the preview (${Math.round(c.metrics.sharp)} vs ${Math.round(trigger)})`);
      let note = '';
      if (kind === 'label') {
        if (typed) note = 'AWB typed, barcode not read';
        else {
          let seen = false;
          try { const f = await barcode.detect(c.probe, c.probe.width, c.probe.height); seen = readCodes(f).cands.includes(expected()); } catch { seen = false; }
          note = seen ? 'barcode read on the still' : 'barcode NOT read on the still';
          if (!seen) reasons.push('barcode not readable in the photo');
        }
      }
      if (c.probe && c.probe.close) c.probe.close();
      const pass = reasons.length === 0;
      if (!pass && !forced) {
        job.cancel();
        busyEl.classList.add('hidden');
        toast('Not saved: ' + reasons[0] + '. Hold steady - it tries again.', 'bad');
        steadySince = 0; await sleep(700); busy = false;
        return;
      }
      busyEl.classList.add('hidden');
      const rv = showReview(c.preview, pass);
      const res = await job.done;   // the JPEG under 2 MB, with EXIF
      if (!res.ok) throw new Error(res.error);
      const checks = {
        captured_at: isoLocal(when), pass, forced: !!forced && !pass, reasons, level: sj.need, trigger: trigger ? Math.round(trigger) : null,
        steady_ms: Math.round(steadyMs), still: c.metrics, barcode: note, size: `${res.width}x${res.height}`, quality: res.quality,
        bytes: res.bytes, via: shot.via, src: `${c.src.w}x${c.src.h}`, encodes: res.encodes, ms: res.ms,
        engine: kind === 'label' ? barcode.engine : undefined, camera: app.camInfo ? app.camInfo.label : '',
      };
      const p = await R.addPhoto(s, b, kind, { id, blob: res.jpeg, width: res.width, height: res.height, quality: res.quality, captured_at: checks.captured_at, checks }, byId);
      app.uploader.kick();
      beep();
      showTake = false; actions();   // e.g. "Wrong AWB?" is gone once a photo is saved
      rv.saved(p, checks);
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
        $('#rvok').textContent = `${checks.pass ? 'Saved ✓' : 'Saved - taken anyway'} · ${p.name}`;
        $('#rvline').textContent = checksLine(checks);
        const nb = $('#nextp'), rb = $('#retake');
        nb.disabled = false; rb.disabled = false;
        let n = 4;
        nb.textContent = `Next (${n})`;
        timer = setInterval(() => { n -= 1; nb.textContent = `Next (${n})`; if (n <= 0) next(); }, 1000);
        rb.onclick = () => {
          done(); review.classList.add('hidden'); review.innerHTML = '';
          steadySince = 0; peaks = []; started = performance.now(); showTake = false; actions(); busy = false;
          toast('Retake: the new photo is saved as the next number and marked final');
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
  const { s, boxes } = d;
  view(`${bar('Done')}<main>
    <div class="card go"><h3>All photos taken ✓</h3><p>Take the phone off the mount and hand the box over.</p></div>
    <div class="card"><dl class="kv"><dt>AWB</dt><dd><span class="awb">${esc(s.awb)}</span></dd><dt>Boxes</dt><dd>${boxes.length}</dd>
      <dt>Uploaded</dt><dd id="sent">...</dd></dl></div>
    <button class="big primary" id="new">New box</button>
    <button class="wide" id="home" style="margin-top:10px">Home</button></main>`);
  $('#new').onclick = async () => { const { b } = await R.createShipment(app.settings); go(`#/m/${encodeURIComponent(b.id)}`); };
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
    <label class="field">Camera <span class="hint">The main rear camera (50 MP). Names appear after the first photo screen allows the camera.</span>
      <select id="cam"><option value="">Automatic (rear camera)</option>${cams.map((c) => `<option value="${esc(c.id)}" ${c.id === st.cameraId ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select></label>
    <div class="row"><label class="field">Phone make<input type="text" id="make" value="${esc(st.phoneMake)}" placeholder="e.g. Samsung"></label>
      <label class="field">Phone model<input type="text" id="model" value="${esc(st.phoneModel)}" placeholder="e.g. SM-A356E"></label></div>
    <div class="row"><button id="calbay">Calibrate bay mount</button><button id="calscale">Calibrate scale mount</button></div>
    <p class="small muted">Calibrated: bay ${st.calib.bay ? '✓' : 'no'} · scale ${st.calib.scale ? '✓' : 'no'}. The calibration screen also shows the live sharpness and light numbers.</p>
    <details><summary>Check levels (advanced)</summary>
      <p class="small muted">Sharpness is the frame-trial score (edge variance on a 540x960 grey copy). Set each level a little below what a good photo scores at the station.</p>
      <div class="row">${['label', 'breadth', 'length-height', 'scale', 'boxes'].map(lvl).join('')}</div>
      <div class="row"><label class="field">Steady (ms)<input type="number" id="steadyMs" value="${lv.steadyMs}" step="100"></label>
        <label class="field">Dark below<input type="number" id="brightMin" value="${lv.brightMin}"></label>
        <label class="field">Bright above<input type="number" id="brightMax" value="${lv.brightMax}"></label></div>
      <div class="row"><label class="field">Glare allowed (%)<input type="number" id="glare" value="${(lv.glareFrame * 100).toFixed(1)}" step="0.5"></label>
        <label class="field">"Take anyway" after (s)<input type="number" id="force" value="${lv.forceAfterS}"></label></div>
      <button class="wide" id="resetlv">Reset levels</button>
    </details>
    <label class="check"><input type="checkbox" id="demo" ${st.demo ? 'checked' : ''}><span>Demo camera <span class="small muted">(computer testing only; forces TEST mode)</span></span></label>
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
      test: $('#testmode').checked || $('#demo').checked, demo: $('#demo').checked, cameraId: $('#cam').value,
      phoneMake: $('#make').value.trim(), phoneModel: $('#model').value.trim(),
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
      if (r.ok) out.innerHTML = `<div class="card go"><b>Connected.</b> This page can read the script's reply, and the key was accepted. Script v${esc(r.version)}.<br>` +
        `Drive: <a href="${esc(r.root && r.root.url)}" target="_blank" rel="noopener">${esc(r.root && r.root.name)}</a> · Sheet: <a href="${esc(r.sheet && r.sheet.url)}" target="_blank" rel="noopener">open</a></div>`;
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
      if (!app.settings.setupDone) {
        // ?demo=1: the drawn demo camera, whose bay and scale match the default outlines. Without it (a phone test),
        // the real camera is used and the mounts are calibrated by hand.
        const demo = qs.has('demo') && qs.get('demo') !== '0', aspect = 1280 / 720;
        await saveSettings({
          scriptUrl: 'http://localhost/demo-backend', key: h.state.key, station: 'Demo station', test: true, demo, setupDone: true,
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
    if (r === 'cap' || r === 'calib') render();
    app.uploader.kick();
  });
  window.addEventListener('hashchange', render);
  setInterval(() => app.uploader.kick(), 30000);
  prune().catch(() => {});
  registerSW();
  await render();
  app.uploader.kick();
}

boot();
