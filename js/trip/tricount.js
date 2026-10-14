/* ============================================================
   CARNET DE VOYAGES — Tricount (Budget Réel) Module
   ============================================================ */

import { getTrip, updateTrip, uid } from '../store.js';
import { notify, showModal, closeModal, fmtDateShort, esc as _esc, customDayTitle } from '../utils.js';
import { repairDuplicateCatColors } from './budget.js';
import { attachCalcKeypad } from '../calckeypad.js';

// ── Module state ──────────────────────────────────────────────────────────────

let _activeTab = 'depenses'; // 'depenses' | 'bilans' | 'budgetvsdep'
let _activeTrip = null;
let _catFilter  = 'all'; // filtre de l'onglet Dépenses : 'all' | catId | '_none' | '_transfer'

// ── Currency support ──────────────────────────────────────────────────────────

const CURRENCIES = [
  { code:'EUR', symbol:'€', name:'Euro' },
  { code:'USD', symbol:'$', name:'Dollar US' },
  { code:'GBP', symbol:'£', name:'Livre sterling' },
  { code:'CHF', symbol:'Fr', name:'Franc suisse' },
  { code:'JPY', symbol:'¥', name:'Yen japonais' },
  { code:'CAD', symbol:'CA$', name:'Dollar canadien' },
  { code:'AUD', symbol:'A$', name:'Dollar australien' },
  { code:'SEK', symbol:'kr', name:'Couronne suédoise' },
  { code:'NOK', symbol:'kr', name:'Couronne norvégienne' },
  { code:'DKK', symbol:'kr', name:'Couronne danoise' },
  { code:'MXN', symbol:'$', name:'Peso mexicain' },
  { code:'MAD', symbol:'DH', name:'Dirham marocain' },
  { code:'TND', symbol:'DT', name:'Dinar tunisien' },
  { code:'TRY', symbol:'₺', name:'Livre turque' },
  { code:'THB', symbol:'฿', name:'Baht thaïlandais' },
  { code:'VND', symbol:'₫', name:'Dong vietnamien' },
  { code:'CNY', symbol:'¥', name:'Yuan chinois' },
  { code:'INR', symbol:'₹', name:'Roupie indienne' },
  { code:'SGD', symbol:'S$', name:'Dollar de Singapour' },
  { code:'MYR', symbol:'RM', name:'Ringgit malaisien' },
  { code:'ISK', symbol:'kr', name:'Couronne islandaise' },
  { code:'IDR', symbol:'Rp', name:'Roupie indonésienne' },
  { code:'BRL', symbol:'R$', name:'Réal brésilien' },
  { code:'KRW', symbol:'₩', name:'Won sud-coréen' },
  { code:'HKD', symbol:'HK$', name:'Dollar de Hong Kong' },
  { code:'NZD', symbol:'NZ$', name:'Dollar néo-zélandais' },
  { code:'ZAR', symbol:'R',   name:'Rand sud-africain' },
  { code:'RON', symbol:'lei', name:'Leu roumain' },
  { code:'CZK', symbol:'Kč',  name:'Couronne tchèque' },
  { code:'HUF', symbol:'Ft',  name:'Forint hongrois' },
  { code:'PLN', symbol:'zł',  name:'Zloty polonais' },
  { code:'BGN', symbol:'лв',  name:'Lev bulgare' },
  { code:'GEL', symbol:'₾',   name:'Lari géorgien' },
  { code:'EGP', symbol:'£E',  name:'Livre égyptienne' },
  { code:'ARS', symbol:'$',   name:'Peso argentin' },
  { code:'CLP', symbol:'$',   name:'Peso chilien' },
  { code:'COP', symbol:'$',   name:'Peso colombien' },
  { code:'PEN', symbol:'S/',  name:'Sol péruvien' },
];

let _ratesCache    = null;
let _ratesFetchedAt = 0;

