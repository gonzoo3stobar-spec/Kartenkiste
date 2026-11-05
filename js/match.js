// Card matching: a 1:1 port of server/recognize/match.py (name index, collector line, fuzzy line,
// basic land banner, illus cue, resolve_candidates) and of the decision parts of pipeline.py
// (compute_confidence, strong/credible art, art hit merging, retry rules, frame cue ...).
// Constants and rules are the Python ones, not re-tuned. No opencv, no DOM: runs in Node.
//
// SQL is replaced by lookups in the offline pack (tools/build_pack.py, format v2):
//   const names = new NameIndex(namesJson, setsJson);    // fuzzy name search (rapidfuzz semantics, fuzz.js)
//   const db    = new CardDb(printsJson);                 // card table: printings per card / set+cn / art rows
//   db.useArt(artJson);                                   // art row -> card index (art.json)
//   const cands = resolveCandidates(db, names, { title, hits?, bottom, bottomText, artHits, ... });
//   const conf  = computeConfidence(cands);
// Parity against the Python code: tools/ref_match.py + tools/match_parity.mjs.

import {
  ratio as fzRatio, ratioPattern, wratio, partialRatio, tokenSetRatio, levenshtein,
  tokenSortRatio as tokenSortRatio2, partialTokenRatio,
} from './fuzz.js';

export const ratio = fzRatio;
export { partialRatio, tokenSetRatio, levenshtein, wratio };

// ---------------------------------------------------------------------------
// constants (match.py)
// ---------------------------------------------------------------------------
export const MAX_CANDIDATES = 8;
export const MIN_NAME_SCORE = 40.0;
export const TITLE_CONFIRM_SCORE = 80.0;
export const GUESS_PENALTY = 10.0;
export const SET_CN_SCORE = 95.0;
export const SET_CN_TITLE_SCORE = 99.0;
export const SET_CN_CONTRADICTED_SCORE = 70.0;
export const TITLE_CONTRADICT_MIN_LETTERS = 6;
export const TITLE_CONTRADICT_SCORE = 50.0;
export const TITLE_CONTRADICT_MIN_NAME_SCORE = 75.0;
export const TITLE_FRAGMENT_PARTIAL = 85.0;
export const LANG_TIE_MARGIN = 1.0;
export const SHORT_QUERY_LETTERS = 4;
export const SHORT_QUERY_MIN_SCORE = 95.0;
export const MAX_PRINTINGS_PER_ORACLE = 3;
export const TINY_QUERY_CHARS = 3;
export const LONG_QUERY_SLACK = 8;
export const ART_STRONG = 10;
export const ART_WEAK = 16;
export const ART_DHASH_MAX = 14;
export const ART_TITLE_SCORE = 98.0;
export const ART_ONLY_SCORE = 92.0;
export const ART_WEAK_TITLE_SCORE = 93.0;
export const ART_SET_CN_SCORE = 100.0;
export const SAME_ART_PENALTY = 3.0;
export const SOFT_NUMBER_MAX_POOL = 3;
export const WEAK_ART_MAX_ILLUSTRATIONS = 3;
export const ART_REASON = 'art match';
export const TITLE_AGREES_REASON = 'title agrees';
export const SAME_ART_REASON = 'same art in';
export const PRINTING_OPEN_REASON = 'printing open';
export const COLLECTOR_PICKS_REASON = 'collector line fits this printing';
export const PROXY_REASON = 'art matches no printing (proxy or unknown print?)';
export const PROXY_MIN_SHARPNESS = 15.0;
export const PROXY_ART_FAR = 22;
export const BACK_FACE_LAYOUTS = ['transform', 'modal_dfc', 'reversible_card'];
export const NON_CARD_LAYOUTS = ['token', 'double_faced_token', 'emblem', 'art_series'];

export const FUZZY_REASON = 'collector line fits (fuzzy)';
export const FUZZY_LEANS_REASON = 'collector line leans to (fuzzy)';
const FUZZY_LOOKALIKE_COST = 0.5;
const FUZZY_FIT = 1.0;
const FUZZY_MARGIN = 1.0;
const FUZZY_SUFFIX_COST = 1.0;
const FUZZY_PART_CAP = 3.0;
const FUZZY_MAX_ORACLES = 3;
const FUZZY_NEAR_TOP = 15.0;

export const BANNER_REASON = 'land name from the banner';
export const BASIC_LAND_NAMES = {
  plains: ['Plains', 'en'], island: ['Island', 'en'], swamp: ['Swamp', 'en'],
  mountain: ['Mountain', 'en'], forest: ['Forest', 'en'], wastes: ['Wastes', 'en'],
  ebene: ['Plains', 'de'], insel: ['Island', 'de'], sumpf: ['Swamp', 'de'],
  gebirge: ['Mountain', 'de'], wald: ['Forest', 'de'], odnis: ['Wastes', 'de'],
};
const BASIC_LAND_CUES = ['basic land', 'standardland'];
const BANNER_NAME_SCORE = 80.0;
const BANNER_CUE_SCORE = 85.0;
const BANNER_CUE_MAX_WORDS = 4;
const BANNER_NAME_SLACK = 2;
export const OLD_FRAMES = ['1993', '1997'];
export const FRAME_REASON = 'old frame (Illus. line)';
const ILLUS_SCORE = 75.0;
const ILLUS_RE = /^[il1m]{1,3}us$/;

// pipeline.py
export const RETRY_MIN_CONF = 0.4;
export const RETRY_MIN_LETTERS = 3;
export const RETRY_MIN_NAME_SCORE = 80.0;
export const ART_OVERRULE_TITLE_SCORE = 90.0;
export const ART_QUERY_LIMIT = 200;
export const HIGH_MIN_SCORE = 90.0;
export const HIGH_MIN_GAP = 15.0;
export const MEDIUM_MIN_SCORE = 70.0;
export const CONFIRMED_MIN_SCORE = SET_CN_TITLE_SCORE;
export const GUIDE_REASON = 'card border not found';
const COLLECTOR_EVIDENCE_PREFIXES = ['printing evidence', 'set+cn exact'];
const ART_EVIDENCE = ART_REASON + ' d=';

// ---------------------------------------------------------------------------
// small Python-compatible helpers
// ---------------------------------------------------------------------------
/** Python round(x, 1): correctly rounded decimal, exact halves to even. */
export function pyRound1(x) {
  if (!Number.isFinite(x)) return x;
  const t = x * 10;
  if (Number.isInteger(x * 4) && !Number.isInteger(x * 2)) {   // x = n + .25 / .75 exactly: a tie at one decimal
    const lo = Math.floor(t);
    return (lo % 2 === 0 ? lo : lo + 1) / 10;
  }
  return Number(x.toFixed(1));
}
/** Python f"{x:.0f}" (exact halves to even). */
export function fmt0(x) {
  if (Math.abs(x % 1) === 0.5) { const lo = Math.floor(x); return String(lo % 2 === 0 ? lo : lo + 1); }
  return x.toFixed(0);
}
/** Python repr() of a str. */
export function pyRepr(s) {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = '';
  for (const ch of s) {
    if (ch === '\\') out += '\\\\';
    else if (ch === q) out += '\\' + q;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch.codePointAt(0) < 32 || ch.codePointAt(0) === 127) out += '\\x' + ch.codePointAt(0).toString(16).padStart(2, '0');
    else out += ch;
  }
  return q + out + q;
}
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** lexicographic comparison of key arrays (numbers / strings) like Python tuples */
function cmpKey(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}
const startsWithAny = (s, prefixes) => prefixes.some(p => s.startsWith(p));
const isAlphaCh = ch => /[A-Za-z]/.test(ch);
const countAlpha = s => { let n = 0; for (let i = 0; i < s.length; i++) if (isAlphaCh(s[i])) n++; return n; };
const isDigitStr = s => /^[0-9]+$/.test(s);

