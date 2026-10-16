/**
 * TFC Packing Proof - backend. A Google Apps Script web app that runs as thefluco@gmail.com.
 *
 * The station phone POSTs JSON as text/plain (no CORS pre-flight). Every request carries the station key,
 * which is typed once on the phone; only its SHA-256 is stored here (Script Properties), never the key.
 *
 *   action "ping"  - checks the key; returns the Drive folder and Sheet links (the phone's "Test connection")
 *   action "photo" - saves one JPEG to Drive  Packing Proof/<YYYY-MM>/<AWB>/   (TEST: Packing Proof/TEST/...)
 *                    and updates the box row(s) in the "Packing Proof" Sheet
 *   action "row"   - updates box row(s) only (readings, numbers to book, AWB, status, times)
 *   action "log"   - appends a station-log row (start of shift, the Monday 10 kg scale test)
 *
 * Drive rules: it only CREATES. It never moves, renames, overwrites or deletes anything. A name that already
 * exists is skipped (same upload) or refused with code "name_taken" (the phone then uses the next number).
 *
 * Scope: drive.file only - the script can see just the folders and files it created itself.
 * One-time setup: run setup() in the editor (creates the folder, the TEST folder, the Sheet and the station key),
 * then Deploy > New deployment > Web app, Execute as: Me, Who has access: Anyone. See README.md.
 */

var PP = {
  VERSION: '1.0.0',
  ROOT_NAME: 'Packing Proof',
  TEST_NAME: 'TEST',
  SHEET_NAME: 'Packing Proof',
  TAB_LIVE: 'Boxes',
  TAB_TEST: 'TEST boxes',
  TAB_FILES: 'Files',
  TAB_LOG: 'Station log',
  MAX_BYTES: 2000000,
  TZ: 'Asia/Kolkata',
  FOLDER_MIME: 'application/vnd.google-apps.folder',
  SHEET_MIME: 'application/vnd.google-apps.spreadsheet',
};

var NAME_RE = /^([A-Z0-9]{6,20})(?:-b(\d{1,2}))?-ours-(label|scale|length-height|breadth|boxes)-(\d{2})\.jpg$/;
var KIND_COLS = { 'label': 'Label', 'breadth': 'Breadth', 'length-height': 'Length-height', 'scale': 'Scale', 'boxes': 'Boxes' };

// ------------------------------------------------------------------ the Sheet's columns
// [header, value from (row snapshot, request)] - undefined keeps what the cell already holds.
function num_(v) {
  if (v === null || v === undefined || v === '') return '';
  var n = Number(String(v).replace(',', '.'));
  return isFinite(n) ? n : String(v);
}
function ist_(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  return isNaN(d.getTime()) ? String(iso) : Utilities.formatDate(d, PP.TZ, 'yyyy-MM-dd HH:mm:ss');
}
function photoUrl_(kind) {
  return function (s) { var p = s.photos && s.photos[kind]; return p && p.url ? p.url : undefined; };
}
function photoChecks_(kind) {
  return function (s) { var p = s.photos && s.photos[kind]; return p ? p.checks || '' : undefined; };
}
function finals_(s) {
  var out = [];
  Object.keys(KIND_COLS).forEach(function (k) { var p = s.photos && s.photos[k]; if (p && p.final) out.push(p.final); });
  return out.join(' | ');
}
function retakes_(s) {
  var out = [];
  Object.keys(KIND_COLS).forEach(function (k) { var p = s.photos && s.photos[k]; if (p && p.retakes) out = out.concat(p.retakes); });
  return out.join(' | ');
}
function rd_(f) { return function (s) { return num_(s.readings && s.readings[f]); }; }
function bk_(f) { return function (s) { return num_(s.book && s.book[f]); }; }

