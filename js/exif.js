// Minimal EXIF writer: capture time (with offset) and phone model go into the file, nothing is drawn on the image.
// Little-endian TIFF, IFD0 + Exif sub-IFD, tags sorted as the spec requires.

const ASCII = 2, SHORT = 3, LONG = 4, RATIONAL = 5, UNDEFINED = 7;

function exifDate(d) {
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}:${p(d.getMonth() + 1)}:${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function offsetText(d) {
  const off = -d.getTimezoneOffset(), a = Math.abs(off);
  return `${off >= 0 ? '+' : '-'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

function asciiBytes(s) {
  const clean = String(s).replace(/[^\x20-\x7e]/g, '?');
  const b = new Uint8Array(clean.length + 1);
  for (let i = 0; i < clean.length; i++) b[i] = clean.charCodeAt(i);
  return b;   // NUL-terminated
}

// entries: [{tag, type, value}] where value is bytes (ASCII/UNDEFINED), a number (SHORT/LONG) or [num, den] (RATIONAL).
function ifdBlock(entries, start, nextIfd) {
  entries = entries.slice().sort((a, b) => a.tag - b.tag);
  const headLen = 2 + entries.length * 12 + 4;
  const data = [];
  let dataLen = 0;
  const head = new DataView(new ArrayBuffer(headLen));
  head.setUint16(0, entries.length, true);
  entries.forEach((e, i) => {
    const o = 2 + i * 12;
    head.setUint16(o, e.tag, true);
    head.setUint16(o + 2, e.type, true);
    let bytes;
    if (e.type === ASCII || e.type === UNDEFINED) bytes = e.value;
    else if (e.type === SHORT) { bytes = new Uint8Array(2); new DataView(bytes.buffer).setUint16(0, e.value, true); }
    else if (e.type === LONG) { bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, e.value >>> 0, true); }
    else if (e.type === RATIONAL) { bytes = new Uint8Array(8); const v = new DataView(bytes.buffer); v.setUint32(0, e.value[0], true); v.setUint32(4, e.value[1], true); }
    const count = e.type === ASCII || e.type === UNDEFINED ? bytes.length : 1;
    head.setUint32(o + 4, count, true);
    if (bytes.length <= 4) {
      new Uint8Array(head.buffer, o + 8, 4).set(bytes);
    } else {
      head.setUint32(o + 8, start + headLen + dataLen, true);
      data.push(bytes);
      dataLen += bytes.length + (bytes.length & 1);   // word-align
      if (bytes.length & 1) data.push(new Uint8Array(1));
    }
  });
  head.setUint32(headLen - 4, nextIfd, true);
  const out = new Uint8Array(headLen + dataLen);
  out.set(new Uint8Array(head.buffer), 0);
  let pos = headLen;
  for (const d of data) { out.set(d, pos); pos += d.length; }
  return out;
}

// Returns the complete APP1 segment (FF E1, length, "Exif\0\0", TIFF).
export function buildExif({ make, model, software, description, date, width, height, uniqueId }) {
  const d = date || new Date();
  const dt = asciiBytes(exifDate(d)), off = asciiBytes(offsetText(d));
  const sub = asciiBytes(String(d.getMilliseconds()).padStart(3, '0'));
  const exifEntries = [
    { tag: 0x9000, type: UNDEFINED, value: asciiBytes('0232').slice(0, 4) },
    { tag: 0x9003, type: ASCII, value: dt },
    { tag: 0x9004, type: ASCII, value: dt },
    { tag: 0x9010, type: ASCII, value: off },
    { tag: 0x9011, type: ASCII, value: off },
    { tag: 0x9012, type: ASCII, value: off },
    { tag: 0x9291, type: ASCII, value: sub },
    { tag: 0xa001, type: SHORT, value: 1 },
    { tag: 0xa002, type: LONG, value: width },
    { tag: 0xa003, type: LONG, value: height },
  ];
  if (uniqueId) exifEntries.push({ tag: 0xa420, type: ASCII, value: asciiBytes(String(uniqueId).replace(/-/g, '').slice(0, 32)) });

  const ifd0Entries = [
    { tag: 0x0112, type: SHORT, value: 1 },
    { tag: 0x011a, type: RATIONAL, value: [72, 1] },
    { tag: 0x011b, type: RATIONAL, value: [72, 1] },
    { tag: 0x0128, type: SHORT, value: 2 },
    { tag: 0x0132, type: ASCII, value: dt },
    { tag: 0x8769, type: LONG, value: 0 },   // patched below
  ];
  if (description) ifd0Entries.push({ tag: 0x010e, type: ASCII, value: asciiBytes(description) });
  if (make) ifd0Entries.push({ tag: 0x010f, type: ASCII, value: asciiBytes(make) });
  if (model) ifd0Entries.push({ tag: 0x0110, type: ASCII, value: asciiBytes(model) });
  if (software) ifd0Entries.push({ tag: 0x0131, type: ASCII, value: asciiBytes(software) });

  // Lay out: TIFF header (8) | IFD0 | Exif IFD. IFD0 size does not depend on the pointer value, so build twice.
  const ifd0Probe = ifdBlock(ifd0Entries, 8, 0);
  const exifStart = 8 + ifd0Probe.length;
  ifd0Entries.find((e) => e.tag === 0x8769).value = exifStart;
  const ifd0 = ifdBlock(ifd0Entries, 8, 0);
  const exif = ifdBlock(exifEntries, exifStart, 0);

  const tiff = new Uint8Array(8 + ifd0.length + exif.length);
  tiff.set([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00], 0);
  tiff.set(ifd0, 8);
  tiff.set(exif, exifStart);

  const segLen = 2 + 6 + tiff.length;
  if (segLen > 65535) throw new Error('EXIF too large');
  const app1 = new Uint8Array(2 + segLen);
  app1.set([0xff, 0xe1, segLen >> 8, segLen & 0xff, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 0);
  app1.set(tiff, 10);
  return app1;
}

// JPEG bytes with our APP1 right after SOI; an existing JFIF APP0 or EXIF APP1 is dropped.
export function insertExif(jpeg, app1) {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('not a JPEG');
  let pos = 2;
  while (pos + 4 <= jpeg.length && jpeg[pos] === 0xff && (jpeg[pos + 1] === 0xe0 || jpeg[pos + 1] === 0xe1)) {
    pos += 2 + ((jpeg[pos + 2] << 8) | jpeg[pos + 3]);
  }
  const out = new Uint8Array(2 + app1.length + (jpeg.length - pos));
  out.set([0xff, 0xd8], 0);
  out.set(app1, 2);
  out.set(jpeg.subarray(pos), 2 + app1.length);
  return out;
}

// Width and height from a JPEG's SOF marker (no decoding).
export function jpegSize(bytes) {
  let pos = 2;
  while (pos + 9 < bytes.length) {
    if (bytes[pos] !== 0xff) { pos++; continue; }
    const m = bytes[pos + 1];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { pos += 2; continue; }
    const len = (bytes[pos + 2] << 8) | bytes[pos + 3];
    if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)) {
      return { h: (bytes[pos + 5] << 8) | bytes[pos + 6], w: (bytes[pos + 7] << 8) | bytes[pos + 8] };
    }
    pos += 2 + len;
  }
  return null;
}
