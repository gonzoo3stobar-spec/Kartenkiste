// Putting cards away. Each user picks the storage system ("Ablage-System", setting `system`):
//   color  "Nach Farbe" (default): Weiß, Blau, Schwarz, Rot, Grün, Mehrfarbig, Farblos & Artefakte, Länder; inside by name
//   type   "Nach Kartentyp": Kreaturen, Spontanzauber, Hexereien, Artefakte, Verzauberungen, Planeswalker, Sonstige, Länder
//          (first type of the front face in that order: an artifact creature is a creature); inside by colour, then name
//   role   "Nach Aufgabe" (Gonzo's home app, mtg-bibliothek v1.10, SPEC 1.6 section 17): the function from the Scryfall
//          oracle tags; inside by colour, then name
// On top of every system, the same rules as the home app:
// - Every group is a section ("Fach") of the box, `capacity` cards each (default 100); a full one is followed by "Removal 2".
// - One rule for the binder ("Ordner", switch binderOn): the price. Copies worth at least `binderMin` (default 3 EUR).
// - Bulk (switch bulkOn): cheaper than 0.20 EUR and rarely played (EDHREC rank above 15,000 or none), no copy of the card in the binder,
//   and not marked "Behalten". Bulk is a section of its own; "Aus Bulk zurück" files the copy in its group again.
// - Changing the system later: planSystem() lists every card that changes its section ("Umräumliste"); only
//   applySystem() after the user's OK moves them (onto the "Einsortieren" pile).
// - "Einsortieren": every copy not ticked off yet (new scans), grouped by the place it belongs, binder candidates first.
//
// Copies live in the store entries (store.js: copies [{id, h, b, at, s}]); a copy is addressed as {key, id}.

import * as store from './store.js';
import { priceOf } from './prices.js';

export const ROLE_KEYS = ['wipe', 'removal', 'interaction', 'draw', 'ramp', 'tutor', 'synergy', 'land'];
export const ROLE_LABELS = { wipe: 'Massenvernichtung', removal: 'Removal', interaction: 'Konter & Schutz', draw: 'Kartenziehen',
  ramp: 'Ramp', tutor: 'Tutoren', synergy: 'Kreaturen & Synergie', land: 'Länder', bulk: 'Bulk',
  white: 'Weiß', blue: 'Blau', black: 'Schwarz', red: 'Rot', green: 'Grün', multi: 'Mehrfarbig', colorless: 'Farblos & Artefakte',
  creature: 'Kreaturen', instant: 'Spontanzauber', sorcery: 'Hexereien', artifact: 'Artefakte', enchantment: 'Verzauberungen',
  planeswalker: 'Planeswalker', other: 'Sonstige' };
export const SYSTEMS = {
  color: { label: 'Nach Farbe', byName: true, keys: ['white', 'blue', 'black', 'red', 'green', 'multi', 'colorless', 'land'],
    help: 'Ein Fach je Farbe, dazu Mehrfarbig, Farblos & Artefakte und Länder. Im Fach nach Name.' },
  type: { label: 'Nach Kartentyp', byName: false, keys: ['creature', 'instant', 'sorcery', 'artifact', 'enchantment', 'planeswalker', 'other', 'land'],
    help: 'Ein Fach je Kartentyp: Kreaturen, Spontanzauber, Hexereien und so weiter. Im Fach nach Farbe und Name.' },
  role: { label: 'Nach Aufgabe', byName: false, keys: ROLE_KEYS,
    help: 'Ein Fach je Aufgabe im Commander, zum Beispiel Removal, Kartenziehen oder Ramp. Im Fach nach Farbe und Name.' },
};
export const BULK = 'bulk';
export const ALL_KEYS = [...new Set([...Object.values(SYSTEMS).flatMap(x => x.keys), BULK])];
export const DEFAULTS = { capacity: 100, binderMin: 3, system: 'color', binderOn: true, bulkOn: true };
export const BULK_MAX_EUR = 0.20, BULK_MIN_RANK = 15000;
const order = () => [...SYSTEMS[settings.system].keys, BULK];
const COLOURS = 'WUBRGMC';
const COLOUR_KEY = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green', M: 'multi', C: 'colorless' };
const TYPE_KEY = { C: 'creature', I: 'instant', S: 'sorcery', A: 'artifact', E: 'enchantment', P: 'planeswalker', L: 'land', O: 'other' };
const ROOT = new URL('../', import.meta.url);

