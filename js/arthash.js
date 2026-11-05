// 64-bit perceptual hashes, bit-identical in intent to server/recognize/arthash.py:
// phash: gray -> 32x32 INTER_AREA -> orthonormal DCT-II (as cv2.dct) -> top-left 8x8,
// bit = coef > median of the 63 AC coefficients, DC bit always 0; dhash: 9x8, left > right.
// Bits row-major, MSB first; a hash is kept as two uint32 (hi, lo).

import { ART_CROPS, cropBox } from './detect.js';

const N = 32;
const COS = (() => {  // COS[k*N+n] = c(k) * cos(pi*(2n+1)k/2N) for k < 8
  const t = new Float64Array(8 * N);
  for (let k = 0; k < 8; k++) {
    const c = k === 0 ? Math.sqrt(1 / N) : Math.sqrt(2 / N);
    for (let n = 0; n < N; n++) t[k * N + n] = c * Math.cos(Math.PI * (2 * n + 1) * k / (2 * N));
  }
  return t;
})();

function bitsToPair(bits) {
  let hi = 0, lo = 0;
  for (let i = 0; i < 32; i++) hi = (hi << 1) | bits[i];
  for (let i = 32; i < 64; i++) lo = (lo << 1) | bits[i];
  return [hi >>> 0, lo >>> 0];
}

function grayOf(cv, m) {
  const g = new cv.Mat();
  cv.cvtColor(m, g, cv.COLOR_RGBA2GRAY);
  return g;
}

export function phash(cv, gray) {
  const s = new cv.Mat();
  cv.resize(gray, s, new cv.Size(N, N), 0, 0, cv.INTER_AREA);
  const x = s.data;
  // rows first: R[y][k] for k<8, then columns: D[k1][k2]
  const R = new Float64Array(N * 8);
  for (let y = 0; y < N; y++) for (let k = 0; k < 8; k++) {
    let a = 0; for (let n = 0; n < N; n++) a += x[y * N + n] * COS[k * N + n];
    R[y * 8 + k] = a;
  }
  s.delete();
  const D = new Float64Array(64);
  for (let k1 = 0; k1 < 8; k1++) for (let k2 = 0; k2 < 8; k2++) {
    let a = 0; for (let y = 0; y < N; y++) a += R[y * 8 + k2] * COS[k1 * N + y];
    D[k1 * 8 + k2] = Math.fround(a);
  }
  const med = Array.from(D.subarray(1)).sort((a, b) => a - b)[31];  // median of 63 AC values
  const bits = new Uint8Array(64);
  for (let i = 1; i < 64; i++) bits[i] = D[i] > med ? 1 : 0;
  return bitsToPair(bits);
}

export function dhash(cv, gray) {
  const s = new cv.Mat();
  cv.resize(gray, s, new cv.Size(9, 8), 0, 0, cv.INTER_AREA);
  const bits = new Uint8Array(64);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits[y * 8 + x] = s.data[y * 9 + x] > s.data[y * 9 + x + 1] ? 1 : 0;
  s.delete();
  return bitsToPair(bits);
}

function pop32(v) { v = v - ((v >>> 1) & 0x55555555); v = (v & 0x33333333) + ((v >>> 2) & 0x33333333); return (((v + (v >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24; }

export const ART_QUERY_LIMIT = 200;
const SHORTLIST = 64;   // arthash.ArtIndex._SHORTLIST

// art.bin rows are sorted by illustration id (tools/build_pack.py), so the row index breaks distance ties
// like Python's illustration-id order. art.json maps a row to its card index in prints.json.
export class ArtIndex {
  constructor(buf, cardIdx) { this.h = new Uint32Array(buf); this.card = cardIdx; this.n = cardIdx.length; this.dist = new Uint8Array(this.n); }
  get length() { return this.n; }
  // Port of ArtIndex.query: best matches over all crops sorted by (distance, dhash_distance, row), one hit per
  // illustration (row), at most `limit`. crops: {name: [x0,y0,x1,y1]} boxes of the 1000x1400 warp (default ART_CROPS).
  // warped: cv.Mat RGBA -> [{idx (art row), card (card index), distance, dhash_distance, crop}]
  query(cv, warped, limit = ART_QUERY_LIMIT, crops = ART_CROPS) {
    const n = this.n, h = this.h, dist = this.dist;
    if (!n || limit <= 0) return [];
    const best = new Map();
    const shortlist = Math.min(n, Math.max(limit, SHORTLIST));
    for (const [name, box] of Object.entries(crops)) {
      const roi = cropBox(cv, warped, box), g = grayOf(cv, roi);
      roi.delete();
      if (g.rows < 2 || g.cols < 2) { g.delete(); continue; }
      const [ph, pl] = phash(cv, g), [dh, dl] = dhash(cv, g);
      g.delete();
      const hist = new Int32Array(65);
      for (let i = 0; i < n; i++) { const o = 4 * i; const d = pop32(h[o] ^ ph) + pop32(h[o + 1] ^ pl); dist[i] = d; hist[d]++; }
      // every row up to the shortlist-th smallest distance, ties included
      let kth = 0, acc = 0;
      for (; kth < 65; kth++) { acc += hist[kth]; if (acc >= shortlist) break; }
      const rows = [];
      for (let i = 0; i < n; i++) {
        if (dist[i] > kth) continue;
        const o = 4 * i;
        rows.push({ idx: i, distance: dist[i], dhash_distance: pop32(h[o + 2] ^ dh) + pop32(h[o + 3] ^ dl) });
      }
      rows.sort((a, b) => a.distance - b.distance || a.dhash_distance - b.dhash_distance || a.idx - b.idx);
      for (const r of rows.slice(0, shortlist)) {
        const prev = best.get(r.idx);
        if (!prev || r.distance < prev.distance || (r.distance === prev.distance && r.dhash_distance < prev.dhash_distance)) best.set(r.idx, { ...r, card: this.card[r.idx], crop: name });
      }
    }
    return [...best.values()].sort((a, b) => a.distance - b.distance || a.dhash_distance - b.dhash_distance || a.idx - b.idx).slice(0, limit);
  }
}
