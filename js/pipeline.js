// Recognition pipeline: a 1:1 port of the orchestration of mtg-bibliothek/server/recognize/pipeline.py
// (recognize, recognize_warped, _orient, _read_warp, _analyse with refit). Constants and rules are the
// Python ones (match.js); nothing is re-tuned here.
//
//   ctx = { cv, names: NameIndex, db: CardDb (with useArt), art: ArtIndex }
//   await recognize(ctx, { src, guide })              src: RGBA cv.Mat camera frame (caller keeps it)
//   await recognizeWarped(ctx, warped, { method })    warped: RGBA cv.Mat, 1000x1400 (or any size: asWarp)
// -> { detected, method, title, bottomText, bottom, langHint, candidates, confidence, rotated, refit,
//      artDistance, artBox, art (top hits), sharpness, nameScore, timing, warped }
// `warped` (the upright card of the winning reading) is only returned with { keepWarp: true }; the caller deletes it.
// candidates: match.js candidates ({i, card_id, name, printed_name, lang, set_code, collector_number, score, reasons}).

import { detectCard, refitWarp, rotate180, cropBox, REFIT_MAX_SIDES, FULLART_ONLY_CROPS, WARP_W, WARP_H } from './detect.js';
import { readTitle, readCollector, readBanner, readIllus } from './ocr.js';
import {
  MAX_CANDIDATES, RETRY_MIN_NAME_SCORE, RETRY_MIN_LETTERS, ART_OVERRULE_TITLE_SCORE, ART_WEAK, ART_QUERY_LIMIT, GUIDE_REASON, BANNER_REASON,
  parseBottom, reconcileLanguage, resolveCandidates, computeConfidence, needsRetry, readQuality, strongArt, credibleArt,
  mergeExtraArtHits, artOfTop, frameCueNeeded, bannerWorthReading, illustrationsOf, basicLandFromLines, basicLandEnglish,
  illusLine, toArtHit, BASIC_LAND_NAMES,
} from './match.js';

export { GUIDE_REASON };

// ---- FAST MODE ---------------------------------------------------------------------------------------------------
// The default on the phone. Deliberate deviations from pipeline.py to save time (each one is documented in LOGBUCH.md);
// `exact: true` in the ctx (URL ?exact=1) runs the unmodified 1:1 path used for the Python parity checks.
//   1. text detector input capped per box (px, long side; RapidOCR's own limit is 960/1500/2000 for limit_type=max)
//   2. title: read with the capped detector first, exactly (as Python) again when that does not name a card (name score < 80);
//      the flipped title read is only tried when needed, not when the artwork already credibly matches upright, not in a
//      guide frame without any title text, and not on the second pass after a refit that kept the card upright
//   3. banner only when one of the 5 nearest artworks is a basic land's (distance <= 12) and the reading without it is not 'high';
//      banner / illus / refit skipped when nothing is readable in the guide fallback (title, collector line, artwork all empty)
//   4. no refit pass when the first reading is already 'high'
export const FAST_CAPS = { title: 800, banner: 0, illus: 640, collector: 800 };   // 0 = uncapped (the banner is read rarely, a 640 cap lost a land banner)
// fast mode: a banner is only worth reading when one of the nearest artworks is a basic land's (strong art as Python, or weak)
const ENGLISH_LANDS = new Set(Object.values(BASIC_LAND_NAMES).map(v => v[0]));
const LAND_ART_MAX = 12;
function landArtNear(db, artHits) {
  return artHits.slice(0, 5).some(h0 => { const h = toArtHit(db, h0); return h.card >= 0 && h.distance <= LAND_ART_MAX && ENGLISH_LANDS.has(db.row(h.card).name); });
}
const alphaCount = text => (String(text || '').match(/\p{L}/gu) || []).length;

