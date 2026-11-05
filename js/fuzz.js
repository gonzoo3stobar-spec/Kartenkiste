// rapidfuzz scorers in plain JS (no DOM, no opencv): ratio, partial_ratio, token_*_ratio,
// WRatio and Levenshtein.distance, ported from rapidfuzz 3.x (fuzz_py.py / Indel_py.py) and
// checked against the C++ build on thousands of pairs (tools/fuzz_parity.mjs + tools/ref_fuzz.py).
// Inputs are ASCII strings (the matcher only ever scores normalize_name() output).

// ---- LCS length (bit-parallel, Hyyro), pattern = one string, text = a slice of another ----
const MAXW = 8;                                  // patterns up to 256 characters use the fast path
const PM = new Uint32Array(256 * MAXW);          // PM[c*words + w]
const S = new Uint32Array(MAXW);
let pmChars = [];
let pmWords = 0, pmLen = 0, pmStr = null;

function buildBlock(p) {
  if (pmStr === p) return;
  for (const c of pmChars) for (let w = 0; w < MAXW; w++) PM[c * MAXW + w] = 0;
  pmChars = [];
  pmLen = p.length;
  pmWords = Math.ceil(p.length / 32);
  pmStr = p;
  for (let i = 0; i < p.length; i++) {
    const c = p.charCodeAt(i) & 255;
    PM[c * MAXW + (i >>> 5)] |= 1 << (i & 31);
    pmChars.push(c);
  }
}

// LCS length between the current block pattern and text[from, to)
function lcsBlock(text, from, to) {
  const W = pmWords, n = pmLen;
  if (W === 0 || to <= from) return 0;
  if (W === 1) {
    let s = 0xFFFFFFFF;
    for (let i = from; i < to; i++) {
      const u = (s & PM[(text.charCodeAt(i) & 255) * MAXW]) >>> 0;
      s = ((s + u) | (s & ~u)) >>> 0;
    }
    // zero bits among the lowest n bits
    const mask = n === 32 ? 0xFFFFFFFF : ((1 << n) - 1) >>> 0;
    return popcnt((~s) & mask);
  }
  for (let w = 0; w < W; w++) S[w] = 0xFFFFFFFF;
  for (let i = from; i < to; i++) {
    const base = (text.charCodeAt(i) & 255) * MAXW;
    let carry = 0;
    for (let w = 0; w < W; w++) {
      const sw = S[w];
      const u = (sw & PM[base + w]) >>> 0;
      const sum = sw + u + carry;
      carry = sum > 0xFFFFFFFF ? 1 : 0;
      S[w] = ((sum >>> 0) | (sw & ~u)) >>> 0;
    }
  }
  let zeros = 0;
  for (let w = 0; w < W; w++) {
    const bits = w === W - 1 && (n & 31) ? (n & 31) : 32;
    const mask = bits === 32 ? 0xFFFFFFFF : ((1 << bits) - 1) >>> 0;
    zeros += popcnt((~S[w]) & mask);
  }
  return zeros;
}

function popcnt(v) {
  v = v >>> 0;
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24;
}

// plain DP fallback for patterns beyond the block width
const dpRow = new Uint16Array(4096);
function lcsDp(a, b) {
  if (b.length + 1 > dpRow.length) b = b.slice(0, dpRow.length - 1);
  dpRow.fill(0, 0, b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const tmp = dpRow[j];
      dpRow[j] = ca === b.charCodeAt(j - 1) ? prev + 1 : (dpRow[j] > dpRow[j - 1] ? dpRow[j] : dpRow[j - 1]);
      prev = tmp;
    }
  }
  return dpRow[b.length];
}

/** ratio(p, t) with `p` forced as the bit-parallel pattern (reused across many texts; p up to 256 chars). */
export function ratioPattern(p, t) {
  const sum = p.length + t.length;
  if (!sum) return 100;
  if (!p.length || !t.length) return 0;
  if (p.length > MAXW * 32) return ratio(p, t);
  buildBlock(p);
  const l = lcsBlock(t, 0, t.length);
  return (1 - (sum - 2 * l) / sum) * 100;
}

export function lcs(a, b) {
  if (!a.length || !b.length) return 0;
  const [p, t] = a.length <= b.length ? [a, b] : [b, a];
  if (p.length > MAXW * 32) return lcsDp(p, t);
  buildBlock(p);
  return lcsBlock(t, 0, t.length);
}

// ---- Indel based scorers ----
/** fuzz.ratio: (1 - indel/(la+lb)) * 100 */
export function ratio(a, b) {
  const sum = a.length + b.length;
  if (!sum) return 100;
  const dist = sum - 2 * lcs(a, b);
  return (1 - dist / sum) * 100;
}

function normDistance(dist, lensum) { return lensum ? 100 - 100 * dist / lensum : 100; }

// ratio of the pattern block (already built for `needle`) against text[from, to)
function blockRatio(needleLen, text, from, to) {
  const sum = needleLen + (to - from);
  if (!sum) return 1;
  const dist = sum - 2 * lcsBlock(text, from, to);
  return 1 - dist / sum;      // 0..1
}

/** fuzz.partial_ratio, exact search over every alignment of the shorter string. */
export function partialRatio(s1, s2) {
  if (!s1.length && !s2.length) return 100;
  const len1 = s1.length, len2 = s2.length;
  const [shorter, longer] = len1 <= len2 ? [s1, s2] : [s2, s1];
  let res = partialImpl(shorter, longer);
  if (res !== 100 && len1 === len2) {
    const res2 = partialImpl(longer, shorter);
    if (res2 > res) res = res2;
  }
  return res;
}

