/* ============================================================
   CARNET DE VOYAGES — Tricount (Budget Réel) Module
   ============================================================ */

import { getTrip, updateTrip, uid } from '../store.js';
import { notify, showModal, closeModal, fmtDateShort } from '../utils.js';
import { updateTopStats } from './trip.js';

// ── Module state ──────────────────────────────────────────────────────────────

let _activeTab = 'depenses'; // 'depenses' | 'bilans' | 'budgetvsdep'

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

function _esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _fmtEur(v) {
  const n = Number(v) || 0;
  return n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

// ── Participants ──────────────────────────────────────────────────────────────

function getParticipants(trip) {
  const moi = { id: 'moi', name: 'Moi', color: '#0d9488' };
  if (!trip.companions || trip.companions.length === 0) return [moi];
  const hasSelf = trip.companions.some(c => c.id === 'moi');
  return hasSelf ? trip.companions : [moi, ...trip.companions];
}

// ── Balance calculation ───────────────────────────────────────────────────────

function computeBalances(trip) {
  const participants = getParticipants(trip);
  const balances = {};
  participants.forEach(p => { balances[p.id] = 0; });

  for (const exp of (trip.realExpenses || [])) {
    if (exp.type === 'transfer') {
      if (balances[exp.fromId] !== undefined) balances[exp.fromId] += Number(exp.amount) || 0;
      if (balances[exp.toId]   !== undefined) balances[exp.toId]   -= Number(exp.amount) || 0;
      continue;
    }

    // Payer gets credited the full amount (use EUR-converted amount when available)
    const eurAmt = exp.currency && exp.currency !== 'EUR'
      ? (Number(exp.amountEur) || Number(exp.amount) || 0)
      : (Number(exp.amount) || 0);
    if (balances[exp.paidById] !== undefined) {
      balances[exp.paidById] += eurAmt;
    }

    if (exp.splits && exp.splits.length > 0) {
      // Custom splits: each person owes their specific share
      for (const split of exp.splits) {
        if (balances[split.id] !== undefined) {
          balances[split.id] -= Number(split.amount) || 0;
        }
      }
    } else {
      // Equal split (backward compat)
      const splitCount = (exp.sharedWith || []).length;
      if (splitCount === 0) continue;
      const eurAmt2 = exp.currency && exp.currency !== 'EUR'
        ? (Number(exp.amountEur) || Number(exp.amount) || 0)
        : (Number(exp.amount) || 0);
      const share = eurAmt2 / splitCount;
      for (const pid of (exp.sharedWith || [])) {
        if (balances[pid] !== undefined) balances[pid] -= share;
      }
    }
  }

  return balances;
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

// ── Render ────────────────────────────────────────────────────────────────────

export function renderTricount(tripId) {
  const panel = document.getElementById('panel-tricount');
  if (!panel) return;

  const trip = getTrip(tripId);
  if (!trip) return;

  if (_handlers.has(panel)) {
    panel.removeEventListener('click', _handlers.get(panel));
    _handlers.delete(panel);
  }

  // Always start on the main expenses tab when entering a trip for the first time
  // so a stale "bilans" or "budgetvsdep" selection from a previous trip isn't shown
  _activeTab = 'depenses';

  const participants = getParticipants(trip);
  const balances    = computeBalances(trip);
  const settlements = computeSettlements(balances);

  panel.innerHTML = `
    <div class="tri-layout">
      <div class="tri-side">
        <div class="tri-side-sc" id="tri-side-content">
          ${_renderSide(trip, participants, balances)}
        </div>
      </div>
      <div class="tri-main" id="tri-main-content">
        ${_renderMain(trip, participants, balances, settlements)}
      </div>
    </div>
    <div class="panel-fab-menu" id="tri-fab-menu">
      <button class="pfm-btn" data-action="add-expense">💶 Dépense</button>
      <button class="pfm-btn" data-action="add-transfer">💸 Virement / Remboursement</button>
    </div>
    <button class="panel-fab" data-action="tri-fab" title="Ajouter">＋</button>`;

  // Close FAB menu on outside click
  setTimeout(() => {
    const fabMenu = panel.querySelector('#tri-fab-menu');
    if (fabMenu) {
      document.addEventListener('click', function _closeFab(ev) {
        if (!ev.target.closest('#tri-fab-menu') && !ev.target.closest('[data-action="tri-fab"]')) {
          fabMenu.classList.remove('visible');
          document.removeEventListener('click', _closeFab);
        }
      });
    }
  }, 0);

  const handler = e => _handleClick(e, tripId);
  _handlers.set(panel, handler);
  panel.addEventListener('click', handler);
}

// ── Side panel ────────────────────────────────────────────────────────────────

function _renderSide(trip, participants, balances) {
  let html = `<div class="bs-lbl" style="padding:4px 2px 8px">Participants</div>`;

  for (const p of participants) {
    const bal      = balances[p.id] ?? 0;
    const initials = (p.name || '?').slice(0, 2).toUpperCase();
    const balColor = bal > 0.01 ? 'var(--grn)' : bal < -0.01 ? 'var(--coral)' : 'var(--ink4)';
    const balLabel = bal > 0.01 ? '+' + _fmtEur(bal) : _fmtEur(bal);

    html += `
      <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;margin-bottom:3px">
        <div class="comp-avatar" style="background:${_esc(p.color || '#0d9488')};width:28px;height:28px;font-size:11px;font-weight:800">${initials}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:11px;font-weight:700;color:var(--ink)">${_esc(p.name)}</div>
          <div style="font-size:10px;font-weight:700;color:${balColor}">${balLabel}</div>
        </div>
      </div>`;
  }

  html += `
    <div style="padding:8px 4px;margin-top:4px;display:flex;flex-direction:column;gap:5px">
      <button class="btn-new" style="width:100%;justify-content:center;font-size:11px" data-action="add-expense">
        &#xFE0F; Ajouter une d&eacute;pense
      </button>
      <button class="btn-new" style="width:100%;justify-content:center;font-size:11px;background:var(--c2);color:var(--ink3);border-color:var(--c3)" data-action="add-transfer">
        💸 Virement / remboursement
      </button>
    </div>`;

  return html;
}

// ── Main panel ────────────────────────────────────────────────────────────────

function _renderMain(trip, participants, balances, settlements) {
  const isDepenses   = _activeTab === 'depenses';
  const isBilans     = _activeTab === 'bilans';
  const isBudgetVsDep = _activeTab === 'budgetvsdep';

  function tabStyle(active) {
    return `padding:5px 16px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;
            background:${active ? '#fff' : 'transparent'};
            color:${active ? 'var(--teal)' : 'var(--ink3)'};
            box-shadow:${active ? 'var(--sh)' : 'none'};transition:all .15s`;
  }

  const mobTabs = `
    <div class="tri-mob-tabs">
      <button class="tri-m-tab${isDepenses ? ' active' : ''}" data-action="switch-tab" data-tab="depenses">💶 Dépenses</button>
      <button class="tri-m-tab${isBilans ? ' active' : ''}" data-action="switch-tab" data-tab="bilans">⚖️ Bilans</button>
      <button class="tri-m-tab${isBudgetVsDep ? ' active' : ''}" data-action="switch-tab" data-tab="budgetvsdep">📊 Budget</button>
    </div>`;

  const tabs = mobTabs + `
    <div class="tri-tab-row-inline" style="display:flex;gap:3px;background:var(--c2);border-radius:8px;padding:3px;border:1px solid var(--c3);margin-bottom:16px;width:fit-content">
      <div data-action="switch-tab" data-tab="depenses" style="${tabStyle(isDepenses)}">
        D&eacute;penses
      </div>
      <div data-action="switch-tab" data-tab="bilans" style="${tabStyle(isBilans)}">
        Bilans
      </div>
      <div data-action="switch-tab" data-tab="budgetvsdep" style="${tabStyle(isBudgetVsDep)}">
        Budget vs D&eacute;p.
      </div>
    </div>`;

  let content;
  if (isDepenses) {
    content = _renderDepenses(trip, participants);
  } else if (isBilans) {
    content = _renderBilans(trip, participants, balances, settlements);
  } else {
    content = _renderBudgetVsDep(trip);
  }

  return tabs + `<div class="tri-main-pad">${content}</div>`;
}

// ── Dépenses tab ──────────────────────────────────────────────────────────────

function _renderDepenses(trip, participants) {
  const expenses   = trip.realExpenses || [];
  const cats       = trip.budgetCats   || [];
  const days       = trip.days         || [];
  const totalSpent = expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);

  if (expenses.length === 0) {
    return `
      <div style="text-align:center;padding:40px 20px;color:var(--ink4)">
        <div style="font-size:32px;margin-bottom:10px">&#x1F4B8;</div>
        <div style="font-size:13px">Aucune d&eacute;pense enregistr&eacute;e</div>
        <div style="font-size:11px;margin-top:4px">Cliquez sur &laquo;&nbsp;Ajouter une d&eacute;pense&nbsp;&raquo; pour commencer</div>
      </div>`;
  }

  let rows = '';
  for (const exp of [...expenses].reverse()) {
    // Transfer row
    if (exp.type === 'transfer') {
      const fromP = participants.find(p => p.id === exp.fromId);
      const toP   = participants.find(p => p.id === exp.toId);
      rows += `
        <tr style="background:var(--c2)">
          <td>
            <div style="display:flex;align-items:center;gap:5px">
              <span style="font-size:14px">💸</span>
              <div>
                <div style="font-weight:600;color:var(--ink)">Virement</div>
                ${exp.note ? `<div style="font-size:10px;color:var(--ink4)">${_esc(exp.note)}</div>` : ''}
              </div>
            </div>
          </td>
          <td style="font-weight:700">${_fmtEur(exp.amount)}</td>
          <td colspan="2">
            <span class="payer-chip" style="background:${_esc(fromP?.color || '#888')}">${_esc(fromP?.name || exp.fromId)}</span>
            <span style="font-size:11px;color:var(--ink4);margin:0 3px">→</span>
            <span class="payer-chip" style="background:${_esc(toP?.color || '#888')}">${_esc(toP?.name || exp.toId)}</span>
          </td>
          <td></td>
          <td style="font-size:10px;color:var(--ink4);white-space:nowrap">${exp.date ? fmtDateShort(exp.date) : ''}</td>
          <td>
            <div style="display:flex;gap:4px">
              <button class="tc-edit-btn" data-action="delete-expense" data-exp-id="${_esc(exp.id)}" title="Supprimer" style="color:var(--coral)">&#x1F5D1;</button>
            </div>
          </td>
        </tr>`;
      continue;
    }

    const payer = participants.find(p => p.id === exp.paidById);
    const cat   = cats.find(c => c.id === exp.catId);
    const day   = days.find(d => d.id === exp.dayId);

    const payerHtml = payer
      ? `<span class="payer-chip" style="background:${_esc(payer.color || '#0d9488')}">${_esc(payer.name)}</span>`
      : `<span class="payer-chip" style="background:var(--c4);color:var(--ink3)">${_esc(exp.paidById || '?')}</span>`;

    let sharedHtml;
    if (exp.splits && exp.splits.length > 0) {
      sharedHtml = exp.splits.map(split => {
        const p = participants.find(pt => pt.id === split.id);
        return `<span class="split-chip" title="${_esc((p?.name || split.id) + ' : ' + _fmtEur(split.amount))}">${_esc(p ? p.name : split.id)}&nbsp;<span style="opacity:.7">${_fmtEur(split.amount)}</span></span>`;
      }).join('');
    } else {
      const splitCount = (exp.sharedWith || []).length;
      const share = splitCount > 0 ? (Number(exp.amount) || 0) / splitCount : 0;
      sharedHtml = (exp.sharedWith || []).map(pid => {
        const p = participants.find(pt => pt.id === pid);
        return `<span class="split-chip">${_esc(p ? p.name : pid)}&nbsp;<span style="opacity:.7">${_fmtEur(share)}</span></span>`;
      }).join('');
    }

    const catHtml = cat
      ? `<span style="font-size:9px;font-weight:800;padding:1px 6px;border-radius:999px;background:${_esc(cat.color || '#0d9488')}22;color:${_esc(cat.color || '#0d9488')}">${_esc(cat.icon || '')} ${_esc(cat.name)}</span>`
      : '';

    const dateHtml = exp.date ? fmtDateShort(exp.date) : '';
    const dayHtml  = day ? 'Jour ' + day.num : '';
    const refHtml  = [dateHtml, dayHtml].filter(Boolean).join(' \xb7 ');

    rows += `
      <tr>
        <td>
          <div style="font-weight:600;color:var(--ink)">${_esc(exp.desc || '—')}</div>
          ${exp.note ? `<div style="font-size:10px;color:var(--ink4);margin-top:1px">${_esc(exp.note)}</div>` : ''}
          ${exp.receipt ? `<img src="${_esc(exp.receipt)}" alt="Reçu" title="Voir le reçu" style="max-height:28px;max-width:40px;border-radius:3px;object-fit:cover;margin-top:3px;cursor:pointer;display:block" onclick="window.open(this.src,'_blank')">` : ''}
        </td>
        <td style="font-weight:700">
          ${exp.currency && exp.currency !== 'EUR'
            ? `${Number(exp.amount).toLocaleString('fr-FR', {minimumFractionDigits:2,maximumFractionDigits:2})} ${exp.currency}<div style="font-size:10px;color:var(--ink4)">${_fmtEur(exp.amountEur || exp.amount)}</div>`
            : _fmtEur(exp.amount)}
        </td>
        <td>${payerHtml}</td>
        <td><div class="split-chips">${sharedHtml || '—'}</div></td>
        <td>${catHtml}</td>
        <td style="font-size:10px;color:var(--ink4);white-space:nowrap">${_esc(refHtml)}</td>
        <td>
          <div style="display:flex;gap:4px">
            <button class="tc-edit-btn" data-action="edit-expense" data-exp-id="${_esc(exp.id)}" title="Modifier">&#x270F;&#xFE0F;</button>
            <button class="tc-edit-btn" data-action="delete-expense" data-exp-id="${_esc(exp.id)}" title="Supprimer" style="color:var(--coral)">&#x1F5D1;</button>
          </div>
        </td>
      </tr>`;
  }

  // Category donut chart
  const donutHtml = _renderCatDonut(trip, expenses);

  return `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
      <div>
        <span style="font-family:var(--sf);font-size:16px;font-weight:700">D&eacute;penses</span>
        <span style="font-size:12px;color:var(--ink4);margin-left:8px">${expenses.length} entr&eacute;e${expenses.length !== 1 ? 's' : ''} &middot; ${_fmtEur(totalSpent)}</span>
      </div>
    </div>
    <table class="tri-exp-table">
      <thead>
        <tr>
          <th>Description</th>
          <th>Montant</th>
          <th>Pay&eacute; par</th>
          <th>Partag&eacute; avec</th>
          <th>Cat&eacute;gorie</th>
          <th>R&eacute;f&eacute;rence</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    ${donutHtml}`;
}

// ── Category donut chart ──────────────────────────────────────────────────────

function _renderCatDonut(trip, expenses) {
  const cats  = trip.budgetCats || [];
  const total = expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  if (cats.length === 0 || total === 0) return '';

  const spentByCat = {};
  for (const exp of expenses) {
    if (exp.catId) spentByCat[exp.catId] = (spentByCat[exp.catId] || 0) + (Number(exp.amount) || 0);
  }

  const budgetByCat = {};
  for (const line of (trip.budgetLines || [])) {
    if (line.catId) budgetByCat[line.catId] = (budgetByCat[line.catId] || 0) + (Number(line.amount) || 0);
  }

  const segments = cats
    .map(cat => ({
      label:   cat.name,
      icon:    cat.icon  || '📦',
      color:   cat.color || '#888',
      spent:   spentByCat[cat.id]  || 0,
      planned: budgetByCat[cat.id] || 0,
    }))
    .filter(s => s.spent > 0);

  if (segments.length === 0) return '';

  const R = 40, cx = 50, cy = 50;
  const circ = 2 * Math.PI * R;
  let offset = 0;
  let arcs = '';
  for (const seg of segments) {
    const dash = (seg.spent / total) * circ;
    const over = seg.planned > 0 && seg.spent > seg.planned;
    arcs += `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none"
      stroke="${over ? 'var(--coral)' : _esc(seg.color)}" stroke-width="16"
      stroke-dasharray="${dash.toFixed(2)} ${(circ - dash).toFixed(2)}"
      stroke-dashoffset="${(-offset).toFixed(2)}"
      transform="rotate(-90 ${cx} ${cy})"/>`;
    offset += dash;
  }

  const legend = segments.map(s => {
    const over = s.planned > 0 && s.spent > s.planned;
    return `
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
        <div style="width:10px;height:10px;border-radius:50%;background:${over ? 'var(--coral)' : _esc(s.color)};flex-shrink:0"></div>
        <div style="font-size:11px;color:var(--ink2);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(s.icon)} ${_esc(s.label)}</div>
        <div style="font-size:11px;font-weight:700;color:${over ? 'var(--coral)' : 'var(--ink)'}">
          ${_fmtEur(s.spent)}${s.planned > 0 ? `<span style="font-weight:400;color:var(--ink4)"> / ${_fmtEur(s.planned)}</span>` : ''}
        </div>
      </div>`;
  }).join('');

  return `
    <div style="margin-top:20px;background:var(--c);border:1.5px solid var(--c3);border-radius:10px;padding:14px 16px">
      <div style="font-size:12px;font-weight:700;color:var(--ink2);margin-bottom:12px">R&eacute;partition par cat&eacute;gorie</div>
      <div style="display:flex;align-items:center;gap:20px;flex-wrap:wrap">
        <svg width="100" height="100" viewBox="0 0 100 100" style="flex-shrink:0">
          <circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="var(--c3)" stroke-width="16"/>
          ${arcs}
        </svg>
        <div style="flex:1;min-width:140px">${legend}</div>
      </div>
    </div>`;
}

// ── Budget vs real comparison ─────────────────────────────────────────────────

function _renderBudgetComparison(trip, totalSpent) {
  const budgetLines = trip.budgetLines || [];
  const totalBudget = budgetLines.reduce((s, l) => s + (Number(l.amount) || 0), 0);

  if (totalBudget === 0) return '';

  const diff      = totalBudget - totalSpent;
  const underBudget = diff >= 0;
  const pct       = Math.min(100, Math.round((totalSpent / totalBudget) * 100));
  const barColor  = underBudget ? 'var(--grn)' : 'var(--coral)';

  return `
    <div style="margin-top:16px;background:var(--c);border:1.5px solid var(--c3);border-radius:10px;padding:14px 16px">
      <div style="font-size:12px;font-weight:700;color:var(--ink2);margin-bottom:12px">Comparaison budget / r&eacute;el</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">
        <div style="flex:1;min-width:100px;background:var(--c2);border-radius:8px;padding:10px 12px;border:1px solid var(--c3)">
          <div style="font-size:10px;color:var(--ink4);margin-bottom:3px">Budget pr&eacute;vu</div>
          <div style="font-size:14px;font-weight:800;color:var(--ink)">${_fmtEur(totalBudget)}</div>
        </div>
        <div style="flex:1;min-width:100px;background:var(--c2);border-radius:8px;padding:10px 12px;border:1px solid var(--c3)">
          <div style="font-size:10px;color:var(--ink4);margin-bottom:3px">D&eacute;penses r&eacute;elles</div>
          <div style="font-size:14px;font-weight:800;color:var(--ink)">${_fmtEur(totalSpent)}</div>
        </div>
        <div style="flex:1;min-width:100px;background:${underBudget ? 'var(--tl)' : '#fff0ee'};border-radius:8px;padding:10px 12px;border:1px solid ${underBudget ? 'var(--teal)' : 'var(--coral)'}44">
          <div style="font-size:10px;color:var(--ink4);margin-bottom:3px">&Eacute;cart</div>
          <div style="font-size:14px;font-weight:800;color:${underBudget ? 'var(--grn)' : 'var(--coral)'}">
            ${underBudget ? '-' : '+'}${_fmtEur(Math.abs(diff))}
          </div>
          <div style="font-size:10px;color:${underBudget ? 'var(--grn)' : 'var(--coral)'}">${underBudget ? 'sous le budget' : 'hors budget'}</div>
        </div>
      </div>
      <div style="font-size:10px;color:var(--ink4);margin-bottom:5px">${pct}% du budget utilis&eacute;</div>
      <div style="background:var(--c3);border-radius:6px;height:10px;overflow:hidden">
        <div style="width:${pct}%;height:100%;background:${barColor};border-radius:6px;transition:width .3s"></div>
      </div>
    </div>`;
}

// ── Bilans tab ────────────────────────────────────────────────────────────────

function _renderBilans(trip, participants, balances, settlements) {
  if ((trip.realExpenses || []).length === 0) {
    return `
      <div style="text-align:center;padding:40px 20px;color:var(--ink4)">
        <div style="font-size:32px;margin-bottom:10px">&#x1F4CA;</div>
        <div style="font-size:13px">Ajoutez des d&eacute;penses pour voir les bilans</div>
      </div>`;
  }

  // Balance cards
  let balCards = '';
  for (const p of participants) {
    const bal      = balances[p.id] ?? 0;
    const isPos    = bal > 0.01;
    const isNeg    = bal < -0.01;
    const balClass = isPos ? 'positive' : isNeg ? 'negative' : '';
    const label    = isPos ? '\xe0 recevoir' : isNeg ? '\xe0 rembourser' : '\xe9quilibr\xe9';
    const display  = Math.abs(bal) < 0.01 ? '0,00 €' : _fmtEur(Math.abs(bal));

    balCards += `
      <div class="balance-card" style="max-width:100%">
        <div class="bc-name" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(p.name)}</div>
        <div class="bc-amt ${balClass}">${display}</div>
        <div class="bc-label" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${label}</div>
      </div>`;
  }

  // Settlements
  let settleHtml = '';
  if (settlements.length > 0) {
    const rows = settlements.map(s => {
      const from = participants.find(p => p.id === s.from);
      const to   = participants.find(p => p.id === s.to);
      return `
        <div class="settlement-row">
          <strong>${_esc(from ? from.name : s.from)}</strong>
          <span>→</span>
          <strong>${_esc(to ? to.name : s.to)}</strong>
          <span>:</span>
          <span style="font-weight:700;color:var(--teal)">${_fmtEur(s.amount)}</span>
        </div>`;
    }).join('');

    settleHtml = `
      <div class="settlements">
        <h4>Remboursements sugg&eacute;r&eacute;s</h4>
        ${rows}
      </div>`;
  } else {
    settleHtml = `
      <div class="settlements" style="background:var(--tl);border-color:var(--teal)">
        <h4 style="color:var(--td)">✓ Tout est &eacute;quilibr&eacute;</h4>
        <div style="font-size:12px;color:var(--td)">Aucun remboursement n&eacute;cessaire.</div>
      </div>`;
  }

  return `
    <div style="font-family:var(--sf);font-size:16px;font-weight:700;margin-bottom:14px">Bilans</div>
    <div class="balance-cards">${balCards}</div>
    ${settleHtml}`;
}

// ── Budget vs Dépenses tab ────────────────────────────────────────────────────

function _renderBudgetVsDep(trip) {
  const cats        = trip.budgetCats    || [];
  const expenses    = trip.realExpenses  || [];
  const budgetLines = trip.budgetLines   || [];

  if (cats.length === 0) {
    return `
      <div style="text-align:center;padding:40px 20px;color:var(--ink4)">
        <div style="font-size:32px;margin-bottom:10px">&#x1F4CA;</div>
        <div style="font-size:13px">Aucune cat&eacute;gorie de budget d&eacute;finie</div>
        <div style="font-size:11px;margin-top:4px">Ajoutez des cat&eacute;gories dans le budget pr&eacute;visionnel du voyage</div>
      </div>`;
  }

  // Sum real expenses by category
  const spentByCat = {};
  for (const exp of expenses) {
    if (exp.catId) {
      spentByCat[exp.catId] = (spentByCat[exp.catId] || 0) + (Number(exp.amount) || 0);
    }
  }

  // Sum budget lines by category
  const budgetByCat = {};
  for (const line of budgetLines) {
    if (line.catId) {
      budgetByCat[line.catId] = (budgetByCat[line.catId] || 0) + (Number(line.amount) || 0);
    }
  }

  let totalPlanned = 0;
  let totalSpent   = 0;
  let rows = '';

  for (const cat of cats) {
    const planned = budgetByCat[cat.id] || 0;
    const spent   = spentByCat[cat.id]  || 0;
    const diff    = planned - spent;
    const isOver  = diff < -0.01;
    const isUnder = diff > 0.01;
    const diffColor = isOver ? 'var(--coral)' : isUnder ? 'var(--grn)' : 'var(--ink4)';
    const diffSign  = isOver ? '+' : '';
    const pct       = planned > 0 ? Math.min(100, Math.round((spent / planned) * 100)) : (spent > 0 ? 100 : 0);
    const barColor  = isOver ? 'var(--coral)' : (cat.color || '#0d9488');

    totalPlanned += planned;
    totalSpent   += spent;

    rows += `
      <tr>
        <td>
          <div style="display:flex;align-items:center;gap:6px">
            <span style="font-size:15px">${_esc(cat.icon || '📦')}</span>
            <span style="font-size:12px;font-weight:600;color:var(--ink)">${_esc(cat.name)}</span>
          </div>
        </td>
        <td style="font-weight:600;color:var(--ink2)">${_fmtEur(planned)}</td>
        <td style="font-weight:700;color:var(--ink)">${_fmtEur(spent)}</td>
        <td style="font-weight:700;color:${diffColor}">${diffSign}${_fmtEur(Math.abs(diff))}${isOver ? ' &#x26A0;' : ''}</td>
        <td style="min-width:100px">
          <div style="display:flex;align-items:center;gap:6px">
            <div style="flex:1;background:var(--c3);border-radius:4px;height:10px;overflow:hidden;min-width:60px">
              <div style="width:${pct}%;height:100%;background:${barColor};border-radius:4px;transition:width .3s"></div>
            </div>
            <span style="font-size:10px;color:var(--ink4);white-space:nowrap">${pct}%</span>
          </div>
        </td>
      </tr>`;
  }

  const totalDiff   = totalPlanned - totalSpent;
  const isOverTotal = totalDiff < -0.01;
  const totalPct    = totalPlanned > 0 ? Math.min(100, Math.round((totalSpent / totalPlanned) * 100)) : 0;
  const totalDiffColor = isOverTotal ? 'var(--coral)' : 'var(--grn)';
  const totalDiffSign  = isOverTotal ? '+' : '';
  const totalBarColor  = isOverTotal ? 'var(--coral)' : 'var(--grn)';

  return `
    <div style="font-family:var(--sf);font-size:16px;font-weight:700;margin-bottom:14px">Budget vs D&eacute;penses</div>
    <div style="overflow-x:auto">
      <table class="tri-exp-table">
        <thead>
          <tr>
            <th>Cat&eacute;gorie</th>
            <th>Budget pr&eacute;vu</th>
            <th>D&eacute;penses r&eacute;elles</th>
            <th>&Eacute;cart</th>
            <th>Progression</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
          <tr style="border-top:2px solid var(--c3);font-weight:800">
            <td><span style="font-size:12px;font-weight:800;color:var(--ink)">TOTAL</span></td>
            <td style="font-weight:800;color:var(--ink)">${_fmtEur(totalPlanned)}</td>
            <td style="font-weight:800;color:var(--ink)">${_fmtEur(totalSpent)}</td>
            <td style="font-weight:800;color:${totalDiffColor}">${totalDiffSign}${_fmtEur(Math.abs(totalDiff))}${isOverTotal ? ' &#x26A0;' : ''}</td>
            <td>
              <div style="display:flex;align-items:center;gap:6px">
                <div style="flex:1;background:var(--c3);border-radius:4px;height:10px;overflow:hidden;min-width:60px">
                  <div style="width:${totalPct}%;height:100%;background:${totalBarColor};border-radius:4px;transition:width .3s"></div>
                </div>
                <span style="font-size:10px;color:var(--ink4);white-space:nowrap">${totalPct}%</span>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>`;
}

// ── Event delegation ──────────────────────────────────────────────────────────

function _handleClick(e, tripId) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;

  const action = btn.dataset.action;

  if (action === 'tri-fab') {
    const menu = document.getElementById('tri-fab-menu');
    if (menu) menu.classList.toggle('visible');

  } else if (action === 'add-expense') {
    document.getElementById('tri-fab-menu')?.classList.remove('visible');
    _openExpenseModal(tripId, null);

  } else if (action === 'add-transfer') {
    document.getElementById('tri-fab-menu')?.classList.remove('visible');
    _openTransferModal(tripId);

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
      updateTopStats(tripId);
      renderTricount(tripId);
    }

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

// ── Participants split helpers ────────────────────────────────────────────────

function _buildParticipantsHtml(state, participants, expAmount) {
  const curSym = CURRENCIES.find(c => c.code === state.currency)?.symbol || '€';
  const rows = participants.map(p => {
    const split = state.participantSplits.find(s => s.id === p.id);
    const incl  = !!split;
    const amt   = split ? split.amount : 0;
    return `
      <label style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:8px;
                    margin-bottom:3px;cursor:pointer;user-select:none;
                    background:${incl ? 'var(--tl)' : 'var(--c)'};
                    border:1.5px solid ${incl ? 'var(--teal)' : 'var(--c3)'}">
        <input type="checkbox" class="tri-part-check" data-part-id="${_esc(p.id)}"
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
        <input type="number" class="tri-part-amount" data-part-id="${_esc(p.id)}"
          min="0" step="0.01" value="${amt > 0 || incl ? amt.toFixed(2) : ''}"
          ${!incl ? 'disabled' : ''}
          style="width:78px;padding:4px 7px;border:1.5px solid var(--c3);border-radius:7px;
                 font-size:12px;text-align:right;background:var(--c);color:var(--ink);
                 ${!incl ? 'opacity:.35;' : ''}">
        <span style="font-size:11px;color:var(--ink3);flex-shrink:0;min-width:10px">${_esc(curSym)}</span>
      </label>`;
  }).join('');

  const total   = state.participantSplits.reduce((s, ps) => s + ps.amount, 0);
  const rounded = Math.round(total * 100) / 100;
  const ok      = expAmount > 0 && Math.abs(rounded - expAmount) < 0.01;

  return `
    <div id="tri-participants-list">${rows}</div>
    <div style="display:flex;align-items:center;justify-content:space-between;margin-top:5px;
                padding:6px 10px;background:var(--c2);border-radius:8px;border:1px solid var(--c3)">
      <button type="button" id="parts-equal"
        style="background:var(--teal);border:none;border-radius:5px;padding:3px 10px;
               font-size:10px;font-weight:700;cursor:pointer;color:#fff;font-family:var(--fn)">
        Égaliser
      </button>
      <div style="font-size:12px;font-weight:700">
        <span id="tri-part-total-val"
          style="color:${ok ? 'var(--grn)' : expAmount > 0 ? 'var(--coral)' : 'var(--ink4)'}">
          ${_fmtEur(rounded)}
        </span>
        ${expAmount > 0 ? `<span style="font-size:10px;font-weight:400;color:var(--ink4)"> / ${_fmtEur(expAmount)}</span>` : ''}
      </div>
    </div>`;
}

function _equalizeParticipants(state, amount) {
  const n = state.participantSplits.length;
  if (n === 0) return;
  const share = Math.round((amount / n) * 100) / 100;
  // Distribute rounding remainder to first participant
  let total = share * n;
  const remainder = Math.round((amount - total) * 100) / 100;
  state.participantSplits.forEach((ps, i) => {
    ps.amount = i === 0 ? share + remainder : share;
  });
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

  // Build initial participant splits
  function _initSplits(amount) {
    if (exp?.splits?.length) {
      return exp.splits.map(s => ({ id: s.id, amount: Number(s.amount) || 0 }));
    }
    if (exp?.sharedWith?.length) {
      const share = amount / exp.sharedWith.length;
      return exp.sharedWith.map(id => ({ id, amount: Math.round(share * 100) / 100 }));
    }
    const share = amount / participants.length;
    return participants.map(p => ({ id: p.id, amount: Math.round(share * 100) / 100 }));
  }

  const initAmount = Number(exp?.amount) || 0;
  const state = {
    paidById:          exp?.paidById   || defaultPayer,
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
        `<option value="${_esc(d.id)}"${exp?.dayId === d.id ? ' selected' : ''}>Jour ${d.num}${d.title ? ' · ' + _esc(d.title) : ''}${d.date ? ' (' + fmtDateShort(d.date) + ')' : ''}</option>`
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
          <input type="number" id="ex-amount" min="0" step="0.01" placeholder="0"
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
        <label>Payé par</label>
        <select id="ex-payer">${payerOptions}</select>
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
        <button class="bs" id="ex-save">Enregistrer</button>
      </div>`;
  }

  function attachEvents() {
    document.getElementById('ex-payer')?.addEventListener('change', ev => {
      state.paidById = ev.target.value;
    });

    // Amount change → auto-equalize participants
    document.getElementById('ex-amount')?.addEventListener('input', () => {
      const amount = parseFloat(document.getElementById('ex-amount')?.value || '0') || 0;
      _equalizeParticipants(state, amount);
      _refreshParticipantsSection(state, participants, amount);
      _refreshEurEquiv();
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
        totalEl.textContent = _fmtEur(rounded) + (amount > 0 ? ' / ' + _fmtEur(amount) : '');
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

      const freshTrip = getTrip(tripId);
      const newExp    = [...(freshTrip.realExpenses || [])];

      // Compute EUR amount for cross-currency balance calculations
      const amountEur = state.currency !== 'EUR'
        ? Math.round(amount * state.exchangeRate * 100) / 100
        : amount;

      const expData = {
        desc,
        amount,
        amountEur,
        currency:     state.currency !== 'EUR' ? state.currency : undefined,
        exchangeRate: state.currency !== 'EUR' ? state.exchangeRate : undefined,
        catId:        catId  || null,
        paidById:     state.paidById,
        sharedWith:   state.participantSplits.map(ps => ps.id),
        splits:       state.participantSplits,
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
      updateTopStats(tripId);
      closeModal();
      renderTricount(tripId);
    });
  }

  showModal(buildHtml());
  attachEvents();
}

// ── Transfer Modal ────────────────────────────────────────────────────────────

function _openTransferModal(tripId) {
  const trip = getTrip(tripId);
  if (!trip) return;

  const participants = getParticipants(trip);
  if (participants.length < 2) {
    notify('Ajoutez au moins 2 participants pour enregistrer un virement', '⚠️');
    return;
  }

  const today = new Date().toISOString().slice(0, 10);

  const fromOpts = participants.map(p =>
    `<option value="${_esc(p.id)}">${_esc(p.name)}</option>`
  ).join('');

  const toOpts = participants.map(p =>
    `<option value="${_esc(p.id)}">${_esc(p.name)}</option>`
  ).join('');

  showModal(`
    <button class="mc" onclick="closeModal()">✕</button>
    <h3>💸 Virement / remboursement</h3>
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
      <input type="number" id="tr-amount" min="0.01" step="0.01" placeholder="0">
    </div>

    <div class="fg">
      <label>Date</label>
      <input type="date" id="tr-date" value="${today}">
    </div>

    <div class="fg">
      <label>Note (optionnel)</label>
      <input type="text" id="tr-note" placeholder="Ex : remboursement dîner…">
    </div>

    <div class="ma">
      <button class="bc" onclick="closeModal()">Annuler</button>
      <button class="bs" id="tr-save">Enregistrer</button>
    </div>`);

  // Default to/from to be different
  const toSel = document.getElementById('tr-to');
  if (toSel && participants.length >= 2) {
    toSel.selectedIndex = 1;
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
    const newExp    = [...(freshTrip.realExpenses || [])];
    newExp.push({
      id:     'ex_' + uid(),
      type:   'transfer',
      fromId,
      toId,
      amount,
      date,
      note,
    });

    updateTrip(tripId, { realExpenses: newExp });
    updateTopStats(tripId);
    notify('Virement enregistré', '💸');
    closeModal();
    renderTricount(tripId);
  });
}
