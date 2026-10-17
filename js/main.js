// TFC Packing Proof v2 - the station app, built for factory staff (design note 2026-10-17, sketches S1-S15).
// One button on the home screen: a photo of the paper on the parcel. That first photo picks the stage, on positive
// evidence only (logic.js pickStage):
//   MEASURE (blue, before booking): slip -> weight -> length -> breadth -> height per box; "Next box of THIS order".
//            The phone only checks the slip's order number (a hint and a blur catcher); the numbers are read in the
//            office later.
//   PROOF (green, after booking): the label's AWB looks up the booking (order number, boxes, box AWBs); per box the
//            label (with the label-slip check: beep, or STOP and buzz; keep aside after 2 fails) -> weight ->
//            length -> breadth -> height; then all boxes in one photo for a multi-box order.
// Photos are taken with the phone's own camera app at full resolution, checked when they come back (sharp, light),
// saved on the phone first and uploaded from a queue. Nothing blocks the line: after 2 failed tries "Use this photo"
// appears and the Sheet row is flagged. Anything risky sits behind the supervisor PIN.
import { APP_VERSION, DEFAULT_SCRIPT_URL, DEFAULT_LEVELS, READ_MAX_BYTES, MIN_QUALITY, MEASURE_KINDS, PROOF_KINDS, DEMO_AWB, DEMO_ORDER, TEST_SITE, TEST_BACKEND } from './config.js';
import * as db from './store.js';
import * as R from './records.js';
import { readCodes, normCode, normOrder, AWB_OK, isoLocal, istDay, uuid, checksLine, pickStage, labelZone, slipCheck } from './logic.js';
import { judge } from './quality.js';
import * as barcode from './barcode.js';
import * as ocr from './ocr.js';
import * as sound from './sound.js';
import { t } from './strings.js';
import { D, I, BLURRED } from './drawings.js';
import { DemoCamera } from './demo.js';
import { Uploader, transport, sha256Hex } from './uploader.js';

const app = { settings: null, uploader: null, q: { pending: 0 }, harness: null, supUntil: 0, pending: null, firstFails: 0, busy: false, cleanup: null, last: {} };
window.ppApp = app;   // for diagnostics and tests