const fmtNum = n => Number(n).toLocaleString('de-DE');
export const fmtEur = v => v == null ? '–' : v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';

// ---- function data (pack/roles.json) ------------------------------------------------------------------------------------
let roles = null, rolesP = null;
/** loads pack/roles.json once (from the data cache; online the network when an older install lacks it) -> true/false */
export function loadRoles() {
  if (roles) return Promise.resolve(true);
  if (!rolesP) {
    rolesP = fetch(new URL('pack/roles.json', ROOT).href).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(d => {
      const idx = new Map();
      const h = d.oracles;
      for (let i = 0, n = d.role.length; i < n; i++) {
        const x = h.slice(i * 32, i * 32 + 32);
        idx.set(`${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`, i);
      }
      roles = { idx, keys: d.roles, role: d.role, rank: d.rank, color: d.color, type: d.type || '', land: d.land || '', d };
      return true;
    }).catch(e => { console.warn('roles.json', e); rolesP = null; return false; });
  }
  return rolesP;
}
export const rolesReady = () => !!roles;
function info(oracleId) {
  if (!roles || !oracleId) return null;
  const i = roles.idx.get(oracleId);
  if (i === undefined) return null;
  const role = roles.keys[roles.role[i]];
  return { role, rank: roles.rank[i] || null, color: roles.color[i], type: roles.type[i] || (role === 'land' ? 'L' : 'O'),
    land: roles.land ? roles.land[i] === '1' : role === 'land' };
}
/** Commander rule data of a card (pack roles.json, see tools/build_pack.py) -> {cid: Set of WUBRG, mv, legal, limit (null: any
 *  number), ptype, cmdr, partner: [tokens]} or null while the data is not loaded / the card is unknown */
export function ruleOf(oid) {
  if (!roles || !roles.d.cid || !oid) return null;
  const i = roles.idx.get(oid);
  if (i === undefined) return null;
  const d = roles.d, m = d.cid.charCodeAt(i) - 97;
  const lim = d.limit[i];
  return { cid: new Set([...'WUBRG'].filter((c, k) => m & (1 << k))), mv: d.mv.charCodeAt(i) - 97, legal: d.legal[i],
    limit: lim === 'u' ? null : Number(lim), ptype: d.ptype[i], cmdr: d.cmdr[i], partner: d.partner[i] || [] };
}
export const autoRole = oid => info(oid)?.role || null;
export const rankOf = oid => info(oid)?.rank ?? null;
export const colourOf = oid => info(oid)?.color || 'C';

// ---- settings, verdicts, overrides (meta; part of the backup) -----------------------------------------------------------
let settings = { ...DEFAULTS }, verdicts = {}, overrides = {};
const ROLE_ONLY = ROLE_KEYS.filter(k => k !== 'land');
export async function loadMeta() {
  const saved = (await store.getMeta('storage')) || {};
  settings = { ...DEFAULTS, ...saved };
  if (!SYSTEMS[saved.system]) {
    // the version of 06.11. filed by function only: whoever has such sections keeps them, everyone else starts by colour
    const byRole = [...store.items.values()].some(e => e.copies.some(c => c.h && ROLE_ONLY.includes(c.h.split(':')[0])));
    settings.system = byRole ? 'role' : 'color';
    await store.setMeta('storage', settings);
  }
  verdicts = (await store.getMeta('verdicts')) || {};
  overrides = (await store.getMeta('roleOverrides')) || {};
}
export const getSettings = () => ({ ...settings });
export const getVerdicts = () => ({ ...verdicts });
export const getOverrides = () => ({ ...overrides });
/** capacity, binderMin, binderOn, bulkOn; `system` only with allowSystem (restore, the very first choice): a change of
 *  the system otherwise goes through planSystem / applySystem */
