import { CaptureQuality } from './quality.js';
import { shutterFeedback } from './shutter.js';
// Kartenkiste app: scan -> add to the collection, collection list, backup file, help, first-start intro.
// The engine (OpenCV, OCR, card data) loads from Cache Storage after the first start (engine.js); the collection lives in
// IndexedDB (store.js). UI text German.

import { registerWorker, ensureData, loadEngine, requestPersist, storageInfo, installedManifest } from './engine.js';
import { recognize } from './pipeline.js';
import { guideRect } from './detect.js';
import * as store from './store.js';
import { saveBackup, readBackup } from './backup.js';
import { LiveHint } from './live.js';
import { helpHtml, INSTALL, SCAN_TIPS } from './help.js';
import { loadPrices, refreshPrices, priceNow, priceOf, fmtPrice, totalOf, pricesAt, stale } from './prices.js';
import * as storage from './storage.js';
import * as decks from './decks.js';
import { RELEASES, newestId, since } from './changelog.js';
import { initTyping, openTyping } from './typing.js';
import { initDeckUi, renderDecks, addCardTo } from './deckui.js';
import { initStorageUi, openSorting, openStorage, entryBox, bindEntryBox, sectionToast, systemChoice } from './storeui.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const imgUrl = (id, size = 'normal') => `https://cards.scryfall.io/${size}/front/${id[0]}/${id[1]}/${id}.jpg`;
const params = new URLSearchParams(location.search);
const ua = navigator.userAgent;
const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
const isAndroid = /Android/.test(ua);
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const fmtDate = iso => { try { return new Date(iso).toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' }); } catch { return iso; } };
const LANG_DE = { en: 'Englisch', de: 'Deutsch', fr: 'Französisch', it: 'Italienisch', es: 'Spanisch', pt: 'Portugiesisch', ja: 'Japanisch', ko: 'Koreanisch', ru: 'Russisch', zhs: 'Chinesisch', zht: 'Chinesisch (trad.)', ph: 'Phyrexianisch' };
const CONF = { high: ['Sicher erkannt', 'ok'], medium: ['Wahrscheinlich richtig', 'mid'], low: ['Unsicher, bitte prüfen', 'bad'], none: ['Nicht erkannt', 'bad'] };

let ctx = null;            // recognition engine
let stream = null;
let logEnabled = false;    // dev server only (/log): scans are reported for the test runs
let installPrompt = null;  // Android: beforeinstallprompt
let reminderShown = false;
let scanning = false;
const live = new LiveHint($('video'), $('overlay'), onHint);
const captureQuality = new CaptureQuality(navigator.deviceMemory);

// ---- small UI helpers -------------------------------------------------------------------------------------------------
let toastTimer = 0;
function toast(html, { ms = 3500, action = null } = {}) {
  const t = $('toast');
  t.innerHTML = `<span>${html}</span>${action ? `<button>${esc(action.label)}</button>` : ''}`;
  if (action) t.querySelector('button').onclick = () => { t.hidden = true; action.run(); };
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
function chip(text, kind = '') {
  const c = $('chip');
  if (c.textContent === text) return;
  console.log('chip ' + text);
  c.textContent = text; c.className = 'chip ' + kind;
  if (!ctx && stream) onHint('idle');   // the hint over the camera shows the loading stage too
  stage(text);
}
// test server only: every loading stage goes to /log, so a start that hangs on the phone shows where
let stageT0 = performance.now(), lastStage = '';
function stage(text) {
  const key = text.replace(/\d+ %/, m => (Math.floor(parseInt(m) / 25) * 25) + ' %');   // progress in 25 % steps
  if (key === lastStage) return;
  lastStage = key;
  sendLog('stage', { stage: text, ms: Math.round(performance.now() - stageT0) });
}

// beforeClose() -> false keeps the sheet open (asked by ×, a tap beside the sheet and every closeSheet() call)
function openSheet(html, onClose = null, { beforeClose = null } = {}) {
  const s = $('sheet'), b = $('sheet-body');
  b.innerHTML = `<button class="sheet-close" aria-label="Schließen">×</button>` + html;
  s.hidden = false;
  s._onClose = onClose;
  s._beforeClose = beforeClose;
  b.querySelector('.sheet-close').onclick = () => closeSheet();
  b.onclick = null; b.onchange = null;
  b.scrollTop = 0;
  return b;
}
function closeSheet(force = false) {
  const s = $('sheet');
  if (s.hidden) return true;
  if (!force && s._beforeClose && !s._beforeClose()) return false;
  s._beforeClose = null;
  s.hidden = true;
  $('sheet-body').innerHTML = '';
  const f = s._onClose; s._onClose = null;
  if (f) f();
  return true;
}
$('sheet').addEventListener('click', e => { if (e.target === $('sheet')) closeSheet(); });

// ---- screens --------------------------------------------------------------------------------------------------------
let current = 'scan';
function show(name) {
  current = name;
  for (const s of ['scan', 'coll', 'decks', 'help']) $('screen-' + s).hidden = s !== name;
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('on', b.dataset.screen === name);
  if (name === 'scan') { maybeStartCamera(); } else { stopCamera(); }
  if (name === 'coll') renderCollection();
  if (name === 'decks') renderDecks();
  if (name === 'help') renderHelp();
  window.scrollTo(0, 0);
}
for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => show(b.dataset.screen);
$('go-coll').onclick = () => show('coll');

// ---- camera + live hint -----------------------------------------------------------------------------------------------
let cameraStarting = false;   // the camera permission prompt may be open: "Was ist neu?" waits for it
let cameraEpoch = 0;
async function startCamera() {
  if (stream) return true;
  if (cameraStarting || document.hidden || current !== 'scan') return false;
  cameraStarting = true;
  const epoch = cameraEpoch;
  let candidate = null;
  try {
    candidate = await navigator.mediaDevices.getUserMedia({ audio: false, video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 3840 }, height: { ideal: 2160 },
      frameRate: { ideal: 15, max: 24 },
    } });
    // Permission requests can resolve after leaving the camera or backgrounding the app.
    if (epoch !== cameraEpoch || document.hidden || current !== 'scan') {
      candidate.getTracks().forEach(t => t.stop());
      return false;
    }
    stream = candidate;
    const v = $('video');
    v.srcObject = stream;
    await v.play();
    if (epoch !== cameraEpoch || stream !== candidate) return false;
    $('cam-start').hidden = true;
    $('scan-note').textContent = '';
    store.setMeta('cameraOk', true).catch(e => console.warn('camera preference', e));
    placeGuide();
    updateShutter();
    if (ctx) live.start(ctx.cv);
    $('hint').hidden = false;
    onHint(ctx ? 'searching' : 'idle');
    return true;
  } catch (e) {
    candidate?.getTracks().forEach(t => t.stop());
    if (epoch !== cameraEpoch) return false;
    if (stream === candidate) stream = null;
    $('video').srcObject = null;
    $('cam-start').hidden = false;
    $('scan-note').innerHTML = e && e.name === 'NotAllowedError'
      ? 'Die Kamera ist nicht erlaubt. Erlaube sie in den Einstellungen des Handys für diese App und tippe dann auf „Kamera starten“.'
      : 'Die Kamera startet nicht: ' + esc(e?.message || e);
    updateShutter();
    return false;
  } finally {
    cameraStarting = false;
    if (epoch !== cameraEpoch && current === 'scan' && !document.hidden) maybeStartCamera();
  }
}
function stopCamera() {
  cameraEpoch++;
  live.stop();
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  $('video').srcObject = null;
  $('cam-start').hidden = false;
  $('hint').hidden = true;
  updateShutter();
}
async function maybeStartCamera() {
  if (current !== 'scan' || stream || cameraStarting || document.hidden || !$('intro').hidden) return;
  if (await store.getMeta('cameraOk', false)) startCamera();
}
$('cam-start').onclick = () => startCamera();
document.addEventListener('visibilitychange', () => { if (document.hidden) stopCamera(); else maybeStartCamera(); });

function placeGuide() {
  const v = $('video'), g = $('guide');
  const fw = v.videoWidth, fh = v.videoHeight;
  if (!fw) { g.style.display = 'none'; return; }
  const [x0, y0, x1, y1] = guideRect(fw, fh);
  const box = v.getBoundingClientRect(), sc = Math.max(box.width / fw, box.height / fh);
  const ox = (box.width - fw * sc) / 2, oy = (box.height - fh * sc) / 2;
  Object.assign(g.style, { display: 'block', left: ox + x0 * fw * sc + 'px', top: oy + y0 * fh * sc + 'px', width: (x1 - x0) * fw * sc + 'px', height: (y1 - y0) * fh * sc + 'px' });
}
addEventListener('resize', () => stream && placeGuide());
$('video').addEventListener('loadedmetadata', () => { placeGuide(); updateShutter(); });
$('video').addEventListener('loadeddata', updateShutter);

function onHint(state) {
  const h = $('hint');
  $('guide').classList.toggle('found', state === 'found');
  if (!ctx) { h.className = 'hint'; h.textContent = $('chip').textContent || 'Erkennung startet …'; return; }
  if (state === 'found') { h.className = 'hint found'; h.textContent = 'Karte erkannt ✓ Jetzt auslösen'; }
  else { h.className = 'hint'; h.textContent = 'Karte in den Rahmen legen'; }
}
function updateShutter() { const v = $('video'); $('shutter').disabled = !(ctx && stream && v.readyState >= 2 && v.videoWidth && v.videoHeight) || scanning; }

// ---- scanning ---------------------------------------------------------------------------------------------------------
async function scanFrame() {
  const v = $('video');
  if (!ctx || !stream || scanning || v.readyState < 2 || !v.videoWidth || !v.videoHeight) return null;
  const epoch = cameraEpoch;
  scanning = true; updateShutter();
  live.pause(true);
  const { cv } = ctx;
  let c = null, src = null, r = null;
  try {
    $('cam').classList.add('busy');
    c = document.createElement('canvas');
    let copyMs = 0, pixels = 0, feedbackSent = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const size = captureQuality.size(v.videoWidth, v.videoHeight);
      pixels = size.width * size.height;
      try {
        const t = performance.now();
        c.width = size.width; c.height = size.height;
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        copyMs = performance.now() - t;
        if (!feedbackSent) { shutterFeedback(v); feedbackSent = true; }
        await new Promise(resolve => setTimeout(resolve, 0));
        if (epoch !== cameraEpoch || document.hidden || current !== 'scan') return null;
        const readStart = performance.now();
        src = cv.imread(c);
        copyMs += performance.now() - readStart;
        break;
      } catch (e) {
        const allocationError = e instanceof RangeError || /memory|allocat|enlarge/i.test(String(e?.message || e));
        if (attempt || !allocationError || !captureQuality.lower(pixels)) throw e;
        c.width = c.height = 0;
        toast('Die Bildgröße wurde an den verfügbaren Speicher angepasst.');
      }
    }
    r = await recognize(ctx, { src, guide: guideRect(src.cols, src.rows), keepWarp: logEnabled });
    captureQuality.record(pixels, v.videoWidth * v.videoHeight, copyMs, r.confidence);
    if (logEnabled) sendScanLog(r, src);
    return epoch === cameraEpoch && current === 'scan' && !document.hidden ? r : null;
  } catch (e) {
    console.error(e);
    toast('Beim Erkennen ist ein Fehler passiert. Du kannst es erneut versuchen: ' + esc(e?.message || e));
    return null;
  } finally {
    try { src?.delete(); } catch (e) { console.warn('scan cleanup', e); }
    try { r?.warped?.delete(); } catch (e) { console.warn('warp cleanup', e); }
    if (c) { c.width = 0; c.height = 0; }
    $('cam').classList.remove('busy');
    scanning = false; updateShutter();
    live.pause(false);
  }
}
$('shutter').onclick = async () => {
  const r = await scanFrame();
  if (r) { live.pause(true); showResult(r); }
};

