// Outlines drawn over the live camera: where the label, the box, the boxes and the readings should be.
// Coordinates are normalised to the video frame (0..1). The bay and scale outlines can be calibrated once per
// mount (Settings): tap the corners on the live picture, and the outline then matches the station exactly.

export const BAY_CORNERS = ['back-left', 'back-right', 'front-right', 'front-left'];
export const DEFAULT_BAY = [[0.12, 0.22], [0.88, 0.22], [0.97, 0.85], [0.03, 0.85]];
export const DEFAULT_PLATFORM = [[0.2, 0.35], [0.8, 0.35], [0.8, 0.9], [0.2, 0.9]];
export const DEFAULT_DISPLAY = [[0.64, 0.03], [0.94, 0.03], [0.94, 0.27], [0.64, 0.27]];

const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
// Point inside the bay quad: u along the length (0 = left wall), v front-to-back (0 = back wall).
export const inBay = (q, u, v) => lerp(lerp(q[0], q[1], u), lerp(q[3], q[2], u), v);

// Displayed video rectangle inside its box (object-fit: contain).
export function videoRect(boxW, boxH, vw, vh) {
  const s = Math.min(boxW / vw, boxH / vh), w = vw * s, h = vh * s;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}

function calibFor(calib, mount, aspect) {
  const c = calib && calib[mount];
  if (!c || !c.pts) return null;
  return Math.abs(c.aspect - aspect) / aspect < 0.05 ? c : null;   // phone turned since calibration: ignore it
}

// The area whose glare matters (null = the whole frame).
export function glareZone(kind, calib, aspect) {
  if (kind === 'breadth' || kind === 'length-height') {
    const c = calibFor(calib, 'bay', aspect);
    return c ? c.pts : null;
  }
  if (kind === 'scale') {
    const c = calibFor(calib, 'scale', aspect);
    return c && c.display ? c.display : null;
  }
  return null;
}

function poly(ctx, r, pts, close = true) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(r.x + x * r.w, r.y + y * r.h) : ctx.moveTo(r.x + x * r.w, r.y + y * r.h)));
  if (close) ctx.closePath();
}

function tag(ctx, r, [x, y], text, color = '#fff') {
  const px = r.x + x * r.w, py = r.y + y * r.h;
  ctx.font = '600 13px system-ui, sans-serif';
  const w = ctx.measureText(text).width + 10;
  ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(px - w / 2, py - 10, w, 20);
  ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, px, py);
  ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
}