const SHARP_MARGIN = 0.05;
const TIER_RANK = { none: 0, low: 1, medium: 2, high: 3 };
const rte = x => { const f = Math.floor(x), d = x - f; return d < 0.5 ? f : d > 0.5 ? f + 1 : (f % 2 === 0 ? f : f + 1); };   // Python round()
const lexGreater = (a, b) => { for (let k = 0; k < a.length; k++) { if (a[k] !== b[k]) return a[k] > b[k]; } return false; };

// Mats created during one recognition; freed at the end (except the one handed to the caller)
class Scope {
  constructor() { this.mats = []; }
  own(m) { if (m) this.mats.push(m); return m; }
  release(m) { const k = this.mats.indexOf(m); if (k >= 0) { this.mats.splice(k, 1); return true; } return false; }
  free() { for (const m of this.mats) { try { m.delete(); } catch { /* already gone */ } } this.mats = []; }
}

function spent(timings, key, start) { timings[key] = (timings[key] || 0) + performance.now() - start; }

/** pipeline.sharpness_of: variance of the Laplacian of the gray warp, interior only (SHARP_MARGIN per side left out) */
export function sharpnessOf(cv, warped) {
  const gray = new cv.Mat(), lap = new cv.Mat();
  cv.cvtColor(warped, gray, cv.COLOR_RGBA2GRAY);
  cv.Laplacian(gray, lap, cv.CV_32F);
  gray.delete();
  const h = lap.rows, w = lap.cols;
  const my = rte(SHARP_MARGIN * h), mx = rte(SHARP_MARGIN * w);
  let view = lap;
  if (h - 2 * my >= 8 && w - 2 * mx >= 8) view = lap.roi(new cv.Rect(mx, my, w - 2 * mx, h - 2 * my));
  const mean = new cv.Mat(), std = new cv.Mat();
  cv.meanStdDev(view, mean, std);
  const s = std.data64F[0];
  mean.delete(); std.delete();
  if (view !== lap) view.delete();
  lap.delete();
  return s * s;
}

/** pipeline._as_warp for an RGBA Mat: the 1000x1400 warp the readers expect (returns `mat` itself when it already is one) */
export function asWarp(cv, mat, scope) {
  if (mat.cols === WARP_W && mat.rows === WARP_H && mat.channels() === 4) return mat;
  let img = mat;
  if (img.channels() === 1) { const o = new cv.Mat(); cv.cvtColor(img, o, cv.COLOR_GRAY2RGBA); scope.own(o); img = o; }
  else if (img.channels() === 3) { const o = new cv.Mat(); cv.cvtColor(img, o, cv.COLOR_RGB2RGBA); scope.own(o); img = o; }
  if (img.rows !== WARP_H || img.cols !== WARP_W) {
    if (img.cols > img.rows) { const o = new cv.Mat(); cv.rotate(img, o, cv.ROTATE_90_CLOCKWISE); scope.own(o); img = o; }
    const o = new cv.Mat(); cv.resize(img, o, new cv.Size(WARP_W, WARP_H), 0, 0, cv.INTER_AREA); scope.own(o); img = o;
  }
  return img;
}

// pipeline._tall: the warp continued below the card, from the top edge of the card down (a view of `extended`)
function tallOf(cv, extended, warped, scope) {
  if (!extended || !warped || extended.cols !== warped.cols) return null;
  const pad = Math.floor((extended.rows - warped.rows) / 2);
  return pad > 0 ? scope.own(extended.roi(new cv.Rect(0, pad, extended.cols, extended.rows - pad))) : null;
}

class Reading {
  constructor(o) { Object.assign(this, o); }
  artFound() { return this.artDistance !== null && this.artDistance <= ART_WEAK; }
  rank() {
    const top = this.candidates.length ? this.candidates[0].score : 0.0;
    return [TIER_RANK[this.confidence] ?? 0, this.artFound() ? 1 : 0, top, this.nameScore];
  }
}

