// Storage screens: "Einsortieren" (the pile of new cards), "Fächer & Ordner" (sections, binder and Bulk suggestions,
// kept cards, settings), the storage box in the card sheet and the big card image on a tap on a thumbnail.
// The rules live in storage.js; this file only draws and calls them. UI text German.

import * as st from './storage.js';
import * as store from './store.js';
import { stale, pricesAt } from './prices.js';

let ui = null;   // { openSheet, closeSheet, toast, esc, imgUrl, openEntry, refreshPrices }
export function initStorageUi(helpers) { ui = helpers; installBig(); }

const fmtNum = n => Number(n).toLocaleString('de-DE');
const plural = (n, one, many) => `${fmtNum(n)} ${n === 1 ? one : many}`;
const ref = it => ({ key: it.entry.key, id: it.copy.id });

/** toast for sections the app has just started ("Neues Fach: Removal 2") */
export function sectionToast(events, prefix = '') {
  if (!events?.length) { if (prefix) ui.toast(prefix); return; }
  const names = [...new Set(events)].map(n => `„${ui.esc(n)}“`);
  const list = names.length === 1 ? names[0] : names.slice(0, -1).join(', ') + ' und ' + names[names.length - 1];
  ui.toast(`${prefix ? prefix + '<br>' : ''}${names.length === 1 ? 'Neues Fach' : 'Neue Fächer'}: ${list}. Leg ${names.length === 1 ? 'dafür eine Trennkarte' : 'für jedes eine Trennkarte'} an.`, { ms: 7000 });
}

export function dayLabel(day) {
  if (!day) return '?';
  const today = st.dayOf(new Date().toISOString()), y = st.dayOf(new Date(Date.now() - 86400000).toISOString());
  if (day === today) return 'heute';
  if (day === y) return 'gestern';
  const [a, b, c] = day.split('-').map(Number);
  return new Date(a, b - 1, c).toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short' });
}

// ---- big card image (touch has no hover: a tap on a thumbnail shows the card) --------------------------------------------
function installBig() {
  const el = document.createElement('div');
  el.id = 'big'; el.className = 'big'; el.hidden = true;
  el.innerHTML = '<img alt=""><span class="small">Tippen zum Schließen</span>';
  el.onclick = () => { el.hidden = true; el.querySelector('img').removeAttribute('src'); };
  document.body.appendChild(el);
  // capture: a thumbnail inside a row must not tick the row or open something else
  document.addEventListener('click', e => {
    const t = e.target.closest?.('[data-big]');
    if (!t) return;
    e.preventDefault(); e.stopPropagation();
    const img = el.querySelector('img');
    img.crossOrigin = 'anonymous';
    img.src = ui.imgUrl(t.dataset.big, 'normal');
    el.hidden = false;
  }, true);
}

// ---- rows ---------------------------------------------------------------------------------------------------------------
function rowHtml(it, { check = false, done = !!it.copy.s, changed = false, sub = '', actions = '', price = true } = {}) {
  const e = it.entry, esc = ui.esc;
  const eur = it.eur !== undefined ? it.eur : st.eurOf(e);
  return `<div class="srow${done && check ? ' done' : ''}${changed ? ' changed' : ''}" data-key="${esc(e.key)}" data-id="${esc(it.copy.id)}">
    ${check ? `<input type="checkbox" class="mark" data-mark ${done ? 'checked' : ''} aria-label="Liegt an seinem Platz">` : ''}
    <img class="thumb" loading="lazy" crossorigin="anonymous" src="${ui.imgUrl(e.card_id, 'small')}" data-big="${esc(e.card_id)}" alt="">
    <div class="sinfo"><b class="sname" data-open>${esc(st.displayName(e))}${e.foil ? ' <span class="foil">Foil</span>' : ''}${e.proxy ? ' <span class="proxy">Proxy</span>' : ''}</b>
      <div class="small">${esc(e.set_code.toUpperCase())} #${esc(e.collector_number)}${sub ? ' · ' + sub : ''}</div>
      ${it.reasons ? `<div class="small reasons">${it.reasons.map(esc).join(' · ')}</div>` : ''}
      ${actions ? `<div class="acts">${actions}</div>` : ''}</div>
    ${price ? `<div class="sprice">${eur != null ? st.fmtEur(eur) : ''}</div>` : ''}
  </div>`;
}
const btn = (act, label, cls = '') => `<button class="xs ${cls}" data-act="${act}">${label}</button>`;
const refOfRow = row => ({ key: row.dataset.key, id: row.dataset.id });

