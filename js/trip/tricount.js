/* ============================================================
   CARNET DE VOYAGES — Tricount (Budget Réel) Module
   ============================================================ */

import { getTrip, updateTrip, uid } from '../store.js';
import { notify, showModal, closeModal, fmtDateShort } from '../utils.js';
import { updateTopStats } from './trip.js';

// ── Module state ──────────────────────────────────────────────────────────────

let _activeTab = 'depenses'; // 'depenses' | 'bilans'

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

  if (!trip.companions || trip.companions.length === 0) {
    panel.innerHTML = `
      <div class="tri-layout" style="align-items:center;justify-content:center">
        <div class="no-participants">
          <div style="font-size:40px;margin-bottom:14px">&#x1F465;</div>
          <div style="font-size:13px;font-weight:700;color:var(--ink2);margin-bottom:8px">Aucun participant</div>
          <div style="font-size:12px;color:var(--ink4);max-width:340px;line-height:1.6">
            Ajoutez des participants dans les param&egrave;tres du voyage (ic&ocirc;ne &#x270F; sur la carte du voyage) pour utiliser le partage de d&eacute;penses.
          </div>
        </div>
      </div>`;

    const handler = e => _handleClick(e, tripId);
    _handlers.set(panel, handler);
    panel.addEventListener('click', handler);
    return;
  }

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
  const depensesActive = _activeTab === 'depenses';

  const tabs = `
    <div style="display:flex;gap:3px;background:var(--c2);border-radius:8px;padding:3px;border:1px solid var(--c3);margin-bottom:16px;width:fit-content">
      <div data-action="switch-tab" data-tab="depenses"
        style="padding:5px 16px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;
               background:${depensesActive ? '#fff' : 'transparent'};
               color:${depensesActive ? 'var(--teal)' : 'var(--ink3)'};
               box-shadow:${depensesActive ? 'var(--sh)' : 'none'};transition:all .15s">
        D&eacute;penses
      </div>
      <div data-action="switch-tab" data-tab="bilans"
        style="padding:5px 16px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;
               background:${!depensesActive ? '#fff' : 'transparent'};
               color:${!depensesActive ? 'var(--teal)' : 'var(--ink3)'};
               box-shadow:${!depensesActive ? 'var(--sh)' : 'none'};transition:all .15s">
        Bilans
      </div>
    </div>`;

  const content = depensesActive
    ? _renderDepenses(trip, participants)
    : _renderBilans(trip, participants, balances, settlements);

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

  // Budget vs real comparison
  const comparisonHtml = _renderBudgetComparison(trip, totalSpent);

  // Category bar chart
  const barChartHtml = _renderCatBarChart(trip, expenses);

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
    ${barChartHtml}
    ${comparisonHtml}`;
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
      <div class="balance-card">
        <div class="bc-name">${_esc(p.name)}</div>
        <div class="bc-amt ${balClass}">${display}</div>
        <div class="bc-label">${label}</div>
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
  };

  function buildHtml() {
    const catsOpts = `<option value="">Aucune cat\xe9gorie</option>` +
      cats.map(c =>
        `<option value="${_esc(c.id)}"${exp?.catId === c.id ? ' selected' : ''}>${_esc(c.icon + ' ' + c.name)}</option>`
      ).join('');

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
