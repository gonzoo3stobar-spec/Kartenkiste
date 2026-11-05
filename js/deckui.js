// Deck screen: the list of decks, one deck (commander, legality, role statistics, cards with "Besitz / in anderem Deck / fehlt"),
// adding cards by typing, from the collection or by scanning (the scan screen has a deck switch). UI text German.

import * as store from './store.js';
import * as st from './storage.js';
import * as dk from './decks.js';
import { canBeCommander, identityText, ROLE_HINTS, CURVE, TYPE_NAMES, TYPE_ORDER } from './commander.js';
import { openTyping, ownedOf } from './typing.js';

let h = null;   // { openSheet, closeSheet, toast, esc, imgUrl, cardOf, show, setScanDeck, scanDeck() }
let openId = null;
const fmt = n => Number(n).toLocaleString('de-DE');
export function initDeckUi(helpers) { h = helpers; }
export const currentDeck = () => openId;

export function renderDecks() {
  const el = document.getElementById('screen-decks');
  if (openId && !store.decks.has(openId)) openId = null;
  el.innerHTML = openId ? deckHtml(openId) : listHtml();
  (openId ? bindDeck : bindList)(el);
}

// ---- list of decks -------------------------------------------------------------------------------------------------------
function listHtml() {
  const list = dk.deckList(), esc = h.esc;
  return `<div class="coll-head"><h2>Decks <span class="small">Commander</span></h2></div>
    <div class="buttons"><button class="primary" data-act="new">Neues Deck</button></div>
    ${list.length ? `<ul class="menu decks">${list.map(d => {
      const v = dk.view(d.id), n = v.check.stats.total;
      return `<li data-open="${esc(d.id)}"><b>${esc(d.name)}${d.commanders.length ? `<span class="small">${esc(d.commanders.map(c => c.printed_name || c.name).join(' & '))}</span>` : ''}</b>
        <span class="${v.check.ok ? 'ok' : ''}">${n}/100${v.check.ok ? ' ✓' : ''}${v.missing ? ` · ${v.missing} fehlen` : ''}</span></li>`;
    }).join('')}</ul>` : `<div class="box"><p><b>Noch kein Deck.</b> Lege ein Commander-Deck an und füge Karten per Scan, Eintippen oder aus deiner Sammlung hinzu. Die App prüft die Commander-Regeln für dich.</p></div>`}`;
}
function bindList(el) {
  el.querySelector('[data-act=new]').onclick = () => {
    const b = h.openSheet(`<h2>Neues Deck</h2><input type="text" data-name placeholder="Name des Decks" autocomplete="off" maxlength="60">
      <div class="buttons stack"><button class="primary" data-act="ok">Anlegen</button></div>`);
    const input = b.querySelector('[data-name]');
    setTimeout(() => input.focus(), 50);
    const go = async () => { const d = await dk.createDeck(input.value); h.closeSheet(); openId = d.id; renderDecks(); };
    b.querySelector('[data-act=ok]').onclick = go;
    input.onkeydown = e => { if (e.key === 'Enter') go(); };
  };
  el.querySelectorAll('[data-open]').forEach(li => { li.onclick = () => { openId = li.dataset.open; renderDecks(); window.scrollTo(0, 0); }; });
}

