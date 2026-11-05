// Kartenkiste service worker: the app works offline after the first start.
//
// - App shell (html, css, js, icons): network first, the cached copy when offline. Updated on every online load,
//   so a new version of the code is live right away (a stale cached page broke the phone test once).
// - Data files (vendor, models, pack; listed in pack/version.json): cache first from "kk-data". The page installs
//   them there itself (engine.js, with a progress bar); the worker only answers from that cache.
// - Card images from cards.scryfall.io: cache first in "kk-img" (cards seen once also show offline).
// - Everything else (test set, dev pages, /log): straight to the network.

const SHELL_CACHE = 'kk-shell-v9';
const DATA_CACHE = 'kk-data';
const IMG_CACHE = 'kk-img';
const IMG_MAX = 3000;   // entries; the oldest are dropped beyond that (small images ~15 KB each)
const SHELL = [
  './', 'index.html', 'hilfe.html', 'style.css', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
  'js/app.js', 'js/quality.js', 'js/shutter.js', 'js/engine.js', 'js/store.js', 'js/backup.js', 'js/live.js', 'js/help.js', 'js/prices.js', 'js/storage.js', 'js/storeui.js', 'js/commander.js', 'js/decks.js', 'js/deckui.js', 'js/typing.js', 'js/changelog.js',
  'js/detect.js', 'js/ocr.js', 'js/match.js', 'js/fuzz.js', 'js/arthash.js', 'js/pipeline.js',
];
const DATA_PREFIXES = ['vendor/', 'models/', 'pack/'];

// install never fails and never hangs: each shell file is cached on its own (8 s limit); a file that is missing now is
// cached later by the network-first handler. On the iPhone the old cache.addAll() install never finished (05.11.),
// the page waited for `ready` forever.
self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const t0 = Date.now();
    const results = await Promise.allSettled(SHELL.map(async u => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      try {
        const res = await fetch(u, { cache: 'no-store', signal: ctl.signal });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        await cache.put(u, res);
      } finally { clearTimeout(timer); }
    }));
    const failed = results.map((r, i) => r.status === 'rejected' ? `${SHELL[i]}: ${r.reason?.message || r.reason}` : null).filter(Boolean);
    report('sw-install', { ms: Date.now() - t0, failed });
    await self.skipWaiting();
  })());
});

// test server only (it answers /log-enabled with 204): the worker reports its install there
async function report(kind, data) {
  try {
    const on = await fetch('log-enabled', { cache: 'no-store' });
    if (on.status !== 204) return;
    await fetch('log', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, app: 'kartenkiste', at: new Date().toISOString(), env: { ua: navigator.userAgent, sw: true }, data }) });
  } catch { /* offline or static host */ }
}

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('kk-shell-') && k !== SHELL_CACHE) await caches.delete(k);
    await self.clients.claim();
    report('sw-activate', {});
  })());
});

const scopePath = () => new URL(self.registration.scope).pathname;

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname === 'cards.scryfall.io') { e.respondWith(image(req, e)); return; }
  if (url.origin !== location.origin) return;
  const rel = url.pathname.startsWith(scopePath()) ? url.pathname.slice(scopePath().length) : null;
  if (rel === null) return;
  if (rel === 'pack/version.json') return;   // always the network (the page reads the installed copy from the cache)
  if (url.searchParams.has('kkv')) return;   // the page downloading a data file into the cache
  if (DATA_PREFIXES.some(p => rel.startsWith(p))) { e.respondWith(data(req, rel)); return; }
  if (rel.startsWith('testset/') || rel.startsWith('dev/') || rel.startsWith('log')) return;
  e.respondWith(shell(req, rel, e));
});

async function data(req, rel) {
  const cache = await caches.open(DATA_CACHE);
  const hit = await cache.match(new URL(rel, self.registration.scope).href);
  return hit || fetch(req);
}

async function shell(req, rel, event) {
  const cache = await caches.open(SHELL_CACHE).catch(() => null);
  const key = req.mode === 'navigate' ? (rel === '' || rel === 'index.html' ? 'index.html' : rel) : rel;
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 8000);
  let response;
  try {
    response = await fetch(req, { cache: 'no-store', signal: ctl.signal });
    if (response.ok) {
      // Keep the timeout active through the body: headers alone do not mean a script finished loading.
      const body = await response.arrayBuffer();
      const complete = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      if (cache && response.type === 'basic') event.waitUntil(cache.put(key, complete.clone()).catch(() => {}));
      return complete;
    }
  } catch { response = null; /* Offline or stalled network: use the installed shell. */ }
  finally { clearTimeout(timer); }
  const hit = cache && await cache.match(key, { ignoreSearch: true }).catch(() => null);
  if (hit) return hit;
  if (req.mode === 'navigate' && cache) { const index = await cache.match('index.html').catch(() => null); if (index) return index; }
  if (response) return response;
  return new Response('Keine Verbindung. Bitte die App erneut öffnen.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

async function image(req, event) {
  const cache = await caches.open(IMG_CACHE).catch(() => null);
  const hit = cache && await cache.match(req.url).catch(() => null);
  if (hit) return hit;
  const res = await fetch(req);
  if (cache && res.ok && (res.type === 'cors' || res.type === 'basic')) {
    // Cache quota must not turn an already loaded image into a failed request.
    event.waitUntil(cache.put(req.url, res.clone()).then(() => trimImages(cache)).catch(() => {}));
  }
  return res;
}

let trimming = false;
async function trimImages(cache) {
  if (trimming) return;
  trimming = true;
  try {
    const keys = await cache.keys();
    for (let i = 0; i < keys.length - IMG_MAX; i++) await cache.delete(keys[i]);
  } finally { trimming = false; }
}
