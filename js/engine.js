// Installing the offline data and starting the recognition engine (shared by the app and the test page).
//
//   await registerWorker()                      service worker (offline shell + data from Cache Storage)
//   const info = await ensureData(onProgress)   data files in Cache Storage "kk-data" (first start: download with progress;
//                                               later: version check, changed files load in the background into
//                                               "kk-data-next" and are swapped in on the next start)
//   const ctx = await loadEngine(onStatus)      { cv, names, db, art } for pipeline.js (files come from the cache via the worker)
//
// pack/version.json (tools/make_version.py) lists every file with size, gzipped size and hash. Each cached response carries
// its hash in the header x-kk-hash, so a half-finished download is noticed and completed.

import { initOcr } from './ocr.js';
import { ArtIndex } from './arthash.js';
import { NameIndex, CardDb } from './match.js';
import { recognizeWarped } from './pipeline.js';

const DATA = 'kk-data', NEXT = 'kk-data-next';
const MANIFEST = 'pack/version.json';
const TYPES = { js: 'text/javascript', mjs: 'text/javascript', wasm: 'application/wasm', json: 'application/json', onnx: 'application/octet-stream', bin: 'application/octet-stream' };
const ROOT = new URL('../', import.meta.url);   // web/ (pages in dev/ load the same files)
const abs = p => new URL(p, ROOT).href;
const hasCaches = () => typeof caches !== 'undefined';

const withTimeout = async (p, ms, what) => {
  let timer;
  try { return await Promise.race([p, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(what + ': Zeitüberschreitung')), ms); })]); }
  finally { clearTimeout(timer); }
};

/** -> { ok, reason } ; never waits longer than a few seconds (a worker that fails to install must not block the start) */
export async function registerWorker(log = () => {}) {
  if (!('serviceWorker' in navigator) || !isSecureContext) return { ok: false, reason: 'unsupported' };
  try {
    const reg = await withTimeout(navigator.serviceWorker.register('sw.js'), 8000, 'register');
    log('worker registered', { active: !!reg.active, installing: !!reg.installing, waiting: !!reg.waiting });
    await withTimeout(navigator.serviceWorker.ready, 8000, 'ready');
    if (!navigator.serviceWorker.controller) {
      // first visit: the worker claims the page in activate; wait a moment for it
      await new Promise(res => { const t = setTimeout(res, 3000); navigator.serviceWorker.addEventListener('controllerchange', () => { clearTimeout(t); res(); }, { once: true }); });
    }
    return { ok: !!navigator.serviceWorker.controller, reason: navigator.serviceWorker.controller ? 'controlled' : 'not controlling' };
  } catch (e) { console.warn('service worker', e); return { ok: false, reason: String(e?.message || e) }; }
}

async function readJson(cacheName, path) {
  const c = await caches.open(cacheName);
  const r = await c.match(abs(path));
  return r ? r.json() : null;
}

async function fetchManifest() {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(abs(MANIFEST) + '?t=' + Date.now(), { cache: 'no-store', signal: ctl.signal });
    return r.ok ? await r.json() : null;
  } catch { return null; } finally { clearTimeout(t); }
}

/** files of `manifest` that are missing in `cacheName` or carry another hash */
async function missingFiles(cacheName, manifest) {
  const c = await caches.open(cacheName);
  const out = [];
  for (const f of manifest.files) {
    const r = await c.match(abs(f.path));
    if (!r || r.headers.get('x-kk-hash') !== f.hash) out.push(f);
  }
  return out;
}

async function download(cacheName, files, onBytes) {
  const c = await caches.open(cacheName);
  for (const f of files) {
    // ?kkv= makes the worker go to the network instead of answering with the old cached copy
    const ctl = new AbortController();
    let timer;
    const touch = () => { clearTimeout(timer); timer = setTimeout(() => ctl.abort(), 30000); };
    let blob;
    touch();
    try {
      const res = await fetch(abs(f.path) + '?kkv=' + f.hash, { cache: 'no-store', signal: ctl.signal });
      if (!res.ok) throw new Error(`${f.path}: HTTP ${res.status}`);
      if (res.body && res.body.getReader) {
        const reader = res.body.getReader(), parts = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          touch();
          parts.push(value);
          onBytes(value.byteLength);
        }
        blob = new Blob(parts);
      } else { blob = await res.blob(); onBytes(blob.size); }
    } finally { clearTimeout(timer); }

    const type = TYPES[f.path.split('.').pop()] || 'application/octet-stream';
    await c.put(abs(f.path), new Response(blob, { headers: { 'Content-Type': type, 'Content-Length': String(blob.size), 'x-kk-hash': f.hash } }));
  }
}