// ---------------------------------------------------------------- small helpers
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const view = (html) => { $('#app').innerHTML = html; window.scrollTo(0, 0); };
const go = (hash) => { if (location.hash === hash) render(); else location.hash = hash; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;
const hh = (key, vars) => esc(t(key, vars).hi);
const ee = (key, vars) => esc(t(key, vars).en);
const KIND_STEP = { slip: 'step_slip', label: 'step_label', scale: 'step_scale', length: 'step_length', breadth: 'step_breadth', height: 'step_height', boxes: 'step_boxes' };
const stepWord = (kind) => t(KIND_STEP[kind] || 'step_boxes');

let toastT = 0;
function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg; el.className = 'show ' + kind;
  clearTimeout(toastT); toastT = setTimeout(() => { el.className = ''; }, 4200);
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
function askText(title, hint, { placeholder = '', mode = 'text', check = (v) => (v ? '' : 'Required') } = {}) {
  return modal(`<h3>${esc(title)}</h3><p class="small muted">${esc(hint)}</p><input type="text" id="mt" inputmode="${mode}" autocomplete="off" placeholder="${esc(placeholder)}">
    <div class="err" id="me"></div><div class="row"><button id="no">Back</button><button class="primary" id="yes">OK</button></div>`,
  (m, close) => {
    setTimeout(() => $('#mt', m).focus(), 50);
    $('#no', m).onclick = () => close(null);
    $('#yes', m).onclick = () => { const v = $('#mt', m).value.trim(), e = check(v); if (e) { $('#me', m).textContent = e; return; } close(v); };
  });
}
function busy(key = 'checking') {
  const el = document.createElement('div');
  el.className = 'busy'; el.id = 'busyov';
  el.innerHTML = `<div class="spin"></div><div>${hh(key)}</div><div class="en" lang="en" style="font-size:16px;font-weight:400">${ee(key)}</div>`;
  document.body.appendChild(el);
  return () => el.remove();
}

// ---------------------------------------------------------------- settings
const DEFAULTS = {
  scriptUrl: DEFAULT_SCRIPT_URL, key: '', station: 'Station 1', test: true, demo: false, phoneMake: '', phoneModel: '',
  levels: DEFAULT_LEVELS, setupDone: false, pinHash: '', pinSalt: '', demoScene: {},
  lock: '',   // stage lock: off by default (one phone for now, owner 17 Oct); the supervisor can lock it for two stations
};
const HARNESS_URL = 'http://localhost/demo-backend';   // the in-browser test backend's stand-in address
const mergeLevels = (l = {}) => ({ ...DEFAULT_LEVELS, ...l, sharp: { ...DEFAULT_LEVELS.sharp, ...(l.sharp || {}) } });

async function loadSettings() {
  const s = await db.getKV('settings', {});
  const out = { ...DEFAULTS, ...s, levels: mergeLevels(s.levels) };
  if (!out.scriptUrl || (out.scriptUrl === HARNESS_URL && DEFAULT_SCRIPT_URL && !TEST_SITE)) out.scriptUrl = DEFAULT_SCRIPT_URL;
  return out;
}
async function saveSettings(patch) {
  app.settings = { ...app.settings, ...patch };
  await db.setKV('settings', app.settings);
}
// The PIN as a salted hash (the salt is random per phone); only this pair is kept, in the phone's settings.
const pinHash = (pin, salt) => sha256Hex(new Blob([`tfc-pp-pin|${salt || ''}|${pin}`]));
const normKey = (k) => String(k || '').toLowerCase().replace(/[^a-z0-9]/g, '');   // as the backend compares station keys

// ---------------------------------------------------------------- still worker (checks + the JPEG, off the main thread)
let worker = null, wseq = 0;
const wjobs = new Map();
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

// ---------------------------------------------------------------- the camera app (and the computer demo)
// The photo is taken with the phone's own camera app (full resolution, its own focus) and comes back as a file.
let pickAt = 0, pickCb = null;
function openCamera(cb, demoScene) {
  pickCb = cb;
  if (app.settings.demo) {
    const cam = new DemoCamera();
    cam.setScene(demoScene || {});
    cam.takePhoto().then((r) => { const f = new File([r.blob], 'demo.jpg', { type: 'image/jpeg', lastModified: Date.now() }); gotFile(f, 'demo camera'); });
    return;
  }
  const inp = $('#fcam');
  inp.value = '';
  pickAt = Date.now();
  inp.click();
}
function gotFile(file, via) {
  pickAt = 0;
  const cb = pickCb;
  pickCb = null;
  if (!file || !cb) return;
  const when = file.lastModified && file.lastModified <= Date.now() + 60000 ? new Date(file.lastModified) : new Date();
  cb({ blob: file, via, when: new Date(), agoMin: Math.max(0, Math.round((Date.now() - when.getTime()) / 60000)) });
}

// The demo camera's picture for this step (computer testing; Supervisor > Settings > Demo camera, or ?demo=1).
// "wrong slip": the slip shows another order than the one the label (and the booking) is for.
function demoFor(kind, s, b) {
  const d = app.settings.demoScene || {};
  const order = d.order || DEMO_ORDER, proof = s ? R.stageOf(s) === 'proof' : d.paper === 'label';
  const code = s && s.awb ? (b && b.box_awb) || s.awb : d.awb || DEMO_AWB;
  const boxes = s ? s.boxes.length : 1;
  return {
    kind, paper: d.paper || 'slip', order: proof && d.wrong ? 'TFC-001599992' : order, labelOrder: order, code, code2: code, label: proof,
    blur: d.blur ? 8 : 0, boxText: boxes > 1 && b ? `Box ${b.n}/${boxes}` : '', smudge: !!d.smudge,
  };
}

// ---------------------------------------------------------------- the checks on one photo
// -> {job, c, reasons, codes (label photos), zone}. `kind` picks the sharpness level.
async function checkPhoto(shot, kind, { probe = false } = {}) {
  const lv = app.settings.levels;
  const job = stillJob({
    blob: shot.blob, zone: null, spotShare: lv.glareSpot, previewAspect: null,
    maxLong: 20000, maxBytes: READ_MAX_BYTES, minQuality: MIN_QUALITY, keepOriginal: READ_MAX_BYTES, probeLong: probe ? 2400 : 0,
    exif: { make: app.settings.phoneMake, model: app.settings.phoneModel, software: `TFC Packing Proof ${APP_VERSION}`, dateMs: shot.when.getTime(), uniqueId: uuid(), description: `TFC packing proof | ${kind}` },
  });
  const c = await job.checked;
  if (!c.ok) throw new Error(c.error || 'the photo could not be read');
  const sj = judge(c.metrics, kind, lv, false);
  const reasons = sj.reasons.map((r) => (r.startsWith('blurred') ? 'blurry' : r === 'too dark' ? 'dark' : r === 'too bright' ? 'glare' : 'blurry'));
  if (shot.agoMin > lv.oldPhotoMin) reasons.push('old');
  let found = [];
  if (probe && c.probe) {
    try { found = await barcode.detect(c.probe, c.probe.width, c.probe.height); } catch { found = []; }
  }
  if (c.probe && c.probe.close) c.probe.close();
  return { job, c, sj, reasons: [...new Set(reasons)], found, rc: readCodes(found), zone: labelZone(found) };
}

function checksOf(shot, chk, res, extra = {}) {
  return {
    captured_at: isoLocal(shot.when), pass: chk.reasons.length === 0, forced: chk.reasons.length > 0, tries: extra.tries, reasons: chk.reasons,
    level: chk.sj.need, still: chk.c.metrics, size: `${res.width}x${res.height}`, quality: res.quality, bytes: res.bytes, via: shot.via,
    src: `${chk.c.src.w}x${chk.c.src.h}`, taken_ago_min: shot.agoMin || undefined, ...extra,
  };
}

async function savePhoto(s, b, kind, shot, chk, extra = {}) {
  const res = await chk.job.done;
  if (!res.ok) throw new Error(res.error || 'the photo could not be saved');
  const d = await R.load(s.id);
  const box = b ? d.boxes.find((x) => x.id === b.id) : null;
  const checks = checksOf(shot, chk, res, extra);
  const p = await R.addPhoto(d.s, box, kind, { id: uuid(), blob: res.jpeg, width: res.width, height: res.height, quality: res.quality, captured_at: checks.captured_at, checks }, d.byId);
  Object.assign(s, d.s);
  if (b && box) Object.assign(b, box);
  app.uploader.kick();
  return { p, preview: chk.c.preview };
}

// ---------------------------------------------------------------- backend calls
function base(test) {
  const st = app.settings;
  return { v: 1, key: st.key, station: st.station, app: APP_VERSION, phone: st.phoneModel || '', test: test ?? !!st.test };
}
// The Pre-booking lookup: {ok, ...} or null when there is no internet / no answer (then nothing is decided from it).
async function lookup(q) {
  const st = app.settings;
  if (!st.scriptUrl || !st.key || !navigator.onLine || app.offline) return null;   // app.offline: tests only
  try {
    const r = await transport.post(st.scriptUrl, { ...base(), action: 'lookup', ...q }, 15000);
    return r && r.ok ? r : null;
  } catch { return null; }
}
async function rowsChanged(s, boxes) { await R.queueRows(s, boxes); app.uploader.kick(); }
async function rowsOf(s) { const d = await R.load(s.id); if (d) await rowsChanged(d.s, d.boxes); }

async function addLog(entry) {
  const st = app.settings;
  const e = { id: uuid(), at: isoLocal(), day: istDay(), station: st.station, test: st.test, phone: st.phoneModel, ...entry };
  await db.put('logs', e);
  await db.enqueue({ type: 'log', log_id: e.id });
  app.uploader.kick();
  return e;
}

// ---------------------------------------------------------------- shared screen parts
function bandHtml(stage, sideA = '', sideB = '', flat = false) {
  const w = t(stage === 'measure' ? 'measure_word' : stage === 'proof' ? 'proof_word' : 'first_word');
  const n = stage === 'measure' ? '1' : stage === 'proof' ? '2' : '?';
  return `<header class="band ${stage}${flat ? ' flat' : ''}"><div class="left"><div class="num">${n}</div><div><div class="word">${esc(w.hi)}${app.settings.test ? `<span class="testtag">${hh('test_mode')}</span>` : ''}</div>` +
    `<div class="sub" lang="en">${esc(w.en)}</div></div></div><div class="side"><div class="a">${esc(sideA)}</div><div class="b" lang="en">${esc(sideB)}</div></div></header>`;
}
function boxSide(s, b) {
  if (!b) return ['', ''];
  const k = t(s.boxes.length > 1 && R.stageOf(s) === 'proof' ? 'box_n_of' : 'box_n', { n: b.n, m: s.boxes.length });
  return [k.hi, k.en];
}
function dotsHtml(s, b, now) {
  const kinds = R.kindsOf(s), stage = R.stageOf(s);
  return `<ol class="dots ${stage}" aria-label="Photos for this box">${kinds.map((k) => {
    const done = b && b.photos[k] && b.photos[k].length, cls = k === now ? 'now' : done ? 'done' : '';
    return `<li class="${cls}" aria-label="${esc(stepWord(k).en)}${k === now ? ', now' : done ? ', done' : ''}">${I[k](k === now ? 26 : 22)}</li>`;
  }).join('')}</ol>`;
}
function bigBtn(id, key, stage, icon = I.camera(46), vars) {
  return `<button class="bigbtn ${stage}" id="${id}">${icon}<span class="tx"><span class="a">${hh(key, vars)}</span><span class="b" lang="en">${ee(key, vars)}</span></span></button>`;
}
function stepsHtml(keys) {
  return `<ul class="steps">${keys.map((k, i) => `<li><span class="n">${i + 1}</span><span><span class="h">${hh(k)}</span><span class="e" lang="en">${ee(k)}</span></span></li>`).join('')}</ul>`;
}
function demoBar() {
  if (!app.settings.demo) return '';
  const d = app.settings.demoScene || {};
  return `<div class="demo-bar" lang="en"><b>Demo camera:</b>
    <select id="dpaper">${[['slip', 'slip only'], ['label', 'label + slip'], ['product', 'product barcode'], ['smudged', 'unreadable label'], ['blank', 'bare parcel']].map(([v, l]) => `<option value="${v}" ${d.paper === v || (!d.paper && v === 'slip') ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <label>slip <input id="dorder" value="${esc(d.order || DEMO_ORDER)}" size="13"></label>
    <label>label AWB <input id="dawb" value="${esc(d.awb || DEMO_AWB)}" size="14"></label>
    <label><input type="checkbox" id="dwrong" ${d.wrong ? 'checked' : ''}> wrong slip</label>
    <label><input type="checkbox" id="dblur" ${d.blur ? 'checked' : ''}> blurred</label>
    <label><input type="checkbox" id="dsmudge" ${d.smudge ? 'checked' : ''}> label barcode unreadable</label></div>`;
}
function wireDemoBar() {
  if (!app.settings.demo) return;
  const upd = () => saveSettings({ demoScene: { paper: $('#dpaper').value, order: normOrder($('#dorder').value) || DEMO_ORDER, awb: normCode($('#dawb').value) || DEMO_AWB,
    wrong: $('#dwrong').checked, blur: $('#dblur').checked, smudge: $('#dsmudge').checked } });
  for (const id of ['#dpaper', '#dorder', '#dawb', '#dwrong', '#dblur', '#dsmudge']) $(id).onchange = upd;
}

// ---------------------------------------------------------------- router
function parts() { return location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent); }
let renderWant = 0, renderChain = Promise.resolve();
function render() {
  const my = ++renderWant;
  renderChain = renderChain.then(() => (my === renderWant ? doRender() : undefined)).catch((e) => console.error(e));
  return renderChain;
}
const supOk = () => Date.now() < app.supUntil;
async function doRender() {
  const [r, a, b, c] = parts();
  if (app.cleanup) { try { app.cleanup(); } catch { /* ignore */ } app.cleanup = null; }
  $('#modal').classList.add('hidden');
  try {
    if (!app.settings.setupDone && r !== 'settings') return go('#/settings');
    switch (r) {
      case 'ask': return screenAsk();
      case 'step': return await screenStep(a, b, c);
      case 'boxdone': return await screenBoxDone(a);
      case 'done': return await screenDone(a);
      case 'aside': return await screenAside(a);
      case 'redo': return await screenRedo(a, b);
      case 'sup': return supOk() ? await screenSup() : screenPin('#/sup');
      case 'settings': return !app.settings.setupDone || supOk() ? await screenSettings() : screenPin('#/settings');
      case 'queue': return supOk() ? await screenQueue() : screenPin('#/queue');
      case 'demo': return supOk() ? await screenDemo() : screenPin('#/demo');
      default: return await screenHome();
    }
  } catch (e) {
    console.error(e);
    view(`<div class="bar"><h1>Problem</h1></div><div class="adm"><div class="card bad"><h3>Something went wrong</h3><p>${esc(e.message)}</p></div><button class="wide" onclick="location.hash='#/'">Home</button></div>`);
  }
}

// ---------------------------------------------------------------- S1 home
async function openRecords() {
  const today = istDay();
  const ships = (await db.all('shipments')).filter((s) => !s.cancelled_at && !s.completed_at && istDay(new Date(s.created_at)) === today);
  const out = [];
  for (const s of ships.sort((a, b) => b.created_at.localeCompare(a.created_at))) {
    const d = await R.load(s.id);
    if (d) out.push({ s: d.s, boxes: d.boxes, nx: R.nextStep(d.s, d.boxes) });
  }
  return out;
}
async function screenHome() {
  const st = app.settings, recs = await openRecords();
  const open = recs.filter((x) => R.isOpen(x.s) && x.nx.screen === 'step'), aside = recs.filter((x) => x.s.kept_aside);
  const pending = app.q.pending || 0, w = pending ? t('waiting', { n: pending }) : t('all_sent');
  const lockW = st.lock ? t('lock_on', { step: t(st.lock === 'measure' ? 'measure_chip' : 'proof_chip').hi }) : null;
  view(`<div class="scr">
    <header class="home-head"><div><div class="t">${hh('app_name')}${st.test ? `<span class="testtag">${hh('test_mode')}</span>` : ''}</div><div class="s" lang="en">${ee('app_name')} · ${esc(st.station)}</div></div>
      <button class="iconbtn" id="sup" aria-label="Supervisor">${I.lock(22)}</button></header>
    ${demoBar()}
    ${TEST_SITE ? `<div class="demo-bar" lang="en">TEST SITE: photos and Sheet rows stay on this device. Nothing is sent to Google.${app.heldReal ? ` ${app.heldReal} uploads for the real backend are kept aside on this phone; they are sent when the real app is back.` : ''}</div>` : ''}
    <main style="justify-content:center;gap:18px;padding:20px 22px">
      ${lockW ? `<div class="note ${st.lock === 'measure' ? '' : 'proof'}"><div><div class="h">${esc(lockW.hi)}</div><div class="e" lang="en">${esc(t('lock_on', { step: t(st.lock === 'measure' ? 'measure_chip' : 'proof_chip').en }).en)}</div></div></div>` : ''}
      ${D.home()}
      <div><h1 class="ttl" style="font-size:31px;line-height:1.2">${hh('home_title')}</h1><div class="ttl-en" lang="en" style="font-size:17px">${ee('home_title')}</div></div>
      <div class="note">${I.info(24)}<div><div class="h">${hh('home_info')}</div><div class="e" lang="en">${ee('home_info')}</div></div></div>
      ${open.length ? `<div class="cards">${open.map((x) => { const u = t('unfinished', { step: `${stepWord(x.nx.kind).hi}${x.nx.box ? ' · ' + t('box_n', { n: x.nx.box.n }).hi : ''}` }), ue = t('unfinished', { step: `${stepWord(x.nx.kind).en}${x.nx.box ? ', box ' + x.nx.box.n : ''}` });
        return `<button class="cardbtn" data-go="#/step/${enc(x.s.id)}/${x.nx.box ? enc(x.nx.box.id) : 'all'}/${x.nx.kind}"><span>${R.stageOf(x.s) === 'measure' ? I.slip(24) : I.label(24)}</span><span><span style="display:block;font-size:17px;font-weight:600">${esc(u.hi)}</span><span class="en" lang="en" style="font-size:14px">${esc(ue.en)}</span></span></button>`; }).join('')}</div>` : ''}
      ${aside.length ? `<button class="cardbtn amber" id="asidecard"><span>${I.release(24)}</span><span><span style="display:block;font-size:17px;font-weight:600">${hh('kept_aside_n', { n: aside.length })}</span><span lang="en" style="font-size:14px">${ee('kept_aside_n', { n: aside.length })}</span></span></button>` : ''}
    </main>
    <footer>${bigBtn('take', 'take_photo', 'neutral', I.camera(48))}
      <div class="waitline">${I.cloud(20)}<span id="waitline">${esc(w.hi)} · <span lang="en">${esc(w.en)}</span></span></div></footer></div>`);
  $('#take').style.minHeight = '132px';
  $('#take').onclick = takeFirst;
  $('#sup').onclick = () => go('#/sup');
  const ac = $('#asidecard'); if (ac) ac.onclick = () => go('#/sup');
  for (const el of document.querySelectorAll('[data-go]')) el.onclick = () => go(el.dataset.go);
  wireDemoBar();
}

// ---------------------------------------------------------------- the first photo picks the stage
function takeFirst() {
  if (app.busy) return;
  openCamera((shot) => processFirst(shot, false), { kind: 'first', ...demoFor('first', null, null) });
}

async function processFirst(shot, forced) {
  if (app.busy) return;
  app.busy = true;
  const done = busy('checking');
  try {
    const st = app.settings;
    const chk = await checkPhoto(shot, 'first', { probe: true });
    if (chk.reasons.length && !forced) {
      chk.job.cancel();
      app.firstFails += 1;
      done(); app.busy = false;
      return showRetake({ stage: 'neutral', reasons: chk.reasons, preview: chk.c.preview, fails: app.firstFails,
        again: takeFirst, use: () => processFirst(shot, true) });
    }
    const tries = app.firstFails + 1;
    app.firstFails = 0;
    // 1. a courier barcode whose AWB is booked in the Pre-booking tab (product barcodes never count)
    let booked = '', lk = null, lookupFailed = false;
    for (const code of chk.rc.cands.slice(0, 4)) {
      const r = await lookup({ by: 'awb', awb: code });
      if (!r) { lookupFailed = true; break; }
      if (r.found) { booked = code; lk = r; break; }
    }
    // 2. the order number on the slip (read on the phone; outside the label when there is one)
    const expected = chk.rc.orderRef || (lk && lk.order) || '';
    const outside = (hits) => hits.filter((h) => !(chk.zone && (h.x == null || (chk.zone.axis === 'x' ? h.x >= chk.zone.lo && h.x <= chk.zone.hi : h.y >= chk.zone.lo && h.y <= chk.zone.hi))));
    const o = await ocr.readOrders(shot.blob, {
      until: (hits) => (booked && expected ? slipCheck(expected, hits, chk.zone).result === 'match' : outside(hits).length > 0),
    });
    const slipHits = o.ok ? outside(o.hits) : [];
    const first = { shot, chk, lk, booked, ocr: o, slipOrder: slipHits.length ? slipHits[0].order : '', forced: !!forced && chk.reasons.length > 0, tries };
    const pick = pickStage({ codes: chk.rc.cands, booked, lookupFailed, slipOrder: first.slipOrder, lock: st.lock });
    app.last.pick = pick;
    done(); app.busy = false;
    if (pick.stage === 'booked') { chk.job.cancel(); return showAlreadyBooked(); }
    if (pick.stage === 'ask') { app.pending = first; return go('#/ask'); }
    if (pick.stage === 'measure') return startMeasure(first, st.lock ? 'locked' : 'found');
    return startProof(first, st.lock ? 'locked' : 'found', booked);
  } catch (e) {
    done(); app.busy = false;
    toast('Photo failed: ' + e.message, 'bad');
  }
}

// S2: neither stage could be picked from the photo. Staff match the picture to the parcel.
function screenAsk() {
  const first = app.pending;
  if (!first) return go('#/');
  view(`<div class="scr">
    <header class="askhead"><h1>${hh('ask_title')}</h1><div class="en" lang="en">${ee('ask_title')}</div></header>
    <main style="padding:18px;gap:16px">
      <button class="ask measure" id="no">${D.askNo()}<span class="row2"><span><span class="a" style="display:block">${hh('ask_no')}</span><span class="b" lang="en">${ee('ask_no')}</span></span><span class="chip">${hh('measure_chip')} · <span lang="en">${ee('measure_chip')}</span></span></span></button>
      <button class="ask proof" id="yes">${D.askYes()}<span class="row2"><span><span class="a" style="display:block">${hh('ask_yes')}</span><span class="b" lang="en">${ee('ask_yes')}</span></span><span class="chip">${hh('proof_chip')} · <span lang="en">${ee('proof_chip')}</span></span></span></button>
    </main>
    <footer style="flex-direction:row;align-items:center;gap:10px;font-size:15px;color:var(--muted)">${I.person(22)}<span>${hh('ask_help')} · <span lang="en">${ee('ask_help')}</span></span></footer></div>`);
  $('#no').onclick = () => { app.pending = null; startMeasure(first, 'asked'); };
  $('#yes').onclick = async () => {
    app.pending = null;
    let code = '';
    const cands = first.chk.rc.cands;
    if (cands.length === 1) code = cands[0];
    else if (cands.length > 1) code = await chooseAwb(cands);
    startProof(first, 'asked', code);
  };
}

function chooseAwb(cands) {
  return modal(`<h3>Which one is the AWB?</h3><p class="small muted">The label has more than one number that looks like an AWB.</p>
    ${cands.map((c) => `<button class="wide" data-c="${esc(c)}" style="margin-top:8px"><span class="awb">${esc(c)}</span></button>`).join('')}
    <button class="wide" id="none" style="margin-top:14px">None of these</button>`,
  (m, close) => { for (const x of m.querySelectorAll('[data-c]')) x.onclick = () => close(x.dataset.c); $('#none', m).onclick = () => close(''); });
}

// ---------------------------------------------------------------- MEASURE
async function startMeasure(first, source) {
  app.busy = true;
  const done = busy('checking');
  try {
    // Already booked / already measured (design note section 3), from the order number the phone read.
    let dup = null;
    if (first.slipOrder) {
      const r = await lookup({ by: 'order', order: first.slipOrder, record: '' });
      if (r && r.booked) { first.chk.job.cancel(); done(); app.busy = false; return showAlreadyBooked(); }
      if (r && r.measured.length) dup = r.measured[0];
    }
    await finishOldMeasures();
    const { s, b } = await R.createMeasure(app.settings, { stage_source: source });
    await savePhoto(s, b, 'slip', first.shot, first.chk, { tries: first.tries, ocr: ocrLine(first.ocr) });
    if (first.slipOrder) await keepHint(s, b, first.slipOrder);   // kept even if the parcel is kept aside next
    if (first.forced) await flagBox(b, 'first photo used after 2 failed tries');
    if (source === 'asked') R.flagRecord(s, 'stage chosen by staff (the photo showed no order number or label)');
    if (dup) R.flagRecord(s, `order ${first.slipOrder} was already measured at ${String(dup.taken_at).slice(11, 16)} (record ${dup.record})`);
    await R.saveRecord(s);
    done(); app.busy = false;
    if (dup) return showAlreadyMeasured(s, b, first.slipOrder, dup);
    return afterSlip(s, b, first.ocr, first.slipOrder);
  } catch (e) {
    done(); app.busy = false;
    toast('Photo failed: ' + e.message, 'bad');
  }
}

// A MEASURE record whose boxes are all done is finished when the next parcel starts.
async function finishOldMeasures() {
  for (const s of await db.all('shipments')) {
    if (R.stageOf(s) !== 'measure' || s.completed_at || s.cancelled_at || s.kept_aside) continue;
    const d = await R.load(s.id);
    if (d && d.boxes.every((b) => R.boxDone(d.s, b))) { await R.markComplete(d.s); await rowsChanged(d.s, d.boxes); }
  }
}

const ocrLine = (o) => (!o ? '' : !o.ok ? `order no. reader failed: ${o.error}` : `order no. reader ${o.orders.join(', ') || 'found nothing'} (${o.ms} ms${o.tilt ? `, tilt ${o.tilt}°` : ''})`);

// The order number the phone read on a slip: a hint for the office ("Order no. (phone)").
async function keepHint(s, b, order) {
  const fresh = await R.updateBox(b.id, (x) => { x.slip_read = 'read'; x.order_hint = order; });
  Object.assign(b, fresh);
  if (b.n === 1 && !s.order_hint) { s.order_hint = order; await R.saveRecord(s); }
}

async function flagBox(b, text) {
  const fresh = await R.updateBox(b.id, (x) => { if (!x.flags.includes(text)) x.flags.push(text); });
  Object.assign(b, fresh);
}

// After a slip photo is saved: the order number read (S4), or "slip not readable" (retake; after 2 tries use it).
async function afterSlip(s, b, o, order) {
  if (!o.ok) {
    await R.updateBox(b.id, (x) => { x.slip_read = 'not available'; });
    await rowsOf(s);
    return showNoReader(s, b);
  }
  if (order) {
    const fresh = await R.updateBox(b.id, (x) => { x.slip_read = 'read'; x.order_hint = order; x.fails.slip = 0; });
    Object.assign(b, fresh);
    if (b.n === 1 && !s.order_hint) { s.order_hint = order; await R.saveRecord(s); }
    if (b.n > 1 && s.order_hint && s.order_hint !== order) await flagBox(b, `box ${b.n} slip shows ${order}, box 1 showed ${s.order_hint} (phone read)`);
    await rowsOf(s);
    sound.good();
    return showSlipOk(s, b, order);
  }
  const fresh = await R.updateBox(b.id, (x) => { x.slip_read = 'not read'; x.fails.slip = (x.fails.slip || 0) + 1; });
  Object.assign(b, fresh);
  await rowsOf(s);
  return showRetake({
    stage: 'measure', side: boxSide(s, b), reasons: ['slip'], preview: null, fails: b.fails.slip,
    again: () => go(`#/step/${enc(s.id)}/${enc(b.id)}/slip`),
    use: async () => { await flagBox(b, 'slip order number not read on the phone after 2 tries'); await rowsOf(s); afterPhoto(s.id); },
  });
}

