// OCR readers of the Kartenkiste: a port of mtg-bibliothek/server/recognize/ocr.py (title, banner,
// illus, collector line with the line finder / line steepness / tall-warp step / detector fallback)
// on top of onnxruntime-web + opencv.js, with the PP-OCR pre/post-processing of RapidOCR 3.9
// (DBPostProcess incl. dilation, fast box score and a Clipper-style round unclip; CTC decode;
// batches of 6 sorted by aspect ratio). Models: det.onnx = PP-OCRv6_det_small, rec_latin.onnx =
// Latin PP-OCRv5 rec mobile (same files as the Python reference).
//
// Pipeline API (cv = opencv.js, warped / tall = RGBA cv.Mat, the 1000x1400 warp; every call
// leaves the Mats it receives untouched and deletes what it allocates):
//   await initOcr({ ep, threads })
//   await readTitle(cv, warped, timing?)              -> { text, conf }
//   await readCollector(cv, warped, tall?, timing?)   -> { text, conf, method, legible, steepness }
//   await readBanner(cv, warped, timing?)             -> string[]
//   await readIllus(cv, warped, timing?)              -> string[]
//   findCollectorLines(cv, warped, cardH?, regionTop?) -> [[x0,y0,x1,y1] x2] | []   (sync)
//   parseCollectorText(text, knownSets?)              -> { collector_number, set_code, lang, rarity }
//   await ocrRegion(cv, rgbaRegion, upscale, timing?) -> { text, conf, lines:[{text,conf,box}] }
// `tall`: the warp continued below the card (same width, the card in its first warped.rows rows),
// as Detection.extended cut from the card's top edge on; omit it when there is none.
// opencv.js pitfalls: `cv` has a `then` method (delete cv.then once ready, never return cv from an
// async function); load opencv.js before onnxruntime (ORT is imported lazily in initOcr).

// imported lazily in initOcr: loaded before opencv.js, the page hung (05.11.)
let ort = null;

// ---- constants (ocr.py / detect.py, 1:1) ---------------------------------------------------------
const TITLE_BOX = [0.04, 0.035, 0.80, 0.115], BOTTOM_BOX = [0.02, 0.905, 0.62, 0.985];
const TITLE_UPSCALE = 2.0, BOTTOM_UPSCALE = 3.0;
const BANNER_BOX = [0.03, 0.62, 0.97, 0.93], BANNER_UPSCALE = 1.0;
const ILLUS_BOX = [0.25, 0.87, 0.75, 0.96], ILLUS_UPSCALE = 2.0;
const COLLECTOR_REGION = [0.0, 0.875, 0.50, 1.0], COLLECTOR_HIGH_TOP = 0.80, COLLECTOR_LEFT = 0.30;
const LINE_KERNEL = 27, FRAME_KERNEL = 61, LINE_MIN_H = 10, LINE_MAX_H = 32;
const LINE_MIN_PITCH = 16, LINE_MAX_PITCH = 38, LINE_MAX_INDENT = 12, LINE_PAD = 5, LINE_MAX_W = 170;
const REC_HEIGHT = 48, LEGIBLE_STEEPNESS = 0.22, STEEPNESS_MIN_CONTRAST = 40.0, TEXT_SCORE = 0.3;
// RapidOCR defaults (config.yaml): Global min/max side, vertical padding; Det; Rec
const G_MIN_SIDE = 30, G_MAX_SIDE = 2000, G_MIN_HEIGHT = 30, G_WH_RATIO = 8;
const DET_THRESH = 0.3, DET_BOX_THRESH = 0.5, DET_MAX_CAND = 1000, DET_UNCLIP = 1.6, DET_MIN_SIZE = 3;
const REC_SHAPE = [3, 48, 320], REC_BATCH = 6;

export { LEGIBLE_STEEPNESS, TITLE_BOX, BOTTOM_BOX, BANNER_BOX, ILLUS_BOX };

let det = null, rec = null, chars = null, provider = 'wasm';

export async function initOcr({ ep = 'wasm', threads = 1 } = {}) {
  // plain WASM build (11 MB) unless WebGPU is wanted (JSEP build, 22 MB)
  ort = await import(ep === 'webgpu' ? '../vendor/ort.all.min.mjs' : '../vendor/ort.wasm.min.mjs');
  ort.env.wasm.wasmPaths = new URL('../vendor/', import.meta.url).href;
  ort.env.wasm.numThreads = threads;
  if (new URLSearchParams(location.search).get('ortlog')) ort.env.logLevel = 'verbose';
  provider = ep;
  const opts = { executionProviders: [ep], graphOptimizationLevel: 'all' };
  const [d, r, dict] = await Promise.all([
    ort.InferenceSession.create(new URL('../models/det.onnx', import.meta.url).href, opts),
    ort.InferenceSession.create(new URL('../models/rec_latin.onnx', import.meta.url).href, opts),
    fetch(new URL('../models/rec_latin_dict.json', import.meta.url)).then(r => r.json()),
  ]);
  det = d; rec = r;
  chars = ['', ...dict.filter(c => c !== ''), ' '];  // CTC blank first, space last (504 classes)
  return { provider, threads: ort.env.wasm.numThreads };
}

// ---- small helpers ----------------------------------------------------------------------------------
// Python round(): half to even (np.round for the box scaling as well)
function pyRound(x) {
  const r = Math.round(x);
  return (Math.abs(x % 1) === 0.5 && r % 2 !== 0) ? r - 1 : r;
}
const f32 = Math.fround;
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;

// numpy percentile (linear) of a uint8 Mat's data via histogram
function percentileU8(data, q) {
  const hist = new Uint32Array(256), n = data.length;
  for (let i = 0; i < n; i++) hist[data[i]]++;
  const at = k => { let c = 0; for (let v = 0; v < 256; v++) { c += hist[v]; if (k < c) return v; } return 255; };
  const idx = (n - 1) * q / 100, lo = Math.floor(idx), g = idx - lo, a = at(lo), b = at(Math.min(lo + 1, n - 1));
  return a + (b - a) * g;
}
function percentileSorted(sorted, q) {
  const n = sorted.length, idx = (n - 1) * q / 100, lo = Math.floor(idx), g = idx - lo;
  const a = sorted[lo], b = sorted[Math.min(lo + 1, n - 1)];
  return a + (b - a) * g;
}