// ---------------------------------------------------------------------------
// normalize.py
// ---------------------------------------------------------------------------
export function normalizeName(s) {
  if (s == null) return '';
  let t = String(s).toLowerCase().normalize('NFKD').replace(/\p{Mn}/gu, '');
  t = t.replace(/ß/g, 'ss').replace(/æ/g, 'ae').replace(/œ/g, 'oe');
  return t.replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
const normMemo = new Map();
function norm(s) {
  let v = normMemo.get(s);
  if (v === undefined) { v = normalizeName(s); if (normMemo.size > 200000) normMemo.clear(); normMemo.set(s, v); }
  return v;
}

// ---------------------------------------------------------------------------
// name score / name index
// ---------------------------------------------------------------------------
function wordRunRatio(choice, query) {
  const words = query.split(/\s+/).filter(Boolean);
  const longest = 2 * choice.length + LONG_QUERY_SLACK;
  let best = 0.0;
  for (let i = 0; i < words.length; i++) {
    let run = words[i];
    best = Math.max(best, fzRatio(choice, run));
    for (let j = i + 1; j < words.length; j++) {
      run = `${run} ${words[j]}`;
      if (run.length > longest) break;
      best = Math.max(best, fzRatio(choice, run));
    }
  }
  return best;
}

/** Similarity (0-100) between a normalized OCR title and a normalized name (match.name_score). */
export function nameScore(query, choice) {
  let score = fzRatio(query, choice);
  if (query.length > choice.length) {
    let contained = wordRunRatio(choice, query) * 0.95;
    const allowed = choice.length + LONG_QUERY_SLACK;
    if (query.length > allowed) contained *= allowed / query.length;
    score = Math.max(score, contained);
  }
  return score;
}
export const name_score = nameScore;

const splitWs = s => s.split(/\s+/).filter(Boolean);
const hex2uuid = h => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;

class TopList {
  // the `limit` best (score desc, index asc) entries with score >= 1 (process.extract score_cutoff=1)
  constructor(limit) { this.limit = limit; this.s = []; this.i = []; this.worst = -1; }
  get full() { return this.s.length >= this.limit; }
  get threshold() { return this.s[this.worst]; }
  add(score, idx) {
    if (score < 1) return;
    if (!this.full) { this.s.push(score); this.i.push(idx); if (this.full) this._findWorst(); return; }
    if (score > this.s[this.worst]) { this.s[this.worst] = score; this.i[this.worst] = idx; this._findWorst(); }
  }
  _findWorst() {
    let w = 0;
    for (let k = 1; k < this.s.length; k++) {
      if (this.s[k] < this.s[w] || (this.s[k] === this.s[w] && this.i[k] > this.i[w])) w = k;
    }
    this.worst = w;
  }
  sorted() {
    const order = this.s.map((_, k) => k).sort((a, b) => this.s[b] - this.s[a] || this.i[a] - this.i[b]);
    return order.map(k => this.i[k]);
  }
}

export class NameIndex {
  /** @param pack names.json (v2), @param setCodes sets.json (known set codes, lowercase) */
  constructor(pack, setCodes = null) {
    this.norms = pack.norm;
    this.display = pack.disp;
    this.langs = pack.langs;
    this.langIdx = pack.lang;
    this.oi = Int32Array.from(pack.oi);
    this.oraclesHex = pack.oracles;
    this.set_codes = new Set((setCodes || []).map(s => String(s).toLowerCase()));
    this.tiny = [];
    for (let i = 0; i < this.norms.length; i++) if (this.norms[i].length <= TINY_QUERY_CHARS) this.tiny.push(i);
    this._prep = null;
  }
  get length() { return this.norms.length; }
  oracleId(oi) { return oi >= 0 ? hex2uuid(this.oraclesHex.slice(oi * 32, oi * 32 + 32)) : ''; }

  _prepare() {
    const n = this.norms.length;
    const tok = new Array(n), dup = new Uint8Array(n), uniq = new Uint16Array(n);
    for (let i = 0; i < n; i++) {
      const t = splitWs(this.norms[i]);
      const set = new Set(t);
      tok[i] = t;
      dup[i] = set.size !== t.length ? 1 : 0;
      uniq[i] = [...set].join(' ').length;
    }
    this._prep = { tok, dup, uniq };
  }

  /** Candidate indices like process.extract(WRatio, limit) union process.extract(ratio, limit); insertion ordered. */
  _retrieve(q, rawLimit, brute) {
    const norms = this.norms, n = norms.length;
    const lq = q.length;
    const wTop = new TopList(rawLimit), rTop = new TopList(rawLimit);
    if (brute) {
      for (let i = 0; i < n; i++) {
        const c = norms[i];
        wTop.add(wratio(q, c), i);
        rTop.add(fzRatio(q, c), i);
      }
    } else {
      if (!this._prep) this._prepare();
      const { tok, dup, uniq } = this._prep;
      const qTok = splitWs(q), qSet = new Set(qTok);
      const qDup = qSet.size !== qTok.length;
      const qUniq = [...qSet].join(' ').length;
      const qCount = new Uint8Array(128);
      for (let k = 0; k < lq; k++) qCount[q.charCodeAt(k) & 127]++;
      const qChars = [...new Set(q)].map(ch => ch.charCodeAt(0) & 127);
      const cCount = new Uint8Array(128);
      for (let i = 0; i < n; i++) {
        const c = norms[i], ln = c.length;
        if (!ln) continue;
        const sum = lq + ln, mn = Math.min(lq, ln);
        const ubr = (1 - (sum - 2 * mn) / sum) * 100;
        const needR = !(rTop.full && ubr <= rTop.threshold);
        // upper bound of WRatio
        const lenRatio = lq > ln ? lq / ln : ln / lq;
        const nt = tok[i];
        let share = false;
        for (let k = 0; k < nt.length; k++) if (qSet.has(nt[k])) { share = true; break; }
        let ubw;
        if (lenRatio < 1.5) {
          let ubTok = 100;
          if (!share) {
            const ua = qUniq, ub = uniq[i];
            ubTok = Math.max(ubr, ua + ub ? 100 - 100 * Math.abs(ua - ub) / (ua + ub) : 100);
          }
          ubw = Math.max(ubr, 0.95 * ubTok);
        } else {
          const ps = lenRatio <= 8.0 ? 0.9 : 0.6;
          for (let k = 0; k < ln; k++) cCount[c.charCodeAt(k) & 127]++;
          let inter = 0;
          for (const ch of qChars) inter += Math.min(qCount[ch], cCount[ch]);
          for (let k = 0; k < ln; k++) cCount[c.charCodeAt(k) & 127] = 0;
          const ubp = inter === 0 ? 0 : (200 * inter / (mn + inter)) * (1 + 1e-9);
          const ubptok = share || qDup || dup[i] ? 100 : ubp;
          ubw = Math.max(ubr, ps * ubp, 0.95 * ps * ubptok);
        }
        const needW = !(wTop.full && ubw <= wTop.threshold) && ubw >= 1;
        if (!needW && !needR) continue;
        const r = ratioPattern(q, c);
        if (needR) rTop.add(r, i);
        if (needW) {
          let w;
          if (lenRatio < 1.5) w = Math.max(r, tokenRatio2(q, c) * 0.95);
          else w = wratioFromRatio(q, c, r, lenRatio);
          wTop.add(w, i);
        }
      }
    }
    const out = new Map();
    for (const i of wTop.sorted()) out.set(i, norms[i]);
    for (const i of rTop.sorted()) out.set(i, norms[i]);
    return out;
  }

  /** Python NameIndex.search: [{oracle_id, oi, display, lang, score}], best first, one per oracle. */
  search(text, limit = 5, { brute = false } = {}) {
    const query = normalizeName(text);
    if (!query || !this.norms.length || limit <= 0) return [];
    const short = countAlpha(query) < SHORT_QUERY_LETTERS;
    const rawLimit = Math.max(limit * 10, 50);
    let candidates;
    if (query.length <= TINY_QUERY_CHARS) {
      candidates = new Map(this.tiny.map(i => [i, this.norms[i]]));
    } else {
      candidates = this._retrieve(query, rawLimit, brute);
    }
    const best = new Map();
    for (const [idx, choice] of candidates) {
      const score = nameScore(query, choice);
      if (short && score < SHORT_QUERY_MIN_SCORE) continue;
      const oi = this.oi[idx];
      const prev = best.get(oi);
      if (prev === undefined || score > prev[0]) best.set(oi, [score, idx]);
    }
    const ordered = [...best.entries()].sort((a, b) => (b[1][0] - a[1][0]) || cmpStr(this.display[a[1][1]], this.display[b[1][1]]));
    return ordered.slice(0, limit).map(([oi, [score, idx]]) => ({
      oracle_id: this.oracleId(oi), oi, display: this.display[idx], lang: this.langs[this.langIdx[idx]], score: pyRound1(score),
    }));
  }
}

// token_ratio / WRatio pieces with a known ratio (identical results to fuzz.js wratio, avoids a second LCS)

function tokenRatio2(a, b) { return Math.max(tokenSetRatio(a, b), tokenSortRatio2(a, b)); }
function wratioFromRatio(a, b, r, lenRatio) {
  const UNBASE = 0.95;
  const PARTIAL = lenRatio <= 8.0 ? 0.9 : 0.6;
  const end = Math.max(r, partialRatio(a, b) * PARTIAL);
  return Math.max(end, partialTokenRatio(a, b) * UNBASE * PARTIAL);
}

// ---------------------------------------------------------------------------
// collector line (parse_bottom)
// ---------------------------------------------------------------------------
const DIGIT_FIX = { O: '0', I: '1', L: '1', '|': '1', S: '5', Z: '2', B: '8' };
const fixDigits = s => s.replace(/[OIL|SZB]/g, c => DIGIT_FIX[c]);
const TOKEN_RE = /[A-Z0-9|]+/g;
const PIPE_SLASH_RE = /(?<![A-Z0-9])([0-9O]{3,4})\s*[|IL]\s*([0-9O]{3,4})(?![A-Z0-9])/g;
const CN_SLASH_RE = /(?<![A-Z0-9])(\d{1,4})\s*[/\\]\s*(\d{1,4})(?![A-Z0-9])/;
const CN_LONE_RE = /(?<![A-Z0-9])([CURMSLT])?(\d{3,4})([CURMSLT])?(?![A-Z0-9])/g;
const GLUED_RARITY_RE = /^([CURMSLT])?([0-9OILSZB|]{3,4})([CURMSLT])?$/;
const RARITY_RE = /\s*[.\-*•·:,]*\s*([CURMSLT])(?![A-Z0-9])/y;
const RARITY_BEFORE_RE = /(?<![A-Z0-9])([CURMSLT])[\s.\-*•·:,]*$/;
const YEAR_RE = /^(19|20)\d\d$/;
const COPYRIGHT_AFTER_RE = /\s*(?:[-–]?\s*[0-9A-Z]{4}\s*)?(?:WIZ|W[A-Z]{2,7}\s+O[FP]\b)/y;
const EURO_SIX_RE = /(?<![A-Z0-9])(0[0-9OILSZB]{2})€(?![A-Z0-9])/g;
const SET_LANG_RE = /(?<![A-Z0-9])([A-Z0-9]{3,5})(?:[^A-Z0-9\n]{1,5}(EN|DE)|(EN|DE)(?![A-Z])|(EN|DE)(?=[A-Z]))/g;
const LANG_RE = /(?<![A-Z])(EN|DE)(?![A-Z])/;
const SET_LETTER_DIGITS_RE = /^[A-Z][0-9OIL]{2}$/;
const RARITY_LETTERS = 'CURMSLT';

function matchAt(re, s, pos) { re.lastIndex = pos; return re.exec(s); }

function fixToken(token) {
  let digits = 0;
  for (let i = 0; i < token.length; i++) if (token[i] >= '0' && token[i] <= '9') digits++;
  if (digits === 0 || digits * 2 < token.length) return token;
  const glued = GLUED_RARITY_RE.exec(token);
  if (glued && (glued[1] || glued[3])) return (glued[1] || '') + fixDigits(glued[2]) + (glued[3] || '');
  return fixDigits(token);
}

function fixSetCode(code) {
  if (SET_LETTER_DIGITS_RE.test(code) && /[0-9]/.test(code)) return code[0] + fixDigits(code.slice(1));
  return code;
}

export function setCodeVariants(code) {
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
  for (const v of variants) { const l = v.toLowerCase(); if (!out.includes(l)) out.push(l); }
  return out;
}
export const set_code_variants = setCodeVariants;

const stripLeadingZeros = cn => cn.replace(/^0+/, '') || '0';

export function bottomInfo(collector_number = null, set_code = null, lang = null, rarity = null, number_legible = true) {
  return { collector_number, set_code, lang, rarity, number_legible,
    // Phase-0 names
    cn: collector_number, set: set_code };
}

/** Parse the collector line (match.parse_bottom). knownSets: Set/array of lowercase set codes, or null. */
export function parseBottom(text, knownSets = null) {
  if (!text || !text.trim()) return bottomInfo();
  const known = knownSets == null ? null : (knownSets instanceof Set ? knownSets : new Set([...knownSets].map(s => String(s).toLowerCase())));
  let t = text.toUpperCase().replace(PIPE_SLASH_RE, '$1/$2');
  t = t.replace(EURO_SIX_RE, '$16');
  t = t.replace(TOKEN_RE, m => fixToken(m));

  let collector_number = null, rarity = null, before = '', after = '';
  const m = CN_SLASH_RE.exec(t);
  if (m) {
    collector_number = m[1];
    before = t.slice(0, m.index); after = t.slice(m.index + m[0].length);
  } else {
    const tokens = [];
    for (const mt of t.matchAll(CN_LONE_RE)) {
      if (mt[2].length === 4 && matchAt(COPYRIGHT_AFTER_RE, t, mt.index + mt[0].length)) continue;
      tokens.push(mt);
    }
    let pick = null;
    for (const mt of tokens) {
      if (mt[1] || mt[3] || matchAt(RARITY_RE, t, mt.index + mt[0].length) || RARITY_BEFORE_RE.exec(t.slice(0, mt.index))) { pick = mt; break; }
    }
    if (pick === null) for (const mt of tokens) if (!YEAR_RE.test(mt[2])) { pick = mt; break; }
    if (pick !== null) {
      collector_number = pick[2];
      rarity = pick[1] || pick[3] || null;
      before = t.slice(0, pick.index); after = t.slice(pick.index + pick[0].length);
    }
  }
  if (collector_number !== null) {
    collector_number = stripLeadingZeros(collector_number);
    const rm = matchAt(RARITY_RE, after, 0) || RARITY_BEFORE_RE.exec(before);
    if (rm && rarity === null) rarity = rm[1];
  }
  let set_code = null, lang = null;
  for (const sm of t.matchAll(SET_LANG_RE)) {
    const code = sm[1];
    if (!/[A-Z]/.test(code)) continue;
    const gluedIntoWord = sm[4] !== undefined;
    if (gluedIntoWord && known === null) continue;
    if (known !== null) {
      const variants = setCodeVariants(code).filter(v => known.has(v));
      if (!variants.length) continue;
      set_code = variants[0];
    } else {
      set_code = fixSetCode(code).toLowerCase();
    }
    lang = (sm[2] || sm[3] || sm[4]).toLowerCase();
    break;
  }
  if (lang === null) { const lm = LANG_RE.exec(t); if (lm) lang = lm[1].toLowerCase(); }
  return bottomInfo(collector_number, set_code, lang, rarity);
}

// ---------------------------------------------------------------------------
// fuzzy collector line
// ---------------------------------------------------------------------------
const pairSet = list => new Set(list.map(p => [...p].sort().join('')));
const SET_PAIRS = pairSet(['CE', 'CO', 'EO', 'DO', 'D0', 'O0', 'C0', 'E0', 'I1', 'IL', 'L1', 'IT', 'S5', 'B8', 'G6', 'Z2', 'TD',
  'MN', 'MH', 'NH', 'TF', 'TY', 'TP', 'TV', 'FP', 'BO', 'BR', 'BD', 'DP', 'KX', 'KR', 'UV', 'RA']);
const DIGIT_PAIRS = pairSet(['08', '09', '06', '03', '89', '86', '83', '96', '93', '63', '17', '56', '27', '23', '58', '79']);
const NUMBER_FIX = { O: '0', Q: '0', D: '0', I: '1', L: '1', '|': '1', Z: '2', S: '5', B: '8', G: '6' };
const fixNumber = s => s.replace(/[OQDIL|ZSBG]/g, c => NUMBER_FIX[c]);
const FUZZY_TOKEN_RE = /[A-Z0-9|€★]+|\//g;
const SEPARATOR_MISREADS = 'O0E*B8D•+';
const LANG_TOKENS = ['EN', 'DE'];
const PLST_CN_RE = /^([A-Z0-9]{2,5})-(.+)$/;

export function fuzzyLineEmpty(line) { return !line.set_tokens.length && !line.numbers.length; }

function weightedDistance(a, b, pairs) {
  if (a === b) return 0.0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const ca = a[i - 1];
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cb = b[j - 1];
      let sub;
      if (ca === cb) sub = 0.0;
      else if (pairs.has(ca < cb ? ca + cb : cb + ca)) sub = FUZZY_LOOKALIKE_COST;
      else sub = 1.0;
      cur[j] = Math.min(prev[j] + 1.0, cur[j - 1] + 1.0, prev[j - 1] + sub);
    }
    prev = cur;
  }
  return prev[b.length];
}

