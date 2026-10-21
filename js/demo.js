// Demo camera for testing on a computer (?demo=1): it draws a pretend photo at phone resolution instead of opening
// the camera app. Everything on it is made up - the slip, the order number, the label, the AWB, the address.
// The browser tests use the same drawings (blurred and tilted) for the order-number reader.
// Never used on the station phone.

const C128 = ['212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313', '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111', '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412', '211214', '211232', '2331112'];

// Bar/space widths (in modules) for a Code 128 symbol: set C for even-length digits, else set B.
export function code128(text) {
  const codes = [];
  if (/^\d+$/.test(text) && text.length % 2 === 0) {
    codes.push(105);
    for (let i = 0; i < text.length; i += 2) codes.push(Number(text.slice(i, i + 2)));
  } else {
    codes.push(104);
    for (const ch of text) {
      const v = ch.charCodeAt(0) - 32;
      if (v < 0 || v > 95) throw new Error('Code 128 B cannot encode ' + ch);
      codes.push(v);
    }
  }
  let sum = codes[0];
  for (let i = 1; i < codes.length; i++) sum += i * codes[i];
  codes.push(sum % 103, 106);
  return codes.map((c) => C128[c]).join('');
}

// EAN-13 (a product barcode) as a string of modules, 1 = bar. `digits`: 12 digits, the check digit is added.
const EAN_L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const EAN_G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const EAN_R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
const EAN_P = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
export function ean13(digits) {
  const d = String(digits).slice(0, 12).split('').map(Number);
  const sum = d.reduce((a, x, i) => a + x * (i % 2 ? 3 : 1), 0);
  d.push((10 - (sum % 10)) % 10);
  let m = '101';
  for (let i = 1; i <= 6; i++) m += (EAN_P[d[0]][i - 1] === 'L' ? EAN_L : EAN_G)[d[i]];
  m += '01010';
  for (let i = 7; i <= 12; i++) m += EAN_R[d[i]];
  return { modules: m + '101', text: d.join('') };
}

// Code 39, as the Shopify packing slip prints the order number (21 Oct 2026): 9 elements a character (bar, space,
// ...), w = wide (3 modules), n = narrow; characters are separated by one narrow space; * starts and stops it.
const C39 = {
  0: 'nnnwwnwnn', 1: 'wnnwnnnnw', 2: 'nnwwnnnnw', 3: 'wnwwnnnnn', 4: 'nnnwwnnnw', 5: 'wnnwwnnnn', 6: 'nnwwwnnnn', 7: 'nnnwnnwnw',
  8: 'wnnwnnwnn', 9: 'nnwwnnwnn', A: 'wnnnnwnnw', B: 'nnwnnwnnw', C: 'wnwnnwnnn', D: 'nnnnwwnnw', E: 'wnnnwwnnn', F: 'nnwnwwnnn',
  G: 'nnnnnwwnw', H: 'wnnnnwwnn', I: 'nnwnnwwnn', J: 'nnnnwwwnn', K: 'wnnnnnnww', L: 'nnwnnnnww', M: 'wnwnnnnwn', N: 'nnnnwnnww',
  O: 'wnnnwnnwn', P: 'nnwnwnnwn', Q: 'nnnnnnwww', R: 'wnnnnnwwn', S: 'nnwnnnwwn', T: 'nnnnwnwwn', U: 'wwnnnnnnw', V: 'nwwnnnnnw',
  W: 'wwwnnnnnn', X: 'nwnnwnnnw', Y: 'wwnnwnnnn', Z: 'nwwnwnnnn', '-': 'nwnnnnwnw', '.': 'wwnnnnwnn', ' ': 'nwwnnnwnn', '*': 'nwnnwnwnn',
};
// Element widths in modules (bar, space, bar, ...) for `*text*`.
export function code39(text) {
  const out = [];
  [...`*${String(text).toUpperCase()}*`].forEach((ch, i) => {
    if (!C39[ch]) throw new Error('Code 39 cannot encode ' + ch);
    if (i) out.push(1);
    for (const e of C39[ch]) out.push(e === 'w' ? 3 : 1);
  });
  return out;
}
function drawCode39(ctx, text, x, y, maxW, h) {
  const widths = code39(text), total = widths.reduce((a, c) => a + c, 0) + 20;   // + quiet zones
  const m = Math.max(2, Math.floor(maxW / total));
  ctx.fillStyle = '#fff'; ctx.fillRect(x, y, maxW, h);
  let cx = Math.round(x + (maxW - (total - 20) * m) / 2);
  ctx.fillStyle = '#000';
  widths.forEach((w, i) => { if (i % 2 === 0) ctx.fillRect(cx, y, w * m, h); cx += w * m; });
}

