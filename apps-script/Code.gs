/**
 * TFC Packing Proof - backend. A Google Apps Script web app that runs as thefluco@gmail.com.
 *
 * The station phone POSTs JSON as text/plain (no CORS pre-flight). Every request carries the station key,
 * which is typed once on the phone; only its SHA-256 is stored here (Script Properties), never the key.
 *
 *   action "ping"  - checks the key; returns the Drive folder and Sheet links (the phone's "Test connection") and
 *                    whether a reader is set up (reader: true/false)
 *   action "photo" - saves one JPEG to Drive  Packing Proof/<YYYY-MM>/<AWB>/   (TEST: Packing Proof/TEST/...)
 *                    and updates the box row(s) in the "Packing Proof" Sheet
 *   action "row"   - updates box row(s) only (readings, numbers to book, AWB, status, times)
 *   action "log"   - appends a station-log row (start of shift, the Monday 10 kg scale test)
 *   action "read"  - reads the weight or the bay scales from a photo with Claude (vision) and returns the numbers;
 *                    nothing is stored. The Anthropic API key lives only in Script Properties (ANTHROPIC_API_KEY)
 *
 * The key is OPTIONAL. Without it the phone does not try to read: the reading photos are still saved and listed,
 * the number columns stay empty, and the numbers can be filled in later from the photos (a cell the phone has no
 * number for is never cleared, so a later fill stays).
 *
 * Drive rules: it only CREATES. It never moves, renames, overwrites or deletes anything. A name that already
 * exists is skipped (same upload) or refused with code "name_taken" (the phone then uses the next number).
 *
 * Scopes: drive.file (the script sees just the folders and files it created itself) and external_request (the
 * call to api.anthropic.com). One-time setup: run setup() in the editor (creates the folder, the TEST folder, the
 * Sheet and the station key), optionally add ANTHROPIC_API_KEY in Project Settings > Script properties, then
 * Deploy > New deployment > Web app, Execute as: Me, Who has access: Anyone. See README.md.
 */

var PP = {
  VERSION: '1.4.0',
  ROOT_NAME: 'Packing Proof',
  TEST_NAME: 'TEST',
  SHEET_NAME: 'Packing Proof',
  TAB_LIVE: 'Boxes',
  TAB_TEST: 'TEST boxes',
  TAB_FILES: 'Files',
  TAB_LOG: 'Station log',
  MAX_BYTES: 2000000,        // Shipmozo's limit per image (the proof-photo cap before v1.4)
  MAX_READ_BYTES: 8000000,
  TZ: 'Asia/Kolkata',
  FOLDER_MIME: 'application/vnd.google-apps.folder',
  SHEET_MIME: 'application/vnd.google-apps.spreadsheet',
};

// Proof photos (label, scale, length-height, breadth, boxes) plus the reading photos taken before the label
// (measure-*, v1.3: weight, length, breadth, height), which the numbers to book are read from. sync.py counts only
// the proof kinds as dispute images.
var NAME_RE = /^([A-Z0-9]{6,20})(?:-b(\d{1,2}))?-ours-(label|scale|length|breadth|height|length-height|boxes|measure-scale|measure-length|measure-breadth|measure-height)-(\d{2})\.jpg$/;
var KIND_COLS = {
  'label': 'Label', 'breadth': 'Breadth', 'length-height': 'Length-height', 'scale': 'Scale', 'boxes': 'Boxes',
  'length': 'Length', 'height': 'Height',
  'measure-scale': 'Measure weight', 'measure-length': 'Measure length', 'measure-breadth': 'Measure breadth', 'measure-height': 'Measure height',
};
// v1.4: every photo is kept at the camera's full resolution (the numbers are read from them); the Shipmozo agent
// makes its own copies under Shipmozo's 2 MB limit when it uploads them. (Before v1.4 proof photos were cut to 2 MB.)
function maxBytes_(kind) { return PP.MAX_READ_BYTES; }

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
// A number the phone does not have (no reader, or not read) never clears a cell: it may have been filled in
// later from the reading photos.
function keep_(v) { return v === '' ? undefined : v; }
function rd_(f) { return function (s) { return keep_(num_(s.readings && s.readings[f])); }; }
function bk_(f) { return function (s) { return keep_(num_(s.book && s.book[f])); }; }

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
  // v1.1 (image-first): where each reading came from, the re-read of the proof photos, the reading photos.
  ['Readings source', function (s) { return s.readings_source || undefined; }],
  ['Re-read check', function (s) { return s.reread || ''; }],
  ['Measure weight photo', photoUrl_('measure-scale')],
  ['Measure length photo', photoUrl_('measure-length')],
  ['Measure breadth photo', photoUrl_('measure-breadth')],
  ['Measure height photo', photoUrl_('measure-height')],
  // v1.3: the checks of each reading photo (camera used, size, sharpness), to compare ways of taking them.
  ['Checks measure weight', photoChecks_('measure-scale')], ['Checks measure length', photoChecks_('measure-length')],
  ['Checks measure breadth', photoChecks_('measure-breadth')], ['Checks measure height', photoChecks_('measure-height')],
  // v1.4: one round after booking - weight ("Scale photo"), length, breadth, height, each with the label.
  ['Length photo', photoUrl_('length')], ['Height photo', photoUrl_('height')],
  ['Checks length', photoChecks_('length')], ['Checks height', photoChecks_('height')],
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
    if (req.action === 'read') return reply_(read_(req));
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
  if (bytes.length > maxBytes_(req.kind)) return { ok: false, code: 'too_big', error: bytes.length + ' bytes' };
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

