// Live prices from Scryfall (api.scryfall.com/cards/collection, 75 cards per request, 100 ms between requests).
// The data pack carries no prices: Scryfall calls prices older than 24 h dangerously stale, so the app asks live, on a tap.
// Non-English printings usually have no price at Scryfall; for those the same printing in English (set + number) is asked.
//
// Stored in meta 'prices': { at (ISO), cards: { card_id: { eur, eur_foil, usd, usd_foil } } }  -- not part of the backup file.

import { getMeta, setMeta } from './store.js';

const API = 'https://api.scryfall.com/cards/collection';
const BATCH = 75, GAP_MS = 100;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = v => (v == null || v === '' ? null : Number(v));
const pick = c => ({ eur: num(c.prices?.eur), eur_foil: num(c.prices?.eur_foil), usd: num(c.prices?.usd), usd_foil: num(c.prices?.usd_foil) });

let cache = null;
export async function loadPrices() { if (!cache) cache = (await getMeta('prices')) || { at: null, cards: {} }; return cache; }
export const pricesAt = () => cache?.at || null;
export const stale = () => !cache?.at || Date.now() - Date.parse(cache.at) > 24 * 3600 * 1000;

/** price of one collection entry (per copy) -> { value, cur } | null; EUR first, USD when there is no EUR price */
export function priceOf(entry) {
  const p = cache?.cards?.[entry.card_id];
  if (!p) return null;
  const eur = entry.foil ? (p.eur_foil ?? p.eur) : (p.eur ?? p.eur_foil);
  if (eur != null) return { value: eur, cur: '€' };
  const usd = entry.foil ? (p.usd_foil ?? p.usd) : (p.usd ?? p.usd_foil);
  return usd != null ? { value: usd, cur: '$' } : null;
}
export const fmtPrice = p => p ? p.value.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + p.cur : '–';

/** total of the collection in EUR (entries without a EUR price are counted in `missing`; proxies count nothing, `proxies`) */
export function totalOf(entries) {
  let eur = 0, missing = 0, proxies = 0;
  for (const e of entries) {
    if (e.proxy) { proxies += e.qty; continue; }
    const p = priceOf(e);
    if (p && p.cur === '€') eur += p.value * e.qty; else missing += e.qty;
  }
  return { eur, missing, proxies };
}

async function post(identifiers) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 12000);
    try {
      const res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ identifiers }), signal: ctl.signal });
      if (res.status === 429) {
        if (attempt === 2) throw new Error('Die Preisabfrage ist gerade ausgelastet. Bitte später erneut versuchen.');
      } else {
        if (!res.ok) throw new Error('Scryfall antwortet mit ' + res.status);
        return await res.json();
      }
    } catch (e) {
      if (e?.name === 'AbortError') throw new Error('Die Preisabfrage dauert zu lange. Bitte später erneut versuchen.');
      throw e;
    } finally { clearTimeout(timer); }
    await sleep(1000 * (attempt + 1));
  }
}

/**
 * Fetches prices for the given cards ({card_id, lang, set_code, collector_number}) and stores them.
 * onProgress(done, total). -> number of cards with a price
 */
export async function refreshPrices(cards, onProgress = () => {}) {
  await loadPrices();
  const uniq = new Map();
  for (const c of cards) if (!uniq.has(c.card_id)) uniq.set(c.card_id, c);
  const list = [...uniq.values()];
  const found = {};
  for (let i = 0; i < list.length; i += BATCH) {
    if (i) await sleep(GAP_MS);
    const part = list.slice(i, i + BATCH);
    // English printings by id, others by set + number (the English one, which carries the price)
    const ids = part.map(c => c.lang === 'en' || !c.set_code ? { id: c.card_id } : { set: c.set_code, collector_number: c.collector_number });
    const res = await post(ids);
    const byId = new Map(), bySetCn = new Map();
    for (const card of res.data || []) { byId.set(card.id, card); bySetCn.set(card.set + '|' + card.collector_number, card); }
    for (const c of part) {
      const hit = byId.get(c.card_id) || bySetCn.get(c.set_code + '|' + c.collector_number);
      if (hit) found[c.card_id] = pick(hit);
    }
    onProgress(Math.min(i + BATCH, list.length), list.length);
  }
  cache = { at: new Date().toISOString(), cards: { ...cache.cards, ...found } };
  await setMeta('prices', cache);
  return Object.keys(found).length;
}

/** price of a single card right after a scan (one request; null when offline) */
export async function priceNow(card, foil = 0) {
  try {
    await loadPrices();
    const ident = card.lang === 'en' ? { id: card.card_id } : { set: card.set_code, collector_number: card.collector_number };
    const res = await post([ident]);
    const hit = res.data?.[0];
    if (!hit) return null;
    cache.cards[card.card_id] = pick(hit);
    await setMeta('prices', cache);
    return priceOf({ card_id: card.card_id, foil });
  } catch { return null; }
}
