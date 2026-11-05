// The collection on the phone (IndexedDB "kartenkiste"). The whole collection is also kept in memory (`items`), so the
// list renders at once and the backup file can be built synchronously inside the tap (Safari only allows the share
// sheet directly in the tap handler).
//
// cards: { key: `${card_id}|${foil}`, card_id, oracle_id (null until known), name, printed_name, set_code, collector_number,
//          lang, foil (0/1), proxy (0/1: a printed copy, no value, never binder / Bulk), qty, added (ISO), updated (ISO), copies }
//   copies (DB v2, one per physical card, copies.length === qty): { id, h, b, at, s }
//          h  home section 'removal:2' (function key : number, 'bulk:1' for Bulk) or null while it has none yet
//          b  1 = lies in the binder ("Ordner"; the home section is kept for when it comes out again)
//          at when the copy was added or last put on the pile (ISO); s when it was ticked off in "Einsortieren" (null:
//          still on the pile of cards to put away)
// meta:  { key, value }   introDone, lastBackup (ISO), addedSinceBackup, firstUnsavedAt (ISO), cameraOk, persisted, prices,
//          storage {capacity, binderMin}, verdicts {oracle_id: ISO} ("Behalten"), roleOverrides {oracle_id: role key}

const DB_NAME = 'kartenkiste', DB_VERSION = 3;
let dbp = null;
export const items = new Map();   // key -> entry
export const decks = new Map();   // id -> deck (DB v3)
const listeners = new Set();
export const onChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };
const changed = () => listeners.forEach(fn => { try { fn(); } catch (e) { console.error(e); } });
export const notify = () => changed();

