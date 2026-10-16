// Demo camera for testing on a computer (Settings > Demo camera, or ?demo=1). It draws a fake station:
// a label with a real Code 128 barcode, the bay with printed scales, the platform scale. It shakes and blurs
// for a moment after every change so the steady/sharp checks are exercised. Never used on the station phone.

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

function drawBarcode(ctx, text, cx, y, maxW, h, minModule) {
  const widths = code128(text);
  const total = [...widths].reduce((a, c) => a + Number(c), 0);
  const m = Math.max(minModule, Math.floor(maxW / (total + 20)));
  let x = Math.round(cx - (total * m) / 2), bar = true;
  ctx.fillStyle = '#000';
  for (const c of widths) {
    const w = Number(c) * m;
    if (bar) ctx.fillRect(x, y, w, h);
    x += w; bar = !bar;
  }
  return total * m;
}

function noise(ctx, W, H, seed, alpha) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  ctx.globalAlpha = alpha;
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = rnd() > 0.5 ? '#000' : '#fff';
    ctx.fillRect(rnd() * W, rnd() * H, 2 + rnd() * W * 0.004, 2 + rnd() * H * 0.004);
  }
  ctx.globalAlpha = 1;
}

function label(ctx, x, y, w, h, code, k) {
  ctx.fillStyle = '#e9e8e1'; ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#222'; ctx.lineWidth = 2 * k; ctx.strokeRect(x + 6 * k, y + 6 * k, w - 12 * k, h - 12 * k);
  ctx.fillStyle = '#111'; ctx.font = `bold ${Math.round(h * 0.07)}px sans-serif`;
  ctx.fillText('DEMO LABEL - NOT A SHIPMENT', x + 14 * k, y + h * 0.12);
  ctx.font = `${Math.round(h * 0.055)}px sans-serif`;
  ctx.fillText('Order TFC-001599999   Box ' + (code.slice(-1) === '2' ? '2/2' : '1/2'), x + 14 * k, y + h * 0.22);
  drawBarcode(ctx, code, x + w / 2, y + h * 0.3, w * 0.86, h * 0.3, Math.max(2, Math.round(2 * k)));
  ctx.fillStyle = '#111'; ctx.font = `bold ${Math.round(h * 0.075)}px monospace`;
  ctx.fillText('AWB ' + code, x + w * 0.2, y + h * 0.72);
  ctx.font = `${Math.round(h * 0.05)}px sans-serif`;
  ctx.fillText('Demo Street, Test City 000000', x + 14 * k, y + h * 0.84);
}

// The bay base, as the default outline sees it: u along the length (0 = left wall), v from the back wall (0).
const BAY_Q = [[0.12, 0.22], [0.88, 0.22], [0.97, 0.85], [0.03, 0.85]];
function bayPt(W, H, u, v) {
  const l = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const p = l(l(BAY_Q[0], BAY_Q[1], u), l(BAY_Q[3], BAY_Q[2], u), v);
  return [p[0] * W, p[1] * H];
}
const DEFAULT_TRUTH = { weight: '16.85', length: '103.5', breadth: '26', height: '27' };

