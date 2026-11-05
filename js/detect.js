// Card detection + perspective warp with opencv.js.
// 1:1 port of mtg-bibliothek server/recognize/detect.py (all constants are calibrated there; do not
// re-tune here). Images are RGBA cv.Mats (cv.imread of a canvas); Python works on BGR, which only
// matters where a colour order is meant (it never is: every colour-dependent step here uses
// channel-symmetric maths, so RGB gives the same numbers as BGR).
// Numeric parts that numpy does in float32 use Math.fround; cv.remap sampling is emulated as in OpenCV 5.0
// (the Python reference; the opencv.js build is 4.10).
// Parity against Python: tools/ref_detect.py + web/dev/detect_check.html + tools/compare_detect.py.

export const WARP_W = 1000, WARP_H = 1400;
export const WARP_MARGIN_Y = 0.07;
export const TITLE_BOX = [0.04, 0.035, 0.80, 0.115];
export const BOTTOM_BOX = [0.02, 0.905, 0.62, 0.985];
export const ART_BOX = [0.07, 0.11, 0.93, 0.56];
export const ART_CROPS = {
  normal: [0.08, 0.12, 0.92, 0.55],
  old: [0.12, 0.11, 0.88, 0.54],
  extended: [0.00, 0.12, 1.00, 0.56],
  fullart: [0.10, 0.12, 0.90, 0.76],
  tight: [0.03, 0.09, 0.96, 0.54],
};
export const FULLART_ONLY_CROPS = { fullart_tall: [0.10, 0.14, 0.92, 0.83] };
export const REFIT_MAX_SIDES = [500, 1000];

// guide rectangle drawn over the camera image (fractions of the frame)
export function guideRect(fw, fh) {
  const h = Math.min(0.86 * fh, 0.9 * fw * 88 / 63), w = h * 63 / 88;
  const x0 = (fw - w) / 2, y0 = (fh - h) / 2;
  return [x0 / fw, y0 / fh, (x0 + w) / fw, (y0 + h) / fh];
}

// ---- tuning constants (detect.py) ----
const DETECT_MAX_SIDE = 1000, MIN_AREA_FRAC = 0.03, MAX_AREA_FRAC = 0.95;
const RATIO_MIN = 0.60, RATIO_MAX = 0.85, CARD_RATIO = 63.0 / 88.0;
const MAX_CORNER_ANGLE_DEV = 28.0, GUIDE_TOLERANCE = 0.30;
const MAX_CANDIDATES = 16, SAME_QUAD_PX = 3.0;
const REFINE_SAMPLES = 20, REFINE_RANGE = 5, REFINE_MIN_CONTRAST = 3.0, REFINE_WEAK = 0.08;
const REFINE_OUTER = 0.6, REFINE_OUTER_GAP = 3, REFINE_MAX_SHIFT = 12.0;
const SUPPORT_SAMPLES = 24, SIDE_SPAN = [0.12, 0.88], SUPPORT_MIN_CONTRAST = 7.0, SUPPORT_REACH = 4;
const SUPPORT_PEAK = 1.3, SUPPORT_REJECT = 0.35;
const RING_DEPTHS = [0.012, 0.026], RING_MAX_DIFF = 30.0, RING_MAX_SPREAD = 45.0, RING_BONUS = 1.25;
const EXPAND_DEPTH = 0.075, EXPAND_MIN_STEP = 4.0, EXPAND_PEAK = 1.6, EXPAND_FLAT = 7.0;
const EXPAND_MIN_STRIP = 3, EXPAND_STAGES = 2, PERFECT_SUPPORT = 0.95, MAX_OVERSHOOT = 0.10;
const MIN_MASK_RANGE = 40.0, BG_MIN_DIFF = 25;
const PARTIAL_MIN_AREA = 0.04, PARTIAL_MIN_SOLIDITY = 0.65, PARTIAL_MIN_CONTENT = 0.025;
const PARTIAL_KEEP_SUPPORT = 0.60, TOO_CLOSE_FILL = 0.60;
const SPAN_MIN_WIDTH = 0.85 * CARD_RATIO, SPAN_ROWS = 40, SPAN_OUTLIER_ROWS = 0.05;
const SPAN_STRAIGHT = 0.010, SPAN_ROUGH = 0.12, SPAN_PARALLEL_DEG = 10.0, SPAN_EDGE_PX = 3;
const SPAN_INNER = [0.3, 0.7], SPAN_LINE_STEP = 12.0, SPAN_LINE_SMEAR = 2, SPAN_LINE_ROWS = 0.85;
const REFIT_MIN_FILL = 0.35, REFIT_MAX_FILL = 0.96;

// ---------------------------------------------------------------------------
// small numeric helpers
// ---------------------------------------------------------------------------
const rte = x => {  // round half to even (numpy rint, cvRound, python round)
  const f = Math.floor(x), d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
};
const f32 = Math.fround;   // numpy does the quad / sampling geometry in float32; mirrored so 1/32 px roundings agree
const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const median = arr => {
  const s = Float64Array.from(arr).sort(), n = s.length;
  return n % 2 ? s[(n - 1) >> 1] : 0.5 * (s[n / 2 - 1] + s[n / 2]);
};
const maxAbsDiff = (q, o) => { let m = 0; for (let i = 0; i < 4; i++) for (let k = 0; k < 2; k++) m = Math.max(m, Math.abs(q[i][k] - o[i][k])); return m; };
const centroid = q => [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4];

// order statistics on an 8 bit histogram (numpy semantics)
function histKth(hist, k) { let c = 0; for (let v = 0; v < 256; v++) { c += hist[v]; if (c > k) return v; } return 255; }
function histPercentile(hist, n, q) {   // numpy.percentile, linear interpolation
  const pos = q / 100 * (n - 1), lo = Math.floor(pos), f = pos - lo;
  const a = histKth(hist, lo), b = histKth(hist, Math.min(lo + 1, n - 1));
  return a + (b - a) * f;
}
const histMedian = (hist, n) => n % 2 ? histKth(hist, (n - 1) / 2) : 0.5 * (histKth(hist, n / 2 - 1) + histKth(hist, n / 2));

// cv.remap(INTER_LINEAR, BORDER_REPLICATE) on an 8 bit image as OpenCV 5.0 (the Python reference) does it:
// plain float bilinear interpolation, rounded to 8 bit (0 of 20000 random points differ). OpenCV 4.x,
// which this opencv.js build is, quantizes to 1/32 pixel and would be off by one in ~2 % of the points.
// img = {data, w, h, ch}; returns Float32Array n*ch.
function sample(img, xs, ys, n) {
  const { data, w, h, ch } = img;
  const out = new Float32Array(n * ch);
  for (let i = 0; i < n; i++) {
    const x = xs[i], y = ys[i], fx0 = Math.floor(x), fy0 = Math.floor(y), ax = x - fx0, ay = y - fy0;
    const ix = fx0, iy = fy0;
    const x0 = clamp(ix, 0, w - 1), x1 = clamp(ix + 1, 0, w - 1);
    const y0 = clamp(iy, 0, h - 1), y1 = clamp(iy + 1, 0, h - 1);
    const w00 = (1 - ax) * (1 - ay), w10 = ax * (1 - ay), w01 = (1 - ax) * ay, w11 = ax * ay;
    for (let c = 0; c < ch; c++) {
      const s = data[(y0 * w + x0) * ch + c] * w00 + data[(y0 * w + x1) * ch + c] * w10 +
        data[(y1 * w + x0) * ch + c] * w01 + data[(y1 * w + x1) * ch + c] * w11;
      out[i * ch + c] = Math.floor(s + 0.5);
    }
  }
  return out;
}
const imgOf = mat => ({ data: mat.data, w: mat.cols, h: mat.rows, ch: mat.channels() });