function cardOf(i) {
  const row = ctx.db.row(i);
  const rel = row.rel ? String(row.rel) : '';   // released as yyyymmdd
  return { i, card_id: row.id, name: row.name, printed_name: row.printed_name, set_code: row.set_code, collector_number: row.collector_number, lang: row.lang,
    rel: rel.length === 8 ? `${rel.slice(0, 4)}-${rel.slice(4, 6)}-${rel.slice(6)}` : rel, oracle: row.oracle, oracle_id: ctx.db.oracleId(row.oracle) };
}

// result sheet: the best card (or the one picked by hand) with add / other version / discard
function showResult(r) {
  const best = r.detected && r.candidates?.length && r.confidence !== 'none' ? r.candidates[0] : null;
  if (!best) {
    const b = openSheet(`<h2>Keine Karte erkannt</h2>
      <p>${r.detected ? 'Die App hat eine Karte gefunden, aber nicht lesen können.' : 'Die App hat im Bild keine Karte gefunden.'}
      Lege die Karte auf eine dunkle, ruhige Unterlage und warte, bis der Rahmen grün wird.</p>
      <div class="buttons"><button class="primary" data-act="again">Nochmal scannen</button><button data-act="search">Karte suchen</button></div>`, () => live.pause(false));
    b.querySelector('[data-act=again]').onclick = closeSheet;
    b.querySelector('[data-act=search]').onclick = () => openSearch();
    return;
  }
  const alts = r.candidates.slice(1).map(c => c.i);
  showCard(cardOf(best.i), { confidence: r.confidence, alts });
}