// crop_box: fractional box -> ROI view (delete it) of an image Mat
function cropBox(cv, img, box) {
  const w = img.cols, h = img.rows;
  const x0 = Math.max(0, Math.min(w - 1, pyRound(box[0] * w)));
  const y0 = Math.max(0, Math.min(h - 1, pyRound(box[1] * h)));
  const x1 = Math.max(x0 + 1, Math.min(w, pyRound(box[2] * w)));
  const y1 = Math.max(y0 + 1, Math.min(h, pyRound(box[3] * h)));
  return img.roi(new cv.Rect(x0, y0, x1 - x0, y1 - y0));
}


// cv2.resize(INTER_CUBIC) as of opencv-python 5.0 (the reference): float coefficients (A = -0.75),
// replicate borders, round to nearest. opencv.js 4.10 uses fixed-point coefficients and differs by
// +-1 on a few pixels, which flips low-confidence characters of the recogniser. Takes an RGBA or
// 1-channel Mat (views are fine); fx/fy as passed to cv2 (inverse scales) or 0 to derive them.
function cubicResize(cv, src, dstW, dstH, fx = 0, fy = 0) {
  const ch = src.channels(), keep = ch === 4 ? 3 : ch;   // alpha is never read downstream
  const own = src.isContinuous() ? null : src.clone();
  const s = (own || src).data, sw = src.cols, sh = src.rows;
  const sx = fx > 0 ? 1 / fx : sw / dstW, sy = fy > 0 ? 1 / fy : sh / dstH;
  const A = -0.75;
  const axis = (nOut, nIn, scale) => {
    const idx = new Int32Array(nOut * 4), cf = new Float64Array(nOut * 4);
    for (let i = 0; i < nOut; i++) {
      const f = (i + 0.5) * scale - 0.5, x0 = Math.floor(f), t = f - x0;
      const c0 = ((A * (t + 1) - 5 * A) * (t + 1) + 8 * A) * (t + 1) - 4 * A;
      const c1 = ((A + 2) * t - (A + 3)) * t * t + 1;
      const c2 = ((A + 2) * (1 - t) - (A + 3)) * (1 - t) * (1 - t) + 1;
      cf[i * 4] = c0; cf[i * 4 + 1] = c1; cf[i * 4 + 2] = c2; cf[i * 4 + 3] = 1 - c0 - c1 - c2;
      for (let k = 0; k < 4; k++) idx[i * 4 + k] = Math.min(Math.max(x0 - 1 + k, 0), nIn - 1);
    }
    return { idx, cf };
  };
  const X = axis(dstW, sw, sx), Y = axis(dstH, sh, sy);
  const tmp = new Float64Array(sh * dstW * keep);   // horizontal pass
  for (let y = 0; y < sh; y++) for (let x = 0; x < dstW; x++) for (let c = 0; c < keep; c++) {
    let v = 0;
    for (let k = 0; k < 4; k++) v += X.cf[x * 4 + k] * s[(y * sw + X.idx[x * 4 + k]) * ch + c];
    tmp[(y * dstW + x) * keep + c] = v;
  }
  const out = new cv.Mat(dstH, dstW, src.type());
  const o = out.data;
  if (ch === 4) o.fill(255);
  for (let y = 0; y < dstH; y++) for (let x = 0; x < dstW; x++) for (let c = 0; c < keep; c++) {
    let v = 0;
    for (let k = 0; k < 4; k++) v += Y.cf[y * 4 + k] * tmp[(Y.idx[y * 4 + k] * dstW + x) * keep + c];
    o[(y * dstW + x) * ch + c] = v <= 0 ? 0 : v >= 255 ? 255 : pyRound(v);
  }
  if (own) own.delete();
  return out;
}
// cv2.resize(src, None, fx, fy, INTER_CUBIC)
function cubicScale(cv, src, fx, fy) {
  return cubicResize(cv, src, Math.max(1, pyRound(src.cols * fx)), Math.max(1, pyRound(src.rows * fy)), fx, fy);
}

// ---- preprocess (ocr.preprocess): upscale bicubic, gray, CLAHE -> new 1-channel Mat -----------------
let clahe = null;
function preprocess(cv, region, upscale) {
  let work = region, own = null;
  if (upscale && upscale !== 1.0) {
    own = cubicScale(cv, region, upscale, upscale);
    work = own;
  }
  const gray = new cv.Mat();
  if (work.channels() === 1) work.copyTo(gray); else cv.cvtColor(work, gray, cv.COLOR_RGBA2GRAY);
  if (own) own.delete();
  if (!clahe) clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));
  const out = new cv.Mat();
  clahe.apply(gray, out);
  gray.delete();
  return out;
}

// ---- RapidOCR detector pre/post-processing ----------------------------------------------------------
const DET_LUT = new Float32Array(256), REC_LUT = new Float32Array(256);
for (let v = 0; v < 256; v++) {
  DET_LUT[v] = f32((f32(v * f32(1 / 255)) - 0.5) / 0.5);   // float32 img * scale, float64 (-mean)/std, -> float32
  REC_LUT[v] = f32(f32(f32(v / 255) - 0.5) / 0.5);          // all float32
}

// get_mini_boxes: 4 points (clockwise from the top-left, as DBPostProcess) + the short side
function miniBoxes(cv, contour) {
  const rr = cv.minAreaRect(contour);
  const pts = cv.RotatedRect.points(rr).map(p => [p.x, p.y]);
  pts.sort((a, b) => a[0] - b[0]);   // stable, as Python sorted
  let i1, i4, i2, i3;
  if (pts[1][1] > pts[0][1]) { i1 = 0; i4 = 1; } else { i1 = 1; i4 = 0; }
  if (pts[3][1] > pts[2][1]) { i2 = 2; i3 = 3; } else { i2 = 3; i3 = 2; }
  return { box: [pts[i1], pts[i2], pts[i3], pts[i4]], side: Math.min(rr.size.width, rr.size.height) };
}

