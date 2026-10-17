// Test harness: runs apps-script/Code.gs in the browser against an in-memory Drive + Sheets, so the app's real
// payloads can be checked end to end before anything is deployed. Not part of the published app.
// Usage: app/index.html?harness=1 (the uploader then posts here instead of to Apps Script), or tests/index.html.

const FOLDER = 'application/vnd.google-apps.folder';
const SHEET = 'application/vnd.google-apps.spreadsheet';

// ---------------------------------------------------------------- SHA-256 (sync, like Utilities.computeDigest)
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
export function sha256(bytes) {
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const l = bytes.length, n = Math.ceil((l + 9) / 64) * 64, m = new Uint8Array(n);
  m.set(bytes); m[l] = 0x80;
  const dv = new DataView(m.buffer);
  dv.setUint32(n - 4, (l * 8) >>> 0); dv.setUint32(n - 8, Math.floor((l * 8) / 2 ** 32));
  const w = new Uint32Array(64);
  const rot = (x, r) => (x >>> r) | (x << (32 - r));
  for (let o = 0; o < n; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rot(w[i - 15], 7) ^ rot(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = rot(w[i - 2], 17) ^ rot(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  const out = new Uint8Array(32), ov = new DataView(out.buffer);
  H.forEach((x, i) => ov.setUint32(i * 4, x));
  return out;
}

// ---------------------------------------------------------------- fake Drive
export const state = { files: new Map(), sheets: new Map(), props: new Map(), cache: new Map(), key: '', logs: [], calls: [] };
let seq = 0;
const newId = () => 'id' + String(++seq).padStart(5, '0');

function parseQ(q) {
  const out = {};
  for (const part of q.split(/\s+and\s+/)) {
    let m;
    if ((m = part.match(/^'((?:\\.|[^'])*)' in parents$/))) out.parent = m[1].replace(/\\(.)/g, '$1');
    else if ((m = part.match(/^name = '((?:\\.|[^'])*)'$/))) out.name = m[1].replace(/\\(.)/g, '$1');
    else if ((m = part.match(/^mimeType = '([^']*)'$/))) out.mime = m[1];
    else if (/^trashed = false$/.test(part)) out.notTrashed = true;
    else throw new Error('harness cannot parse query part: ' + part);
  }
  return out;
}
function view(f) {
  return { id: f.id, name: f.name, mimeType: f.mimeType, size: f.bytes ? String(f.bytes.length) : undefined, description: f.description, parents: f.parents, trashed: f.trashed };
}
const Drive = {
  Files: {
    list(args) {
      state.calls.push(['Drive.list', args.q]);
      const q = parseQ(args.q);
      const files = [...state.files.values()].filter((f) => (!q.parent || f.parents.includes(q.parent)) && (!q.name || f.name === q.name) &&
        (!q.mime || f.mimeType === q.mime) && (!q.notTrashed || !f.trashed)).map(view);
      return { files };
    },
    create(resource, blob) {
      state.calls.push(['Drive.create', resource.name]);
      for (const p of resource.parents || []) if (!state.files.has(p)) throw new Error('File not found: ' + p);
      const f = { id: newId(), name: resource.name, mimeType: resource.mimeType || (blob && blob.type) || 'application/octet-stream',
        parents: resource.parents || ['root'], description: resource.description || '', bytes: blob ? blob.bytes : null, trashed: false };
      state.files.set(f.id, f);
      if (f.mimeType === SHEET) state.sheets.set(f.id, { tabs: [{ gid: 0, title: 'Sheet1', grid: [], frozen: 0, bold: false }] });
      return view(f);
    },
    get(id) {
      const f = state.files.get(id);
      if (!f) throw new Error('File not found: ' + id);
      return view(f);
    },
  },
};

// ---------------------------------------------------------------- fake Sheets
function colNum(s) { let n = 0; for (const c of s) n = n * 26 + (c.charCodeAt(0) - 64); return n; }
function parseRange(r) {
  const m = r.match(/^'((?:''|[^'])*)'!(.*)$/);
  if (!m) throw new Error('harness range: ' + r);
  const tab = m[1].replace(/''/g, "'"), a1 = m[2];
  let x;
  if ((x = a1.match(/^([A-Z]+):([A-Z]+)$/))) return { tab, r0: 1, c0: colNum(x[1]), r1: Infinity, c1: colNum(x[2]) };
  if ((x = a1.match(/^(\d+):(\d+)$/))) return { tab, r0: +x[1], c0: 1, r1: +x[2], c1: Infinity };
  if ((x = a1.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/))) return { tab, r0: +x[2], c0: colNum(x[1]), r1: +x[4], c1: colNum(x[3]) };
  if ((x = a1.match(/^([A-Z]+)(\d+)$/))) return { tab, r0: +x[2], c0: colNum(x[1]), r1: +x[2], c1: colNum(x[1]) };
  throw new Error('harness A1: ' + a1);
}
function tabOf(id, title) {
  const ss = state.sheets.get(id);
  if (!ss) throw new Error('Requested entity was not found (spreadsheet ' + id + ')');
  const t = ss.tabs.find((x) => x.title === title);
  if (!t) throw new Error('Unable to parse range: ' + title);
  return t;
}
function write(t, r0, c0, values) {
  values.forEach((row, i) => {
    const r = r0 - 1 + i;
    while (t.grid.length <= r) t.grid.push([]);
    row.forEach((v, j) => { t.grid[r][c0 - 1 + j] = v; });
  });
}
const Sheets = {
  Spreadsheets: {
    get(id) {
      const ss = state.sheets.get(id);
      return { sheets: ss.tabs.map((t, i) => ({ properties: { sheetId: t.gid, title: t.title, index: i } })) };
    },
    batchUpdate(res, id) {
      const ss = state.sheets.get(id), replies = [];
      for (const r of res.requests) {
        if (r.addSheet) {
          const t = { gid: ss.tabs.length * 1000 + 7, title: r.addSheet.properties.title, grid: [], frozen: 0, bold: false };
          ss.tabs.push(t); replies.push({ addSheet: { properties: { sheetId: t.gid, title: t.title } } });
        } else if (r.updateSheetProperties) {
          const p = r.updateSheetProperties.properties, t = ss.tabs.find((x) => x.gid === p.sheetId);
          if (p.title) t.title = p.title;
          if (p.gridProperties) t.frozen = p.gridProperties.frozenRowCount;
          replies.push({});
        } else if (r.repeatCell) {
          ss.tabs.find((x) => x.gid === r.repeatCell.range.sheetId).bold = true; replies.push({});
        } else throw new Error('harness batchUpdate: ' + Object.keys(r));
      }
      return { replies };
    },
    Values: {
      get(id, range, opts = {}) {
        const { tab, r0, c0, r1, c1 } = parseRange(range), t = tabOf(id, tab);
        const fmt = opts.valueRenderOption !== 'UNFORMATTED_VALUE';
        const rows = [];
        for (let r = r0 - 1; r < Math.min(t.grid.length, r1); r++) {
          const src = t.grid[r] || [], row = [];
          for (let c = c0 - 1; c < Math.min(src.length, c1); c++) row.push(src[c] === undefined ? '' : fmt ? String(src[c]) : src[c]);
          while (row.length && row[row.length - 1] === '') row.pop();
          rows.push(row);
        }
        while (rows.length && !rows[rows.length - 1].length) rows.pop();
        return rows.length ? { values: rows } : {};
      },
      update(res, id, range) {
        const { tab, r0, c0 } = parseRange(range);
        write(tabOf(id, tab), r0, c0, res.values);
        return {};
      },
      append(res, id, range) {
        const { tab } = parseRange(range), t = tabOf(id, tab);
        let last = t.grid.length;
        while (last > 0 && !(t.grid[last - 1] || []).some((v) => v !== undefined && v !== '')) last--;
        write(t, last + 1, 1, res.values);
        return {};
      },
    },
  },
};

// ---------------------------------------------------------------- the rest of the Apps Script globals
const signed = (u8) => Array.from(u8, (b) => (b > 127 ? b - 256 : b));
const unsigned = (arr) => Uint8Array.from(arr, (b) => (b < 0 ? b + 256 : b));
const Utilities = {
  DigestAlgorithm: { SHA_256: 'SHA_256' },
  Charset: { UTF_8: 'UTF_8' },
  base64Decode(s) { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return signed(u); },
  computeDigest(alg, data) {
    if (alg !== 'SHA_256') throw new Error('harness digest ' + alg);
    return signed(sha256(typeof data === 'string' ? new TextEncoder().encode(data) : unsigned(data)));
  },
  newBlob(bytes, type, name) { return { bytes: unsigned(bytes), type, name }; },
  getUuid() { return crypto.randomUUID(); },
  formatDate(d, tz, fmt) {
    if (tz !== 'Asia/Kolkata') throw new Error('harness tz ' + tz);
    const t = new Date(d.getTime() + 330 * 60000), p = (n) => String(n).padStart(2, '0');
    const parts = { yyyy: t.getUTCFullYear(), MM: p(t.getUTCMonth() + 1), dd: p(t.getUTCDate()), HH: p(t.getUTCHours()), mm: p(t.getUTCMinutes()), ss: p(t.getUTCSeconds()) };
    return fmt.replace(/yyyy|MM|dd|HH|mm|ss/g, (k) => parts[k]);
  },
  sleep() {},
};
const ContentService = {
  MimeType: { JSON: 'JSON' },
  createTextOutput(text) { return { text, setMimeType() { return this; }, getContent() { return text; } }; },
};
const LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) };
// Tests set state.urlfetch = (url, opts) => ({status, body}) to answer the script's call to the Anthropic API.
const UrlFetchApp = {
  fetch(url, opts) {
    if (!state.urlfetch) throw new Error('harness: no UrlFetchApp stub set');
    const r = state.urlfetch(url, opts);
    return { getResponseCode: () => r.status, getContentText: () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) };
  },
};
const PropertiesService = { getScriptProperties: () => ({ getProperty: (k) => state.props.get(k) ?? null, setProperty: (k, v) => state.props.set(k, String(v)) }) };
const CacheService = { getScriptCache: () => ({ get: (k) => state.cache.get(k) ?? null, put: (k, v) => state.cache.set(k, v), remove: (k) => state.cache.delete(k) }) };
const harnessConsole = {
  log: (...a) => { const s = a.join(' '); state.logs.push(s); const m = s.match(/STATION KEY[^:]*: (\S+)/); if (m) state.key = m[1]; },
  warn: (...a) => state.logs.push('WARN ' + a.join(' ')),
  error: (...a) => state.logs.push('ERROR ' + a.join(' ')),
};