async function _fetchRates() {
  const now = Date.now();
  if (_ratesCache && now - _ratesFetchedAt < 3_600_000) return _ratesCache;
  try {
    const resp = await fetch('https://open.er-api.com/v6/latest/EUR');
    const data = await resp.json();
    if (data.result === 'success') {
      _ratesCache = data.rates;
      _ratesFetchedAt = now;
    }
  } catch (_) {}
  return _ratesCache || {};
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _fmtEur(v) {
  const n = Number(v) || 0;
  return n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

/**
 * An expense's amount normalised to EUR — exp.amount is in the expense's
 * own currency, exp.amountEur is the pre-converted value computed at save
 * time (see _openExpenseModal). Aggregate totals (category donut, tab
 * headers, Budget vs Dépenses) must use this, never exp.amount directly,
 * or a single foreign-currency expense silently throws off every total by
 * treating e.g. "50 USD" as "50 €".
 */
function _eurAmount(exp) {
  return exp.currency && exp.currency !== 'EUR'
    ? (Number(exp.amountEur) || Number(exp.amount) || 0)
    : (Number(exp.amount) || 0);
}

/** Plain-text "who paid" label — one name, or several joined with " + " for a compte commun. */
function _payerLabel(exp, participants) {
  if (exp.payers && exp.payers.length > 0) {
    return exp.payers.map(pp => participants.find(p => p.id === pp.id)?.name || pp.id).join(' + ');
  }
  return participants.find(p => p.id === exp.paidById)?.name || exp.paidById || '?';
}

// ── Participants ──────────────────────────────────────────────────────────────

export function getParticipants(trip) {
  const moi = { id: 'moi', name: 'Moi', color: '#0d9488' };
  if (!trip.companions || trip.companions.length === 0) return [moi];
  const hasSelf = trip.companions.some(c => c.id === 'moi');
  return hasSelf ? trip.companions : [moi, ...trip.companions];
}

// ── Balance calculation ───────────────────────────────────────────────────────

/**
 * Compute the net balance (in EUR) for every participant.
 * Positive = owed money back; Negative = owes money to others.
 *
 * Algorithm:
 *  1a. If exp.payers exists (compte commun — paid jointly), each listed
 *      payer is credited their own EUR contribution.
 *  1b. Otherwise the single exp.paidById is credited the full EUR amount.
 *  2a. If custom splits exist, each person is debited their specific share.
 *  2b. Otherwise the amount is divided equally among `sharedWith` participants.
 *  3. Transfers are handled as a direct credit/debit pair.
 *
 * Results are rounded to 2 decimal places to eliminate floating-point drift
 * (e.g. €33.33 + €33.33 + €33.34 should sum to exactly €0.00).
 */
function computeBalances(trip) {
  const participants = getParticipants(trip);
  const balances = {};
  participants.forEach(p => { balances[p.id] = 0; });

  for (const exp of (trip.realExpenses || [])) {
    // Transfers: direct credit/debit between two participants
    if (exp.type === 'transfer') {
      if (balances[exp.fromId] !== undefined) balances[exp.fromId] += Number(exp.amount) || 0;
      if (balances[exp.toId]   !== undefined) balances[exp.toId]   -= Number(exp.amount) || 0;
      continue;
    }

    // Normalise to EUR: use pre-computed amountEur when currency differs, else use amount directly
    const eurAmt = _eurAmount(exp);

    // Credit the payer(s) — a compte commun (exp.payers) credits each
    // contributor their own share instead of crediting exp.paidById in full.
    if (exp.payers && exp.payers.length > 0) {
      for (const payer of exp.payers) {
        if (balances[payer.id] !== undefined) balances[payer.id] += Number(payer.amount) || 0;
      }
    } else if (balances[exp.paidById] !== undefined) {
      balances[exp.paidById] += eurAmt;
    }

    if (exp.splits && exp.splits.length > 0) {
      // Custom per-person splits (amounts already in EUR from the modal)
      for (const split of exp.splits) {
        if (balances[split.id] !== undefined) {
          balances[split.id] -= Number(split.amount) || 0;
        }
      }
    } else {
      // Equal split across all sharedWith participants
      const splitCount = (exp.sharedWith || []).length;
      if (splitCount === 0) continue;
      const share = eurAmt / splitCount; // eurAmt already converted above
      for (const pid of (exp.sharedWith || [])) {
        if (balances[pid] !== undefined) balances[pid] -= share;
      }
    }
  }

  // Round each balance to 2 decimal places to eliminate accumulated float errors
  const rounded = {};
  for (const [id, bal] of Object.entries(balances)) {
    rounded[id] = Math.round(bal * 100) / 100;
  }
  return rounded;
}

function computeSettlements(balances) {
  const creditors = [];
  const debtors   = [];

  for (const [id, bal] of Object.entries(balances)) {
    if (bal >  0.01) creditors.push({ id, amount:  bal });
    if (bal < -0.01) debtors  .push({ id, amount: -bal });
  }

  creditors.sort((a, b) => b.amount - a.amount);
  debtors  .sort((a, b) => b.amount - a.amount);

  const settlements = [];
  let ci = 0, di = 0;

  while (ci < creditors.length && di < debtors.length) {
    const c = creditors[ci];
    const d = debtors[di];
    const amount = Math.min(c.amount, d.amount);

    if (amount > 0.01) {
      settlements.push({
        from:   d.id,
        to:     c.id,
        amount: Math.round(amount * 100) / 100,
      });
    }

    c.amount -= amount;
    d.amount -= amount;
    if (c.amount < 0.01) ci++;
    if (d.amount < 0.01) di++;
  }

  return settlements;
}

// ── Panel listener registry ───────────────────────────────────────────────────

const _handlers = new WeakMap();
// Keyed by panel too, even though the listener is bound to `document` (not
// panel) — this is just how we remember "the previous render's closer" so it
// can be removed before adding the new one, same pattern as _handlers above.

// ── Render ────────────────────────────────────────────────────────────────────
// Style v2 (v239) : même famille que Bagages / l'écran voyage — carte résumé
// (total + soldes de chacun), boutons Dépense / Virement, onglets segmentés
// Dépenses / Bilans / Budget, listes en cartes blanches. Calculs inchangés
// (computeBalances, computeSettlements, _eurAmount), modales inchangées.

export function renderTricount(tripId) {
  const panel = document.getElementById('panel-tricount');
  if (!panel) return;

  let trip = getTrip(tripId);
  if (!trip) return;
  repairDuplicateCatColors(tripId, trip);
  trip = getTrip(tripId); // re-read: repair may have just persisted a fix

  if (_handlers.has(panel)) {
    panel.removeEventListener('click', _handlers.get(panel));
    _handlers.delete(panel);
  }

  // On garde l'onglet choisi d'un rendu à l'autre (ajout/modification d'une
  // dépense), mais on repart sur « Dépenses » en changeant de voyage.
  if (_activeTrip !== tripId) { _activeTab = 'depenses'; _catFilter = 'all'; _activeTrip = tripId; }

  const participants = getParticipants(trip);
  const balances    = computeBalances(trip);
  const settlements = computeSettlements(balances);

  panel.innerHTML = `
    <div class="tr">
      ${_renderSummary(trip, participants, balances)}
      <div id="tri-main-content">${_renderMain(trip, participants, balances, settlements)}</div>
    </div>`;

  const handler = e => _handleClick(e, tripId);
  _handlers.set(panel, handler);
  panel.addEventListener('click', handler);
}

function _initials(name) {
  return (name || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
}

function _av(p, size = '') {
  return `<span class="tr-av${size}" style="background:${_esc(p?.color || '#64748b')}">${_esc(_initials(p?.name))}</span>`;
}

// ── Résumé (haut de page) ─────────────────────────────────────────────────────

function _renderSummary(trip, participants, balances) {
  const realOnly = (trip.realExpenses || []).filter(e => e.type !== 'transfer');
  const total    = realOnly.reduce((s, e) => s + _eurAmount(e), 0);
  const nDays    = (trip.days || []).length;
  const planned  = (trip.budgetLines || []).reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const sub = [
    `${realOnly.length} dépense${realOnly.length !== 1 ? 's' : ''}`,
    nDays && total ? `${_fmtEur(total / nDays)} / jour` : '',
    planned ? `${Math.round(total / planned * 100)} % du budget` : '',
  ].filter(Boolean).join(' · ');

  const bals = participants.map(p => {
    const bal = balances[p.id] ?? 0;
    const cls = bal > 0.01 ? 'pos' : bal < -0.01 ? 'neg' : '';
    return `
      <div class="tr-bal">
        ${_av(p)}
        <span class="tr-bal-n">${_esc(p.name)}</span>
        <b class="tr-bal-v ${cls}">${bal > 0.01 ? '+' : ''}${Math.abs(bal) < 0.01 ? '0,00 €' : _fmtEur(bal)}</b>
      </div>`;
  }).join('');

  return `
    <div class="tr-hero">
      <span class="tr-hero-l">Total dépensé</span>
      <b class="tr-hero-v">${_fmtEur(total)}</b>
      <span class="tr-hero-s">${sub}</span>
      ${participants.length ? `<div class="tr-bals">${bals}</div>` : ''}
    </div>
    <div class="tr-actions">
      <button class="pk-btn pk-btn-dark" data-action="add-expense">＋ Dépense</button>
      <button class="pk-btn" data-action="add-transfer">💸 Virement</button>
    </div>`;
}

// ── Onglets ───────────────────────────────────────────────────────────────────

function _renderMain(trip, participants, balances, settlements) {
  const tabs = [['depenses', 'Dépenses'], ['bilans', 'Bilans'], ['budgetvsdep', 'Budget']];
  const seg = `<div class="tr-seg">${tabs.map(([k, l]) =>
    `<button class="${_activeTab === k ? 'on' : ''}" data-action="switch-tab" data-tab="${k}">${l}</button>`).join('')}</div>`;
  let content;
  if (_activeTab === 'bilans')           content = _renderBilans(trip, participants, balances, settlements);
  else if (_activeTab === 'budgetvsdep') content = _renderBudgetVsDep(trip);
  else                                   content = _renderDepenses(trip, participants);
  return seg + content;
}

function _empty(icon, title, sub = '') {
  return `<div class="pk-empty tr-empty"><div>${icon}</div><b>${title}</b>${sub ? `<span>${sub}</span>` : ''}</div>`;
}

function _longDay(iso) {
  try {
    const s = new Date(iso + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
    return s.charAt(0).toUpperCase() + s.slice(1);
  } catch (_) { return iso; }
}

// ── Dépenses ──────────────────────────────────────────────────────────────────

function _renderDepenses(trip, participants) {
  const expenses = trip.realExpenses || [];
  const cats     = trip.budgetCats   || [];
  const days     = trip.days         || [];
  if (!expenses.length) return _empty('💸', 'Aucune dépense', 'Ajoutez la première avec « ＋ Dépense ».');

  // Filtre par type de dépense (catégorie) — pastilles défilantes, seulement les
  // catégories réellement utilisées ; « Virements » et « Sans catégorie » si présents.
  const used = new Set(expenses.filter(e => e.type !== 'transfer').map(e => e.catId || '_none'));
  const hasTransfers = expenses.some(e => e.type === 'transfer');
  const filters = [['all', '', 'Toutes'],
    ...cats.filter(c => used.has(c.id)).map(c => [c.id, c.icon || '📦', c.name]),
    ...(used.has('_none') || [...used].some(id => id !== '_none' && !cats.some(c => c.id === id)) ? [['_none', '❔', 'Sans catégorie']] : []),
    ...(hasTransfers ? [['_transfer', '💸', 'Virements']] : [])];
  if (!filters.some(f => f[0] === _catFilter)) _catFilter = 'all';
  const match = e => _catFilter === 'all' ? true
    : _catFilter === '_transfer' ? e.type === 'transfer'
    : e.type === 'transfer' ? false
    : _catFilter === '_none' ? !e.catId || !cats.some(c => c.id === e.catId)
    : e.catId === _catFilter;
  const shown = expenses.filter(match);
  const shownTotal = shown.filter(e => e.type !== 'transfer').reduce((s, e) => s + _eurAmount(e), 0);
  const filterHtml = filters.length > 2 ? `
    <div class="tr-filters">${filters.map(([k, ic, l]) =>
      `<button class="tr-fchip${_catFilter === k ? ' on' : ''}" data-action="filter-cat" data-cat="${_esc(k)}">${ic ? `<i>${_esc(ic)}</i>` : ''}${_esc(l)}</button>`).join('')}</div>
    ${_catFilter !== 'all' ? `<div class="tr-fsum">${shown.length} élément${shown.length > 1 ? 's' : ''}${shownTotal ? ` · ${_fmtEur(shownTotal)}` : ''}</div>` : ''}` : '';

  // Plus récentes d'abord, regroupées par date (ordre d'ajout conservé dans une même date)
  const list = expenses.map((e, i) => ({ e, i })).filter(({ e }) => match(e))
    .sort((a, b) => (b.e.date || '').localeCompare(a.e.date || '') || b.i - a.i);
  const groups = [];
  for (const { e } of list) {
    const key = e.date || '';
    let g = groups[groups.length - 1];
    if (!g || g.key !== key) { g = { key, items: [] }; groups.push(g); }
    g.items.push(e);
  }

  const row = exp => {
    if (exp.type === 'transfer') {
      const fromP = participants.find(p => p.id === exp.fromId);
      const toP   = participants.find(p => p.id === exp.toId);
      return `
        <button class="tr-row" data-action="edit-transfer" data-exp-id="${_esc(exp.id)}">
          <span class="tr-ic" style="--cc:#64748b">💸</span>
          <span class="tr-txt"><b>Virement${exp.note ? ' · ' + _esc(exp.note) : ''}</b>
            <small>${_esc(fromP?.name || exp.fromId)} → ${_esc(toP?.name || exp.toId)}</small></span>
          <span class="tr-amt tr-amt-muted">${_fmtEur(exp.amount)}</span>
        </button>`;
    }
    const cat = cats.find(c => c.id === exp.catId);
    const day = days.find(d => d.id === exp.dayId);
    const nShared = exp.splits?.length || (exp.sharedWith || []).length;
    const sub = [`Payé par ${_esc(_payerLabel(exp, participants))}`,
      nShared > 1 ? `÷ ${nShared}` : '', day ? 'Jour ' + day.num : ''].filter(Boolean).join(' · ');
    const foreign = exp.currency && exp.currency !== 'EUR';
    return `
      <button class="tr-row" data-action="edit-expense" data-exp-id="${_esc(exp.id)}">
        <span class="tr-ic" style="--cc:${_esc(cat?.color || '#0d9488')}">${cat?.icon || '💶'}</span>
        <span class="tr-txt"><b>${_esc(exp.desc || '—')}</b><small>${sub}</small></span>
        <span class="tr-amt">${foreign
          ? `${Number(exp.amount).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${_esc(exp.currency)}<small>${_fmtEur(exp.amountEur || exp.amount)}</small>`
          : _fmtEur(exp.amount)}${exp.receipt ? '<small>📎 reçu</small>' : ''}</span>
      </button>`;
  };

  const html = groups.map(g => {
    const dayTotal = g.items.filter(e => e.type !== 'transfer').reduce((s, e) => s + _eurAmount(e), 0);
    return `
      <div class="tr-day"><span>${g.key ? _esc(_longDay(g.key)) : 'Sans date'}</span>${dayTotal ? `<b>${_fmtEur(dayTotal)}</b>` : ''}</div>
      <div class="tr-card">${g.items.map(row).join('')}</div>`;
  }).join('');

  return filterHtml + html + (_catFilter === 'all' ? _renderCatDonut(trip, expenses.filter(e => e.type !== 'transfer')) : '');
}

// ── Répartition par catégorie (anneau) ────────────────────────────────────────

function _renderCatDonut(trip, expenses) {
  const cats  = trip.budgetCats || [];
  const total = expenses.reduce((s, e) => s + _eurAmount(e), 0);
  if (cats.length === 0 || total === 0) return '';

  const spentByCat = {};
  for (const exp of expenses) {
    if (exp.catId) spentByCat[exp.catId] = (spentByCat[exp.catId] || 0) + _eurAmount(exp);
  }
  const budgetByCat = {};
  for (const line of (trip.budgetLines || [])) {
    if (line.catId) budgetByCat[line.catId] = (budgetByCat[line.catId] || 0) + (Number(line.amount) || 0);
  }
  const segments = cats
    .map(cat => ({ label: cat.name, icon: cat.icon || '📦', color: cat.color || '#888',
                   spent: spentByCat[cat.id] || 0, planned: budgetByCat[cat.id] || 0 }))
    .filter(s => s.spent > 0)
    .sort((a, b) => b.spent - a.spent);
  if (segments.length === 0) return '';

  const R = 40, cx = 50, cy = 50, circ = 2 * Math.PI * R;
  let offset = 0, arcs = '';
  for (const seg of segments) {
    const dash = (seg.spent / total) * circ;
    arcs += `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${_esc(seg.color)}" stroke-width="14"
      stroke-dasharray="${Math.max(0, dash - 1.2).toFixed(2)} ${(circ - Math.max(0, dash - 1.2)).toFixed(2)}"
      stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`;
    offset += dash;
  }
  // Dépassement signalé sur le montant seul (corail), jamais sur la couleur de la
  // catégorie elle-même (cf. v196 : deux catégories en dépassement devenaient identiques).
  const legend = segments.map(s => {
    const over = s.planned > 0 && s.spent > s.planned;
    return `
      <div class="tr-leg">
        <i style="background:${_esc(s.color)}"></i>
        <span>${_esc(s.icon)} ${_esc(s.label)}</span>
        <b class="${over ? 'neg' : ''}">${_fmtEur(s.spent)}${s.planned > 0 ? `<small> / ${_fmtEur(s.planned)}</small>` : ''}</b>
      </div>`;
  }).join('');

  return `
    <div class="tr-sec">Par catégorie</div>
    <div class="tr-card tr-donut">
      <div class="tr-donut-svg">
        <svg viewBox="0 0 100 100"><circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="var(--hv-chip)" stroke-width="14"/>${arcs}</svg>
        <div><b>${_fmtEur(total)}</b></div>
      </div>
      <div class="tr-legs">${legend}</div>
    </div>`;
}

// ── Bilans ────────────────────────────────────────────────────────────────────

function _renderBilans(trip, participants, balances, settlements) {
  if ((trip.realExpenses || []).length === 0) return _empty('⚖️', 'Pas encore de bilan', 'Ajoutez des dépenses pour voir qui doit quoi.');

  const max = Math.max(0.01, ...participants.map(p => Math.abs(balances[p.id] ?? 0)));
  const bars = participants.map(p => {
    const bal = balances[p.id] ?? 0;
    const pos = bal > 0.01, neg = bal < -0.01;
    const w = Math.round(Math.abs(bal) / max * 100);
    return `
      <div class="tr-bil">
        ${_av(p, ' tr-av-l')}
        <div class="tr-bil-t">
          <div><b>${_esc(p.name)}</b><span class="${pos ? 'pos' : neg ? 'neg' : ''}">${pos ? '+' : neg ? '−' : ''}${_fmtEur(Math.abs(bal))}</span></div>
          <div class="tr-bil-bar"><i class="${pos ? 'pos' : 'neg'}" style="width:${pos || neg ? w : 0}%"></i></div>
          <small>${pos ? 'doit recevoir' : neg ? 'doit rembourser' : 'équilibré'}</small>
        </div>
      </div>`;
  }).join('');

  const settle = settlements.length ? settlements.map(st => {
    const from = participants.find(p => p.id === st.from);
    const to   = participants.find(p => p.id === st.to);
    return `
      <div class="tr-set">
        ${_av(from)}<span class="tr-set-n">${_esc(from ? from.name : st.from)}</span>
        <span class="tr-set-arrow">→</span>
        ${_av(to)}<span class="tr-set-n">${_esc(to ? to.name : st.to)}</span>
        <b>${_fmtEur(st.amount)}</b>
      </div>`;
  }).join('') : `<div class="tr-ok">✓ Tout est équilibré — aucun remboursement nécessaire.</div>`;

  return `
    <div class="tr-sec">Soldes</div>
    <div class="tr-card tr-pad">${bars}</div>
    <div class="tr-sec">Remboursements suggérés</div>
    <div class="tr-card">${settle}</div>`;
}

// ── Budget prévu vs dépensé ───────────────────────────────────────────────────

function _renderBudgetVsDep(trip) {
  const cats        = trip.budgetCats   || [];
  const expenses    = trip.realExpenses || [];
  const budgetLines = trip.budgetLines  || [];
  if (cats.length === 0) return _empty('📊', 'Aucune catégorie de budget', 'Ajoutez des catégories dans le budget prévisionnel du voyage.');

  const spentByCat = {}, budgetByCat = {};
  for (const exp of expenses) if (exp.catId) spentByCat[exp.catId] = (spentByCat[exp.catId] || 0) + _eurAmount(exp);
  for (const line of budgetLines) if (line.catId) budgetByCat[line.catId] = (budgetByCat[line.catId] || 0) + (Number(line.amount) || 0);

  let totalPlanned = 0, totalSpent = 0;
  const row = (icon, name, color, planned, spent, isTotal) => {
    const diff = planned - spent, over = diff < -0.01;
    const pct = planned > 0 ? Math.round(spent / planned * 100) : (spent > 0 ? 100 : 0);
    return `
      <div class="tr-bud${isTotal ? ' tr-bud-total' : ''}">
        <div class="tr-bud-h">
          ${isTotal ? '' : `<span class="tr-ic tr-ic-s" style="--cc:${_esc(color)}">${_esc(icon)}</span>`}
          <b>${_esc(name)}</b>
          <span class="${over ? 'neg' : diff > 0.01 ? 'pos' : ''}">${over ? `+${_fmtEur(-diff)} ⚠` : diff > 0.01 ? `reste ${_fmtEur(diff)}` : '—'}</span>
        </div>
        <div class="tr-bil-bar"><i style="width:${Math.min(100, pct)}%;background:${over ? 'var(--hv-coral)' : _esc(color)}"></i></div>
        <small>${_fmtEur(spent)} dépensés${planned ? ` sur ${_fmtEur(planned)} · ${pct} %` : ' · pas de budget prévu'}</small>
      </div>`;
  };
  const rows = cats.map(cat => {
    const planned = budgetByCat[cat.id] || 0, spent = spentByCat[cat.id] || 0;
    totalPlanned += planned; totalSpent += spent;
    return row(cat.icon || '📦', cat.name, cat.color || '#0d9488', planned, spent, false);
  }).join('');

  return `
    <div class="tr-card tr-pad">${row('', 'Total', '#0d9488', totalPlanned, totalSpent, true)}</div>
    <div class="tr-sec">Par catégorie</div>
    <div class="tr-card tr-pad">${rows}</div>`;
}

// ── Event delegation ──────────────────────────────────────────────────────────

function _handleClick(e, tripId) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;

  const action = btn.dataset.action;

  if (action === 'add-expense') {
    _openExpenseModal(tripId, null);

  } else if (action === 'add-transfer') {
    _openTransferModal(tripId);

  } else if (action === 'edit-transfer') {
    _openTransferModal(tripId, btn.dataset.expId);

  } else if (action === 'edit-expense') {
    _openExpenseModal(tripId, btn.dataset.expId);

  } else if (action === 'delete-expense') {
    const expId = btn.dataset.expId;
    if (confirm('Supprimer cette d\xe9pense ?')) {
      const trip = getTrip(tripId);
      updateTrip(tripId, {
        realExpenses: (trip.realExpenses || []).filter(ex => ex.id !== expId)
      });
      notify('D\xe9pense supprim\xe9e', '🗑');
      renderTricount(tripId);
    }

  } else if (action === 'filter-cat') {
    _catFilter = btn.dataset.cat || 'all';
    _refreshMain(tripId);

  } else if (action === 'switch-tab') {
    _activeTab = btn.dataset.tab || 'depenses';
    _refreshMain(tripId);
  }
}

function _refreshMain(tripId) {
  const trip = getTrip(tripId);
  if (!trip) return;
  const participants = getParticipants(trip);
  const balances     = computeBalances(trip);
  const settlements  = computeSettlements(balances);
  const mainEl       = document.getElementById('tri-main-content');
  if (mainEl) mainEl.innerHTML = _renderMain(trip, participants, balances, settlements);
}

// ── Split editor (shared) ─────────────────────────────────────────────────────

/**
 * Checklist of participants, each optionally included with an editable
 * amount, plus an "Égaliser" button and a running total vs. the target
 * amount. Shared by two independent uses in the expense modal: "Participants
 * & répartition" (who owes what, list = state.participantSplits) and "Payé
 * par plusieurs personnes" (who contributed how much to a joint/compte-commun
 * payment, list = state.payers) — same UI and validation, different backing
 * list and element ids (passed in via `ids` so the two don't collide in the
 * DOM or in each other's delegated event listeners).
 */
function _buildSplitEditorHtml(list, participants, expAmount, currency, ids) {
  const curSym = CURRENCIES.find(c => c.code === currency)?.symbol || '€';
  const rows = participants.map(p => {
    const split = list.find(s => s.id === p.id);
    const incl  = !!split;
    const amt   = split ? split.amount : 0;
    return `
      <label style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:8px;
                    margin-bottom:3px;cursor:pointer;user-select:none;
                    background:${incl ? 'var(--tl)' : 'var(--c)'};
                    border:1.5px solid ${incl ? 'var(--teal)' : 'var(--c3)'}">
        <input type="checkbox" class="${ids.checkClass}" data-part-id="${_esc(p.id)}"
          ${incl ? 'checked' : ''}
          style="width:16px;height:16px;cursor:pointer;accent-color:var(--teal);flex-shrink:0">
        <div class="comp-avatar"
          style="background:${_esc(p.color || '#0d9488')};width:24px;height:24px;font-size:10px;font-weight:800;flex-shrink:0">
          ${(p.name || '?').slice(0, 2).toUpperCase()}
        </div>
        <span style="flex:1;font-size:12px;font-weight:600;color:var(--ink);
                     min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
          ${_esc(p.name)}
        </span>
        <input type="text" inputmode="decimal" class="${ids.amountClass}" data-part-id="${_esc(p.id)}"
          value="${amt > 0 || incl ? amt.toFixed(2) : ''}"
          ${!incl ? 'disabled' : ''}
          style="width:78px;padding:4px 7px;border:1.5px solid var(--c3);border-radius:7px;
                 font-size:12px;text-align:right;background:var(--c);color:var(--ink);
                 ${!incl ? 'opacity:.35;' : ''}">
        <span style="font-size:11px;color:var(--ink3);flex-shrink:0;min-width:10px">${_esc(curSym)}</span>
      </label>`;
  }).join('');

  const total   = list.reduce((s, ps) => s + ps.amount, 0);
  const rounded = Math.round(total * 100) / 100;
  const ok      = expAmount > 0 && Math.abs(rounded - expAmount) < 0.01;

  return `
    <div id="${ids.listId}">${rows}</div>
    <div style="display:flex;align-items:center;justify-content:space-between;margin-top:5px;
                padding:6px 10px;background:var(--c2);border-radius:8px;border:1px solid var(--c3)">
      <button type="button" id="${ids.equalBtnId}"
        style="background:var(--teal);border:none;border-radius:5px;padding:3px 10px;
               font-size:10px;font-weight:700;cursor:pointer;color:#fff;font-family:var(--fn)">
        Égaliser
      </button>
      <div style="font-size:12px;font-weight:700">
        <span id="${ids.totalId}"
          style="color:${ok ? 'var(--grn)' : expAmount > 0 ? 'var(--coral)' : 'var(--ink4)'}">
          ${_fmtEur(rounded)}
        </span>
        ${expAmount > 0 ? `<span style="font-size:10px;font-weight:400;color:var(--ink4)"> / ${_fmtEur(expAmount)}</span>` : ''}
      </div>
    </div>`;
}

function _equalizeSplitList(list, amount) {
  const n = list.length;
  if (n === 0) return;
  const share = Math.round((amount / n) * 100) / 100;
  // Distribute rounding remainder to first participant
  let total = share * n;
  const remainder = Math.round((amount - total) * 100) / 100;
  list.forEach((ps, i) => {
    ps.amount = i === 0 ? share + remainder : share;
  });
}

const _PART_IDS  = { checkClass: 'tri-part-check',  amountClass: 'tri-part-amount',  listId: 'tri-participants-list', equalBtnId: 'parts-equal',  totalId: 'tri-part-total-val' };
const _PAYER_IDS = { checkClass: 'tri-payer-check', amountClass: 'tri-payer-amount', listId: 'tri-payers-list',       equalBtnId: 'payers-equal', totalId: 'tri-payer-total-val' };

function _buildParticipantsHtml(state, participants, expAmount) {
  return _buildSplitEditorHtml(state.participantSplits, participants, expAmount, state.currency, _PART_IDS);
}

function _equalizeParticipants(state, amount) {
  _equalizeSplitList(state.participantSplits, amount);
}

function _refreshParticipantsSection(state, participants, expAmount) {
  const section = document.getElementById('ex-split-section');
  if (!section) return;
  const label = section.querySelector('label');
  const newHtml = _buildParticipantsHtml(state, participants, expAmount);
  // Remove everything after the label
  while (section.children.length > 1) section.removeChild(section.lastChild);
  const div = document.createElement('div');
  div.innerHTML = newHtml;
  while (div.firstChild) section.appendChild(div.firstChild);
  section.querySelectorAll('.tri-part-amount').forEach(attachCalcKeypad);
}

// ── Payers split helpers (compte commun) ──────────────────────────────────────

function _buildPayersHtml(state, participants, expAmount) {
  return _buildSplitEditorHtml(state.payers, participants, expAmount, state.currency, _PAYER_IDS);
}

function _refreshPayersSection(state, participants, expAmount) {
  const section = document.getElementById('ex-payer-split-section');
  if (!section) return;
  section.innerHTML = _buildPayersHtml(state, participants, expAmount);
  section.querySelectorAll('.tri-payer-amount').forEach(attachCalcKeypad);
}

function _refreshEurEquiv() {
  const amountEl = document.getElementById('ex-amount');
  const equivEl  = document.getElementById('ex-eur-equiv');
  if (!equivEl || !amountEl) return;
  const amount = parseFloat(amountEl.value || '0') || 0;
  const state_currency = document.getElementById('ex-currency')?.value || 'EUR';
  const rate   = parseFloat(document.getElementById('ex-rate')?.value || '1') || 1;
  if (state_currency !== 'EUR' && amount > 0) {
    equivEl.textContent = '≈ ' + (amount * rate).toFixed(2) + ' €';
  } else {
    equivEl.textContent = '';
  }
}

// ── Add / Edit Expense Modal ──────────────────────────────────────────────────

function _openExpenseModal(tripId, expId) {
  const trip = getTrip(tripId);
  if (!trip) return;

  const participants = getParticipants(trip);
  const cats         = trip.budgetCats   || [];
  const days         = trip.days         || [];
  const expenses     = trip.realExpenses || [];
  const isEdit       = !!expId;
  const exp          = isEdit ? expenses.find(ex => ex.id === expId) : null;

  const defaultPayer  = participants[0]?.id || 'moi';

  // Build initial participant splits. The split editor works entirely in the
  // expense's own currency (same as #ex-amount and the sum validation below),
  // but exp.splits[].amount is stored in EUR (see the save handler) so that
  // computeBalances/tripstats can add it straight to an EUR-denominated
  // payer credit without a second conversion — convert back to native
  // currency here for editing.
  const _rate      = exp?.exchangeRate || 1;
  const _isForeign = !!(exp?.currency && exp.currency !== 'EUR');
  const _toNative  = eur => _isForeign ? Math.round((eur / _rate) * 100) / 100 : eur;

  function _initSplits(amount) {
    if (exp?.splits?.length) {
      return exp.splits.map(s => ({ id: s.id, amount: _toNative(Number(s.amount) || 0) }));
    }
    if (exp?.sharedWith?.length) {
      const share = amount / exp.sharedWith.length;
      return exp.sharedWith.map(id => ({ id, amount: Math.round(share * 100) / 100 }));
    }
    const share = amount / participants.length;
    return participants.map(p => ({ id: p.id, amount: Math.round(share * 100) / 100 }));
  }

  // Same native-currency conversion as _initSplits, for a compte commun
  // (exp.payers). When the expense isn't a compte commun (or is new), seed
  // with just the single payer at the full amount — a sane, valid starting
  // point once "Compte commun" gets checked, instead of an empty/invalid split.
  function _initPayers(amount) {
    if (exp?.payers?.length) {
      return exp.payers.map(pp => ({ id: pp.id, amount: _toNative(Number(pp.amount) || 0) }));
    }
    return [{ id: exp?.paidById || defaultPayer, amount }];
  }

  const initAmount = Number(exp?.amount) || 0;
  const state = {
    paidById:          exp?.paidById   || defaultPayer,
    multiPayer:        !!(exp?.payers && exp.payers.length > 0), // "compte commun" toggle
    payers:            _initPayers(initAmount),  // [{ id, amount }] — used only when multiPayer
    participantSplits: _initSplits(initAmount),  // [{ id, amount }] — only included participants
    receipt:           exp?.receipt    || null,
    currency:          exp?.currency   || 'EUR',
    exchangeRate:      exp?.exchangeRate || 1,    // 1 foreign = exchangeRate EUR
  };

  async function _compressImage(file) {
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = ev => {
        const img = new Image();
        img.onload = () => {
          const maxSize = 800;
          const canvas  = document.createElement('canvas');
          let { width, height } = img;
          if (width > maxSize || height > maxSize) {
            const r = Math.min(maxSize / width, maxSize / height);
            width = Math.round(width * r); height = Math.round(height * r);
          }
          canvas.width = width; canvas.height = height;
          canvas.getContext('2d').drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', 0.8));
        };
        img.src = ev.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function buildReceiptHtml() {
    if (state.receipt) {
      return `
        <img src="${state.receipt}" alt="Reçu" style="max-height:80px;max-width:100%;border-radius:6px;border:1px solid var(--c3);display:block;margin-bottom:6px">
        <button type="button" id="ex-receipt-clear" style="background:var(--c2);border:1px solid var(--c3);border-radius:6px;padding:4px 10px;font-size:11px;cursor:pointer;color:var(--coral)">✕ Supprimer la photo</button>`;
    }
    return `<input type="file" id="ex-receipt-file" accept="image/*" style="font-size:12px;color:var(--ink3)">`;
  }

  function refreshReceiptArea() {
    const area = document.getElementById('ex-receipt-area');
    if (!area) return;
    area.innerHTML = buildReceiptHtml();
    attachReceiptEvents();
  }

  function attachReceiptEvents() {
    document.getElementById('ex-receipt-file')?.addEventListener('change', async ev => {
      const file = ev.target.files?.[0];
      if (!file) return;
      state.receipt = await _compressImage(file);
      refreshReceiptArea();
    });
    document.getElementById('ex-receipt-clear')?.addEventListener('click', () => {
      state.receipt = null;
      refreshReceiptArea();
    });
  }

  function buildHtml() {
    const defaultCatId = exp?.catId || cats[0]?.id || '';
    const catsOpts = cats.length
      ? cats.map(c =>
          `<option value="${_esc(c.id)}"${defaultCatId === c.id ? ' selected' : ''}>${_esc(c.icon + ' ' + c.name)}</option>`
        ).join('')
      : `<option value="" disabled>Aucune catégorie — créez-en dans Budget</option>`;

    const daysOpts = `<option value="">Aucun jour</option>` +
      days.map(d =>
        `<option value="${_esc(d.id)}"${exp?.dayId === d.id ? ' selected' : ''}>Jour ${d.num}${customDayTitle(d) ? ' · ' + _esc(customDayTitle(d)) : ''}${d.date ? ' (' + fmtDateShort(d.date) + ')' : ''}</option>`
      ).join('');

    const payerOptions = participants.map(p =>
      `<option value="${_esc(p.id)}"${state.paidById === p.id ? ' selected' : ''}>${_esc(p.name)}</option>`
    ).join('');

    const currencyOptions = CURRENCIES.map(c =>
      `<option value="${c.code}"${state.currency === c.code ? ' selected' : ''}>${c.code} (${c.symbol}) — ${_esc(c.name)}</option>`
    ).join('');

    const today       = new Date().toISOString().slice(0, 10);
    const isNonEur    = state.currency !== 'EUR';
    const curSym      = CURRENCIES.find(c => c.code === state.currency)?.symbol || '€';
    const expAmount   = Number(exp?.amount) || 0;
    const eurEquiv    = isNonEur && expAmount > 0 ? (expAmount * state.exchangeRate).toFixed(2) : '';

    return `
      <button class="mc" onclick="closeModal()">✕</button>
      <h3>${isEdit ? '✏️ Modifier la dépense' : '+ Nouvelle dépense'}</h3>

      <div class="fg">
        <label>Description</label>
        <input type="text" id="ex-desc" placeholder="Ex : Restaurant du soir" value="${_esc(exp?.desc || '')}">
      </div>

      <div class="fg">
        <label>Montant</label>
        <div style="display:flex;gap:8px;align-items:center">
          <input type="text" inputmode="decimal" id="ex-amount" placeholder="0"
            value="${_esc(exp?.amount ?? '')}" style="flex:1">
          <select id="ex-currency"
            style="width:130px;padding:8px 6px;border:1.5px solid var(--c3);border-radius:8px;
                   font-size:12px;color:var(--ink);background:var(--c);font-family:var(--fn)">
            ${currencyOptions}
          </select>
        </div>
        <div id="ex-rate-row" style="display:${isNonEur ? 'flex' : 'none'};align-items:center;gap:6px;margin-top:6px;
             background:var(--c2);border-radius:8px;padding:6px 10px;border:1px solid var(--c3)">
          <span style="font-size:11px;color:var(--ink4)">1 <span id="ex-cur-code">${_esc(state.currency)}</span> =</span>
          <input type="number" id="ex-rate" min="0.000001" step="0.0001"
            value="${state.exchangeRate.toFixed(4)}"
            style="width:80px;padding:3px 7px;border:1.5px solid var(--c3);border-radius:6px;font-size:12px;text-align:right;background:var(--c);color:var(--ink)">
          <span style="font-size:11px;color:var(--ink4)">€</span>
          <span style="flex:1"></span>
          <span id="ex-eur-equiv" style="font-size:11px;font-weight:700;color:var(--teal)">
            ${eurEquiv ? '≈ ' + eurEquiv + ' €' : ''}
          </span>
          <button type="button" id="ex-rate-refresh" title="Actualiser le taux"
            style="background:none;border:none;cursor:pointer;font-size:14px;color:var(--ink4);padding:0">
            🔄
          </button>
        </div>
      </div>

      <div class="fg">
        <label>Catégorie</label>
        <select id="ex-cat">${catsOpts}</select>
      </div>

      <div class="fg">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
          <label style="margin:0;display:block;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--ink3)">Payé par</label>
          <label style="display:flex;align-items:center;gap:5px;font-size:11px;font-weight:600;color:var(--ink3);cursor:pointer;margin:0;text-transform:none">
            <input type="checkbox" id="ex-multi-payer" ${state.multiPayer ? 'checked' : ''} style="accent-color:var(--teal)">
            Compte commun
          </label>
        </div>
        <select id="ex-payer" style="${state.multiPayer ? 'display:none' : ''}">${payerOptions}</select>
        <div id="ex-payer-split-section" style="${state.multiPayer ? '' : 'display:none'};margin-top:6px">
          ${_buildPayersHtml(state, participants, expAmount || 0)}
        </div>
      </div>

      <div class="fg" id="ex-split-section">
        <label>Participants &amp; répartition</label>
        ${_buildParticipantsHtml(state, participants, expAmount || 0)}
      </div>

      <div class="fg">
        <label>Date</label>
        <input type="date" id="ex-date" value="${_esc(exp?.date || today)}">
      </div>

      <div class="fg">
        <label>Jour du voyage (optionnel)</label>
        <select id="ex-day">${daysOpts}</select>
      </div>

      <div class="fg">
        <label>Note</label>
        <textarea id="ex-note" rows="2" placeholder="Remarque optionnelle…">${_esc(exp?.note || '')}</textarea>
      </div>

      <div class="fg">
        <label>Photo (reçu)</label>
        <div id="ex-receipt-area">${buildReceiptHtml()}</div>
      </div>

      <div class="ma">
        <button class="bc" onclick="closeModal()">Annuler</button>
        ${isEdit ? `<button class="bc" id="ex-delete" style="color:var(--coral)">🗑 Supprimer</button>` : ''}
        <button class="bs" id="ex-save">Enregistrer</button>
      </div>`;
  }

  function attachEvents() {
    document.getElementById('ex-payer')?.addEventListener('change', ev => {
      state.paidById = ev.target.value;
    });

    // "Compte commun" toggle — swap the single payer <select> for the
    // multi-payer split editor (same widget as "Participants & répartition",
    // just backed by state.payers instead of state.participantSplits).
    document.getElementById('ex-multi-payer')?.addEventListener('change', ev => {
      state.multiPayer = ev.target.checked;
      const sel = document.getElementById('ex-payer');
      const sec = document.getElementById('ex-payer-split-section');
      if (sel) sel.style.display = state.multiPayer ? 'none' : '';
      if (sec) sec.style.display = state.multiPayer ? '' : 'none';
      const amount = parseFloat(document.getElementById('ex-amount')?.value || '0') || 0;
      if (state.multiPayer && state.payers.length === 0) {
        state.payers = [{ id: state.paidById, amount }];
      }
      _refreshPayersSection(state, participants, amount);
    });

    // Amount change → auto-equalize participants (and payers, if compte commun)
    document.getElementById('ex-amount')?.addEventListener('input', () => {
      const amount = parseFloat(document.getElementById('ex-amount')?.value || '0') || 0;
      _equalizeParticipants(state, amount);
      _refreshParticipantsSection(state, participants, amount);
      if (state.multiPayer) {
        _equalizeSplitList(state.payers, amount);
        _refreshPayersSection(state, participants, amount);
      }
      _refreshEurEquiv();
    });

    // Payer checkbox change (compte commun)
    document.getElementById('ex-payer-split-section')?.addEventListener('change', ev => {
      const cb = ev.target.closest('.tri-payer-check');
      if (!cb) return;
      const pid    = cb.dataset.partId;
      const amount = parseFloat(document.getElementById('ex-amount')?.value || '0') || 0;
      if (cb.checked) {
        if (!state.payers.find(s => s.id === pid)) state.payers.push({ id: pid, amount: 0 });
      } else {
        state.payers = state.payers.filter(s => s.id !== pid);
      }
      _equalizeSplitList(state.payers, amount);
      _refreshPayersSection(state, participants, amount);
    });

    // Payer amount change (manual, compte commun)
    document.getElementById('ex-payer-split-section')?.addEventListener('input', ev => {
      const input = ev.target.closest('.tri-payer-amount');
      if (!input) return;
      const pid = input.dataset.partId;
      const val = parseFloat(input.value) || 0;
      const ps  = state.payers.find(s => s.id === pid);
      if (ps) ps.amount = val;
      const amount  = parseFloat(document.getElementById('ex-amount')?.value || '0') || 0;
      const total   = state.payers.reduce((s, p) => s + p.amount, 0);
      const rounded = Math.round(total * 100) / 100;
      const ok      = amount > 0 && Math.abs(rounded - amount) < 0.01;
      const totalEl = document.getElementById('tri-payer-total-val');
      if (totalEl) {
        totalEl.textContent = _fmtEur(rounded);
        totalEl.style.color = ok ? 'var(--grn)' : amount > 0 ? 'var(--coral)' : 'var(--ink4)';
      }
    });

    // Payer "Égaliser" button (compte commun)
    document.getElementById('ex-payer-split-section')?.addEventListener('click', ev => {
      if (ev.target.closest('#payers-equal')) {
        const amount = parseFloat(document.getElementById('ex-amount')?.value || '0') || 0;
        _equalizeSplitList(state.payers, amount);
        _refreshPayersSection(state, participants, amount);
      }
    });

    // Currency change
    document.getElementById('ex-currency')?.addEventListener('change', async ev => {
      state.currency = ev.target.value;
      const isNonEur = state.currency !== 'EUR';
      const rateRow  = document.getElementById('ex-rate-row');
      if (rateRow) rateRow.style.display = isNonEur ? 'flex' : 'none';
      document.getElementById('ex-cur-code') && (document.getElementById('ex-cur-code').textContent = state.currency);
      if (isNonEur) {
        // Fetch rate
        const rates = await _fetchRates();
        const foreignPerEur = rates[state.currency] || 1;
        state.exchangeRate = Math.round((1 / foreignPerEur) * 10000) / 10000;
        const rateInput = document.getElementById('ex-rate');
        if (rateInput) rateInput.value = state.exchangeRate.toFixed(4);
      } else {
        state.exchangeRate = 1;
      }
      _refreshParticipantsSection(state, participants,
        parseFloat(document.getElementById('ex-amount')?.value || '0') || 0);
      if (state.multiPayer) {
        _refreshPayersSection(state, participants,
          parseFloat(document.getElementById('ex-amount')?.value || '0') || 0);
      }
      _refreshEurEquiv();
    });

    // Rate manual edit
    document.getElementById('ex-rate')?.addEventListener('input', ev => {
      state.exchangeRate = parseFloat(ev.target.value) || 1;
      _refreshEurEquiv();
    });

    // Refresh rate button
    document.getElementById('ex-rate-refresh')?.addEventListener('click', async () => {
      const rates = await _fetchRates();
      const foreignPerEur = rates[state.currency] || 1;
      state.exchangeRate = Math.round((1 / foreignPerEur) * 10000) / 10000;
      const rateInput = document.getElementById('ex-rate');
      if (rateInput) rateInput.value = state.exchangeRate.toFixed(4);
      _refreshEurEquiv();
      notify('Taux actualisé', '🔄');
    });

    // Participant checkbox change
    document.getElementById('ex-split-section')?.addEventListener('change', ev => {
      const cb = ev.target.closest('.tri-part-check');
      if (!cb) return;
      const pid    = cb.dataset.partId;
      const amount = parseFloat(document.getElementById('ex-amount')?.value || '0') || 0;
      if (cb.checked) {
        if (!state.participantSplits.find(s => s.id === pid)) {
          state.participantSplits.push({ id: pid, amount: 0 });
        }
      } else {
        state.participantSplits = state.participantSplits.filter(s => s.id !== pid);
      }
      _equalizeParticipants(state, amount);
      _refreshParticipantsSection(state, participants, amount);
    });

    // Participant amount change (manual)
    document.getElementById('ex-split-section')?.addEventListener('input', ev => {
      const input = ev.target.closest('.tri-part-amount');
      if (!input) return;
      const pid = input.dataset.partId;
      const val = parseFloat(input.value) || 0;
      const ps  = state.participantSplits.find(s => s.id === pid);
      if (ps) ps.amount = val;
      // Just update the total indicator
      const amount = parseFloat(document.getElementById('ex-amount')?.value || '0') || 0;
      const total  = state.participantSplits.reduce((s, p) => s + p.amount, 0);
      const rounded = Math.round(total * 100) / 100;
      const ok = amount > 0 && Math.abs(rounded - amount) < 0.01;
      const totalEl = document.getElementById('tri-part-total-val');
      if (totalEl) {
        // Just the running total here — the " / montant total" part is a
        // separate sibling <span> already in the initial markup
        // (_buildParticipantsHtml); appending it here too duplicated it
        // ("12,00 € / 20,00 € / 20,00 €") once this listener started firing.
        totalEl.textContent = _fmtEur(rounded);
        totalEl.style.color = ok ? 'var(--grn)' : amount > 0 ? 'var(--coral)' : 'var(--ink4)';
      }
    });

    // Equalize button
    document.getElementById('ex-split-section')?.addEventListener('click', ev => {
      if (ev.target.closest('#parts-equal')) {
        const amount = parseFloat(document.getElementById('ex-amount')?.value || '0') || 0;
        _equalizeParticipants(state, amount);
        _refreshParticipantsSection(state, participants, amount);
      }
    });

    attachReceiptEvents();

    document.getElementById('ex-save')?.addEventListener('click', () => {
      const desc   = document.getElementById('ex-desc')?.value?.trim()   || '';
      const amount = parseFloat(document.getElementById('ex-amount')?.value || '0') || 0;
      const catId  = document.getElementById('ex-cat')?.value             || '';
      const date   = document.getElementById('ex-date')?.value            || '';
      const dayId  = document.getElementById('ex-day')?.value             || null;
      const note   = document.getElementById('ex-note')?.value?.trim()    || '';

      state.paidById = document.getElementById('ex-payer')?.value || state.paidById;

      if (!desc)       { notify('Veuillez saisir une description', '⚠️'); return; }
      if (amount <= 0) { notify('Veuillez saisir un montant positif', '⚠️'); return; }
      if (state.participantSplits.length === 0) { notify('Sélectionnez au moins un participant', '⚠️'); return; }

      // Validate splits sum
      const splitTotal = state.participantSplits.reduce((s, ps) => s + ps.amount, 0);
      if (Math.abs(splitTotal - amount) > 0.01) {
        notify(`La somme des parts (${_fmtEur(splitTotal)}) doit égaler le montant (${_fmtEur(amount)})`, '⚠️');
        return;
      }

      // Validate payer split sum (compte commun)
      if (state.multiPayer) {
        if (state.payers.length === 0) { notify('Sélectionnez au moins une personne ayant payé', '⚠️'); return; }
        const payersTotal = state.payers.reduce((s, ps) => s + ps.amount, 0);
        if (Math.abs(payersTotal - amount) > 0.01) {
          notify(`La somme payée (${_fmtEur(payersTotal)}) doit égaler le montant (${_fmtEur(amount)})`, '⚠️');
          return;
        }
      }

      const freshTrip = getTrip(tripId);
      const newExp    = [...(freshTrip.realExpenses || [])];

      // Compute EUR amount for cross-currency balance calculations
      const isForeign = state.currency !== 'EUR';
      const amountEur = isForeign
        ? Math.round(amount * state.exchangeRate * 100) / 100
        : amount;

      // splits[].amount is stored in EUR, not the expense's own currency —
      // computeBalances (and tripstats' per-person/per-category totals) add
      // it directly to the payer's EUR-denominated credit, so a value still
      // in e.g. USD would silently corrupt every balance/settlement for this
      // expense. The split editor itself stays in native currency (matches
      // #ex-amount and the sum check just above); only convert at this
      // final persistence boundary.
      const splitsEur = state.participantSplits.map(ps => ({
        id:     ps.id,
        amount: isForeign ? Math.round(ps.amount * state.exchangeRate * 100) / 100 : ps.amount,
      }));

      // payers[].amount is EUR too, same conversion/rationale as splitsEur —
      // computeBalances credits each payer their own contribution directly.
      // Only set when "Compte commun" is on; otherwise cleared (undefined)
      // so editing a former compte-commun expense back to a single payer
      // actually drops the old payers array instead of leaving it stale.
      const payersEur = state.multiPayer
        ? state.payers.map(ps => ({
            id:     ps.id,
            amount: isForeign ? Math.round(ps.amount * state.exchangeRate * 100) / 100 : ps.amount,
          }))
        : undefined;

      const expData = {
        desc,
        amount,
        amountEur,
        currency:     isForeign ? state.currency      : undefined,
        exchangeRate: isForeign ? state.exchangeRate   : undefined,
        catId:        catId  || null,
        paidById:     state.multiPayer ? (payersEur[0]?.id || state.paidById) : state.paidById,
        payers:       payersEur,
        sharedWith:   state.participantSplits.map(ps => ps.id),
        splits:       splitsEur,
        date,
        dayId:        dayId  || null,
        note,
        receipt:      state.receipt || null,
      };

      if (isEdit) {
        const idx = newExp.findIndex(ex => ex.id === expId);
        if (idx !== -1) newExp[idx] = { ...newExp[idx], ...expData };
        notify('Dépense mise à jour', '✓');
      } else {
        newExp.push({ id: 'ex_' + uid(), ...expData });
        notify('Dépense ajoutée', '✓');
      }

      updateTrip(tripId, { realExpenses: newExp });
      closeModal();
      renderTricount(tripId);
    });

    document.getElementById('ex-delete')?.addEventListener('click', () => {
      if (!confirm('Supprimer cette d\xe9pense ?')) return;
      const fresh = getTrip(tripId);
      if (!fresh) { closeModal(); return; }
      updateTrip(tripId, { realExpenses: (fresh.realExpenses || []).filter(ex => ex.id !== expId) });
      notify('D\xe9pense supprim\xe9e', '🗑');
      closeModal();
      renderTricount(tripId);
    });

    attachCalcKeypad(document.getElementById('ex-amount'));
    document.querySelectorAll('#ex-split-section .tri-part-amount').forEach(attachCalcKeypad);
    document.querySelectorAll('#ex-payer-split-section .tri-payer-amount').forEach(attachCalcKeypad);
  }

  showModal(buildHtml(), { boxClass: 'hv2-modal v2-skin' });
  attachEvents();
}

// ── Transfer Modal ────────────────────────────────────────────────────────────

function _openTransferModal(tripId, expId = null) {
  const trip = getTrip(tripId);
  if (!trip) return;

  const participants = getParticipants(trip);
  if (participants.length < 2) {
    notify('Ajoutez au moins 2 participants pour enregistrer un virement', '⚠️');
    return;
  }

  const today    = new Date().toISOString().slice(0, 10);
  const existing = expId ? (trip.realExpenses || []).find(e => e.id === expId) : null;
  const isEdit   = !!existing;

  const fromOpts = participants.map(p =>
    `<option value="${_esc(p.id)}"${existing?.fromId === p.id ? ' selected' : ''}>${_esc(p.name)}</option>`
  ).join('');

  const toOpts = participants.map(p =>
    `<option value="${_esc(p.id)}"${existing?.toId === p.id ? ' selected' : ''}>${_esc(p.name)}</option>`
  ).join('');

  showModal(`
    <button class="mc" onclick="closeModal()">✕</button>
    <h3>💸 ${isEdit ? 'Modifier le virement' : 'Virement / remboursement'}</h3>
    <p style="font-size:12px;color:var(--ink4);margin-bottom:14px">
      Enregistrez un remboursement direct entre participants. Cela ajuste les soldes.
    </p>

    <div class="fg">
      <label>De (qui paie)</label>
      <select id="tr-from">${fromOpts}</select>
    </div>

    <div class="fg">
      <label>À (qui reçoit)</label>
      <select id="tr-to">${toOpts}</select>
    </div>

    <div class="fg">
      <label>Montant (€)</label>
      <input type="text" inputmode="decimal" id="tr-amount" placeholder="0" value="${existing ? existing.amount : ''}">
    </div>

    <div class="fg">
      <label>Date</label>
      <input type="date" id="tr-date" value="${existing ? existing.date : today}">
    </div>

    <div class="fg">
      <label>Note (optionnel)</label>
      <input type="text" id="tr-note" placeholder="Ex : remboursement dîner…" value="${_esc(existing?.note || '')}">
    </div>

    <div class="ma">
      <button class="bc" onclick="closeModal()">Annuler</button>
      ${isEdit ? `<button class="bc" id="tr-delete" style="color:var(--coral)">🗑 Supprimer</button>` : ''}
      <button class="bs" id="tr-save">Enregistrer</button>
    </div>`, { boxClass: 'hv2-modal v2-skin' });

  attachCalcKeypad(document.getElementById('tr-amount'));

  // Default to/from to be different when creating
  if (!isEdit) {
    const toSel = document.getElementById('tr-to');
    if (toSel && participants.length >= 2) toSel.selectedIndex = 1;
  }

  if (isEdit) {
    document.getElementById('tr-delete')?.addEventListener('click', () => {
      if (confirm('Supprimer ce virement ?')) {
        const freshTrip = getTrip(tripId);
        updateTrip(tripId, {
          realExpenses: (freshTrip.realExpenses || []).filter(e => e.id !== expId)
        });
        notify('Virement supprimé', '🗑');
        closeModal();
        renderTricount(tripId);
      }
    });
  }

  document.getElementById('tr-save')?.addEventListener('click', () => {
    const fromId = document.getElementById('tr-from')?.value || '';
    const toId   = document.getElementById('tr-to')?.value   || '';
    const amount = parseFloat(document.getElementById('tr-amount')?.value || '0') || 0;
    const date   = document.getElementById('tr-date')?.value  || today;
    const note   = document.getElementById('tr-note')?.value?.trim() || '';

    if (!fromId || !toId)  { notify('Sélectionnez les participants', '⚠️'); return; }
    if (fromId === toId)   { notify('Le payeur et le destinataire doivent être différents', '⚠️'); return; }
    if (amount <= 0)       { notify('Montant invalide', '⚠️'); return; }

    const freshTrip = getTrip(tripId);
    let newExps = [...(freshTrip.realExpenses || [])];

    if (isEdit) {
      const idx = newExps.findIndex(e => e.id === expId);
      if (idx !== -1) newExps[idx] = { ...newExps[idx], fromId, toId, amount, date, note };
    } else {
      newExps.push({ id: 'ex_' + uid(), type: 'transfer', fromId, toId, amount, date, note });
    }

    updateTrip(tripId, { realExpenses: newExps });
    notify(isEdit ? 'Virement modifié' : 'Virement enregistré', '💸');
    closeModal();
    renderTricount(tripId);
  });
}