class Pipeline {
  constructor(ctx, timings) {
    this.cv = ctx.cv; this.names = ctx.names; this.db = ctx.db; this.artIndex = ctx.art || null;
    this.haveArt = !!this.artIndex && this.artIndex.length > 0;
    this.fast = !ctx.exact; this.caps = { ...FAST_CAPS, ...(ctx.fastCaps || {}) };
    this.timings = timings; this.scope = new Scope();
    this.ocrTiming = timings;   // readers add det / rec (ms) here
    this.hitCache = ctx._hitCache || (ctx._hitCache = new Map());
  }

  // pipeline._query_art: nearest illustrations over ART_CROPS plus the full-art-only crops (merged for full-art printings)
  queryArt(warped) {
    if (!this.haveArt) return [];
    const hits = this.artIndex.query(this.cv, warped, ART_QUERY_LIMIT);
    const extra = this.artIndex.query(this.cv, warped, ART_QUERY_LIMIT, FULLART_ONLY_CROPS);
    return mergeExtraArtHits(this.db, hits, extra);
  }

  // pipeline._best_hit -> {score, lang, hits}; searches memoised per title text (pure function of the text)
  bestHit(title) {
    if (!title || !title.trim()) return { score: 0.0, lang: null, hits: [] };
    let hits = this.hitCache.get(title);
    if (!hits) {
      hits = this.names.search(title, MAX_CANDIDATES);
      if (this.hitCache.size > 64) this.hitCache.delete(this.hitCache.keys().next().value);
      this.hitCache.set(title, hits);
    }
    if (!hits.length) return { score: 0.0, lang: null, hits: [] };
    return { score: hits[0].score, lang: hits[0].lang, hits };
  }

  // fast mode: the title is read with the capped detector first; when that does not name a card (name score < 80) it is read
  // again exactly as Python does (a capped detector sometimes finds no box at all). Not when a guide frame shows no text.
  async title(warped, key = 'title', method = 'contour', refine = true) {
    const t = performance.now();
    let r = await readTitle(this.cv, warped, this.ocrTiming, { detCap: this.fast ? this.caps.title : 0 });
    if (this.fast && refine && this.caps.title > 0 && this.bestHit(r.text).score < RETRY_MIN_NAME_SCORE && !(method === 'guide' && !alphaCount(r.text))) {
      r = await readTitle(this.cv, warped, this.ocrTiming);
    }
    spent(this.timings, key, t);
    return r;
  }