// S4
function showSlipOk(s, b, order) {
  const [a, bb] = boxSide(s, b);
  view(`<div class="scr measure-ink">${bandHtml('measure', a, bb)}${dotsHtml(s, b, 'scale')}
    <main style="justify-content:center;gap:18px;padding:18px">
      <section class="okcard" aria-label="Slip check result"><div class="disc" style="width:84px;height:84px;background:var(--proof);color:#fff">${I.check(48)}</div>
        <div><div style="font-size:28px;font-weight:700;line-height:1.2">${hh('slip_ok')}</div><div lang="en" style="font-size:16px;color:var(--proof-ink)">${ee('slip_ok')}</div></div>
        <div class="ord mono" lang="en" id="order">${esc(order)}</div>
        <div class="sound" style="color:var(--proof-ink)">${I.speaker(20)}<span>${hh('short_beep')} · <span lang="en">${ee('short_beep')}</span></span></div></section>
      <div class="waitline">${I.info(20)}<span>${hh('only_check')} · <span lang="en">${ee('only_check')}</span></span></div>
    </main>
    <footer style="padding-top:0">${nextBtnHtml('measure', nextOf(s, b, 'slip'))}
      <button class="smallbtn measure" id="retake">${hh('retake')} · <span lang="en">${ee('retake')}</span></button></footer></div>`);
  $('#next').onclick = () => afterPhoto(s.id);
  $('#retake').onclick = () => go(`#/step/${enc(s.id)}/${enc(b.id)}/slip`);
}

function showNoReader(s, b) {
  const [a, bb] = boxSide(s, b);
  view(`<div class="scr measure-ink">${bandHtml('measure', a, bb)}${dotsHtml(s, b, 'scale')}
    <main style="justify-content:center;padding:18px"><div class="note amber">${I.info(24)}<div><div class="h">${hh('no_reader')}</div><div class="e" lang="en">${ee('no_reader')}</div></div></div></main>
    <footer>${nextBtnHtml('measure', nextOf(s, b, 'slip'))}</footer></div>`);
  $('#next').onclick = () => afterPhoto(s.id);
}

// The step this box still needs after `after` (the first one in the step order), or '' when it has none left.
function nextOf(s, b, after) { return R.kindsOf(s).find((k) => k !== after && R.needs(b, k)) || ''; }

function nextBtnHtml(stage, kind, cls = '') {
  const w = kind ? stepWord(kind) : null;
  const a = w ? t('next_step', { step: w.hi }).hi : t('next').hi, b = w ? t('next_step', { step: w.en }).en : t('next').en;
  return `<button class="bigbtn ${cls || stage}" id="next"><span class="tx"><span class="a">${esc(a)}</span><span class="b" lang="en">${esc(b)}</span></span>${I.arrow(40)}</button>`;
}

function showAlreadyMeasured(s, b, order, dup) {
  const [a, bb] = boxSide(s, b), time = String(dup.taken_at || '').slice(11, 16) || '?';
  view(`<div class="full amber">${bandHtml('measure', a, bb, true)}
    <main>${D.keepAside()}
      <div><div class="res-a">${hh('already_measured', { time })}</div><div class="res-b" lang="en">${ee('already_measured', { time })}</div></div>
      <div class="pair"><div><span class="k">${hh('slip')} · <span lang="en" style="font-weight:400">${ee('slip')}</span></span><span class="v mono" lang="en">${esc(order)}</span></div></div>
      <div style="font-size:16px">${hh('either_way')} · <span lang="en">${ee('either_way')}</span></div></main>
    <footer><button class="bigbtn neutral" id="aside"><span class="tx"><span class="a">${hh('keep_aside_btn')}</span><span class="b" lang="en">${ee('keep_aside_btn')}</span></span></button>
      <button class="midbtn measure" id="cont"><span class="tx"><span class="a">${hh('continue_btn')}</span><span class="b" lang="en">${ee('continue_btn')}</span></span></button></footer></div>`);
  $('#aside').onclick = async () => { await R.keepAside(s, `order ${order} already measured at ${time}`); await rowsOf(s); showKeepAside(s, 'measure'); };
  $('#cont').onclick = async () => { R.flagRecord(s, 'continued after "already measured"'); await R.saveRecord(s); await afterSlip(s, b, { ok: true }, order); };
}

function showAlreadyBooked() {
  sound.retake();
  view(`<div class="full amber"><main>${D.askYes()}
      <div><div class="res-a">${hh('already_booked')}</div><div class="res-b" lang="en">${ee('already_booked')}</div></div>
      <div style="font-size:22px;font-weight:600">${hh('already_booked_do')}<br><span lang="en" style="font-size:16px;font-weight:400">${ee('already_booked_do')}</span></div></main>
    <footer><button class="bigbtn neutral" id="ok"><span class="tx"><span class="a">${hh('ok')}</span><span class="b" lang="en">${ee('ok')}</span></span></button></footer></div>`);
  $('#ok').onclick = () => go('#/');
}

// S10
async function screenBoxDone(sid) {
  const d = await R.load(sid);
  if (!d) return go('#/');
  const { s, boxes } = d, b = boxes[boxes.length - 1];
  if (R.stageOf(s) !== 'measure') return go('#/');
  const n = R.kindsOf(s).length;
  view(`<div class="scr measure-ink">${bandHtml('measure', ...boxSide(s, b))}${dotsHtml(s, b, '')}
    <main class="center"><div class="disc" style="width:104px;height:104px;background:var(--proof);color:#fff">${I.check(60)}</div>
      <div><div style="font-size:34px;font-weight:700;line-height:1.15">${hh('box_done', { n: b.n })}</div><div lang="en" style="font-size:17px;color:var(--muted)">${ee('box_done', { n: b.n })}</div></div>
      <div class="note" style="flex-direction:column;gap:4px"><div class="h">${hh('sending', { n })}</div><div class="h">${hh('read_office')}</div><div class="e" lang="en">${ee('sending', { n })} · ${ee('read_office')}</div></div></main>
    <footer style="padding-top:0"><button class="midbtn measure" id="nextbox">${I.plusBox(34)}<span class="tx"><span class="a">${hh('next_box')}</span><span class="b" lang="en">${ee('next_box')}</span></span></button>
      <button class="bigbtn measure" id="nextparcel"><span class="tx"><span class="a">${hh('next_parcel')}</span><span class="b" lang="en">${ee('next_parcel')}</span></span>${I.arrow(40)}</button>
      ${redoBtn(s.id, 'measure', location.hash)}</footer></div>`);
  wireRedo();
  $('#nextbox').onclick = async () => {
    const nb = await R.addMeasureBox(s);
    await rowsChanged(s, [...boxes, nb]);
    go(`#/step/${enc(s.id)}/${enc(nb.id)}/slip`);
  };
  $('#nextparcel').onclick = async () => { await R.markComplete(s); await rowsChanged(s, boxes); go('#/'); };
}

// ---------------------------------------------------------------- PROOF
async function startProof(first, source, code) {
  app.busy = true;
  const done = busy('checking');
  try {
    const st = app.settings;
    let lk = first.lk;
    if (code && !lk) lk = await lookup({ by: 'awb', awb: code });
    const { s, boxes } = await R.createProof(st, { awb: lk && lk.found ? lk.awb : code || null, awbSource: 'scan', lookup: lk && lk.found ? lk : null, extra: { stage_source: source } });
    if (first.chk.rc.orderRef) s.label_order = first.chk.rc.orderRef;
    if (source === 'asked') R.flagRecord(s, 'stage chosen by staff');
    if (code && lk === null) R.flagRecord(s, 'booking not checked (no internet)');
    await R.saveRecord(s);
    done(); app.busy = false;
    // which box is this label on?
    let b = boxes[0];
    if (boxes.length > 1) {
      const own = boxes.find((x) => x.box_awb && x.box_awb === code && x.box_awb !== s.awb);
      if (own) b = own;
      else b = await pickBox(s, boxes);
    }
    return afterLabelPhoto(s, b, first.shot, first.chk, first.ocr, { first: true, forced: first.forced, tries: first.tries, code });
  } catch (e) {
    done(); app.busy = false;
    toast('Photo failed: ' + e.message, 'bad');
  }
}

// The S11 box buttons, as a question after the first photo (boxes that share one AWB).
function pickBox(s, boxes) {
  return new Promise((res) => {
    view(`<div class="scr proof-ink">${bandHtml('proof')}
      <main style="justify-content:center;gap:16px;padding:18px">
        <div class="chipline">${I.boxes(22)}<span><b>${hh('from_booking', { order: s.order_no || '?', n: boxes.length })}</b> · <span lang="en">${ee('from_booking')}</span></span></div>
        <div style="font-size:26px;font-weight:700">${hh('which_box')}</div><div class="en" lang="en" style="font-size:16px;margin-top:-10px">${ee('which_box')}</div>
        <div class="boxpick">${boxes.map((x) => `<button data-n="${x.n}" ${x.photos.label.length ? 'disabled' : ''}>${hh('box_n', { n: x.n })}</button>`).join('')}</div></main></div>`);
    for (const el of document.querySelectorAll('.boxpick button')) el.onclick = () => res(boxes.find((x) => x.n === Number(el.dataset.n)));
  });
}