// ---------------------------------------------------------------------------
// quad geometry
// ---------------------------------------------------------------------------
export function orderCorners(points) {
  const pts = points.map(p => [p[0], p[1]]);
  const [cx, cy] = centroid(pts);
  const ang = pts.map(p => Math.atan2(p[1] - cy, p[0] - cx));
  const idx = [0, 1, 2, 3].sort((a, b) => ang[a] - ang[b]);
  const sorted = idx.map(i => pts[i]);
  let start = 0, best = Infinity;
  sorted.forEach((p, i) => { const s = p[0] + p[1]; if (s < best) { best = s; start = i; } });
  return [0, 1, 2, 3].map(i => sorted[(i + start) % 4]);
}
export function quadSize(q) {
  return [(dist(q[0], q[1]) + dist(q[3], q[2])) / 2, (dist(q[3], q[0]) + dist(q[2], q[1])) / 2];
}
export function toPortrait(quad) {
  const q = orderCorners(quad), [w, h] = quadSize(q);
  return w > h ? [q[3], q[0], q[1], q[2]] : q;
}
function polyArea(pts) {  // |shoelace| / 2, as cv.contourArea
  let s = 0;
  for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; s += a[0] * b[1] - b[0] * a[1]; }
  return Math.abs(s) / 2;
}
function isConvex(pts) {
  const n = pts.length; let orient = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n], c = pts[(i + 2) % n];
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (cr > 0) orient |= 1; else if (cr < 0) orient |= 2;
    if (orient === 3) return false;
  }
  return true;
}
function cornerAnglesOk(q) {
  for (let i = 0; i < 4; i++) {
    const p = q[(i + 3) % 4], c = q[i], n = q[(i + 1) % 4];
    const v1 = [p[0] - c[0], p[1] - c[1]], v2 = [n[0] - c[0], n[1] - c[1]];
    const n1 = Math.hypot(v1[0], v1[1]), n2 = Math.hypot(v2[0], v2[1]);
    if (n1 === 0 || n2 === 0) return false;
    const cosv = clamp((v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2), -1, 1);
    if (Math.abs(Math.acos(cosv) * 180 / Math.PI - 90) > MAX_CORNER_ANGLE_DEV) return false;
  }
  return true;
}
function scoreQuad(q, imgArea, minAreaFrac = MIN_AREA_FRAC) {
  const area = polyArea(q);
  if (area < minAreaFrac * imgArea || area > MAX_AREA_FRAC * imgArea) return null;
  if (!isConvex(q)) return null;
  const [w, h] = quadSize(q);
  if (Math.min(w, h) <= 0) return null;
  const ratio = Math.min(w, h) / Math.max(w, h);
  if (!(RATIO_MIN <= ratio && ratio <= RATIO_MAX)) return null;
  if (area < 0.80 * w * h) return null;
  if (!cornerAnglesOk(q)) return null;
  const penalty = Math.min(1.0, Math.abs(ratio - CARD_RATIO) / 0.13);
  return area * (1.0 - 0.5 * penalty);
}
function shrink(q, px) {
  if (px <= 0) return q;
  const [cx, cy] = centroid(q);
  return q.map(p => {
    const vx = cx - p[0], vy = cy - p[1], n = Math.hypot(vx, vy);
    return n > 0 ? [f32(p[0] + f32(f32(vx / n) * px)), f32(p[1] + f32(f32(vy / n) * px))] : [p[0], p[1]];
  });
}
function intersect(p1, d1, p2, d2) {
  const cross = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(cross) < 1e-6) return null;
  const s = ((p2[0] - p1[0]) * d2[1] - (p2[1] - p1[1]) * d2[0]) / cross;
  return [f32(p1[0] + s * d1[0]), f32(p1[1] + s * d1[1])];
}
const matPts = m => { const d = m.data32S, out = []; for (let i = 0; i < m.rows; i++) out.push([d[2 * i], d[2 * i + 1]]); return out; };
function boxPoints(rect) {  // cv.boxPoints is not in the opencv.js build
  const a0 = rect.angle * Math.PI / 180, b = Math.cos(a0) * 0.5, a = Math.sin(a0) * 0.5;
  const { x: cx, y: cy } = rect.center, { width: w, height: h } = rect.size;
  const p0 = [cx - a * h - b * w, cy + b * h - a * w], p1 = [cx + a * h - b * w, cy - b * h - a * w];
  return [p0, p1, [2 * cx - p0[0], 2 * cy - p0[1]], [2 * cx - p1[0], 2 * cy - p1[1]]];
}

function quadsFromPolygon(poly, area) {
  const n = poly.length;
  const lengths = poly.map((p, i) => dist(p, poly[(i + 1) % n]));
  const minLen = 0.22 * Math.sqrt(Math.max(area, 1));
  const order = lengths.map((l, i) => i).sort((a, b) => lengths[b] - lengths[a]).slice(0, 6).filter(i => lengths[i] >= minLen);
  if (order.length < 4) return [];
  order.sort((a, b) => a - b);
  const out = [], m = order.length;
  for (let a = 0; a < m; a++) for (let b = a + 1; b < m; b++) for (let c = b + 1; c < m; c++) for (let d = c + 1; d < m; d++) {
    const combo = [order[a], order[b], order[c], order[d]], corners = [];
    for (let k = 0; k < 4; k++) {
      const i = combo[k], j = combo[(k + 1) % 4];
      const ni = poly[(i + 1) % n], nj = poly[(j + 1) % n];
      const corner = intersect(poly[i], [ni[0] - poly[i][0], ni[1] - poly[i][1]], poly[j], [nj[0] - poly[j][0], nj[1] - poly[j][1]]);
      if (!corner) break;
      corners.push(corner);
    }
    if (corners.length === 4) out.push(orderCorners(corners));
  }
  return out;
}

