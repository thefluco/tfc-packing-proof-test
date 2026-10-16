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

function scaleStrip(ctx, x0, y0, x1, y1, cm, k) {
  // printed scale: tick every cm, digits every 5 cm
  ctx.strokeStyle = '#111'; ctx.fillStyle = '#111'; ctx.font = `bold ${Math.round(11 * k)}px sans-serif`;
  for (let i = 0; i <= cm; i++) {
    const t = i / cm, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
    const len = (i % 5 === 0 ? 10 : 5) * k;
    ctx.lineWidth = Math.max(1, k);
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + len); ctx.stroke();
    if (i % 10 === 0) ctx.fillText(String(i), x - 6 * k, y + 22 * k);
  }
}

function drawScene(ctx, W, H, scene, jx, jy) {
  const k = W / 1280;
  ctx.save();
  ctx.translate(jx * k, jy * k);
  if (scene.kind === 'label') {
    ctx.fillStyle = '#b98b5a'; ctx.fillRect(-20 * k, -20 * k, W + 40 * k, H + 40 * k);
    noise(ctx, W, H, 7, 0.25);
    label(ctx, W * 0.25, H * 0.18, W * 0.5, H * 0.62, scene.code, k);
  } else if (scene.kind === 'scale') {
    ctx.fillStyle = '#d9d9d6'; ctx.fillRect(-20 * k, -20 * k, W + 40 * k, H + 40 * k);
    noise(ctx, W, H, 11, 0.15);
    ctx.fillStyle = '#555'; ctx.fillRect(W * 0.2, H * 0.35, W * 0.6, H * 0.55);           // platform
    ctx.fillStyle = '#c8a46e'; ctx.fillRect(W * 0.08, H * 0.42, W * 0.84, H * 0.3);       // the box
    label(ctx, W * 0.42, H * 0.45, W * 0.16, H * 0.22, scene.code, k * 0.35);
    ctx.fillStyle = '#122'; ctx.fillRect(W * 0.66, H * 0.05, W * 0.26, H * 0.2);           // display
    ctx.fillStyle = '#6f6'; ctx.font = `bold ${Math.round(60 * k)}px monospace`;
    ctx.fillText(scene.weight || '16.85', W * 0.68, H * 0.2);
  } else if (scene.kind === 'boxes') {
    ctx.fillStyle = '#e8e8e4'; ctx.fillRect(-20 * k, -20 * k, W + 40 * k, H + 40 * k);
    noise(ctx, W, H, 5, 0.15);
    ctx.fillStyle = '#c8a46e'; ctx.fillRect(W * 0.05, H * 0.2, W * 0.42, H * 0.6); ctx.fillRect(W * 0.53, H * 0.25, W * 0.42, H * 0.55);
    label(ctx, W * 0.14, H * 0.3, W * 0.24, H * 0.36, scene.code, k * 0.5);
    label(ctx, W * 0.62, H * 0.33, W * 0.24, H * 0.36, scene.code2 || scene.code, k * 0.5);
  } else {   // bay: breadth or length-height
    ctx.fillStyle = '#9a9a96'; ctx.fillRect(-20 * k, -20 * k, W + 40 * k, H + 40 * k);
    ctx.fillStyle = '#f2f2ee';
    ctx.beginPath(); ctx.moveTo(W * 0.12, H * 0.22); ctx.lineTo(W * 0.88, H * 0.22); ctx.lineTo(W * 0.97, H * 0.85); ctx.lineTo(W * 0.03, H * 0.85); ctx.closePath(); ctx.fill();
    noise(ctx, W, H, 3, 0.08);
    scaleStrip(ctx, W * 0.04, H * 0.8, W * 0.96, H * 0.8, 180, k);       // scale L
    scaleStrip(ctx, W * 0.12, H * 0.24, W * 0.05, H * 0.78, 75, k);       // B1
    scaleStrip(ctx, W * 0.87, H * 0.24, W * 0.95, H * 0.78, 75, k);       // B2
    ctx.fillStyle = '#c8a46e'; ctx.fillRect(W * 0.14, H * 0.25, W * 0.5, H * 0.24);       // the box, back-left
    label(ctx, W * 0.33, H * 0.28, W * 0.12, H * 0.17, scene.code, k * 0.28);
    ctx.fillStyle = '#7a4b22';
    if (scene.kind === 'breadth') ctx.fillRect(W * 0.1, H * 0.49, W * 0.8, H * 0.025);   // low fence
    else { ctx.fillRect(W * 0.64, H * 0.22, W * 0.02, H * 0.6); ctx.fillRect(W * 0.3, H * 0.12, W * 0.015, H * 0.16); }   // end panel + gauge
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
    if (this.ctrl.cover) hand(ctx, W, H, this.scene.kind);
    if (this.ctrl.glare) glare(ctx, W, H, this.scene.kind);
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