var BOX_COLS = [
  ['Box ID', function (s) { return s.box_id; }],
  ['Shipment ID', function (s) { return s.shipment_id; }],
  ['AWB', function (s) { return s.awb || ''; }],
  ['Box', function (s) { return s.box; }],
  ['Boxes', function (s) { return s.boxes; }],
  ['Status', function (s) { return s.status || ''; }],
  ['Order ref', function (s) { return s.order_ref || ''; }],
  ['Weight kg', rd_('weight')], ['Length cm', rd_('length')], ['Breadth cm', rd_('breadth')], ['Height cm', rd_('height')],
  ['Book weight kg', bk_('weight')], ['Book L cm', bk_('length')], ['Book B cm', bk_('breadth')], ['Book H cm', bk_('height')],
  ['Label photo', photoUrl_('label')], ['Breadth photo', photoUrl_('breadth')], ['Length-height photo', photoUrl_('length-height')],
  ['Scale photo', photoUrl_('scale')], ['Boxes photo', photoUrl_('boxes')],
  ['Checks label', photoChecks_('label')], ['Checks breadth', photoChecks_('breadth')], ['Checks length-height', photoChecks_('length-height')],
  ['Checks scale', photoChecks_('scale')], ['Checks boxes', photoChecks_('boxes')],
  ['Final files', finals_], ['Retakes', retakes_],
  ['Label codes read', function (s) { return s.label_codes || ''; }],
  ['AWB source', function (s) { return s.awb_source || ''; }],
  ['Re-measured', function (s) { return s.remeasured || ''; }],
  ['Created', function (s) { return ist_(s.created_at); }],
  ['Readings typed', function (s) { return ist_(s.readings_at); }],
  ['Booked', function (s) { return ist_(s.booked_at); }],
  ['Label scanned', function (s) { return ist_(s.label_at); }],
  ['Complete', function (s) { return ist_(s.completed_at); }],
  ['Cancelled', function (s) { return s.cancelled || ''; }],
  ['Last update', function () { return ist_(new Date().toISOString()); }],
  ['Station', function (s, req) { return s.station || req.station || ''; }],
  ['Phone', function (s, req) { return req.phone || ''; }],
  ['App', function (s, req) { return req.app || ''; }],
  ['Team notes', function () { return undefined; }],   // people type here; the script never writes it
];
var FILE_COLS = ['Uploaded', 'Test', 'AWB', 'Box', 'Kind', 'No.', 'File', 'Link', 'Bytes', 'Final when uploaded', 'Captured', 'Station', 'Phone', 'Upload ID'];
var LOG_COLS = ['Logged', 'Test', 'Station', 'Type', 'Reading', 'Result', 'Notes', 'Phone', 'App', 'Entry ID'];

// ------------------------------------------------------------------ web app entry points
function doGet() {
  return reply_({ ok: true, service: 'tfc-packing-proof', version: PP.VERSION });
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '');
  } catch (err) {
    return reply_({ ok: false, code: 'bad_json' });
  }
  if (!req || req.v !== 1) return reply_({ ok: false, code: 'bad_version' });
  if (!keyOk_(req.key)) {
    Utilities.sleep(300);
    return reply_({ ok: false, code: 'bad_key' });
  }
  try {
    if (req.action === 'ping') return reply_(ping_());
    if (req.action === 'photo') return reply_(locked_(function () { return photo_(req); }));
    if (req.action === 'row') return reply_(locked_(function () { return rows_(req); }));
    if (req.action === 'log') return reply_(locked_(function () { return log_(req); }));
    return reply_({ ok: false, code: 'bad_action' });
  } catch (err) {
    console.error((err && err.stack) || err);
    return reply_({ ok: false, code: 'server_error', error: String((err && err.message) || err).slice(0, 300) });
  }
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function locked_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { ok: false, code: 'busy', error: 'another upload is running; retry' };
  try { return fn(); } finally { lock.releaseLock(); }
}

// ------------------------------------------------------------------ key + settings
function props_() { return PropertiesService.getScriptProperties(); }