function langIn(token) {
  const spots = [];
  for (const code of LANG_TOKENS) {
    let i = token.indexOf(code);
    while (i !== -1) { spots.push([i, code.toLowerCase()]); i = token.indexOf(code, i + 1); }
  }
  for (const wanted of [i => i >= 3, i => i === 2, i => i === 0]) {
    const hits = spots.filter(s => wanted(s[0])).sort((a, b) => a[0] - b[0] || cmpStr(a[1], b[1]));
    if (hits.length) return hits[0];
  }
  return null;
}

/** match.fuzzy_collector_line -> {set_tokens, numbers: [[stripped, asRead, suffix]], lang} */
export function fuzzyCollectorLine(text) {
  if (!text || !text.trim()) return { set_tokens: [], numbers: [], lang: null };
  const upper = text.toUpperCase().replace(EURO_SIX_RE, '$16');
  const tokens = upper.match(FUZZY_TOKEN_RE) || [];
  const set_tokens = [], numbers = [];
  let lang = null, afterSlash = false;
  for (let k = 0; k < tokens.length; k++) {
    let token = tokens[k];
    if (token === '/') { afterSlash = true; continue; }
    const total = afterSlash;
    afterSlash = false;
    token = token.replace(/€/g, '');
    if (!token) continue;
    const found = langIn(token);
    if (found !== null && lang === null && (found[0] >= 2 || token.length <= 4)) lang = found[1];
    let digits = 0, letters = 0;
    for (const ch of token) { if (ch >= '0' && ch <= '9') digits++; else if (isAlphaCh(ch)) letters++; }
    if (digits >= 1 && !total) {
      let core = token;
      if (core.length >= 4 && isAlphaCh(core[0]) && !isAlphaCh(core[1])) core = core.slice(1);
      if (core.length >= 4 && RARITY_LETTERS.includes(core[core.length - 1]) && !isAlphaCh(core[core.length - 2])) core = core.slice(0, -1);
      let mapped = fixNumber(core);
      let suffix = '';
      if (mapped.length >= 2 && !/[0-9]$/.test(mapped) && isDigitStr(mapped.slice(0, -1))) {
        suffix = mapped[mapped.length - 1]; mapped = mapped.slice(0, -1);
      }
      const year = mapped.length === 4 && (mapped.slice(0, 2) === '19' || mapped.slice(0, 2) === '20') && k + 1 < tokens.length && tokens[k + 1].startsWith('W');
      let digitLike = 0;
      for (const ch of mapped) if (ch >= '0' && ch <= '9') digitLike++;
      if (mapped.length >= 1 && mapped.length <= 5 && !year && digitLike >= Math.max(1, mapped.length - 1)
          && (digits >= 2 || isDigitStr(mapped))) {
        numbers.push([mapped.replace(/^0+/, '') || '0', mapped, suffix]);
      }
    }
    if (letters >= 1) {
      let core = token;
      if (found !== null && found[0] >= 2) core = token.slice(0, found[0]);
      else if (found !== null && found[0] === 0) core = '';
      const variants = [core];
      if (core.length >= 4 && SEPARATOR_MISREADS.includes(core[core.length - 1])) variants.push(core.slice(0, -1));
      if (core.length >= 4 && (RARITY_LETTERS + 'V').includes(core[0])) variants.push(core.slice(1));
      if (core.length >= 5) variants.push(core.slice(0, 3), core.slice(0, 4));
      for (const v of variants) {
        if (v.length >= 2 && v.length <= 5 && [...v].some(isAlphaCh) && !set_tokens.includes(v)) set_tokens.push(v);
      }
    }
  }
  return { set_tokens, numbers, lang };
}
export const fuzzy_collector_line = fuzzyCollectorLine;

function printedSetCodes(card) {
  const code = String(card.set_code || '').toUpperCase();
  const out = code ? [code] : [];
  const cn = String(card.collector_number || '').toUpperCase();
  const plst = PLST_CN_RE.exec(cn);
  if (plst) out.push(plst[1]);
  else if (code.length === 4 && code.startsWith('P')) out.push(code.slice(1));
  return out;
}