// A label photo passed its checks (or is used after the tries): attach the AWB, save it, run the label-slip check.
async function afterLabelPhoto(s, b, shot, chk, o, { first = false, forced = false, tries = 1, code = '' } = {}) {
  const d0 = await R.load(s.id);
  Object.assign(s, d0.s);
  const boxes = d0.boxes;
  b = boxes.find((x) => x.id === b.id) || b;
  const rc = chk.rc;
  const known = [s.awb, ...boxes.map((x) => x.box_awb)].filter(Boolean);
  let seen = rc.cands.find((c) => known.includes(c)) || '';
  if (!s.awb) seen = code || (rc.cands.length === 1 ? rc.cands[0] : '');
  // own box AWBs: the scan says which box this is
  if (seen && seen !== s.awb) {
    const owner = boxes.find((x) => x.box_awb === seen);
    if (owner && owner.id !== b.id) {
      if (owner.photos.label.length) {
        chk.job.cancel();
        sound.retake();
        return showRetake({ stage: 'proof', side: boxSide(s, b), reasons: ['otherbox'], vars: { n: owner.n, m: b.n }, preview: chk.c.preview, fails: 0,
          again: () => go(`#/step/${enc(s.id)}/${enc(b.id)}/label`) });
      }
      b = owner;
    }
  }
  const typed = !!(b.label && b.label.typed) || s.awb_source === 'typed';
  if (!seen && !typed) {
    // the barcode did not read: retake; after 2 tries use the photo (AWB known) or keep aside (no AWB yet)
    const fresh = await R.updateBox(b.id, (x) => { x.fails.label = (x.fails.label || 0) + 1; });
    Object.assign(b, fresh);
    const pass = chk.reasons.length === 0;
    if (!forced) {
      return showRetake({
        stage: 'proof', side: boxSide(s, b), reasons: ['barcode'], preview: chk.c.preview, fails: b.fails.label,
        again: () => go(`#/step/${enc(s.id)}/${enc(b.id)}/label`),
        use: () => afterLabelPhoto(s, b, shot, chk, o, { first, forced: true, tries: b.fails.label, code }),
        useKey: s.awb ? 'use_photo' : 'keep_aside_btn',
      });
    }
    if (!pass) { /* forced for quality too: keep going */ }
  }
  if (!s.awb && seen) { await R.setAwb(s, seen, 'scan'); }
  const label = { code: seen || s.awb || '', codes: rc.all, child: !!seen && seen !== s.awb, typed, at: isoLocal() };
  await R.updateBox(b.id, (x) => { x.label = label; });
  if (rc.orderRef && !s.label_order) { s.label_order = rc.orderRef; await R.saveRecord(s); }
  const { p } = await savePhoto(s, b, 'label', shot, chk, { tries, barcode: seen ? `barcode ${seen} read` : typed ? 'AWB typed by the supervisor' : 'barcode NOT read', ocr: ocrLine(o) });
  if (forced && chk.reasons.length) await flagBox(b, 'label photo used after 2 failed tries');
  if (!seen && !typed) {
    if (!s.awb) {   // no AWB at all: the photo waits unnamed; the supervisor types the AWB
      await R.keepAside(s, 'label barcode not readable: the supervisor types the AWB');
      await rowsOf(s);
      return showKeepAside(s, 'proof');
    }
    await flagBox(b, 'label barcode not read in the label photo');
  }
  return labelCheck(s, b, o, chk.zone, p);
}

// The label-slip check (design note section 4): the booked order number must be on the slip next to the label.
async function labelCheck(s, b, o, zone, photo) {
  const d = await R.load(s.id);
  Object.assign(s, d.s);
  b = d.boxes.find((x) => x.id === b.id);
  const expected = s.label_order || s.order_no;
  if (s.label_order && s.order_no && s.label_order !== s.order_no) R.flagRecord(s, `the label's order barcode ${s.label_order} differs from the booking ${s.order_no}`);
  if (!expected || !o || !o.ok) {
    const why = !expected ? 'label-slip check skipped: no order number for this AWB' : 'label-slip check skipped: the reader was not available';
    const fresh = await R.updateBox(b.id, (x) => { x.slip_check = 'skipped'; if (!x.flags.includes(why)) x.flags.push(why); });
    Object.assign(b, fresh);
    await R.saveRecord(s); await rowsOf(s);
    return showCheckSkipped(s, b, !expected);
  }
  // the first photo was read cold: read again for this number when the cold read did not settle it
  let res = slipCheck(expected, o.hits, zone);
  if (res.result !== 'match' && photo && photo.blob && !o.verified) {
    const done = busy('checking');
    const o2 = await ocr.readOrders(photo.blob, { until: (hits) => slipCheck(expected, hits, zone).result === 'match' });
    done();
    if (o2.ok) { res = slipCheck(expected, o2.hits, zone); o = { ...o2, verified: true }; }
  }
  if (res.result === 'match') {
    const fresh = await R.updateBox(b.id, (x) => { x.slip_check = 'match'; x.check_seen = res.seen; });
    Object.assign(b, fresh);
    await R.saveRecord(s); await rowsOf(s);
    sound.good();
    return showMatch(s, b, expected);
  }
  const fresh = await R.updateBox(b.id, (x) => { x.check_fails = (x.check_fails || 0) + 1; x.check_seen = res.seen; x.check_why = res.why; });
  Object.assign(b, fresh);
  if (b.check_fails >= app.settings.levels.tries) {
    await R.updateBox(b.id, (x) => {
      x.slip_check = 'no match';
      const f = `label and slip do not match twice (slip ${res.seen || 'number not found'}, label ${expected})`;
      if (!x.flags.includes(f)) x.flags.push(f);
    });
    await R.keepAside(s, 'label and slip do not match');
    await rowsOf(s);
    sound.stop();
    return showKeepAside(s, 'proof');
  }
  await R.saveRecord(s); await rowsOf(s);
  sound.stop();
  return showStop(s, b, expected, res);
}

// S12
function showMatch(s, b, order) {
  const [a, bb] = boxSide(s, b);
  view(`<div class="full green">${bandHtml('proof', a, bb, true)}
    <main><div class="disc" style="width:128px;height:128px;background:#fff;color:var(--proof)">${I.check(76)}</div>
      <div><div class="res-a" style="font-size:36px">${hh('match')}</div><div class="res-b" lang="en">${ee('match')}</div></div>
      <div class="pair"><div><span class="k">${hh('slip')} · <span lang="en" style="font-weight:400">${ee('slip')}</span></span><span class="v mono" lang="en">${esc(order)}</span></div>
        <div><span class="k">${hh('label')} · <span lang="en" style="font-weight:400">${ee('label')}</span></span><span class="v mono" lang="en">${esc(order)}</span></div></div>
      <div class="sound">${I.speaker(20)}<span>${hh('short_beep')} · <span lang="en">${ee('short_beep')}</span></span></div></main>
    <footer>${nextBtnHtml('proof', nextOf(s, b, 'label'), 'white proof-t')}</footer></div>`);
  $('#next').onclick = () => afterPhoto(s.id);
}

// S13
function showStop(s, b, expected, res) {
  const [a, bb] = boxSide(s, b), diff = res.why === 'different';
  view(`<div class="full red">${bandHtml('proof', a, bb, true)}
    <main style="gap:16px">${I.stopSign(124)}
      <div><div style="font-size:44px;font-weight:700;line-height:1.05">${hh('stop')}</div><div lang="en" style="font-size:20px;font-weight:600;letter-spacing:.06em">${ee('stop')}</div></div>
      <div><div style="font-size:23px;font-weight:700;line-height:1.25">${hh(diff ? 'diff_orders' : 'not_on_slip')}</div><div lang="en" style="font-size:16px">${ee(diff ? 'diff_orders' : 'not_on_slip')}</div></div>
      <div class="pair"><div><span class="k">${hh('slip')} · <span lang="en" style="font-weight:400">${ee('slip')}</span></span><span class="v mono ${diff ? '' : 'bad'}" lang="en">${diff ? esc(res.seen) : `${hh('not_found')} · ${ee('not_found')}`}</span></div>
        <div><span class="k">${hh('label')} · <span lang="en" style="font-weight:400">${ee('label')}</span></span><span class="v mono ${diff ? 'bad' : ''}" lang="en">${esc(expected)}</span></div></div>
      <div style="font-size:18px;font-weight:600;line-height:1.3">${hh('find_label')}<br><span lang="en" style="font-size:15px;font-weight:400">${ee('find_label')}</span></div>
      <div class="sound">${I.buzz(20)}<span>${hh('three_buzz')} · <span lang="en">${ee('three_buzz')}</span></span></div></main>
    <footer><button class="bigbtn white stop-t" id="again">${I.again(42)}<span class="tx"><span class="a">${hh('check_again')}</span><span class="b" lang="en">${ee('check_again')}</span></span></button>
      <div style="font-size:14px;text-align:center">${hh('fails_twice')} · <span lang="en">${ee('fails_twice')}</span></div></footer></div>`);
  $('#again').onclick = () => go(`#/step/${enc(s.id)}/${enc(b.id)}/label`);
}

// S14
function showKeepAside(s, stage) {
  view(`<div class="full amber">${bandHtml(stage, '', '', true)}
    <main>${D.keepAside()}
      <div><div class="res-a" style="font-size:38px">${hh('keep_aside')}</div><div lang="en" style="font-size:19px;font-weight:600">${ee('keep_aside')}</div></div>
      <div><div style="font-size:24px;font-weight:600">${hh('sup_will_check')}</div><div lang="en" style="font-size:16px">${ee('sup_will_check')}</div></div>
      <div class="note" style="width:100%;text-align:left">${I.sheet(28)}<div style="color:var(--ink)"><div class="h">${hh('marked_sheet')}</div><div class="e" lang="en">${ee('marked_sheet')}</div></div></div></main>
    <footer>${bigBtn('next', 'next_parcel', 'neutral', '')}</footer></div>`);
  $('#next').insertAdjacentHTML('beforeend', I.arrow(40));
  $('#next').onclick = () => go('#/');
}
async function screenAside(sid) {
  const d = await R.load(sid);
  if (!d) return go('#/');
  return showKeepAside(d.s, R.stageOf(d.s));
}

function showCheckSkipped(s, b, notBooked) {
  const [a, bb] = boxSide(s, b);
  view(`<div class="scr proof-ink">${bandHtml('proof', a, bb)}${dotsHtml(s, b, 'scale')}
    <main style="justify-content:center;padding:18px"><div class="note amber">${I.info(24)}<div>
      <div class="h">${hh(notBooked ? 'not_booked' : 'check_skipped')}</div><div class="h">${hh('not_booked_do')}</div>
      <div class="e" lang="en">${ee(notBooked ? 'not_booked' : 'check_skipped')}: ${ee('not_booked_do')}</div></div></div></main>
    <footer>${nextBtnHtml('proof', nextOf(s, b, 'label'))}</footer></div>`);
  $('#next').onclick = () => afterPhoto(s.id);
}

// PROOF done
async function screenDone(sid) {
  const d = await R.load(sid);
  if (!d) return go('#/');
  const { s } = d;
  view(`<div class="full green">${bandHtml('proof', '', '', true)}
    <main><div class="disc" style="width:128px;height:128px;background:#fff;color:var(--proof)">${I.check(76)}</div>
      <div><div class="res-a">${hh('all_done')}</div><div class="res-b" lang="en">${ee('all_done')}</div></div>
      <div class="pair"><div><span class="k">AWB</span><span class="v mono" lang="en">${esc(s.awb || '')}</span></div></div></main>
    <footer><button class="bigbtn white proof-t" id="next"><span class="tx"><span class="a">${hh('next_parcel')}</span><span class="b" lang="en">${ee('next_parcel')}</span></span>${I.arrow(40)}</button>
      ${redoBtn(s.id, 'proof', location.hash).replace('smallbtn proof', 'smallbtn proof" style="background:transparent;color:#fff;border-color:#fff')}</footer></div>`);
  $('#next').onclick = () => go('#/');
  wireRedo();
}

// ---------------------------------------------------------------- redo: a photo, a box, or every box
// Staff tap the photos to take again (any box), or "Restart box n" / "Restart all boxes", then one button. The new
// photos become the final ones; the old ones stay in Drive and the Sheet as retakes, and the box notes the redo.
function redoBtn(sid, stage, back = '') {
  return `<button class="smallbtn ${stage}" id="redo" data-go="#/redo/${enc(sid)}${back ? '/' + enc(back) : ''}">↺ ${hh('redo_btn')} · <span lang="en" style="font-weight:400">${ee('redo_btn')}</span></button>`;
}
function wireRedo() { const r = $('#redo'); if (r) r.onclick = () => go(r.dataset.go); }
const hasPhotos = (s, boxes) => boxes.some((b) => Object.values(b.photos).some((l) => l.length)) || s.boxes_photo.length > 0;

