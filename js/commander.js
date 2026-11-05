// Commander rules, ported from the home app (mtg-bibliothek server/commander.py; the per-card facts come from pack/roles.json):
// 100 cards, colour identity, singleton (except basics and "any number" cards), commander legality, partner pairs.
// Cards are { oracle_id, name, qty } (name = English oracle name, "A // B" for double faces).

import { ruleOf, roleOf, ROLE_KEYS } from './storage.js';

export const ROLE_HINTS = { ramp: [9, 11], draw: [9, 11], removal: [8, 10], wipe: [2, 4], land: [35, 38] };   // usual Commander counts
export const CURVE = ['0', '1', '2', '3', '4', '5', '6', '7+'];
export const TYPE_NAMES = { L: 'Länder', C: 'Kreaturen', P: 'Planeswalker', B: 'Schlachten', I: 'Spontanzauber', S: 'Hexereien', A: 'Artefakte', E: 'Verzauberungen', O: 'Sonstige' };
const TYPE_ORDER = 'CPBISAELO';
const WUBRG = 'WUBRG';

const norm = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const frontName = n => String(n || '').split(' // ')[0].trim();
export const identityText = set => { const l = [...WUBRG].filter(c => set.has(c)); return l.length ? l.map(c => `{${c}}`).join('') : '(farblos)'; };
const has = (r, t) => r.partner.includes(t);
const tokenValue = (r, p) => { const t = r.partner.find(x => x.startsWith(p)); return t ? t.slice(p.length) : null; };

export function canBeCommander(oid) {
  const r = ruleOf(oid);
  if (!r) return { ok: null, reason: 'unbekannt' };
  if (r.cmdr === 'y') return { ok: true, reason: '' };
  if (r.cmdr === 'k') return { ok: false, reason: 'Background nur als zweiter Commander zu „Choose a Background“' };
  return { ok: false, reason: 'keine legendäre Kreatur' };
}

/** may these commanders lead a deck together? -> {ok, reason} */
export function partnerOk(cmds) {
  if (!cmds.length) return { ok: false, reason: 'Kein Commander festgelegt.' };
  if (cmds.length === 1) return { ok: true, reason: 'Ein Commander.' };
  if (cmds.length > 2) return { ok: false, reason: `${cmds.length} Commander sind zu viele, erlaubt sind höchstens zwei.` };
  const [a, b] = cmds, ra = ruleOf(a.oracle_id), rb = ruleOf(b.oracle_id);
  if (!ra || !rb) return { ok: true, reason: 'unbekannt' };
  if (has(ra, 'P') && has(rb, 'P')) return { ok: true, reason: 'Partner' };
  const withTarget = (r, other) => { const t = tokenValue(r, 'W:'); return !!t && (norm(t) === norm(frontName(other.name)) || norm(t) === norm(other.name)); };
  if (withTarget(ra, b) && withTarget(rb, a)) return { ok: true, reason: 'Partner with' };
  if (has(ra, 'F') && has(rb, 'F')) return { ok: true, reason: 'Friends forever' };
  const qa = tokenValue(ra, 'Q:'), qb = tokenValue(rb, 'Q:');
  if (qa && qb && qa.toLowerCase() === qb.toLowerCase()) return { ok: true, reason: `Partner—${qa}` };
  if ((has(ra, 'D') && has(rb, 'T')) || (has(rb, 'D') && has(ra, 'T'))) return { ok: true, reason: "Doctor's companion" };
  if ((has(ra, 'B') && has(rb, 'G')) || (has(rb, 'B') && has(ra, 'G'))) return { ok: true, reason: 'Choose a Background' };
  return { ok: false, reason: `${a.name} und ${b.name} dürfen nicht zusammen Commander sein (kein gemeinsames Partner, „Partner with“ aufeinander, „Partner—…“ mit gleicher Eigenschaft, „Friends forever“, Doctor's companion oder Background).` };
}

export const combinedIdentity = cmds => { const s = new Set(); for (const c of cmds) for (const x of ruleOf(c.oracle_id)?.cid || []) s.add(x); return s; };