function priceNote() {
  const at = pricesAt();
  if (at && !stale()) return '';
  return `<div class="banner warn"><span>${at ? 'Die Preise sind älter als ein Tag.' : 'Es sind noch keine Preise geladen.'} Ordner- und Bulk-Vorschläge richten sich nach dem Preis.</span><button data-act="prices">Preise aktualisieren</button></div>`;
}
async function doPrices(btnEl, after) {
  btnEl.disabled = true;
  await ui.refreshPrices(t => { btnEl.textContent = t; });
  after();
}

/** handles the shared row buttons; after() redraws */
async function rowAction(e, after, { beforeOpen = () => true } = {}) {
  const b = e.target.closest('button[data-act]');
  if (b?.dataset.act === 'prices') { doPrices(b, after); return true; }
  const row = e.target.closest('.srow');
  if (!row) return false;
  if (!b) {
    if (e.target.closest('[data-open]')) { if (beforeOpen()) ui.openEntry(row.dataset.key); return true; }
    return false;
  }
  const r = refOfRow(row), entry = store.items.get(r.key);
  if (!entry) return true;
  const name = `„${ui.esc(st.displayName(entry))}“`;
  b.disabled = true;
  switch (b.dataset.act) {
    case 'binder': await st.toBinder([r]); ui.toast(`${name} liegt jetzt im Ordner.`); break;
    case 'unbinder': sectionToast(await st.fromBinder([r]), `${name} kommt zurück in ihr Fach und liegt jetzt bei „Einsortieren“.`); break;
    case 'bulk': sectionToast(await st.toBulk([r]), `${name} liegt jetzt in Bulk.`); break;
    case 'unbulk': sectionToast(await st.fromBulk([r]), `${name} ist zurück in ihrem Fach.`); break;
    case 'keep': await st.setKeep(entry.oracle_id, true); ui.toast(`${name} wird nie mehr als Bulk vorgeschlagen.`); break;
    case 'unkeep': await st.setKeep(entry.oracle_id || b.dataset.oid, false); ui.toast(`${name} kann wieder als Bulk vorgeschlagen werden.`); break;
    default: b.disabled = false; return false;
  }
  after();
  return true;
}