export async function setSettings(s, { allowSystem = false } = {}) {
  const cap = Math.round(Number(s.capacity ?? settings.capacity));
  const min = Number(String(s.binderMin ?? settings.binderMin).replace(',', '.'));
  settings = { capacity: cap >= 10 && cap <= 1000 ? cap : settings.capacity, binderMin: min >= 0 && min < 10000 ? min : settings.binderMin,
    system: allowSystem && SYSTEMS[s.system] ? s.system : settings.system,
    binderOn: s.binderOn === undefined ? settings.binderOn : !!s.binderOn, bulkOn: s.bulkOn === undefined ? settings.bulkOn : !!s.bulkOn };
  await store.setMeta('storage', settings);
  store.notify();
  return getSettings();
}
/** restore: the storage meta of a backup (v2); missing parts are left as they are */
export async function restoreMeta({ storage, verdicts: v, roleOverrides: o } = {}) {
  if (storage) await setSettings(storage, { allowSystem: true });
  if (v) { verdicts = v; await store.setMeta('verdicts', verdicts); }
  if (o) { overrides = o; await store.setMeta('roleOverrides', overrides); }
}
export const isKept = oid => !!(oid && verdicts[oid]);
export const roleOf = oid => (oid && overrides[oid]) || autoRole(oid);
export const isOverridden = oid => !!(oid && overrides[oid]);
/** the group (section key) of an entry in a system; null while the card data is not known */
export function groupOf(entry, system = settings.system) {
  const oid = entry.oracle_id;
  if (system === 'role') return roleOf(oid);
  const x = info(oid);
  if (!x) return null;
  if (system === 'type') return TYPE_KEY[x.type] || 'other';
  return x.land ? 'land' : COLOUR_KEY[x.color] || 'colorless';
}

// ---- places -------------------------------------------------------------------------------------------------------------
export const homeRole = h => h ? h.split(':')[0] : null;
export function sectionName(h) {
  if (!h) return 'noch ohne Fach';
  const [role, n] = h.split(':');
  return (ROLE_LABELS[role] || role) + (Number(n) > 1 ? ' ' + n : '');
}
export const placeName = c => c.b ? 'Ordner' : sectionName(c.h);
const placeSort = c => {
  const o = order();
  if (c.b) return [o.length + 51, 0];
  if (!c.h) return [o.length + 52, 0];
  const i = o.indexOf(homeRole(c.h));
  return [i < 0 ? o.length + ALL_KEYS.indexOf(homeRole(c.h)) : i, Number(c.h.split(':')[1])];
};
const cmpPlace = (a, b) => { const x = placeSort(a), y = placeSort(b); return x[0] - y[0] || x[1] - y[1]; };

/** [{entry, copy}] of the whole collection */
export function allCopies() {
  const out = [];
  for (const entry of store.items.values()) for (const copy of entry.copies) out.push({ entry, copy });
  return out;
}
export const displayName = e => e.printed_name || e.name;
const byName = (a, b) => displayName(a.entry).localeCompare(displayName(b.entry), 'de');
const byColourName = (a, b) => COLOURS.indexOf(colourOf(a.entry.oracle_id)) - COLOURS.indexOf(colourOf(b.entry.oracle_id)) || byName(a, b);
/** the order inside a section: by name ("Nach Farbe"), else by colour (W U B R G multi colourless), then name */
const byInner = (a, b) => (SYSTEMS[settings.system].byName ? byName(a, b) : byColourName(a, b));