// adds copies to the collection (shared by scan, typing, decks) -> { entry, events }; proxy marks the entry (it counts for the whole entry)
async function addToCollection(card, { qty = 1, foil = 0, proxy = 0 } = {}) {
  const before = store.items.get(store.keyOf(card.card_id, foil));
  let e = await store.addCard(card, { foil, qty });
  if (proxy && (!before || before.proxy)) e = await store.setProxy(e.key, true);
  else if (proxy) toast('Diese Karte ist schon als echte Karte in der Sammlung. Setze „Proxy“ in der Karte selbst, wenn alle Exemplare Proxys sind.', { ms: 6000 });
  const events = await storage.placeCopies();
  if (events.length) setTimeout(() => sectionToast(events), 800);
  checkReminder(true);
  return { entry: store.items.get(e.key) || e, events };
}
let scanDeckId = null;   // deck mode: a scanned copy goes into the collection and this deck
const scanDeck = () => (scanDeckId && store.decks.has(scanDeckId) ? scanDeckId : null);
async function setScanDeck(id) { scanDeckId = id; await store.setMeta('scanDeck', id); renderScanDeck(); }
function renderScanDeck() {
  const el = $('scan-deck'), d = scanDeck() && store.decks.get(scanDeck());
  el.innerHTML = d ? `<span>Scannt ins Deck <b>${esc(d.name)}</b></span><button class="xs" data-act="off">Aus</button>` : '';
  el.hidden = !d;
  if (d) el.querySelector('[data-act=off]').onclick = () => setScanDeck(null);
}
const collectionTarget = () => ({ label: 'Zur Sammlung hinzufügen', addLabel: 'Zur Sammlung hinzufügen', add: async (card, o) => {
  const { entry } = await addToCollection(card, o);
  if (!o.quiet) toast(`Hinzugefügt: <b>${esc(card.printed_name || card.name)}</b> (jetzt ${entry.qty}×)`);
} });

function showCard(card, { confidence = null, alts = [], qty = 1, foil = 0 } = {}) {
  const [label, cls] = confidence ? CONF[confidence] : ['Von dir gewählt', 'ok'];
  const name = card.printed_name || card.name;
  const have = (store.items.get(store.keyOf(card.card_id, 0))?.qty || 0) + (store.items.get(store.keyOf(card.card_id, 1))?.qty || 0);
  const b = openSheet(`
    <div class="result">
      <img class="cardimg" crossorigin="anonymous" src="${imgUrl(card.card_id)}" alt="${esc(name)}">
      <div class="result-info">
        <h2>${esc(name)}</h2>
        ${card.printed_name && card.printed_name !== card.name ? `<div class="small">${esc(card.name)}</div>` : ''}
        <div class="small">${esc(card.set_code.toUpperCase())} #${esc(card.collector_number)} · ${esc(LANG_DE[card.lang] || card.lang)}</div>
        <div class="conf ${cls}">${label}</div>
        ${have ? `<div class="small">Schon in der Sammlung: ${have}×</div>` : ''}
        <div class="small" data-price>${navigator.onLine ? 'Preis wird geladen …' : ''}</div>
        <div class="row">
          <div class="stepper"><button data-act="minus" aria-label="weniger">−</button><b data-qty>${qty}</b><button data-act="plus" aria-label="mehr">+</button></div>
          <label class="check"><input type="checkbox" data-foil ${foil ? 'checked' : ''}> Foil</label>
          <label class="check"><input type="checkbox" data-proxy> Proxy</label>
        </div>
      </div>
    </div>
    <div class="buttons stack">
      <button class="primary" data-act="add">${scanDeck() ? esc(`In Sammlung und Deck „${store.decks.get(scanDeck()).name}“`) : 'Zur Sammlung hinzufügen'}</button>
      ${scanDeck() ? '<button data-act="addonly">Nur in die Sammlung</button>' : ''}
      ${scanDeck() && storage.rolesReady() && card.oracle_id && !store.decks.get(scanDeck()).commanders.some(c => c.oracle_id === card.oracle_id) ? '<button data-act="addcmd">Als Commander des Decks</button>' : ''}
      <button data-act="other">Andere Version wählen</button>
      <button data-act="discard" class="ghost">Verwerfen</button>
    </div>`, () => live.pause(false));
  let n = qty;
  const q = b.querySelector('[data-qty]');
  b.querySelector('[data-act=minus]').onclick = () => { n = Math.max(1, n - 1); q.textContent = n; };
  b.querySelector('[data-act=plus]').onclick = () => { n = Math.min(99, n + 1); q.textContent = n; };
  b.querySelector('[data-act=discard]').onclick = closeSheet;
  // live price (Scryfall), only when online; follows the foil switch
  const priceEl = b.querySelector('[data-price]');
  const showPrice = () => { const p = priceOf({ card_id: card.card_id, foil: b.querySelector('[data-foil]').checked ? 1 : 0 }); priceEl.textContent = p ? 'Preis: ' + fmtPrice(p) : 'Kein Preis bei Scryfall'; };
  if (navigator.onLine) priceNow(card).then(p => { if (priceEl.isConnected) { if (p !== null || priceOf({ card_id: card.card_id, foil: 0 })) showPrice(); else priceEl.textContent = ''; } });
  b.querySelector('[data-foil]').addEventListener('change', () => { if (priceEl.textContent) showPrice(); });
  b.querySelector('[data-act=other]').onclick = () => openVersions(card, alts, { qty: n, foil: b.querySelector('[data-foil]').checked ? 1 : 0 });
  const doAdd = async (toDeck, asCommander = false) => {
    const foilNow = b.querySelector('[data-foil]').checked ? 1 : 0, proxy = b.querySelector('[data-proxy]').checked ? 1 : 0;
    if (asCommander) { const ok = await addCardTo(scanDeck(), card, { qty: 1, foil: foilNow, proxy, own: true, commander: true }); if (ok === false) return; closeSheet(); return; }
    const { entry: e, events } = await addToCollection(card, { foil: foilNow, qty: n, proxy });
    if (toDeck) await decks.addCard(scanDeck(), card, n);
    closeSheet();
    const fresh = e.copies.slice(-n);
    const where = fresh.some(c => storage.hintOf(e, c) === 'binder') ? `gehört in den Ordner (${fmtPrice(priceOf(e))})`
      : fresh[0]?.h ? 'Fach: ' + esc(storage.sectionName(fresh[0].h)) : '';
    toast(`Hinzugefügt: <b>${esc(name)}</b>${e.qty > n ? ` (jetzt ${e.qty}×)` : ''}${toDeck ? ` · Deck „${esc(store.decks.get(scanDeck()).name)}“` : ''}${where ? '<br><span class="small">' + where + '</span>' : ''}`, {
      action: { label: 'Rückgängig', run: async () => { await store.setQty(e.key, e.qty - n); if (toDeck) { const dd = store.decks.get(scanDeck()); const cur = dd?.cards.find(c => c.oracle_id === card.oracle_id); if (cur) await decks.setQty(dd.id, card.oracle_id, cur.qty - n); } toast('Rückgängig gemacht'); } },
    });
  };
  b.querySelector('[data-act=add]').onclick = () => doAdd(!!scanDeck());
  b.querySelector('[data-act=addonly]')?.addEventListener('click', () => doAdd(false));
  b.querySelector('[data-act=addcmd]')?.addEventListener('click', () => doAdd(false, true));
}