// Make sure `tab` exists and its first row holds every one of `headers`; returns the header row as it stands in
// the Sheet (cached for 5 minutes). Columns are found by their header, so columns moved or added by hand stay
// where they are; a missing header is added at the end (the tab is widened first: a new tab has only 26 columns).
// Nothing is ever removed or reordered.
function ensureTab_(sheetId, tab, headers) {
  var cache = CacheService.getScriptCache(), ck = 'h|' + sheetId + '|' + tab;
  var hit = cache.get(ck);
  if (hit) {
    var known = JSON.parse(hit);
    if (headers.every(function (h) { return known.indexOf(h) >= 0; })) return known;
  }
  var meta = Sheets.Spreadsheets.get(sheetId, { fields: 'sheets.properties(sheetId,title,index,gridProperties)' });
  var sheets = (meta.sheets || []).map(function (s) { return s.properties; });
  var have = sheets.filter(function (p) { return p.title === tab; })[0];
  if (!have) {
    var blank = sheets.filter(function (p) { return p.title === 'Sheet1' || p.title === 'Sheet 1'; })[0];
    if (blank && tab === PP.TAB_LIVE) {
      Sheets.Spreadsheets.batchUpdate({ requests: [{ updateSheetProperties: { properties: { sheetId: blank.sheetId, title: tab }, fields: 'title' } }] }, sheetId);
      have = blank;
    } else {
      var r = Sheets.Spreadsheets.batchUpdate({ requests: [{ addSheet: { properties: { title: tab } } }] }, sheetId);
      have = r.replies[0].addSheet.properties;
    }
  }
  var top = (Sheets.Spreadsheets.Values.get(sheetId, a1Tab_(tab, '1:1')).values || [[]])[0] || [];
  var missing = headers.filter(function (h) { return top.indexOf(h) < 0; });
  if (missing.length) {
    var reqs = [], cols = (have.gridProperties && have.gridProperties.columnCount) || 26, need = top.length + missing.length;
    if (need > cols) {
      Sheets.Spreadsheets.batchUpdate({ requests: [{ appendDimension: { sheetId: have.sheetId, dimension: 'COLUMNS', length: need - cols } }] }, sheetId);
    }
    Sheets.Spreadsheets.Values.update({ values: [missing] }, sheetId, a1Tab_(tab, col_(top.length + 1) + '1'), { valueInputOption: 'RAW' });
    if (!top.length) reqs.push({ updateSheetProperties: { properties: { sheetId: have.sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } });
    reqs.push({ repeatCell: { range: { sheetId: have.sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } });
    Sheets.Spreadsheets.batchUpdate({ requests: reqs }, sheetId);
    top = top.concat(missing);
  }
  cache.put(ck, JSON.stringify(top), 300);
  return top;
}

// A row laid out by the Sheet's own header row: `values` maps header -> value; other columns are left blank.
function byHeader_(top, values) {
  return top.map(function (h) { return Object.prototype.hasOwnProperty.call(values, h) ? values[h] : ''; });
}

function appendRow_(sheetId, tab, headers, row) {
  var top = ensureTab_(sheetId, tab, headers), values = {};
  headers.forEach(function (h, i) { values[h] = row[i]; });
  Sheets.Spreadsheets.Values.append({ values: [byHeader_(top, values)] }, sheetId, a1Tab_(tab, 'A1'), { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' });
}

// One row per box, keyed by Box ID. Cells the snapshot does not know keep their value; "Team notes" is never written.
function upsertRows_(sheetId, tab, rows, req, link) {
  if (!rows.length) return 0;
  var top = ensureTab_(sheetId, tab, BOX_COLS.map(function (c) { return c[0]; }));
  var idCol = col_(top.indexOf('Box ID') + 1), last = col_(top.length);
  var ids = (Sheets.Spreadsheets.Values.get(sheetId, a1Tab_(tab, idCol + ':' + idCol)).values || []).map(function (r) { return r[0]; });
  rows.forEach(function (snap) {
    if (!snap || !snap.box_id) return;
    var at = ids.indexOf(snap.box_id);
    var cur = at > 0 ? ((Sheets.Spreadsheets.Values.get(sheetId, a1Tab_(tab, 'A' + (at + 1) + ':' + last + (at + 1)), { valueRenderOption: 'UNFORMATTED_VALUE' }).values || [[]])[0] || []) : [];
    // Start from the row as it is (columns we do not own - Team notes, anything added by hand - are kept).
    var row = top.map(function (h, i) { return cur[i] === undefined ? '' : cur[i]; });
    BOX_COLS.forEach(function (c) {
      var v = c[1](snap, req);
      if (link && link.final && c[0] === KIND_COLS[link.kind] + ' photo') v = link.url;
      if (v !== undefined) row[top.indexOf(c[0])] = v;
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
    reader: !!props_().getProperty('ANTHROPIC_API_KEY'),   // false: the phone leaves the numbers to be read later
  };
}

// ------------------------------------------------------------------ reading the numbers from a photo (Claude vision)
// The phone sends the whole photo (<= 2576 px) plus close-ups of the printed scales when the mount is calibrated.
// Model, effort and key come from Script Properties: ANTHROPIC_API_KEY (required), READ_MODEL, READ_EFFORT.
var READ_SYSTEM = 'You read measurements from photos taken at a parcel measuring station. The numbers are used to book ' +
  'shipments and to dispute courier weight charges, so being right matters more than giving an answer: never guess a ' +
  'value you cannot see - mark it unreadable instead. Where a board or arm sits between two marks, give the larger ' +
  'value: the parcel is billed by its outer size, so reading low understates it. Reply with the requested JSON only.';
var READ_BAY = 'The measuring bay: a white base 180 x 75 cm with a back wall along the far long side and a left wall. ' +
  'Printed scales: scale L runs along the front edge of the base, 0 at the left wall, a tick every cm and numbers every ' +
  '5 cm. Scales B1 (left end) and B2 (right end) run from the back wall (0) towards the front. The parcel sits in the ' +
  'back-left corner, one end against the left wall and one side against the back wall. ';
var READ_HALF = ' Give centimetres, to the nearest half centimetre where the marks allow.';
var CONF = { type: 'string', enum: ['high', 'medium', 'low'] };
// v1.3 reading photos (no station yet): a close-up of a tape measure at one edge of the parcel, one number each.
function tapeSpec_(what, where) {
  return {
    ask: 'A close-up of a tape measure against a parcel, taken to measure its ' + what + '. The tape\'s zero is held at the ' +
      'far edge, out of the picture. Read the tape where ' + where + '. Give the reading in cm with its decimal (mm marks), ' +
      'e.g. "103.4"; if the marks between numbers are not clear, the nearest half cm, rounding up.',
    schema: {
      type: 'object', additionalProperties: false, required: ['readable', 'value_cm', 'confidence', 'notes'],
      properties: {
        readable: { type: 'boolean' }, value_cm: { type: 'string', description: 'e.g. "103.4". Empty if unreadable.' },
        confidence: CONF, notes: { type: 'string' },
      },
    },
  };
}
var TAPE_FIELD = {
  'measure-length': 'length', 'measure-breadth': 'breadth', 'measure-height': 'height',
  'length': 'length', 'breadth': 'breadth', 'height': 'height',   // v1.4: the photos after booking (label in view)
};
var TAPE_AT = {
  length: 'the parcel\'s end (or a flat board pressed against it) meets the tape',
  breadth: 'the parcel\'s side at its widest point (or a flat board pressed against it) meets the tape',
  height: 'a flat board laid across the parcel\'s highest point (or the top of the parcel) meets the upright tape',
};
var READ_SPECS = {
  'measure-length': tapeSpec_('length', TAPE_AT.length),
  'measure-breadth': tapeSpec_('breadth', TAPE_AT.breadth),
  'measure-height': tapeSpec_('height', TAPE_AT.height),
  'length': tapeSpec_('length', TAPE_AT.length),
  'breadth': tapeSpec_('breadth', TAPE_AT.breadth),
  'height': tapeSpec_('height', TAPE_AT.height),
  'scale': {
    ask: 'A parcel on a platform weighing scale. Read the weight on the scale\'s digital display exactly as shown, in kg, ' +
      'keeping every decimal. Also say whether the parcel rests only on the platform with both ends clear of the floor, ' +
      'and whether the display digits look steady and complete.',
    schema: {
      type: 'object', additionalProperties: false,
      required: ['readable', 'weight_kg', 'confidence', 'on_platform_only', 'display_steady', 'notes'],
      properties: {
        readable: { type: 'boolean' }, weight_kg: { type: 'string', description: 'As displayed, e.g. "16.85". Empty if unreadable.' },
        confidence: CONF, on_platform_only: { type: 'boolean' }, display_steady: { type: 'boolean' }, notes: { type: 'string' },
      },
    },
  },
  'length-height': {
    ask: READ_BAY + 'LENGTH: an end panel (a board standing across the bay) touches the parcel\'s far end, on the right. ' +
      'Read scale L at the face of the end panel that touches the parcel. HEIGHT: a height gauge (an upright post with a ' +
      'printed scale facing the camera) has an arm resting on the parcel\'s highest point; read the gauge scale at the ' +
      'underside of the arm.' + READ_HALF,
    schema: {
      type: 'object', additionalProperties: false,
      required: ['length_readable', 'length_cm', 'length_confidence', 'height_readable', 'height_cm', 'height_confidence', 'notes'],
      properties: {
        length_readable: { type: 'boolean' }, length_cm: { type: 'string', description: 'e.g. "103.5". Empty if unreadable.' },
        length_confidence: CONF, height_readable: { type: 'boolean' }, height_cm: { type: 'string', description: 'e.g. "27". Empty if unreadable.' },
        height_confidence: CONF, notes: { type: 'string' },
      },
    },
  },
  'bay-breadth': {   // the measuring station's fence photo (v1.0-1.3); kept for when the station exists
    ask: READ_BAY + 'BREADTH: a long low fence board lies along the front of the parcel, parallel to the back wall, ' +
      'touching its widest point. Read scale B1 and scale B2 where the fence\'s front face crosses them.' + READ_HALF,
    schema: {
      type: 'object', additionalProperties: false,
      required: ['readable', 'b1_cm', 'b2_cm', 'confidence', 'notes'],
      properties: {
        readable: { type: 'boolean' }, b1_cm: { type: 'string', description: 'Empty if unreadable.' },
        b2_cm: { type: 'string', description: 'Empty if unreadable.' }, confidence: CONF, notes: { type: 'string' },
      },
    },
  },
};

// {url, headers, body} for POST /v1/messages (the caller adds x-api-key). Shared with the test site's harness.
function buildReadRequest_(req, model, effort) {
  var base = String(req.kind || '').replace(/^measure-/, '');
  var spec = READ_SPECS[req.kind] || READ_SPECS[base];   // the tape reading photos, else the station's
  if (!spec) throw new Error('unknown reading: ' + req.kind);
  var content = [];
  (req.images || []).slice(0, 6).forEach(function (im, i) {
    content.push({ type: 'text', text: 'Image ' + (i + 1) + ': ' + String(im.label || 'the photo').slice(0, 120) });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: String(im.b64 || '') } });
  });
  content.push({ type: 'text', text: spec.ask });
  return {
    url: 'https://api.anthropic.com/v1/messages',
    headers: { 'anthropic-version': '2023-06-01', 'anthropic-beta': 'server-side-fallback-2026-07-01' },
    body: {
      model: model || 'claude-opus-5-5', max_tokens: 16000, fallbacks: 'default', system: READ_SYSTEM,
      output_config: { effort: effort || 'medium', format: { type: 'json_schema', schema: spec.schema } },
      messages: [{ role: 'user', content: content }],
    },
  };
}

function cleanReading_(v) {
  var t = String(v == null ? '' : v).replace(',', '.').replace(/[^0-9.]/g, '');
  return /^\d{1,4}(\.\d{1,3})?$/.test(t) ? t : '';
}

// The API's reply -> {ok, kind, values:{weight|length,height|b1,b2}, confidence:{...}, flags, notes, model}
function parseReadResponse_(kind, res) {
  if (!res || res.type === 'error') return { ok: false, code: 'reader_error', error: String((res && res.error && res.error.message) || 'no reply').slice(0, 200) };
  if (res.stop_reason === 'refusal') return { ok: false, code: 'reader_refused', error: 'the reader declined this photo' };
  if (res.stop_reason === 'max_tokens') return { ok: false, code: 'reader_error', error: 'the reply was cut off' };
  var text = (res.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('');
  var o;
  try { o = JSON.parse(text); } catch (e) { return { ok: false, code: 'reader_error', error: 'the reply was not JSON' }; }
  var base = String(kind || '').replace(/^measure-/, ''), values = {}, confidence = {}, flags = {};
  if (TAPE_FIELD[kind]) {
    var f = TAPE_FIELD[kind];
    if (o.readable && cleanReading_(o.value_cm)) values[f] = cleanReading_(o.value_cm);
    confidence[f] = o.confidence;
  } else if (base === 'scale') {
    if (o.readable && cleanReading_(o.weight_kg)) values.weight = cleanReading_(o.weight_kg);
    confidence.weight = o.confidence;
    flags = { on_platform_only: !!o.on_platform_only, display_steady: !!o.display_steady };
  } else if (base === 'length-height') {
    if (o.length_readable && cleanReading_(o.length_cm)) values.length = cleanReading_(o.length_cm);
    if (o.height_readable && cleanReading_(o.height_cm)) values.height = cleanReading_(o.height_cm);
    confidence.length = o.length_confidence; confidence.height = o.height_confidence;
  } else if (base === 'bay-breadth') {
    if (o.readable && cleanReading_(o.b1_cm)) values.b1 = cleanReading_(o.b1_cm);
    if (o.readable && cleanReading_(o.b2_cm)) values.b2 = cleanReading_(o.b2_cm);
    confidence.breadth = o.confidence;
  }
  return { ok: true, kind: base, values: values, confidence: confidence, flags: flags, notes: String(o.notes || '').slice(0, 300), model: res.model || '' };
}

function read_(req) {
  var p = props_(), key = p.getProperty('ANTHROPIC_API_KEY');
  if (!key) return { ok: false, code: 'no_reader', error: 'no Anthropic API key in Script Properties (ANTHROPIC_API_KEY)' };
  var imgs = req.images || [];
  if (!imgs.length || imgs.length > 6) return { ok: false, code: 'bad_image', error: 'send 1 to 6 images' };
  for (var i = 0; i < imgs.length; i++) {
    var b = String(imgs[i].b64 || '');
    if (b.length > 6900000 || b.slice(0, 4) !== '/9j/') return { ok: false, code: 'bad_image', error: 'image ' + (i + 1) + ' is not a JPEG under 5 MB' };
  }
  var r;
  try { r = buildReadRequest_(req, p.getProperty('READ_MODEL'), p.getProperty('READ_EFFORT')); } catch (e) { return { ok: false, code: 'bad_kind', error: e.message }; }
  var headers = { 'x-api-key': key };
  Object.keys(r.headers).forEach(function (h) { headers[h] = r.headers[h]; });
  var resp = UrlFetchApp.fetch(r.url, { method: 'post', contentType: 'application/json', headers: headers, payload: JSON.stringify(r.body), muteHttpExceptions: true });
  var status = resp.getResponseCode(), body = resp.getContentText(), json = null;
  try { json = JSON.parse(body); } catch (e) { json = null; }
  if (status === 401 || status === 403) return { ok: false, code: 'reader_key', error: 'the Anthropic API key was refused' };
  if (status === 429 || status >= 500) return { ok: false, code: 'reader_busy', error: 'the reader is busy (HTTP ' + status + '); try again' };
  if (status !== 200) return { ok: false, code: 'reader_error', error: 'HTTP ' + status + ': ' + String((json && json.error && json.error.message) || body).slice(0, 200) };
  return parseReadResponse_(req.kind, json);
}

// ------------------------------------------------------------------ self-test (run from the editor after setup)
// Saves a tiny TEST photo through the same code as a phone upload (no station key: the editor runs as the owner):
// Packing Proof/TEST/<month>/SELFTEST000001/SELFTEST000001-ours-measure-length-NN.jpg, a "Files" row and a
// "TEST boxes" row (Box ID SELFTEST-b1). Run again, it finds the same photo already there ("skipped": true), as a
// repeated phone upload would. Nothing outside TEST.
var SELFTEST_JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCABAAGADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDoaKKoX17eWt1bRQ2sMq3MnlqzzlCDsZuQEPGFPevFSuei3Yv0VmQ6pdPa3F3JZxiCAzDEcxeRvLZl4XaByV9e9RSazcrpdxfx2ltMkEZl3R3WUdQpPysF68dCPTmq5WLmRsUVHA0zR5uI443z92Ny4/MgfyqSpGFFFFAwooooAKKKKACq9za/aJ7SXft+zTGXGM7so6Y9vv5/CrFFAjIttEe2kuGjmt0aZ5W85LbEy72Lff3HOM+nanHRWktdRjlnjEt/D5TNFDsUcMN23ccn5uTnnA9K1aKrnYuVBRRRUlBRRRQAUUUUAFFFFABRRXnP/CvNX/5+LL/vt/8A4mtIRjLd2IlJrZXPRqK85/4V5q//AD8WX/fb/wDxNH/CvNX/AOfiy/77f/4mtPZU/wCcjnl/KejUV5z/AMK81f8A5+LL/vt//iaP+Feav/z8WX/fb/8AxNHsqf8AOHPL+U9Gorzn/hXmr/8APxZf99v/APE0f8K81f8A5+LL/vt//iaPZU/5w55fyno1Fec/8K81f/n4sv8Avt//AImj/hXmr/8APxZf99v/APE0eyp/zhzy/lPRqK85/wCFeav/AM/Fl/32/wD8TXe6dbvZ6Za2shUvDCkbFehIUA4rOcIx2lcuMm91Ys0UUVmWFFFFABRRRQAUUUUAFFFFABRRRQB//9k=';
function selfTest() {
  var awb = 'SELFTEST000001', kind = 'measure-length', bytes = Utilities.base64Decode(SELFTEST_JPEG), now = new Date().toISOString();
  var month = Utilities.formatDate(new Date(), PP.TZ, 'yyyy-MM'), r = null;
  var row = { box_id: 'SELFTEST-b1', shipment_id: 'SELFTEST', awb: awb, box: 1, boxes: 1, status: 'self-test', order_ref: '',
    readings: {}, book: {}, photos: {}, created_at: now, station: 'Self-test (editor)', readings_source: '', reread: '' };
  for (var nn = 1; nn < 50; nn++) {
    r = photo_({
      v: 1, action: 'photo', test: true, station: 'Self-test (editor)', phone: 'editor', app: 'selfTest ' + PP.VERSION,
      upload_id: Utilities.getUuid(), name: awb + '-ours-' + kind + '-' + (nn < 10 ? '0' : '') + nn + '.jpg', awb: awb, month: month,
      box: 1, boxes: 1, kind: kind, nn: nn, final: true, captured_at: now, bytes: bytes.length,
      sha256: hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes)), jpeg_b64: SELFTEST_JPEG, rows: [row],
    });
    if (!r || r.code !== 'name_taken') break;   // an earlier self-test used this number
  }
  console.log('Self-test: ' + JSON.stringify(r));
  console.log('Open the Sheet: ' + sheetUrl_(ids_().sheet) + ' (tab "TEST boxes", Box ID SELFTEST-b1; tab "Files")');
  return r;
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