/** "2× Removal, 1× Ordner" for an entry */
export function placesText(entry) {
  const m = new Map();
  for (const c of [...entry.copies].sort(cmpPlace)) { const n = placeName(c); m.set(n, (m.get(n) || 0) + 1); }
  return [...m].map(([n, k]) => (entry.qty > 1 ? `${k}× ` : '') + n).join(', ');
}

/** price per copy in EUR (null: no EUR price known, or a proxy: it is worth nothing and never a binder / Bulk card) */
export const eurOf = entry => { if (entry.proxy) return null; const p = priceOf(entry); return p && p.cur === '€' ? p.value : null; };

// Home assignment: the newest section of a function that is not full; the copy that would overflow it starts the next one.
function fills() {
  const fill = new Map(), top = new Map();
  for (const { copy } of allCopies()) {
    if (!copy.h) continue;
    fill.set(copy.h, (fill.get(copy.h) || 0) + 1);
    const [r, n] = copy.h.split(':');
    top.set(r, Math.max(top.get(r) || 0, Number(n)));
  }
  return { fill, top };
}
function nextHome(state, role, events) {
  let n = state.top.get(role) || 0;
  if (!n || (state.fill.get(`${role}:${n}`) || 0) >= settings.capacity) {
    n += 1;
    state.top.set(role, n);
    events.push(sectionName(`${role}:${n}`));
  }
  const h = `${role}:${n}`;
  state.fill.set(h, (state.fill.get(h) || 0) + 1);
  return h;
}
function release(state, h) { if (h) state.fill.set(h, Math.max(0, (state.fill.get(h) || 0) - 1)); }

/** fills in missing oracle ids from the card data (old entries, old backups); db = engine CardDb */
export async function backfillOracles(db) {
  const todo = [];
  for (const e of store.items.values()) {
    if (e.oracle_id) continue;
    const i = db.indexOfId(e.card_id);
    if (i >= 0) todo.push({ ...e, oracle_id: db.oracleId(db.row(i).oracle) });
  }
  await store.saveEntries(todo);
  return todo.length;
}

/** gives every copy without a home the section of its function -> names of the sections started (for the toast) */
export async function placeCopies() {
  if (!roles) return [];
  const state = fills(), events = [], changed = [];
  const entries = [...store.items.values()].sort((a, b) => String(a.added).localeCompare(String(b.added)));
  for (const e of entries) {
    if (!e.copies.some(c => !c.h)) continue;
    const group = groupOf(e);
    if (!group) continue;
    changed.push({ ...e, copies: e.copies.map(c => c.h ? c : { ...c, h: nextHome(state, group, events) }) });
  }
  await store.saveEntries(changed);
  return events;
}

// ---- suggestions --------------------------------------------------------------------------------------------------------
/** binder suggestions: copies outside the binder worth at least binderMin, most valuable first */
export function binderSuggestions(min = settings.binderMin) {
  const out = [];
  if (!settings.binderOn) return out;
  for (const it of allCopies()) {
    if (it.copy.b) continue;
    const eur = eurOf(it.entry);
    if (eur != null && eur >= min) out.push({ ...it, eur });
  }
  return out.sort((a, b) => b.eur - a.eur || displayName(a.entry).localeCompare(displayName(b.entry), 'de'));
}
export function inBinderOracles() {
  const ids = new Set();
  for (const e of store.items.values()) if (e.oracle_id && e.copies.some(c => c.b)) ids.add(e.oracle_id);
  return ids;
}
function bulkReasons(entry, eur) {
  const rank = rankOf(entry.oracle_id);
  return [rank ? `selten gespielt: Rang ${fmtNum(rank)}` : 'selten gespielt: kein EDHREC-Rang', `Wert ${fmtEur(eur)}`];
}
/** Bulk suggestions: not in Bulk or the binder, EUR price known and below 0.20, EDHREC rank above 15,000 or none, no copy
 *  of the card in the binder, not kept; sorted by section, colour, name */