  // pipeline._orient
  async orient(warped, extended, method = 'contour', prior = null) {
    const T = this.timings, cv = this.cv, haveArt = this.haveArt;
    let start = performance.now();
    const artUp = this.queryArt(warped);
    let flipped = null, artDown = null, byArt = false;
    if (haveArt && !credibleArt(artUp)) {
      flipped = this.scope.own(rotate180(cv, warped));
      artDown = this.queryArt(flipped);
      byArt = strongArt(artDown);
    }
    spent(T, 'art', start);

    start = performance.now();
    let rotated = false, title, conf, score, lang, hits;
    if (byArt) {
      ({ text: title, conf } = await this.title(flipped, 'title', method));
      ({ score, lang, hits } = this.bestHit(title));
      rotated = true;
      if (score < RETRY_MIN_NAME_SCORE) {
        // no title that way up: an upright title that names a card overrules the artwork
        const up = await this.title(warped, 'title', method);
        const u = this.bestHit(up.text);
        if (u.score >= ART_OVERRULE_TITLE_SCORE) { rotated = false; title = up.text; conf = up.conf; score = u.score; lang = u.lang; hits = u.hits; }
      }
      spent(T, 'ocr', start);
    } else {
      ({ text: title, conf } = await this.title(warped, 'title', method));
      ({ score, lang, hits } = this.bestHit(title));
      spent(T, 'ocr', start);
      // fast mode: no flipped read when the artwork credibly matches upright or when the guide frame shows no title at all
      // (and on the second pass after a refit when the first pass kept the card upright)
      const skipRetry = this.fast && (credibleArt(artUp) || (method === 'guide' && alphaCount(title) < RETRY_MIN_LETTERS) || (prior && !prior.rotated));
      if (!strongArt(artUp) && !skipRetry && needsRetry(title, conf, score)) {
        start = performance.now();
        if (!flipped) flipped = this.scope.own(rotate180(cv, warped));
        const t2 = await this.title(flipped, 'title_retry', method, false);   // fast mode: the flipped read is not repeated exactly
        const h2 = this.bestHit(t2.text);
        let flip = lexGreater(readQuality(t2.text, t2.conf, h2.score), readQuality(title, conf, score));
        if (haveArt && Math.max(score, h2.score) < RETRY_MIN_NAME_SCORE) {
          // no readable title either way up: the artwork decides when it matches the flipped card
          if (!artDown) { const a0 = performance.now(); artDown = this.queryArt(flipped); spent(T, 'art', a0); }
          if (strongArt(artDown)) flip = true;
        }
        if (flip) { rotated = true; title = t2.text; conf = t2.conf; score = h2.score; lang = h2.lang; hits = h2.hits; }
        spent(T, 'ocr_retry', start);
      }
    }
    if (!rotated) return { warped, extended, title, score, lang, hits, artHits: artUp, rotated: false };
    if (!artDown) { const a0 = performance.now(); artDown = this.queryArt(flipped); spent(T, 'art', a0); }
    return { warped: flipped, extended: extended ? this.scope.own(rotate180(cv, extended)) : null, title, score, lang, hits, artHits: artDown, rotated: true };
  }