function quadsFromContour(cv, contour, area, shrinkPx) {
  const quads = [];
  const hull = new cv.Mat();
  cv.convexHull(contour, hull, false, true);
  const perimeter = cv.arcLength(hull, true);
  let quad = null;
  for (const eps of [0.02, 0.03, 0.045]) {
    const approx = new cv.Mat();
    cv.approxPolyDP(hull, approx, eps * perimeter, true);
    if (approx.rows === 4) quad = matPts(approx);
    approx.delete();
    if (quad) break;
  }
  if (!quad) {
    const rect = cv.minAreaRect(hull), rectArea = rect.size.width * rect.size.height;
    if (rectArea > 0 && cv.contourArea(hull) >= 0.90 * rectArea) quad = boxPoints(rect);
  }
  hull.delete();
  if (quad) quads.push(shrink(orderCorners(quad), shrinkPx));
  const poly = new cv.Mat();
  cv.approxPolyDP(contour, poly, 0.012 * cv.arcLength(contour, true), true);
  if (poly.rows >= 5 && poly.rows <= 14) for (const q of quadsFromPolygon(matPts(poly), area)) quads.push(shrink(q, shrinkPx));
  poly.delete();
  return quads;
}

// ---------------------------------------------------------------------------
// masks
// ---------------------------------------------------------------------------
const kernels = {};
const K = (cv, n) => kernels[n] || (kernels[n] = cv.Mat.ones(n, n, cv.CV_8U));
function morph(cv, src, op, k) {
  const dst = new cv.Mat();
  cv.morphologyEx(src, dst, op, K(cv, k), new cv.Point(-1, -1), 1, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue());
  return dst;
}
function clean(cv, mask, close = 9, open = 7) {
  const a = morph(cv, mask, cv.MORPH_CLOSE, close), b = morph(cv, a, cv.MORPH_OPEN, open);
  a.delete(); return b;
}
function edgeMask(cv, gray, lo, hi) {
  const e = new cv.Mat(), d = new cv.Mat();
  cv.Canny(gray, e, lo, hi, 3, false);
  cv.dilate(e, d, K(cv, 3), new cv.Point(-1, -1), 2, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue());
  e.delete(); return d;
}
function adaptiveMask(cv, gray) {
  const m = new cv.Mat();
  cv.adaptiveThreshold(gray, m, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 51, -6);
  const c = morph(cv, m, cv.MORPH_CLOSE, 15); m.delete();
  const o = morph(cv, c, cv.MORPH_OPEN, 7); c.delete();
  return o;
}
function otsuMasks(cv, gray) {
  const raw = new cv.Mat(); cv.threshold(gray, raw, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
  const inv = new cv.Mat(); cv.bitwise_not(raw, inv);
  const r = [clean(cv, raw), clean(cv, inv)];
  raw.delete(); inv.delete(); return r;
}
function tableColour(rgb) {  // median colour of the frame border (3 % strip, every third pixel)
  const { data, w, h } = rgb;
  const m = Math.max(2, rte(0.03 * Math.min(h, w)));
  const hist = [new Float64Array(256), new Float64Array(256), new Float64Array(256)];
  let n = 0;
  const add = (y, x) => { const o = (y * w + x) * 3; hist[0][data[o]]++; hist[1][data[o + 1]]++; hist[2][data[o + 2]]++; n++; };
  for (let y = 0; y < m; y++) for (let x = 0; x < w; x += 3) add(y, x);
  for (let y = h - m; y < h; y++) for (let x = 0; x < w; x += 3) add(y, x);
  for (let y = m; y < h - m; y += 3) for (let x = 0; x < m; x++) add(y, x);
  for (let y = m; y < h - m; y += 3) for (let x = w - m; x < w; x++) add(y, x);
  return hist.map(hh => histMedian(hh, n));
}
// everything that differs from the table colour, at the Otsu threshold of that difference (leaves
// the card's shadow out) and at the smallest one (low-contrast cards)
function backgroundMasks(cv, rgbMat) {
  const rgb = imgOf(rgbMat), t = tableColour(rgb).map(rte);
  const n = rgb.w * rgb.h, diff = new cv.Mat(rgb.h, rgb.w, cv.CV_8UC1), dd = diff.data, d = rgb.data;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(d[3 * i] - t[0]), b = Math.abs(d[3 * i + 1] - t[1]), c = Math.abs(d[3 * i + 2] - t[2]);
    dd[i] = a > b ? (a > c ? a : c) : (b > c ? b : c);
  }
  const tmp = new cv.Mat();
  const otsu = cv.threshold(diff, tmp, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
  const high = Math.max(BG_MIN_DIFF, otsu), thresholds = [high];
  if (BG_MIN_DIFF <= 0.7 * high) thresholds.push(BG_MIN_DIFF);
  const out = thresholds.map(th => { cv.threshold(diff, tmp, th, 255, cv.THRESH_BINARY); return clean(cv, tmp, 5, 5); });
  tmp.delete(); diff.delete();
  return out;
}
// the darkest and the brightest population alone
function extremeMasks(cv, grayMat) {
  const { data, w, h } = imgOf(grayMat);
  const hist = new Float64Array(256); let n = 0;
  for (let y = 0; y < h; y += 4) for (let x = 0; x < w; x += 4) { hist[data[y * w + x]]++; n++; }
  const [p2, p40, p60, p98] = [2, 40, 60, 98].map(q => histPercentile(hist, n, q));
  const masks = [], tmp = new cv.Mat();
  if (p60 - p2 >= MIN_MASK_RANGE) { cv.threshold(grayMat, tmp, p2 + 0.3 * (p60 - p2), 255, cv.THRESH_BINARY_INV); masks.push(clean(cv, tmp, 5, 3)); }
  if (p98 - p40 >= MIN_MASK_RANGE) { cv.threshold(grayMat, tmp, p98 - 0.3 * (p98 - p40), 255, cv.THRESH_BINARY); masks.push(clean(cv, tmp, 5, 3)); }
  tmp.delete(); return masks;
}
// yields {mask, shrink, blob}; the consumer deletes the masks (the first one it keeps as `edges`)
function* candidateMasks(cv, grayBlur, rgbBlur) {
  yield { mask: edgeMask(cv, grayBlur, 50, 150), shrink: 2.0, blob: false };
  yield { mask: edgeMask(cv, grayBlur, 15, 45), shrink: 2.0, blob: false };
  const cl = new cv.CLAHE(3.0, new cv.Size(8, 8)), eq = new cv.Mat();
  cl.apply(grayBlur, eq); cl.delete();
  const em = edgeMask(cv, eq, 20, 60); eq.delete();
  yield { mask: em, shrink: 2.0, blob: false };
  yield { mask: adaptiveMask(cv, grayBlur), shrink: 0.0, blob: false };
  const [bright, dark] = otsuMasks(cv, grayBlur);
  yield { mask: bright, shrink: 0.0, blob: false };
  yield { mask: dark, shrink: 0.0, blob: false };
  for (const m of backgroundMasks(cv, rgbBlur)) yield { mask: m, shrink: 0.0, blob: true };
  for (const m of extremeMasks(cv, grayBlur)) yield { mask: m, shrink: 0.0, blob: true };
}

// ---------------------------------------------------------------------------
// measuring a candidate on the image
// ---------------------------------------------------------------------------
// points along the middle part of each side and the unit normals pointing into the quad
function sideFrames(q, count) {
  const step = (SIDE_SPAN[1] - SIDE_SPAN[0]) / (count - 1);
  const t = Array.from({ length: count }, (_, i) => f32(i === count - 1 ? SIDE_SPAN[1] : i * step + SIDE_SPAN[0]));
  const points = [], normals = [];
  for (let s = 0; s < 4; s++) {
    const a = q[s], b = q[(s + 1) % 4], dx = f32(b[0] - a[0]), dy = f32(b[1] - a[1]);
    const len = Math.max(f32(Math.sqrt(f32(f32(dx * dx) + f32(dy * dy)))), 1e-6), ux = f32(dx / len), uy = f32(dy / len);
    normals.push([f32(-uy), ux]);
    points.push(t.map(tt => [f32(a[0] + f32(tt * dx)), f32(a[1] + f32(tt * dy))]));
  }
  return { points, normals };
}
// sample position `off` along the normal of a side point (float32 like numpy)
const at = (p, off, n) => [f32(p[0] + f32(off * n[0])), f32(p[1] + f32(off * n[1]))];

// all lines a side may be moved to (offset a at the first sample, b at the last)
const LINE_A = [], LINE_B = [], LINE_INDEX = [], LINE_COST = [], LINE_PARALLEL = [];
for (let a = 0; a <= 2 * REFINE_RANGE; a++) for (let b = 0; b <= 2 * REFINE_RANGE; b++) {
  const li = LINE_A.length;
  LINE_A.push(a); LINE_B.push(b);
  LINE_INDEX.push(Int32Array.from({ length: REFINE_SAMPLES }, (_, k) => rte(a + (b - a) * (k / (REFINE_SAMPLES - 1)))));
  LINE_COST.push(0.02 * (Math.abs(a - REFINE_RANGE) + Math.abs(b - REFINE_RANGE)));
  if (a === b) LINE_PARALLEL.push(li);
}
const NLINES = LINE_A.length;
function argmax(arr) { let bi = 0; for (let i = 1; i < arr.length; i++) if (arr[i] > arr[bi]) bi = i; return bi; }

function pickLine(quality) {
  const reach = REFINE_RANGE;
  const parallel = LINE_PARALLEL.map(i => quality[i]);
  const floor = Math.max(REFINE_MIN_CONTRAST, REFINE_WEAK * Math.max(...parallel));
  const peaks = [];
  for (let i = 0; i < parallel.length; i++) {
    const l = i > 0 ? parallel[i - 1] : 0, r = i < parallel.length - 1 ? parallel[i + 1] : 0;
    if (parallel[i] >= floor && parallel[i] >= l && parallel[i] >= r) peaks.push(i);
  }
  if (!peaks.length) {
    const rated = Array.from(quality, (v, i) => v - LINE_COST[i]);
    const pick = argmax(rated);
    return quality[pick] >= REFINE_MIN_CONTRAST ? pick : null;
  }
  let best = 0, bd = Infinity;
  peaks.forEach((p, i) => { const d = Math.abs(p - reach); if (d < bd) { bd = d; best = i; } });
  let offset = peaks[best];
  const outer = peaks.filter(p => p <= offset - REFINE_OUTER_GAP);
  if (outer.length) {
    let mo = outer[0]; for (const o of outer) if (parallel[o] > parallel[mo]) mo = o;
    if (parallel[mo] >= REFINE_OUTER * parallel[offset]) offset = mo;
  }
  const rated = new Float64Array(NLINES);
  for (let i = 0; i < NLINES; i++) {
    const near = Math.abs(LINE_A[i] - offset) <= 2 && Math.abs(LINE_B[i] - offset) <= 2;
    rated[i] = near ? quality[i] - 0.02 * (Math.abs(LINE_A[i] - offset) + Math.abs(LINE_B[i] - offset)) : -1.0;
  }
  return argmax(rated);
}

function fitLineHuber(cv, pts) {
  const m = cv.matFromArray(pts.length, 1, cv.CV_32FC2, pts.flat());
  const line = new cv.Mat();
  cv.fitLine(m, line, cv.DIST_HUBER, 0, 0.01, 0.01);
  const d = line.data32F, r = [[d[2], d[3]], [d[0], d[1]]];  // [point, direction]
  m.delete(); line.delete();
  return r;
}

function cornersFromLines(lines, q, keepOnFail) {
  const corners = [];
  for (let s = 0; s < 4; s++) {
    const prev = lines[(s + 3) % 4];
    const c = intersect(prev[0], prev[1], lines[s][0], lines[s][1]);
    if (keepOnFail) corners.push(!c || dist(c, q[s]) > REFINE_MAX_SHIFT ? q[s] : c);
    else { if (!c) return null; corners.push(c); }
  }
  return corners;
}

// move every side onto the edge that runs along its whole length
function refineQuad(cv, q, gray, trace = null) {
  const { points, normals } = sideFrames(q, REFINE_SAMPLES);
  const G = 2 * REFINE_RANGE + 4;  // grid -6.5 .. 6.5 (14 values)
  const C = G - 3, quartile = REFINE_SAMPLES >> 2;
  const lines = [];
  for (let s = 0; s < 4; s++) {
    const xs = new Float64Array(REFINE_SAMPLES * G), ys = new Float64Array(REFINE_SAMPLES * G);
    for (let i = 0; i < REFINE_SAMPLES; i++) for (let g = 0; g < G; g++) {
      const off = -REFINE_RANGE - 1.5 + g;
      const c = at(points[s][i], off, normals[s]); xs[i * G + g] = c[0]; ys[i * G + g] = c[1];
    }
    const vals = sample(gray, xs, ys, REFINE_SAMPLES * G);
    const contrast = new Float32Array(REFINE_SAMPLES * C);   // column j = offset j - reach
    for (let i = 0; i < REFINE_SAMPLES; i++) for (let j = 0; j < C; j++) contrast[i * C + j] = Math.abs(vals[i * G + j + 3] - vals[i * G + j]);
    const quality = new Float64Array(NLINES), tmp = new Float64Array(REFINE_SAMPLES);
    for (let li = 0; li < NLINES; li++) {
      const idx = LINE_INDEX[li];
      for (let i = 0; i < REFINE_SAMPLES; i++) tmp[i] = contrast[i * C + idx[i]];
      quality[li] = Float64Array.from(tmp).sort()[quartile];
    }
    const pick = pickLine(quality);
    if (trace) trace('pick', s, Array.from(quality), pick);
    if (pick === null) { lines.push([q[s], [q[(s + 1) % 4][0] - q[s][0], q[(s + 1) % 4][1] - q[s][1]]]); continue; }
    const col = LINE_INDEX[pick], centre = new Float64Array(REFINE_SAMPLES), shift = new Float64Array(REFINE_SAMPLES);
    for (let i = 0; i < REFINE_SAMPLES; i++) {
      const c = contrast[i * C + col[i]], l = contrast[i * C + Math.max(col[i] - 1, 0)], r = contrast[i * C + Math.min(col[i] + 1, 2 * REFINE_RANGE)];
      const curve = l - 2 * c + r;
      const delta = curve < -1e-3 ? 0.5 * (l - r) / Math.min(curve, -1e-3) : 0;   // sub-pixel parabola
      centre[i] = c; shift[i] = col[i] - REFINE_RANGE + clamp(delta, -0.5, 0.5);
    }
    const med = median(centre), fitted = [];
    for (let i = 0; i < REFINE_SAMPLES; i++) if (centre[i] >= 0.5 * med) fitted.push(at(points[s][i], shift[i], normals[s]));
    const fl = fitLineHuber(cv, fitted);
    if (trace) trace('fit', s, fitted, fl);
    lines.push(fl);
  }
  const refined = cornersFromLines(lines, q, true);
  return isConvex(refined) ? refined : q;
}

// move the sides of a quad found on the inner frame out to the card edge (or null)
function expandQuad(q, gray) {
  const short = Math.min(...quadSize(q)), depth = rte(EXPAND_DEPTH * short);
  if (depth < 7) return null;
  const { points, normals } = sideFrames(q, REFINE_SAMPLES);
  const K0 = depth + 6, lines = [];
  let moved = false;
  for (let s = 0; s < 4; s++) {
    const xs = new Float64Array(REFINE_SAMPLES * K0), ys = new Float64Array(REFINE_SAMPLES * K0);
    for (let i = 0; i < REFINE_SAMPLES; i++) for (let k = 0; k < K0; k++) {
      const c = at(points[s][i], -k, normals[s]); xs[i * K0 + k] = c[0]; ys[i * K0 + k] = c[1];
    }
    const vals = sample(gray, xs, ys, REFINE_SAMPLES * K0);
    const row = new Float64Array(K0), col = new Float64Array(REFINE_SAMPLES);
    for (let k = 0; k < K0; k++) { for (let i = 0; i < REFINE_SAMPLES; i++) col[i] = vals[i * K0 + k]; row[k] = median(col); }
    const edge = new Float64Array(K0 - 2);
    for (let k = 0; k < K0 - 2; k++) edge[k] = Math.abs(row[k + 2] - row[k]);
    let shift = 0;
    for (let k = depth; k > EXPAND_MIN_STRIP + 2; k--) {
      if (edge[k] < EXPAND_MIN_STEP || edge[k] < EXPAND_PEAK * Math.max(edge[k - 3], edge[k + 3])) continue;
      const strip = row.slice(3, k), med = median(strip);
      let mx = 0; for (const v of strip) mx = Math.max(mx, Math.abs(v - med));
      if (mx <= EXPAND_FLAT) { shift = k + 1; break; }
    }
    moved = moved || shift > 0;
    lines.push([[q[s][0] - shift * normals[s][0], q[s][1] - shift * normals[s][1]], [q[(s + 1) % 4][0] - q[s][0], q[(s + 1) % 4][1] - q[s][1]]]);
  }
  if (!moved) return null;
  return cornersFromLines(lines, q, false);
}

// edge support and border ring of a quad on the blurred frame -> [mean support, min support, ring uniform]
function measureQuad(q, gray, rgb, borderOk) {
  const { w, h } = gray;
  const { points, normals } = sideFrames(q, SUPPORT_SAMPLES);
  const reach = SUPPORT_REACH, S = SUPPORT_SAMPLES, G = reach + 6;   // steps -reach-2.5 ... 2.5 (10 values)
  const support = new Float64Array(4);
  for (let s = 0; s < 4; s++) {
    const xs = new Float64Array(S * G), ys = new Float64Array(S * G);
    for (let i = 0; i < S; i++) for (let g = 0; g < G; g++) {
      const off = -reach - 2.5 + g;
      const c = at(points[s][i], off, normals[s]); xs[i * G + g] = c[0]; ys[i * G + g] = c[1];
    }
    const prof = sample(gray, xs, ys, S * G);
    const signed = (i, j) => prof[i * G + j + 3] - prof[i * G + j];   // column j = offset j - reach - 1
    const m = median(Float64Array.from({ length: S }, (_, i) => signed(i, reach + 1)));
    const sign = m > 0 ? 1 : m < 0 ? -1 : 0;
    let hits = 0, seen = 0;
    for (let i = 0; i < S; i++) {
      let atLine = -Infinity;
      for (let j = reach; j < reach + 3; j++) atLine = Math.max(atLine, signed(i, j) * sign);
      const outside = Math.max(Math.abs(signed(i, 0)), Math.abs(signed(i, 1)));
      const fx = xs[i * G], fy = ys[i * G];
      const inFrame = fx >= 0 && fx <= w - 1 && fy >= 0 && fy <= h - 1;
      if (inFrame) seen++;
      if (atLine >= SUPPORT_MIN_CONTRAST && atLine >= SUPPORT_PEAK * outside && inFrame) hits++;
    }
    support[s] = borderOk ? (seen >= S >> 2 ? hits / Math.max(seen, 1) : 1.0) : hits / S;
  }
  const short = Math.min(...quadSize(q));
  const depths = RING_DEPTHS.map(d => f32(Math.max(2.0, f32(d * f32(short)))));
  const ch = rgb.ch, cnt = S * depths.length, medians = [];
  let spread = 0;
  for (let s = 0; s < 4; s++) {
    const xs = new Float64Array(cnt), ys = new Float64Array(cnt);
    let k = 0;
    for (let i = 0; i < S; i++) for (const d of depths) { const c = at(points[s][i], d, normals[s]); xs[k] = c[0]; ys[k] = c[1]; k++; }
    const v = sample(rgb, xs, ys, cnt), med = [];
    for (let c = 0; c < ch; c++) {
      const col = new Float64Array(cnt); for (let i = 0; i < cnt; i++) col[i] = v[i * ch + c];
      col.sort();
      med.push(col[cnt >> 1]);
      spread = Math.max(spread, col[Math.floor(0.9 * (cnt - 1))] - col[Math.floor(0.1 * (cnt - 1))]);
    }
    medians.push(med);
  }
  let diff = 0;
  for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) for (let c = 0; c < ch; c++) diff = Math.max(diff, Math.abs(medians[a][c] - medians[b][c]));
  const uniform = diff <= RING_MAX_DIFF && spread <= RING_MAX_SPREAD;
  return [(support[0] + support[1] + support[2] + support[3]) / 4, Math.min(support[0], support[1], support[2], support[3]), uniform];
}

