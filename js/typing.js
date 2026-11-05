// "Eintippen": find a card by name (German or English, from about 2 letters) in the offline card data, or paste a list in the
// style "1 Sol Ring" and check it before adding. Used for the collection and for decks (the target decides what "add" does).
//
// target = { label ('Zur Sammlung hinzufügen'), deck (true: shows "Habe ich"), commander (true: list headers "Commander" count),
//            add(card, { qty, foil, proxy, own, commander }) -> Promise }   card = app.js cardOf() (+ oracle_id)

import * as store from './store.js';

let h = null;   // { ctx(), cardOf(i), openSheet, closeSheet, toast, esc, imgUrl, LANG_DE, priceOf, priceNow, fmtPrice }
export function initTyping(helpers) { h = helpers; }

const NON_CARD = new Set(['token', 'double_faced_token', 'emblem', 'art_series']);
const yearOf = c => (c.rel || '').slice(0, 4);
const byNewest = (a, b) => (b.rel || '').localeCompare(a.rel || '') || a.collector_number.localeCompare(b.collector_number, 'en', { numeric: true });

/** how many copies of a card (oracle id) are in the collection */
export function ownedOf(oid) { let n = 0; for (const e of store.items.values()) if (e.oracle_id === oid) n += e.qty; return n; }

/** all printings of an oracle index as cards, newest first, real cards only */
function printingsOf(oi) {
  const ctx = h.ctx();
  const all = ctx.db.printingsOf(oi).map(h.cardOf);
  const real = all.filter(c => !NON_CARD.has(ctx.db.row(c.i).layout));
  return (real.length ? real : all).sort(byNewest);
}
/** the printing a typed name stands for: the typed language first, else English, newest */
export function defaultPrinting(oi, lang = null) {
  const list = printingsOf(oi);
  return list.find(c => lang && c.lang === lang) || list.find(c => c.lang === 'en') || list[0] || null;
}

// ---- single card ------------------------------------------------------------------------------------------------------
function resultRows(hits) {
  const { esc, imgUrl } = h;
  return hits.map(x => {
    const p = x.pick, own = ownedOf(p.oracle_id);
    return `<li data-oi="${x.oi}" data-lang="${esc(x.lang)}"><img loading="lazy" crossorigin="anonymous" src="${imgUrl(p.card_id, 'small')}" alt="">
      <div><b>${esc(x.display)}</b><div class="small">${x.display !== p.name ? esc(p.name) + ' · ' : ''}${own ? `<span class="ok">${own}× in der Sammlung</span>` : 'noch nicht in der Sammlung'}</div></div></li>`;
  }).join('');
}
function searchHits(q) {
  const ctx = h.ctx();
  let hits = ctx.names.search(q, 12).filter(x => x.score >= 50);
  if (hits.length && hits[0].score >= 95) hits = hits.filter(x => x.score >= 75);
  const seen = new Set(), out = [];
  for (const x of hits) {
    if (seen.has(x.oi)) continue;
    seen.add(x.oi);
    const pick = defaultPrinting(x.oi, x.lang);
    if (pick) out.push({ ...x, pick });
    if (out.length >= 8) break;
  }
  return out;
}

export function openTyping(target) {
  const { esc } = h;
  const b = h.openSheet(`<h2>Eintippen</h2>
    <p class="small">${esc(target.label)}</p>
    <div class="cchips"><button class="cchip on" data-mode="one">Eine Karte</button><button class="cchip" data-mode="list">Liste einfügen</button></div>
    <div data-pane></div>`);
  const pane = b.querySelector('[data-pane]');
  const setMode = m => { b.querySelectorAll('[data-mode]').forEach(x => x.classList.toggle('on', x.dataset.mode === m)); (m === 'one' ? singlePane : listPane)(pane, target); };
  b.querySelectorAll('[data-mode]').forEach(x => { x.onclick = () => setMode(x.dataset.mode); });
  setMode('one');
}