function hex_(bytes) {
  return bytes.map(function (b) { return ((b + 256) % 256).toString(16); }).map(function (h) { return h.length === 1 ? '0' + h : h; }).join('');
}
function sha256Text_(s) {
  return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8));
}
function normKey_(k) { return String(k || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

function keyOk_(key) {
  var k = normKey_(key);
  if (k.length < 8) return false;
  var want = String(props_().getProperty('STATION_KEY_SHA256') || '').split(',').filter(String);
  var got = sha256Text_(k), ok = false;
  want.forEach(function (w) {
    var diff = w.length ^ got.length;
    for (var i = 0; i < Math.min(w.length, got.length); i++) diff |= w.charCodeAt(i) ^ got.charCodeAt(i);
    if (diff === 0) ok = true;
  });
  return ok;
}

function ids_() {
  var p = props_(), out = { root: p.getProperty('ROOT_ID'), test: p.getProperty('TEST_ID'), sheet: p.getProperty('SHEET_ID') };
  if (!out.root || !out.test || !out.sheet) throw new Error('not set up: run setup() in the Apps Script editor');
  return out;
}

function folderUrl_(id) { return 'https://drive.google.com/drive/folders/' + id; }
function fileUrl_(id) { return 'https://drive.google.com/file/d/' + id + '/view'; }
function sheetUrl_(id) { return 'https://docs.google.com/spreadsheets/d/' + id; }

// ------------------------------------------------------------------ Drive (create-only)
function q_(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }

function list_(q, fields) {
  var out = [], token = null;
  do {
    var args = { q: q, fields: 'nextPageToken,files(' + fields + ')', pageSize: 200 };
    if (token) args.pageToken = token;
    var r = Drive.Files.list(args);
    out = out.concat(r.files || []);
    token = r.nextPageToken;
  } while (token);
  return out;
}

// The child folder `name` of `parentId`, created if missing. Cached for 6 hours.
function folder_(parentId, name) {
  var cache = CacheService.getScriptCache(), ck = 'f|' + parentId + '|' + name, hit = cache.get(ck);
  if (hit) return hit;
  var found = list_("'" + q_(parentId) + "' in parents and name = '" + q_(name) + "' and mimeType = '" + PP.FOLDER_MIME + "' and trashed = false", 'id');
  var id = found.length ? found[0].id : Drive.Files.create({ name: name, mimeType: PP.FOLDER_MIME, parents: [parentId] }).id;
  cache.put(ck, id, 21600);
  return id;
}

function exists_(id) {
  try { return !Drive.Files.get(id, { fields: 'id,trashed' }).trashed; } catch (e) { return false; }
}

function bytesOk_(b) {
  return b.length > 3 && (b[0] & 0xff) === 0xff && (b[1] & 0xff) === 0xd8;
}

function photo_(req) {
  var name = String(req.name || ''), m = NAME_RE.exec(name);
  var boxes = Number(req.boxes) || 1;
  if (!m || m[1] !== String(req.awb || '') || m[3] !== req.kind || Number(m[4]) !== Number(req.nn)) return { ok: false, code: 'bad_name', error: name };
  var multiNamed = !!m[2], multiWanted = boxes > 1 && req.kind !== 'boxes';
  if (multiNamed !== multiWanted || (multiNamed && Number(m[2]) !== Number(req.box))) return { ok: false, code: 'bad_name', error: 'box number does not match: ' + name };
  var month = /^20\d\d-(0[1-9]|1[0-2])$/.test(String(req.month || '')) ? req.month : Utilities.formatDate(new Date(), PP.TZ, 'yyyy-MM');
  var bytes = Utilities.base64Decode(String(req.jpeg_b64 || ''));
  if (!bytesOk_(bytes)) return { ok: false, code: 'bad_image', error: 'not a JPEG' };
  if (bytes.length > PP.MAX_BYTES) return { ok: false, code: 'too_big', error: bytes.length + ' bytes' };
  var sha = hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes));
  if (req.sha256 && String(req.sha256).toLowerCase() !== sha) return { ok: false, code: 'bad_hash', error: 'the photo arrived damaged; resend' };

  var ids = ids_(), base = req.test ? ids.test : ids.root, awb = m[1];
  var file = null, skipped = false, monthFolder = null, awbFolder = null;
  for (var attempt = 0; attempt < 2 && !file; attempt++) {
    try {
      monthFolder = folder_(base, month);
      awbFolder = folder_(monthFolder, awb);
      var same = list_("'" + q_(awbFolder) + "' in parents and trashed = false", 'id,name,size,description');
      var clash = same.filter(function (f) { return f.name === name; })[0];
      if (clash) {
        var meta = {};
        try { meta = JSON.parse(clash.description || '{}'); } catch (e) { meta = {}; }
        if (meta.upload_id === req.upload_id || meta.sha256 === sha) {
          file = { id: clash.id, name: clash.name, size: Number(clash.size) }; skipped = true;
        } else {
          var next = 1;
          same.forEach(function (f) {
            var x = NAME_RE.exec(f.name || '');
            if (x && x[3] === m[3] && (x[2] || '') === (m[2] || '')) next = Math.max(next, Number(x[4]) + 1);
          });
          return { ok: false, code: 'name_taken', next_nn: next, error: name + ' already exists in Drive' };
        }
      } else {
        var desc = JSON.stringify({
          upload_id: req.upload_id, sha256: sha, captured_at: req.captured_at, station: req.station, phone: req.phone, app: req.app,
          awb: awb, box: req.box, boxes: boxes, kind: req.kind, nn: Number(req.nn), test: !!req.test,
        });
        var f = Drive.Files.create({ name: name, parents: [awbFolder], mimeType: 'image/jpeg', description: desc },
          Utilities.newBlob(bytes, 'image/jpeg', name), { fields: 'id,name,size' });
        file = { id: f.id, name: f.name, size: Number(f.size) || bytes.length };
      }
    } catch (err) {
      if (attempt) throw err;
      // A cached folder may have been removed by hand: forget it and look it up again.
      var cache = CacheService.getScriptCache();
      cache.remove('f|' + base + '|' + month);
      if (monthFolder) cache.remove('f|' + monthFolder + '|' + awb);
      monthFolder = null; awbFolder = null;
    }
  }
  file.url = fileUrl_(file.id);

  if (!skipped) {
    appendRow_(ids.sheet, PP.TAB_FILES, FILE_COLS, [ist_(new Date().toISOString()), req.test ? 'TEST' : '', awb, req.box || '', req.kind,
      Number(req.nn), name, file.url, file.size, req.final ? 'yes' : 'no', ist_(req.captured_at), req.station || '', req.phone || '', req.upload_id || '']);
  }
  var link = { kind: req.kind, url: file.url, final: !!req.final };
  var n = upsertRows_(ids.sheet, req.test ? PP.TAB_TEST : PP.TAB_LIVE, req.rows || [], req, link);
  return { ok: true, skipped: skipped, file: file, folder: { id: awbFolder, url: folderUrl_(awbFolder) }, rows: n };
}