function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = ev => {
      const db = r.result;
      if (!db.objectStoreNames.contains('cards')) db.createObjectStore('cards', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('decks')) db.createObjectStore('decks', { keyPath: 'id' });   // v3
      // v1 -> v2: every entry gets its copies; cards from before lie on the pile to put away (no home yet)
      if (ev.oldVersion >= 1 && ev.oldVersion < 2) {
        const cur = r.transaction.objectStore('cards').openCursor();
        cur.onsuccess = () => {
          const c = cur.result;
          if (!c) return;
          c.update(normalize(c.value));
          c.continue();
        };
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
const done = tx => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

let copySeq = 0;
export const copyId = () => Date.now().toString(36) + (copySeq++ % 1296).toString(36).padStart(2, '0') + Math.random().toString(36).slice(2, 5);
export const newCopy = (at = new Date().toISOString()) => ({ id: copyId(), h: null, b: 0, at, s: null });

/** makes sure an entry has oracle_id and exactly qty copies (old entries, old backups) */
export function normalize(e) {
  const copies = Array.isArray(e.copies) ? e.copies.filter(c => c && typeof c === 'object') : [];
  while (copies.length < e.qty) copies.push(newCopy(e.added || new Date().toISOString()));
  if (copies.length > e.qty) dropCopies(copies, copies.length - e.qty);
  return { ...e, oracle_id: e.oracle_id || null, proxy: e.proxy ? 1 : 0, copies };
}
/** removes n copies: the newest ones still on the pile first, then the newest */
function dropCopies(copies, n) {
  const order = copies.map((c, i) => i).sort((a, b) => ((copies[a].s ? 1 : 0) - (copies[b].s ? 1 : 0)) || String(copies[b].at).localeCompare(String(copies[a].at)));
  const gone = new Set(order.slice(0, n));
  const keep = copies.filter((c, i) => !gone.has(i));
  copies.length = 0;
  copies.push(...keep);
}

export async function load() {
  const db = await open();
  const all = await req(db.transaction('cards').objectStore('cards').getAll());
  items.clear();
  for (const e of all) items.set(e.key, normalize(e));
  decks.clear();
  for (const d of await req(db.transaction('decks').objectStore('decks').getAll())) decks.set(d.id, d);
  changed();
  return items;
}

export async function getMeta(key, fallback = null) {
  const db = await open();
  const r = await req(db.transaction('meta').objectStore('meta').get(key));
  return r ? r.value : fallback;
}
export async function setMeta(key, value) {
  const db = await open();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({ key, value });
  await done(tx);
}

export const keyOf = (cardId, foil) => `${cardId}|${foil ? 1 : 0}`;
export const totalCount = () => { let n = 0; for (const e of items.values()) n += e.qty; return n; };

async function put(entries, removeKeys = []) {
  const db = await open();
  const tx = db.transaction('cards', 'readwrite');
  const s = tx.objectStore('cards');
  for (const e of entries) s.put(e);
  for (const k of removeKeys) s.delete(k);
  await done(tx);
}

/** adds `qty` copies of a card (card: {card_id, oracle_id, name, printed_name, set_code, collector_number, lang}) -> the
 *  entry; the new copies lie on the pile without a home (storage.placeCopies gives them one) */
export async function addCard(card, { foil = 0, qty = 1 } = {}) {
  const now = new Date().toISOString();
  const key = keyOf(card.card_id, foil);
  const old = items.get(key);
  const fresh = Array.from({ length: qty }, () => newCopy(now));
  const e = old ? { ...old, oracle_id: old.oracle_id || card.oracle_id || null, qty: old.qty + qty, updated: now, copies: [...old.copies, ...fresh] }
    : { key, card_id: card.card_id, oracle_id: card.oracle_id || null, name: card.name, printed_name: card.printed_name || null,
        set_code: card.set_code, collector_number: card.collector_number, lang: card.lang, foil: foil ? 1 : 0, qty, added: now,
        updated: now, copies: fresh };
  await put([e]);
  items.set(key, e);
  await countUnsaved(qty);
  changed();
  return e;
}

/** sets the quantity (0 removes the entry) */
export async function setQty(key, qty) {
  const old = items.get(key);
  if (!old) return null;
  if (qty <= 0) { await put([], [key]); items.delete(key); await countUnsaved(1); changed(); return null; }
  const copies = [...old.copies];
  if (qty > copies.length) while (copies.length < qty) copies.push(newCopy());
  else dropCopies(copies, copies.length - qty);
  const e = { ...old, qty, copies, updated: new Date().toISOString() };
  await put([e]);
  items.set(key, e);
  await countUnsaved(1);
  changed();
  return e;
}

/** switches the foil flag (merges with an existing entry of the other kind) */
export async function setFoil(key, foil) {
  const old = items.get(key);
  if (!old || !!old.foil === !!foil) return old;
  const nkey = keyOf(old.card_id, foil);
  const other = items.get(nkey);
  const e = { ...old, key: nkey, foil: foil ? 1 : 0, qty: old.qty + (other ? other.qty : 0), copies: [...old.copies, ...(other ? other.copies : [])],
    oracle_id: old.oracle_id || other?.oracle_id || null, proxy: old.proxy || other?.proxy ? 1 : 0, updated: new Date().toISOString() };
  await put([e], [key]);
  items.delete(key); items.set(nkey, e);
  await countUnsaved(1);
  changed();
  return e;
}

/** decks (DB v3): { id, name, created, updated, commanders: [{oracle_id, card_id, name, printed_name}],
 *  cards: [{oracle_id, card_id (printing shown), name, printed_name, qty}] }; cards are listed by oracle id (any printing) */
export const deckId = () => 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
export async function saveDeck(deck) {
  const d = { ...deck, updated: new Date().toISOString() };
  const db = await open();
  const tx = db.transaction('decks', 'readwrite');
  tx.objectStore('decks').put(d);
  await done(tx);
  decks.set(d.id, d);
  await countUnsaved(1);
  changed();
  return d;
}
export async function deleteDeck(id) {
  const db = await open();
  const tx = db.transaction('decks', 'readwrite');
  tx.objectStore('decks').delete(id);
  await done(tx);
  decks.delete(id);
  await countUnsaved(1);
  changed();
}
/** restore: replaces all decks */
export async function replaceDecks(list) {
  const db = await open();
  const tx = db.transaction('decks', 'readwrite');
  const s = tx.objectStore('decks');
  s.clear();
  for (const d of list) s.put(d);
  await done(tx);
  decks.clear();
  for (const d of list) decks.set(d.id, d);
  changed();
}

/** marks an entry as proxy (printed copy) or not */
export async function setProxy(key, proxy) {
  const old = items.get(key);
  if (!old || !!old.proxy === !!proxy) return old;
  const e = { ...old, proxy: proxy ? 1 : 0, updated: new Date().toISOString() };
  await put([e]);
  items.set(key, e);
  await countUnsaved(1);
  changed();
  return e;
}

/** replaces the whole collection (restore from a backup file) */
export async function replaceAll(entries) {
  const db = await open();
  const tx = db.transaction('cards', 'readwrite');
  const s = tx.objectStore('cards');
  s.clear();
  const norm = entries.map(normalize);
  for (const e of norm) s.put(e);
  await done(tx);
  items.clear();
  for (const e of norm) items.set(e.key, e);
  changed();
}

/** writes changed entries (storage moves, oracle ids); `count`: changes for the backup reminder (0: none, e.g. oracle ids) */
export async function saveEntries(entries, count = 0) {
  if (!entries.length) return;
  const now = new Date().toISOString();
  const list = entries.map(e => (count ? { ...e, updated: now } : e));
  await put(list);
  for (const e of list) items.set(e.key, e);
  if (count) await countUnsaved(count);
  changed();
}

// ---- backup reminder bookkeeping ------------------------------------------------------------------------------------
export const REMIND_CARDS = 20, REMIND_DAYS = 7;

async function countUnsaved(n) {
  const cur = await getMeta('addedSinceBackup', 0);
  await setMeta('addedSinceBackup', cur + n);
  if (!(await getMeta('firstUnsavedAt'))) await setMeta('firstUnsavedAt', new Date().toISOString());
}
export async function markBackedUp() {
  await setMeta('lastBackup', new Date().toISOString());
  await setMeta('addedSinceBackup', 0);
  await setMeta('firstUnsavedAt', null);
  changed();
}
/** -> { due, changes, days, lastBackup } (due: 20 changes or 7 days with unsaved changes) */
export async function backupState() {
  const changes = await getMeta('addedSinceBackup', 0);
  const first = await getMeta('firstUnsavedAt');
  const lastBackup = await getMeta('lastBackup');
  const days = first ? (Date.now() - Date.parse(first)) / 86400000 : 0;
  return { due: items.size > 0 && changes > 0 && (changes >= REMIND_CARDS || days >= REMIND_DAYS), changes, days, lastBackup };
}