async function screenRedo(sid, back) {
  const d = await R.load(sid);
  if (!d || d.s.cancelled_at || d.s.kept_aside) return go('#/');
  const { s, boxes } = d, stage = R.stageOf(s), kinds = R.kindsOf(s), multi = boxes.length > 1;
  const sel = new Map(boxes.map((b) => [b.id, new Set()]));
  let selBoxes = false;
  const tile = (b, k) => {
    const done = b.photos[k] && b.photos[k].length > 0, w = stepWord(k);
    return `<button class="rtile ${done ? 'done' : ''}" data-b="${esc(b.id)}" data-k="${k}" ${done ? '' : 'disabled'}>${I[k](24)}<span>${esc(w.hi)}</span><span class="tag" lang="en">${esc(w.en)}</span></button>`;
  };
  view(`<div class="scr ${stage}-ink">${bandHtml(stage)}
    <main style="gap:12px">
      <div><h1 class="ttl" style="font-size:27px">${hh('redo_title')}</h1><div class="ttl-en" lang="en">${ee('redo_title')}</div></div>
      <div class="waitline">${I.info(20)}<span>${hh('redo_tap')} · <span lang="en">${ee('redo_tap')}</span></span></div>
      ${boxes.map((b) => `<section class="rbox"><div class="hd">${hh('box_n', { n: b.n })} · <span lang="en" style="font-weight:400;font-size:15px">${ee('box_n', { n: b.n })}</span></div>
        <div class="rtiles">${kinds.map((k) => tile(b, k)).join('')}</div>
        <button class="smallbtn ${stage}" data-all="${esc(b.id)}" ${hasPhotos(s, [b]) ? '' : 'disabled'}>${hh('restart_box', { n: b.n })} · <span lang="en" style="font-weight:400">${ee('restart_box', { n: b.n })}</span></button></section>`).join('')}
      ${R.needsBoxesPhoto(s, boxes) && s.boxes_photo.length ? `<section class="rbox"><div class="rtiles" style="grid-template-columns:1fr"><button class="rtile done" id="rboxes">${I.boxes(24)}<span>${esc(stepWord('boxes').hi)}</span><span class="tag" lang="en">${esc(stepWord('boxes').en)}</span></button></div></section>` : ''}
      ${multi ? `<button class="midbtn amber" id="rall"><span class="tx" style="align-items:center"><span class="a" style="font-size:19px">${hh('restart_all')}</span><span class="b" lang="en">${ee('restart_all')}</span></span></button>` : ''}
      <div class="waitline">${I.sheet(20)}<span>${hh('old_kept')} · <span lang="en">${ee('old_kept')}</span></span></div>
    </main>
    <footer><button class="bigbtn ${stage}" id="rgo" disabled>${I.again(40)}<span class="tx"><span class="a" style="font-size:26px">${hh('redo_go')}</span><span class="b" lang="en">${ee('redo_go')}</span></span></button>
      <button class="smallbtn ${stage}" id="rback">${hh('back')} · <span lang="en" style="font-weight:400">${ee('back')}</span></button></footer></div>`);
  const paint = () => {
    for (const el of document.querySelectorAll('.rtile[data-k]')) el.classList.toggle('sel', sel.get(el.dataset.b).has(el.dataset.k));
    const bx = $('#rboxes'); if (bx) bx.classList.toggle('sel', selBoxes);
    $('#rgo').disabled = ![...sel.values()].some((x) => x.size) && !selBoxes;
  };
  for (const el of document.querySelectorAll('.rtile[data-k]')) el.onclick = () => { const set = sel.get(el.dataset.b); if (set.has(el.dataset.k)) set.delete(el.dataset.k); else set.add(el.dataset.k); paint(); };
  for (const el of document.querySelectorAll('[data-all]')) el.onclick = () => {
    const b = boxes.find((x) => x.id === el.dataset.all), set = sel.get(b.id), done = kinds.filter((k) => b.photos[k] && b.photos[k].length);
    const all = done.every((k) => set.has(k));
    for (const k of done) { if (all) set.delete(k); else set.add(k); }
    paint();
  };
  const bx = $('#rboxes'); if (bx) bx.onclick = () => { selBoxes = !selBoxes; paint(); };
  const ra = $('#rall'); if (ra) ra.onclick = () => {
    const allNow = boxes.every((b) => kinds.filter((k) => b.photos[k] && b.photos[k].length).every((k) => sel.get(b.id).has(k)));
    for (const b of boxes) for (const k of kinds) if (b.photos[k] && b.photos[k].length) { if (allNow) sel.get(b.id).delete(k); else sel.get(b.id).add(k); }
    if (R.needsBoxesPhoto(s, boxes) && s.boxes_photo.length) selBoxes = !allNow;
    paint();
  };
  $('#rback').onclick = () => go(back || '#/');
  $('#rgo').onclick = async () => {
    const items = boxes.map((b) => ({ box: b, kinds: kinds.filter((k) => sel.get(b.id).has(k)) })).filter((x) => x.kinds.length);
    await R.markRedo(s, items, { boxesPhoto: selBoxes });
    const d2 = await R.load(sid);
    await rowsChanged(d2.s, d2.boxes);
    const nx = R.nextStep(d2.s, d2.boxes);
    if (nx.screen === 'step') return go(`#/step/${enc(sid)}/${nx.box ? enc(nx.box.id) : 'all'}/${nx.kind}`);
    return go('#/');
  };
}

// ---------------------------------------------------------------- the photo steps (S3, S5-S8, S11, all boxes)
const STEP_INFO = {
  slip: { title: 'slip_title', draw: () => D.slip(), lines: () => ['slip_1', 'slip_2', 'slip_3'] },
  label: { title: 'label_title', draw: () => D.label(), lines: () => [], caption: 'label_caption' },
  scale: { title: 'weight_title', draw: (p) => D.scale(p), lines: (p) => ['weight_1', 'weight_2', p ? 'weight_3p' : 'weight_3'] },
  length: { title: 'length_title', draw: (p) => D.length(p), lines: (p) => ['length_1', 'length_2', 'length_3', ...(p ? ['label_in_view'] : [])] },
  breadth: { title: 'breadth_title', draw: (p) => D.breadth(p), lines: (p) => ['breadth_1', 'breadth_2', 'breadth_3', ...(p ? ['label_in_view'] : [])] },
  height: { title: 'height_title', draw: (p) => D.height(p), lines: (p) => ['height_1', 'height_2', 'height_3', ...(p ? ['label_in_view'] : [])] },
  boxes: { title: 'boxes_title', draw: () => D.boxes(), lines: () => ['boxes_1'] },
};

async function screenStep(sid, bid, kind) {
  const d = await R.load(sid);
  if (!d || !STEP_INFO[kind]) return go('#/');
  const { s, boxes } = d, stage = R.stageOf(s), proof = stage === 'proof';
  if (s.cancelled_at) return go('#/');
  if (s.kept_aside) return go(`#/aside/${enc(sid)}`);
  if (!R.kindsOf(s).includes(kind) && kind !== 'boxes') return go('#/');
  let b = bid === 'all' ? null : boxes.find((x) => x.id === bid) || null;
  if (kind !== 'boxes' && !b) return go('#/');
  const info = STEP_INFO[kind];
  // shared AWB, several boxes: staff tap the big box number before the label photo
  const shared = proof && kind === 'label' && boxes.length > 1 && !boxes.some((x) => x.box_awb && x.box_awb !== s.awb);
  const head = proof && kind === 'label' && s.order_no ? `<div class="chipline">${I.boxes(22)}<span><b>${hh('from_booking', { order: s.order_no, n: boxes.length })}</b> · <span lang="en">${ee('from_booking')}</span></span></div>` : '';
  const chooser = shared ? `<div class="note" style="flex-direction:column;gap:8px"><div class="h">${hh('which_box')} · <span lang="en" class="e">${ee('which_box')}</span></div>
      <div class="boxpick">${boxes.map((x) => `<button data-b="${esc(x.id)}" class="${b && x.id === b.id ? 'on' : ''}" ${R.needs(x, 'label') ? '' : 'disabled'}>${hh('box_n', { n: x.n })}</button>`).join('')}</div></div>` : '';
  const [sa, sb] = kind === 'boxes' ? ['', ''] : boxSide(s, b);
  view(`<div class="scr ${stage}-ink">${bandHtml(stage, sa, sb)}${kind === 'boxes' ? '' : dotsHtml(s, b, kind)}${demoBar()}
    <main>${head}
      <div><h1 class="ttl">${hh(info.title)}</h1><div class="ttl-en" lang="en">${ee(info.title)}</div></div>
      <figure class="fig">${info.draw(proof)}<figcaption>${info.caption ? `${hh(info.caption)} · <span lang="en">${ee(info.caption)}</span>` : `${hh('like_this')} · <span lang="en">${ee('like_this')}</span>`}</figcaption></figure>
      ${chooser}${stepsHtml(info.lines(proof))}</main>
    <footer>${bigBtn('take', 'take_photo', stage)}${hasPhotos(s, boxes) ? redoBtn(s.id, stage, location.hash) : ''}</footer></div>`);
  wireDemoBar();
  wireRedo();
  for (const el of document.querySelectorAll('[data-b]')) el.onclick = () => go(`#/step/${enc(sid)}/${enc(el.dataset.b)}/label`);
  $('#take').onclick = () => {
    if (app.busy) return;
    openCamera((shot) => processStep(s.id, b ? b.id : null, kind, shot, false), demoFor(kind, s, b));
  };
}

async function processStep(sid, bid, kind, shot, forced) {
  if (app.busy) return;
  app.busy = true;
  const done = busy('checking');
  try {
    const d = await R.load(sid);
    const s = d.s, stage = R.stageOf(s), b = bid ? d.boxes.find((x) => x.id === bid) : null;
    const chk = await checkPhoto(shot, kind, { probe: kind === 'label' });
    const fails = (b ? b.fails[kind] : s.boxes_fails) || 0;
    if (chk.reasons.length && !forced) {
      chk.job.cancel();
      if (b) await R.updateBox(b.id, (x) => { x.fails[kind] = (x.fails[kind] || 0) + 1; });
      else { s.boxes_fails = fails + 1; await R.saveRecord(s); }
      done(); app.busy = false;
      return showRetake({ stage, side: boxSide(s, b), reasons: chk.reasons, preview: chk.c.preview, fails: fails + 1,
        again: () => go(`#/step/${enc(sid)}/${bid ? enc(bid) : 'all'}/${kind}`), use: () => processStep(sid, bid, kind, shot, true) });
    }
    const tries = fails + 1;
    if (kind === 'slip') {
      const o = await ocr.readOrders(shot.blob, {});
      await savePhoto(s, b, 'slip', shot, chk, { tries, ocr: ocrLine(o) });
      if (forced && chk.reasons.length) await flagBox(b, 'slip photo used after 2 failed tries');
      await R.updateBox(b.id, (x) => { x.fails.slip = 0; });
      // box 1's first order number read: the already-booked / already-measured checks
      if (b.n === 1 && o.ok && o.orders.length && !s.order_hint) {
        const r = await lookup({ by: 'order', order: o.orders[0], record: s.id });
        if (r && (r.booked || r.measured.length)) await keepHint(s, b, o.orders[0]);
        if (r && r.booked) {
          await R.cancelRecord(s, 'order already booked: needs PROOF, not MEASURE');
          await rowsOf(s);
          done(); app.busy = false;
          return showAlreadyBooked();
        }
        if (r && r.measured.length) {
          R.flagRecord(s, `order ${o.orders[0]} was already measured at ${String(r.measured[0].taken_at).slice(11, 16)} (record ${r.measured[0].record})`);
          await R.saveRecord(s);
          done(); app.busy = false;
          const fresh = await R.load(sid);
          return showAlreadyMeasured(fresh.s, fresh.boxes.find((x) => x.id === b.id), o.orders[0], r.measured[0]);
        }
      }
      done(); app.busy = false;
      const fresh = await R.load(sid);
      return afterSlip(fresh.s, fresh.boxes.find((x) => x.id === b.id), o, o.ok ? o.orders[0] || '' : '');
    }
    if (kind === 'label') {
      const expected = s.label_order || s.order_no || chk.rc.orderRef || '';
      const o = await ocr.readOrders(shot.blob, { until: (hits) => (expected ? slipCheck(expected, hits, chk.zone).result === 'match' : hits.length > 0) });
      done(); app.busy = false;
      return afterLabelPhoto(s, b, shot, chk, { ...o, verified: true }, { forced, tries });
    }
    const { p, preview } = await savePhoto(s, b, kind, shot, chk, { tries });
    if (forced && chk.reasons.length) {
      if (b) await flagBox(b, `${kind} photo used after 2 failed tries`);
      else { R.flagRecord(s, 'all-boxes photo used after 2 failed tries'); await R.saveRecord(s); }
    }
    if (b) await R.updateBox(b.id, (x) => { x.fails[kind] = 0; });
    done(); app.busy = false;
    sound.good();
    await showSaved(preview);
    return afterPhoto(sid, p);
  } catch (e) {
    done(); app.busy = false;
    toast('Photo failed: ' + e.message, 'bad');
  }
}

// "Photo saved" for a moment, with the photo, then the next step.
async function showSaved(preview) {
  const url = preview ? URL.createObjectURL(preview) : '';
  const el = document.createElement('div');
  el.className = 'saved'; el.id = 'savedov';
  el.innerHTML = `${url ? `<img src="${url}" alt="">` : ''}<div class="disc" style="width:72px;height:72px;background:var(--proof);color:#fff">${I.check(44)}</div>
    <div style="font-size:26px;font-weight:700">${hh('saved')}</div><div lang="en">${ee('saved')}</div>`;
  document.body.appendChild(el);
  await sleep(app.settings.demo ? 400 : 1100);
  el.remove();
  if (url) URL.revokeObjectURL(url);
}

async function afterPhoto(sid) {
  const d = await R.load(sid);
  const nx = R.nextStep(d.s, d.boxes);
  if (nx.screen === 'step') return go(`#/step/${enc(sid)}/${nx.box ? enc(nx.box.id) : 'all'}/${nx.kind}`);
  if (nx.screen === 'boxdone') { await rowsChanged(d.s, d.boxes); return go(`#/boxdone/${enc(sid)}`); }
  if (nx.screen === 'done') { await R.markComplete(d.s); await rowsChanged(d.s, d.boxes); return go(`#/done/${enc(sid)}`); }
  return go('#/');
}

// S9: why the photo was not used, in a picture and words; "Use this photo" after the tries (flagged).
function showRetake({ stage, side = ['', ''], reasons, preview, fails, again, use, useKey = 'use_photo', vars }) {
  sound.retake();
  const r = reasons[0] || 'blurry';
  const msg = {
    blurry: ['blurry', 'blurry_do', I.buzz(34)], dark: ['dark', null, I.moon(34)], glare: ['glare', null, I.sun(34)], old: ['old_photo', 'old_photo_do', I.info(34)],
    slip: ['slip_unreadable', 'slip_unreadable_do', I.slip(34)], barcode: ['no_barcode', 'no_barcode_do', I.label(34)], otherbox: ['other_box', 'other_box_do', I.boxes(34)],
  }[r];
  const url = preview ? URL.createObjectURL(preview) : '';
  app.cleanup = () => { if (url) URL.revokeObjectURL(url); };
  const showUse = use && fails >= app.settings.levels.tries;
  const pic = url ? `<img src="${url}" alt="the photo just taken">` : r === 'blurry' ? BLURRED : '';
  view(`<div class="scr">${bandHtml(stage, side[0], side[1])}
    <main style="padding:18px;gap:14px">
      <section class="retake" aria-label="Photo check">${pic}
        <div class="why"><div class="disc" style="flex:none;width:60px;height:60px;background:var(--amber);color:#fff">${msg[2]}</div>
          <div><div class="a">${hh(msg[0], vars)}</div>${msg[1] ? `<div class="b">${hh(msg[1], vars)}</div>` : ''}<div class="c" lang="en">${msg[1] ? ee(msg[1], vars) : ee(msg[0], vars)}</div></div></div>
        <div class="sound" style="color:var(--amber-ink);font-size:14px">${I.buzzLong(18)}<span>${hh('long_buzz')} · <span lang="en">${ee('long_buzz')}</span></span></div></section>
    </main>
    <footer>${bigBtn('again', 'take_again', stage === 'neutral' ? 'neutral' : stage, I.camera(44))}
      ${showUse ? `<button class="midbtn amber" id="use"><span class="tx" style="align-items:center"><span class="a" style="font-size:17px">${hh(useKey)}</span><span class="b" lang="en">${ee(useKey)}</span></span></button>` : ''}</footer></div>`);
  $('#again').onclick = () => again();
  const u = $('#use');
  if (u) u.onclick = () => use();
}