function drawBay(ctx, W, H, kind, t, code, withLabel, k) {
  const P = (u, v) => bayPt(W, H, u, v), poly = (pts) => { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p))); ctx.closePath(); };
  ctx.fillStyle = '#9a9a96'; ctx.fillRect(-20 * k, -20 * k, W + 40 * k, H + 40 * k);
  ctx.fillStyle = '#f2f2ee'; poly([P(0, 0), P(1, 0), P(1, 1), P(0, 1)]); ctx.fill();
  noise(ctx, W, H, 3, 0.08);
  ctx.strokeStyle = '#111'; ctx.fillStyle = '#111'; ctx.lineWidth = Math.max(1, k);
  ctx.font = `bold ${Math.round(12 * k)}px sans-serif`;
  for (let cm = 0; cm <= 180; cm++) {        // scale L along the front edge
    const [x, y] = P(cm / 180, 1), len = (cm % 5 ? 6 : 12) * k;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + len); ctx.stroke();
    if (cm % 10 === 0) ctx.fillText(String(cm), x - 7 * k, y + 26 * k);
  }
  for (const [u, dir] of [[0, -1], [1, 1]]) {   // B1 (left end) and B2 (right end), 0 at the back wall
    for (let cm = 0; cm <= 75; cm++) {
      const [x, y] = P(u, cm / 75), len = (cm % 5 ? 6 : 12) * k * dir;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + len, y); ctx.stroke();
      if (cm % 10 === 0) ctx.fillText(String(cm), x + (dir < 0 ? -34 : 16) * k, y + 4 * k);
    }
  }
  const L = Number(t.length) / 180, B = Number(t.breadth) / 75;
  ctx.fillStyle = '#c8a46e'; poly([P(0, 0), P(L, 0), P(L, B), P(0, B)]); ctx.fill();   // the box, back-left
  if (withLabel) { const [cx, cy] = P(L / 2, B / 2); label(ctx, cx - W * 0.06, cy - H * 0.08, W * 0.12, H * 0.16, code, k * 0.28); }
  ctx.strokeStyle = '#7a4b22'; ctx.lineWidth = 9 * k;
  if (kind === 'breadth') {                  // low fence against the front of the box
    ctx.beginPath(); ctx.moveTo(...P(-0.02, B + 0.01)); ctx.lineTo(...P(1.02, B + 0.01)); ctx.stroke();
  } else {                                   // end panel at the far end, and the height gauge
    ctx.beginPath(); ctx.moveTo(...P(L + 0.005, -0.02)); ctx.lineTo(...P(L + 0.005, 1.04)); ctx.stroke();
    const [gx, gy] = P(Math.min(L + 0.07, 0.96), Math.min(B + 0.2, 0.9)), postH = H * 0.32;
    ctx.lineWidth = 6 * k; ctx.beginPath(); ctx.moveTo(gx, gy); ctx.lineTo(gx, gy - postH); ctx.stroke();
    ctx.lineWidth = Math.max(1, k); ctx.strokeStyle = '#111'; ctx.fillStyle = '#111';
    for (let cm = 0; cm <= 50; cm++) {
      const y = gy - (cm / 50) * postH, len = (cm % 5 ? 5 : 10) * k;
      ctx.beginPath(); ctx.moveTo(gx + 4 * k, y); ctx.lineTo(gx + 4 * k + len, y); ctx.stroke();
      if (cm % 10 === 0) ctx.fillText(String(cm), gx + 18 * k, y + 4 * k);
    }
    const ay = gy - (Number(t.height) / 50) * postH;
    ctx.strokeStyle = '#7a4b22'; ctx.lineWidth = 5 * k;
    ctx.beginPath(); ctx.moveTo(gx - 70 * k, ay); ctx.lineTo(gx, ay); ctx.stroke();
  }
}

function drawScene(ctx, W, H, scene, jx, jy) {
  const k = W / 1280, kind = String(scene.kind || '').replace(/^measure-/, ''), t = scene.truth || DEFAULT_TRUTH;
  const withLabel = scene.label !== false;
  ctx.save();
  ctx.translate(jx * k, jy * k);
  if (kind === 'label') {
    ctx.fillStyle = '#b98b5a'; ctx.fillRect(-20 * k, -20 * k, W + 40 * k, H + 40 * k);
    noise(ctx, W, H, 7, 0.25);
    label(ctx, W * 0.25, H * 0.18, W * 0.5, H * 0.62, scene.code, k);
  } else if (kind === 'scale') {
    ctx.fillStyle = '#d9d9d6'; ctx.fillRect(-20 * k, -20 * k, W + 40 * k, H + 40 * k);
    noise(ctx, W, H, 11, 0.15);
    ctx.fillStyle = '#555'; ctx.fillRect(W * 0.2, H * 0.35, W * 0.6, H * 0.55);           // platform
    ctx.fillStyle = '#c8a46e'; ctx.fillRect(W * 0.08, H * 0.42, W * 0.84, H * 0.3);       // the box
    if (withLabel) label(ctx, W * 0.42, H * 0.45, W * 0.16, H * 0.22, scene.code, k * 0.35);
    ctx.fillStyle = '#122'; ctx.fillRect(W * 0.66, H * 0.05, W * 0.26, H * 0.2);           // display
    ctx.fillStyle = '#6f6'; ctx.font = `bold ${Math.round(60 * k)}px monospace`;
    ctx.fillText(Number(t.weight).toFixed(2), W * 0.68, H * 0.2);
  } else if (kind === 'boxes') {
    ctx.fillStyle = '#e8e8e4'; ctx.fillRect(-20 * k, -20 * k, W + 40 * k, H + 40 * k);
    noise(ctx, W, H, 5, 0.15);
    ctx.fillStyle = '#c8a46e'; ctx.fillRect(W * 0.05, H * 0.2, W * 0.42, H * 0.6); ctx.fillRect(W * 0.53, H * 0.25, W * 0.42, H * 0.55);
    label(ctx, W * 0.14, H * 0.3, W * 0.24, H * 0.36, scene.code, k * 0.5);
    label(ctx, W * 0.62, H * 0.33, W * 0.24, H * 0.36, scene.code2 || scene.code, k * 0.5);
  } else {   // bay: breadth or length-height, boards placed at the box's true size
    drawBay(ctx, W, H, kind, t, scene.code, withLabel, k);
  }
  ctx.restore();
}