// pyclipper PyclipperOffset(JT_ROUND, ET_CLOSEDPOLYGON).Execute(distance) on an integer polygon,
// emulating Clipper 6.4 (ArcTolerance 0.25) for the convex quad DBPostProcess feeds it.
function clipperRoundOffset(poly, delta) {
  const rnd = x => Math.trunc(x < 0 ? x - 0.5 : x + 0.5);
  let P = poly.filter((p, i) => { const q = poly[(i + poly.length - 1) % poly.length]; return p[0] !== q[0] || p[1] !== q[1]; });
  const n0 = P.length;
  if (n0 < 3) return P;
  let area = 0;
  for (let i = 0; i < n0; i++) { const a = P[i], b = P[(i + 1) % n0]; area += a[0] * b[1] - b[0] * a[1]; }
  if (area < 0) P = P.slice().reverse();   // Clipper wants the outer ring positively oriented
  const n = P.length, absD = Math.abs(delta);
  if (absD < 0.5) return P;
  const y = 0.25 > absD * 0.25 ? absD * 0.25 : 0.25;   // ArcTolerance 0.25 vs absDelta * def_arc_tolerance
  let steps = Math.PI / Math.acos(1 - y / absD);
  if (steps > absD * Math.PI) steps = absD * Math.PI;
  const mSin = Math.sin(2 * Math.PI / steps), mCos = Math.cos(2 * Math.PI / steps), stepsPerRad = steps / (2 * Math.PI);
  const nrm = P.map((p, i) => {
    const q = P[(i + 1) % n], dx = q[0] - p[0], dy = q[1] - p[1], f = 1 / Math.sqrt(dx * dx + dy * dy);
    return [dy * f, -dx * f];
  });
  const out = [];
  for (let j = 0, k = n - 1; j < n; k = j, j++) {
    const nk = nrm[k], nj = nrm[j], src = P[j];
    let sinA = nk[0] * nj[1] - nj[0] * nk[1];
    if (Math.abs(sinA * delta) < 1.0) {
      const cosA = nk[0] * nj[0] + nj[1] * nk[1];
      if (cosA > 0) { out.push([rnd(src[0] + nk[0] * delta), rnd(src[1] + nk[1] * delta)]); continue; }
    } else if (sinA > 1) sinA = 1; else if (sinA < -1) sinA = -1;
    if (sinA * delta < 0) {   // concave
      out.push([rnd(src[0] + nk[0] * delta), rnd(src[1] + nk[1] * delta)], [src[0], src[1]], [rnd(src[0] + nj[0] * delta), rnd(src[1] + nj[1] * delta)]);
    } else {                  // DoRound
      const a = Math.atan2(sinA, nk[0] * nj[0] + nk[1] * nj[1]);
      const st = Math.max(pyRound(stepsPerRad * Math.abs(a)), 1);
      let X = nk[0], Y = nk[1];
      for (let i = 0; i < st; i++) {
        out.push([rnd(src[0] + X * delta), rnd(src[1] + Y * delta)]);
        const X2 = X; X = X * mCos - mSin * Y; Y = X2 * mSin + Y * mCos;
      }
      out.push([rnd(src[0] + nj[0] * delta), rnd(src[1] + nj[1] * delta)]);
    }
  }
  return out;
}

// DBPostProcess.unclip + get_mini_boxes of the grown polygon
function unclipBox(cv, box) {
  let area = 0, len = 0;
  for (let i = 0; i < 4; i++) {
    const a = box[i], b = box[(i + 1) % 4];
    area += a[0] * b[1] - b[0] * a[1];
    len += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  area = Math.abs(area) / 2;
  const distance = area * DET_UNCLIP / len;
  const ints = box.map(p => [Math.trunc(p[0]), Math.trunc(p[1])]);   // pyclipper takes integer points
  const grown = clipperRoundOffset(ints, distance);
  if (grown.length < 3) return null;
  const m = cv.matFromArray(grown.length, 1, cv.CV_32SC2, grown.flat());
  const r = miniBoxes(cv, m);
  m.delete();
  return r;
}

// box_score_fast: mean of the probability map inside the box polygon
function boxScoreFast(cv, pred, W, H, box) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of box) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
  const xmin = Math.min(Math.max(Math.floor(x0), 0), W - 1), xmax = Math.min(Math.max(Math.ceil(x1), 0), W - 1);
  const ymin = Math.min(Math.max(Math.floor(y0), 0), H - 1), ymax = Math.min(Math.max(Math.ceil(y1), 0), H - 1);
  const mw = xmax - xmin + 1, mh = ymax - ymin + 1;
  const mask = cv.Mat.zeros(mh, mw, cv.CV_8U);
  const poly = cv.matFromArray(4, 1, cv.CV_32SC2, box.flatMap(p => [Math.trunc(p[0] - xmin), Math.trunc(p[1] - ymin)]));
  const vec = new cv.MatVector(); vec.push_back(poly);
  cv.fillPoly(mask, vec, new cv.Scalar(1));
  let sum = 0, cnt = 0;
  const md = mask.data;
  for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) if (md[y * mw + x]) { sum += pred[(ymin + y) * W + xmin + x]; cnt++; }
  mask.delete(); vec.delete(); poly.delete();
  return cnt ? sum / cnt : 0;
}

// order_points_clockwise + clip_det_res of DBPostProcess.filter_det_res
function orderClockwise(b) {
  const xs = b.slice().sort((p, q) => p[0] - q[0]);
  const [tl, bl] = xs.slice(0, 2).sort((p, q) => p[1] - q[1]);
  const [tr, br] = xs.slice(2).sort((p, q) => p[1] - q[1]);
  return [tl, tr, br, bl];
}

// RapidOCR image steps before the detector: resize_image_within_bounds, vertical padding.
// gray: 1-channel Mat. Returns the Mat to detect on plus the bookkeeping to map boxes back.
function rapidPrepare(cv, gray, own) {
  let img = gray, ratioH = 1, ratioW = 1;
  const resize32 = (src, ratio) => {
    const h = src.rows, w = src.cols;
    const rh = pyRound(Math.trunc(h * ratio) / 32) * 32, rw = pyRound(Math.trunc(w * ratio) / 32) * 32;
    if (rh <= 0 || rw <= 0) throw new Error('resize to zero');
    const out = new cv.Mat(); own.push(out);
    cv.resize(src, out, new cv.Size(rw, rh));
    ratioH = h / rh; ratioW = w / rw;
    return out;
  };
  if (Math.max(img.rows, img.cols) > G_MAX_SIDE) img = resize32(img, G_MAX_SIDE / Math.max(img.rows, img.cols));
  if (Math.min(img.rows, img.cols) < G_MIN_SIDE) img = resize32(img, G_MIN_SIDE / Math.min(img.rows, img.cols));
  let top = 0;
  const h = img.rows, w = img.cols;
  if (h <= G_MIN_HEIGHT || w / h > G_WH_RATIO) {
    const newH = Math.max(Math.trunc(w / G_WH_RATIO), G_MIN_HEIGHT) * 2;
    top = Math.trunc(Math.abs(newH - h) / 2);
    const out = new cv.Mat(); own.push(out);
    cv.copyMakeBorder(img, out, top, top, 0, 0, cv.BORDER_CONSTANT, new cv.Scalar(0));
    img = out;
  }
  return { img, ratioH, ratioW, top };
}