// ---------------------------------------------------------------- supervisor (behind a 4-digit PIN)
// The factory supervisor holds the PIN (owner, 17 Oct). It is set the first time the supervisor menu opens on the
// phone and kept only as a salted hash in the phone's settings: never sent to the backend, never in the Sheet. A
// forgotten PIN is reset with the station key, which the owner holds.
function pinPad(titleKey, sub, onPin, { forgot = false } = {}) {
  let pin = '';
  view(`<div class="scr"><header class="band neutral"><div class="left">${I.lock(30)}<div><div class="word" style="font-size:22px">${hh(titleKey)}</div><div class="sub" lang="en">${ee(titleKey)}</div></div></div>
      <button class="iconbtn" id="x" style="background:transparent;color:#fff;border-color:#fff;width:auto;padding:0 14px">${hh('exit')} · <span lang="en">${ee('exit')}</span></button></header>
    <main class="center">${sub ? `<div><div style="font-size:20px;font-weight:600">${hh(sub)}</div><div class="en" lang="en">${ee(sub)}</div></div>` : ''}
      <div class="pindots" id="dots">${'<span></span>'.repeat(4)}</div><div class="pinerr" id="err"></div>
      <div class="pinpad">${[1, 2, 3, 4, 5, 6, 7, 8, 9, '', 0, '⌫'].map((k) => (k === '' ? '<span></span>' : `<button data-k="${k}">${k}</button>`)).join('')}</div>
      ${forgot ? `<button class="smallbtn" id="forgot" style="max-width:340px;border:1px solid var(--line)">${hh('pin_forgot')} · <span lang="en" style="font-weight:400">${ee('pin_forgot')}</span></button>` : ''}</main></div>`);
  $('#x').onclick = () => go('#/');
  const paint = () => { [...$('#dots').children].forEach((el, i) => el.classList.toggle('on', i < pin.length)); };
  const err = (key) => { $('#err').textContent = `${t(key).hi} · ${t(key).en}`; sound.retake(); };
  for (const el of document.querySelectorAll('[data-k]')) el.onclick = async () => {
    const k = el.dataset.k;
    $('#err').textContent = '';
    if (k === '⌫') pin = pin.slice(0, -1); else if (pin.length < 4) pin += k;
    paint();
    if (pin.length === 4) { const p = pin; pin = ''; paint(); await onPin(p, err); }
  };
  return $('#forgot');
}

function screenPin(next) {
  if (!app.settings.pinHash) return screenSetPin(next);
  const forgot = pinPad('pin_title', '', async (p, err) => {
    if ((await pinHash(p, app.settings.pinSalt)) === app.settings.pinHash) { app.supUntil = Date.now() + 5 * 60000; render(); }
    else err('pin_wrong');
  }, { forgot: true });
  forgot.onclick = async () => {
    const key = await modal(`<h3>${hh('pin_forgot')}</h3><p class="small muted" lang="en">${ee('pin_forgot')}. The owner holds the station key.</p>
      <input type="password" id="sk" autocomplete="off"><div class="err" id="ske"></div><div class="row"><button id="no">Back</button><button class="primary" id="yes">OK</button></div>`,
    (m, close) => {
      setTimeout(() => $('#sk', m).focus(), 50);
      $('#no', m).onclick = () => close(null);
      $('#yes', m).onclick = () => {
        const v = normKey($('#sk', m).value);
        if (v.length < 8 || v !== normKey(app.settings.key)) { $('#ske', m).textContent = `${t('key_wrong').hi} · ${t('key_wrong').en}`; sound.retake(); return; }
        close(v);
      };
    });
    if (!key) return;
    await saveSettings({ pinHash: '', pinSalt: '' });
    await supLog('PIN reset with the station key', null, '');
    screenSetPin(next);
  };
}

// First opening (or after a reset): the supervisor types a new PIN twice.
function screenSetPin(next) {
  pinPad('pin_new', 'pin_new_hint', async (p1) => {
    pinPad('pin_again', '', async (p2) => {
      if (p1 !== p2) { screenSetPin(next); setTimeout(() => { const e = $('#err'); if (e) e.textContent = `${t('pin_mismatch').hi} · ${t('pin_mismatch').en}`; sound.retake(); }, 0); return; }
      const salt = Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) => x.toString(16).padStart(2, '0')).join('');
      await saveSettings({ pinSalt: salt, pinHash: await pinHash(p1, salt) });
      await supLog('PIN set', null, '');
      sound.good();
      app.supUntil = Date.now() + 5 * 60000;
      if (location.hash === next) render(); else go(next);
    });
  });
}

async function supLog(action, s, notes) {
  await addLog({ type: `supervisor: ${action}`, reading: s ? s.id : '', result: s && s.awb ? s.awb : '', notes: notes || '' });
}
async function pickRecord(title, filter) {
  const all = [];
  for (const s of (await db.all('shipments')).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 80)) if (filter(s)) all.push(s);
  if (!all.length) { toast('No records to choose from', 'bad'); return null; }
  return modal(`<h3>${esc(title)}</h3>${all.map((s) => `<button class="wide" data-s="${esc(s.id)}" style="margin-top:8px;text-align:left">
      <b>${R.stageOf(s) === 'measure' ? 'MEASURE' : 'PROOF'}</b> ${esc(s.awb || s.order_hint || s.order_no || '')} · ${s.boxes.length} box${s.boxes.length > 1 ? 'es' : ''} · ${esc(s.created_at.slice(11, 16))}
      ${s.kept_aside ? `<br><span class="small">kept aside: ${esc(s.kept_aside.reason)}</span>` : ''}<br><span class="small muted">${esc(s.id)}</span></button>`).join('')}
    <button class="wide" id="no" style="margin-top:14px">Back</button>`,
  (m, close) => { for (const x of m.querySelectorAll('[data-s]')) x.onclick = () => close(all.find((s) => s.id === x.dataset.s)); $('#no', m).onclick = () => close(null); });
}

async function screenSup() {
  const st = app.settings;
  const lockBtn = (v, key, color) => `<button data-lock="${v}" class="${(st.lock || '') === v ? 'on' : ''}" style="${(st.lock || '') === v ? '' : `border:2px solid ${color};color:${color}`}">${hh(key)}</button>`;
  const item = (id, icon, key, color = 'var(--muted)') => `<button class="supbtn" id="${id}"><span style="color:${color}">${icon}</span><span><span class="a">${hh(key)}</span><span class="b" lang="en">${ee(key)}</span></span></button>`;
  view(`<div class="bar"><span>${I.lock(26)}</span><h1>${hh('supervisor')} · <span lang="en" style="font-weight:400;font-size:14px">${ee('supervisor')}</span></h1><a href="#/" id="exit">${hh('exit')} · Exit</a></div>
    <div class="adm">
      ${item('awb', I.keyboard(28), 'sup_awb')}${item('release', I.release(28), 'sup_release', '#8a5300')}${item('boxes', I.plusBox(28), 'sup_boxes')}${item('cancel', I.cancel(28), 'sup_cancel', 'var(--stop)')}${item('supredo', I.again(28), 'sup_redo')}
      <div class="card"><span class="a" style="display:block;font-size:19px;font-weight:600">${hh('sup_lock')}</span><span class="small muted" lang="en">${ee('sup_lock')}</span>
        <div class="lockrow" style="margin-top:10px">${lockBtn('', 'lock_none', 'var(--ink)')}${lockBtn('measure', 'measure_chip', 'var(--measure)')}${lockBtn('proof', 'proof_chip', 'var(--proof)')}</div></div>
      ${item('settings', I.gear(28), 'sup_settings')}
      <p class="small muted" style="display:flex;gap:8px;align-items:center">${I.sheet(20)} ${hh('sup_logged')} · <span lang="en">${ee('sup_logged')}</span></p>
      <p class="small"><a href="#/queue">Uploads</a>${app.harness ? ' · <a href="#/demo">TEST: what reached Drive and the Sheet</a>' : ''}</p>
    </div>`);
  app.supUntil = Date.now() + 5 * 60000;
  $('#exit').onclick = (e) => { e.preventDefault(); app.supUntil = 0; go('#/'); };
  for (const el of document.querySelectorAll('[data-lock]')) el.onclick = async () => {
    await saveSettings({ lock: el.dataset.lock });
    await supLog('stage lock', null, el.dataset.lock || 'none');
    render();
  };
  $('#settings').onclick = () => go('#/settings');
  $('#awb').onclick = supTypeAwb;
  $('#release').onclick = supRelease;
  $('#boxes').onclick = supBoxes;
  $('#cancel').onclick = supCancel;
  $('#supredo').onclick = async () => {
    const s = await pickRecord('Redo photos of which parcel?', (x) => !x.cancelled_at && !x.kept_aside && istDay(new Date(x.created_at)) === istDay());
    if (!s) return;
    await supLog('redo photos', s, '');
    app.supUntil = 0;
    go(`#/redo/${enc(s.id)}`);
  };
}

async function supTypeAwb() {
  const v = await askText('Type the AWB', 'Only when the barcode will not scan. The Sheet shows it was typed.', { placeholder: 'e.g. 55130010176993', check: (x) => (AWB_OK.test(normCode(x)) ? '' : '6-20 letters or digits') });
  if (!v) return;
  const typed = normCode(v);
  const done = busy('checking');
  const lk = await lookup({ by: 'awb', awb: typed });
  done();
  const master = lk && lk.found ? lk.awb : typed;   // a box's own AWB books under the order's AWB
  const waiting = (await db.all('shipments')).filter((s) => R.stageOf(s) === 'proof' && !s.awb && !s.cancelled_at);
  const s = waiting.length ? await pickRecord('Which parcel is this AWB for? (Back: a new parcel)', (x) => waiting.some((w) => w.id === x.id)) : null;
  app.supUntil = 0;
  if (s) {
    // a parcel kept aside because its label barcode would not read: its label photo is already taken
    if (lk && lk.found) {
      s.lookup = lk; s.order_no = lk.order || ''; s.order_source = lk.order ? 'booking' : '';
      for (let i = s.boxes.length; i < lk.boxes.length; i++) await R.addBoxByHand(s);
      const d1 = await R.load(s.id);
      for (const b of d1.boxes) { const x = lk.boxes[b.n - 1]; if (x) await R.updateBox(b.id, (y) => { y.pre_box_id = x.box_id || ''; y.box_awb = x.box_awb || ''; }); }
    }
    s.flags = s.flags.filter((f) => f !== 'no AWB yet');
    R.flagRecord(s, `AWB typed by the supervisor: ${typed}`);
    await R.setAwb(s, master, 'typed');   // the photos that waited get their names and upload now
    if (s.kept_aside) await R.release(s, 'AWB typed by the supervisor');
    await supLog('type AWB', s, typed);
    const d = await R.load(s.id);
    const b = d.boxes.find((x) => x.photos.label.length) || d.boxes[0];
    await R.updateBox(b.id, (x) => { x.label = { code: typed, codes: [], child: typed !== master, typed: true, at: isoLocal() }; });
    await rowsOf(d.s);
    const lp = R.finalPhoto(b.photos.label, d.byId);
    if (lp && lp.blob) {   // run the label-slip check on that photo (the label was not located: no barcode read)
      const expected = d.s.label_order || d.s.order_no, done2 = busy('checking');
      const o = await ocr.readOrders(lp.blob, { until: (h) => (expected ? slipCheck(expected, h, null).result === 'match' : h.length > 0) });
      done2();
      return labelCheck(d.s, b, { ...o, verified: true }, null, lp);
    }
    return go(`#/step/${enc(s.id)}/${enc(b.id)}/label`);
  }
  // a new parcel with a typed AWB: its label photo is next (no barcode needed on it)
  const { s: ns, boxes } = await R.createProof(app.settings, { awb: master, awbSource: 'typed', lookup: lk && lk.found ? lk : null, extra: { stage_source: 'supervisor' } });
  R.flagRecord(ns, `AWB typed by the supervisor: ${typed}`);
  await R.saveRecord(ns);
  await supLog('type AWB', ns, typed);
  await rowsOf(ns);
  const b0 = boxes.find((x) => x.box_awb && x.box_awb === typed) || boxes[0];
  go(`#/step/${enc(ns.id)}/${enc(b0.id)}/label`);
}