  // pipeline._read_warp
  async readWarp(warped, extended, method, prior = null) {
    const T = this.timings, cv = this.cv, db = this.db, names = this.names;
    let start = performance.now();
    const sharpness = sharpnessOf(cv, warped);
    spent(T, 'art', start);
    const o = await this.orient(warped, extended, method, prior);
    warped = o.warped; extended = o.extended;
    const { rotated, artHits } = o;
    const title = o.title;
    let nameScore = o.score;

    // the collector line is read once, on the orientation that won
    start = performance.now();
    const collector = await readCollector(cv, warped, tallOf(cv, extended, warped, this.scope), this.ocrTiming, { detCap: this.fast ? this.caps.collector : 0 });
    spent(T, 'collector', start); spent(T, 'ocr', start);

    start = performance.now();
    const bottomText = collector.text;
    let bottom = reconcileLanguage(parseBottom(bottomText, names.set_codes), bottomText);
    if (!collector.legible) bottom = { ...bottom, number_legible: false };
    const extras = { detectedByContour: method === 'contour', sharpness, bottomText };

    let banner = null;
    const resolve = (ttl, score, hitLang, hits, shown = null, land = null) => {
      const candidates = resolveCandidates(db, names, { title: ttl, bottom, hits, artHits, ...extras });
      for (const c of candidates) {
        if (method === 'guide' && !c.reasons.includes(GUIDE_REASON)) c.reasons.push(GUIDE_REASON);
        if (land && c.name === land && !c.reasons.includes(BANNER_REASON)) c.reasons.push(BANNER_REASON);
      }
      const art = artOfTop(db, candidates, artHits);
      return new Reading({
        warped, title: shown === null ? ttl : shown, bottomText, bottom,
        langHint: bottom.lang || (candidates.length ? hitLang : null),
        candidates, confidence: computeConfidence(candidates), rotated,
        artDistance: art.distance, artBox: art.box, sharpness, nameScore: score,
        hitLang, hits, matchTitle: ttl, artHits,
      });
    };
    const bestReading = () => {
      let reading;
      if (banner) reading = resolve(banner.printed, banner.score, banner.lang, banner.hits, banner.shown, banner.english);
      else reading = resolve(title, nameScore, o.lang, o.hits);
      if (prior && prior.nameScore >= RETRY_MIN_NAME_SCORE && prior.nameScore > nameScore) {
        const priorTitle = prior.matchTitle !== null && prior.matchTitle !== undefined ? prior.matchTitle : prior.title;
        const fromBanner = priorTitle !== prior.title;
        const landName = fromBanner ? basicLandEnglish(priorTitle) : null;
        const titled = resolve(priorTitle, prior.nameScore, prior.hitLang, prior.hits, fromBanner ? prior.title : null, landName);
        if (lexGreater(titled.rank(), reading.rank())) reading = titled;
      }
      return reading;
    };

    let reading = bestReading();
    // fast mode: nothing readable in a guide frame (no title, no collector line, no artwork evidence)
    const empty = this.fast && method === 'guide' && alphaCount(title) < RETRY_MIN_LETTERS && !artHits.some(h => h.distance <= ART_WEAK) && !(bottom.set_code || bottom.collector_number);
    // fast mode: the banner can only name a basic land; skip it when the reading is already 'high' or there is nothing to read
    const skipBanner = this.fast && (reading.confidence === 'high' || empty);

    // a full-art basic land has no title bar, its name sits in a banner on the artwork
    if (nameScore < RETRY_MIN_NAME_SCORE && !skipBanner && bannerWorthReading(db, artHits) && (!this.fast || landArtNear(db, artHits))) {
      const b0 = performance.now();
      const lines = await readBanner(cv, warped, this.ocrTiming, { detCap: this.fast ? this.caps.banner : 0 });
      const land = basicLandFromLines(lines);
      if (land) {
        const [printed, english] = land;
        const l = this.bestHit(printed);
        if (l.score >= RETRY_MIN_NAME_SCORE) banner = { shown: lines.join(' '), printed, english, score: l.score, lang: l.lang, hits: l.hits };
      }
      spent(T, 'banner', b0); spent(T, 'ocr', b0);
    }
    if (banner) { nameScore = banner.score; reading = bestReading(); }
    reading.empty = empty;
    start = performance.now();

    if (!(this.fast && empty) && frameCueNeeded(db, reading.candidates)) {
      // retro-frame reprint or modern printing of the same artwork? The old frames' "Illus." line says it
      const c0 = performance.now();
      const old = illusLine(await readIllus(cv, warped, this.ocrTiming, { detCap: this.fast ? this.caps.illus : 0 }));
      spent(T, 'illus', c0); spent(T, 'ocr', c0);
      if (old) { extras.frameHint = 'old'; reading = bestReading(); }
    }
    spent(T, 'match', start);
    return reading;
  }

  wantsRefit(reading) {
    if (!reading.candidates.length || reading.nameScore < RETRY_MIN_NAME_SCORE) return true;
    return this.haveArt && !reading.artFound();
  }

  refit(warped, maxSide) {
    try {
      const det = refitWarp(this.cv, warped, { maxSide, extended: true });
      if (det && det.warped) { this.scope.own(det.warped); this.scope.own(det.extended); return det; }
      det?.warped?.delete(); det?.extended?.delete();
    } catch (e) { console.warn('refit of the warp failed: ' + (e?.message || e)); }
    return null;
  }