export function bulkSuggestions() {
  const binderCards = inBinderOracles();
  const out = [];
  if (!settings.bulkOn) return out;
  for (const it of allCopies()) {
    const { entry, copy } = it;
    if (copy.b || homeRole(copy.h) === BULK || !entry.oracle_id || !roles) continue;
    if (isKept(entry.oracle_id) || binderCards.has(entry.oracle_id)) continue;
    const eur = eurOf(entry);
    const rank = rankOf(entry.oracle_id);
    if (eur == null || eur >= BULK_MAX_EUR || (rank && rank <= BULK_MIN_RANK)) continue;
    out.push({ ...it, eur, reasons: bulkReasons(entry, eur) });
  }
  return out.sort((a, b) => cmpPlace(a.copy, b.copy) || byColourName(a, b));
}
/** 'binder' | 'bulk' | null for one copy (the same rules as the two lists) */
export function hintOf(entry, copy, binderCards = inBinderOracles()) {
  if (copy.b) return null;
  const eur = eurOf(entry);
  if (settings.binderOn && eur != null && eur >= settings.binderMin) return 'binder';
  if (!settings.bulkOn || homeRole(copy.h) === BULK || !entry.oracle_id || !roles || eur == null || eur >= BULK_MAX_EUR) return null;
  if (isKept(entry.oracle_id) || binderCards.has(entry.oracle_id)) return null;
  const rank = rankOf(entry.oracle_id);
  return rank && rank <= BULK_MIN_RANK ? null : 'bulk';
}

// ---- moves (all saved at once; refs = [{key, id}]) -----------------------------------------------------------------------
async function edit(refs, fn) {
  const byKey = new Map();
  for (const r of refs) { if (!byKey.has(r.key)) byKey.set(r.key, new Set()); byKey.get(r.key).add(r.id); }
  const state = fills(), events = [], changed = [];
  for (const [key, ids] of byKey) {
    const e = store.items.get(key);
    if (!e) continue;
    changed.push({ ...e, copies: e.copies.map(c => ids.has(c.id) ? fn({ ...c }, e, state, events) : c) });
  }
  await store.saveEntries(changed, refs.length);
  return events;
}
const now = () => new Date().toISOString();
/** "In Ordner gelegt" (the home section stays for when it comes out again) */
export const toBinder = refs => edit(refs, c => ({ ...c, b: 1, s: now() }));
/** "Aus dem Ordner genommen": back into its section, on the pile until it is filed */
export const fromBinder = refs => edit(refs, (c, e, st, ev) => ({ ...c, b: 0, h: c.h || (groupOf(e) ? nextHome(st, groupOf(e), ev) : null), at: now(), s: null }));
/** "In Bulk gelegt": Bulk becomes the home -> sections started */
export const toBulk = refs => edit(refs, (c, e, st, ev) => { release(st, c.h); return { ...c, b: 0, h: nextHome(st, BULK, ev), s: now() }; });
/** "Aus Bulk zurück": into the section of its function */
export const fromBulk = refs => edit(refs, (c, e, st, ev) => { release(st, c.h); return { ...c, b: 0, h: groupOf(e) ? nextHome(st, groupOf(e), ev) : null, s: now() }; });
/** tick off as put away (done) or put back on the pile */
export const mark = (refs, done) => edit(refs, c => ({ ...c, s: done ? now() : null }));