function drawCode128(ctx, text, x, y, maxW, h) {
  const widths = code128(text);
  const total = [...widths].reduce((a, c) => a + Number(c), 0);
  const m = Math.max(2, Math.floor(maxW / total));
  let cx = Math.round(x + (maxW - total * m) / 2), bar = true;
  ctx.fillStyle = '#000';
  for (const c of widths) { const w = Number(c) * m; if (bar) ctx.fillRect(cx, y, w, h); cx += w; bar = !bar; }
}
function drawEan13(ctx, digits, x, y, maxW, h) {
  const { modules, text } = ean13(digits), m = Math.max(2, Math.floor(maxW / (modules.length + 18)));
  ctx.fillStyle = '#fff'; ctx.fillRect(x - 9 * m, y - 4 * m, (modules.length + 18) * m, h + 20 * m);
  ctx.fillStyle = '#000';
  [...modules].forEach((b, i) => { if (b === '1') ctx.fillRect(x + i * m, y, m, h); });
  ctx.font = `${Math.round(m * 9)}px sans-serif`; ctx.fillText(text, x, y + h + 10 * m);
  return text;
}

function noise(ctx, W, H, seed, alpha, n = 900) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  ctx.globalAlpha = alpha;
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = rnd() > 0.5 ? '#000' : '#fff';
    ctx.fillRect(rnd() * W, rnd() * H, 2 + rnd() * W * 0.004, 2 + rnd() * H * 0.004);
  }
  ctx.globalAlpha = 1;
}

// A made-up packing slip, `w` wide (about 100 x 135 mm). The order number sits at the top right, small as on the
// owner's sample (about 3 mm) or, with `big`, as the template edit prints it. `bar`: the order number as a Code 39
// barcode under the header (about 80 x 12 mm), as the 21 Oct template prints it.
export function drawSlip(ctx, x, y, w, order, big = false, order2 = '', bar = false) {
  const h = w * 1.35, f = (r, b = '') => `${b} ${Math.round(w * r)}px Arial, Helvetica, sans-serif`;
  ctx.fillStyle = '#fbfbf8'; ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#bbb'; ctx.lineWidth = Math.max(1, w * 0.002); ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = '#111';
  ctx.font = f(0.042, 'bold'); ctx.textAlign = 'left'; ctx.fillText('DEMO STORE', x + w * 0.05, y + w * 0.08);
  ctx.font = f(0.022); ctx.fillText('made-up slip for tests', x + w * 0.05, y + w * 0.11);
  ctx.textAlign = 'right';
  // big: the template edit prints the order number on its own line under the header, about 7 mm tall
  ctx.font = f(big ? 0.07 : 0.032, 'bold'); ctx.fillText(`Order #${order}`, x + w * 0.95, y + w * (big ? 0.21 : 0.075));
  ctx.font = f(0.024); ctx.fillText('17 Oct 2026', x + w * 0.95, y + w * 0.11);
  ctx.textAlign = 'left';
  if (bar && order) drawCode39(ctx, order, x + w * 0.05, y + w * (big ? 0.25 : 0.13), w * 0.9, w * 0.12);
  const dy = (big ? 0.12 : 0) + (bar ? 0.16 : 0), Y = (yy) => y + w * (yy + dy), hr = (yy, t) => ctx.fillRect(x + w * 0.05, Y(yy), w * 0.9, Math.max(1, w * t));
  const line = (t, r, yy, b) => { ctx.font = f(r, b); ctx.fillText(t, x + w * 0.05, Y(yy)); };
  const right = (t, r, yy, b) => { ctx.font = f(r, b); ctx.textAlign = 'right'; ctx.fillText(t, x + w * 0.95, Y(yy)); ctx.textAlign = 'left'; };
  line('SHIP TO', 0.026, 0.22, 'bold');
  line('Test Customer', 0.03, 0.27); line('12 Demo Street, Test Nagar', 0.03, 0.31); line('Test City 000000', 0.03, 0.35); line('Phone 00000 00000', 0.03, 0.39);
  hr(0.46, 0.003);
  line('ITEMS', 0.026, 0.52, 'bold'); right('QTY', 0.026, 0.52, 'bold');
  line('Demo cushion (test item)', 0.03, 0.58); right('1', 0.03, 0.58);
  line('Demo roll (test item)', 0.03, 0.63); right('1', 0.03, 0.63);
  hr(0.7, 0.002);
  // order2: a second order number on the paper (as when the reader misreads a digit: two numbers from one slip)
  if (order2) line(`Replaces order #${order2}`, 0.036, 0.68, 'bold');
  line('Balance to pay: ________', 0.028, 0.77);
  line('Thank you! (not a real order)', 0.024, 1.2);
  return h;
}