  // pipeline._analyse -> {reading, refit}
  async analyse(warped, extended, method) {
    const T = this.timings, cv = this.cv, db = this.db;
    const first = await this.readWarp(warped, extended, method);
    if (!this.wantsRefit(first)) return { reading: first, refit: false };
    // fast mode: no refit when the first reading is 'high' already or the guide frame shows nothing at all
    if (this.fast && (first.empty || first.confidence === 'high')) return { reading: first, refit: false };
    const start = performance.now();
    const titled = first.candidates.length > 0 && first.nameScore >= RETRY_MIN_NAME_SCORE;
    const named = titled && this.haveArt ? illustrationsOf(db, first.candidates[0].oracle) : new Set();
    let chosen = null, fallback = null;
    for (const maxSide of REFIT_MAX_SIDES) {
      const det = this.refit(warped, maxSide);
      if (!det) continue;
      if (!this.haveArt) { chosen = det; break; }
      const showsKnownArt = hits => credibleArt(hits) || hits.some(h => h.distance <= ART_WEAK && named.has(toArtHit(db, h).ill));
      let ok = showsKnownArt(this.queryArt(det.warped));
      if (!ok) { const r = rotate180(cv, det.warped); try { ok = showsKnownArt(this.queryArt(r)); } finally { r.delete(); } }
      if (ok) { chosen = det; break; }
      if (!fallback) fallback = det;
    }
    if (!chosen && !titled) chosen = fallback;
    spent(T, 'refit', start);
    if (!chosen) return { reading: first, refit: false };
    const second = await this.readWarp(chosen.warped, chosen.extended, 'contour', first);
    if (lexGreater(second.rank(), first.rank())) return { reading: second, refit: true };
    return { reading: first, refit: false };
  }
}

function finish(p, reading, refit, method, timings, keepWarp) {
  const db = p.db;
  let warped = null;
  if (keepWarp && p.scope.release(reading.warped)) warped = reading.warped;   // the input warp stays with the caller
  p.scope.free();
  return {
    detected: true, method: refit ? 'contour' : method,
    title: reading.title, bottomText: reading.bottomText, bottom: reading.bottom, langHint: reading.langHint,
    candidates: reading.candidates, confidence: reading.confidence, rotated: reading.rotated, refit,
    artDistance: reading.artDistance, artBox: reading.artBox, sharpness: Math.round(reading.sharpness * 10) / 10,
    nameScore: reading.nameScore, art: reading.artHits.slice(0, 3).map(h => { const a = toArtHit(db, h); return { card: a.card, distance: a.distance, dhash_distance: a.dhash_distance, box: a.box }; }),
    timing: timings, warped,
  };
}

/** pipeline.recognize_warped: the pipeline from OCR onward on a stored warp. extended: the tall warp (optional). */
export async function recognizeWarped(ctx, warped, { method = 'contour', extended = null, keepWarp = false } = {}) {
  const timings = {};
  const t0 = performance.now();
  const p = new Pipeline(ctx, timings);
  try {
    const w = asWarp(ctx.cv, warped, p.scope);
    const { reading, refit } = await p.analyse(w, extended, method);
    timings.total = performance.now() - t0;
    return finish(p, reading, refit, method, timings, keepWarp);
  } catch (e) { p.scope.free(); throw e; }
}

/** pipeline.recognize: a camera frame (RGBA cv.Mat, kept by the caller). guide: [x0,y0,x1,y1] fractions or null. */
export async function recognize(ctx, { src = null, warped = null, guide = null, keepWarp = false } = {}) {
  if (!src && warped) return recognizeWarped(ctx, warped, { keepWarp });
  const { cv } = ctx;
  const timings = {};
  const t0 = performance.now();
  const det = detectCard(cv, src, guide, { extended: true });
  timings.detect = performance.now() - t0;
  if (!det.found || !det.warped) {
    timings.total = performance.now() - t0;
    return { detected: false, method: det.method || 'none', title: '', bottomText: '', bottom: parseBottom(''), langHint: null, candidates: [], confidence: 'none', rotated: false, refit: false, artDistance: null, artBox: null, art: [], sharpness: 0, nameScore: 0, timing: timings, warped: null, quad: det.quad };
  }
  const p = new Pipeline(ctx, timings);
  p.scope.own(det.warped); p.scope.own(det.extended);
  try {
    const { reading, refit } = await p.analyse(det.warped, det.extended, det.method);
    timings.total = performance.now() - t0;
    const out = finish(p, reading, refit, det.method, timings, keepWarp);
    out.quad = det.quad;
    return out;
  } catch (e) { p.scope.free(); throw e; }
}