// TextDetector.__call__ + DBPostProcess; returns boxes of `img` (padded) coordinates, sorted
async function detectBoxes(cv, img, timing, detCap = 0) {
  const H0 = img.rows, W0 = img.cols, maxwh = Math.max(H0, W0);
  let limit = maxwh < 960 ? 960 : maxwh < 1500 ? 1500 : 2000;   // TextDetector.get_preprocess (limit_type max)
  // FAST MODE (deviation from Python/RapidOCR, off unless the caller passes detCap): run the detector on at most detCap px of
  // the long side. The boxes are mapped back to this image, the recogniser still reads crops of the full-resolution image.
  if (detCap > 0 && detCap < limit) limit = detCap;
  const ratio = maxwh > limit ? limit / (H0 > W0 ? H0 : W0) : 1.0;
  const rh = pyRound(Math.trunc(H0 * ratio) / 32) * 32, rw = pyRound(Math.trunc(W0 * ratio) / 32) * 32;
  if (rh <= 0 || rw <= 0) return [];
  const rs = new cv.Mat();
  cv.resize(img, rs, new cv.Size(rw, rh));
  const n = rw * rh, data = new Float32Array(3 * n), src = rs.data;
  for (let i = 0; i < n; i++) { const v = DET_LUT[src[i]]; data[i] = v; data[n + i] = v; data[2 * n + i] = v; }
  rs.delete();
  const t0 = performance.now();
  const out = await det.run({ x: new ort.Tensor('float32', data, [1, 3, rh, rw]) });
  if (timing) timing.det = (timing.det || 0) + performance.now() - t0;
  const pred = Object.values(out)[0].data;   // [1,1,rh,rw]
  const thr = f32(DET_THRESH);
  const bm = new cv.Mat(rh, rw, cv.CV_8U);
  for (let i = 0; i < n; i++) bm.data[i] = pred[i] > thr ? 255 : 0;
  const dil = new cv.Mat(), ker = cv.Mat.ones(2, 2, cv.CV_8U);
  cv.dilate(bm, dil, ker, new cv.Point(-1, -1), 1, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue());
  bm.delete(); ker.delete();
  const contours = new cv.MatVector(), hier = new cv.Mat();
  cv.findContours(dil, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
  dil.delete(); hier.delete();
  const boxes = [];
  const num = Math.min(contours.size(), DET_MAX_CAND);
  for (let i = 0; i < num; i++) {
    const c = contours.get(i);
    const mb = miniBoxes(cv, c);
    c.delete();
    if (mb.side < DET_MIN_SIZE) continue;
    const score = boxScoreFast(cv, pred, rw, rh, mb.box);
    if (DET_BOX_THRESH > score) continue;
    const g = unclipBox(cv, mb.box);
    if (!g || g.side < DET_MIN_SIZE + 2) continue;
    const bx = g.box.map(p => [
      Math.min(Math.max(pyRound(p[0] / rw * W0), 0), W0),
      Math.min(Math.max(pyRound(p[1] / rh * H0), 0), H0)]);
    // filter_det_res
    const o = orderClockwise(bx).map(p => [Math.trunc(Math.min(Math.max(p[0], 0), W0 - 1)), Math.trunc(Math.min(Math.max(p[1], 0), H0 - 1))]);
    const nrm = (a, b) => f32(Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2));
    if (Math.trunc(nrm(o[0], o[1])) <= 3 || Math.trunc(nrm(o[0], o[3])) <= 3) continue;
    boxes.push(o);
  }
  contours.delete();
  // TextDetector.sorted_boxes: stable by y of the top-left, new row when dy >= 10, then x
  const byY = boxes.map((b, i) => ({ b, i })).sort((p, q) => p.b[0][1] - q.b[0][1] || p.i - q.i);
  let line = 0;
  byY.forEach((it, i) => { if (i > 0 && it.b[0][1] - byY[i - 1].b[0][1] >= 10) line++; it.line = line; });
  byY.sort((p, q) => p.line - q.line || p.b[0][0] - q.b[0][0]);
  return byY.map(it => it.b);
}

// get_rotate_crop_image on a 1-channel image; returns a new Mat
function cropRotated(cv, img, pts) {
  const nrm = (a, b) => f32(Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2));
  const w = Math.trunc(Math.max(nrm(pts[0], pts[1]), nrm(pts[2], pts[3])));
  const h = Math.trunc(Math.max(nrm(pts[0], pts[3]), nrm(pts[1], pts[2])));
  const from = cv.matFromArray(4, 1, cv.CV_32FC2, pts.flat());
  const to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w, 0, w, h, 0, h]);
  const M = cv.getPerspectiveTransform(from, to);
  let out = new cv.Mat();
  cv.warpPerspective(img, out, M, new cv.Size(w, h), cv.INTER_CUBIC, cv.BORDER_REPLICATE);
  from.delete(); to.delete(); M.delete();
  if (h / w >= 1.5) { const r = new cv.Mat(); cv.rotate(out, r, cv.ROTATE_90_COUNTERCLOCKWISE); out.delete(); out = r; }
  return out;
}