// A made-up courier label, `w` wide: the AWB barcode, the order number as a barcode too, and "Box x/y".
export function drawLabel(ctx, x, y, w, code, order, boxText = '') {
  const h = w * 1.05, f = (r, b = '') => `${b} ${Math.round(w * r)}px Arial, Helvetica, sans-serif`;
  ctx.fillStyle = '#fff'; ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#222'; ctx.lineWidth = Math.max(2, w * 0.004); ctx.strokeRect(x + w * 0.02, y + w * 0.02, w * 0.96, h - w * 0.04);
  ctx.fillStyle = '#111'; ctx.textAlign = 'left';
  ctx.font = f(0.05, 'bold'); ctx.fillText('DEMO COURIER - TEST LABEL', x + w * 0.06, y + w * 0.1);
  if (boxText) { ctx.font = f(0.06, 'bold'); ctx.textAlign = 'right'; ctx.fillText(boxText, x + w * 0.94, y + w * 0.19); ctx.textAlign = 'left'; }
  drawCode128(ctx, code, x + w * 0.06, y + w * 0.24, w * 0.88, w * 0.26);
  ctx.font = f(0.055, 'bold'); ctx.fillText('AWB ' + code, x + w * 0.1, y + w * 0.58);
  if (order) {
    drawCode128(ctx, order, x + w * 0.2, y + w * 0.64, w * 0.6, w * 0.12);
    ctx.font = f(0.035); ctx.fillText('Order ' + order, x + w * 0.3, y + w * 0.82);
  }
  ctx.font = f(0.032); ctx.fillText('To: Test Customer, Test City 000000', x + w * 0.06, y + w * 0.95);
  return h;
}

function parcel(ctx, W, H, seed) {
  ctx.fillStyle = '#b6a183'; ctx.fillRect(0, 0, W, H);          // the floor
  noise(ctx, W, H, seed, 0.25);
  ctx.fillStyle = '#e9e6dd'; ctx.fillRect(W * 0.04, H * 0.12, W * 0.92, H * 0.8);   // the parcel's wrap
  noise(ctx, W, H, seed + 1, 0.06, 400);
}

// The paper on the parcel: the slip, and with `label` the courier label stuck right next to it.
function papers(ctx, W, H, sc) {
  const sw = W * (sc.label ? 0.4 : 0.48), sx = sc.label ? W * 0.06 : W * 0.26, sy = H * 0.24;
  ctx.save();
  if (sc.tilt) { ctx.translate(W / 2, H / 2); ctx.rotate((sc.tilt * Math.PI) / 180); ctx.translate(-W / 2, -H / 2); }
  if (sc.slip !== false) drawSlip(ctx, sx, sy, sw, sc.order, sc.bigOrder, sc.order2 || '', !!sc.slipBar);
  if (sc.label) {
    const lx = W * 0.5, ly = sy + W * 0.02, lw = W * 0.44;
    drawLabel(ctx, lx, ly, lw, sc.code, sc.labelOrder === undefined ? sc.order : sc.labelOrder, sc.boxText || '');
    if (sc.smudge) {   // the label's barcodes rubbed out (its printed text still reads)
      ctx.fillStyle = '#8d8d88';
      ctx.fillRect(lx + lw * 0.04, ly + lw * 0.22, lw * 0.92, lw * 0.3); ctx.fillRect(lx + lw * 0.18, ly + lw * 0.62, lw * 0.64, lw * 0.16);
    }
  }
  ctx.restore();
}

function measureScene(ctx, W, H, sc) {
  parcel(ctx, W, H, 11);
  const kind = sc.kind;
  // the paper (smaller: it only has to be in view)
  const small = { ...sc, tilt: 0 };
  ctx.save(); ctx.translate(W * 0.18, H * 0.42); ctx.scale(0.55, 0.55); papers(ctx, W, H * 0.6, small); ctx.restore();
  ctx.fillStyle = '#111';
  if (kind === 'scale') {
    ctx.fillStyle = '#3c4650'; ctx.fillRect(W * 0.1, H * 0.86, W * 0.8, H * 0.05);
    ctx.fillStyle = '#1b2229'; ctx.fillRect(W * 0.55, H * 0.14, W * 0.38, H * 0.1);
    ctx.fillStyle = '#7cf29a'; ctx.font = `bold ${Math.round(W * 0.07)}px monospace`; ctx.fillText(sc.weight || '18.40', W * 0.58, H * 0.215);
  } else {   // a tape with cm marks, read where it meets the L-square
    const vertical = kind === 'height';
    ctx.save();
    if (vertical) { ctx.translate(W * 0.88, H * 0.9); ctx.rotate(-Math.PI / 2); } else ctx.translate(W * 0.04, H * 0.2);
    const len = vertical ? H * 0.75 : W * 0.92;
    ctx.fillStyle = '#f2c200'; ctx.fillRect(0, 0, len, W * 0.05);
    ctx.fillStyle = '#111'; ctx.font = `bold ${Math.round(W * 0.022)}px sans-serif`;
    for (let i = 0; i <= 60; i++) {
      const xx = (i / 60) * len;
      ctx.fillRect(xx, 0, 2, i % 5 ? W * 0.012 : W * 0.022);
      if (i % 10 === 0) ctx.fillText(String(i + (sc.tapeFrom || 80)), xx + 4, W * 0.045);
    }
    ctx.restore();
    ctx.fillStyle = '#1e1e1e';
    if (vertical) ctx.fillRect(W * 0.3, H * 0.3, W * 0.6, W * 0.02); else ctx.fillRect(W * 0.8, H * 0.1, W * 0.02, H * 0.8);
  }
}

