/* ============================================================
   CARNET DE VOYAGES — Tricount (Budget Réel) Module
   ============================================================ */

import { getTrip, updateTrip, uid } from '../store.js';
import { notify, showModal, closeModal, fmtDateShort } from '../utils.js';
import { updateTopStats } from './trip.js';

// ── Module state ──────────────────────────────────────────────────────────────

let _activeTab = 'depenses'; // 'depenses' | 'bilans' | 'budgetvsdep'

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
    const splitCount = (exp.sharedWith || []).length;
    if (splitCount === 0) continue;

    const share = exp.amount / splitCount;

    // Payer gets credited the full amount paid
    if (balances[exp.paidById] !== undefined) {
      balances[exp.paidById] += exp.amount;
    }

    // Each person in sharedWith owes their share
    for (const pid of (exp.sharedWith || [])) {
      if (balances[pid] !== undefined) {
        balances[pid] -= share;
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
    </div>`;

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
    <div style="padding:8px 4px;margin-top:4px">
      <button class="btn-new" style="width:100%;justify-content:center;font-size:11px" data-action="add-expense">
        &#xFE0F; Ajouter une d&eacute;pense
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

  const tabs = `
    <div style="display:flex;gap:3px;background:var(--c2);border-radius:8px;padding:3px;border:1px solid var(--c3);margin-bottom:16px;width:fit-content">
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

  return tabs + content;
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
    const payer = participants.find(p => p.id === exp.paidById);
    const cat   = cats.find(c => c.id === exp.catId);
    const day   = days.find(d => d.id === exp.dayId);

    const payerHtml = payer
      ? `<span class="payer-chip" style="background:${_esc(payer.color || '#0d9488')}">${_esc(payer.name)}</span>`
      : `<span class="payer-chip" style="background:var(--c4);color:var(--ink3)">${_esc(exp.paidById || '?')}</span>`;

    const sharedHtml = (exp.sharedWith || []).map(pid => {
      const p = participants.find(pt => pt.id === pid);
      return `<span class="split-chip">${_esc(p ? p.name : pid)}</span>`;
    }).join('');

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
        <td style="font-weight:700">${_fmtEur(exp.amount)}</td>
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

  if (action === 'add-expense') {
    _openExpenseModal(tripId, null);

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
  const defaultShared = participants.map(p => p.id);

  const state = {
    paidById:   exp?.paidById   || defaultPayer,
    sharedWith: exp?.sharedWith ? [...exp.sharedWith] : [...defaultShared],
    receipt:    exp?.receipt    || null,
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
      : `<option value="" disabled>Aucune catégorie disponible — créez-en une dans Budget</option>`;

    const daysOpts = `<option value="">Aucun jour</option>` +
      days.map(d =>
        `<option value="${_esc(d.id)}"${exp?.dayId === d.id ? ' selected' : ''}>Jour ${d.num}${d.title ? ' \xb7 ' + _esc(d.title) : ''}${d.date ? ' (' + fmtDateShort(d.date) + ')' : ''}</option>`
      ).join('');

    const payerOptions = participants.map(p =>
      `<option value="${_esc(p.id)}"${state.paidById === p.id ? ' selected' : ''}>${_esc(p.name)}</option>`
    ).join('');

    const sharedCheckboxes = participants.map(p => {
      const checked = state.sharedWith.includes(p.id);
      return `
        <label style="display:flex;align-items:center;gap:7px;padding:4px 0;cursor:pointer;font-size:12px;color:var(--ink2)">
          <input type="checkbox" data-shared-id="${_esc(p.id)}" ${checked ? 'checked' : ''}
            style="width:15px;height:15px;cursor:pointer;accent-color:var(--teal)">
          <div class="comp-avatar" style="background:${_esc(p.color || '#0d9488')};width:20px;height:20px;font-size:9px;font-weight:800">${(p.name || '?').slice(0, 2).toUpperCase()}</div>
          ${_esc(p.name)}
        </label>`;
    }).join('');

    const today = new Date().toISOString().slice(0, 10);

    return `
      <button class="mc" onclick="closeModal()">✕</button>
      <h3>${isEdit ? '✏️ Modifier la d\xe9pense' : '+ Nouvelle d\xe9pense'}</h3>

      <div class="fg">
        <label>Description</label>
        <input type="text" id="ex-desc" placeholder="Ex : Restaurant du soir" value="${_esc(exp?.desc || '')}">
      </div>

      <div class="fg">
        <label>Montant (€)</label>
        <input type="number" id="ex-amount" min="0" step="0.01" placeholder="0" value="${_esc(exp?.amount ?? '')}">
      </div>

      <div class="fg">
        <label>Cat\xe9gorie</label>
        <select id="ex-cat">${catsOpts}</select>
      </div>

      <div class="fg">
        <label>Pay\xe9 par</label>
        <select id="ex-payer">${payerOptions}</select>
      </div>

      <div class="fg">
        <label>Partag\xe9 avec</label>
        <div id="ex-shared" style="display:flex;flex-direction:column;gap:2px;background:var(--c);border:1.5px solid var(--c3);border-radius:8px;padding:8px 10px">
          ${sharedCheckboxes}
        </div>
        <div style="display:flex;gap:6px;margin-top:5px">
          <button type="button" id="shared-all"  style="background:var(--c2);border:1px solid var(--c3);border-radius:6px;padding:4px 10px;font-size:10px;font-weight:700;cursor:pointer;color:var(--ink3)">Tous</button>
          <button type="button" id="shared-none" style="background:var(--c2);border:1px solid var(--c3);border-radius:6px;padding:4px 10px;font-size:10px;font-weight:700;cursor:pointer;color:var(--ink3)">Aucun</button>
        </div>
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
        <textarea id="ex-note" rows="2" placeholder="Remarque optionnelle...">${_esc(exp?.note || '')}</textarea>
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

    document.getElementById('ex-shared')?.addEventListener('change', ev => {
      const cb = ev.target.closest('[data-shared-id]');
      if (!cb) return;
      const pid = cb.dataset.sharedId;
      if (cb.checked) {
        if (!state.sharedWith.includes(pid)) state.sharedWith.push(pid);
      } else {
        state.sharedWith = state.sharedWith.filter(id => id !== pid);
      }
    });

    document.getElementById('shared-all')?.addEventListener('click', () => {
      state.sharedWith = participants.map(p => p.id);
      document.querySelectorAll('[data-shared-id]').forEach(cb => { cb.checked = true; });
    });

    document.getElementById('shared-none')?.addEventListener('click', () => {
      state.sharedWith = [];
      document.querySelectorAll('[data-shared-id]').forEach(cb => { cb.checked = false; });
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

      if (!desc)          { notify('Veuillez saisir une description', '⚠️'); return; }
      if (amount <= 0)    { notify('Veuillez saisir un montant positif', '⚠️'); return; }
      if (state.sharedWith.length === 0) { notify('S\xe9lectionnez au moins une personne', '⚠️'); return; }

      const freshTrip = getTrip(tripId);
      const newExp    = [...(freshTrip.realExpenses || [])];

      if (isEdit) {
        const idx = newExp.findIndex(ex => ex.id === expId);
        if (idx !== -1) {
          newExp[idx] = {
            ...newExp[idx],
            desc,
            amount,
            catId:      catId  || null,
            paidById:   state.paidById,
            sharedWith: state.sharedWith,
            date,
            dayId:      dayId  || null,
            note,
            receipt:    state.receipt || null,
          };
        }
        notify('D\xe9pense mise \xe0 jour', '✓');
      } else {
        newExp.push({
          id:         'ex_' + uid(),
          desc,
          amount,
          catId:      catId  || null,
          paidById:   state.paidById,
          sharedWith: state.sharedWith,
          date,
          dayId:      dayId  || null,
          note,
          receipt:    state.receipt || null,
        });
        notify('D\xe9pense ajout\xe9e', '✓');
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