// ---- Einsortieren -------------------------------------------------------------------------------------------------------
// Gonzo 2026-11-06 (home app): ticks are a draft until "Speichern (n)" (one tap on "Alle hier einsortiert" had saved 100
// cards by accident); closing with unsaved ticks asks first; the colour chips show one colour at a time ("jetzt alle
// schwarzen"). Unsaved ticks survive a change of day, colour or "auch erledigte" here (they are kept per copy).
const COLOR_CHIPS = [['', 'Alle'], ['W', 'Weiß'], ['U', 'Blau'], ['B', 'Schwarz'], ['R', 'Rot'], ['G', 'Grün'], ['M', 'Mehrfarbig'], ['C', 'Farblos']];
const countText = n => n ? `Noch <b>${plural(n, 'Karte', 'Karten')}</b> einzusortieren.` : '<b>Alles einsortiert.</b>';
const changes = n => `${plural(n, 'Änderung ist', 'Änderungen sind')} noch nicht gespeichert.`;
export function openSorting() {
  let day = '', showDone = false, color = '';
  const pending = new Map();   // `${key}#${id}` -> {ref, done}: only the differences to what is saved
  const pk = it => it.entry.key + '#' + it.copy.id;
  const isDone = it => pending.has(pk(it)) ? pending.get(pk(it)).done : !!it.copy.s;
  const setWanted = (it, done) => { if (done === !!it.copy.s) pending.delete(pk(it)); else pending.set(pk(it), { ref: ref(it), done }); };
  const leave = () => !pending.size || confirm(`${changes(pending.size)} Ohne Speichern schließen?`);
  const b = ui.openSheet(`<h2>Einsortieren</h2>
    <p class="small">Hier liegen die Karten, die du gescannt und noch nicht weggeräumt hast, sortiert nach dem Platz, an den sie gehören.
    Hake ab, was an seinem Platz liegt, und tippe zum Schluss auf „Speichern“. Vorher ist noch nichts gespeichert.</p>
    <div class="row filters"><select data-day aria-label="Tag"></select>
      <label class="check"><input type="checkbox" data-done> auch erledigte</label></div>
    <div class="cchips" data-colors>${COLOR_CHIPS.map(([k, l]) => `<button class="cchip${k ? '' : ' on'}" data-color="${k}">${l}</button>`).join('')}</div>
    <div data-summary class="summary"></div>
    <div data-prices></div>
    <div data-list></div>
    <div class="sheet-foot"><button data-act="save">Speichern</button></div>`, null, { beforeClose: leave });
  const list = b.querySelector('[data-list]'), daySel = b.querySelector('[data-day]'), summary = b.querySelector('[data-summary]');
  const saveBtn = b.querySelector('[data-act=save]');
  let groups = [];
  function showSummary(q) {
    const all = groups.flatMap(g => g.items);
    const open = q ? q.open : st.openCount();
    const openNow = open - [...pending.values()].filter(x => x.done).length + [...pending.values()].filter(x => !x.done).length;
    const colorOpen = all.filter(it => (!color || it.color === color) && !isDone(it)).length;
    const label = COLOR_CHIPS.find(([k]) => k === color)[1];
    summary.innerHTML = `<span>${countText(openNow)}${color ? ` <span class="small">(${label}: ${fmtNum(colorOpen)} offen)</span>` : ''}</span>`
      + (pending.size ? ` <span class="warn small">${changes(pending.size)}</span>` : '')
      + (day ? ` <button class="xs" data-act="day">Ganzen Tag abhaken</button>` : '');
    saveBtn.textContent = pending.size ? `Speichern (${fmtNum(pending.size)})` : 'Speichern';
    saveBtn.classList.toggle('primary', pending.size > 0);
    saveBtn.disabled = !pending.size;
  }
  function render() {
    const q = st.sortingQueue({ openOnly: !showDone, day });
    const days = q.days.filter(d => d.open || showDone || d.day === day);
    daySel.innerHTML = `<option value="">alle Tage</option>` + days.map(d => `<option value="${d.day}" ${d.day === day ? 'selected' : ''}>${ui.esc(dayLabel(d.day))} (${fmtNum(d.open)} offen)</option>`).join('');
    groups = q.groups;
    b.querySelector('[data-prices]').innerHTML = q.groups.length ? priceNote() : '';
    const shown = q.groups.map(g => ({ ...g, shown: g.items.filter(it => !color || it.color === color) })).filter(g => g.shown.length);
    list.innerHTML = shown.length ? shown.map(g => `<div class="sgroup${g.kind === 'to_binder' ? ' binder' : ''}">
      <div class="sgroup-head"><h3>${ui.esc(g.name)} <span class="small">${fmtNum(g.shown.length)}</span></h3>
        <button class="xs" data-act="group" data-group="${ui.esc(g.key)}">Alle hier abhaken</button></div>
      ${g.kind === 'to_binder' ? '<p class="small">Diese Karten sind mehr wert. Leg sie in den Ordner und tippe auf „In Ordner gelegt“.</p>' : ''}
      ${g.shown.map(it => rowHtml(it, { check: true, done: isDone(it), changed: pending.has(pk(it)),
        sub: ui.esc(dayLabel(it.day)) + (g.kind === 'to_binder' ? ' · gehört sonst in ' + ui.esc(st.sectionName(it.copy.h)) : ''),
        actions: it.hint === 'binder' ? btn('binder', 'In Ordner gelegt', 'primary')
          : it.hint === 'bulk' ? `<span class="tag">Bulk-Kandidat</span>${btn('bulk', 'In Bulk gelegt')}${btn('keep', 'Behalten')}` : '' })).join('')}
    </div>`).join('')
      : `<p class="empty">${color ? 'In dieser Farbe ist nichts offen.' : day ? 'An diesem Tag ist nichts mehr offen.' : 'Nichts mehr einzusortieren.'}</p>`;
    showSummary(q);
  }
  const itemOf = row => groups.flatMap(g => g.items).find(it => it.entry.key === row.dataset.key && it.copy.id === row.dataset.id);
  async function save() {
    const on = [...pending.values()].filter(x => x.done).map(x => x.ref), off = [...pending.values()].filter(x => !x.done).map(x => x.ref);
    saveBtn.disabled = true;
    if (on.length) await st.mark(on, true);
    if (off.length) await st.mark(off, false);
    pending.clear();
    ui.toast(`${plural(on.length, 'Karte', 'Karten')} als einsortiert gespeichert${off.length ? `, ${fmtNum(off.length)} wieder offen` : ''}.`);
    render();   // the sheet stays open: on with the next colour
  }
  render();
  daySel.onchange = () => { day = daySel.value; render(); };
  b.querySelector('[data-done]').onchange = ev => { showDone = ev.target.checked; render(); };
  b.onchange = e => {
    const box = e.target.closest('input[data-mark]');
    if (!box) return;
    const row = box.closest('.srow'), it = itemOf(row);
    if (!it) return;
    setWanted(it, box.checked);
    row.classList.toggle('done', box.checked);
    row.classList.toggle('changed', pending.has(pk(it)));
    showSummary();
  };
  b.onclick = async e => {
    const chip = e.target.closest('button[data-color]');
    if (chip) {
      color = chip.dataset.color;
      b.querySelectorAll('.cchip').forEach(c => c.classList.toggle('on', c === chip));
      render();
      return;
    }
    if (e.target.closest('button[data-act=save]')) { save(); return; }
    const g = e.target.closest('button[data-act=group]');
    if (g) {
      const grp = groups.find(x => x.key === g.dataset.group);
      for (const it of grp?.items || []) if (!color || it.color === color) setWanted(it, true);
      render();
      return;
    }
    if (e.target.closest('button[data-act=day]')) {
      for (const grp of groups) for (const it of grp.items) if (it.day === day) setWanted(it, true);
      render();
      return;
    }
    const act = e.target.closest('.srow button[data-act]');
    if (act) { const it = itemOf(act.closest('.srow')); if (it) pending.delete(pk(it)); }   // a move ticks the card off itself
    rowAction(e, render, { beforeOpen: () => { if (!leave()) return false; pending.clear(); return true; } });
  };
}