function partialImpl(s1, s2) {          // len(s1) <= len(s2)
  const len1 = s1.length, len2 = s2.length;
  if (len1 === 0) return 0;
  if (len1 > MAXW * 32) return partialImplSlow(s1, s2);
  buildBlock(s1);
  let best = 0;
  const has = new Uint8Array(256);
  for (let i = 0; i < len1; i++) has[s1.charCodeAt(i) & 255] = 1;
  for (let i = 1; i < len1; i++) {
    if (!has[s2.charCodeAt(i - 1) & 255]) continue;
    const r = blockRatio(len1, s2, 0, i);
    if (r > best) { best = r; if (best === 1) return 100; }
  }
  for (let i = 0; i < len2 - len1; i++) {
    if (!has[s2.charCodeAt(i + len1 - 1) & 255]) continue;
    const r = blockRatio(len1, s2, i, i + len1);
    if (r > best) { best = r; if (best === 1) return 100; }
  }
  for (let i = len2 - len1; i < len2; i++) {
    if (!has[s2.charCodeAt(i) & 255]) continue;
    const r = blockRatio(len1, s2, i, len2);
    if (r > best) { best = r; if (best === 1) return 100; }
  }
  return best * 100;
}

function partialImplSlow(s1, s2) {
  let best = 0;
  const len1 = s1.length, len2 = s2.length;
  const sim = (a, b) => { const sum = a.length + b.length; return sum ? 1 - (sum - 2 * lcsDp(a, b)) / sum : 1; };
  for (let i = 1; i < len1; i++) best = Math.max(best, sim(s1, s2.slice(0, i)));
  for (let i = 0; i < len2 - len1; i++) best = Math.max(best, sim(s1, s2.slice(i, i + len1)));
  for (let i = len2 - len1; i < len2; i++) best = Math.max(best, sim(s1, s2.slice(i)));
  return best >= 1 ? 100 : best * 100;
}

// ---- token scorers ----
const splitWs = s => s.split(/\s+/).filter(Boolean);       // str.split() on ASCII text
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function tokenSortRatio(s1, s2) {
  return ratio(splitWs(s1).sort(cmp).join(' '), splitWs(s2).sort(cmp).join(' '));
}

export function tokenSetRatio(s1, s2) {
  const ta = new Set(splitWs(s1)), tb = new Set(splitWs(s2));
  if (!ta.size || !tb.size) return 0;
  const inter = [...ta].filter(t => tb.has(t));
  const dab = [...ta].filter(t => !tb.has(t)).sort(cmp);
  const dba = [...tb].filter(t => !ta.has(t)).sort(cmp);
  if (inter.length && (!dab.length || !dba.length)) return 100;
  const jab = dab.join(' '), jba = dba.join(' ');
  const abLen = jab.length, baLen = jba.length;
  const sectLen = inter.join(' ').length;
  const sectAbLen = sectLen + (sectLen !== 0 ? 1 : 0) + abLen;
  const sectBaLen = sectLen + (sectLen !== 0 ? 1 : 0) + baLen;
  const dist = jab.length + jba.length - 2 * lcs(jab, jba);
  const result = normDistance(dist, sectAbLen + sectBaLen);
  if (!sectLen) return result;
  const abDist = (sectLen !== 0 ? 1 : 0) + abLen;
  const abRatio = normDistance(abDist, sectLen + sectAbLen);
  const baDist = (sectLen !== 0 ? 1 : 0) + baLen;
  const baRatio = normDistance(baDist, sectLen + sectBaLen);
  return Math.max(result, abRatio, baRatio);
}

export function tokenRatio(s1, s2) {
  return Math.max(tokenSetRatio(s1, s2), tokenSortRatio(s1, s2));
}

export function partialTokenRatio(s1, s2) {
  const sa = splitWs(s1), sb = splitWs(s2);
  const ta = new Set(sa), tb = new Set(sb);
  for (const t of ta) if (tb.has(t)) return 100;
  const dab = [...ta].sort(cmp), dba = [...tb].sort(cmp);     // no common token: the diffs are the sets
  const result = partialRatio([...sa].sort(cmp).join(' '), [...sb].sort(cmp).join(' '));
  if (sa.length === ta.size && sb.length === tb.size) return result;
  return Math.max(result, partialRatio(dab.join(' '), dba.join(' ')));
}

/** fuzz.WRatio */
export function wratio(s1, s2) {
  const UNBASE = 0.95;
  if (!s1.length || !s2.length) return 0;
  const l1 = s1.length, l2 = s2.length;
  const lenRatio = l1 > l2 ? l1 / l2 : l2 / l1;
  let end = ratio(s1, s2);
  if (lenRatio < 1.5) return Math.max(end, tokenRatio(s1, s2) * UNBASE);
  const PARTIAL = lenRatio <= 8.0 ? 0.9 : 0.6;
  end = Math.max(end, partialRatio(s1, s2) * PARTIAL);
  return Math.max(end, partialTokenRatio(s1, s2) * UNBASE * PARTIAL);
}

/** rapidfuzz.distance.Levenshtein.distance (unit costs) */
export function levenshtein(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}
