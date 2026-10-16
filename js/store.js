// IndexedDB on the phone: settings, records, photos (JPEG blobs) and the upload queue.
// Everything survives a closed app, a dead network or a restart; uploads finish from the queue.

const DB_NAME = 'tfc-packing-proof';
const DB_VERSION = 1;
let dbp = null;

function req(r) {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

export function openDB() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('kv', { keyPath: 'k' });
      db.createObjectStore('shipments', { keyPath: 'id' });
      db.createObjectStore('boxes', { keyPath: 'id' }).createIndex('shipment', 'shipment_id');
      const ph = db.createObjectStore('photos', { keyPath: 'id' });
      ph.createIndex('shipment', 'shipment_id');
      db.createObjectStore('queue', { keyPath: 'seq', autoIncrement: true });
      db.createObjectStore('logs', { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

// Close and delete the phone's database (only the computer demo's "start again" uses this).
export async function wipe() {
  if (dbp) { (await dbp).close(); dbp = null; }
  await new Promise((res) => { const r = indexedDB.deleteDatabase(DB_NAME); r.onsuccess = res; r.onerror = res; r.onblocked = res; });
}

async function store(name, mode = 'readonly') {
  return (await openDB()).transaction(name, mode).objectStore(name);
}

export async function get(name, key) { return req((await store(name)).get(key)); }
export async function all(name) { return req((await store(name)).getAll()); }
export async function put(name, value) { return req((await store(name, 'readwrite')).put(value)); }
export async function del(name, key) { return req((await store(name, 'readwrite')).delete(key)); }
export async function byIndex(name, index, value) { return req((await store(name)).index(index).getAll(value)); }

// Several writes in one transaction (all or nothing).
export async function putMany(items) {
  const db = await openDB();
  const names = [...new Set(items.map((i) => i[0]))];
  const tx = db.transaction(names, 'readwrite');
  for (const [name, value] of items) tx.objectStore(name).put(value);
  return new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
}

export async function getKV(k, fallback = null) {
  const r = await get('kv', k);
  return r ? r.v : fallback;
}
export async function setKV(k, v) { return put('kv', { k, v }); }

export async function enqueue(item) {
  return put('queue', { ...item, created: Date.now(), tries: 0, next: 0 });
}

// Ask Chrome not to evict our data when the phone runs low on space.
export async function persist() {
  try { return navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false; } catch { return false; }
}

export async function usage() {
  try { return navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null; } catch { return null; }
}
