// Backup file: the whole collection as JSON (kartenkiste-YYYY-MM-DD.json).
// Saving goes through the share sheet (iPhone: "In Dateien sichern" -> iCloud Drive; Android: Google Drive) when the
// browser accepts the file there (navigator.canShare), otherwise it is offered as a download. Restoring reads the file
// through the normal file picker and replaces the collection.
//
// Version 2 (2026-11-06) adds per card oracle_id and copies [{id, h, b, at, s}] (place and "Einsortieren" state, see
// store.js) and at the top storage {capacity, binderMin, system, binderOn, bulkOn}, verdicts {oracle_id: ISO} ("Behalten") and roleOverrides
// {oracle_id: role} ("Aufgabe ändern"), and per card proxy (0/1). Version 1 files still load: their cards lie on the pile
// without a place.

import { items, decks, keyOf, newCopy } from './store.js';
import { getSettings, getVerdicts, getOverrides, ROLE_KEYS, ALL_KEYS } from './storage.js';

export const FORMAT = 'kartenkiste-backup';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const pad = n => String(n).padStart(2, '0');
export function fileName(d = new Date()) { return `kartenkiste-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`; }

/** the backup as a File (synchronous: called inside the tap so the share sheet is allowed) */
export function backupFile() {
  const cards = [...items.values()].sort((a, b) => a.added < b.added ? -1 : a.added > b.added ? 1 : 0).map(e => ({
    card_id: e.card_id, name: e.name, printed_name: e.printed_name, set_code: e.set_code, collector_number: e.collector_number,
    lang: e.lang, foil: e.foil, proxy: e.proxy ? 1 : 0, qty: e.qty, added: e.added, updated: e.updated, oracle_id: e.oracle_id || null,
    copies: e.copies.map(c => ({ id: c.id, h: c.h || null, b: c.b ? 1 : 0, at: c.at, s: c.s || null })),
  }));
  const body = { format: FORMAT, version: 3, app: 'Kartenkiste', exported: new Date().toISOString(), entries: cards.length,
    copies: cards.reduce((s, c) => s + c.qty, 0), storage: getSettings(), verdicts: getVerdicts(), roleOverrides: getOverrides(),
    decks: [...decks.values()].map(d => ({ id: d.id, name: d.name, created: d.created, updated: d.updated, commanders: d.commanders, cards: d.cards })), cards };
  return new File([JSON.stringify(body, null, 1)], fileName(), { type: 'application/json' });
}

/**
 * Save the backup. Must be called directly from a tap handler (no await before it).
 * -> Promise<'shared' | 'downloaded' | 'cancelled'>
 */
export function saveBackup() {
  const file = backupFile();
  let canShare = false;
  try { canShare = !!(navigator.canShare && navigator.share && navigator.canShare({ files: [file] })); } catch { canShare = false; }
  if (!canShare) { download(file); return Promise.resolve('downloaded'); }
  return navigator.share({ files: [file], title: 'Kartenkiste-Sicherung' }).then(() => 'shared', e => {
    if (e && e.name === 'AbortError') return 'cancelled';
    console.warn('share failed, download instead', e);
    download(file);
    return 'downloaded';
  });
}

export function download(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = file.name; a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

const HOME = new RegExp(`^(${ALL_KEYS.join('|')}):[1-9][0-9]{0,3}$`);
const isoOr = (v, d) => (typeof v === 'string' && !isNaN(Date.parse(v)) ? v : d);
/** the copies of a backup card, checked; missing ones (version 1, damaged file) lie on the pile without a place */
function readCopies(raw, qty, added) {
  const out = [];
  for (const c of Array.isArray(raw) ? raw : []) {
    if (!c || typeof c !== 'object' || out.length >= qty) continue;
    const base = newCopy(isoOr(c.at, added));
    out.push({ id: typeof c.id === 'string' && c.id.length <= 40 ? c.id : base.id, h: typeof c.h === 'string' && HOME.test(c.h) ? c.h : null,
      b: c.b ? 1 : 0, at: base.at, s: c.s ? isoOr(c.s, null) : null });
  }
  while (out.length < qty) out.push(newCopy(added));
  return out;
}
const cardRef = c => (c && typeof c === 'object' && typeof c.oracle_id === 'string' && UUID.test(c.oracle_id) && typeof c.card_id === 'string' && UUID.test(c.card_id)
  ? { oracle_id: c.oracle_id, card_id: c.card_id, name: String(c.name || '?'), printed_name: c.printed_name ? String(c.printed_name) : null } : null);
/** decks of a version 3 backup, checked; a damaged card is dropped */
function readDecks(raw, now) {
  const out = [];
  for (const d of Array.isArray(raw) ? raw : []) {
    if (!d || typeof d.id !== 'string' || d.id.length > 40) continue;
    const cards = new Map();
    for (const c of Array.isArray(d.cards) ? d.cards : []) {
      const r = cardRef(c), qty = Math.floor(Number(c?.qty));
      if (r && qty > 0) cards.set(r.oracle_id, { ...r, qty: Math.min(99, qty + (cards.get(r.oracle_id)?.qty || 0)) });
    }
    out.push({ id: d.id, name: String(d.name || 'Deck').slice(0, 60), created: isoOr(d.created, now), updated: isoOr(d.updated, now),
      commanders: (Array.isArray(d.commanders) ? d.commanders : []).map(cardRef).filter(Boolean).slice(0, 2), cards: [...cards.values()] });
  }
  return out;
}
const objOf = (v, ok) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {};
  for (const [k, x] of Object.entries(v)) if (UUID.test(k) && ok(x)) out[k] = x;
  return out;
};