// ---- one deck --------------------------------------------------------------------------------------------------------------
const bar = (n, max, cls = '') => `<i class="${cls}" style="width:${max ? Math.round(100 * Math.min(n, max) / max) : 0}%"></i>`;
function statsHtml(s) {
  const roles = st.ROLE_KEYS.map(k => {
    const hint = ROLE_HINTS[k], n = s.roles[k];
    const state = hint ? (n < hint[0] ? 'low' : n > hint[1] ? 'high' : 'good') : '';
    return `<div class="stat"><span>${h.esc(st.ROLE_LABELS[k])}</span><span class="meter">${bar(n, hint ? hint[1] * 1.3 : 20, state)}</span>
      <b>${n}</b><span class="small">${hint ? `üblich ${hint[0]}–${hint[1]}` : ''}</span></div>`;
  }).join('');
  const maxC = Math.max(1, ...Object.values(s.curve));
  const curve = `<div class="curve">${CURVE.map(k => `<div><span class="cb"><i style="height:${Math.round(100 * s.curve[k] / maxC)}%"></i></span><b>${s.curve[k]}</b><span class="small">${k}</span></div>`).join('')}</div>`;
  const colors = ['W', 'U', 'B', 'R', 'G', 'C'].filter(c => s.colors[c]).map(c => `<span class="pip pip-${c}">${c === 'C' ? '◇' : c} ${s.colors[c]}</span>`).join(' ');
  const types = [...TYPE_ORDER, ''].concat(['L']).map(t => t && s.types[t] ? `${TYPE_NAMES[t]} ${s.types[t]}` : '').filter(Boolean).join(' · ');
  return `<h3>Aufgaben im Deck</h3><div class="stats">${roles}</div>
    <h3>Manakosten</h3>${curve}<div class="small">Durchschnitt ${String(s.avgMv).replace('.', ',')} · ${s.nonlands} Nicht-Länder, ${s.lands} Länder</div>
    <h3>Farben und Typen</h3><div>${colors || '–'}</div><div class="small">${h.esc(types)}</div>`;
}
function deckHtml(id) {
  const v = dk.view(id), d = v.deck, esc = h.esc, s = v.check.stats;
  const bad = new Set(v.check.errors.filter(e => ['identity', 'legality', 'singleton'].includes(e.code)).flatMap(e => e.cards));
  const scanning = h.scanDeck() === id;
  const groups = new Map();
  for (const r of v.rows.filter(x => !x.commander)) {
    const t = st.ruleOf?.(r.card.oracle_id)?.ptype || 'O';
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(r);
  }
  const rowHtml = r => {
    const c = r.card, name = c.printed_name || c.name;
    const status = r.missing ? `<span class="bad">${r.missing} fehlt${r.missing === 1 ? '' : 'en'}</span>` : '<span class="ok">Besitz ✓</span>';
    return `<div class="srow deckrow${bad.has(c.name) ? ' problem' : ''}" data-oid="${esc(c.oracle_id)}">
      <img class="thumb" loading="lazy" crossorigin="anonymous" src="${h.imgUrl(c.card_id, 'small')}" data-big="${esc(c.card_id)}" alt="">
      <div class="sinfo"><b class="sname" data-card>${esc(name)}</b>
        <div class="small">${status} · Besitz ${r.owned}${r.other ? ` · ${r.other} in anderem Deck` : ''}${bad.has(c.name) ? ' · <span class="bad">Regelproblem</span>' : ''}</div></div>
      <div class="sprice">${r.qty}×</div></div>`;
  };
  const errs = v.check.errors.map(e => `<li class="bad">${esc(e.message)}</li>`).join('') + v.check.warnings.map(e => `<li class="small">${esc(e.message)}</li>`).join('');
  return `<div class="deckhead"><button class="xs back" data-act="back">← Alle Decks</button>
      <h2 data-act="rename" title="Name ändern">${esc(d.name)} <span class="small">✎</span></h2></div>
    <div class="cmdrs">${d.commanders.length ? d.commanders.map(c => `<div class="cmdr"><img crossorigin="anonymous" src="${h.imgUrl(c.card_id, 'small')}" data-big="${esc(c.card_id)}" alt="">
        <div><b>${esc(c.printed_name || c.name)}</b><div class="small">Commander</div><button class="xs" data-act="uncmd" data-oid="${esc(c.oracle_id)}">Kein Commander mehr</button></div></div>`).join('')
      : '<div class="box small"><b>Noch kein Commander.</b> Tippe bei einer Karte auf „Als Commander“, oder suche ihn mit „Commander wählen“.</div>'}</div>
    <div class="deckstate ${v.check.ok ? 'okbox' : ''}"><b>${s.total}/100 Karten</b>${s.identity.length || d.commanders.length ? ` · Farbidentität ${esc(identityText(new Set(s.identity)))}` : ''}
      ${v.check.ok ? '<div class="ok">Das Deck ist regelkonform ✓</div>' : `<ul class="errs">${errs}</ul>`}
      ${v.missing ? `<div class="small">Es fehlen noch ${v.missing} ${v.missing === 1 ? 'Karte' : 'Karten'} aus deiner Sammlung.</div>` : ''}</div>
    <div class="buttons"><button data-act="type">Eintippen</button><button data-act="coll">Aus der Sammlung</button>
      <button data-act="cmdsearch">Commander wählen</button></div>
    <label class="check scanline"><input type="checkbox" data-scan ${scanning ? 'checked' : ''}> Beim Scannen in dieses Deck legen</label>
    ${[...groups.keys()].sort((a, b) => TYPE_ORDER.indexOf(a) - TYPE_ORDER.indexOf(b)).map(t => `<div class="sgroup"><div class="sgroup-head"><h3>${TYPE_NAMES[t]} <span class="small">${groups.get(t).reduce((n, r) => n + r.qty, 0)}</span></h3></div>
      ${groups.get(t).sort((a, b) => (a.card.printed_name || a.card.name).localeCompare(b.card.printed_name || b.card.name, 'de')).map(rowHtml).join('')}</div>`).join('')}
    ${d.cards.length ? '' : '<p class="empty">Noch keine Karten im Deck.</p>'}
    ${statsHtml(s)}
    <div class="buttons"><button class="danger" data-act="delete">Deck löschen</button></div>`;
}
function bindDeck(el) {
  const id = openId, esc = h.esc;
  const q = s => el.querySelector(s);
  q('[data-act=back]').onclick = () => { openId = null; renderDecks(); };
  q('[data-act=rename]').onclick = () => {
    const name = prompt('Name des Decks', store.decks.get(id).name);
    if (name !== null) dk.renameDeck(id, name);
  };
  q('[data-act=delete]').onclick = async () => {
    if (!confirm(`Das Deck „${store.decks.get(id).name}“ löschen? Deine Sammlung bleibt unberührt.`)) return;
    await dk.removeDeck(id);
    if (h.scanDeck() === id) h.setScanDeck(null);
    openId = null; renderDecks();
  };
  q('[data-scan]').onchange = e => { h.setScanDeck(e.target.checked ? id : null); h.toast(e.target.checked ? 'Beim Scannen kommen die Karten in Sammlung und Deck.' : 'Scannen legt die Karten wieder nur in die Sammlung.'); };
  q('[data-act=type]').onclick = () => openTyping(typingTarget(id));
  q('[data-act=cmdsearch]').onclick = () => openTyping({ ...typingTarget(id), label: 'Suche den Commander. Er zählt als erste Karte des Decks.', addLabel: 'Als Commander', commanderBtn: false,
    add: (card, o) => addCardTo(id, card, { ...o, commander: true }) });
  q('[data-act=coll]').onclick = () => openCollectionPicker(id);
  el.querySelectorAll('[data-act=uncmd]').forEach(b => { b.onclick = () => dk.removeCommander(id, b.dataset.oid); });
  el.querySelectorAll('.deckrow [data-card]').forEach(n => { n.onclick = () => openCardSheet(id, n.closest('.deckrow').dataset.oid); });
}