async function supRelease() {
  const s = await pickRecord('Release which kept-aside parcel?', (x) => !!x.kept_aside && !x.cancelled_at);
  if (!s) return;
  if (R.stageOf(s) === 'proof' && !s.awb) { toast('This parcel has no AWB yet: use "Type an AWB" first', 'bad'); return; }
  const why = await askText('Why is it released?', `Kept aside: ${s.kept_aside.reason}. The reason goes to the Sheet.`, { placeholder: 'e.g. checked: right label, slip number smudged' });
  if (!why) return;
  await R.release(s, why);
  const d = await R.load(s.id);
  for (const b of d.boxes) if (b.slip_check === 'no match' || (b.check_fails && b.slip_check !== 'match')) await R.updateBox(b.id, (x) => { x.slip_check = 'overridden'; });
  await supLog('release', s, why);
  await rowsOf(s);
  app.supUntil = 0;
  const d2 = await R.load(s.id);
  const nx = R.nextStep(d2.s, d2.boxes);
  if (nx.screen === 'step') {
    // a released label photo: go on with the weight of that box
    const lb = d2.boxes.find((b) => b.photos.label.length && !b.photos.scale.length);
    if (R.stageOf(s) === 'proof' && lb) return go(`#/step/${enc(s.id)}/${enc(lb.id)}/scale`);
    return go(`#/step/${enc(s.id)}/${nx.box ? enc(nx.box.id) : 'all'}/${nx.kind}`);
  }
  return afterPhoto(s.id);
}

async function supBoxes() {
  const s = await pickRecord('Add or remove a box: which record?', (x) => !x.cancelled_at && !x.completed_at);
  if (!s) return;
  const act = await modal(`<h3>${esc(s.id)}</h3><p>${s.boxes.length} box${s.boxes.length > 1 ? 'es' : ''} now.</p>
    <div class="row"><button id="add">+ Add a box</button>${s.boxes.length > 1 ? '<button id="rm">Remove the last box</button>' : ''}</div><button class="wide" id="no" style="margin-top:12px">Back</button>`,
  (m, close) => { $('#add', m).onclick = () => close('add'); const r = $('#rm', m); if (r) r.onclick = () => close('rm'); $('#no', m).onclick = () => close(null); });
  if (!act) return;
  try {
    if (act === 'add') await R.addBoxByHand(s); else await R.removeLastBox(s);
  } catch (e) { toast(e.message, 'bad'); return; }
  R.flagRecord(s, `boxes changed by the supervisor: now ${s.boxes.length}`);
  await R.saveRecord(s);
  await supLog(act === 'add' ? 'add box' : 'remove box', s, `now ${s.boxes.length} boxes`);
  await rowsOf(s);
  toast(`Now ${s.boxes.length} boxes`, 'go');
  render();
}

async function supCancel() {
  const s = await pickRecord('Cancel which record? Its photos are kept.', (x) => !x.cancelled_at && !x.completed_at);
  if (!s) return;
  const why = await askText('Why is it cancelled?', 'Photos already uploaded stay in Drive. The reason goes to the Sheet.', { placeholder: 'e.g. re-packed' });
  if (!why) return;
  await R.cancelRecord(s, why);
  await supLog('cancel', s, why);
  await rowsOf(s);
  toast('Record cancelled', 'go');
  render();
}

// ---------------------------------------------------------------- settings (supervisor)
async function screenSettings() {
  const st = app.settings, lv = st.levels;
  const lvl = (k) => `<label class="field">${k} <input type="number" data-sharp="${k}" value="${lv.sharp[k]}" min="0" step="10"></label>`;
  view(`<div class="bar">${st.setupDone ? '<a href="#/sup">&#8249;</a>' : ''}<h1>Settings</h1>${st.test ? '<span class="pill test">TEST</span>' : ''}</div><div class="adm">
    ${st.setupDone ? '' : '<div class="card warn"><b>First time on this phone.</b> Paste the backend URL, type the station key once, test the connection, then Save. The factory supervisor sets the 4-digit PIN the first time the supervisor menu (the lock icon) opens.</div>'}
    <label class="field">Backend URL <span class="hint">The Apps Script web-app address ending in /exec.</span><input type="url" id="url" value="${esc(st.scriptUrl)}" placeholder="https://script.google.com/macros/s/.../exec" autocomplete="off"></label>
    <label class="field">Station key <span class="hint">Typed once. It stays on this phone and is never in the app's code.</span><input type="password" id="key" value="${esc(st.key)}" autocomplete="off"></label>
    <button class="wide" id="test">Test connection</button><div id="testout" class="small" style="margin:8px 0 4px"></div>
    <label class="field">Station name<input type="text" id="station" value="${esc(st.station)}"></label>
    ${st.setupDone ? `<label class="field">Change the supervisor PIN <span class="hint">4 digits. Leave empty to keep the current PIN. It stays on this phone as a salted hash; a forgotten PIN is reset with the station key.</span><input type="password" id="pin" inputmode="numeric" maxlength="4" autocomplete="off"></label>` : ''}
    <label class="check"><input type="checkbox" id="testmode" ${st.test ? 'checked' : ''}><span><b>TEST mode</b><br><span class="small muted">Files go to Packing Proof/TEST and rows to the TEST tabs. Turn off to go live.</span></span></label>
    <div class="row"><label class="field">Phone make<input type="text" id="make" value="${esc(st.phoneMake)}" placeholder="e.g. Samsung"></label>
      <label class="field">Phone model<input type="text" id="model" value="${esc(st.phoneModel)}" placeholder="e.g. SM-A356E"></label></div>
    <details><summary>Check levels (advanced)</summary>
      <p class="small muted">Sharpness is the frame-trial score (edge variance on a 540x960 grey copy). Set each level a little below what a good photo scores.</p>
      <div class="row">${Object.keys(lv.sharp).map(lvl).join('')}</div>
      <div class="row"><label class="field">Dark below<input type="number" id="brightMin" value="${lv.brightMin}"></label>
        <label class="field">Bright above<input type="number" id="brightMax" value="${lv.brightMax}"></label>
        <label class="field">"Use this photo" after (tries)<input type="number" id="tries" value="${lv.tries}" min="1"></label></div>
      <button class="wide" id="resetlv">Reset levels</button>
    </details>
    <label class="check"><input type="checkbox" id="demo" ${st.demo ? 'checked' : ''}><span>Demo camera <span class="small muted">(computer testing only; forces TEST mode)</span></span></label>
    <button class="wide primary" id="save" style="margin-top:12px;min-height:64px">Save</button>
    <h2>About this phone</h2>
    <dl class="kv small"><dt>App</dt><dd>v${APP_VERSION}</dd><dt>Order-number reader</dt><dd id="ocrst">${esc(ocr.state.status)}${ocr.state.loadMs ? ` (loaded in ${ocr.state.loadMs} ms)` : ''}${ocr.state.error ? ' · ' + esc(ocr.state.error) : ''}</dd>
      <dt>Barcode reader</dt><dd id="eng">${esc(barcode.engine)}</dd><dt>Storage</dt><dd id="stor">...</dd><dt>Uploads</dt><dd>${app.q.pending || 0} waiting · <a href="#/queue">details</a></dd></dl>
  </div>`);
  db.usage().then((u) => { const el = $('#stor'); if (el && u) el.textContent = `${(u.usage / 1e6).toFixed(0)} MB used of ${(u.quota / 1e9).toFixed(1)} GB`; });
  barcode.getDetector().then(() => { const el = $('#eng'); if (el) el.textContent = barcode.engine; }).catch(() => {});
  const collect = () => {
    const sharp = {};
    for (const el of document.querySelectorAll('[data-sharp]')) sharp[el.dataset.sharp] = Math.max(0, Number(el.value) || 0);
    return {
      scriptUrl: $('#url').value.trim(), key: $('#key').value.trim(), station: $('#station').value.trim() || 'Station 1',
      test: $('#testmode').checked || $('#demo').checked, demo: $('#demo').checked, phoneMake: $('#make').value.trim(), phoneModel: $('#model').value.trim(),
      levels: mergeLevels({ ...st.levels, sharp, brightMin: Number($('#brightMin').value) || 0, brightMax: Number($('#brightMax').value) || 255, tries: Math.max(1, Number($('#tries').value) || 2) }),
    };
  };
  $('#test').onclick = async () => {
    const c = collect(), out = $('#testout');
    if (!c.scriptUrl) { out.textContent = 'Paste the backend URL first.'; return; }
    out.textContent = 'Testing...';
    try {
      const r = await transport.post(c.scriptUrl, { v: 1, action: 'ping', key: c.key, station: c.station, app: APP_VERSION, phone: c.phoneModel, test: c.test });
      if (r.ok) {
        out.innerHTML = `<div class="card go"><b>Connected.</b> Script v${esc(r.version)}${r.stages ? '' : ' - <b>this backend is older than v2: update the Apps Script first</b>'}.<br>` +
          `Drive: <a href="${esc(r.root && r.root.url)}" target="_blank" rel="noopener">${esc(r.root && r.root.name)}</a> · Sheet: <a href="${esc(r.sheet && r.sheet.url)}" target="_blank" rel="noopener">open</a></div>`;
      } else if (r.code === 'bad_key') out.innerHTML = '<div class="card warn"><b>Reply readable, key refused.</b> The station key is wrong.</div>';
      else out.innerHTML = `<div class="card warn">Reply: ${esc(r.code)} ${esc(r.error || '')}</div>`;
    } catch (e) { out.innerHTML = `<div class="card bad"><b>Cannot reach the script.</b> ${esc(e.message)}</div>`; }
  };
  $('#resetlv').onclick = async () => { await saveSettings({ levels: mergeLevels({}) }); await supLog('settings saved', null, 'check levels reset'); toast('Levels reset'); render(); };
  $('#save').onclick = async () => {
    const c = collect(), pin = $('#pin') ? $('#pin').value.trim() : '';
    if (!c.scriptUrl || !/^https:\/\/|^http:\/\/localhost/.test(c.scriptUrl)) { toast('Paste the backend URL (https://...)', 'bad'); return; }
    if (c.key.length < 8) { toast('Type the station key (8 characters or more)', 'bad'); return; }
    if (pin && !/^\d{4}$/.test(pin)) { toast('The PIN is 4 digits', 'bad'); return; }
    let pinPatch = {};
    if (pin) { const salt = Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) => x.toString(16).padStart(2, '0')).join(''); pinPatch = { pinSalt: salt, pinHash: await pinHash(pin, salt) }; }
    // what changed, for the Station log (names only: never the key or the PIN)
    const names = { scriptUrl: 'backend URL', key: 'station key', station: 'station name', test: 'TEST mode', demo: 'demo camera', phoneMake: 'phone make', phoneModel: 'phone model' };
    const changed = Object.keys(names).filter((k) => c[k] !== st[k]).map((k) => (k === 'test' ? `TEST mode ${c.test ? 'on' : 'off'}` : names[k]));
    if (JSON.stringify(c.levels) !== JSON.stringify(st.levels)) changed.push('check levels');
    if (pin) changed.push('PIN changed');
    const wasSetUp = st.setupDone;
    await saveSettings({ ...c, ...pinPatch, setupDone: true });
    if (wasSetUp && changed.length) await supLog('settings saved', null, changed.join(', '));
    app.uploader.retryNow();
    toast('Saved', 'go');
    go('#/');
  };
}

// ---------------------------------------------------------------- upload details (supervisor)
async function screenQueue() {
  const q = (await db.all('queue')).sort((a, b) => a.seq - b.seq);
  const photos = (await db.all('photos')).sort((a, b) => (b.captured_at || '').localeCompare(a.captured_at || '')).slice(0, 60);
  const when = (ms) => (ms ? new Date(ms).toTimeString().slice(0, 8) : 'now');
  view(`<div class="bar"><a href="#/sup">&#8249;</a><h1>Uploads</h1></div><div class="adm">
    <button class="wide primary" id="retry">Retry all now</button>
    ${shareCard((await db.all('photos')).filter((p) => p.blob).length)}
    <h2>Waiting (${q.length})</h2>
    ${q.map((i) => `<div class="card small"><b>${esc(i.type)}</b> ${esc(i.photo_id || i.box_id || i.log_id || '')}<br>tries ${i.tries || 0} · next ${when(i.next)}${i.error ? `<br><span style="color:var(--bad)">${esc(i.error)}</span>` : ''}</div>`).join('') || '<p class="muted">Nothing waiting.</p>'}
    <h2>Recent photos</h2>
    ${photos.map((p) => `<div class="card small"><b>${esc(p.name || '(waiting for an AWB)')}</b> · ${Math.round((p.bytes || 0) / 1024)} KB · ${esc(p.upload.state)}${p.upload.url ? ` · <a href="${esc(p.upload.url)}" target="_blank" rel="noopener">Drive</a>` : ''}${p.upload.error ? ` · ${esc(p.upload.error)}` : ''}</div>`).join('') || '<p class="muted">No photos yet.</p>'}
  </div>`);
  $('#retry').onclick = async () => { await app.uploader.retryNow(); render(); };
  wireShare();
}