/** the stats of a deck: total, lands, curve, colours, types, roles (usual-count hints in ROLE_HINTS) */
export function deckStats(cmds, main) {
  const curve = Object.fromEntries(CURVE.map(k => [k, 0]));
  const colors = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
  const types = {};
  const roles = Object.fromEntries(ROLE_KEYS.map(k => [k, 0]));
  let lands = 0, nonland = 0, mvSum = 0, mainTotal = 0;
  for (const c of main) {
    const r = ruleOf(c.oracle_id), q = c.qty;
    mainTotal += q;
    const pt = r?.ptype || 'O';
    types[pt] = (types[pt] || 0) + q;
    if (r && r.cid.size) for (const x of r.cid) colors[x] += q; else colors.C += q;
    if (pt === 'L') { lands += q; roles.land += q; continue; }
    const mv = r?.mv || 0;
    curve[mv >= 7 ? '7+' : String(mv)] += q;
    mvSum += mv * q; nonland += q;
    const role = roleOf(c.oracle_id) || 'synergy';
    roles[role in roles ? role : 'synergy'] += q;
  }
  return { total: cmds.length + mainTotal, lands, nonlands: mainTotal - lands, avgMv: nonland ? Math.round(100 * mvSum / nonland) / 100 : 0,
    curve, colors, types, roles, identity: [...WUBRG].filter(c => combinedIdentity(cmds).has(c)) };
}

/** full legality check -> {ok, errors: [{code, message, cards}], warnings, stats}; codes count singleton identity legality commander partner */
export function checkDeck(cmds, main) {
  const errors = [], warnings = [];
  const err = (code, message, cards = []) => errors.push({ code, message, cards });
  const pair = partnerOk(cmds);
  if (!cmds.length) err('commander', 'Kein Commander festgelegt.');
  for (const c of cmds) {
    const ok = canBeCommander(c.oracle_id);
    const bg = cmds.length === 2 && pair.ok && ruleOf(c.oracle_id)?.partner.includes('G');
    if (ok.ok === false && !bg) err('commander', `Kann nicht Commander sein: ${c.name} (${ok.reason}).`, [c.name]);
  }
  if (cmds.length && !pair.ok) err('partner', pair.reason, cmds.map(c => c.name));
  const total = cmds.length + main.reduce((s, c) => s + c.qty, 0);
  if (total !== 100) err('count', `Deck hat ${total} Karten, Commander braucht genau 100.`);
  const counts = new Map();
  for (const c of [...cmds.map(x => ({ ...x, qty: 1 })), ...main]) {
    const e = counts.get(c.oracle_id) || { name: c.name, oid: c.oracle_id, n: 0 };
    e.n += c.qty; counts.set(c.oracle_id, e);
  }
  const dupes = [...counts.values()].map(e => ({ ...e, limit: ruleOf(e.oid)?.limit === undefined ? 1 : ruleOf(e.oid).limit })).filter(e => e.limit !== null && e.n > e.limit);
  if (dupes.length) err('singleton', 'Mehrfach vorhanden: ' + dupes.map(e => e.limit === 1 ? `${e.name} (${e.n}×)` : `${e.name} (${e.n}×, erlaubt ${e.limit})`).join(', ') + '.', dupes.map(e => e.name));
  if (cmds.length) {
    const id = combinedIdentity(cmds);
    const outside = [...new Set(main.filter(c => { const r = ruleOf(c.oracle_id); return r && [...r.cid].some(x => !id.has(x)); }).map(c => c.name))];
    if (outside.length) err('identity', `Außerhalb der Farbidentität ${identityText(id)}: ${outside.join(', ')}.`, outside);
  }
  const banned = [], notLegal = [], unknown = [];
  for (const c of [...cmds, ...main]) {
    const r = ruleOf(c.oracle_id);
    const l = r ? r.legal : '?';
    if (l === 'b') banned.push(c.name); else if (l === 'n') notLegal.push(c.name); else if (l === '?') unknown.push(c.name);
  }
  const u = a => [...new Set(a)];
  if (banned.length) err('legality', 'Im Commander gebannt: ' + u(banned).join(', ') + '.', u(banned));
  if (notLegal.length) err('legality', 'Nicht legal in Commander: ' + u(notLegal).join(', ') + '.', u(notLegal));
  if (unknown.length) warnings.push({ code: 'legality', message: 'Legalität unbekannt: ' + u(unknown).join(', ') + '.', cards: u(unknown) });
  return { ok: !errors.length, errors, warnings, stats: deckStats(cmds, main) };
}

/** names of the cards that break a rule (for the red mark in the list) */
export const problemNames = check => new Set(check.errors.filter(e => ['identity', 'legality', 'singleton'].includes(e.code)).flatMap(e => e.cards));
export { TYPE_ORDER };