// other printings: the other candidates of the scan first, then every printing of the card (newest first)
function openVersions(card, alts, keep) {
  const seen = new Set([card.i]);
  const altCards = alts.filter(i => !seen.has(i) && seen.add(i)).map(cardOf);
  const prints = ctx.db.printingsOf(card.oracle).filter(i => !seen.has(i)).map(cardOf)
    .sort((a, b) => (b.rel || '').localeCompare(a.rel || '') || a.set_code.localeCompare(b.set_code) || a.collector_number.localeCompare(b.collector_number, 'en', { numeric: true }));
  const row = c => `<li data-i="${c.i}"><img loading="lazy" crossorigin="anonymous" src="${imgUrl(c.card_id, 'small')}" alt="">
    <div><b>${esc(c.printed_name || c.name)}</b><div class="small">${esc(c.set_code.toUpperCase())} #${esc(c.collector_number)} · ${esc(LANG_DE[c.lang] || c.lang)}${c.rel ? ' · ' + esc(c.rel.slice(0, 4)) : ''}</div></div></li>`;
  const b = openSheet(`<h2>Andere Version</h2>
    ${altCards.length ? `<h3>Andere Treffer des Scans</h3><ul class="plist">${altCards.map(row).join('')}</ul>` : ''}
    <h3>Alle Drucke von ${esc(card.name)} (${prints.length + 1})</h3>
    <input type="search" data-filter placeholder="Set oder Nummer, z. B. MKM oder 123" autocomplete="off">
    <ul class="plist" data-prints></ul>
    <div class="buttons"><button data-act="search">Andere Karte suchen</button></div>`, () => live.pause(false));
  const list = b.querySelector('[data-prints]');
  const render = () => {
    const f = b.querySelector('[data-filter]').value.trim().toLowerCase();
    const hits = f ? prints.filter(c => c.set_code.includes(f) || c.collector_number.toLowerCase() === f || (c.lang === f)) : prints;
    list.innerHTML = hits.slice(0, 80).map(row).join('') + (hits.length > 80 ? `<li class="small">… und ${hits.length - 80} weitere. Filtere nach dem Set.</li>` : '');
  };
  render();
  b.querySelector('[data-filter]').oninput = render;
  b.querySelector('[data-act=search]').onclick = () => openSearch();
  b.addEventListener('click', e => {
    const li = e.target.closest('li[data-i]');
    if (li) { const c = cardOf(Number(li.dataset.i)); showCard(c, { alts, ...keep }); }
  });
}

// search by name (when a scan fails): the typing sheet (names -> card -> edition, language, quantity, foil, proxy; list mode)
function openSearch() {
  if (!ctx) { toast('Die Erkennung startet noch. Gleich nochmal versuchen.'); return; }
  live.pause(true);
  openTyping(collectionTarget());
}
$('search-open').onclick = () => openSearch();

// ---- collection -------------------------------------------------------------------------------------------------------
function renderCollection() {
  const items = [...store.items.values()];
  const total = store.totalCount();
  $('coll-count').textContent = items.length ? `${total} Karte${total === 1 ? '' : 'n'}, ${items.length} verschiedene` : '';
  renderValue(items);
  renderStoreBar(items);
  $('coll-empty').innerHTML = items.length ? '' : `<div class="box">
    <p><b>Noch keine Karten.</b> Scanne deine erste Karte. Wenn du schon eine Sicherung hast, lade sie hier.</p>
    <div class="buttons"><button class="primary" data-act="restore">Sicherung laden</button><button data-act="scan">Zum Scannen</button></div></div>`;
  if (!items.length) {
    $('coll-empty').querySelector('[data-act=restore]').onclick = () => $('file').click();
    $('coll-empty').querySelector('[data-act=scan]').onclick = () => show('scan');
  }
  const f = $('coll-filter').value.trim().toLowerCase();
  const shown = items.filter(e => !f || (e.name || '').toLowerCase().includes(f) || (e.printed_name || '').toLowerCase().includes(f) || e.set_code === f)
    .sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
  $('coll-list').innerHTML = shown.map(e => `<li data-key="${esc(e.key)}">
      <img loading="lazy" crossorigin="anonymous" src="${imgUrl(e.card_id, 'small')}" data-big="${esc(e.card_id)}" alt="">
      <div class="ci"><b>${esc(e.printed_name || e.name)}</b>
        <div class="small">${esc(e.set_code.toUpperCase())} #${esc(e.collector_number)} · ${esc(e.lang)}${e.foil ? ' · <span class="foil">Foil</span>' : ''}${e.proxy ? ' · <span class="proxy">Proxy</span>' : ''}</div>
        <div class="small place">${esc(storage.placesText(e))}</div></div>
      <div class="qty">${e.qty}×${priceOf(e) ? `<div class="small">${fmtPrice(priceOf(e))}</div>` : ''}</div></li>`).join('');
  renderReminder();
}
$('coll-filter').oninput = renderCollection;

// storage: the pile to put away and the sections / binder / Bulk
function renderStoreBar(items) {
  const el = $('coll-store');
  if (!items.length) { el.innerHTML = ''; return; }
  const n = storage.openCount();
  el.innerHTML = `<div class="storebar"><button class="${n ? 'primary' : ''}" data-act="sort">Einsortieren${n ? ` <b class="badge">${n}</b>` : ''}</button>
    <button data-act="store">Fächer &amp; Ordner</button></div>`;
  el.querySelector('[data-act=sort]').onclick = () => openSorting();
  el.querySelector('[data-act=store]').onclick = () => openStorage();
}
async function pricesFor(progress) {
  if (!navigator.onLine) { toast('Für Preise braucht die App Internet.'); return 0; }
  try {
    const n = await refreshPrices([...store.items.values()], (done, all) => progress(`Lädt ${done}/${all} …`));
    toast(`Preise geladen: ${n} von ${new Set([...store.items.values()].map(e => e.card_id)).size} Karten. Quelle: Scryfall (Cardmarket).`, { ms: 5000 });
    return n;
  } catch (e) { toast('Preise konnten nicht geladen werden: ' + esc(e?.message || e)); return 0; }
}