/** adds a card to a deck (and to the collection when `own`), or makes it commander -> false when refused */
export async function addCardTo(id, card, { qty = 1, foil = 0, proxy = 0, own = false, commander = false, quiet = false } = {}) {
  const name = card.printed_name || card.name;
  if (own) await h.addToCollection(card, { qty, foil, proxy });
  if (commander) {
    const r = await dk.setCommander(id, card);
    if (!r.ok) { h.toast(esc2(r.message), { ms: 6000 }); return false; }
    if (!quiet) h.toast(`<b>${esc2(name)}</b> ist jetzt Commander.`);
    return true;
  }
  await dk.addCard(id, card, qty);
  if (!quiet) h.toast(`<b>${esc2(name)}</b> liegt im Deck${own ? ' und in der Sammlung' : ''}.`);
  return true;
}
const esc2 = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function typingTarget(id) {
  return { label: `Ins Deck „${store.decks.get(id).name}“`, deck: true, addLabel: 'Ins Deck', commanderBtn: true, add: (card, o) => addCardTo(id, card, o) };
}

function openCardSheet(id, oid) {
  const v = dk.view(id), r = v.rows.find(x => x.card.oracle_id === oid);
  if (!r) return;
  const c = r.card, name = c.printed_name || c.name, esc = h.esc;
  const can = canBeCommander(oid);
  const b = h.openSheet(`<div class="result"><img class="cardimg" crossorigin="anonymous" src="${h.imgUrl(c.card_id)}" alt="${esc(name)}">
      <div class="result-info"><h2>${esc(name)}</h2><div class="small">${esc(st.ROLE_LABELS[st.roleOf(oid)] || '')}</div>
        <div class="small">Besitz ${r.owned}${r.other ? ` · ${r.other} in anderem Deck` : ''}${r.missing ? ` · <span class="bad">${r.missing} fehlen</span>` : ''}</div>
        <div class="row"><div class="stepper"><button data-act="minus" aria-label="weniger">−</button><b data-qty>${r.qty}</b><button data-act="plus" aria-label="mehr">+</button></div></div></div></div>
    <div class="buttons stack">${can.ok !== false && !r.commander ? '<button data-act="cmd">Als Commander</button>' : ''}
      <button class="danger" data-act="remove">Aus dem Deck entfernen</button></div>`);
  b.querySelector('[data-act=minus]').onclick = async () => { await dk.setQty(id, oid, r.qty - 1); h.closeSheet(); if (r.qty > 1) openCardSheet(id, oid); };
  b.querySelector('[data-act=plus]').onclick = async () => { await dk.setQty(id, oid, r.qty + 1); h.closeSheet(); openCardSheet(id, oid); };
  b.querySelector('[data-act=remove]').onclick = async () => { await dk.setQty(id, oid, 0); h.closeSheet(); };
  b.querySelector('[data-act=cmd]')?.addEventListener('click', async () => { const res = await dk.setCommander(id, c); h.closeSheet(); if (!res.ok) h.toast(esc(res.message), { ms: 6000 }); });
}

