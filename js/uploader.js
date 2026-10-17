// The upload queue: sends photos, Sheet rows and station-log entries to the Apps Script, one at a time,
// oldest first. Nothing is lost offline: items wait in IndexedDB and retry with back-off.
// Wire format: POST, Content-Type text/plain (no CORS pre-flight), body = JSON. The reply is JSON.
import * as db from './store.js';
import { APP_VERSION } from './config.js';
import { rowSnapshot, nextNn, listFor, upgradeBox, stageOf } from './records.js';
import { photoName, prePhotoName, isoLocal } from './logic.js';

export function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(',')[1] || '');
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(blob);
  });
}

export async function sha256Hex(blob) {
  const h = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(h), (x) => x.toString(16).padStart(2, '0')).join('');
}

// Default transport: fetch to the Apps Script /exec URL. Tests swap in the local harness.
export async function postJSON(url, payload, timeoutMs = 120000) {
  const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST', body: JSON.stringify(payload), redirect: 'follow', cache: 'no-store', signal: ctrl.signal,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch { throw new Error(`reply was not JSON (HTTP ${res.status}): ${text.slice(0, 120)}`); }
  } finally { clearTimeout(t); }
}

export const transport = { post: postJSON };

const backoff = (tries) => Math.min(10 * 60000, 15000 * 2 ** Math.max(0, tries - 1));

export class Uploader {
  constructor(getSettings, onState) {
    this.getSettings = getSettings;
    this.onState = onState || (() => {});
    this.busy = false; this.again = false;
    this.state = { pending: 0, sending: '', error: '', paused: '', lastOk: null };
  }

  report() { this.onState({ ...this.state }); }

  async kick() {
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    try {
      do { this.again = false; await this.drain(); } while (this.again);
    } catch (e) {
      this.state.error = String((e && e.message) || e);
    } finally {
      this.busy = false; this.state.sending = ''; this.report();
    }
  }

  async retryNow() {
    for (const i of await db.all('queue')) if (i.next) await db.put('queue', { ...i, next: 0 });
    this.state.paused = '';
    return this.kick();
  }

  async drain() {
    const st = await this.getSettings();
    this.state.paused = !st.scriptUrl ? 'No backend URL yet (Settings)' : !st.key ? 'No station key yet (Settings)' : '';
    for (;;) {
      const items = (await db.all('queue')).sort((a, b) => a.seq - b.seq);
      this.state.pending = items.length;
      this.report();
      if (this.state.paused || !items.length) return;
      if (!navigator.onLine) { this.state.error = 'Offline - photos wait on the phone'; return; }
      const now = Date.now(), item = items.find((i) => (i.next || 0) <= now);
      if (!item) return;
      const r = await this.process(item, st);
      if (r === 'stop') return;
    }
  }

  async fail(item, msg) {
    const tries = (item.tries || 0) + 1;
    await db.put('queue', { ...item, tries, next: Date.now() + backoff(tries), error: msg });
    this.state.error = msg;
  }

  base(st, test) {
    return { v: 1, key: st.key, station: st.station, app: APP_VERSION, phone: st.phoneModel || '', test: !!test };
  }

  async send(st, payload) {
    try { return await transport.post(st.scriptUrl, payload); }
    catch (e) { return { ok: false, code: 'network', error: e.name === 'AbortError' ? 'timed out' : String((e && e.message) || e) }; }
  }

  async handleReply(item, r) {
    if (r && r.ok) { await db.del('queue', item.seq); this.state.error = ''; this.state.lastOk = isoLocal(); return 'done'; }
    if (r && r.code === 'bad_key') { this.state.paused = 'Station key refused - fix it in Settings'; return 'stop'; }
    const why = r && r.code === 'network' ? `Cannot reach the backend (${r.error})` : `Backend said: ${(r && (r.error || r.code)) || 'no reply'}`;
    await this.fail(item, why);
    return 'retry';
  }