// ------------------------------------------------------------------ Sheet
function a1Tab_(tab, a1) { return "'" + tab.replace(/'/g, "''") + "'!" + a1; }
function col_(n) { var s = ''; while (n > 0) { var r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; }

// Make sure `tab` exists with our header row (cached for 6 hours). Only ever adds columns at the end.
function ensureTab_(sheetId, tab, headers) {
  var cache = CacheService.getScriptCache(), ck = 't|' + sheetId + '|' + tab + '|' + headers.length;
  if (cache.get(ck)) return;
  var meta = Sheets.Spreadsheets.get(sheetId, { fields: 'sheets.properties(sheetId,title,index)' });
  var sheets = (meta.sheets || []).map(function (s) { return s.properties; });
  var have = sheets.filter(function (p) { return p.title === tab; })[0];
  var reqs = [];
  if (!have) {
    var blank = sheets.filter(function (p) { return p.title === 'Sheet1' || p.title === 'Sheet 1'; })[0];
    if (blank && tab === PP.TAB_LIVE) {
      Sheets.Spreadsheets.batchUpdate({ requests: [{ updateSheetProperties: { properties: { sheetId: blank.sheetId, title: tab }, fields: 'title' } }] }, sheetId);
      have = { sheetId: blank.sheetId, title: tab };
    } else {
      var r = Sheets.Spreadsheets.batchUpdate({ requests: [{ addSheet: { properties: { title: tab } } }] }, sheetId);
      have = r.replies[0].addSheet.properties;
    }
  }
  var top = (Sheets.Spreadsheets.Values.get(sheetId, a1Tab_(tab, '1:1')).values || [[]])[0] || [];
  var prefix = top.every(function (h, i) { return h === headers[i]; });
  if (!top.length || (prefix && top.length < headers.length)) {
    Sheets.Spreadsheets.Values.update({ values: [headers] }, sheetId, a1Tab_(tab, 'A1'), { valueInputOption: 'RAW' });
    reqs.push({ updateSheetProperties: { properties: { sheetId: have.sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } });
    reqs.push({ repeatCell: { range: { sheetId: have.sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } });
  } else if (!prefix) {
    console.warn('Header row of ' + tab + ' was changed by hand; leaving it as it is.');
  }
  if (reqs.length) Sheets.Spreadsheets.batchUpdate({ requests: reqs }, sheetId);
  cache.put(ck, '1', 21600);
}

function appendRow_(sheetId, tab, headers, row) {
  ensureTab_(sheetId, tab, headers);
  Sheets.Spreadsheets.Values.append({ values: [row] }, sheetId, a1Tab_(tab, 'A1'), { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' });
}

// One row per box, keyed by Box ID. Cells the snapshot does not know keep their value; "Team notes" is never written.
function upsertRows_(sheetId, tab, rows, req, link) {
  if (!rows.length) return 0;
  var headers = BOX_COLS.map(function (c) { return c[0]; });
  ensureTab_(sheetId, tab, headers);
  var last = col_(headers.length);
  var ids = (Sheets.Spreadsheets.Values.get(sheetId, a1Tab_(tab, 'A:A')).values || []).map(function (r) { return r[0]; });
  rows.forEach(function (snap) {
    if (!snap || !snap.box_id) return;
    var at = ids.indexOf(snap.box_id);
    var cur = at > 0 ? ((Sheets.Spreadsheets.Values.get(sheetId, a1Tab_(tab, 'A' + (at + 1) + ':' + last + (at + 1)), { valueRenderOption: 'UNFORMATTED_VALUE' }).values || [[]])[0] || []) : [];
    var row = BOX_COLS.map(function (c, i) {
      var v = c[1](snap, req);
      if (link && link.final && c[0] === KIND_COLS[link.kind] + ' photo') v = link.url;
      return v === undefined ? (cur[i] === undefined ? '' : cur[i]) : v;
    });
    if (at > 0) {
      Sheets.Spreadsheets.Values.update({ values: [row] }, sheetId, a1Tab_(tab, 'A' + (at + 1)), { valueInputOption: 'RAW' });
    } else {
      Sheets.Spreadsheets.Values.append({ values: [row] }, sheetId, a1Tab_(tab, 'A1'), { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' });
      ids.push(snap.box_id);
    }
  });
  return rows.length;
}

function rows_(req) {
  var ids = ids_();
  return { ok: true, rows: upsertRows_(ids.sheet, req.test ? PP.TAB_TEST : PP.TAB_LIVE, req.rows || [], req, null) };
}

function log_(req) {
  var ids = ids_(), e = req.entry || {};
  appendRow_(ids.sheet, PP.TAB_LOG, LOG_COLS, [ist_(e.at || new Date().toISOString()), e.test ? 'TEST' : '', e.station || req.station || '',
    e.type || '', e.reading || '', e.result || '', e.notes || '', e.phone || req.phone || '', req.app || '', e.id || '']);
  return { ok: true };
}

function ping_() {
  var ids = ids_();
  return {
    ok: true, version: PP.VERSION, server_time: ist_(new Date().toISOString()),
    root: { id: ids.root, name: PP.ROOT_NAME, url: folderUrl_(ids.root) },
    test: { id: ids.test, url: folderUrl_(ids.test) },
    sheet: { id: ids.sheet, url: sheetUrl_(ids.sheet) },
  };
}

// ------------------------------------------------------------------ one-time setup (run from the editor)
function setup() {
  var p = props_();
  var root = p.getProperty('ROOT_ID');
  if (!root || !exists_(root)) {
    root = Drive.Files.create({ name: PP.ROOT_NAME, mimeType: PP.FOLDER_MIME }).id;
    p.setProperty('ROOT_ID', root);
  }
  p.setProperty('TEST_ID', folder_(root, PP.TEST_NAME));
  var sheet = p.getProperty('SHEET_ID');
  if (!sheet || !exists_(sheet)) {
    sheet = Drive.Files.create({ name: PP.SHEET_NAME, mimeType: PP.SHEET_MIME, parents: [root] }).id;
    p.setProperty('SHEET_ID', sheet);
  }
  var headers = BOX_COLS.map(function (c) { return c[0]; });
  ensureTab_(sheet, PP.TAB_LIVE, headers);
  ensureTab_(sheet, PP.TAB_TEST, headers);
  ensureTab_(sheet, PP.TAB_FILES, FILE_COLS);
  ensureTab_(sheet, PP.TAB_LOG, LOG_COLS);
  console.log('Packing Proof folder: ' + folderUrl_(root));
  console.log('TEST folder:          ' + folderUrl_(p.getProperty('TEST_ID')));
  console.log('Sheet:                ' + sheetUrl_(sheet));
  if (!p.getProperty('STATION_KEY_SHA256')) newStationKey();
  else console.log('A station key already exists. Run newStationKey() only to replace it (the phone must then be updated).');
}

// Makes a new station key, keeps only its SHA-256 and prints the key ONCE. Replaces any older key.
function newStationKey() {
  var raw = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, 20);
  props_().setProperty('STATION_KEY_SHA256', sha256Text_(normKey_(raw)));
  console.log('STATION KEY (type it once on the phone, in Settings; it is not shown again): ' + raw.replace(/(.{4})(?=.)/g, '$1-'));
}