// ---------------------------------------------------------------- demo persistence (the app's demo keeps its fake Drive)
const DBN = 'pp-harness';
let persist = false;
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DBN, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('s');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function saveState() {
  const db = await idb();
  const snap = { files: [...state.files.values()], sheets: [...state.sheets.entries()], props: [...state.props.entries()], seq };
  await new Promise((res, rej) => { const tx = db.transaction('s', 'readwrite'); tx.objectStore('s').put(snap, 'state'); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
}
async function restoreState() {
  const db = await idb();
  const snap = await new Promise((res) => { const r = db.transaction('s').objectStore('s').get('state'); r.onsuccess = () => res(r.result || null); r.onerror = () => res(null); });
  if (!snap) return false;
  state.files = new Map(snap.files.map((f) => [f.id, f]));
  state.sheets = new Map(snap.sheets);
  state.props = new Map(snap.props);
  seq = snap.seq;
  return true;
}
// Forget the demo's fake Drive, Sheet and key (demo data on this computer only).
export async function reset() {
  const db = await idb();
  await new Promise((res) => { const tx = db.transaction('s', 'readwrite'); tx.objectStore('s').delete('state'); tx.oncomplete = res; tx.onerror = res; });
  try { localStorage.removeItem('pp-harness-key'); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- load Code.gs
let gas = null;
// opts.persist: keep the fake Drive/Sheet in IndexedDB across reloads (the app's demo). Tests start fresh.
export async function load(opts = {}) {
  if (gas) return gas;
  const src = new URL('../apps-script/Code.gs', import.meta.url);
  const code = await (await fetch(src, { cache: 'no-store' })).text();
  const factory = new Function('Drive', 'Sheets', 'Utilities', 'ContentService', 'LockService', 'PropertiesService', 'CacheService', 'UrlFetchApp', 'console',
    code + '\nreturn { doPost: doPost, doGet: doGet, setup: setup, newStationKey: newStationKey, PP: PP, BOX_COLS: BOX_COLS,' +
    ' buildReadRequest_: buildReadRequest_, parseReadResponse_: parseReadResponse_ };');
  gas = factory(Drive, Sheets, Utilities, ContentService, LockService, PropertiesService, CacheService, UrlFetchApp, harnessConsole);
  persist = !!opts.persist;
  const restored = persist && await restoreState().catch(() => false);
  // The script's own folder exists only after setup(); Drive's "root" is implicit.
  if (!restored) state.files.set('root', { id: 'root', name: 'My Drive', mimeType: FOLDER, parents: [], description: '', bytes: null, trashed: false });
  gas.setup();   // idempotent: on a restored Drive it finds the folder, Sheet and key that are already there
  // Keep one test key across page reloads (the fake Drive itself starts empty on every load).
  try {
    const kept = localStorage.getItem('pp-harness-key');
    if (kept) {
      state.key = kept;
      const norm = kept.toLowerCase().replace(/[^a-z0-9]/g, '');
      state.props.set('STATION_KEY_SHA256', Array.from(sha256(new TextEncoder().encode(norm)), (x) => x.toString(16).padStart(2, '0')).join(''));
    } else localStorage.setItem('pp-harness-key', state.key);
  } catch { /* no storage: one key per load */ }
  if (persist) await saveState();
  return gas;
}

// The test site's reader. The real backend calls the Anthropic API from Apps Script with a key in Script
// Properties; here the same request is built and parsed by Code.gs, but sent from the browser with a key typed
// on this device (Settings, test site only). Without a key there is no reader (the numbers are read later), except
// in the computer demo, whose "demo reader" answers the drawn camera with the values it drew.
let readerKey = '', demoReader = false;
export function setReaderKey(k) { readerKey = String(k || '').trim(); }
export function hasReaderKey() { return !!readerKey; }
export function setDemoReader(on) { demoReader = !!on; }

async function readAsync(g, payload) {
  const auth = JSON.parse(g.doPost({ postData: { contents: JSON.stringify({ v: 1, key: payload.key, action: 'ping' }) } }).getContent());
  if (!auth.ok) return auth;   // same station-key check as every other action
  if (readerKey) {
    const r = g.buildReadRequest_(payload, 'claude-opus-5-5', 'medium');
    let res, json = null;
    try {
      res = await fetch(r.url, {
        method: 'POST', body: JSON.stringify(r.body),
        headers: { ...r.headers, 'content-type': 'application/json', 'x-api-key': readerKey, 'anthropic-dangerous-direct-browser-access': 'true' },
      });
      json = await res.json().catch(() => null);
    } catch (e) { return { ok: false, code: 'network', error: String((e && e.message) || e) }; }
    if (res.status === 401 || res.status === 403) return { ok: false, code: 'reader_key', error: 'the Anthropic API key was refused' };
    if (res.status === 429 || res.status >= 500) return { ok: false, code: 'reader_busy', error: `the reader is busy (HTTP ${res.status}); try again` };
    if (!res.ok) return { ok: false, code: 'reader_error', error: `HTTP ${res.status}: ${String((json && json.error && json.error.message) || '').slice(0, 200)}` };
    return g.parseReadResponse_(payload.kind, json);
  }
  const t = payload.demo_truth;
  if (t && demoReader) {
    await new Promise((r) => setTimeout(r, 700));
    const base = String(payload.kind).replace(/^measure-/, '');
    const values = base === 'scale' ? { weight: t.weight } : base === 'length-height' ? { length: t.length, height: t.height } : { b1: t.breadth, b2: t.breadth };
    const confidence = base === 'scale' ? { weight: 'high' } : base === 'length-height' ? { length: 'high', height: 'high' } : { breadth: 'high' };
    return { ok: true, kind: base, values, confidence, flags: {}, notes: 'demo camera: drawn values', model: 'demo' };
  }
  return { ok: false, code: 'no_reader', error: 'No AI key on this test site (Settings) - the numbers are read later' };
}

// Same shape as uploader.postJSON: the request goes through JSON exactly as it would over HTTP.
export async function post(url, payload) {
  const g = await load();
  if (payload && payload.action === 'read' && !state.syncReader) return readAsync(g, payload);
  await new Promise((r) => setTimeout(r, 5));
  const out = g.doPost({ postData: { contents: JSON.stringify(payload), type: 'text/plain' } });
  if (persist) await saveState();
  const res = JSON.parse(out.getContent());
  // The test site's reader is the key typed on this device (or the demo reader), not a Script Property.
  if (payload && payload.action === 'ping' && res.ok && !res.reader) res.reader = hasReaderKey() || demoReader;
  return res;
}

// Inspection helpers for tests.
export function tab(title) {
  const id = state.props.get('SHEET_ID');
  return state.sheets.get(id).tabs.find((t) => t.title === title);
}
export function rows(title) {
  const t = tab(title);
  if (!t || !t.grid.length) return [];
  const head = t.grid[0];
  return t.grid.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] === undefined ? '' : r[i]])));
}
export function pathOf(id) {
  const out = [];
  let f = state.files.get(id);
  while (f && f.id !== 'root') { out.unshift(f.name); f = state.files.get(f.parents[0]); }
  return out.join('/');
}
export function filesUnder(name) {
  return [...state.files.values()].filter((f) => f.mimeType !== FOLDER && f.mimeType !== SHEET && pathOf(f.id).startsWith(name));
}