// collection value: live prices on a tap (Scryfall calls prices older than 24 h stale)
function renderValue(items) {
  const el = $('coll-value');
  if (!items.length) { el.innerHTML = ''; return; }
  const at = pricesAt();
  const { eur, missing, proxies } = totalOf(items);
  const when = at ? new Date(at).toLocaleString('de-DE', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }) : null;
  el.innerHTML = `<div class="value"><div>${at ? `<b>Wert ca. ${fmtPrice({ value: eur, cur: '€' })}</b>
      <div class="small">Preise vom ${esc(when)}${stale() ? ', älter als ein Tag' : ''}${missing ? ` · ${missing} Karte${missing === 1 ? '' : 'n'} ohne Euro-Preis` : ''}${proxies ? ` · ohne ${proxies} ${proxies === 1 ? 'Proxy' : 'Proxys'}` : ''}</div>`
      : '<b>Wert der Sammlung</b><div class="small">Noch keine Preise geladen.</div>'}</div>
    <button data-act="prices">Preise aktualisieren</button></div>`;
  el.querySelector('[data-act=prices]').onclick = async ev => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    await pricesFor(t => { btn.textContent = t; });
    renderCollection();
  };
}
$('coll-list').onclick = e => { const li = e.target.closest('li[data-key]'); if (li) openEntry(li.dataset.key); };
store.onChange(() => { if (current === 'coll') renderCollection(); if (current === 'decks') renderDecks(); updateDot(); });

function openEntry(key) {
  const e = store.items.get(key);
  if (!e) return;
  const name = e.printed_name || e.name;
  const b = openSheet(`<div class="result">
      <img class="cardimg" crossorigin="anonymous" src="${imgUrl(e.card_id)}" alt="${esc(name)}">
      <div class="result-info"><h2>${esc(name)}</h2>
        ${e.printed_name && e.printed_name !== e.name ? `<div class="small">${esc(e.name)}</div>` : ''}
        <div class="small">${esc(e.set_code.toUpperCase())} #${esc(e.collector_number)} · ${esc(LANG_DE[e.lang] || e.lang)}</div>
        <div class="small">Hinzugefügt am ${esc(fmtDate(e.added))}</div>
        ${priceOf(e) ? `<div class="small">Preis: ${fmtPrice(priceOf(e))} pro Karte</div>` : ''}
        <div class="row">
          <div class="stepper"><button data-act="minus" aria-label="weniger">−</button><b data-qty>${e.qty}</b><button data-act="plus" aria-label="mehr">+</button></div>
          <label class="check"><input type="checkbox" data-foil ${e.foil ? 'checked' : ''}> Foil</label>
          <label class="check" title="Nachgedruckte Karte: zählt nicht zum Sammlungswert und kommt nicht in den Ordner oder in Bulk."><input type="checkbox" data-proxy ${e.proxy ? 'checked' : ''}> Proxy</label>
        </div>
        ${e.proxy ? '<div class="small">Proxy: zählt als Karte, aber nicht zum Wert, und kommt nie in den Ordner oder nach Bulk.</div>' : ''}</div></div>
    ${entryBox(e)}
    <div class="buttons stack"><button data-act="remove" class="danger">Aus der Sammlung entfernen</button></div>`);
  let k = key;
  bindEntryBox(b, key, nk => openEntry(nk));
  const q = b.querySelector('[data-qty]');
  const setQ = async n => {
    const r = await store.setQty(k, n);
    if (!r) { closeSheet(); return; }
    const ev = await storage.placeCopies();
    if (ev.length) sectionToast(ev);
    openEntry(k);
  };
  b.querySelector('[data-act=minus]').onclick = () => setQ((store.items.get(k)?.qty || 1) - 1);
  b.querySelector('[data-act=plus]').onclick = () => setQ((store.items.get(k)?.qty || 0) + 1);
  b.querySelector('[data-foil]').onchange = async ev => { const r = await store.setFoil(k, ev.target.checked); if (r) openEntry(r.key); };
  b.querySelector('[data-proxy]').onchange = async ev => { await store.setProxy(k, ev.target.checked); openEntry(k); };
  b.querySelector('[data-act=remove]').onclick = async () => {
    const cur = store.items.get(k);
    if (!cur) return closeSheet();
    await store.setQty(k, 0);
    closeSheet();
    toast(`Entfernt: <b>${esc(name)}</b>`, { action: { label: 'Rückgängig', run: async () => { await store.saveEntries([cur], 1); } } });
  };
}

// ---- backup -----------------------------------------------------------------------------------------------------------
function doSave() {
  if (!store.items.size) { toast('Die Sammlung ist noch leer.'); return; }
  // no await before saveBackup(): Safari only opens the share sheet straight from the tap
  saveBackup().then(async how => {
    if (how === 'cancelled') { toast('Sicherung abgebrochen.'); return; }
    await store.markBackedUp();
    renderReminder(); updateDot();
    toast(how === 'shared' ? 'Sicherung weitergegeben. Am besten in iCloud Drive oder Google Drive ablegen.' : 'Sicherung als Datei heruntergeladen (Ordner „Downloads“).', { ms: 5000 });
  });
}
$('save').onclick = doSave;
$('load').onclick = () => $('file').click();
$('file').onchange = async ev => {
  const file = ev.target.files?.[0];
  ev.target.value = '';
  if (!file) return;
  let data;
  try { data = await readBackup(file); } catch (e) { toast(esc(e.message), { ms: 6000 }); return; }
  const when = data.exported ? ` vom ${fmtDate(data.exported)}` : '';
  const nowCount = store.totalCount();
  if (nowCount && !confirm(`Deine Sammlung (${nowCount} Karten${store.decks.size ? `, ${store.decks.size} Decks` : ''}) wird durch die Sicherung${when} (${data.copies} Karten${data.decks?.length ? `, ${data.decks.length} Decks` : ''}) ersetzt. Fortfahren?`)) return;
  await store.replaceAll(data.entries);
  if (data.meta) await storage.restoreMeta(data.meta);
  if (data.decks) await store.replaceDecks(data.decks); else if (data.meta) await store.replaceDecks([]);
  if (ctx) await storage.backfillOracles(ctx.db);
  await storage.placeCopies();
  await store.markBackedUp();
  $('scan-banner').innerHTML = '';
  renderScanDeck();
  toast(`Sicherung${when} geladen: ${data.copies} Karten${data.skipped ? `, ${data.skipped} Einträge unlesbar` : ''}.`, { ms: 5000 });
  if (!$('intro').hidden) finishIntro();
  show('coll');
};