async function putManifest(cacheName, manifest) {
  const c = await caches.open(cacheName);
  await c.put(abs(MANIFEST), new Response(JSON.stringify(manifest), { headers: { 'Content-Type': 'application/json' } }));
}

/** a fully downloaded update from the last run goes live now (before anything is loaded from the cache) */
async function applyStagedUpdate() {
  if (!(await caches.has(NEXT))) return false;
  const next = await readJson(NEXT, MANIFEST);
  if (!next || (await missingFiles(NEXT, next)).length) return false;   // still incomplete: continues later
  const src = await caches.open(NEXT), dst = await caches.open(DATA);
  for (const f of next.files) {
    const have = await dst.match(abs(f.path));
    if (have && have.headers.get('x-kk-hash') === f.hash) continue;
    await dst.put(abs(f.path), await src.match(abs(f.path)));
  }
  await putManifest(DATA, next);
  await caches.delete(NEXT);
  return true;
}

let backgroundUpdate = null;

/**
 * Makes sure all data files are in the cache.
 * onProgress({ done, total, phase: 'install' | 'update' }) in bytes (uncompressed).
 * -> { version, packDate, size, installedNow, updated (staged update applied), update: Promise|null (background download) }
 * Throws { code: 'offline' } when nothing is installed yet and there is no connection.
 */
export async function ensureData(onProgress = () => {}, log = () => {}) {
  if (!hasCaches()) {   // no Cache Storage (plain http on a LAN address): everything straight from the network
    const m = await fetchManifest();
    return { version: m?.version || '?', packDate: m?.pack_date || '?', size: m?.size || 0, installedNow: false, updated: false, update: null, uncached: true };
  }
  const updated = await applyStagedUpdate().catch(e => { console.warn('staged update', e); return false; });
  log('data: staged checked', { updated });
  let installed = await readJson(DATA, MANIFEST);
  const remote = await fetchManifest();
  let installedNow = false;
  const incomplete = installed ? await missingFiles(DATA, installed) : null;
  log('data: state', { installed: installed?.version || null, remote: remote?.version || null, incomplete: incomplete ? incomplete.length : null });
  if (!installed || incomplete.length) {
    const target = remote || installed;
    if (!remote) { const e = new Error('Keine Verbindung'); e.code = 'offline'; throw e; }
    const todo = await missingFiles(DATA, target);
    const total = todo.reduce((s, f) => s + f.size, 0);
    let done = 0;
    onProgress({ done, total, phase: 'install' });
    await download(DATA, todo, n => { done += n; onProgress({ done, total, phase: 'install' }); });
    await putManifest(DATA, target);
    installed = target;
    installedNow = true;
  }
  let update = null;
  if (remote && remote.version !== installed.version) {
    update = backgroundUpdate || (backgroundUpdate = (async () => {
      const todo = await missingFiles(NEXT, remote);
      // unchanged files are taken over from the current cache instead of downloading them again
      const cur = await caches.open(DATA), next = await caches.open(NEXT);
      const fetchList = [];
      for (const f of todo) {
        const have = await cur.match(abs(f.path));
        if (have && have.headers.get('x-kk-hash') === f.hash) await next.put(abs(f.path), have);
        else fetchList.push(f);
      }
      const total = fetchList.reduce((s, f) => s + f.size, 0);
      let done = 0;
      await download(NEXT, fetchList, n => { done += n; onProgress({ done, total, phase: 'update' }); });
      await putManifest(NEXT, remote);
      return { version: remote.version, packDate: remote.pack_date, bytes: total };
    })());
  }
  return { version: installed.version, packDate: installed.pack_date, size: installed.size, gz: installed.gz, installedNow, updated, update };
}