  async process(item, st) {
    if (item.type === 'log') {
      const entry = await db.get('logs', item.log_id);
      if (!entry) { await db.del('queue', item.seq); return 'done'; }
      this.state.sending = `station log (${entry.type})`; this.report();
      const r = await this.send(st, { ...this.base(st, entry.test), action: 'log', entry });
      const out = await this.handleReply(item, r);
      if (out === 'done') await db.put('logs', { ...entry, sent: isoLocal() });
      return out;
    }

    const sid = item.type === 'photo' ? ((await db.get('photos', item.photo_id)) || {}).shipment_id : item.shipment_id;
    const s = sid && (await db.get('shipments', sid));
    if (!s) { await db.del('queue', item.seq); return 'done'; }
    const boxes = (await db.byIndex('boxes', 'shipment', s.id)).map(upgradeBox).sort((a, b) => a.n - b.n);
    const photos = await db.byIndex('photos', 'shipment', s.id);
    const byId = Object.fromEntries(photos.map((p) => [p.id, p]));

    if (item.type === 'row') {
      const b = boxes.find((x) => x.id === item.box_id);
      if (!b) { await db.del('queue', item.seq); return 'done'; }
      this.state.sending = `Sheet row, box ${b.n}`; this.report();
      const r = await this.send(st, { ...this.base(st, s.test), action: 'row', rows: [rowSnapshot(s, b, byId)] });
      return this.handleReply(item, r);
    }

    // photo
    const p = byId[item.photo_id];
    if (!p || !p.name || !p.blob || (p.upload && p.upload.state === 'done')) { await db.del('queue', item.seq); return 'done'; }
    const b = p.box_id ? boxes.find((x) => x.id === p.box_id) : null;
    const list = listFor(s, b, p.kind);
    const rows = (p.kind === 'boxes' ? boxes : [b]).map((x) => rowSnapshot(s, x, byId));
    const measure = stageOf(s) === 'measure';
    this.state.sending = p.name; this.report();
    // MEASURE photos are named by record and filed by day; PROOF photos by AWB and month (the month the record
    // started, so an order's photos stay together).
    const payload = {
      ...this.base(st, s.test), action: 'photo', upload_id: p.id, name: p.name, stage: measure ? 'measure' : 'proof', record: s.id,
      awb: measure ? '' : s.awb, month: s.month || (s.awb_at || s.created_at || '').slice(0, 7), day: s.day || (s.created_at || '').slice(0, 10),
      box: p.box_n, boxes: s.boxes.length, kind: p.kind, nn: p.nn, final: list[list.length - 1] === p.id,
      captured_at: p.captured_at, bytes: p.blob.size, sha256: await sha256Hex(p.blob),
      jpeg_b64: await blobToBase64(p.blob), rows,
    };
    const r = await this.send(st, payload);
    if (r && r.ok) {
      p.upload = { ...p.upload, state: 'done', url: (r.file && r.file.url) || '', file_id: (r.file && r.file.id) || '', at: isoLocal(), skipped: !!r.skipped };
      await db.put('photos', p);
      return this.handleReply(item, r);
    }
    if (r && r.code === 'name_taken') {
      // Another file already has this name in Drive (never overwritten): take the next free number and resend.
      const nn = Math.max(nextNn(list, byId), p.nn + 1, (r.next_nn || 0));
      if (nn > 99) { await this.fail(item, 'No free photo number left for ' + p.name); return 'retry'; }
      p.nn = nn;
      p.name = measure ? prePhotoName({ record: s.id, box: p.box_n, kind: p.kind, nn }) : photoName({ awb: s.awb, box: p.box_n, boxes: s.boxes.length, kind: p.kind, nn });
      await db.put('photos', p);
      return 'retry-now';
    }
    p.upload = { ...p.upload, state: 'error', tries: (p.upload.tries || 0) + 1, error: (r && (r.error || r.code)) || '' };
    await db.put('photos', p);
    return this.handleReply(item, r);
  }
}