function singlePane(pane, target) {
  const { esc } = h;
  pane.innerHTML = `<input type="search" data-q placeholder="Kartenname (Deutsch oder Englisch)" autocomplete="off" enterkeyhint="search">
    <ul class="plist" data-res></ul><div data-detail></div>`;
  const input = pane.querySelector('[data-q]'), res = pane.querySelector('[data-res]'), detail = pane.querySelector('[data-detail]');
  let timer = 0;
  input.oninput = () => {
    clearTimeout(timer);
    detail.innerHTML = ''; res.hidden = false;
    timer = setTimeout(() => {
      const q = input.value.trim();
      if (q.length < 2) { res.innerHTML = ''; return; }
      const hits = searchHits(q);
      res.innerHTML = hits.length ? resultRows(hits) : '<li class="small">Nichts gefunden.</li>';
    }, 150);
  };
  setTimeout(() => input.focus(), 50);
  res.onclick = e => {
    const li = e.target.closest('li[data-oi]');
    if (!li) return;
    const oi = Number(li.dataset.oi);
    res.hidden = true;
    pickCard(detail, oi, li.dataset.lang, target, () => { res.hidden = false; detail.innerHTML = ''; input.focus(); });
  };
}

/** edition / language / quantity / foil / proxy for one card, then add */
function pickCard(el, oi, lang, target, back) {
  const { esc, imgUrl, LANG_DE } = h;
  const prints = printingsOf(oi);
  const first = defaultPrinting(oi, lang);
  const editions = [];   // one per set + number
  for (const c of prints) if (!editions.some(x => x.set_code === c.set_code && x.collector_number === c.collector_number)) editions.push(c);
  let cur = first, qty = 1;
  const langsOf = c => prints.filter(x => x.set_code === c.set_code && x.collector_number === c.collector_number);
  el.innerHTML = `<div class="result">
      <img class="cardimg" crossorigin="anonymous" alt="">
      <div class="result-info"><h2 data-name></h2><div class="small" data-sub></div>
        <div class="small" data-own></div><div class="small" data-price></div></div></div>
    <div class="fields">
      <label>Edition <select data-ed>${editions.map((c, k) => `<option value="${k}">${esc(c.set_code.toUpperCase())} #${esc(c.collector_number)}${yearOf(c) ? ' · ' + yearOf(c) : ''}</option>`).join('')}</select></label>
      <label>Sprache <select data-lang></select></label>
    </div>
    <div class="row"><div class="stepper"><button data-act="minus" aria-label="weniger">−</button><b data-qty>1</b><button data-act="plus" aria-label="mehr">+</button></div>
      <label class="check"><input type="checkbox" data-foil> Foil</label>
      <label class="check"><input type="checkbox" data-proxy> Proxy</label>
      ${target.deck ? '<label class="check"><input type="checkbox" data-own> Habe ich (auch in die Sammlung)</label>' : ''}</div>
    <div class="buttons stack"><button class="primary" data-act="add">${esc(target.addLabel || 'Hinzufügen')}</button>
      ${target.commanderBtn ? '<button data-act="cmd">Als Commander</button>' : ''}<button class="ghost" data-act="back">Andere Karte</button></div>`;
  const $ = s => el.querySelector(s);
  const show = () => {
    const name = cur.printed_name || cur.name;
    $('.cardimg').src = imgUrl(cur.card_id);
    $('[data-name]').textContent = name;
    $('[data-sub]').textContent = (cur.printed_name && cur.printed_name !== cur.name ? cur.name + ' · ' : '') + `${cur.set_code.toUpperCase()} #${cur.collector_number} · ${LANG_DE[cur.lang] || cur.lang}`;
    const own = ownedOf(cur.oracle_id);
    $('[data-own]').textContent = own ? `Schon ${own}× in der Sammlung` : 'Noch nicht in der Sammlung';
    const ls = langsOf(cur);
    $('[data-lang]').innerHTML = ls.map(c => `<option value="${esc(c.lang)}" ${c.lang === cur.lang ? 'selected' : ''}>${esc(LANG_DE[c.lang] || c.lang)}</option>`).join('');
    $('[data-ed]').value = String(editions.findIndex(c => c.set_code === cur.set_code && c.collector_number === cur.collector_number));
    const priceEl = $('[data-price]');
    priceEl.textContent = '';
    if (navigator.onLine) h.priceNow(cur).then(p => { if (priceEl.isConnected && cur) { const q = h.priceOf({ card_id: cur.card_id, foil: $('[data-foil]').checked ? 1 : 0 }); if (q) priceEl.textContent = 'Preis: ' + h.fmtPrice(q); } });
  };
  $('[data-ed]').onchange = e => {
    const ed = editions[Number(e.target.value)], ls = langsOf(ed);
    cur = ls.find(c => c.lang === cur.lang) || ls.find(c => c.lang === 'en') || ls[0];
    show();
  };
  $('[data-lang]').onchange = e => { cur = langsOf(cur).find(c => c.lang === e.target.value) || cur; show(); };
  $('[data-act=minus]').onclick = () => { qty = Math.max(1, qty - 1); $('[data-qty]').textContent = qty; };
  $('[data-act=plus]').onclick = () => { qty = Math.min(99, qty + 1); $('[data-qty]').textContent = qty; };
  $('[data-act=back]').onclick = back;
  const opts = extra => ({ qty, foil: $('[data-foil]').checked ? 1 : 0, proxy: $('[data-proxy]').checked ? 1 : 0, own: target.deck ? $('[data-own]').checked : true, ...extra });
  $('[data-act=add]').onclick = async ev => { ev.currentTarget.disabled = true; await target.add(cur, opts()); back(); };
  const cmd = $('[data-act=cmd]');
  if (cmd) cmd.onclick = async ev => { ev.currentTarget.disabled = true; const ok = await target.add(cur, opts({ commander: true })); if (ok !== false) back(); else ev.currentTarget.disabled = false; };
  show();
}