// ---- recognizer (TextRecognizer + CTCLabelDecode) ---------------------------------------------------
// imgs: Mats, 1 channel (gray, replicated to 3) or RGBA (fed as B,G,R like cv2 BGR). -> [{text, conf}]
async function recognizeMats(cv, imgs, timing) {
  const res = new Array(imgs.length);
  if (!imgs.length) return res;
  const ratios = imgs.map(m => m.cols / m.rows);
  const order = ratios.map((r, i) => i).sort((a, b) => ratios[a] - ratios[b] || a - b);
  const [, imgH, imgW0] = REC_SHAPE;
  for (let beg = 0; beg < imgs.length; beg += REC_BATCH) {
    const idx = order.slice(beg, Math.min(imgs.length, beg + REC_BATCH));
    let maxRatio = imgW0 / imgH;
    for (const i of idx) maxRatio = Math.max(maxRatio, ratios[i]);
    const W = Math.trunc(imgH * maxRatio), plane = imgH * W;
    const data = new Float32Array(idx.length * 3 * plane);   // zero padding, as RapidOCR
    idx.forEach((i, b) => {
      const m = imgs[i], ratio = m.cols / m.rows;
      const rwid = Math.ceil(imgH * ratio) > W ? W : Math.ceil(imgH * ratio);
      const rs = new cv.Mat();
      cv.resize(m, rs, new cv.Size(rwid, imgH));
      const base = b * 3 * plane, d = rs.data, ch = rs.channels();
      for (let y = 0; y < imgH; y++) for (let x = 0; x < rwid; x++) {
        const p = y * rwid + x, o = y * W + x;
        if (ch === 1) { const v = REC_LUT[d[p]]; data[base + o] = v; data[base + plane + o] = v; data[base + 2 * plane + o] = v; }
        else { data[base + o] = REC_LUT[d[p * 4 + 2]]; data[base + plane + o] = REC_LUT[d[p * 4 + 1]]; data[base + 2 * plane + o] = REC_LUT[d[p * 4]]; }
      }
      rs.delete();
    });
    const t0 = performance.now();
    const out = await rec.run({ x: new ort.Tensor('float32', data, [idx.length, 3, imgH, W]) });
    if (timing) timing.rec = (timing.rec || 0) + performance.now() - t0;
    const t = Object.values(out)[0], [, T, C] = t.dims, p = t.data;
    idx.forEach((i, b) => {
      let text = '', confs = [], last = -1;
      for (let s = 0; s < T; s++) {
        let bi = 0, bv = -Infinity;
        const off = (b * T + s) * C;
        for (let c = 0; c < C; c++) if (p[off + c] > bv) { bv = p[off + c]; bi = c; }
        if (bi !== 0 && bi !== last) { text += chars[bi] ?? ''; confs.push(Math.round(bv * 1e5) / 1e5); }
        last = bi;
      }
      res[i] = { text, conf: confs.length ? Math.round(mean(confs) * 1e5) / 1e5 : 0 };
    });
  }
  return res;
}

// ---- ocr_region (RapidOCR det + rec) ----------------------------------------------------------------
function sortLines(lines) {
  if (!lines.length) return [];
  const geo = l => {
    if (!l.box.length) return { yc: 0, h: 0, x: 0 };
    const ys = l.box.map(p => p[1]), xs = l.box.map(p => p[0]);
    return { yc: (Math.min(...ys) + Math.max(...ys)) / 2, h: Math.max(...ys) - Math.min(...ys), x: Math.min(...xs) };
  };
  const items = lines.map(l => ({ l, g: geo(l) })).sort((a, b) => a.g.yc - b.g.yc);
  const rows = [];
  for (const it of items) {
    const row = rows[rows.length - 1];
    if (row) {
      const yc = mean(row.map(r => r.g.yc)), rh = mean(row.map(r => r.g.h)) || 1.0;
      if (Math.abs(it.g.yc - yc) <= 0.5 * Math.max(rh, it.g.h, 1.0)) { row.push(it); continue; }
    }
    rows.push([it]);
  }
  return rows.flatMap(r => r.slice().sort((a, b) => a.g.x - b.g.x).map(x => x.l));
}

// region: RGBA Mat (view ok). Returns {text, conf, lines:[{text, conf, box (region pixels)}]}
export async function ocrRegion(cv, region, upscale, timing, detCap = 0) {
  const own = [];
  const gray = preprocess(cv, region, upscale); own.push(gray);
  try {
    const prep = rapidPrepare(cv, gray, own);
    const boxes = await detectBoxes(cv, prep.img, timing, detCap);
    const crops = boxes.map(b => { const m = cropRotated(cv, prep.img, b); own.push(m); return m; });
    const recs = await recognizeMats(cv, crops, timing);
    const H = gray.rows, W = gray.cols, factor = upscale ? Number(upscale) : 1.0;
    let lines = [];
    recs.forEach((r, i) => {
      if (!r.text.trim() || r.conf < TEXT_SCORE) return;   // RapidOCR drops empty text and scores < text_score
      const box = boxes[i].map(p => {   // map_boxes_to_original (padding, ratio, clamp) and / upscale
        const x = Math.min(Math.max(f32(p[0] * prep.ratioW), 0), W), y = Math.min(Math.max(f32((p[1] - prep.top) * prep.ratioH), 0), H);
        return [x / factor, y / factor];
      });
      lines.push({ text: r.text.trim(), conf: r.conf, box });
    });
    lines = sortLines(lines);
    return { text: lines.map(l => l.text).join(' '), conf: lines.length ? mean(lines.map(l => l.conf)) : 0, lines };
  } finally { own.forEach(m => m.delete()); }
}

async function readBox(cv, warped, box, upscale, timing, detCap = 0) {
  const roi = cropBox(cv, warped, box);
  try {
    const r = await ocrRegion(cv, roi, upscale, timing, detCap);
    return r;
  } finally { roi.delete(); }
}

// last argument of the readers: { detCap } = fast-mode cap of the detector input (px, long side); omitted = exact RapidOCR path
export async function readTitle(cv, warped, timing, { detCap = 0 } = {}) {
  const r = await readBox(cv, warped, TITLE_BOX, TITLE_UPSCALE, timing, detCap);
  return { text: r.lines.length ? r.text : '', conf: r.lines.length ? r.conf : 0, lines: r.lines };
}
export async function readBanner(cv, warped, timing, { detCap = 0 } = {}) {
  return (await readBox(cv, warped, BANNER_BOX, BANNER_UPSCALE, timing, detCap)).lines.map(l => l.text).filter(Boolean);
}
export async function readIllus(cv, warped, timing, { detCap = 0 } = {}) {
  return (await readBox(cv, warped, ILLUS_BOX, ILLUS_UPSCALE, timing, detCap)).lines.map(l => l.text).filter(Boolean);
}