// ---------------------------------------------------------------- export this phone's records for the office
// One text file (the records and photo checks on this phone, the upload queue, and on the TEST site the stand-in
// Sheet's tabs) and, optionally, every photo still on the phone. Works in every build (Supervisor > Uploads).
// Settings are reduced to what explains the run: never the station key, the PIN or its hash.
async function phoneDataFiles(withPhotos) {
  const h = app.harness, sheet = {};
  if (h) {
    for (const tab of ['TEST pre-booking', 'TEST boxes', 'Files', 'Station log', 'Pre-booking', 'Boxes']) { try { sheet[tab] = h.rows(tab); } catch { sheet[tab] = []; } }
    for (const tab of ['TEST check before pickup', 'Check before pickup']) { try { sheet[tab] = h.evalCheckTab(tab); } catch { sheet[tab] = []; } }
  }
  const records = [];
  for (const s of (await db.all('shipments')).sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const d = await R.load(s.id);
    if (!d) continue;
    records.push({
      record: d.s, boxes: d.boxes, next: R.nextStep(d.s, d.boxes).screen,
      photos: Object.values(d.byId).sort((a, b) => (a.captured_at || '').localeCompare(b.captured_at || '')).map((p) => ({
        name: p.name, kind: p.kind, box: p.box_n, nn: p.nn, bytes: p.bytes, size: `${p.width}x${p.height}`, captured_at: p.captured_at,
        checks: checksLine(p.checks), upload: p.upload && p.upload.state,
      })),
    });
  }
  const st = app.settings;
  const summary = {
    exported_at: isoLocal(), app: APP_VERSION, test_site: TEST_SITE, user_agent: navigator.userAgent,
    settings: { station: st.station, test: st.test, demo: st.demo, lock: st.lock, phoneMake: st.phoneMake, phoneModel: st.phoneModel, levels: st.levels },
    reader: { status: ocr.state.status, loadMs: ocr.state.loadMs, error: ocr.state.error }, barcode_engine: barcode.engine,
    queue_waiting: (await db.all('queue')).length, held_for_real_backend: app.heldReal || 0, backend: h ? 'TEST site stand-in' : 'real (Apps Script)', sheet, records,
  };
  const stamp = isoLocal().slice(0, 16).replace(/[-:T]/g, '');
  const files = [new File([JSON.stringify(summary, null, 1)], `packing-proof-${h ? 'test-' : ''}data-${stamp}.txt`, { type: 'text/plain' })];
  if (withPhotos) {
    for (const p of (await db.all('photos')).sort((a, b) => (a.captured_at || '').localeCompare(b.captured_at || ''))) {
      if (p.blob) files.push(new File([p.blob], p.name || `${p.shipment_id}-b${p.box_n || 0}-${p.kind}-${String(p.nn).padStart(2, '0')}-unnamed.jpg`, { type: 'image/jpeg' }));
    }
  }
  return files;
}

// The share menu (or, on a computer, a saved summary file).
async function shareData(withPhotos, out) {
  out.textContent = 'Preparing...';
  try {
    const files = await phoneDataFiles(withPhotos);
    if (navigator.canShare && navigator.canShare({ files })) {
      await navigator.share({ files, title: 'Packing Proof data', text: `Packing Proof data from ${app.settings.station}, ${files.length} file(s)` });
      out.textContent = 'Shared.';
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(files[0]); a.download = files[0].name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      out.textContent = 'This browser has no share menu: the summary was saved as a file.';
    }
  } catch (e) { out.textContent = e.name === 'AbortError' ? 'Not shared.' : 'Could not share: ' + e.message; }
}
const shareCard = (n) => `<div class="card"><b>Send this phone's records to the office</b><p class="small">A summary (the records on this phone, each photo's checks${app.harness ? ', the stand-in Sheet' : ''}) and the ${n} photos still on the phone, through the share menu: for example "Save to Drive" or email. Never the station key or the PIN.</p>
  <div class="row"><button class="primary" id="shareall">Share summary + photos</button><button id="sharesum">Share the summary only</button></div><div class="small muted" id="shareout"></div></div>`;
function wireShare() {
  const a = $('#shareall'), b = $('#sharesum');
  if (a) a.onclick = () => shareData(true, $('#shareout'));
  if (b) b.onclick = () => shareData(false, $('#shareout'));
}

// ---------------------------------------------------------------- TEST: what reached the (emulated) Drive and Sheet
// Only with the in-browser test backend (the TEST site, or ?harness=1 on a computer). It also stands in for the
// booking step, which is not part of the app: "Book" writes an AWB into a Pre-booking row, as the operator will.
async function screenDemo() {
  const h = app.harness;
  if (!h) return go('#/sup');
  const files = h.filesUnder('Packing Proof').map((f) => ({ f, path: h.pathOf(f.id) })).sort((a, b) => a.path.localeCompare(b.path));
  const folders = new Map();
  for (const x of files) { const dir = x.path.split('/').slice(0, -1).join('/'); if (!folders.has(dir)) folders.set(dir, []); folders.get(dir).push(x.f); }
  const urls = [];
  const thumb = (f) => { const u = URL.createObjectURL(new Blob([f.bytes], { type: 'image/jpeg' })); urls.push(u); return `<figure><img src="${u}" alt="" data-full="${u}"><figcaption>${esc(f.name)}<br>${Math.round(f.bytes.length / 1024)} KB</figcaption></figure>`; };
  const tbl = (rows, cols) => `<div class="tablewrap"><table><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>${rows.map((r) => `<tr>${cols.map((c) => `<td class="${['Flags', 'Checks'].includes(c) ? 'wrap' : ''}">${c === '' ? '' : esc(r[c])}</td>`).join('')}</tr>`).join('')}</table></div>`;
  const preTab = app.settings.test ? 'TEST pre-booking' : 'Pre-booking', boxTab = app.settings.test ? 'TEST boxes' : 'Boxes', chkTab = app.settings.test ? 'TEST check before pickup' : 'Check before pickup';
  const pre = h.rows(preTab), box = h.rows(boxTab).filter((r) => r['Box ID'] && !String(r['Box ID']).startsWith('SELFTEST'));
  let check = [];
  try { check = h.evalCheckTab(chkTab); } catch { check = []; }
  const preCols = ['Box ID', 'Box', 'Boxes', 'Status', 'Order no. (phone)', 'Order no.', 'AWB', 'Box AWB', 'Proof status', 'Flags', 'Checks'];
  const boxCols = ['Box ID', 'AWB', 'Box', 'Boxes', 'Status', 'Order no.', 'Slip check', 'Pre-booking box', 'Flags'];
  view(`<div class="bar"><a href="#/sup">&#8249;</a><h1>TEST: Drive and Sheet</h1></div><div class="adm">
    <div class="card warn">Test copies on this device only. Your real Google Drive and Sheets are not touched.</div>
    ${shareCard((await db.all('photos')).filter((p) => p.blob).length)}
    <h2>Book a measured parcel (stands in for the operator)</h2>
    <p class="small">Type the AWB of the courier label for a Pre-booking row, as the operator will paste it. Then photograph the parcel with the label stuck next to the slip: the app picks PROOF.</p>
    ${pre.filter((r) => !r['AWB'] && !r['Cancelled']).map((r) => `<div class="card small"><b>${esc(r['Box ID'])}</b> · box ${esc(r['Box'])} · order (phone) ${esc(r['Order no. (phone)'] || '-')}
      <div class="row" style="margin-top:6px"><button data-book="${esc(r['Box ID'])}">Book with an AWB</button><button data-bookown="${esc(r['Box ID'])}">Book with its own box AWB</button></div></div>`).join('') || '<p class="muted">No measured rows waiting for an AWB.</p>'}
    <h2>Sheet · ${esc(chkTab)} (${check.length})</h2>${check.length ? tbl(check, ['Box ID', 'AWB', 'Box AWB', 'Proof status', 'Status']) : '<p class="muted">Nothing to check before pickup.</p>'}
    <h2>Sheet · ${esc(preTab)} (${pre.length})</h2>${pre.length ? tbl(pre, preCols) : '<p class="muted">No rows yet.</p>'}
    <h2>Sheet · ${esc(boxTab)} (${box.length})</h2>${box.length ? tbl(box, boxCols) : '<p class="muted">No rows yet.</p>'}
    <h2>Drive: Packing Proof/ (${files.length} photos)</h2>
    ${[...folders].map(([dir, fs]) => `<div class="card"><b>${esc(dir)}/</b><div class="thumbs">${fs.map(thumb).join('')}</div></div>`).join('') || '<p class="muted">No photos yet.</p>'}
    <h2>Station log (${h.rows('Station log').length})</h2>${tbl(h.rows('Station log'), ['Logged', 'Type', 'Reading', 'Result', 'Notes'])}
    <button class="danger wide" id="reset" style="margin-top:22px">Start the test again (clears the test data on this device)</button>
  </div>`);
  app.cleanup = () => urls.forEach((u) => URL.revokeObjectURL(u));
  for (const img of document.querySelectorAll('.thumbs img')) img.onclick = () => modal(`<img src="${img.dataset.full}" alt="" style="width:100%;border-radius:10px"><div class="row"><button id="x">Close</button></div>`, (m, close) => { $('#x', m).onclick = () => close(); });
  wireShare();
  const book = async (boxId, own) => {
    const r = pre.find((x) => x['Box ID'] === boxId);
    const v = await askText(own ? "The box's own AWB" : 'The AWB booked for this parcel', 'As printed on the courier label (the demo camera prints the demo AWB).', { placeholder: app.settings.demoScene.awb || DEMO_AWB, check: (x) => (AWB_OK.test(normCode(x)) ? '' : '6-20 letters or digits') });
    if (!v) return;
    const awb = normCode(v);
    let master = awb;
    if (own) {   // per-box AWBs: the order's AWB is box 1's
      const m = await askText("The order's AWB (box 1's)", 'Every box row of the order carries it.', { placeholder: awb, check: (x) => (AWB_OK.test(normCode(x)) ? '' : '6-20 letters or digits') });
      if (!m) return;
      master = normCode(m);
    }
    await h.bookPre(app.settings.test, boxId, { awb: master, boxAwb: own ? awb : '', order: r['Order no. (phone)'] || '' });
    if (app.settings.demo) await saveSettings({ demoScene: { ...app.settings.demoScene, paper: 'label', awb, order: r['Order no. (phone)'] || app.settings.demoScene.order || DEMO_ORDER } });
    toast(`Booked: ${boxId} · AWB ${awb}`, 'go');
    render();
  };
  for (const el of document.querySelectorAll('[data-book]')) el.onclick = () => book(el.dataset.book, false);
  for (const el of document.querySelectorAll('[data-bookown]')) el.onclick = () => book(el.dataset.bookown, true);
  $('#reset').onclick = async () => {
    const ok = await modal('<h3>Start the test again?</h3><p>This clears the test records, photos and the stand-in Sheet on this device. Nothing else.</p><div class="row"><button id="no">Keep them</button><button class="danger" id="yes">Clear and restart</button></div>',
      (m, close) => { $('#no', m).onclick = () => close(false); $('#yes', m).onclick = () => close(true); });
    if (!ok) return;
    await h.reset();
    await db.wipe();
    location.hash = '#/';
    location.reload();
  };
}

// ---------------------------------------------------------------- uploads, housekeeping, start
function onQ(state) {
  app.q = state;
  const el = $('#waitline');
  if (el) { const w = state.pending ? t('waiting', { n: state.pending }) : t('all_sent'); el.innerHTML = `${esc(w.hi)} · <span lang="en">${esc(w.en)}</span>`; }
}

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

// The TEST site replaces the real build at the same address. A phone that ran the real build keeps that setup (backend
// URL, station key, PIN) and its waiting uploads aside, untouched, so the stand-in backend never receives them; the next
// real build puts them back and sends them.
async function holdReal() {
  const st = app.settings, q = await db.all('queue'), old = await db.getKV('real-held', null);
  await db.setKV('real-held', {
    at: isoLocal(), settings: { scriptUrl: st.scriptUrl, key: st.key, station: st.station, test: st.test, pinHash: st.pinHash || '', pinSalt: st.pinSalt || '' },
    queue: [...((old && old.queue) || []), ...q],
  });
  for (const i of q) await db.del('queue', i.seq);
  await saveSettings({ setupDone: false });
}
async function restoreReal() {
  const held = await db.getKV('real-held', null);
  if (!held) return;
  for (const i of held.queue || []) { const { seq, ...item } = i; await db.put('queue', item); }
  if (!app.settings.scriptUrl || app.settings.scriptUrl === HARNESS_URL) await saveSettings({ ...held.settings, setupDone: true });
  await db.del('kv', 'real-held');
}

function registerSW() {
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if (!('serviceWorker' in navigator) || local) return;
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

async function boot() {
  const qs = new URLSearchParams(location.search);
  // tests only: start from an empty phone and an empty stand-in Drive/Sheet (never on a real backend)
  if (qs.has('fresh') && (TEST_SITE || qs.has('harness'))) {
    await db.wipe();
    try { await (await import(TEST_BACKEND)).reset(); } catch { /* no test backend */ }
  }
  app.settings = await loadSettings();
  app.sound = sound;
  if (qs.has('demo')) await saveSettings({ demo: qs.get('demo') !== '0', test: true });
  if (TEST_SITE || qs.has('harness')) {
    // TEST site / computer demo: uploads go to an emulator of the Apps Script, Drive and Sheet in this browser.
    try {
      if (app.settings.setupDone && app.settings.scriptUrl && app.settings.scriptUrl !== HARNESS_URL) await holdReal();
      const h = await import(TEST_BACKEND);
      await h.load({ persist: true });
      transport.post = h.post; app.harness = h;
      if (!app.settings.setupDone) {
        await saveSettings({
          scriptUrl: HARNESS_URL, key: h.state.key, station: 'Test station', test: true, setupDone: true, pinHash: '', pinSalt: '', lock: '',
          phoneModel: app.settings.phoneModel || (app.settings.demo ? 'Demo phone' : ''),
        });
      }
    } catch (e) { console.warn('test harness not loaded', e); }
  } else await restoreReal();
  const held = await db.getKV('real-held', null);
  app.heldReal = held && held.queue ? held.queue.length : 0;
  db.persist();
  sound.unlock();
  app.uploader = new Uploader(async () => app.settings, onQ);
  window.addEventListener('online', () => app.uploader.kick());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    app.uploader.kick();
    // back from the camera app with no photo (cancelled, or Android closed this page meanwhile)
    if (pickAt) {
      const at = pickAt;
      setTimeout(() => { if (pickAt === at) { pickAt = 0; const w = t('no_photo'); toast(`${w.hi} · ${w.en}`, 'bad'); } }, 3000);
    }
  });
  $('#fcam').onchange = (ev) => gotFile(ev.target.files[0], 'camera app');
  window.addEventListener('hashchange', render);
  setInterval(() => app.uploader.kick(), 30000);
  prune().catch(() => {});
  registerSW();
  await render();
  app.uploader.kick();
  if (navigator.onLine && !qs.has('noocr')) setTimeout(() => ocr.warm(), 1500);
}

boot();