/** what a first install would download (for the "about 30 MB" note), null when offline */
export async function remoteManifest() { return fetchManifest(); }
export async function installedManifest() { return hasCaches() ? readJson(DATA, MANIFEST) : null; }

// ---- engine ---------------------------------------------------------------------------------------------------------

function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Laden fehlgeschlagen: ' + src)); document.head.appendChild(s); });
}

export async function loadCv() {
  await withTimeout(loadScript(abs('vendor/opencv.js')), 30000, 'Bildverarbeitung laden');
  let c = window.cv;
  if (c instanceof Promise) c = await c;
  // poll instead of onRuntimeInitialized: the callback may already have fired
  const t0 = performance.now();
  while (!window.cv?.Mat) {
    if (performance.now() - t0 > 30000) throw new Error('OpenCV startet nicht');
    await new Promise(r => setTimeout(r, 50));
  }
  // opencv.js (Emscripten MODULARIZE) carries a `then` method: returned from an async
  // function, the promise adopts it again and again and the page freezes (05.11.)
  delete window.cv.then;
  return window.cv;
}

/**
 * Loads OpenCV, the OCR models and the card data (all from the cache once installed) and runs one warm-up.
 * onStatus(text, timings) is called per step. opts: { ep, threads, noCache } (noCache: fetch the pack past the HTTP cache).
 */
export async function loadEngine(onStatus = () => {}, { ep = 'wasm', threads = 1 } = {}) {
  const t = {};
  const step = async (key, text, p) => {
    onStatus(text + ' …', t);
    const t0 = performance.now();
    const v = await p;
    t[key] = Math.round(performance.now() - t0);
    return v;
  };
  const t0 = performance.now();
  // opencv.js and onnxruntime-web both bring an Emscripten runtime; loaded at the same time the page hung (05.11.)
  const cv = await step('opencv', 'Bildverarbeitung laden', loadCv());
  const ocrInfo = await step('models', 'Texterkennung laden', Promise.race([initOcr({ ep, threads }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('Texterkennung startet nicht (120 s)')), 120000))]));
  const get = async (p, kind) => {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 30000);
    try {
      const r = await fetch(abs(p), { signal: ctl.signal });
      if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
      return await r[kind]();
    } finally { clearTimeout(timer); }
  };
  const [namesJson, printsJson, artBuf, artCards, sets] = await step('pack', 'Kartendaten laden', Promise.all([
    get('pack/names.json', 'json'), get('pack/prints.json', 'json'), get('pack/art.bin', 'arrayBuffer'),
    get('pack/art.json', 'json'), get('pack/sets.json', 'json'),
  ]));
  const db = new CardDb(printsJson);
  db.useArt(artCards);
  const ctx = { cv, names: new NameIndex(namesJson, sets), db, art: new ArtIndex(artBuf, artCards), ocrInfo };
  db.setOracles(ctx.names.oraclesHex);
  t.total = Math.round(performance.now() - t0);
  // warm-up run on a blank card so the first real scan is not the cold one
  onStatus('Aufwärmen …', t);
  const blank = new cv.Mat(1400, 1000, cv.CV_8UC4, new cv.Scalar(200, 200, 200, 255));
  const tw = performance.now();
  try { await recognizeWarped(ctx, blank); } finally { blank.delete(); }
  t.warmup = Math.round(performance.now() - tw);
  ctx.timings = t;
  return ctx;
}

/** persistent storage (WebKit grants it by heuristics, e.g. for home screen apps); -> true/false/null (unsupported) */
export async function requestPersist() {
  if (!navigator.storage?.persist) return null;
  try { return (await navigator.storage.persisted()) || (await navigator.storage.persist()); } catch { return null; }
}
export async function storageInfo() {
  const out = { persisted: null, usage: null, quota: null };
  try { if (navigator.storage?.persisted) out.persisted = await navigator.storage.persisted(); } catch { /* */ }
  try { if (navigator.storage?.estimate) Object.assign(out, await navigator.storage.estimate()); } catch { /* */ }
  return out;
}