// ---- list mode ---------------------------------------------------------------------------------------------------------
const HEADERS = { commander: 'commander', deck: 'main', main: 'main', mainboard: 'main', sideboard: 'skip', maybeboard: 'skip', companion: 'skip', considering: 'skip' };
/** "1 Sol Ring", "2x Sol Ring (C21) 123", "Sol Ring" -> [{qty, name, set, cn, zone, raw}] (headers "Commander" / "Sideboard" switch the zone) */
export function parseList(text) {
  const out = [];
  let zone = 'main';
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('#')) continue;
    const hd = HEADERS[line.replace(/[:\s]+$/, '').toLowerCase()];
    if (hd) { zone = hd; continue; }
    if (/^sb:/i.test(line)) continue;
    let m = /^(\d+)\s*[x×]?\s+(.+)$/i.exec(line);
    let qty = 1, name = line;
    if (m) { qty = Math.min(99, Number(m[1])); name = m[2]; }
    let set = null, cn = null;
    const sm = /\s+\(([A-Za-z0-9]{2,6})\)(?:\s+([0-9A-Za-z★-]+))?\s*$/.exec(name);
    if (sm) { set = sm[1].toLowerCase(); cn = sm[2] || null; name = name.slice(0, sm.index); }
    name = name.replace(/\s+\*[FE]\*\s*$/, '').trim();
    out.push({ qty, name, set, cn, zone, raw });
  }
  return out;
}
/** matches one parsed line -> {status: 'ok' | 'fuzzy' | 'none', oi, pick, options: [{oi, display, pick}]} */
export function matchLine(line) {
  const ctx = h.ctx();
  if (line.set && line.cn) {
    const row = ctx.db.lookupSetCn(line.set, line.cn)[0];
    if (row !== undefined) { const c = h.cardOf(row); return { status: 'ok', oi: c.oracle, pick: c, options: [] }; }
  }
  const hits = searchHits(line.name);
  if (!hits.length) return { status: 'none', options: [] };
  const top = hits[0];
  const exact = top.score >= 95;
  const options = hits.slice(0, 4).map(x => ({ oi: x.oi, display: x.display, pick: x.pick }));
  if (line.set) { const p = printingsOf(top.oi).find(c => c.set_code === line.set); if (p) top.pick = p; }
  return { status: exact ? 'ok' : 'fuzzy', oi: top.oi, pick: top.pick, options };
}