// extra: { barcodes:[{box, good}], spot:{x,y}, ready:bool }
export function drawOverlay(ctx, r, kind, calib, extra = {}) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  const aspect = r.w / r.h, ok = extra.ready ? '#3ddc84' : '#ffd54a';
  ctx.lineWidth = 3;
  if (kind === 'label') {
    const s = Math.min(r.w, r.h) * 0.7, w = r.w > r.h ? s * 1.2 : s, h = r.w > r.h ? s : s * 1.2;
    ctx.strokeStyle = ok; ctx.setLineDash([12, 8]);
    ctx.strokeRect(r.x + (r.w - w) / 2, r.y + (r.h - h) / 2, w, h);
    ctx.setLineDash([]);
    tag(ctx, { x: r.x, y: r.y, w: r.w, h: r.h }, [0.5, (r.h - h) / 2 / r.h - 0.03 + 0.06], 'Whole label inside, a little box around it');
  } else if (kind === 'breadth' || kind === 'length-height') {
    const c = calibFor(calib, 'bay', aspect), q = c ? c.pts : DEFAULT_BAY;
    ctx.strokeStyle = c ? ok : 'rgba(255,255,255,0.8)'; ctx.setLineDash(c ? [] : [10, 8]);
    poly(ctx, r, q); ctx.stroke();
    ctx.setLineDash([8, 6]); ctx.strokeStyle = 'rgba(61,220,132,0.9)';
    poly(ctx, r, [inBay(q, 0, 0), inBay(q, 0.62, 0), inBay(q, 0.62, 0.42), inBay(q, 0, 0.42)]); ctx.stroke();
    ctx.setLineDash([]);
    tag(ctx, r, inBay(q, 0.31, 0.21), 'Box: back-left corner, label up');
    tag(ctx, r, inBay(q, 0.5, 0.97), 'scale L');
    tag(ctx, r, inBay(q, 0.04, 0.6), 'B1');
    tag(ctx, r, inBay(q, 0.96, 0.6), 'B2');
    if (kind === 'breadth') tag(ctx, r, inBay(q, 0.5, 0.55), 'Low fence on the widest bulge', '#ffd54a');
    else tag(ctx, r, inBay(q, 0.8, 0.3), 'End panel + gauge arm', '#ffd54a');
    if (!c) tag(ctx, r, [0.5, 0.06], 'Outline not calibrated - see Settings', '#ffd54a');
  } else if (kind === 'scale') {
    const c = calibFor(calib, 'scale', aspect);
    ctx.strokeStyle = c ? ok : 'rgba(255,255,255,0.8)'; ctx.setLineDash(c ? [] : [10, 8]);
    poly(ctx, r, c ? c.pts : DEFAULT_PLATFORM); ctx.stroke();
    ctx.strokeStyle = '#ffd54a'; poly(ctx, r, c && c.display ? c.display : DEFAULT_DISPLAY); ctx.stroke();
    ctx.setLineDash([]);
    const d = c && c.display ? c.display : DEFAULT_DISPLAY;
    tag(ctx, r, [(d[0][0] + d[2][0]) / 2, Math.min(0.97, d[2][1] + 0.04)], 'Reading', '#ffd54a');
    tag(ctx, r, [0.5, 0.97], 'Both ends clear of the floor');
    if (!c) tag(ctx, r, [0.5, 0.06], 'Outline not calibrated - see Settings', '#ffd54a');
  } else if (kind === 'boxes') {
    tag(ctx, r, [0.5, 0.06], 'Every box side by side, labels facing the camera');
  }
  for (const b of extra.barcodes || []) {
    if (!b.box) continue;
    ctx.strokeStyle = b.good ? '#3ddc84' : '#ff6b6b'; ctx.lineWidth = 4;
    ctx.strokeRect(r.x + b.box.x * r.w, r.y + b.box.y * r.h, b.box.w * r.w, b.box.h * r.h);
  }
  if (extra.spot) {
    ctx.strokeStyle = '#ff4d4d'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(r.x + extra.spot.x * r.w, r.y + extra.spot.y * r.h, 26, 0, Math.PI * 2); ctx.stroke();
    tag(ctx, r, [extra.spot.x, Math.min(0.95, extra.spot.y + 0.07)], 'Glare', '#ff8a8a');
  }
}

// Calibration: what to tap, in order, for each mount.
export const CALIB_STEPS = {
  bay: ['Tap the BACK-LEFT corner of the bay base', 'Tap the BACK-RIGHT corner', 'Tap the FRONT-RIGHT corner', 'Tap the FRONT-LEFT corner'],
  scale: ['Tap the platform: top-left corner', 'top-right corner', 'bottom-right corner', 'bottom-left corner', 'Tap the reading window: top-left corner', 'its bottom-right corner'],
};

export function calibFromTaps(mount, taps, aspect) {
  if (mount === 'bay') return { pts: taps.slice(0, 4), aspect };
  const [a, b] = taps.slice(4, 6);
  return { pts: taps.slice(0, 4), display: [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]], aspect };
}

export function drawTaps(ctx, r, taps) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.fillStyle = '#ffd54a'; ctx.strokeStyle = '#ffd54a'; ctx.lineWidth = 3;
  taps.forEach(([x, y], i) => {
    ctx.beginPath(); ctx.arc(r.x + x * r.w, r.y + y * r.h, 9, 0, Math.PI * 2); ctx.fill();
    tag(ctx, r, [x, Math.min(0.97, y + 0.05)], String(i + 1), '#ffd54a');
  });
  if (taps.length >= 2) { poly(ctx, r, taps.slice(0, 4), taps.length >= 4); ctx.stroke(); }
}