// ---- collector line --------------------------------------------------------------------------------
// ocr.find_collector_lines. warped: RGBA Mat. Returns [] or the two boxes [x0,y0,x1,y1].
export function findCollectorLines(cv, warped, cardH = null, regionTop = null) {
  if (!warped || warped.empty()) return [];
  const h = warped.rows, w = warped.cols;
  const card = cardH ? Math.trunc(cardH) : h;
  const scale = card / 1400.0;
  const topFrac = regionTop === null ? COLLECTOR_REGION[1] : Number(regionTop);
  const x0 = Math.trunc(COLLECTOR_REGION[0] * w), y0 = Math.trunc(topFrac * card);
  const x1 = Math.trunc(COLLECTOR_REGION[2] * w), y1 = cardH ? h : Math.trunc(COLLECTOR_REGION[3] * h);
  const rw = Math.min(x1, w) - x0, rh = Math.min(y1, h) - y0;
  if (rh < 8 || rw < 8) return [];
  const own = [];
  const M = m => { own.push(m); return m; };
  try {
    const view = M(warped.roi(new cv.Rect(x0, y0, rw, rh)));
    const gray0 = M(new cv.Mat());
    if (view.channels() === 1) view.copyTo(gray0); else cv.cvtColor(view, gray0, cv.COLOR_RGBA2GRAY);
    const gray = M(new cv.Mat());
    cv.GaussianBlur(gray0, gray, new cv.Size(3, 3), 0, 0, cv.BORDER_DEFAULT);
    const vk = Math.max(3, pyRound(LINE_KERNEL * scale) | 1);
    const padded = M(new cv.Mat());
    cv.copyMakeBorder(gray, padded, vk, vk, 0, 0, cv.BORDER_CONSTANT, new cv.Scalar(0));
    const kv = M(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1, vk)));
    const th = M(new cv.Mat());
    const bv = cv.morphologyDefaultBorderValue(), an = new cv.Point(-1, -1);
    cv.morphologyEx(padded, th, cv.MORPH_TOPHAT, kv, an, 1, cv.BORDER_CONSTANT, bv);
    const top = M(th.roi(new cv.Rect(0, vk, rw, rh)));
    const hk = Math.max(3, pyRound(FRAME_KERNEL * scale) | 1);
    const kh = M(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(hk, 1)));
    const opened = M(new cv.Mat());
    cv.morphologyEx(top, opened, cv.MORPH_OPEN, kh, an, 1, cv.BORDER_CONSTANT, bv);
    const sub = M(new cv.Mat());
    cv.subtract(top, opened, sub);
    const sd = sub.data;   // continuous (fresh Mat)
    const threshold = Math.max(20.0, percentileU8(sd, 97) * 0.5);
    const mask = new Uint8Array(rw * rh);
    for (let i = 0; i < mask.length; i++) mask[i] = sd[i] > threshold ? 1 : 0;

    const leftW = Math.max(1, Math.trunc(COLLECTOR_LEFT * w) - x0);
    const prof = new Float32Array(rh);
    for (let y = 0; y < rh; y++) { let s = 0; for (let x = 0; x < leftW; x++) s += mask[y * rw + x]; prof[y] = s; }
    const pm = M(cv.matFromArray(rh, 1, cv.CV_32FC1, Array.from(prof)));
    const pb = M(new cv.Mat());
    cv.GaussianBlur(pm, pb, new cv.Size(1, 5), 0, 0, cv.BORDER_DEFAULT);
    const profile = pb.data32F;

    // runs of profile >= 8 * scale
    const runs = [];
    const lim = 8 * scale;
    for (let y = 0; y < rh; y++) {
      if (profile[y] >= lim) { const a = y; while (y < rh && profile[y] >= lim) y++; runs.push([a, y]); }
    }
    const rows = [];
    for (const [a, b] of runs) {
      if (b - a < 6 * scale) continue;
      if (b - a > LINE_MAX_H * scale) {   // two lines without a gap between them
        const lo = a + Math.trunc(0.3 * (b - a)), hi = b - Math.trunc(0.3 * (b - a));
        let cut = lo, best = Infinity;
        for (let y = lo; y < hi; y++) if (profile[y] < best) { best = profile[y]; cut = y; }
        rows.push([a, cut], [cut, b]);
      } else rows.push([a, b]);
    }
    const boxes = [];
    for (const [a, b] of rows) {
      let first = -1, last = -1, aFirst = -1, aLast = -1, cntLeft = 0;
      for (let x = 0; x < rw; x++) {
        let s = 0;
        for (let y = a; y < b; y++) s += mask[y * rw + x];
        if (s > 0) {
          if (aFirst < 0) aFirst = x;
          aLast = x;
          if (x < leftW) { if (first < 0) first = x; last = x; cntLeft++; }
        }
      }
      if (cntLeft < 15 * scale) continue;
      boxes.push([x0 + first, y0 + a, x0 + aLast + 1, y0 + b]);
    }
    let pair = [];
    for (let i = 0; i + 1 < boxes.length; i++) {
      const first = boxes[i], second = boxes[i + 1];
      const h1 = first[3] - first[1], h2 = second[3] - second[1];
      const pitch = (second[1] + second[3]) / 2.0 - (first[1] + first[3]) / 2.0;
      const cutOff = second[3] >= h - 1;
      if (Math.abs(first[0] - second[0]) > LINE_MAX_INDENT * scale) continue;
      if (!(LINE_MIN_PITCH * scale <= pitch && pitch <= LINE_MAX_PITCH * scale)) continue;
      if (!(LINE_MIN_H * scale <= h1 && h1 <= LINE_MAX_H * scale)) continue;
      if (!((LINE_MIN_H * scale <= h2 && h2 <= LINE_MAX_H * scale) || (cutOff && h2 >= 6 * scale))) continue;
      pair = [first, second];   // keep the lowest pair
    }
    return pair;
  } finally { own.forEach(m => m.delete()); }
}

// line_crop: ROI view (delete it) of the start of a collector line
function lineCrop(cv, warped, box, cardH = null) {
  const h = warped.rows, w = warped.cols;
  const scale = (cardH ? Math.trunc(cardH) : h) / 1400.0;
  const [x0, y0, x1, y1] = box;
  const pad = pyRound(LINE_PAD * scale), margin = pyRound(8 * scale);
  const xEnd = Math.min(x1 + margin, x0 + pyRound(LINE_MAX_W * scale));
  const ya = Math.max(0, y0 - pad), yb = Math.min(h, y1 + pad), xa = Math.max(0, x0 - margin), xb = Math.min(w, xEnd);
  if (yb <= ya || xb <= xa) return null;
  return warped.roi(new cv.Rect(xa, ya, xb - xa, yb - ya));
}