function printedNumber(card) {
  let cn = String(card.collector_number || '').toUpperCase();
  const plst = PLST_CN_RE.exec(cn);
  if (plst) cn = plst[2];
  const m = /^(\d+)([^]*)$/.exec(cn);
  if (!m) return ['', cn];
  return [m[1].replace(/^0+/, '') || '0', m[2]];
}

export function fuzzySetCost(line, card) {
  if (!line.set_tokens.length) return null;
  const codes = printedSetCodes(card);
  if (!codes.length) return FUZZY_PART_CAP;
  let best = Infinity;
  for (const t of line.set_tokens) for (const c of codes) best = Math.min(best, weightedDistance(t, c, SET_PAIRS));
  return Math.min(best, FUZZY_PART_CAP);
}

export function fuzzyNumberCost(line, card) {
  if (!line.numbers.length) return null;
  const [digits, suffix] = printedNumber(card);
  if (!digits) return FUZZY_PART_CAP;
  let best = FUZZY_PART_CAP;
  for (const [stripped, asRead, readSuffix] of line.numbers) {
    let cost = weightedDistance(stripped, digits, DIGIT_PAIRS);
    if (asRead.length > digits.length) cost = Math.min(cost, weightedDistance(asRead, digits.padStart(asRead.length, '0'), DIGIT_PAIRS));
    if (suffix && !readSuffix.includes(suffix)) cost += FUZZY_SUFFIX_COST;
    best = Math.min(best, cost);
  }
  return Math.min(best, FUZZY_PART_CAP);
}

function isListTwin(card, of) {
  if (String(card.set_code || '') !== 'plst') return false;
  return String(card.collector_number || '').toUpperCase() === `${String(of.set_code || '').toUpperCase()}-${String(of.collector_number || '').toUpperCase()}`;
}

/** match.fuzzy_pick -> {winners, kind, setCost, numberCost} */
export function fuzzyPick(pool, line) {
  if (fuzzyLineEmpty(line) || !pool.length) return { winners: [], kind: null, setCost: 0.0, numberCost: 0.0 };
  const groups = new Map();
  for (const card of pool) {
    const key = JSON.stringify([String(card.set_code || ''), String(card.collector_number || '')]);
    let g = groups.get(key);
    if (!g) groups.set(key, g = { key: [String(card.set_code || ''), String(card.collector_number || '')], cards: [] });
    g.cards.push(card);
  }
  const scored = [];
  for (const g of groups.values()) {
    const s = fuzzySetCost(line, g.cards[0]);
    const n = fuzzyNumberCost(line, g.cards[0]);
    const total = (s === null ? FUZZY_PART_CAP : s) + (n === null ? FUZZY_PART_CAP : n);
    scored.push({ total, s, n, key: g.key, cards: g.cards });
  }
  scored.sort((a, b) => (a.total - b.total) || cmpStr(a.key[0], b.key[0]) || cmpStr(a.key[1], b.key[1]));
  const { total, s, n, cards } = scored[0];
  const rivals = scored.slice(1).filter(x => !isListTwin(x.cards[0], cards[0])).map(x => x.total);
  const ahead = !rivals.length || Math.min(...rivals) - total >= FUZZY_MARGIN;
  const sc = s || 0.0, nc = n || 0.0;
  if (!ahead) return { winners: [], kind: null, setCost: sc, numberCost: nc };
  if (s !== null && n !== null && s <= FUZZY_FIT && n <= FUZZY_FIT) return { winners: cards, kind: 'joint', setCost: s, numberCost: n };
  if ((s !== null && s <= FUZZY_FIT) || (n !== null && n <= FUZZY_FIT)) return { winners: cards, kind: 'leans', setCost: sc, numberCost: nc };
  return { winners: [], kind: null, setCost: sc, numberCost: nc };
}

// ---------------------------------------------------------------------------
// basic land banner, illus cue
// ---------------------------------------------------------------------------
function bannerCue(n) {
  if (splitWs(n).length > BANNER_CUE_MAX_WORDS) return false;
  return BASIC_LAND_CUES.some(c => n.includes(c)) || BASIC_LAND_CUES.some(c => partialRatio(c, n) >= BANNER_CUE_SCORE);
}

export function basicLandPrinted(n) { return n === 'odnis' ? 'Ödnis' : n.charAt(0).toUpperCase() + n.slice(1); }
export function basicLandEnglish(name) {
  const e = BASIC_LAND_NAMES[normalizeName(name || '')];
  return e ? e[0] : null;
}

/** match.basic_land_from_lines -> [printed, english, lang] | null */
export function basicLandFromLines(lines) {
  const norms = [...lines].map(raw => normalizeName(raw || '')).filter(Boolean);
  const cueLines = norms.filter(bannerCue);
  if (!cueLines.length) return null;
  let best = null;
  const pieces = [...norms.map(n => [n, false]), ...cueLines.flatMap(n => splitWs(n).map(w => [w, true]))];
  for (const [piece, fromCue] of pieces) {
    if (countAlpha(piece) < 4) continue;
    for (const name of Object.keys(BASIC_LAND_NAMES)) {
      if (!fromCue && piece.length > name.length + BANNER_NAME_SLACK) continue;
      const score = fzRatio(piece, name);
      if (score >= BANNER_NAME_SCORE && (best === null || score > best[0])) best = [score, name];
    }
  }
  if (best === null) return null;
  const [english, lang] = BASIC_LAND_NAMES[best[1]];
  return [basicLandPrinted(best[1]), english, lang];
}