// ---- Fächer & Ordner ----------------------------------------------------------------------------------------------------
let lastPlan = null;
/** the three storage systems as radio buttons with one sentence each (also used by the intro) */
export function systemChoice(current, name = 'kk-system') {
  return `<div class="systems">${Object.entries(st.SYSTEMS).map(([k, x]) => `<label class="system${k === current ? ' on' : ''}">
    <input type="radio" name="${name}" value="${k}" data-system ${k === current ? 'checked' : ''}>
    <span><b>${ui.esc(x.label)}</b><span class="small">${ui.esc(x.help)}</span></span></label>`).join('')}</div>`;
}
export function openStorage(view = 'home') {
  const esc = ui.esc;
  const back = `<button class="xs back" data-go="home">← Fächer & Ordner</button>`;
  let html = '';
  if (view === 'home') {
    const sec = st.sections(), bs = st.binderSuggestions(), bu = st.bulkSuggestions(), kept = st.keptList(), s = st.getSettings();
    const sum = list => list.reduce((x, i) => x + (i.eur || 0), 0);
    const sys = st.SYSTEMS[s.system];
    const example = st.sectionName(`${sys.keys[s.system === 'color' ? 2 : 1]}:2`);
    const rules = [s.binderOn ? `Karten ab ${st.fmtEur(s.binderMin)} gehören in den Ordner.` : '', s.bulkOn ? 'Sehr billige und kaum gespielte Karten schlägt die App für Bulk vor.' : ''].filter(Boolean).join(' ');
    html = `<h2>Fächer & Ordner</h2>
      <p class="small">Deine Kiste ist <b>${esc(sys.label.toLowerCase())}</b> sortiert, jede Gruppe ist ein Fach. Ist ein Fach voll (${fmtNum(s.capacity)} Karten),
      beginnt das nächste, zum Beispiel „${esc(example)}“. ${rules}</p>
      ${s.binderOn || s.bulkOn ? priceNote() : ''}
      ${st.rolesReady() ? '' : '<p class="small bad">Die Daten für die Fächer sind noch nicht geladen. Das passiert mit der nächsten Kartenliste.</p>'}
      ${s.binderOn || s.bulkOn || kept.length ? `<h3>Vorschläge</h3>
      <ul class="menu">
        ${s.binderOn ? `<li data-go="binder"><b>Für den Ordner</b><span>${plural(bs.length, 'Karte', 'Karten')}${bs.length ? ' · ' + st.fmtEur(sum(bs)) : ''}</span></li>` : ''}
        ${s.bulkOn ? `<li data-go="bulk"><b>Für Bulk</b><span>${plural(bu.length, 'Karte', 'Karten')}</span></li>` : ''}
        ${s.bulkOn || kept.length ? `<li data-go="kept"><b>Behaltene Karten</b><span>${fmtNum(kept.length)}</span></li>` : ''}
      </ul>` : ''}
      <h3>Fächer</h3>
      ${sec.length ? `<ul class="menu">${sec.map(x => `<li data-go="sec" data-h="${esc(x.h ?? '')}"><b>${esc(x.name)}</b><span>${plural(x.count, 'Karte', 'Karten')}${x.away ? ` · ${fmtNum(x.away)} im Ordner` : ''}</span></li>`).join('')}</ul>`
        : '<p class="small">Noch keine Karten.</p>'}
      <h3>Ablage-System</h3>
      ${systemChoice(s.system)}
      <p class="small">Wechselst du später, zeigt die App zuerst eine Umräumliste. Erst wenn du zustimmst, ändert sich etwas.</p>
      <h3>Einstellungen</h3>
      <div class="settings">
        <label>Karten pro Fach <input type="number" inputmode="numeric" min="10" max="1000" step="10" data-cap value="${s.capacity}"></label>
        <label class="check"><input type="checkbox" data-binder-on ${s.binderOn ? 'checked' : ''}> Ordner ab</label>
        <label><input type="text" inputmode="decimal" data-min value="${String(s.binderMin).replace('.', ',')}" aria-label="Ordner ab Euro"> €</label>
        <label class="check"><input type="checkbox" data-bulk-on ${s.bulkOn ? 'checked' : ''}> Bulk-Vorschläge</label>
        <button class="xs" data-act="save-settings">Speichern</button>
      </div>
      <p class="small">Ein volles Fach bleibt voll. Eine neue Zahl gilt für die Karten, die ab jetzt dazukommen.</p>`;
  } else if (view.startsWith('switch:')) {
    const plan = st.planSystem(view.slice(7));
    lastPlan = plan;
    const groups = new Map();
    for (const m of plan.moves) { if (!groups.has(m.to)) groups.set(m.to, []); groups.get(m.to).push(m); }
    html = `${back}<h2>Umräumliste</h2>
      <p>Umstellen auf <b>${esc(st.SYSTEMS[plan.system].label)}</b>: ${plural(plan.moves.length, 'Karte wechselt', 'Karten wechseln')} das Fach${plan.same ? `, ${plural(plan.same, 'Karte bleibt', 'Karten bleiben')}, wo sie ${plan.same === 1 ? 'ist' : 'sind'}` : ''}.
      Bulk und der Ordner bleiben, wie sie sind.</p>
      ${plan.unknown ? `<p class="small bad">${plural(plan.unknown, 'Karte', 'Karten')} kann die App noch nicht zuordnen. Sie bleiben vorerst in ihrem Fach.</p>` : ''}
      <p class="small">Nach dem Übernehmen liegen die Karten, die umziehen, bei „Einsortieren“. Dort hakst du sie ab, sobald sie im neuen Fach stehen.</p>
      <div class="buttons"><button class="primary" data-act="apply-system">Umräumen übernehmen</button><button data-go="home">Abbrechen</button></div>
      ${[...groups].map(([to, list]) => `<div class="sgroup"><div class="sgroup-head"><h3>→ ${esc(to)} <span class="small">${fmtNum(list.length)}</span></h3></div>
        ${list.map(m => rowHtml(m, { sub: 'aus ' + esc(m.from), price: false })).join('')}</div>`).join('')}`;
  } else if (view === 'binder') {
    const list = st.binderSuggestions();
    html = `${back}<h2>Für den Ordner</h2>
      <p class="small">Diese Karten sind mindestens ${st.fmtEur(st.getSettings().binderMin)} wert und liegen noch nicht im Ordner. Es zählt nur der Preis.</p>
      ${priceNote()}
      ${list.length ? list.map(it => rowHtml(it, { sub: esc(st.placeName(it.copy)), actions: btn('binder', 'In Ordner gelegt', 'primary') })).join('') : '<p class="empty">Keine Vorschläge.</p>'}`;
  } else if (view === 'bulk') {
    const list = st.bulkSuggestions();
    html = `${back}<h2>Für Bulk</h2>
      <p class="small">Unter ${st.fmtEur(st.BULK_MAX_EUR)} und selten gespielt (EDHREC-Rang über ${fmtNum(st.BULK_MIN_RANK)} oder keiner). Taugt eine Karte trotzdem etwas,
      tippe auf „Behalten“. Dann schlägt die App sie nie wieder vor.</p>
      ${priceNote()}
      ${list.length ? list.map(it => rowHtml(it, { sub: esc(st.placeName(it.copy)), actions: btn('bulk', 'In Bulk gelegt') + btn('keep', 'Behalten') })).join('') : '<p class="empty">Keine Vorschläge.</p>'}`;
  } else if (view === 'kept') {
    const list = st.keptList();
    html = `${back}<h2>Behaltene Karten</h2>
      <p class="small">Diese Karten schlägt die App nie als Bulk vor.</p>
      ${list.length ? list.map(k => k.entry
        ? rowHtml({ entry: k.entry, copy: k.entry.copies[0] }, { sub: 'behalten ' + esc(dayLabel(st.dayOf(k.at))), actions: btn('unkeep', 'Wieder vorschlagen'), price: false })
        : `<div class="srow"><div class="sinfo"><b>Karte nicht mehr in der Sammlung</b><div class="acts"><button class="xs" data-act="unkeep-oid" data-oid="${esc(k.oracle_id)}">Wieder vorschlagen</button></div></div></div>`).join('')
        : '<p class="empty">Noch keine.</p>'}`;
  } else if (view.startsWith('sec:')) {
    const h = view.slice(4) || null;
    const items = st.contents(h);
    const name = h === 'binder' ? 'Ordner' : st.sectionName(h);
    const act = h === 'binder' ? btn('unbinder', 'Aus dem Ordner genommen') : st.homeRole(h) === st.BULK ? btn('unbulk', 'Aus Bulk zurück') : '';
    html = `${back}<h2>${esc(name)} <span class="small">${plural(items.length, 'Karte', 'Karten')}</span></h2>
      <p class="small">${h === null ? 'Für diese Karten fehlen der App noch die Daten. Sie bekommen ihr Fach, sobald die Kartenliste geladen ist.'
        : h !== 'binder' && st.SYSTEMS[st.getSettings().system].byName ? 'Sortiert nach Name, so wie die Karten hinter der Trennkarte stehen.'
        : 'Sortiert nach Farbe (Weiß, Blau, Schwarz, Rot, Grün, mehrfarbig, farblos) und Name, so wie die Karten hinter der Trennkarte stehen.'}</p>
      ${items.map(it => rowHtml(it, { actions: act })).join('') || '<p class="empty">Leer.</p>'}`;
  }
  const b = ui.openSheet(html);
  const redraw = () => openStorage(view);
  b.onchange = e => {
    const r = e.target.closest('input[data-system]');
    if (r && r.value !== st.getSettings().system) openStorage('switch:' + r.value);
  };
  b.onclick = async e => {
    if (e.target.closest('button[data-act=apply-system]') && lastPlan) {
      const n = await st.applySystem(lastPlan);
      lastPlan = null;
      ui.toast(n ? `Umgestellt. ${plural(n, 'Karte liegt', 'Karten liegen')} jetzt bei „Einsortieren“.` : 'Umgestellt.', { ms: 6000 });
      openStorage('home');
      return;
    }
    const go = e.target.closest('[data-go]');
    if (go) { openStorage(go.dataset.go === 'sec' ? 'sec:' + go.dataset.h : go.dataset.go); return; }
    const save = e.target.closest('button[data-act=save-settings]');
    if (save) {
      const s = await st.setSettings({ capacity: b.querySelector('[data-cap]').value, binderMin: b.querySelector('[data-min]').value,
        binderOn: b.querySelector('[data-binder-on]').checked, bulkOn: b.querySelector('[data-bulk-on]').checked });
      ui.toast(`Gespeichert: ${fmtNum(s.capacity)} Karten pro Fach${s.binderOn ? `, Ordner ab ${st.fmtEur(s.binderMin)}` : ', ohne Ordner'}${s.bulkOn ? '' : ', ohne Bulk'}.`);
      redraw();
      return;
    }
    const uk = e.target.closest('button[data-act=unkeep-oid]');
    if (uk) { await st.setKeep(uk.dataset.oid, false); redraw(); return; }
    rowAction(e, redraw);
  };
}