/** reads and checks a backup file -> { entries: [store entries], exported, copies, skipped, meta, decks }; decks is null for files before version 3, meta is null for version 1
 *  files, else {storage, verdicts, roleOverrides}; throws an Error with a German message */
export async function readBackup(file) {
  if (file.size > 50 * 1024 * 1024) throw new Error('Die Sicherungsdatei ist zu groß (höchstens 50 MB).');
  let data;
  try { data = JSON.parse(await file.text()); } catch { throw new Error('Die Datei ist keine Kartenkiste-Sicherung (kein JSON).'); }
  if (!data || data.format !== FORMAT || !Array.isArray(data.cards)) throw new Error('Die Datei ist keine Kartenkiste-Sicherung.');
  if (data.version > 3) throw new Error('Die Sicherung stammt aus einer neueren Version der App. Bitte die App aktualisieren.');
  // Validate before creating per-copy objects: Infinity or huge quantities can freeze the UI.
  const MAX_COPIES = 100000;
  let total = 0;
  for (const c of data.cards) {
    if (!c || typeof c.card_id !== 'string' || !UUID.test(c.card_id)) continue;
    const qty = Number(c.qty);
    if (!Number.isSafeInteger(qty) || qty < 0) throw new Error('Die Sicherung enthält eine ungültige Kartenanzahl.');
    total += qty;
    if (total > MAX_COPIES) throw new Error('Die Sicherung enthält zu viele Karten (höchstens 100.000 Exemplare).');
  }
  const now = new Date().toISOString();
  const merged = new Map();
  let skipped = 0;
  for (const c of data.cards) {
    const qty = Math.floor(Number(c?.qty));
    if (!c || typeof c.card_id !== 'string' || !UUID.test(c.card_id) || !(qty > 0)) { skipped++; continue; }
    const foil = c.foil ? 1 : 0, key = keyOf(c.card_id, foil);
    const old = merged.get(key);
    const added = isoOr(c.added, now);
    const copies = readCopies(c.copies, qty, added);
    if (old) { old.qty += qty; old.copies = old.copies.concat(copies); if (c.proxy) old.proxy = 1; continue; }
    merged.set(key, {
      key, card_id: c.card_id, name: String(c.name || '?'), printed_name: c.printed_name ? String(c.printed_name) : null,
      set_code: String(c.set_code || ''), collector_number: String(c.collector_number || ''), lang: String(c.lang || 'en'),
      foil, proxy: c.proxy ? 1 : 0, qty, added, updated: isoOr(c.updated, now), oracle_id: typeof c.oracle_id === 'string' && UUID.test(c.oracle_id) ? c.oracle_id : null,
      copies,
    });
  }
  const entries = [...merged.values()];
  const deckList = readDecks(data.decks, now);
  const meta = data.version >= 2 ? {
    storage: data.storage && typeof data.storage === 'object' ? { capacity: data.storage.capacity, binderMin: data.storage.binderMin,
      system: data.storage.system, binderOn: data.storage.binderOn, bulkOn: data.storage.bulkOn } : null,
    verdicts: objOf(data.verdicts, x => typeof x === 'string'),
    roleOverrides: objOf(data.roleOverrides, x => ROLE_KEYS.includes(x)),
  } : null;
  return { entries, exported: data.exported || null, copies: entries.reduce((s, e) => s + e.qty, 0), skipped, meta, decks: data.version >= 3 ? deckList : null };
}