/** match.illus_line: one of the OCR lines holds the word "Illus." of an old frame's artist line. */
export function illusLine(lines) {
  for (const raw of lines) for (const word of splitWs(normalizeName(raw || ''))) {
    if (word.length >= 3 && word.length <= 6 && (fzRatio(word, 'illus') >= ILLUS_SCORE || ILLUS_RE.test(word))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// card database (replaces the SQL queries)
// ---------------------------------------------------------------------------
export class CardDb {
  /** @param pack prints.json (v2) */
  constructor(pack) {
    this.pack = pack;
    this.n = pack.n;
    this.idsHex = pack.ids;
    this.oracle = Int32Array.from(pack.oracle);
    this.langCol = Uint8Array.from(pack.lang);
    this.setCol = Int32Array.from(pack.set);
    this.cnCol = pack.cn;
    this.nameCol = Int32Array.from(pack.name);
    this.pnameCol = Int32Array.from(pack.pname);
    this.relCol = Int32Array.from(pack.rel);
    this.flags = Uint8Array.from(pack.flags);
    this.layoutCol = Int32Array.from(pack.layout);
    this.frameCol = Int32Array.from(pack.frame);
    this.ill = Int32Array.from(pack.ill);
    this._rows = new Array(this.n);
    this.oraclesHex = null;
    this._byOracle = null; this._bySetCn = null; this._byIll = null; this._idMap = null; this._oracleMap = null;
    this.artCard = null; this._hashed = null;
    if (pack.art) this.useArt(pack.art);
  }
  /** art.json: card index per art-hash row */
  useArt(artCard) {
    this.artCard = Int32Array.from(artCard);
    this._hashed = new Set();
    for (const c of this.artCard) if (this.ill[c] >= 0) this._hashed.add(this.ill[c]);
  }
  setOracles(hex) { if (!this.oraclesHex) this.oraclesHex = hex; }
  oracleId(oi) { return oi >= 0 && this.oraclesHex ? hex2uuid(this.oraclesHex.slice(oi * 32, oi * 32 + 32)) : (oi >= 0 ? `oracle#${oi}` : ''); }
  oracleIndex(id) {
    if (!this._oracleMap) {
      this._oracleMap = new Map();
      const h = this.oraclesHex || '';
      for (let i = 0; i * 32 < h.length; i++) this._oracleMap.set(hex2uuid(h.slice(i * 32, i * 32 + 32)), i);
    }
    return this._oracleMap.has(id) ? this._oracleMap.get(id) : -1;
  }
  id(i) { return hex2uuid(this.idsHex.slice(i * 32, i * 32 + 32)); }
  indexOfId(id) {
    if (!this._idMap) {
      this._idMap = new Map();
      for (let i = 0; i < this.n; i++) this._idMap.set(this.id(i), i);
    }
    return this._idMap.has(id) ? this._idMap.get(id) : -1;
  }
  str(i) { return this.pack.strs[i]; }

  /** the card row as an object with the Python field names (cached: identity is stable) */
  row(i) {
    let r = this._rows[i];
    if (r) return r;
    const p = this.pack;
    const pn = this.pnameCol[i];
    r = this._rows[i] = {
      i, id: this.id(i), oracle: this.oracle[i],
      name: p.strs[this.nameCol[i]], printed_name: pn < 0 ? null : p.strs[pn],
      lang: p.langs[this.langCol[i]], set_code: p.sets[this.setCol[i]], collector_number: this.cnCol[i],
      rel: p.rels[this.relCol[i]], promo: this.flags[i] & 1, full_art: (this.flags[i] >> 1) & 1,
      layout: this.layoutCol[i] < 0 ? null : p.layouts[this.layoutCol[i]],
      frame: this.frameCol[i] < 0 ? null : p.frames[this.frameCol[i]],
      ill: this.ill[i],
    };
    return r;
  }

  /** all card indices of one oracle id, in table order (idx_cards_oracle) */
  printingsOf(oi) {
    if (!this._byOracle) {
      const m = new Map();
      for (let i = 0; i < this.n; i++) { const o = this.oracle[i]; if (o < 0) continue; let a = m.get(o); if (!a) m.set(o, a = []); a.push(i); }
      this._byOracle = m;
    }
    return this._byOracle.get(oi) || [];
  }
  /** SELECT ... WHERE set_code = ? AND collector_number = ? [AND lang = ?] (index order: lang, rowid) */
  lookupSetCn(set, cn, lang = null) {
    if (!this._bySetCn) {
      const m = new Map();
      for (let i = 0; i < this.n; i++) {
        const k = this.setCol[i] + '\u0000' + this.cnCol[i];
        let a = m.get(k); if (!a) m.set(k, a = []); a.push(i);
      }
      this._bySetCn = m;
    }
    const si = this.pack.sets.indexOf(set);
    if (si < 0) return [];
    let a = this._bySetCn.get(si + '\u0000' + cn) || [];
    if (lang) a = a.filter(i => this.pack.langs[this.langCol[i]] === lang);
    else a = [...a].sort((x, y) => cmpStr(this.pack.langs[this.langCol[x]], this.pack.langs[this.langCol[y]]) || x - y);
    return a;
  }
  /** all card indices carrying one illustration (the slow path of the SQL version) */
  printingsOfIllustration(ill) {
    if (!this._byIll) {
      const m = new Map();
      for (let i = 0; i < this.n; i++) { const o = this.ill[i]; if (o < 0) continue; let a = m.get(o); if (!a) m.set(o, a = []); a.push(i); }
      this._byIll = m;
    }
    return this._byIll.get(ill) || [];
  }
  anyHashed(illSet) {
    if (!this._hashed) return false;
    for (const i of illSet) if (i >= 0 && this._hashed.has(i)) return true;
    return false;
  }
}
/** Phase-0 name of the card table: `prints.byId.get(cardId)` -> [id, oracle idx, lang, set, cn, name, printed_name, ill] */
export class Prints extends CardDb {
  legacyRow(i) {
    const r = this.row(i);
    return [r.id, r.oracle, r.lang, r.set_code, r.collector_number, r.name, r.printed_name, r.ill];
  }
  get byId() {
    return { get: id => { const i = this.indexOfId(id); return i < 0 ? undefined : this.legacyRow(i); } };
  }
}

/** Normalizes an art hit to {card (index), ill, distance, dhash_distance, box, idx?}.
 *  Accepts the arthash.js shape ({idx: art row, distance, dhash_distance, crop}), a hit with a card index
 *  (`card`) or a card id string (`card_id`), and the Python recording shape (card_id + illustration_id). */
export function toArtHit(db, h) {
  if (h.ill !== undefined && h.card !== undefined) return h;
  let card = -1;
  if (h.card !== undefined) card = h.card;
  else if (h.idx !== undefined && db.artCard) card = db.artCard[h.idx];
  else if (typeof h.card_id === 'number') card = h.card_id;
  else if (typeof h.card_id === 'string') card = db.indexOfId(h.card_id);
  return {
    card, ill: card >= 0 ? db.ill[card] : -1, distance: h.distance, dhash_distance: h.dhash_distance,
    box: h.box !== undefined ? h.box : h.crop,
  };
}

// ---------------------------------------------------------------------------
// candidate resolution helpers
// ---------------------------------------------------------------------------
function namesOf(card) {
  const names = [];
  for (const value of [card.name, card.printed_name]) {
    if (value) {
      names.push(value);
      if (value.includes(' // ')) names.push(...value.split(' // ').map(p => p.trim()));
    }
  }
  return names;
}
function nameNorms(cards) {
  const out = new Set();
  for (const c of cards) for (const n of namesOf(c)) { const v = norm(n); if (v) out.add(v); }
  return out;
}
function bestScore(titleNorm, norms) {
  let best = 0.0;
  for (const n of norms) best = Math.max(best, nameScore(titleNorm, n));
  return best;
}
export function titleScore(titleNorm, card) {
  if (!titleNorm) return 0.0;
  return bestScore(titleNorm, nameNorms([card]));
}
function isFragment(titleNorm, norms) {
  for (const n of norms) if (titleNorm.length < n.length && partialRatio(titleNorm, n) >= TITLE_FRAGMENT_PARTIAL) return true;
  return false;
}
function titleContradicts(titleNorm, titleLetters, score, norms, bestNameScore) {
  return titleLetters >= TITLE_CONTRADICT_MIN_LETTERS && score < TITLE_CONTRADICT_SCORE
    && bestNameScore >= TITLE_CONTRADICT_MIN_NAME_SCORE && !isFragment(titleNorm, norms);
}
function titleLanguage(titleNorm, printings, hitLang) {
  if (!hitLang || !titleNorm) return hitLang;
  const english = nameNorms(printings.map(p => ({ name: p.name })));
  const german = nameNorms(printings.filter(p => p.lang === 'de' && p.printed_name).map(p => ({ name: p.printed_name })));
  if (!english.size || !german.size) return hitLang;
  if (Math.abs(bestScore(titleNorm, english) - bestScore(titleNorm, german)) < LANG_TIE_MARGIN) return null;
  return hitLang;
}

function hasEvidence(card, bottom, confirmed = null) {
  const setMatch = !!bottom.set_code && card.set_code === bottom.set_code;
  const cnMatch = !!bottom.collector_number && card.collector_number === bottom.collector_number;
  const langOk = !bottom.lang || card.lang === bottom.lang;
  if (bottom.set_code && bottom.collector_number) {
    if (setMatch && cnMatch && (bottom.number_legible || confirmed === null || confirmed.has(card.i))) return 'set+cn';
    return setMatch && !bottom.number_legible ? 'set' : null;
  }
  if (setMatch) return 'set';
  if (cnMatch && langOk && bottom.number_legible) return 'cn';
  return null;
}

const cnOrder = card => {
  const cn = String(card.collector_number || '');
  return isDigitStr(cn) ? [0, parseInt(cn, 10)] : [1, 0];
};
function printingKey(card, prefLang, bottom) {
  const [a, b] = cnOrder(card);
  return [
    prefLang && card.lang === prefLang ? 0 : 1,
    bottom.set_code && card.set_code === bottom.set_code ? 0 : 1,
    bottom.collector_number && card.collector_number === bottom.collector_number ? 0 : 1,
    !card.promo ? 0 : 1,
    -card.rel,
    a, b,
    card.id,
  ];
}
function sameArtKey(card, prefLang, bottom) {
  const [a, b] = cnOrder(card);
  return [
    prefLang && card.lang === prefLang ? 0 : 1,
    bottom.set_code && card.set_code === bottom.set_code ? 0 : 1,
    bottom.collector_number && card.collector_number === bottom.collector_number ? 0 : 1,
    card.lang === 'en' ? 0 : 1,
    !card.promo ? 0 : 1,
    a, b,
    -card.rel,
    card.id,
  ];
}
const sortedBy = (arr, keyFn) => arr.map(x => [keyFn(x), x]).sort((p, q) => cmpKey(p[0], q[0])).map(p => p[1]);

const oneMisreadApart = (a, b) => a !== b && levenshtein(a, b) <= 1;
function softNumberPicks(pool, numbered, inSet, number) {
  if (!inSet && pool.length > SOFT_NUMBER_MAX_POOL) return false;
  const picked = new Set(numbered);
  return !pool.some(p => !picked.has(p) && oneMisreadApart(String(p.collector_number || ''), number));
}
function narrowByCollectorLine(printings, bottom) {
  let pool = printings;
  let inSet = [];
  if (bottom.set_code) {
    inSet = pool.filter(p => p.set_code === bottom.set_code);
    if (inSet.length) pool = inSet;
  }
  if (bottom.collector_number) {
    const numbered = pool.filter(p => p.collector_number === bottom.collector_number);
    if (numbered.length && (bottom.number_legible || softNumberPicks(pool, numbered, inSet.length > 0, bottom.collector_number))) pool = numbered;
  }
  return pool;
}
const openReason = count => `${PRINTING_OPEN_REASON} (${count} printings possible)`;

function pickPrintings(printings, prefLang, bottom, confirmed = null) {
  const ordered = sortedBy(printings, c => printingKey(c, prefLang, bottom));
  const chosen = [ordered[0]];
  for (let k = 1; k < ordered.length; k++) {
    const card = ordered[k];
    if (chosen.length >= MAX_PRINTINGS_PER_ORACLE) break;
    if (hasEvidence(card, bottom, confirmed) || card.lang !== chosen[0].lang) chosen.push(card);
  }
  return chosen;
}

function makeCandidate(db, card, score, reasons) {
  return {
    card_id: card.id, i: card.i, oracle: card.oracle, oracle_id: db.oracleId(card.oracle),
    name: String(card.name || ''), printed_name: card.printed_name,
    lang: String(card.lang || ''), set_code: String(card.set_code || ''), collector_number: String(card.collector_number || ''),
    score: pyRound1(Number(score)), reasons: [...reasons],
  };
}
const isArtBacked = reasons => reasons.some(r => String(r).startsWith(ART_REASON + ' d='));
const ART_DISTANCE_RE = /^art match d=(\d+)/;
function artDistance(reasons) {
  const found = [];
  for (const r of reasons) { const m = ART_DISTANCE_RE.exec(String(r)); if (m) found.push(parseInt(m[1], 10)); }
  return found.length ? Math.min(...found) : null;
}

const isNonCard = c => NON_CARD_LAYOUTS.includes(c.layout);
function cardPrintings(db, oi, cache) {
  let rows = cache.get(oi);
  if (rows === undefined) {
    rows = db.printingsOf(oi).map(i => db.row(i)).filter(r => !isNonCard(r));
    cache.set(oi, rows);
  }
  return rows;
}
function artPrintings(db, hit, rep, cache) {
  if (rep && rep.oracle >= 0) {
    const card = cardPrintings(db, rep.oracle, cache);
    return [card.filter(r => r.ill === hit.ill), card];
  }
  const rows = db.printingsOfIllustration(hit.ill).map(i => db.row(i)).filter(r => !isNonCard(r));
  if (!rows.length || rows[0].oracle < 0) return [rows, rows];
  return [rows, cardPrintings(db, rows[0].oracle, cache)];
}

function artCandidates(db, artHits, bottom, titleNorm, titleLetters, hits, setCnCards) {
  const out = [];
  const lead = new Map();
  const strongOracles = new Set();
  const strongPools = new Map();
  const weakPools = new Map();
  const firstReasonLists = new Map();
  const cardCache = new Map();
  const usable = artHits.filter(h => h.distance <= ART_WEAK)
    .sort((a, b) => (a.distance - b.distance) || (a.dhash_distance - b.dhash_distance) || (a.ill - b.ill));
  if (!usable.length) return [out, lead, strongOracles];

  const hitLang = new Map(), hitScore = new Map();
  for (const h of hits) if (!hitScore.has(h.oi)) { hitLang.set(h.oi, h.lang); hitScore.set(h.oi, Number(h.score)); }
  const bestNameScore = hits.length ? Number(hits[0].score) : 0.0;
  const setCnOracles = new Set(setCnCards.values());
  const titleUsable = titleLetters >= SHORT_QUERY_LETTERS;

  const seen = new Set();
  for (const hit of usable) {
    if (seen.has(hit.ill)) continue;
    seen.add(hit.ill);
    const strong = hit.distance <= ART_STRONG;
    const rep = hit.card >= 0 ? db.row(hit.card) : null;
    if (!strong) {
      const oracle = rep && rep.oracle >= 0 ? rep.oracle : null;
      if (oracle === null || !(hitScore.has(oracle) || setCnOracles.has(oracle))) continue;
    }
    const [printings, cardPr] = artPrintings(db, hit, rep, cardCache);
    if (!printings.length) continue;
    const oracleId = printings[0].oracle;

    const norms = nameNorms(printings);
    const ts = titleNorm ? bestScore(titleNorm, norms) : 0.0;
    const named = Math.max(ts, hitScore.has(oracleId) ? hitScore.get(oracleId) : 0.0);
    const agrees = named >= (titleUsable ? TITLE_CONFIRM_SCORE : SHORT_QUERY_MIN_SCORE);
    const artReason = `${ART_REASON} d=${hit.distance} (${hit.box})`;
    let base, reasons;
    if (strong && agrees) { base = ART_TITLE_SCORE; reasons = [artReason, TITLE_AGREES_REASON]; }
    else if (strong) {
      if (hit.dhash_distance > ART_DHASH_MAX) { base = null; reasons = [artReason]; }
      else if (titleContradicts(titleNorm, titleLetters, ts, norms, bestNameScore)) {
        base = SET_CN_CONTRADICTED_SCORE; reasons = [artReason, `title contradicts ${fmt0(ts)}`];
      } else { base = ART_ONLY_SCORE; reasons = [artReason]; }
    } else if (agrees) { base = ART_WEAK_TITLE_SCORE; reasons = [artReason, TITLE_AGREES_REASON]; }
    else { base = null; reasons = [artReason]; }

    const prefLang = bottom.lang || titleLanguage(titleNorm, printings, hitLang.get(oracleId));
    const ordered = sortedBy(printings, p => [setCnCards.has(p.i) ? 0 : 1, ...sameArtKey(p, prefLang, bottom)]);
    const first = ordered[0];
    const firstConfirmed = setCnCards.has(first.i);
    if (base === null && !firstConfirmed) continue;
    if (strong && agrees) strongOracles.add(oracleId);
    const pool = prefLang ? ordered.filter(p => p.lang === first.lang) : ordered;
    const narrowed = firstConfirmed ? [first] : narrowByCollectorLine(pool, bottom);
    lead.set(first.i, narrowed.length);
    const firstReasons = [...reasons];
    firstReasonLists.set(first.i, firstReasons);
    if (!firstConfirmed && pool.length > 1 && narrowed.length === 1) firstReasons.push(COLLECTOR_PICKS_REASON);
    if (strong && base !== null && !firstConfirmed) {
      if (!strongPools.has(oracleId)) strongPools.set(oracleId, []);
      strongPools.get(oracleId).push([first.i, pool]);
    } else if (!strong && base !== null && !firstConfirmed) {
      const inLang = prefLang ? cardPr.filter(p => p.lang === first.lang) : cardPr;
      if (!weakPools.has(oracleId)) weakPools.set(oracleId, []);
      weakPools.get(oracleId).push([first.i, pool, inLang]);
    }
    ordered.forEach((card, i) => {
      if (setCnCards.has(card.i)) out.push([card, ART_SET_CN_SCORE, [...reasons]]);
      else if (base === null) return;
      else if (i === 0) out.push([card, base, firstReasons]);
      else out.push([card, base - SAME_ART_PENALTY, [...reasons, `${SAME_ART_REASON} ${ordered.length} printings`]]);
    });
  }

  for (const entries of strongPools.values()) {
    if (entries.length < 2) continue;
    const combined = entries.flatMap(([, pool]) => pool);
    const openTotal = narrowByCollectorLine(combined, bottom).length;
    for (const [firstId] of entries) lead.set(firstId, Math.max(lead.get(firstId), openTotal));
  }
  for (const [oracleId, entries] of weakPools) {
    if (strongPools.has(oracleId)) continue;
    let openTotal = 1;
    if (entries.length > 1) openTotal = narrowByCollectorLine(entries.flatMap(([, pool]) => pool), bottom).length;
    const left = narrowByCollectorLine(entries[0][2], bottom);
    if (new Set(left.map(p => p.ill)).size > WEAK_ART_MAX_ILLUSTRATIONS) openTotal = Math.max(openTotal, left.length);
    for (const [firstId] of entries) lead.set(firstId, Math.max(lead.get(firstId), openTotal));
  }
  for (const [firstId, fr] of firstReasonLists) {
    if ((lead.has(firstId) ? lead.get(firstId) : 1) > 1) {
      const k = fr.indexOf(COLLECTOR_PICKS_REASON);
      if (k >= 0) fr.splice(k, 1);
    }
  }
  return [out, lead, strongOracles];
}

function sameCardInSet(db, card) {
  let n = 0;
  for (const i of db.printingsOf(card.oracle)) {
    const r = db.row(i);
    if (r.set_code === card.set_code && r.lang === card.lang && (r.layout === null || !NON_CARD_LAYOUTS.includes(r.layout))) n++;
  }
  return n;
}

function titleReadsBackFace(titleNorm, printings) {
  const front = new Set(), back = new Set();
  for (const card of printings) {
    if (!BACK_FACE_LAYOUTS.includes(card.layout)) continue;
    for (const value of [card.name, card.printed_name]) {
      const parts = String(value || '').split(' // ').map(normalizeName).filter(Boolean);
      parts.slice(0, 1).forEach(p => front.add(p));
      parts.slice(1).forEach(p => back.add(p));
    }
  }
  return back.size > 0 && bestScore(titleNorm, back) > bestScore(titleNorm, front);
}

function cardsWithoutArtwork(db, titleNorm, named, artHits) {
  if (!artHits.length || !named.length) return [];
  const reach = Math.max(...artHits.map(h => h.distance));
  if (reach < ART_WEAK) return [];
  const horizon = Math.min(reach, PROXY_ART_FAR);
  const near = new Set(artHits.filter(h => h.distance <= horizon).map(h => h.ill));
  const out = [];
  for (const [oracleId, printings] of named) {
    const real = printings.filter(p => !NON_CARD_LAYOUTS.includes(p.layout));
    let m = 0.0;
    for (const n of nameNorms(real)) m = Math.max(m, fzRatio(titleNorm, n));
    if (m < TITLE_CONFIRM_SCORE) continue;
    const artworks = new Set(real.filter(p => p.ill >= 0).map(p => p.ill));
    if ([...artworks].some(a => near.has(a)) || !db.anyHashed(artworks)) continue;
    if (titleReadsBackFace(titleNorm, real)) continue;
    out.push(oracleId);
  }
  return out;
}

/** match.reconcile_language */
export function reconcileLanguage(bottom, bottomText) {
  if (!bottom.lang || bottom.set_code || !bottomText) return bottom;
  const lineLang = fuzzyCollectorLine(bottomText).lang;
  if (lineLang && lineLang !== bottom.lang) return { ...bottom, lang: null };
  return bottom;
}
export const reconcile_language = reconcileLanguage;

function fuzzyLang(bottom, line) {
  if (bottom.lang && line.lang && bottom.lang !== line.lang) return null;
  return bottom.lang || line.lang;
}

function applyFuzzyLine(db, found, bottom, line, titleNorm, hits, frameHint = null) {
  if (!found.size) return;
  const lang = fuzzyLang(bottom, line);
  const hitLang = new Map();
  for (const h of hits) if (!hitLang.has(h.oi)) hitLang.set(h.oi, h.lang);
  const ordered = [...found.values()].sort((a, b) => b.score - a.score);
  const topScore = ordered[0].score;
  const oracles = [];
  for (const cand of ordered) {
    if (cand.oracle >= 0 && !oracles.includes(cand.oracle) && cand.score >= topScore - FUZZY_NEAR_TOP) oracles.push(cand.oracle);
    if (oracles.length >= FUZZY_MAX_ORACLES) break;
  }
  const cache = new Map();
  for (const oracle of oracles) {
    const cands = ordered.filter(c => c.oracle === oracle);
    if (cands.some(c => c.reasons.some(r => String(r).startsWith('set+cn exact')))) continue;
    const best = cands[0];
    if (!best.reasons.some(r => String(r).startsWith(PRINTING_OPEN_REASON) || r === 'printing guessed')) continue;
    const printings = db.printingsOf(oracle).map(i => db.row(i)).filter(r => !isNonCard(r));
    void cache;
    const byId = new Map(printings.map(p => [p.i, p]));
    const artBacked = cands.filter(c => isArtBacked(c.reasons) && byId.has(c.i));
    const strong = artBacked.filter(c => (artDistance(c.reasons) || ART_WEAK + 1) <= ART_STRONG);  // sic: distance 0 counts as "none" like Python `or`
    const artIds = (strong.length ? strong : artBacked).map(c => c.i);
    let pool = artIds.length ? artIds.map(i => byId.get(i)) : [...printings];
    pool = narrowByCollectorLine(pool, bottom);
    const titleLang = titleNorm ? titleLanguage(titleNorm, printings, hitLang.get(oracle)) : null;
    let poolLang;
    if (lang && titleLang && lang !== titleLang) poolLang = null;
    else poolLang = lang || titleLang;
    if (poolLang) {
      const inLang = pool.filter(p => p.lang === poolLang);
      pool = inLang.length ? inLang : pool;
      if (!inLang.length) poolLang = null;
    }
    let byFrame = false;
    if (frameHint === 'old') {
      const oldFrame = pool.filter(p => OLD_FRAMES.includes(String(p.frame || '')));
      if (oldFrame.length && oldFrame.length < pool.length) { pool = oldFrame; byFrame = true; }
    }
    let { winners, kind } = fuzzyPick(pool, line);
    if (!kind && byFrame) {
      const keys = new Set(pool.map(p => p.set_code + '\u0000' + p.collector_number));
      if (keys.size === 1) { winners = [...pool]; kind = 'frame'; }
    }
    if (!kind || !winners.length) continue;
    if (poolLang === null) {
      const rank = new Map(cands.map((c, i) => [c.i, i]));
      winners = sortedBy(winners, p => [rank.has(p.i) ? rank.get(p.i) : rank.size, p.lang === 'en' ? 0 : 1]);
    }
    const winner = winners[0];
    const label = `${String(winner.set_code || '').toUpperCase()} ${winner.collector_number}`;
    const openReasons = best.reasons.filter(r => String(r).startsWith(PRINTING_OPEN_REASON));
    const guessed = best.reasons.includes('printing guessed');
    const reasons = best.reasons.filter(r => r !== 'printing guessed' && !String(r).startsWith(PRINTING_OPEN_REASON)
      && !String(r).startsWith('printing evidence'));
    let cand = found.get(winner.i);
    if (cand === undefined) {
      cand = makeCandidate(db, winner, best.score, reasons);
      found.set(cand.i, cand);
    } else {
      cand.reasons = cand.reasons.filter(r => r !== 'printing guessed' && !String(r).startsWith(PRINTING_OPEN_REASON));
      const ownArt = isArtBacked(cand.reasons);
      for (const r of reasons) {
        if (cand.reasons.includes(r) || startsWithAny(String(r), [SAME_ART_REASON, COLLECTOR_PICKS_REASON])) continue;
        if (ownArt && isArtBacked([r])) continue;
        cand.reasons.push(r);
      }
    }
    cand.reasons = cand.reasons.filter(r => !String(r).startsWith(SAME_ART_REASON));
    if (kind === 'joint') {
      cand.reasons.push(`${FUZZY_REASON}: ${label}`);
      if (winners.length > 1) cand.reasons.push(openReason(winners.length));
    } else {
      cand.reasons.push(`${kind === 'frame' ? FRAME_REASON : FUZZY_LEANS_REASON}: ${label}`);
      if (guessed) cand.reasons.push('printing guessed');
      else cand.reasons.push(...(openReasons.length ? openReasons : [openReason(Math.max(2, pool.length))]));
    }
    cand.score = best.score;
    for (const other of cands) {
      if (other.i !== cand.i && other.score >= cand.score) other.score = pyRound1(cand.score - SAME_ART_PENALTY);
    }
  }
}

function normalizeBottom(b) {
  if (!b) return bottomInfo();
  return {
    collector_number: b.collector_number !== undefined ? b.collector_number : (b.cn ?? null),
    set_code: b.set_code !== undefined ? b.set_code : (b.set ?? null),
    lang: b.lang ?? null, rarity: b.rarity ?? null,
    number_legible: b.number_legible === undefined ? true : !!b.number_legible,
  };
}

function normalizeHits(db, hits) {
  return hits.map(h => {
    if (Array.isArray(h)) h = { oracle_id: h[0], display: h[1], lang: h[2], score: h[3] };
    let oi = h.oi;
    if (oi === undefined) oi = db.oracleIndex(h.oracle_id);
    return { oi, oracle_id: h.oracle_id, display: h.display, lang: h.lang, score: Number(h.score) };
  });
}

/**
 * match.resolve_candidates. Returns the top MAX_CANDIDATES candidates (best first):
 *   {card_id, i (card index), oracle, oracle_id, name, printed_name, lang, set_code, collector_number, score, reasons[]}
 * @param db     CardDb
 * @param index  NameIndex
 * @param o.title            OCR title text of the upright card ('' / null: none)
 * @param o.hits             index.search(title, MAX_CANDIDATES) when the caller has it (null/undefined: searched here;
 *                           [] means "searched, nothing found")
 * @param o.bottom           BottomInfo {collector_number, set_code, lang, rarity, number_legible} (parseBottom result,
 *                           reconcileLanguage applied by the caller or not: it is applied here again like in Python;
 *                           set number_legible=false when the collector line OCR was soft)
 * @param o.bottomText       raw OCR text of the collector line (for the fuzzy reading)
 * @param o.artHits          art hits (any shape accepted by toArtHit), sorted or not
 * @param o.detectedByContour true when the card outline was found (not the guide fallback), default true
 * @param o.sharpness        Laplacian variance of the warp (pipeline.sharpness_of), null: no proxy check
 * @param o.frameHint        'old' when illusLine() read the "Illus." line of a 1993/1997 frame
 */
export function resolveCandidates(db, index, o = {}) {
  if (index && index.oraclesHex) db.setOracles(index.oraclesHex);
  const titleText = o.title || '';
  const bottomText = o.bottomText ?? null;
  const frameHint = o.frameHint ?? null;
  const detectedByContour = o.detectedByContour === undefined ? true : o.detectedByContour;
  const sharpness = o.sharpness ?? null;
  const bottom = reconcileLanguage(normalizeBottom(o.bottom), bottomText);
  const titleNorm = normalizeName(titleText);
  const titleLetters = countAlpha(titleNorm);
  let hits = o.hits;
  if (titleNorm && (hits === undefined || hits === null)) hits = index.search(titleText, MAX_CANDIDATES);
  hits = normalizeHits(db, hits || []);
  const artHits = (o.artHits || []).map(h => toArtHit(db, h));
  const bestNameScore = hits.length ? hits[0].score : 0.0;
  const found = new Map();      // card index -> candidate (insertion ordered)

  const add = cand => {
    const existing = found.get(cand.i);
    if (existing === undefined) { found.set(cand.i, cand); return; }
    const reasons = [...existing.reasons, ...cand.reasons.filter(r => !existing.reasons.includes(r))];
    if (cand.score > existing.score) { cand.reasons = reasons; found.set(cand.i, cand); }
    else existing.reasons = reasons;
  };

  // 1. exact printing from the collector line
  const setCnCards = new Map();
  const softPending = [];
  if (bottom.set_code && bottom.collector_number) {
    let rows = [];
    for (const code of setCodeVariants(bottom.set_code.toUpperCase())) {
      if (bottom.lang) {
        rows = db.lookupSetCn(code, bottom.collector_number, bottom.lang);
        if (rows.length) break;
      }
      rows = db.lookupSetCn(code, bottom.collector_number, null);
      if (rows.length) break;
    }
    for (const ci of rows) {
      const card = db.row(ci);
      const ts = titleNorm ? titleScore(titleNorm, card) : 0.0;
      if (!bottom.number_legible) {
        if (ts < TITLE_CONFIRM_SCORE) continue;
        if (sameCardInSet(db, card) > 1) softPending.push(card.i);
      }
      setCnCards.set(card.i, card.oracle);
      let score = SET_CN_SCORE;
      const reasons = [`set+cn exact (${card.set_code} #${card.collector_number})`];
      if (titleNorm) {
        if (ts >= TITLE_CONFIRM_SCORE) { score = SET_CN_TITLE_SCORE; reasons.push(`title match ${fmt0(ts)}`); }
        else if (titleContradicts(titleNorm, titleLetters, ts, nameNorms([card]), bestNameScore)) {
          score = SET_CN_CONTRADICTED_SCORE; reasons.push(`title contradicts ${fmt0(ts)}`);
        } else reasons.push(`title score ${fmt0(ts)}`);
      }
      add(makeCandidate(db, card, score, reasons));
    }
  }

  // 2. art hash -> printings of the matched illustrations
  let artLead = new Map(), strongArtOracles = new Set();
  if (artHits.length) {
    const [artCands, lead, strongOracles] = artCandidates(db, artHits, bottom, titleNorm, titleLetters, hits, setCnCards);
    artLead = lead; strongArtOracles = strongOracles;
    for (const [card, score, reasons] of artCands) add(makeCandidate(db, card, score, reasons));
  }
  for (const id of softPending) {
    if (!isArtBacked(found.get(id).reasons)) { found.delete(id); setCnCards.delete(id); }
  }

  // 3. fuzzy title -> printings
  const named = [];
  if (titleNorm) {
    for (const h of hits) {
      if (h.score < MIN_NAME_SCORE) continue;
      const printings = db.printingsOf(h.oi).map(i => db.row(i));
      if (!printings.length) continue;
      if (h.score >= TITLE_CONFIRM_SCORE) named.push([h.oi, printings]);
      const prefLang = bottom.lang || h.lang;
      const langKnown = !!(bottom.lang || titleLanguage(titleNorm, printings, h.lang));
      const picked = pickPrintings(printings, prefLang, bottom, setCnCards);
      for (const p of printings) {
        if (artLead.has(p.i) && hasEvidence(p, bottom, setCnCards) && !picked.includes(p)) picked.push(p);
      }
      for (const card of picked) {
        const evidence = hasEvidence(card, bottom, setCnCards);
        const reasons = [`name ~ ${pyRepr(h.display)} (${h.lang}) ${fmt0(h.score)}`];
        let score;
        if (evidence) {
          score = h.score;
          reasons.push(`printing evidence: ${evidence}`);
          if (evidence !== 'set+cn') {
            let alike = 0;
            for (const p of printings) if ((!langKnown || p.lang === card.lang) && hasEvidence(p, bottom, setCnCards) === evidence) alike++;
            if (alike > 1) reasons.push(openReason(alike));
          }
        } else {
          score = h.score - GUESS_PENALTY;
          reasons.push('printing guessed');
        }
        add(makeCandidate(db, card, score, reasons));
      }
    }
  }

  // the artwork has the last word on what is still open
  const halfLine = ['printing evidence: set', 'printing evidence: cn'];
  const softLine = bottom.number_legible ? [] : ['printing evidence: set+cn', 'set+cn exact'];
  const artWithLine = new Set();
  for (const c of found.values()) {
    if (isArtBacked(c.reasons) && c.reasons.some(r => String(r).startsWith('printing evidence'))) artWithLine.add(c.oracle);
  }
  for (const cand of found.values()) {
    if (isArtBacked(cand.reasons)) {
      const reasons = cand.reasons.filter(r => r !== 'printing guessed' && !String(r).startsWith(PRINTING_OPEN_REASON));
      if ((artLead.has(cand.i) ? artLead.get(cand.i) : 1) > 1) reasons.push(openReason(artLead.get(cand.i)));
      cand.reasons = reasons;
    } else if (strongArtOracles.has(cand.oracle) && !artWithLine.has(cand.oracle)
        && cand.reasons.some(r => halfLine.includes(r) || startsWithAny(String(r), softLine))) {
      cand.reasons = cand.reasons.filter(r => !String(r).startsWith(PRINTING_OPEN_REASON));
      cand.reasons.push(`${PRINTING_OPEN_REASON} (collector line and artwork disagree)`);
    }
  }

  // proxy hint (SPEC 1.2 section 13.8)
  if (detectedByContour && sharpness !== null && sharpness >= PROXY_MIN_SHARPNESS) {
    for (const oracle of cardsWithoutArtwork(db, titleNorm, named, artHits)) {
      for (const cand of found.values()) {
        if (cand.oracle === oracle && cand.reasons.includes('printing guessed') && !cand.reasons.includes(PROXY_REASON)) cand.reasons.push(PROXY_REASON);
      }
    }
  }

  // the raw collector line (and the frame) pick among the printings still open
  const line = fuzzyCollectorLine(bottomText);
  if (!fuzzyLineEmpty(line) || frameHint) applyFuzzyLine(db, found, bottom, line, titleNorm, hits, frameHint);

  return [...found.values()].sort((a, b) => b.score - a.score).slice(0, MAX_CANDIDATES);
}
export const resolve_candidates = resolveCandidates;

// ---------------------------------------------------------------------------
// pipeline.py: decisions from candidates / art hits
// ---------------------------------------------------------------------------
const hasReason = (cand, prefixes) => cand.reasons.some(r => startsWithAny(String(r), Array.isArray(prefixes) ? prefixes : [prefixes]));
const printingBacked = cand => hasReason(cand, [...COLLECTOR_EVIDENCE_PREFIXES, ART_EVIDENCE]);
const artConfirmed = cand => cand.score >= ART_TITLE_SCORE && hasReason(cand, ART_EVIDENCE) && hasReason(cand, TITLE_AGREES_REASON);
const confirmed = cand => cand.score >= CONFIRMED_MIN_SCORE || artConfirmed(cand);

/** pipeline.compute_confidence: 'high' | 'medium' | 'low' | 'none' (add GUIDE_REASON to the reasons when the guide fallback was used) */
export function computeConfidence(candidates) {
  if (!candidates.length) return 'none';
  const best = candidates[0];
  const capped = hasReason(best, PRINTING_OPEN_REASON) || hasReason(best, GUIDE_REASON)
    || (hasReason(best, ART_EVIDENCE) && !hasReason(best, TITLE_AGREES_REASON) && !hasReason(best, COLLECTOR_EVIDENCE_PREFIXES))
    || (hasReason(best, FUZZY_REASON) && !(hasReason(best, ART_EVIDENCE) && hasReason(best, TITLE_AGREES_REASON)));
  if (!capped) {
    const others = candidates.slice(1).filter(c => c.oracle !== best.oracle);
    if (best.score >= CONFIRMED_MIN_SCORE && others.every(c => c.score < CONFIRMED_MIN_SCORE)) return 'high';
    if (artConfirmed(best) && !others.some(confirmed)) return 'high';
    const second = others.length ? Math.max(...others.map(c => c.score)) : null;
    if (best.score >= HIGH_MIN_SCORE && printingBacked(best) && (second === null || best.score - second >= HIGH_MIN_GAP)) return 'high';
  }
  return best.score >= MEDIUM_MIN_SCORE ? 'medium' : 'low';
}
export const compute_confidence = computeConfidence;

const letters = text => countAlpha(text);
const digitsOf = text => (text.match(/[0-9]/g) || []).length;
/** pipeline._needs_retry: read the title the other way up as well? */
export function needsRetry(title, conf, nameScoreValue) {
  if (conf < RETRY_MIN_CONF) return true;
  if (letters(title) < RETRY_MIN_LETTERS) return true;
  if (digitsOf(title) > letters(title)) return true;
  return nameScoreValue < RETRY_MIN_NAME_SCORE;
}
/** pipeline._read_quality: compare two readings [nameScore, conf * min(letters, 12)] lexicographically */
export function readQuality(title, conf, nameScoreValue) { return [nameScoreValue, conf * Math.min(letters(title), 12)]; }
export const betterRead = (a, b) => cmpKey(a, b) > 0;
/** pipeline._strong_art: nearest illustration stands without a title. hits: toArtHit shape or arthash.js shape */
export function strongArt(artHits) {
  return artHits.length > 0 && artHits[0].distance <= ART_STRONG && artHits[0].dhash_distance <= ART_DHASH_MAX;
}
/** pipeline._credible_art */
export function credibleArt(artHits) {
  return artHits.some(h => h.distance <= ART_WEAK && h.dhash_distance <= ART_DHASH_MAX);
}
/** pipeline._query_art merge step: `hits` = query over ART_CROPS, `extra` = query over the full-art-only crops
 *  (detect.FULLART_ONLY_CROPS); extra hits within ART_WEAK count only for full-art printings. */
export function mergeExtraArtHits(db, hits, extra) {
  const near = extra.map(h => toArtHit(db, h)).filter(h => h.distance <= ART_WEAK);
  const base = hits.map(h => toArtHit(db, h));
  if (!near.length) return base;
  const best = new Map(base.map(h => [h.ill, h]));
  for (const hit of near) {
    const old = best.get(hit.ill);
    if (db.row(hit.card).full_art && (old === undefined || hit.distance < old.distance
        || (hit.distance === old.distance && hit.dhash_distance < old.dhash_distance))) best.set(hit.ill, hit);
  }
  return [...best.values()].sort((a, b) => (a.distance - b.distance) || (a.dhash_distance - b.dhash_distance) || (a.ill - b.ill)).slice(0, ART_QUERY_LIMIT);
}
/** pipeline._art_of_top: {distance, box} of the art hit for the top candidate's illustration (or nulls) */
export function artOfTop(db, candidates, artHits) {
  if (!candidates.length || !artHits.length) return { distance: null, box: null };
  const ill = db.row(candidates[0].i).ill;
  if (ill < 0) return { distance: null, box: null };
  for (const h0 of artHits) { const h = toArtHit(db, h0); if (h.ill === ill) return { distance: h.distance, box: h.box }; }
  return { distance: null, box: null };
}
/** pipeline._illustrations_of: Set of illustration indices of all printings of a card (oracle index) */
export function illustrationsOf(db, oracle) {
  return new Set(db.printingsOf(oracle).map(i => db.ill[i]).filter(v => v >= 0));
}
/** pipeline._frame_cue_needed: top printing is open, art-backed, and its artwork exists in old and newer frames */
export function frameCueNeeded(db, candidates) {
  if (!candidates.length) return false;
  const top = candidates[0];
  if (!hasReason(top, PRINTING_OPEN_REASON) || !hasReason(top, ART_EVIDENCE)) return false;
  const ill = db.row(top.i).ill;
  const frames = new Set();
  for (const i of db.printingsOf(top.oracle)) { const r = db.row(i); if (r.ill === ill) frames.add(String(r.frame || '')); }
  const old = [...frames].some(f => OLD_FRAMES.includes(f));
  const newer = [...frames].some(f => !OLD_FRAMES.includes(f));
  return old && newer;
}
/** pipeline._banner_worth_reading: no strong artwork, or the strong one is a basic land's */
export function bannerWorthReading(db, artHits) {
  if (!strongArt(artHits)) return true;
  const h = toArtHit(db, artHits[0]);
  if (h.card < 0) return false;
  const english = new Set(Object.values(BASIC_LAND_NAMES).map(v => v[0]));
  return english.has(db.row(h.card).name);
}

// ---------------------------------------------------------------------------
// Phase-0 compatible entry point: resolve({names, prints, title, bottom, art}) -> {titleHits, candidates, confidence}
// candidates[]: {row: [id, oracle idx, lang, set, cn, name, printed_name, illustration idx], score, why}
// ---------------------------------------------------------------------------
export function resolve({ names, prints, title, bottom, art, bottomText = null, artHits = null, sharpness = null, detectedByContour = true }) {
  const hits = names.search(title || '', MAX_CANDIDATES);
  const candidates = resolveCandidates(prints, names, {
    title, hits, bottom, bottomText, artHits: artHits || art || [], sharpness, detectedByContour,
  });
  return {
    titleHits: hits,
    candidates: candidates.slice(0, 5).map(c => ({
      row: [c.card_id, c.oracle, c.lang, c.set_code, c.collector_number, c.name, c.printed_name, prints.ill[c.i]],
      score: c.score, why: c.reasons, cand: c,
    })),
    confidence: computeConfidence(candidates),
  };
}