async function renderReminder() {
  const s = await store.backupState();
  const el = $('coll-banner');
  if (!s.due) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="banner warn"><span>Seit der letzten Sicherung hat sich viel getan (${s.changes} Änderungen). Speichere jetzt eine Sicherung.</span><button>Jetzt sichern</button></div>`;
  el.querySelector('button').onclick = doSave;
}
async function updateDot() { const s = await store.backupState(); document.querySelector('.tabs .dot').hidden = !s.due; }
async function checkReminder(afterAdd) {
  const s = await store.backupState();
  updateDot();
  if (s.due && afterAdd && !reminderShown) {
    reminderShown = true;
    setTimeout(() => toast(`${s.changes} Änderungen seit der letzten Sicherung.`, { ms: 7000, action: { label: 'Jetzt sichern', run: doSave } }), 3700);
  }
}

function emptyStartBanner() {
  if (store.items.size) return;
  const el = $('scan-banner');
  el.innerHTML = `<div class="banner"><span>Deine Sammlung ist leer. Hast du eine Sicherung?</span><button data-act="load">Sicherung laden</button><button data-act="x" class="ghost" aria-label="Ausblenden">×</button></div>`;
  el.querySelector('[data-act=load]').onclick = () => $('file').click();
  el.querySelector('[data-act=x]').onclick = () => { el.innerHTML = ''; };
}

// ---- "Was ist neu?" (js/changelog.js) -----------------------------------------------------------------------------------
function newsHtml(list, title) {
  return `<h2>${esc(title)}</h2>${list.map(r => `<div class="news"><h3>${esc(r.title)} <span class="small">${esc(r.date)}</span></h3>
    <ul>${r.points.map(p => `<li>${esc(p)}</li>`).join('')}</ul></div>`).join('')}
    <div class="sheet-foot"><button class="primary" data-act="ok">Verstanden</button></div>`;
}
export function showNews(list = RELEASES.slice(0, 5), title = 'Was ist neu?') {
  const b = openSheet(newsHtml(list, title));
  b.querySelector('[data-act=ok]').onclick = () => closeSheet();
  return b;
}
/** after an update: once, when the app is idle on the start screen (no intro, no sheet, no data download, no camera prompt) */
async function maybeShowNews() {
  const last = await store.getMeta('lastSeenRelease', null);
  if (last === newestId()) return;
  if (!(await store.getMeta('introDone', false))) { await store.setMeta('lastSeenRelease', newestId()); return; }   // new user
  const list = since(last, 3);
  const t0 = Date.now();
  while (!$('intro').hidden || !$('sheet').hidden || cameraStarting || !ctx) {
    if (Date.now() - t0 > 10 * 60 * 1000) return;   // try again on the next start
    await new Promise(r => setTimeout(r, 700));
  }
  const b = openSheet(newsHtml(list, 'Neu in der Kartenkiste'), () => store.setMeta('lastSeenRelease', newestId()));
  b.querySelector('[data-act=ok]').onclick = () => closeSheet();
}

// ---- help -------------------------------------------------------------------------------------------------------------
async function renderHelp() {
  const el = $('screen-help');
  el.innerHTML = `<div class="buttons"><button id="news-open">Was ist neu?</button></div>` + helpHtml({ inApp: true }) + `<div class="buttons"><button id="intro-again">Einführung nochmal ansehen</button></div>`;
  $('news-open').onclick = () => showNews();
  $('help-save').onclick = doSave;
  $('help-load').onclick = () => $('file').click();
  $('intro-again').onclick = () => showIntro();
  const [info, man, last] = await Promise.all([storageInfo(), installedManifest(), store.getMeta('lastBackup')]);
  const mb = v => v == null ? '?' : v >= 1e9 ? (v / 1e9).toFixed(1).replace('.', ',') + ' GB' : (v / 1e6).toFixed(0) + ' MB';
  const st = $('help-status');
  if (!st) return;
  st.innerHTML = `<div><b>Dauerhafter Speicher:</b> ${info.persisted === true ? 'ja, das Handy räumt die Daten nicht von selbst weg' : info.persisted === false ? 'nicht gewährt. Das Handy darf die Daten bei Platzmangel löschen, deshalb ist die Sicherungsdatei wichtig.' : 'unbekannt'}</div>
    <div><b>Belegt:</b> ${mb(info.usage)}${info.quota ? ` von ${mb(info.quota)}` : ''}</div>
    <div><b>Kartenliste:</b> ${man ? `Stand ${esc(man.pack_date)} (Version ${esc(man.version)})` : 'noch nicht geladen'}</div>
    <div><b>Sammlung:</b> ${store.totalCount()} Karten · letzte Sicherung: ${last ? esc(fmtDate(last)) : 'noch keine'}</div>
    <div><b>Als App installiert:</b> ${standalone() ? 'ja' : 'nein, läuft im Browser'}</div>`;
}

// ---- first start intro --------------------------------------------------------------------------------------------------
const introProgress = { text: '', pct: null };
function installStep() {
  if (standalone()) return `<p class="ok">✓ Die App ist schon auf deinem Home-Bildschirm. Gut so.</p>`;
  if (isIOS) return `<p>Lege die Kartenkiste auf den Home-Bildschirm. Erst dann merkt sich das iPhone deine Sammlung dauerhaft.</p>
    <ol><li>Unten auf das Teilen-Symbol tippen (Quadrat mit Pfeil nach oben).</li><li><b>„Zum Home-Bildschirm“</b> wählen und auf „Hinzufügen“ tippen.</li><li>Die App über das neue Symbol öffnen und dort weitermachen.</li></ol>
    <p class="small">Safari und die installierte App haben getrennte Speicher. Scanne deshalb gleich in der installierten App.</p>`;
  if (isAndroid) return `<p>Installiere die Kartenkiste als App. Dann startet sie wie jede andere App und funktioniert offline.</p>
    ${installPrompt ? '<div class="buttons"><button class="primary" data-act="install">App installieren</button></div>' : '<ol><li>Oben rechts in Chrome auf die drei Punkte tippen.</li><li><b>„App installieren“</b> wählen.</li><li>Die App über das neue Symbol öffnen.</li></ol>'}`;
  return `<p>Am besten nutzt du die Kartenkiste auf dem Handy. So installierst du sie:</p>${INSTALL}`;
}
const INTRO = [
  () => `<div class="intro-logo"><img src="icons/icon-512.png" alt=""></div>
    <h2>Willkommen in der Kartenkiste</h2>
    <p>Scanne deine Karten mit der Kamera und führe deine Sammlung im Handy. Die App braucht kein Konto und funktioniert auch offline.</p>
    <div class="progress-box"><div class="small" data-ptext>${esc(introProgress.text)}</div><div class="bar"><i data-pbar style="width:${introProgress.pct ?? 0}%"></i></div></div>
    <p class="small">Die Kartenkiste ist von GonzooTV.</p>`,
  () => `<h2>Auf den Home-Bildschirm</h2>${installStep()}`,
  () => `<h2>So scannst du gut</h2>${SCAN_TIPS}
    <p class="small">Beim ersten Scannen fragt das Handy, ob die App die Kamera benutzen darf. Tippe auf „Erlauben“. Die Bilder bleiben im Handy.</p>`,
  () => {
    const placed = [...store.items.values()].some(e => e.copies.some(c => c.h));
    return `<h2>Wie sortierst du deine Karten?</h2>
    <p>Die App sagt dir zu jeder Karte, in welches Fach deiner Kiste sie gehört. Such dir aus, wie deine Kiste aufgeteilt ist.</p>
    ${systemChoice(storage.getSettings().system, 'intro-system')}
    <p class="small">${placed ? 'Ändern kannst du das unter Sammlung → „Fächer & Ordner“. Dort zeigt die App zuerst, welche Karten umziehen.'
      : 'Du kannst das später unter Sammlung → „Fächer & Ordner“ ändern. Teure Karten ab 3 € schlägt die App für den Ordner vor.'}</p>`;
  },
  () => `<h2>Deine Sammlung sichern</h2>
    <p>Deine Sammlung liegt nur in diesem Handy. Speichere ab und zu eine Sicherungsdatei, dann kannst du sie auf jedem Handy zurückholen.
    Auf dem iPhone legst du sie in iCloud Drive ab, auf Android in Google Drive.</p>
    <p>Hast du schon eine Sicherung? Dann lade sie jetzt.</p>
    <div class="buttons stack"><button class="primary" data-act="done">Los geht's</button><button data-act="restore">Ich habe eine Sicherung</button></div>`,
];
let introStep = 0;
function showIntro(step = 0) {
  introStep = step;
  stopCamera();
  const el = $('intro');
  el.hidden = false;
  const last = introStep === INTRO.length - 1;
  el.innerHTML = `<div class="intro-body">${INTRO[introStep]()}</div>
    <div class="intro-nav">
      <button data-act="back" class="ghost" ${introStep ? '' : 'style="visibility:hidden"'}>Zurück</button>
      <span class="dots">${INTRO.map((_, i) => `<i class="${i === introStep ? 'on' : ''}"></i>`).join('')}</span>
      <button data-act="next" class="ghost" ${last ? 'style="visibility:hidden"' : ''}>Weiter</button>
    </div>`;
  el.querySelector('[data-act=back]').onclick = () => showIntro(Math.max(0, introStep - 1));
  el.querySelector('[data-act=next]').onclick = () => showIntro(Math.min(INTRO.length - 1, introStep + 1));
  el.querySelector('[data-act=done]')?.addEventListener('click', finishIntro);
  el.querySelectorAll('input[name=intro-system]').forEach(r => r.addEventListener('change', async () => {
    if ([...store.items.values()].some(e => e.copies.some(c => c.h))) { showIntro(introStep); return; }   // with sections: only via the Umräumliste
    await storage.setSettings({ system: r.value }, { allowSystem: true });
    showIntro(introStep);
  }));
  if ([...store.items.values()].some(e => e.copies.some(c => c.h))) el.querySelectorAll('input[name=intro-system]').forEach(r => { r.disabled = true; });
  el.querySelector('[data-act=restore]')?.addEventListener('click', () => $('file').click());
  el.querySelector('[data-act=install]')?.addEventListener('click', async () => {
    installPrompt.prompt();
    const r = await installPrompt.userChoice.catch(() => null);
    installPrompt = null;
    if (r?.outcome === 'accepted') toast('Installiert. Öffne die App jetzt über das neue Symbol.', { ms: 6000 });
    showIntro(introStep);
  });
}
async function finishIntro() {
  $('intro').hidden = true;
  await store.setMeta('introDone', true);
  await store.setMeta('lastSeenRelease', newestId());
  requestPersist().then(p => store.setMeta('persisted', p));
  show(current);
}
function setProgress(text, pct = null) {
  introProgress.text = text; introProgress.pct = pct;
  const t = document.querySelector('[data-ptext]'), b = document.querySelector('[data-pbar]');
  if (t) t.textContent = text;
  if (b) b.style.width = (pct ?? 0) + '%';
}
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; if (!$('intro').hidden && introStep === 1) showIntro(1); });

