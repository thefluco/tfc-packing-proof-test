// Image checks used on the live preview and again on the full-size still. Pure functions on grey pixels,
// so they run the same in the page and in the still worker.
//
// Sharpness is the score the 15 Oct frame trial used (actions.py `sharpness`): the variance of PIL's
// FIND_EDGES map on a 540x960 grey copy (960x540 when landscape). FIND_EDGES is the 3x3 kernel
// [-1 -1 -1; -1 8 -1; -1 -1 -1], clipped to 0..255, with the one-pixel border copied from the input.

export function analysisSize(w, h) {
  return h >= w ? { w: 540, h: 960 } : { w: 960, h: 540 };
}

// PIL's "L" conversion: L = R*299/1000 + G*587/1000 + B*114/1000, in fixed point.
export function toGray(rgba) {
  const n = rgba.length >> 2, g = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = (rgba[j] * 19595 + rgba[j + 1] * 38470 + rgba[j + 2] * 7471 + 32768) >> 16;
  return g;
}

export function edgeVariance(g, w, h) {
  let sum = 0, sum2 = 0;
  for (let x = 0; x < w; x++) {
    const a = g[x], b = g[(h - 1) * w + x];
    sum += a + b; sum2 += a * a + b * b;
  }
  for (let y = 1; y < h - 1; y++) {
    const a = g[y * w], b = g[y * w + w - 1];
    sum += a + b; sum2 += a * a + b * b;
  }
  for (let y = 1; y < h - 1; y++) {
    const r0 = (y - 1) * w, r1 = y * w, r2 = (y + 1) * w;
    for (let x = 1; x < w - 1; x++) {
      const c = g[r1 + x];
      let v = 9 * c - (g[r0 + x - 1] + g[r0 + x] + g[r0 + x + 1] + g[r1 + x - 1] + c + g[r1 + x + 1] + g[r2 + x - 1] + g[r2 + x] + g[r2 + x + 1]);
      if (v < 0) v = 0; else if (v > 255) v = 255;
      sum += v; sum2 += v * v;
    }
  }
  const n = w * h, mean = sum / n;
  return sum2 / n - mean * mean;
}

// Box-average shrink by an integer factor (for the steadiness check).
export function shrink(g, w, h, f) {
  const sw = Math.floor(w / f), sh = Math.floor(h / f), out = new Uint8Array(sw * sh), area = f * f;
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      let s = 0;
      for (let dy = 0; dy < f; dy++) {
        const row = (y * f + dy) * w + x * f;
        for (let dx = 0; dx < f; dx++) s += g[row + dx];
      }
      out[y * sw + x] = (s / area + 0.5) | 0;
    }
  }
  return { g: out, w: sw, h: sh };
}

// Share of pixels that changed by more than `thr` levels between two same-size small frames.
export function changeFraction(a, b, thr = 12) {
  if (!a || !b || a.length !== b.length) return 1;
  let n = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > thr) n++;
  return n / a.length;
}

export function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Light: mean brightness of the whole frame, and burnt-out pixels (>= 250) inside the zone that holds the
// readings (normalised polygon; null = whole frame). A glare SPOT is a 20x20 block that is mostly burnt out.
export function lightCheck(g, w, h, zone, spotShare = 0.4) {
  let sum = 0;
  for (let i = 0; i < g.length; i++) sum += g[i];
  const B = 20, bw = Math.ceil(w / B), bh = Math.ceil(h / B);
  let zonePx = 0, hot = 0, spot = null, worst = 0;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const x0 = bx * B, y0 = by * B, x1 = Math.min(w, x0 + B), y1 = Math.min(h, y0 + B);
      if (zone && !pointInPoly((x0 + x1) / 2 / w, (y0 + y1) / 2 / h, zone)) continue;
      let n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (g[y * w + x] >= 250) n++;
      const px = (x1 - x0) * (y1 - y0);
      zonePx += px; hot += n;
      const share = n / px;
      if (share > worst) worst = share;
      if (share >= spotShare && !spot) spot = { x: (x0 + x1) / 2 / w, y: (y0 + y1) / 2 / h };
    }
  }
  return { bright: sum / g.length, glare: zonePx ? hot / zonePx : 0, spot, worst };
}

// One verdict for a frame or a still. `lv` = levels from config/settings, `kind` = photo kind.
// Glare only blocks inside a known reading zone (a calibrated mount): a white label or white laminate can be
// bright without hiding anything, and the label's readability is proven by reading its barcode on the still.
export function judge(m, kind, lv, glareBlocks = true) {
  const reasons = [];
  const need = lv.sharp[kind] ?? 150;
  if (m.sharp < need) reasons.push(`blurred (${Math.round(m.sharp)} < ${need})`);
  if (m.bright < lv.brightMin) reasons.push('too dark');
  if (m.bright > lv.brightMax) reasons.push('too bright');
  if (glareBlocks && m.spot) reasons.push('glare spot on a reading');
  else if (glareBlocks && m.glare > lv.glareFrame) reasons.push(`glare ${(m.glare * 100).toFixed(1)}% on the readings`);
  return { ok: reasons.length === 0, reasons, need };
}

// Grey pixels + every metric for one image source (video, bitmap or canvas), drawn at the analysis size.
// `ctx` is a 2D context of a reusable canvas; the caller sizes it.
export function measure(ctx, source, sw, sh, zone, spotShare) {
  const { w, h } = analysisSize(sw, sh);
  if (ctx.canvas.width !== w || ctx.canvas.height !== h) { ctx.canvas.width = w; ctx.canvas.height = h; }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, w, h);
  const g = toGray(ctx.getImageData(0, 0, w, h).data);
  const light = lightCheck(g, w, h, zone, spotShare);
  return { g, w, h, sharp: edgeVariance(g, w, h), ...light };
}