// line_steepness: 95th percentile of the gradient magnitude per pixel / the crop's contrast
export function lineSteepness(cv, crop) {
  if (!crop || crop.empty()) return 0.0;
  const own = [];
  const M = m => { own.push(m); return m; };
  try {
    const gray = M(new cv.Mat());
    if (crop.channels() === 1) crop.copyTo(gray); else cv.cvtColor(crop, gray, cv.COLOR_RGBA2GRAY);
    const gd = gray.data, n = gd.length;
    const contrast = percentileU8(gd, 95) - percentileU8(gd, 5);
    if (contrast < STEEPNESS_MIN_CONTRAST) return 0.0;
    const gx = M(new cv.Mat()), gy = M(new cv.Mat());
    cv.Sobel(gray, gx, cv.CV_32F, 1, 0, 3, 1, 0, cv.BORDER_DEFAULT);
    cv.Sobel(gray, gy, cv.CV_32F, 0, 1, 3, 1, 0, cv.BORDER_DEFAULT);
    const ax = gx.data32F, ay = gy.data32F, mag = new Float32Array(n);
    for (let i = 0; i < n; i++) { const a = f32(ax[i] / 8.0), b = f32(ay[i] / 8.0); mag[i] = Math.sqrt(a * a + b * b); }
    mag.sort();
    return percentileSorted(mag, 95) / contrast;
  } finally { own.forEach(m => m.delete()); }
}

// recognize_line: recognition only, `img` is one text line (RGBA ROI/Mat); height scaled to 48
async function recognizeLine(cv, img, timing) {
  if (!img || img.empty()) return { text: '', conf: 0.0 };
  let work = img, own = null;
  if (img.rows !== REC_HEIGHT) {
    const f = REC_HEIGHT / img.rows;
    own = cubicScale(cv, img, f, f);
    work = own;
  }
  try {
    const r = await recognizeMats(cv, [work], timing);
    return { text: r[0].text.trim(), conf: r[0].conf };
  } finally { if (own) own.delete(); }
}

async function readLines(cv, image, boxes, cardH, timing) {
  const texts = [], confs = [];
  let steepness = 0.0;
  for (let i = 0; i < boxes.length; i++) {
    const crop = lineCrop(cv, image, boxes[i], cardH);
    try {
      if (i === 0) steepness = lineSteepness(cv, crop);
      const r = await recognizeLine(cv, crop, timing);
      if (r.text) { texts.push(r.text); confs.push(r.conf); }
    } finally { if (crop) crop.delete(); }
  }
  if (!texts.length) return { text: '', conf: 0.0, method: 'none', legible: false, steepness };
  return { text: texts.join(' '), conf: mean(confs), method: 'lines', legible: steepness >= LEGIBLE_STEEPNESS, steepness };
}

const sameBoxes = (a, b) => a.length === b.length && a.every((x, i) => x.every((v, j) => v === b[i][j]));

async function readLinesBelow(cv, warped, tall, boxes, first, timing) {
  if (!tall || !warped || tall.cols !== warped.cols || tall.rows <= warped.rows) return first;
  const h = warped.rows;
  const cut = boxes.length > 0 && boxes[boxes.length - 1][3] >= h - 1;
  if (!cut && first.text && hasCollectorInfo(first.text)) return first;
  const tb = findCollectorLines(cv, tall, h);
  if (!tb.length || tb[tb.length - 1][3] <= h - 1) return first;   // nothing below the card
  const second = await readLines(cv, tall, tb, h, timing);
  if (second.text && (hasCollectorInfo(second.text) || !first.text)) return second;
  return first;
}

async function readCollectorLines(cv, warped, tall, timing) {
  const boxes = findCollectorLines(cv, warped);
  const result = await readLinesBelow(cv, warped, tall, boxes, await readLines(cv, warped, boxes, null, timing), timing);
  if (!warped || (result.text && hasCollectorInfo(result.text))) return result;
  // nothing that parses: the lines may sit higher, above a sleeve rim or the tape guide
  const higher = findCollectorLines(cv, warped, null, COLLECTOR_HIGH_TOP);
  if (higher.length && !sameBoxes(higher, boxes)) {
    const alt = await readLines(cv, warped, higher, null, timing);
    if (alt.text && hasCollectorInfo(alt.text)) return alt;
  }
  return result;
}

// _detector_read: v1 reader (text detector + recogniser on BOTTOM_BOX)
async function detectorRead(cv, warped, timing, detCap = 0) {
  const region = cropBox(cv, warped, BOTTOM_BOX);
  try {
    const r = await ocrRegion(cv, region, BOTTOM_UPSCALE, timing, detCap);
    if (!r.lines.length) return { text: '', conf: 0.0, steepness: 0.0, digitLine: false };
    let steepness = 0.0, digitLine = false;
    const rh = region.rows, rw = region.cols;
    for (const line of r.lines) {
      if ((line.text.match(/\d/g) || []).length < 2) continue;
      digitLine = true;
      if (!line.box.length) continue;
      const xs = line.box.map(p => p[0]), ys = line.box.map(p => p[1]);
      const a = Math.max(0, Math.trunc(Math.min(...xs))), b = Math.min(rw, Math.trunc(Math.max(...xs)) + 1);
      const c = Math.max(0, Math.trunc(Math.min(...ys))), d = Math.min(rh, Math.trunc(Math.max(...ys)) + 1);
      if (b - a >= 4 && d - c >= 4) {
        const crop = region.roi(new cv.Rect(a, c, b - a, d - c));
        try { steepness = Math.max(steepness, lineSteepness(cv, crop)); } finally { crop.delete(); }
      }
    }
    return { text: r.text, conf: mean(r.lines.map(l => l.conf)), steepness, digitLine };
  } finally { region.delete(); }
}

export async function readBottomDetector(cv, warped, timing) {
  const r = await detectorRead(cv, warped, timing);
  return { text: r.text, conf: r.conf };
}

// read_collector: line reader first, v1 detector reader as the fallback
export async function readCollector(cv, warped, tall = null, timing, { detCap = 0 } = {}) {
  const lines = await readCollectorLines(cv, warped, tall, timing);
  if (lines.text && hasCollectorInfo(lines.text)) return lines;
  const d = await detectorRead(cv, warped, timing, detCap);
  if (d.text && (!lines.text || hasCollectorInfo(d.text))) {
    const steepness = lines.steepness > 0.0 ? lines.steepness : d.steepness;
    const legible = (steepness > 0.0 || d.digitLine) ? steepness >= LEGIBLE_STEEPNESS : true;
    return { text: d.text, conf: d.conf, method: 'detector', legible, steepness };
  }
  return lines;
}