// ---- dev logging (only on the test server) ------------------------------------------------------------------------------
function matToJpeg(cv, mat, maxSide = 700) {
  const c = document.createElement('canvas');
  const sc = Math.min(1, maxSide / Math.max(mat.cols, mat.rows));
  const m = new cv.Mat();
  cv.resize(mat, m, new cv.Size(Math.round(mat.cols * sc), Math.round(mat.rows * sc)), 0, 0, cv.INTER_AREA);
  cv.imshow(c, m); m.delete();
  return c.toDataURL('image/jpeg', 0.8);
}
function sendScanLog(r, src) {
  const { cv } = ctx;
  const best = r.candidates?.[0];
  const info = c => ({ id: c.card_id, name: c.name, printed: c.printed_name, set: c.set_code, cn: c.collector_number, lang: c.lang, score: c.score, why: c.reasons });
  const images = { frame: matToJpeg(cv, src, 900) };
  if (r.warped) images.warped = matToJpeg(cv, r.warped, 700);
  const body = { kind: 'scan', app: 'kartenkiste', at: new Date().toISOString(), env: { ua, standalone: standalone(), camera: stream?.getVideoTracks()[0]?.getSettings?.() ? `${$('video').videoWidth}x${$('video').videoHeight}` : null, hint: live.state, live: live.stats() },
    data: { timing: r.timing, method: r.method, refit: r.refit, rotated: r.rotated, title: r.title, bottomText: r.bottomText, bottom: r.bottom, confidence: r.confidence, best: best ? info(best) : null, top: (r.candidates || []).slice(0, 5).map(info) }, images };
  fetch('log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
}
function sendLog(kind, data) {
  if (!logEnabled) return;
  fetch('log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, app: 'kartenkiste', at: new Date().toISOString(), env: { ua, standalone: standalone() }, data }) }).catch(() => {});
}

// ---- test hooks for headless runs -------------------------------------------------------------------------------------
// ?fakecam=dev/frames/a.png,dev/frames/b.png shows still images as the camera (intro skipped);
// ?autoscan=1 then waits per image for "Karte erkannt" (max 6 s), shoots and reports everything to /log.
let fakeFrame = null;
async function devHooks() {
  const fake = params.get('fakecam');
  if (!fake) return;
  await store.setMeta('introDone', true);
  await store.setMeta('cameraOk', true);
  const imgs = await Promise.all(fake.split(',').map(async u => { const i = new Image(); i.src = u; await i.decode(); return i; }));
  const c = document.createElement('canvas'); c.width = imgs[0].width; c.height = imgs[0].height;
  const g = c.getContext('2d');
  let k = 0;
  const paint = () => { const im = imgs[k]; g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height); g.drawImage(im, 0, 0, c.width, c.height); };
  paint();
  setInterval(paint, 100);
  fakeFrame = { count: imgs.length, names: fake.split(','), set: n => { k = n; paint(); } };
  navigator.mediaDevices.getUserMedia = async () => c.captureStream(10);
}
async function autoscan() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  while (!stream || !$('video').videoWidth) await sleep(100);
  const out = [];
  for (let k = 0; k < fakeFrame.count; k++) {
    fakeFrame.set(k);
    live.hits = 0; live.set('searching');
    const t0 = performance.now();
    let found = null;
    while (performance.now() - t0 < 6000) { if (live.state === 'found') { found = Math.round(performance.now() - t0); break; } await sleep(50); }
    const r = await scanFrame();
    const best = r?.candidates?.[0];
    out.push({ frame: fakeFrame.names[k], hintMs: found, liveMs: Math.round(live.lastMs), detected: r?.detected, method: r?.method, confidence: r?.confidence,
      best: best ? `${best.name} ${best.set_code}#${best.collector_number}` : null, total: Math.round(r?.timing?.total || 0) });
    live.pause(false);
  }
  console.log('autoscan', JSON.stringify(out));
  await fetch('log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'autoscan', app: 'kartenkiste', at: new Date().toISOString(), env: { ua }, data: out }) }).catch(() => {});
}

// ---- start --------------------------------------------------------------------------------------------------------------
async function init() {
  await devHooks();
  if (fakeFrame) maybeStartCamera();
  const worker = registerWorker((what, info) => sendLog('stage', { stage: what, ...info, ms: Math.round(performance.now() - stageT0) }));
  await store.load();
  await storage.loadMeta();
  await loadPrices().catch(() => {});
  initStorageUi({ openSheet, closeSheet, toast, esc, imgUrl, openEntry, refreshPrices: pricesFor });
  initTyping({ ctx: () => ctx, cardOf, openSheet, closeSheet, toast, esc, imgUrl, LANG_DE, priceOf, priceNow, fmtPrice });
  initDeckUi({ openSheet, closeSheet, toast, esc, imgUrl, cardOf, show, scanDeck, setScanDeck, addToCollection });
  scanDeckId = await store.getMeta('scanDeck', null);
  renderScanDeck();
  const introDone = await store.getMeta('introDone', false);
  if (!introDone || params.get('intro')) showIntro();
  else if (!store.items.size) emptyStartBanner();
  updateDot();
  await Promise.race([fetch('log-enabled', { cache: 'no-store' }).then(r => { logEnabled = r.status === 204; }).catch(() => {}), new Promise(r => setTimeout(r, 1500))]);
  sendLog('stage', { stage: 'start', ms: Math.round(performance.now() - stageT0), worker: 'serviceWorker' in navigator, caches: typeof caches !== 'undefined' });
  const swOk = await worker;
  let shellFiles = null;
  try { shellFiles = (await (await caches.open((await caches.keys()).find(k => k.startsWith('kk-shell-')) || 'kk-shell')).keys()).map(r => new URL(r.url).pathname.replace(/^\//, '')); } catch { /* */ }
  sendLog('stage', { stage: 'worker', ...swOk, shell: shellFiles ? shellFiles.length : null, ms: Math.round(performance.now() - stageT0) });

  // data: first start downloads everything (progress), later starts check the version in the background
  let data;
  for (;;) {
    try {
      data = await ensureData(p => {
        if (p.phase !== 'install') return;
        const pct = p.total ? Math.floor(100 * p.done / p.total) : 100;
        chip(`Kartenliste ${pct} %`, 'busy');
        setProgress(`Kartenliste wird geladen: ${pct} %. Das passiert nur beim ersten Start.`, pct);
      }, (what, info) => sendLog('stage', { stage: what, ...info, ms: Math.round(performance.now() - stageT0) }));
      break;
    } catch (e) {
      sendLog('error', { where: 'ensureData', name: e?.name, message: String(e?.message || e), stack: e?.stack });
      const offline = e?.code === 'offline';
      chip(offline ? 'Offline' : 'Fehler', 'bad');
      setProgress(offline ? 'Für den ersten Start braucht die App einmal Internet. Sie versucht es gleich wieder.' : 'Laden fehlgeschlagen: ' + (e?.message || e), 0);
      $('scan-note').textContent = offline ? 'Für den ersten Start braucht die App einmal Internet (etwa 30 MB, am besten im WLAN).' : 'Die Kartenliste konnte nicht geladen werden (' + (e?.message || e) + '). Die App versucht es gleich wieder.';
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  setProgress('Kartenliste ist geladen. Die Erkennung startet …', 100);
  const rolesP = storage.loadRoles();
  if (data.installedNow || introDone) requestPersist().then(p => store.setMeta('persisted', p));
  data.update?.then(u => { toast('Neue Kartenliste geladen. Sie gilt ab dem nächsten Start der App.', { ms: 6000 }); sendLog('update', u); })
    .catch(e => console.warn('background update', e));

  chip('Erkennung startet', 'busy');
  try {
    ctx = await loadEngine(text => chip(text.replace(' …', ''), 'busy'));
  } catch (e) {
    console.error(e);
    chip('Fehler', 'bad');
    $('scan-note').textContent = 'Die Erkennung startet nicht: ' + (e?.message || e) + '. Schließe die App und öffne sie neu.';
    sendLog('error', { message: String(e?.message || e), stack: e?.stack });
    return;
  }
  chip('Bereit', 'ok');
  // storage: oracle ids for entries from before v2 / old backups, then a section for every copy without one
  try {
    await storage.backfillOracles(ctx.db);
    if ((await rolesP) || (await storage.loadRoles())) { const ev = await storage.placeCopies(); if (ev.length && store.items.size) sectionToast(ev); }
  } catch (e) { console.warn('storage', e); }
  setProgress('Alles bereit. Die App funktioniert jetzt auch offline.', 100);
  $('scan-note').textContent = '';
  updateShutter();
  if (stream) { live.start(ctx.cv); onHint('searching'); }
  if (fakeFrame && params.get('autoscan')) autoscan();
  maybeShowNews().catch(e => console.warn('news', e));
  sendLog('load', { timings: ctx.timings, data: { version: data.version, installedNow: data.installedNow, updated: data.updated }, worker: swOk });
}

show('scan');
init().catch(e => { console.error(e); chip('Fehler', 'bad'); $('scan-note').textContent = 'Fehler beim Start: ' + (e?.message || e); });