function boxesScene(ctx, W, H, sc) {
  parcel(ctx, W, H, 5);
  ctx.fillStyle = '#d9d2c3'; ctx.fillRect(W * 0.04, H * 0.15, W * 0.44, H * 0.7); ctx.fillRect(W * 0.52, H * 0.18, W * 0.44, H * 0.67);
  drawLabel(ctx, W * 0.07, H * 0.3, W * 0.38, sc.code, sc.order, 'Box 1/2');
  drawLabel(ctx, W * 0.55, H * 0.32, W * 0.38, sc.code2 || sc.code, sc.order, 'Box 2/2');
}

// One pretend photo. scene: {kind: 'first'|'slip'|'label'|'scale'|'length'|'breadth'|'height'|'boxes',
//   paper: 'slip'|'label'|'product'|'blank' (the first photo), order, labelOrder, code, code2, boxText, bigOrder,
//   label (show the label in measurement photos), tilt (degrees), blur (px), weight, slipBar (the slip's barcode)}
export function drawScene(ctx, W, H, scene) {
  const sc = { order: '', code: '', ...scene };
  const kind = sc.kind === 'first' ? sc.paper || 'slip' : sc.kind;
  if (kind === 'slip' || kind === 'label') {
    parcel(ctx, W, H, 7);
    papers(ctx, W, H, { ...sc, label: kind === 'label' });
  } else if (kind === 'product') {     // a product barcode sticker, no slip, no label
    parcel(ctx, W, H, 9);
    drawEan13(ctx, sc.ean || '890123456789', W * 0.3, H * 0.4, W * 0.4, H * 0.08);
  } else if (kind === 'blank') {
    parcel(ctx, W, H, 13);
  } else if (kind === 'smudged') {     // a crumpled courier label: sharp, but its barcodes and numbers do not read
    parcel(ctx, W, H, 15);
    const x = W * 0.28, y = H * 0.24, w = W * 0.44;
    drawLabel(ctx, x, y, w, sc.code || '99001610209999', sc.order || '');
    ctx.fillStyle = '#8d8d88'; ctx.fillRect(x + w * 0.03, y + w * 0.2, w * 0.94, w * 0.68);
    ctx.strokeStyle = '#f4f4ef'; ctx.lineWidth = Math.max(3, w * 0.008);
    for (let i = 0; i < 9; i++) { ctx.beginPath(); ctx.moveTo(x + w * (0.05 + i * 0.1), y + w * 0.22); ctx.lineTo(x + w * (0.1 + i * 0.1), y + w * 0.86); ctx.stroke(); }
  } else if (kind === 'boxes') {
    boxesScene(ctx, W, H, sc);
  } else {
    measureScene(ctx, W, H, { ...sc, slip: true });
  }
}

// A pretend photo as a JPEG blob, portrait like a phone camera (3000 x 4000), blurred if asked.
export async function photo(scene, W = 3000, H = 4000, quality = 0.9) {
  const c = new OffscreenCanvas(W, H), ctx = c.getContext('2d');
  drawScene(ctx, W, H, scene);
  let out = c;
  if (scene.blur) {
    out = new OffscreenCanvas(W, H);
    const o = out.getContext('2d');
    o.filter = `blur(${scene.blur}px)`;
    o.drawImage(c, 0, 0);
  }
  return out.convertToBlob({ type: 'image/jpeg', quality });
}

export class DemoCamera {
  constructor() { this.scene = { kind: 'first', paper: 'slip' }; }
  setScene(scene) { this.scene = { ...this.scene, ...scene }; }
  async takePhoto() { return { blob: await photo(this.scene), via: 'demo camera' }; }
}