function guideToPixels(w, h, g) {
  if (!g) return null;
  let [x0, y0, x1, y1] = g.map(Number);
  if ([x0, y0, x1, y1].some(v => !isFinite(v))) return null;
  x0 = clamp(x0, 0, 1); x1 = clamp(x1, 0, 1); y0 = clamp(y0, 0, 1); y1 = clamp(y1, 0, 1);
  if (x0 > x1) [x0, x1] = [x1, x0];
  if (y0 > y1) [y0, y1] = [y1, y0];
  if (x1 - x0 < 0.02 || y1 - y0 < 0.02) return null;
  return [x0 * w, y0 * h, x1 * w, y1 * h];
}
function centerInGuide(q, g) {
  const [x0, y0, x1, y1] = g, gw = x1 - x0, gh = y1 - y0, [cx, cy] = centroid(q);
  return x0 - GUIDE_TOLERANCE * gw <= cx && cx <= x1 + GUIDE_TOLERANCE * gw && y0 - GUIDE_TOLERANCE * gh <= cy && cy <= y1 + GUIDE_TOLERANCE * gh;
}

// ---------------------------------------------------------------------------
// partial card (probe hints)
// ---------------------------------------------------------------------------
function drawBlob(cv, contour, w, h) {
  const blob = cv.Mat.zeros(h, w, cv.CV_8UC1), mv = new cv.MatVector();
  mv.push_back(contour);
  cv.drawContours(blob, mv, 0, new cv.Scalar(255), -1);
  mv.delete();
  return blob;
}
function contentAtFrameEdge(cv, contour, w, h, edges, touched) {
  const blob0 = drawBlob(cv, contour, w, h), blobM = new cv.Mat();
  cv.erode(blob0, blobM, K(cv, 15), new cv.Point(-1, -1), 1, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue());
  blob0.delete();
  const m = Math.max(3, rte(0.04 * Math.min(h, w))), [left, top, right, bottom] = touched;
  const bd = blobM.data, ed = edges.data;
  let count = 0, hit = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!((top && y < m) || (bottom && y >= h - m) || (left && x < m) || (right && x >= w - m))) continue;
    if (bd[y * w + x]) { count++; if (ed[y * w + x]) hit++; }
  }
  blobM.delete();
  if (count < 50) return false;
  return hit >= PARTIAL_MIN_CONTENT * count;
}
function lineAlongStrip(gray, w, h, ys, xl, xr) {
  const n = ys.length, width = xl.map((v, i) => xr[i] - v);
  const count = Math.max(8, rte((SPAN_INNER[1] - SPAN_INNER[0]) * median(width)));
  const img = { data: gray, w, h, ch: 1 };
  const hits = Array.from({ length: n }, () => new Uint8Array(count));
  for (let r = 0; r < n; r++) {
    const xa = new Float64Array(count), xb = new Float64Array(count), yy = new Float64Array(count).fill(ys[r]);
    for (let c = 0; c < count; c++) {
      const u = SPAN_INNER[0] + (SPAN_INNER[1] - SPAN_INNER[0]) * c / (count - 1), x = xl[r] + u * width[r];
      xa[c] = x - 1.5; xb[c] = x + 1.5;
    }
    const before = sample(img, xa, yy, count), after = sample(img, xb, yy, count);
    for (let c = 0; c < count; c++) hits[r][c] = Math.abs(after[c] - before[c]) >= SPAN_LINE_STEP ? 1 : 0;
  }
  let best = 0;
  for (let c = 0; c < count; c++) {
    let tot = 0;
    for (let r = 0; r < n; r++) {
      let hit = 0;
      for (let d = -SPAN_LINE_SMEAR; d <= SPAN_LINE_SMEAR && !hit; d++) { const cc = c + d; if (cc >= 0 && cc < count && hits[r][cc]) hit = 1; }
      tot += hit;
    }
    best = Math.max(best, tot / n);
  }
  return best >= SPAN_LINE_ROWS;
}
function polyfit1(ys, xs) {  // least squares x = slope * y + offset
  const n = xs.length; let sx = 0, sy = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxy += xs[i] * ys[i]; syy += ys[i] * ys[i]; }
  const den = n * syy - sy * sy, slope = den ? (n * sxy - sx * sy) / den : 0;
  return [slope, (sx - slope * sy) / n];
}
// a blob from one frame edge to the opposite one is a card only when it is shaped like a card cut by them
function spansLikeCard(cv, contour, w, h, touched, grayMat) {
  const blobMat = drawBlob(cv, contour, w, h);
  let blob = blobMat.data.slice(), gray = grayMat ? grayMat.data : null;
  blobMat.delete();
  if (!(touched[1] && touched[3])) {   // left to right: look at it turned by 90 degrees
    const tb = new Uint8Array(w * h), tg = gray ? new Uint8Array(w * h) : null;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { tb[x * h + y] = blob[y * w + x]; if (tg) tg[x * h + y] = gray[y * w + x]; }
    blob = tb; gray = tg; [w, h] = [h, w];
  }
  const span = h - 1, N = SPAN_ROWS;
  const ys = Float64Array.from({ length: N }, (_, i) => 0.03 * span + (0.97 * span - 0.03 * span) * i / (N - 1));
  const left = new Float64Array(N), right = new Float64Array(N);
  for (let r = 0; r < N; r++) {
    const row = rte(ys[r]) * w; let l = -1, rr = -1;
    for (let x = 0; x < w; x++) if (blob[row + x]) { if (l < 0) l = x; rr = x; }
    if (l < 0) return false;
    left[r] = l; right[r] = rr;
  }
  const lines = []; let clean_ = false;
  for (const [xs, border] of [[left, 0], [right, w - 1]]) {
    const fy = [], fx = [];
    for (let r = 0; r < N; r++) if (Math.abs(xs[r] - border) > SPAN_EDGE_PX) { fy.push(ys[r]); fx.push(xs[r]); }
    const share = fx.length / N;
    if (share < 0.25) { lines.push(null); continue; }
    const [slope, offset] = polyfit1(fy, fx);
    const res = fx.map((x, i) => Math.abs(x - (slope * fy[i] + offset))).sort((a, b) => b - a);
    const dev = res[Math.min(res.length - 1, Math.floor(SPAN_OUTLIER_ROWS * res.length))] / span;
    if (dev > SPAN_ROUGH) return false;
    clean_ = clean_ || (share >= 0.9 && dev <= SPAN_STRAIGHT);
    lines.push([slope, offset]);
  }
  if (!clean_) return false;
  if (lines[0] && lines[1]) {
    const ang = Math.abs((Math.atan(lines[0][0]) - Math.atan(lines[1][0])) * 180 / Math.PI);
    if (ang > SPAN_PARALLEL_DEG) return false;
  }
  const middle = 0.5 * span;
  const xl = lines[0] ? lines[0][0] * middle + lines[0][1] : 0, xr = lines[1] ? lines[1][0] * middle + lines[1][1] : w - 1;
  const slopes = lines.filter(Boolean).map(l => l[0]);
  const meanSlope = slopes.reduce((a, b) => a + b, 0) / slopes.length;
  const width = (xr - xl) * Math.cos(Math.atan(meanSlope));
  if (width < SPAN_MIN_WIDTH * h) return false;
  if (!gray) return true;
  const sides = [0, 1].map(k => Array.from(ys, y => lines[k] ? lines[k][0] * y + lines[k][1] : (k ? w - 1 : 0)));
  return !lineAlongStrip(gray, w, h, ys, sides[0], sides[1]);
}
// -> {hint, hull (points), area} for a blob that looks like a card cut by the frame edge, or null
function partialCard(cv, contour, w, h, edges, grayMat) {
  const area = cv.contourArea(contour);
  if (area < PARTIAL_MIN_AREA * h * w) return null;
  const r = cv.boundingRect(contour), edge = 2;
  const left = r.x <= edge, top = r.y <= edge, right = r.x + r.width >= w - edge, bottom = r.y + r.height >= h - edge;
  if (!(left || top || right || bottom)) return null;
  if (left && top && right && bottom) return null;
  const hull = new cv.Mat(); cv.convexHull(contour, hull, false, true);
  try {
    const hullArea = cv.contourArea(hull);
    if (hullArea <= 0 || area < PARTIAL_MIN_SOLIDITY * hullArea) return null;
    const polyM = new cv.Mat(); cv.approxPolyDP(hull, polyM, 0.02 * cv.arcLength(hull, true), true);
    const poly = matPts(polyM); polyM.delete();
    if (!(poly.length >= 4 && poly.length <= 6)) return null;
    const hullPts = matPts(hull);
    if ((left && right) || (top && bottom)) {
      const nTouched = [left, top, right, bottom].filter(Boolean).length;
      if (nTouched > 2 && area < TOO_CLOSE_FILL * h * w) return null;
      if (!spansLikeCard(cv, contour, w, h, [left, top, right, bottom], grayMat)) return null;
      if (edges && contentAtFrameEdge(cv, contour, w, h, edges, [left, top, right, bottom])) return { hint: 'too_close', hull: hullPts, area };
      return null;
    }
    let rightAngles = 0;
    for (let i = 0; i < poly.length; i++) {
      const [px, py] = poly[i];
      if (px <= edge || py <= edge || px >= w - 1 - edge || py >= h - 1 - edge) continue;
      const a = poly[(i + poly.length - 1) % poly.length], b = poly[(i + 1) % poly.length];
      const v1 = [a[0] - px, a[1] - py], v2 = [b[0] - px, b[1] - py];
      const n1 = Math.hypot(v1[0], v1[1]), n2 = Math.hypot(v2[0], v2[1]);
      if (n1 === 0 || n2 === 0) continue;
      const ang = Math.acos(clamp((v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2), -1, 1)) * 180 / Math.PI;
      if (Math.abs(ang - 90) <= 20) rightAngles++;
    }
    if (rightAngles < 1) return null;
    return { hint: area > TOO_CLOSE_FILL * h * w ? 'too_close' : 'cut_off', hull: hullPts, area };
  } finally { hull.delete(); }
}
function pointInConvex(pts, cx, cy) {   // pointPolygonTest(...) >= 0
  let pos = false, neg = false;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const cr = (b[0] - a[0]) * (cy - a[1]) - (b[1] - a[1]) * (cx - a[0]);
    if (cr > 0) pos = true; else if (cr < 0) neg = true;
  }
  return !(pos && neg);
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------
// img: cv.Mat RGBA (or RGB / gray). opts: {guide, minAreaFrac, wantPartial, insideWarp, maxSide}
// -> {quad (tl,tr,br,bl in img px, portrait order) | null, partial ('cut_off'|'too_close'|null), support, ring}
export function searchCard(cv, img, opts = {}) {
  const { guide = null, minAreaFrac = MIN_AREA_FRAC, wantPartial = false, insideWarp = false, trace = null } = opts;
  if (!img || img.empty()) return { quad: null, partial: null, support: 0, ring: false };
  const h = img.rows, w = img.cols;
  const maxSide = Math.max(64, Math.trunc(opts.maxSide || DETECT_MAX_SIDE));
  const scale = Math.max(h, w) > maxSide ? maxSide / Math.max(h, w) : 1.0;
  const mats = [];   // everything created here (deleted at the end)
  const own = m => { mats.push(m); return m; };
  try {
    let small = img;
    if (scale !== 1.0) { small = own(new cv.Mat()); cv.resize(img, small, new cv.Size(0, 0), scale, scale, cv.INTER_AREA); }
    const gray = own(new cv.Mat()), rgb = own(new cv.Mat());
    const ch = small.channels();
    if (ch === 4) { cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY); cv.cvtColor(small, rgb, cv.COLOR_RGBA2RGB); }
    else if (ch === 3) { cv.cvtColor(small, gray, cv.COLOR_RGB2GRAY); small.copyTo(rgb); }
    else { small.copyTo(gray); cv.cvtColor(small, rgb, cv.COLOR_GRAY2RGB); }
    const grayBlur = own(new cv.Mat()), rgbBlur = own(new cv.Mat());
    cv.GaussianBlur(gray, grayBlur, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
    cv.GaussianBlur(rgb, rgbBlur, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
    const sh = grayBlur.rows, sw = grayBlur.cols, imgArea = sh * sw;
    const guidePx = guide ? guideToPixels(sw, sh, guide) : null;
    const gimg = imgOf(grayBlur), cimg = imgOf(rgbBlur);

    const candidates = [], partials = [];
    let edges = null;
    const gen = candidateMasks(cv, grayBlur, rgbBlur);
    try {
      for (const { mask, shrink: shr, blob } of gen) {
        if (!edges) edges = own(mask);
        if (trace) trace('mask', cv.countNonZero(mask));
        const contours = new cv.MatVector(), hier = new cv.Mat();
        cv.findContours(mask, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
        hier.delete();
        for (let i = 0; i < contours.size(); i++) {
          const contour = contours.get(i);
          const area = cv.contourArea(contour);
          if (area < minAreaFrac * imgArea * 0.8) { contour.delete(); continue; }
          if (blob) { const f = partialCard(cv, contour, sw, sh, edges, grayBlur); if (f) partials.push(f); }
          for (const quad of quadsFromContour(cv, contour, area, shr)) {
            if (guidePx && !centerInGuide(quad, guidePx)) continue;
            const xsq = quad.map(p => p[0]), ysq = quad.map(p => p[1]);
            if (Math.min(...xsq) < -MAX_OVERSHOOT * sw || Math.max(...xsq) > (1 + MAX_OVERSHOOT) * sw ||
                Math.min(...ysq) < -MAX_OVERSHOOT * sh || Math.max(...ysq) > (1 + MAX_OVERSHOOT) * sh) continue;
            if (candidates.some(c => maxAbsDiff(quad, c[1]) < SAME_QUAD_PX)) continue;
            const base = scoreQuad(quad, imgArea, minAreaFrac);
            if (trace) trace('score', base, quad);
            if (base !== null) candidates.push([base, quad]);
          }
          contour.delete();
        }
        contours.delete();
        if (mask !== edges) mask.delete();
      }
    } finally { gen.return(); }

    // the quad lies inside a card that the frame edge cuts (its art box, the visible half): not a card;
    // a complete outline with a uniform ring stays (a card with a hand or arm attached to it)
    const partOfCutCard = (quad, minSupport, ring) => {
      if (insideWarp || !partials.length || (ring && minSupport >= PARTIAL_KEEP_SUPPORT)) return false;
      const [cx, cy] = centroid(quad);
      return partials.some(p => pointInConvex(p.hull, cx, cy));
    };

    let bestQuad = null, best = [-1.0, 0.0, false];
    if (candidates.length) {
      const measured = [];
      // measure one candidate (and what it expands to); true when the search can stop
      const consider = (quad, firstBase, stage) => {
        if (measured.some(o => maxAbsDiff(quad, o) < SAME_QUAD_PX)) return false;
        let refined = refineQuad(cv, quad, gimg, trace);
        if (trace) trace('refine', null, quad, refined);
        let base = scoreQuad(refined, imgArea, minAreaFrac);
        if (base === null) {
          if (firstBase === null) return false;
          refined = quad; base = firstBase;
        }
        if (measured.some(o => maxAbsDiff(refined, o) < SAME_QUAD_PX)) return false;
        measured.push(refined);
        const [meanSupport, minSupport, ring] = measureQuad(refined, gimg, cimg, insideWarp);
        if (trace) trace('measure', base, refined, meanSupport, minSupport, ring);
        let leads = false;
        const eligible = stage === 0 || ring;
        if (eligible && minSupport >= SUPPORT_REJECT && !partOfCutCard(refined, minSupport, ring)) {
          const score = base * meanSupport * (ring ? RING_BONUS : 1.0);
          if (score > best[0]) { best = [score, meanSupport, ring]; bestQuad = refined; leads = true; }
        }
        const perfect = leads && ring && meanSupport >= PERFECT_SUPPORT;
        if (stage < EXPAND_STAGES && minSupport >= SUPPORT_REJECT) {
          const expanded = expandQuad(refined, gimg);
          if (expanded) {
            if (consider(expanded, null, stage + 1)) return true;
            return perfect && bestQuad === refined;
          }
        }
        return perfect;
      };
      candidates.sort((a, b) => b[0] - a[0]);
      for (const [fb, quad] of candidates.slice(0, MAX_CANDIDATES)) if (consider(quad, fb, 0)) break;
    }
    let partial = null;
    if (wantPartial) {
      const hints = new Set(partials.map(p => p.hint));
      partial = hints.has('too_close') ? 'too_close' : hints.has('cut_off') ? 'cut_off' : null;
    }
    if (!bestQuad) return { quad: null, partial, support: 0, ring: false };
    return { quad: toPortrait(bestQuad.map(p => [p[0] / scale, p[1] / scale])), partial, support: best[1], ring: best[2] };
  } finally { mats.forEach(m => m.delete()); }
}

export function findCardQuad(cv, img, guide = null) { return searchCard(cv, img, { guide }).quad; }

// second contour attempt restricted to the guide rectangle (plus a margin)
export function findInGuide(cv, img, guide) {
  const gp = guideToPixels(img.cols, img.rows, guide);
  if (!gp) return null;
  const [x0, y0, x1, y1] = gp, mx = 0.15 * (x1 - x0), my = 0.15 * (y1 - y0);
  const cx0 = Math.trunc(Math.max(0, x0 - mx)), cy0 = Math.trunc(Math.max(0, y0 - my));
  const cx1 = Math.trunc(Math.min(img.cols, x1 + mx)), cy1 = Math.trunc(Math.min(img.rows, y1 + my));
  if (cx1 - cx0 < 20 || cy1 - cy0 < 20) return null;
  const roi = img.roi(new cv.Rect(cx0, cy0, cx1 - cx0, cy1 - cy0)), crop = new cv.Mat();
  roi.copyTo(crop); roi.delete();   // contiguous copy (the search reads .data)
  const quad = findCardQuad(cv, crop);
  crop.delete();
  return quad ? quad.map(([x, y]) => [x + cx0, y + cy0]) : null;
}
export function guideQuad(img, guide) {
  const gp = guideToPixels(img.cols, img.rows, guide);
  if (!gp) return null;
  const [x0, y0, x1, y1] = gp;
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

// ---------------------------------------------------------------------------
// warps
// ---------------------------------------------------------------------------
function warpTo(cv, src, quad, padY, outH) {
  const s = toPortrait(quad);
  const from = cv.matFromArray(4, 1, cv.CV_32FC2, s.flat());
  const to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, padY, WARP_W - 1, padY, WARP_W - 1, padY + WARP_H - 1, 0, padY + WARP_H - 1]);
  const M = cv.getPerspectiveTransform(from, to);
  const out = new cv.Mat();
  cv.warpPerspective(src, out, M, new cv.Size(WARP_W, outH), cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
  from.delete(); to.delete(); M.delete();
  return out;
}
// card as an upright 1000x1400 portrait image (caller deletes)
export function warpQuad(cv, src, quad) { return warpTo(cv, src, quad, 0, WARP_H); }
// the same warp with `marginY` of the card height kept above and below: 1000 x (1400 + 2 pad),
// the card in rows [pad, pad + 1400) with pad = round(marginY * 1400) = 98 (caller deletes)
export function warpQuadExtended(cv, src, quad, marginY = WARP_MARGIN_Y) {
  const pad = Math.max(0, rte(marginY * WARP_H));
  return warpTo(cv, src, quad, pad, WARP_H + 2 * pad);
}

// src: cv.Mat RGBA frame. -> {found, method ('contour'|'guide'|'none'), quad (frame px, portrait order),
// warped (cv.Mat RGBA 1000x1400), extended (only with opts.extended: the tall warp; caller deletes both)}.
export function detectCard(cv, src, guide = null, opts = {}) {
  let quad = findCardQuad(cv, src, guide), method = 'contour';
  if (!quad && guide) quad = findInGuide(cv, src, guide);
  if (!quad && guide) { quad = guideQuad(src, guide); method = 'guide'; }
  if (!quad) return { found: false, method: 'none', quad: null, warped: null, extended: null };
  return {
    found: true, method, quad, warped: warpQuad(cv, src, quad),
    extended: opts.extended ? warpQuadExtended(cv, src, quad) : null,
  };
}

// Search the card again inside a stored warp whose quad was not on the card edge -> detection with
// method 'refit' (new warp cut from `warped`) or null. opts: {minFill, maxFill, maxSide (REFIT_MAX_SIDES), extended}
export function refitWarp(cv, warped, opts = {}) {
  const { minFill = REFIT_MIN_FILL, maxFill = REFIT_MAX_FILL, maxSide = REFIT_MAX_SIDES[0] } = opts;
  if (!warped || warped.empty()) return null;
  const { quad } = searchCard(cv, warped, { insideWarp: true, maxSide });
  if (!quad) return null;
  const fill = polyArea(quad) / (warped.rows * warped.cols);
  if (!(minFill <= fill && fill <= maxFill)) return null;
  return {
    found: true, method: 'refit', quad, warped: warpQuad(cv, warped, quad),
    extended: opts.extended ? warpQuadExtended(cv, warped, quad) : null,
  };
}

// fractional box (x0, y0, x1, y1) of an image -> ROI view (caller deletes), clamped as crop_box
export function cropBox(cv, mat, box) {
  const w = mat.cols, h = mat.rows;
  const x0 = clamp(rte(box[0] * w), 0, w - 1), y0 = clamp(rte(box[1] * h), 0, h - 1);
  const x1 = Math.max(x0 + 1, clamp(rte(box[2] * w), 0, w)), y1 = Math.max(y0 + 1, clamp(rte(box[3] * h), 0, h));
  return mat.roi(new cv.Rect(x0, y0, x1 - x0, y1 - y0));
}

export function rotate180(cv, mat) {
  const out = new cv.Mat();
  cv.rotate(mat, out, cv.ROTATE_180);
  return out;
}