// Demo buttons: a bright glare spot where a reading is, and a hand over the label's barcode.
const GLARE_AT = { scale: [0.79, 0.15], breadth: [0.9, 0.5], 'length-height': [0.9, 0.5], label: [0.5, 0.42], boxes: [0.3, 0.45] };
function glare(ctx, W, H, kind) {
  const [x, y] = GLARE_AT[kind] || [0.5, 0.5], r = W * 0.07, g = ctx.createRadialGradient(x * W, y * H, 0, x * W, y * H, r);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.65, 'rgba(255,255,255,1)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x * W, y * H, r, 0, Math.PI * 2); ctx.fill();
}
function hand(ctx, W, H, kind) {
  const box = kind === 'label' ? [0.28, 0.32, 0.44, 0.28] : kind === 'scale' ? [0.4, 0.43, 0.2, 0.26] : kind === 'boxes' ? [0.12, 0.28, 0.3, 0.4] : [0.31, 0.26, 0.16, 0.2];
  ctx.fillStyle = '#c68863';
  ctx.beginPath(); ctx.roundRect(box[0] * W, box[1] * H, box[2] * W, box[3] * H, W * 0.02); ctx.fill();
}

export class DemoCamera {
  constructor() {
    this.canvas = null; this.stream = null; this.video = null; this.scene = { kind: 'label', code: '' }; this.shakeUntil = 0; this.timer = 0; this.track = null;
    this.ctrl = { shake: false, glare: false, cover: false };
  }

  paint(ctx, W, H, jx, jy) {
    drawScene(ctx, W, H, this.scene, jx, jy);
    ctx.filter = 'none';
    const kind = String(this.scene.kind || '').replace(/^measure-/, '');
    if (this.ctrl.cover) hand(ctx, W, H, kind);
    if (this.ctrl.glare) glare(ctx, W, H, kind);
  }

  setScene(scene) {
    this.scene = { ...this.scene, ...scene };
    this.shakeUntil = performance.now() + 1200;
  }

  async start(video) {
    this.stop();
    this.canvas = document.createElement('canvas');
    this.canvas.width = 1280; this.canvas.height = 720;
    const ctx = this.canvas.getContext('2d');
    const tick = () => {
      const shaking = performance.now() < this.shakeUntil || this.ctrl.shake;
      ctx.filter = shaking ? 'blur(4px)' : 'none';
      this.paint(ctx, 1280, 720, shaking ? (Math.random() - 0.5) * 40 : 0, shaking ? (Math.random() - 0.5) * 30 : 0);
      ctx.filter = 'none';
    };
    tick();
    this.timer = setInterval(tick, 66);
    this.stream = this.canvas.captureStream(15);
    this.track = this.stream.getVideoTracks()[0];
    video.muted = true; video.playsInline = true; video.srcObject = this.stream;
    await video.play().catch(() => {});
    if (!video.videoWidth) await new Promise((r) => video.addEventListener('loadedmetadata', r, { once: true }));
    this.video = video;
    this.shakeUntil = performance.now() + 1200;
    return this.info();
  }

  async attach(video) {
    video.muted = true; video.playsInline = true; video.srcObject = this.stream;
    await video.play().catch(() => {});
    if (!video.videoWidth) await new Promise((r) => video.addEventListener('loadedmetadata', r, { once: true }));
    this.video = video;
  }

  info() { return { label: 'Demo camera (computer test)', preview: '1280x720', still: '4000x2250 drawn' }; }

  stop() {
    clearInterval(this.timer);
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    if (this.video) this.video.srcObject = null;
    this.stream = null; this.video = null; this.track = null;
  }

  get live() { return !!this.stream; }

  async takePhoto() {
    const W = 4000, H = 2250, c = new OffscreenCanvas(W, H), ctx = c.getContext('2d');
    if (performance.now() < this.shakeUntil || this.ctrl.shake) ctx.filter = 'blur(12px)';
    this.paint(ctx, W, H, 0, 0);
    return { blob: await c.convertToBlob({ type: 'image/jpeg', quality: 0.95 }), via: 'demo camera' };
  }
}