function openCollectionPicker(id) {
  const esc = h.esc;
  const b = h.openSheet(`<h2>Aus der Sammlung</h2><input type="search" data-q placeholder="In der Sammlung suchen" autocomplete="off"><ul class="plist" data-list></ul>`);
  const list = b.querySelector('[data-list]');
  const render = () => {
    const f = b.querySelector('[data-q]').value.trim().toLowerCase();
    const d = store.decks.get(id);
    const by = new Map();
    for (const e of store.items.values()) { if (!e.oracle_id) continue; const x = by.get(e.oracle_id) || { e, n: 0 }; x.n += e.qty; by.set(e.oracle_id, x); }
    const rows = [...by.values()].filter(x => !f || (x.e.name || '').toLowerCase().includes(f) || (x.e.printed_name || '').toLowerCase().includes(f))
      .sort((a, c) => (a.e.printed_name || a.e.name).localeCompare(c.e.printed_name || c.e.name, 'de')).slice(0, 60);
    list.innerHTML = rows.map(({ e, n }) => {
      const inDeck = d.cards.find(c => c.oracle_id === e.oracle_id)?.qty || (d.commanders.some(c => c.oracle_id === e.oracle_id) ? 1 : 0);
      return `<li data-oid="${esc(e.oracle_id)}" data-key="${esc(e.key)}"><img loading="lazy" crossorigin="anonymous" src="${h.imgUrl(e.card_id, 'small')}" alt="">
        <div><b>${esc(e.printed_name || e.name)}</b><div class="small">Besitz ${n}× · ${inDeck ? `${inDeck}× in diesem Deck` : 'noch nicht im Deck'}</div></div><button class="xs" data-add>+ 1</button></li>`;
    }).join('') || '<li class="small">Nichts gefunden.</li>';
  };
  render();
  b.querySelector('[data-q]').oninput = render;
  list.onclick = async e => {
    const li = e.target.closest('li[data-oid]');
    if (!li || !e.target.closest('[data-add]')) return;
    const entry = store.items.get(li.dataset.key);
    await dk.addCard(id, { oracle_id: entry.oracle_id, card_id: entry.card_id, name: entry.name, printed_name: entry.printed_name }, 1);
    render();
  };
}
