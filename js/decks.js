// Commander decks (store.js: decks). A deck lists its cards by oracle id (any printing counts); the commander(s) are listed
// apart and count as cards 1 and 2 of the 100. "Besitz" is what the collection holds of the card, "in anderem Deck" what the
// other decks use of it, "fehlt" what is left over. Rules: commander.js.

import * as store from './store.js';
import { canBeCommander, checkDeck } from './commander.js';

const now = () => new Date().toISOString();
const slim = c => ({ oracle_id: c.oracle_id, card_id: c.card_id, name: c.name, printed_name: c.printed_name || null });
export const deckList = () => [...store.decks.values()].sort((a, b) => String(b.updated).localeCompare(String(a.updated)));

export async function createDeck(name) {
  const d = { id: store.deckId(), name: String(name || '').trim() || 'Neues Deck', created: now(), updated: now(), commanders: [], cards: [] };
  return store.saveDeck(d);
}
export const renameDeck = (id, name) => store.saveDeck({ ...store.decks.get(id), name: String(name || '').trim() || 'Deck' });
export const removeDeck = id => store.deleteDeck(id);

/** adds qty copies of a card to the main deck -> the deck. A card that is the commander of this deck is not added twice. */
export async function addCard(id, card, qty = 1) {
  const d = store.decks.get(id);
  if (!d || !card.oracle_id) return d;
  if (d.commanders.some(c => c.oracle_id === card.oracle_id)) return d;
  const cards = [...d.cards];
  const k = cards.findIndex(c => c.oracle_id === card.oracle_id);
  if (k >= 0) cards[k] = { ...cards[k], qty: cards[k].qty + qty };
  else cards.push({ ...slim(card), qty });
  return store.saveDeck({ ...d, cards });
}
/** sets the quantity of a card (0 removes it) */
export async function setQty(id, oid, qty) {
  const d = store.decks.get(id);
  const cards = d.cards.map(c => c.oracle_id === oid ? { ...c, qty } : c).filter(c => c.qty > 0);
  return store.saveDeck({ ...d, cards });
}
/** makes a card a commander (max. two) -> {ok, message}; a card that cannot lead a deck is refused */
export async function setCommander(id, card) {
  const d = store.decks.get(id);
  const can = canBeCommander(card.oracle_id);
  if (can.ok === false) return { ok: false, message: `„${card.printed_name || card.name}“ kann nicht Commander sein (${can.reason}).` };
  if (d.commanders.some(c => c.oracle_id === card.oracle_id)) return { ok: true, message: '' };
  if (d.commanders.length >= 2) return { ok: false, message: 'Ein Deck hat höchstens zwei Commander. Nimm zuerst einen heraus.' };
  const cards = d.cards.filter(c => c.oracle_id !== card.oracle_id);
  await store.saveDeck({ ...d, commanders: [...d.commanders, slim(card)], cards });
  return { ok: true, message: '' };
}
export async function removeCommander(id, oid) {
  const d = store.decks.get(id);
  return store.saveDeck({ ...d, commanders: d.commanders.filter(c => c.oracle_id !== oid) });
}

// ---- what the collection and the other decks hold -------------------------------------------------------------------------
export function ownedMap() {
  const m = new Map();
  for (const e of store.items.values()) if (e.oracle_id) m.set(e.oracle_id, (m.get(e.oracle_id) || 0) + e.qty);
  return m;
}
/** copies of a card the other decks use */
export function usedElsewhere(id) {
  const m = new Map();
  for (const d of store.decks.values()) {
    if (d.id === id) continue;
    for (const c of [...d.commanders.map(x => ({ ...x, qty: 1 })), ...d.cards]) m.set(c.oracle_id, (m.get(c.oracle_id) || 0) + c.qty);
  }
  return m;
}
/** the deck as the rules see it plus a status per card: { deck, check, rows: [{card, qty, owned, other, missing, commander}], missing } */
export function view(id) {
  const deck = store.decks.get(id);
  const owned = ownedMap(), other = usedElsewhere(id);
  const status = (c, qty) => {
    const o = owned.get(c.oracle_id) || 0, x = other.get(c.oracle_id) || 0;
    return { owned: o, other: x, missing: Math.max(0, qty - Math.max(0, o - x)) };
  };
  const rows = [
    ...deck.commanders.map(c => ({ card: c, qty: 1, commander: true, ...status(c, 1) })),
    ...deck.cards.map(c => ({ card: c, qty: c.qty, commander: false, ...status(c, c.qty) })),
  ];
  return { deck, check: checkDeck(deck.commanders, deck.cards), rows, missing: rows.reduce((s, r) => s + r.missing, 0) };
}