// ---- storage box in the card sheet ----------------------------------------------------------------------------------------
export function entryBox(entry) {
  const esc = ui.esc, oid = entry.oracle_id;
  const role = st.roleOf(oid);
  const roleSel = role ? `<select data-role>${st.ROLE_KEYS.map(k => `<option value="${k}" ${k === role ? 'selected' : ''}>${esc(st.ROLE_LABELS[k])}</option>`).join('')}</select>
    <span class="small">${st.isOverridden(oid) ? `von dir geändert · <a href="#" data-act="role-auto">automatisch: ${esc(st.ROLE_LABELS[st.autoRole(oid)] || '?')}</a>` : 'automatisch'}</span>`
    : '<span class="small">wird noch geladen</span>';
  const copies = entry.copies;
  const binderCards = st.inBinderOracles();
  const hintBinder = copies.find(c => st.hintOf(entry, c, binderCards) === 'binder');
  const hintBulk = copies.find(c => st.hintOf(entry, c, binderCards) === 'bulk');
  const inBinder = copies.find(c => c.b), inBulk = copies.find(c => !c.b && st.homeRole(c.h) === st.BULK);
  const acts = [];
  if (hintBinder) acts.push(`<div>Mindestens ${st.fmtEur(st.getSettings().binderMin)} wert: gehört in den Ordner. <button class="xs primary" data-act="binder" data-id="${hintBinder.id}">In Ordner gelegt</button></div>`);
  if (hintBulk) acts.push(`<div>Bulk-Kandidat (${esc(st.bulkSuggestions().find(x => x.copy.id === hintBulk.id)?.reasons.join(', ') || 'billig, selten gespielt')}). <button class="xs" data-act="bulk" data-id="${hintBulk.id}">In Bulk gelegt</button> <button class="xs" data-act="keep" data-id="${hintBulk.id}">Behalten</button></div>`);
  if (inBinder) acts.push(`<div><button class="xs" data-act="unbinder" data-id="${inBinder.id}">Aus dem Ordner genommen</button></div>`);
  if (inBulk) acts.push(`<div><button class="xs" data-act="unbulk" data-id="${inBulk.id}">Aus Bulk zurück</button></div>`);
  if (st.isKept(oid)) acts.push(`<div>Behalten: wird nie als Bulk vorgeschlagen. <button class="xs" data-act="unkeep" data-id="${copies[0]?.id || ''}">Wieder vorschlagen</button></div>`);
  return `<div class="box store-box">
    ${st.getSettings().system === 'role' ? `<div class="line"><b>Aufgabe</b> ${roleSel}</div>` : ''}
    <div class="line"><b>Liegt in</b> ${esc(st.placesText(entry))}</div>
    ${acts.join('')}</div>`;
}
/** wires the box; redraw(newKey) re-opens the card sheet */
export function bindEntryBox(root, key, redraw) {
  const box = root.querySelector('.store-box');
  if (!box) return;
  const entry = () => store.items.get(key);
  box.querySelector('[data-role]')?.addEventListener('change', async ev => {
    const e = entry();
    sectionToast(await st.setRole(e.oracle_id, ev.target.value), `Aufgabe von „${ui.esc(st.displayName(e))}“: ${ui.esc(st.ROLE_LABELS[ev.target.value])}. Die Karte liegt jetzt bei „Einsortieren“.`);
    redraw(key);
  });
  box.addEventListener('click', async ev => {
    const a = ev.target.closest('[data-act]');
    if (!a) return;
    ev.preventDefault();
    const e = entry();
    if (!e) return;
    if (a.dataset.act === 'role-auto') { sectionToast(await st.setRole(e.oracle_id, null), 'Aufgabe wieder automatisch.'); redraw(key); return; }
    const r = [{ key, id: a.dataset.id }], name = `„${ui.esc(st.displayName(e))}“`;
    a.disabled = true;
    if (a.dataset.act === 'binder') { await st.toBinder(r); ui.toast(`${name} liegt jetzt im Ordner.`); }
    if (a.dataset.act === 'unbinder') sectionToast(await st.fromBinder(r), `${name} liegt jetzt bei „Einsortieren“.`);
    if (a.dataset.act === 'bulk') sectionToast(await st.toBulk(r), `${name} liegt jetzt in Bulk.`);
    if (a.dataset.act === 'unbulk') sectionToast(await st.fromBulk(r), `${name} ist zurück in ihrem Fach.`);
    if (a.dataset.act === 'keep') { await st.setKeep(e.oracle_id, true); ui.toast(`${name} wird nie mehr als Bulk vorgeschlagen.`); }
    if (a.dataset.act === 'unkeep') { await st.setKeep(e.oracle_id, false); ui.toast(`${name} kann wieder als Bulk vorgeschlagen werden.`); }
    redraw(key);
  });
}