function listPane(pane, target) {
  const { esc, imgUrl } = h;
  pane.innerHTML = `<p class="small">Eine Karte pro Zeile, zum Beispiel „1 Sol Ring“ oder „2 Blitzschlag“. Die Zeilen „Commander“ und „Sideboard“ werden erkannt.</p>
    <textarea data-text rows="7" placeholder="1 Sol Ring&#10;1 Command Tower&#10;3 Swords to Plowshares" spellcheck="false"></textarea>
    <div class="buttons"><button data-act="check" class="primary">Prüfen</button></div>
    <div data-preview></div>`;
  const prev = pane.querySelector('[data-preview]');
  let rows = [];
  const total = () => rows.reduce((s, r) => s + (r.use && r.pick && r.zone !== 'skip' ? r.qty : 0), 0);
  const draw = () => {
    prev.innerHTML = rows.length ? `<ul class="plist lines">${rows.map((r, i) => {
      const bad = !r.pick;
      return `<li data-i="${i}" class="${bad ? 'bad' : r.status === 'fuzzy' ? 'fuzzy' : ''}">
        ${r.pick ? `<img loading="lazy" crossorigin="anonymous" src="${imgUrl(r.pick.card_id, 'small')}" alt="">` : '<span class="noimg"></span>'}
        <div><b>${r.qty}× ${esc(r.pick ? (r.pick.printed_name || r.pick.name) : r.name)}</b>
          <div class="small">${r.zone === 'skip' ? 'Sideboard: wird übersprungen' : r.zone === 'commander' ? 'Commander' : ''}${r.status === 'fuzzy' ? ` · meintest du …? (du hast „${esc(r.name)}“ geschrieben)` : bad ? `Nicht gefunden: „${esc(r.name)}“` : r.pick ? esc(r.pick.set_code.toUpperCase() + ' #' + r.pick.collector_number) : ''}</div>
          ${r.status === 'fuzzy' ? `<select data-opt>${r.options.map(o => `<option value="${o.oi}" ${o.oi === r.oi ? 'selected' : ''}>${esc(o.display)}</option>`).join('')}<option value="-">Zeile überspringen</option></select>` : ''}</div>
        <label class="check"><input type="checkbox" data-use ${r.use && r.pick ? 'checked' : ''} ${r.pick ? '' : 'disabled'} aria-label="Übernehmen"></label></li>`;
    }).join('')}</ul>
      ${target.deck ? '<label class="check"><input type="checkbox" data-own> Habe ich (auch in die Sammlung)</label>' : ''}
      <div class="buttons"><button class="primary" data-act="addall" ${total() ? '' : 'disabled'}>${total()} ${total() === 1 ? 'Karte' : 'Karten'} hinzufügen</button></div>` : '';
  };
  pane.querySelector('[data-act=check]').onclick = () => {
    rows = parseList(pane.querySelector('[data-text]').value).map(l => { const m = matchLine(l); return { ...l, ...m, use: m.status !== 'none' && l.zone !== 'skip' }; });
    if (!rows.length) { prev.innerHTML = '<p class="small">Keine Zeilen gefunden.</p>'; return; }
    draw();
  };
  prev.onchange = e => {
    const li = e.target.closest('li[data-i]');
    if (!li) return;
    const r = rows[Number(li.dataset.i)];
    if (e.target.matches('[data-use]')) { r.use = e.target.checked; draw(); return; }
    if (e.target.matches('[data-opt]')) {
      if (e.target.value === '-') { r.pick = null; r.use = false; r.status = 'none'; }
      else { const o = r.options.find(x => String(x.oi) === e.target.value); r.oi = o.oi; r.pick = o.pick; r.use = true; }
      draw();
    }
  };
  prev.onclick = async e => {
    if (!e.target.closest('[data-act=addall]')) return;
    const btn = e.target.closest('[data-act=addall]');
    btn.disabled = true;
    const own = target.deck ? !!prev.querySelector('[data-own]')?.checked : true;
    let n = 0;
    for (const r of rows) {
      if (!r.use || !r.pick || r.zone === 'skip') continue;
      await target.add(r.pick, { qty: r.qty, foil: 0, proxy: 0, own, commander: r.zone === 'commander', quiet: true });
      n += r.qty;
    }
    h.toast(`${n} ${n === 1 ? 'Karte' : 'Karten'} hinzugefügt.`);
    h.closeSheet();
  };
}