/** "Behalten" (true): never a Bulk suggestion again; false = "Wieder vorschlagen" */
export async function setKeep(oid, keep) {
  if (!oid) return;
  if (keep) verdicts = { ...verdicts, [oid]: now() };
  else { verdicts = { ...verdicts }; delete verdicts[oid]; }
  await store.setMeta('verdicts', verdicts);
  store.notify();
}
/** the cards marked "Behalten", newest first: [{oracle_id, at, entry (one of the collection, may be null)}] */
export function keptList() {
  const any = new Map();
  for (const e of store.items.values()) if (e.oracle_id && !any.has(e.oracle_id)) any.set(e.oracle_id, e);
  return Object.entries(verdicts).map(([oracle_id, at]) => ({ oracle_id, at, entry: any.get(oracle_id) || null }))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/** "Aufgabe ändern": role key, or null for the automatic one. Copies of the card in a function section move to the section
 *  of the new function and go back on the pile (the card has to be moved by hand). -> sections started */
export async function setRole(oid, role) {
  if (!oid) return [];
  const before = roleOf(oid);
  overrides = { ...overrides };
  if (role && role !== autoRole(oid)) overrides[oid] = role; else delete overrides[oid];
  await store.setMeta('roleOverrides', overrides);
  const after = roleOf(oid);
  if (!after || after === before || settings.system !== 'role') { store.notify(); return []; }
  const refs = [];
  for (const e of store.items.values()) if (e.oracle_id === oid) for (const c of e.copies) if (c.h && homeRole(c.h) !== BULK) refs.push({ key: e.key, id: c.id });
  if (!refs.length) { store.notify(); return []; }
  return edit(refs, (c, e, st, ev) => { release(st, c.h); return { ...c, h: nextHome(st, after, ev), at: c.b ? c.at : now(), s: c.b ? c.s : null }; });
}

// ---- overview -----------------------------------------------------------------------------------------------------------
/** the sections in the order of the index cards, then the binder: [{h, name, count (lying there), away (in the binder)}] */
export function sections() {
  const m = new Map();
  let binder = 0, none = 0;
  for (const { copy } of allCopies()) {
    if (copy.b) binder++;
    if (!copy.h) { if (!copy.b) none++; continue; }
    const s = m.get(copy.h) || { h: copy.h, name: sectionName(copy.h), count: 0, away: 0 };
    if (copy.b) s.away++; else s.count++;
    m.set(copy.h, s);
  }
  const out = [...m.values()].sort((a, b) => cmpPlace({ h: a.h }, { h: b.h }));
  if (binder) out.push({ h: 'binder', name: 'Ordner', count: binder, away: 0 });
  if (none) out.push({ h: null, name: 'Noch ohne Fach', count: none, away: 0 });
  return out;
}
/** what lies in one place ('binder', a section, null = without one), in the order of the section (byInner) */
export function contents(h) {
  return allCopies().filter(({ copy }) => h === 'binder' ? copy.b : !copy.b && (copy.h || null) === h).sort(h === 'binder' ? byColourName : byInner);
}

// ---- the pile ("Einsortieren") ------------------------------------------------------------------------------------------
const pad = n => String(n).padStart(2, '0');
export const dayOf = iso => { const d = new Date(iso); return isNaN(d) ? '' : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

/** -> { open, days: [{day, open, total}], groups: [{key, name, kind ('to_binder' | 'place'), items: [{entry, copy, hint, eur, day}]}] } */
export function sortingQueue({ openOnly = true, day = '' } = {}) {
  const days = new Map();
  const binderCards = inBinderOracles();
  const items = [];
  for (const it of allCopies()) {
    const d = dayOf(it.copy.at);
    const rec = days.get(d) || { day: d, open: 0, total: 0 };
    rec.total++;
    if (!it.copy.s) rec.open++;
    days.set(d, rec);
    if (openOnly && it.copy.s) continue;
    if (day && d !== day) continue;
    items.push({ ...it, day: d, hint: hintOf(it.entry, it.copy, binderCards), eur: eurOf(it.entry), color: colourOf(it.entry.oracle_id) });
  }
  const toBinderPile = items.filter(i => i.hint === 'binder').sort((a, b) => b.eur - a.eur || displayName(a.entry).localeCompare(displayName(b.entry), 'de'));
  const groups = new Map();
  for (const i of items) {
    if (i.hint === 'binder') continue;
    const k = i.copy.b ? 'binder' : i.copy.h || '';
    if (!groups.has(k)) groups.set(k, { key: k, name: i.copy.b ? 'Ordner' : sectionName(i.copy.h), kind: 'place', sample: i.copy, items: [] });
    groups.get(k).items.push(i);
  }
  const list = [...groups.values()].sort((a, b) => cmpPlace(a.sample, b.sample));
  for (const g of list) { g.items.sort(g.key === 'binder' ? byColourName : byInner); delete g.sample; }
  if (toBinderPile.length) list.unshift({ key: 'to_binder', name: `In den Ordner (ab ${fmtEur(settings.binderMin)})`, kind: 'to_binder', items: toBinderPile });
  return {
    open: [...days.values()].reduce((s, d) => s + d.open, 0),
    days: [...days.values()].sort((a, b) => b.day.localeCompare(a.day)),
    groups: list,
  };
}
export const openCount = () => allCopies().reduce((n, x) => n + (x.copy.s ? 0 : 1), 0);
/** refs of every copy put on the pile on one day */
export const refsOfDay = (day, open = true) => allCopies().filter(x => dayOf(x.copy.at) === day && (!open || !x.copy.s)).map(x => ({ key: x.entry.key, id: x.copy.id }));

// ---- changing the system ("Umräumliste") --------------------------------------------------------------------------------
/** what a switch to `system` would change. Every copy outside Bulk gets the section of its group in the new system
 *  (numbered afresh, in the order the cards were added). -> { system, moves: [{entry, copy, from, to}], homes: Map(copy id
 *  -> new home), same, unknown (copies whose card data is not loaded yet; they keep their place) } */
export function planSystem(system) {
  if (!SYSTEMS[system]) throw new Error('unknown system ' + system);
  const state = { fill: new Map(), top: new Map() }, events = [];
  const keep = [];
  for (const { copy } of allCopies()) if (homeRole(copy.h) === BULK) keep.push(copy.h);
  for (const h of keep) { state.fill.set(h, (state.fill.get(h) || 0) + 1); const [r, n] = h.split(':'); state.top.set(r, Math.max(state.top.get(r) || 0, Number(n))); }
  const cap = settings.capacity;
  const list = allCopies().filter(x => homeRole(x.copy.h) !== BULK)
    .sort((a, b) => String(a.entry.added).localeCompare(String(b.entry.added)) || String(a.copy.at).localeCompare(String(b.copy.at)));
  const homes = new Map(), moves = [];
  let same = 0, unknown = 0;
  for (const it of list) {
    const g = groupOf(it.entry, system);
    if (!g) { unknown++; continue; }
    let n = state.top.get(g) || 0;
    if (!n || (state.fill.get(`${g}:${n}`) || 0) >= cap) { n += 1; state.top.set(g, n); }
    const h = `${g}:${n}`;
    state.fill.set(h, (state.fill.get(h) || 0) + 1);
    homes.set(it.copy.id, h);
    if (h === it.copy.h) same++;
    else moves.push({ ...it, from: it.copy.b ? 'Ordner' : sectionName(it.copy.h), to: sectionName(h) });
  }
  moves.sort((a, b) => cmpPlace({ h: homes.get(a.copy.id) }, { h: homes.get(b.copy.id) }) || a.from.localeCompare(b.from) || byName(a, b));
  return { system, moves, homes, same, unknown };
}
/** applies a plan after the user's OK: the new system, the new homes; moved copies outside the binder go onto the pile */
export async function applySystem(plan) {
  settings = { ...settings, system: plan.system };
  await store.setMeta('storage', settings);
  const changed = [];
  for (const e of store.items.values()) {
    let touched = false;
    const copies = e.copies.map(c => {
      const h = plan.homes.get(c.id);
      if (!h || h === c.h) return c;
      touched = true;
      return c.b ? { ...c, h } : { ...c, h, at: now(), s: null };
    });
    if (touched) changed.push({ ...e, copies });
  }
  await store.saveEntries(changed, plan.moves.length);
  if (!changed.length) store.notify();
  return plan.moves.length;
}