// ---- parse_bottom (match.py), needed for the "does it parse" decisions ----------------------------
const DIGIT_FIX = { O: '0', I: '1', L: '1', '|': '1', S: '5', Z: '2', B: '8' };
const fixDigits = s => s.replace(/[OIL|SZB]/g, c => DIGIT_FIX[c]);
const PIPE_SLASH_RE = /(?<![A-Z0-9])([0-9O]{3,4})\s*[|IL]\s*([0-9O]{3,4})(?![A-Z0-9])/g;
const EURO_SIX_RE = /(?<![A-Z0-9])(0[0-9OILSZB]{2})€(?![A-Z0-9])/g;
const TOKEN_RE = /[A-Z0-9|]+/g;
const CN_SLASH_RE = /(?<![A-Z0-9])(\d{1,4})\s*[/\\]\s*(\d{1,4})(?![A-Z0-9])/;
const CN_LONE_RE = /(?<![A-Z0-9])([CURMSLT])?(\d{3,4})([CURMSLT])?(?![A-Z0-9])/g;
const GLUED_RARITY_RE = /^([CURMSLT])?([0-9OILSZB|]{3,4})([CURMSLT])?$/;
const RARITY_RE = /\s*[.\-*•·:,]*\s*([CURMSLT])(?![A-Z0-9])/y;
const RARITY_BEFORE_RE = /(?<![A-Z0-9])([CURMSLT])[\s.\-*•·:,]*$/;
const YEAR_RE = /^(19|20)\d\d$/;
const COPYRIGHT_AFTER_RE = /\s*(?:[-–]?\s*[0-9A-Z]{4}\s*)?(?:WIZ|W[A-Z]{2,7}\s+O[FP]\b)/y;
const SET_LANG_RE = /(?<![A-Z0-9])([A-Z0-9]{3,5})(?:[^A-Z0-9\n]{1,5}(EN|DE)|(EN|DE)(?![A-Z])|(EN|DE)(?=[A-Z]))/g;
const LANG_RE = /(?<![A-Z])(EN|DE)(?![A-Z])/;
const SET_LETTER_DIGITS_RE = /^[A-Z][0-9OIL]{2}$/;
const RARITY_LETTERS = 'CURMSLT';
const matchAt = (re, s, pos) => { re.lastIndex = pos; return re.exec(s); };

function fixToken(token) {
  const digits = (token.match(/[0-9]/g) || []).length;
  if (digits === 0 || digits * 2 < token.length) return token;
  const g = GLUED_RARITY_RE.exec(token);
  if (g && (g[1] || g[3])) return (g[1] || '') + fixDigits(g[2]) + (g[3] || '');
  return fixDigits(token);
}
function fixSetCode(code) {
  if (SET_LETTER_DIGITS_RE.test(code) && /[0-9]/.test(code)) return code[0] + fixDigits(code.slice(1));
  return code;
}
function setCodeVariants(code) {
  const variants = [code];
  let fixed = fixSetCode(code);
  if (fixed !== code) variants.push(fixed);
  if (code.length >= 4 && RARITY_LETTERS.includes(code[0])) {
    const stripped = code.slice(1);
    variants.push(stripped);
    fixed = fixSetCode(stripped);
    if (fixed !== stripped) variants.push(fixed);
  }
  const out = [];
  for (const v of variants.map(x => x.toLowerCase())) if (!out.includes(v)) out.push(v);
  return out;
}

export function parseCollectorText(text, knownSets = null) {
  const none = { collector_number: null, set_code: null, lang: null, rarity: null };
  if (!text || !text.trim()) return none;
  const known = knownSets ? new Set([...knownSets].map(s => String(s).toLowerCase())) : null;
  let t = text.toUpperCase().replace(PIPE_SLASH_RE, (m, a, b) => `${a}/${b}`);
  t = t.replace(EURO_SIX_RE, (m, a) => a + '6').replace(TOKEN_RE, m => fixToken(m));
  let cn = null, rarity = null, before = '', after = '';
  const m = CN_SLASH_RE.exec(t);
  if (m) {
    cn = m[1]; before = t.slice(0, m.index); after = t.slice(m.index + m[0].length);
  } else {
    const tokens = [...t.matchAll(CN_LONE_RE)].filter(mt => !(mt[2].length === 4 && matchAt(COPYRIGHT_AFTER_RE, t, mt.index + mt[0].length)));
    let pick = null;
    for (const mt of tokens) {   // a number next to (or glued to) a rarity letter wins
      const end = mt.index + mt[0].length;
      if (mt[1] || mt[3] || matchAt(RARITY_RE, t, end) || RARITY_BEFORE_RE.test(t.slice(0, mt.index))) { pick = mt; break; }
    }
    if (!pick) for (const mt of tokens) if (!YEAR_RE.test(mt[2])) { pick = mt; break; }   // first that is not year-like
    if (pick) {
      cn = pick[2]; rarity = pick[1] || pick[3] || null;
      before = t.slice(0, pick.index); after = t.slice(pick.index + pick[0].length);
    }
  }
  if (cn !== null) {
    cn = cn.replace(/^0+/, '') || '0';
    const rm = matchAt(RARITY_RE, after, 0) || RARITY_BEFORE_RE.exec(before);
    if (rm && rarity === null) rarity = rm[1];
  }
  let setCode = null, lang = null;
  for (const sm of t.matchAll(SET_LANG_RE)) {
    const code = sm[1];
    if (!/[A-Z]/.test(code)) continue;
    const glued = sm[4] !== undefined;
    if (glued && known === null) continue;
    if (known !== null) {
      const v = setCodeVariants(code).filter(x => known.has(x));
      if (!v.length) continue;
      setCode = v[0];
    } else setCode = fixSetCode(code).toLowerCase();
    lang = (sm[2] || sm[3] || sm[4]).toLowerCase();
    break;
  }
  if (lang === null) { const lm = LANG_RE.exec(t); if (lm) lang = lm[1].toLowerCase(); }
  return { collector_number: cn, set_code: setCode, lang, rarity };
}

function hasCollectorInfo(text) {
  const p = parseCollectorText(text);
  return !!(p.set_code || p.collector_number);
}

// internals for the parity harness (web/dev)
export const _test = { lineCrop, recognizeMats, preprocess, cropBox, readLines, recognizeLine };
