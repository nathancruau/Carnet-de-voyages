/* ============================================================
   CARNET DE VOYAGES — Budget (Prévisionnel) Module
   ============================================================ */

import { getTrip, updateTrip, uid } from '../store.js';
import { notify, showModal, closeModal, fmtDateShort } from '../utils.js';
import { updateTopStats } from './trip.js';

// ── Module state ──────────────────────────────────────────────────────────────

let _selectedCatId = null; // null = vue globale

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
  return n.toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' €';
}

function _catLinesTotal(lines, catId) {
  return lines
    .filter(l => l.catId === catId)
    .reduce((s, l) => s + (Number(l.amount) || 0), 0);
}

function _totalPlanned(cats) {
  return cats.reduce((s, c) => s + (Number(c.planned) || 0), 0);
}

function _totalLines(lines) {
  return lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
}

// ── Panel listener registry ───────────────────────────────────────────────────

const _handlers = new WeakMap();

// ── Render ────────────────────────────────────────────────────────────────────

export function renderBudget(tripId) {
  const panel = document.getElementById('panel-budget');
  if (!panel) return;

  const trip = getTrip(tripId);
  if (!trip) return;

  if (_handlers.has(panel)) {
    panel.removeEventListener('click', _handlers.get(panel));
    _handlers.delete(panel);
  }

  const cats  = trip.budgetCats  || [];
  const lines = trip.budgetLines || [];

  panel.innerHTML = `
    <div class="bud-layout">
      <div class="bud-side">
        <div class="bud-side-sc" id="bud-side-content">
          ${_renderSide(cats, lines)}
        </div>
      </div>
      <div class="bud-main" id="bud-main-content">
        ${_renderMain(trip, cats, lines)}
      </div>
    </div>`;

  const handler = e => _handleClick(e, tripId);
  _handlers.set(panel, handler);
  panel.addEventListener('click', handler);
}

// ── Side panel ────────────────────────────────────────────────────────────────

function _renderSide(cats, lines) {
  const totalPlanned = _totalPlanned(cats);

  const globalActive = _selectedCatId === null;
  let html = `
    <div class="glob-btn${globalActive ? ' active' : ''}" data-action="select-cat" data-cat-id="">
      <span style="font-size:15px">💰</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:11px;font-weight:700;color:var(--ink)">Vue globale</div>
        <div class="ci-cnt">${_fmtEur(totalPlanned)} prévu</div>
      </div>
    </div>
    <div class="bs-lbl" style="padding:8px 2px 4px">Catégories</div>`;

  for (const cat of cats) {
    const planned  = Number(cat.planned) || 0;
    const spent    = _catLinesTotal(lines, cat.id);
    const pct      = totalPlanned > 0 ? Math.min(100, Math.round((planned / totalPlanned) * 100)) : 0;
    const linesCnt = lines.filter(l => l.catId === cat.id).length;
    const isActive = _selectedCatId === cat.id;

    html += `
      <div class="cat-item${isActive ? ' active' : ''}" data-action="select-cat" data-cat-id="${_esc(cat.id)}">
        <div class="ci-ic">${_esc(cat.icon || '📦')}</div>
        <div class="ci-info">
          <div class="ci-nm">${_esc(cat.name)}</div>
          <div class="ci-cnt">${linesCnt} ligne${linesCnt !== 1 ? 's' : ''} · ${_fmtEur(spent)}</div>
          <div class="ci-bar"><div class="ci-fill" style="width:${pct}%;background:${_esc(cat.color || '#0d9488')}"></div></div>
        </div>
        <div class="ci-amt">${_fmtEur(planned)}</div>
      </div>`;
  }

  html += `
    <div class="add-cat-row">
      <button class="btn-new" style="width:100%;justify-content:center;font-size:11px" data-action="add-cat">＋ Nouvelle catégorie</button>
    </div>`;

  return html;
}

// ── Main panel ────────────────────────────────────────────────────────────────

function _renderMain(trip, cats, lines) {
  const selCat     = _selectedCatId ? cats.find(c => c.id === _selectedCatId) : null;
  const filteredLines = _selectedCatId
    ? lines.filter(l => l.catId === _selectedCatId)
    : lines;

  const totalPlanned = selCat ? (Number(selCat.planned) || 0) : _totalPlanned(cats);

  // Sum costs from planning events
  const days = trip.days || [];
  const planningCostItems = [];
  for (const day of days) {
    for (const ev of (day.items || [])) {
      if (Number(ev.cost) > 0) {
        if (!selCat || ev.catId === selCat.id) {
          planningCostItems.push(ev);
        }
      }
    }
  }
  const totalPlannedCosts = planningCostItems.reduce((s, ev) => s + (Number(ev.cost) || 0), 0);

  let html = `
    <div class="bud-section-hd">
      <h3>${selCat ? _esc(selCat.icon + ' ' + selCat.name) : '💰 Budget prévisionnel'}</h3>
      <button class="btn-new" data-action="add-line">＋ Ajouter une ligne</button>
    </div>

    <div class="bud-summary-cards">
      <div class="bud-sm-card">
        <div class="bud-sm-v">${_fmtEur(totalPlanned)}</div>
        <div class="bud-sm-l">Budget prévu</div>
      </div>
      <div class="bud-sm-card">
        <div class="bud-sm-v" style="color:var(--teal)">${_fmtEur(totalPlannedCosts)}</div>
        <div class="bud-sm-l">Dépenses planifiées</div>
      </div>
    </div>`;

  // Donut chart only on global view when there are categories with planned amounts
  if (!selCat && cats.length > 0 && _totalPlanned(cats) > 0) {
    html += _renderDonut(cats, lines);
  }

  // Bar chart of real expenses by category (global view only)
  if (!selCat) {
    const realExpenses = trip.realExpenses || [];
    if (realExpenses.length > 0) {
      html += `<h4 style="margin:20px 0 6px;font-size:13px;font-weight:700;color:var(--ink)">💳 Dépenses réelles par catégorie</h4>`;
      html += _renderRealExpensesBarChart(trip, cats, realExpenses);
    }
  }

  // Planned costs from trip days (read-only)
  const daysCostHtml = _renderDaysCosts(trip, cats, selCat);
  if (daysCostHtml) html += daysCostHtml;

  // Budget lines table
  html += `<h4 style="margin:20px 0 6px;font-size:13px;font-weight:700;color:var(--ink)">📋 Lignes budgétaires manuelles</h4>`;
  html += _renderLinesTable(trip, cats, filteredLines);

  return html;
}

// ── Donut chart ───────────────────────────────────────────────────────────────

function _renderDonut(cats, lines) {
  const catsWithPlanned = cats.filter(c => Number(c.planned) > 0);
  if (catsWithPlanned.length === 0) return '';

  const total   = _totalPlanned(catsWithPlanned);
  const radius  = 54;
  const cx      = 70;
  const cy      = 70;
  const circum  = 2 * Math.PI * radius;

  let offset = 0;
  let circles = '';
  let legendItems = '';

  for (const cat of catsWithPlanned) {
    const planned = Number(cat.planned) || 0;
    const pct     = planned / total;
    const dash    = pct * circum;
    const gap     = circum - dash;
    const rotation = -90 + (offset / total) * 360;

    circles += `<circle
      cx="${cx}" cy="${cy}" r="${radius}"
      fill="none"
      stroke="${_esc(cat.color || '#0d9488')}"
      stroke-width="18"
      stroke-dasharray="${dash.toFixed(2)} ${gap.toFixed(2)}"
      transform="rotate(${rotation.toFixed(2)} ${cx} ${cy})"
      style="cursor:pointer"
      data-action="select-cat"
      data-cat-id="${_esc(cat.id)}"
      title="${_esc(cat.name + ' : ' + _fmtEur(planned))}">
    </circle>`;

    legendItems += `
      <div class="dl-it" style="cursor:pointer" data-action="select-cat" data-cat-id="${_esc(cat.id)}">
        <div class="dl-dot" style="background:${_esc(cat.color || '#0d9488')}"></div>
        <span style="flex:1;color:var(--ink2)">${_esc(cat.name)}</span>
        <span style="font-weight:700;color:var(--ink)">${_fmtEur(planned)}</span>
      </div>`;

    offset += planned;
  }

  const totalLines = _totalLines(lines);

  return `
    <div class="donut-row">
      <div class="donut-wrap">
        <svg width="140" height="140" viewBox="0 0 140 140">
          <circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="var(--c3)" stroke-width="18"/>
          ${circles}
        </svg>
        <div class="donut-cnt">
          <div class="dc-v">${_fmtEur(total)}</div>
          <div class="dc-l">Prévu</div>
        </div>
      </div>
      <div class="dl-grid" style="flex:1;min-width:160px">${legendItems}</div>
    </div>`;
}

// ── Real expenses bar chart by category ──────────────────────────────────────

function _renderRealExpensesBarChart(trip, cats, realExpenses) {
  if (cats.length === 0 || realExpenses.length === 0) return '';

  // Sum real expenses by category
  const spentByCat = {};
  for (const exp of realExpenses) {
    if (exp.catId) {
      spentByCat[exp.catId] = (spentByCat[exp.catId] || 0) + (Number(exp.amount) || 0);
    }
  }

  // Only show cats that have real expenses
  const activeCats = cats.filter(c => spentByCat[c.id] > 0);
  if (activeCats.length === 0) return '';

  const maxSpent = Math.max(...activeCats.map(c => spentByCat[c.id] || 0));

  let bars = '';
  for (const cat of activeCats) {
    const spent      = spentByCat[cat.id] || 0;
    const planned    = Number(cat.planned) || 0;
    const pct        = maxSpent > 0 ? Math.round((spent / maxSpent) * 100) : 0;
    const overBudget = planned > 0 && spent > planned;
    const barColor   = overBudget ? 'var(--coral)' : (cat.color || '#0d9488');

    bars += `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
        <div style="width:28px;text-align:center;font-size:15px">${_esc(cat.icon || '📦')}</div>
        <div style="width:90px;font-size:11px;font-weight:600;color:var(--ink2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_esc(cat.name)}</div>
        <div style="flex:1;background:var(--c3);border-radius:4px;height:12px;overflow:hidden">
          <div style="width:${pct}%;height:100%;background:${barColor};border-radius:4px;transition:width .3s"></div>
        </div>
        <div style="width:80px;text-align:right;font-size:11px;font-weight:700;color:${overBudget ? 'var(--coral)' : 'var(--ink)'}">
          ${_fmtEur(spent)}${planned > 0 ? `<span style="font-weight:400;color:var(--ink4)"> / ${_fmtEur(planned)}</span>` : ''}
        </div>
      </div>`;
  }

  return `
    <div style="background:var(--c);border:1.5px solid var(--c3);border-radius:10px;padding:14px 16px;margin-bottom:4px">
      ${bars}
    </div>`;
}

// ── Days costs (read-only, from planning) ─────────────────────────────────────

function _renderDaysCosts(trip, cats, selCat) {
  const days = trip.days || [];

  // Collect all events across all days that have a cost > 0
  const costItems = [];
  for (const day of days) {
    for (const ev of (day.items || [])) {
      if (Number(ev.cost) > 0) {
        costItems.push({ day, ev });
      }
    }
  }

  if (costItems.length === 0) return '';

  // If in category view, filter by catId if event has one; show all costs in global view
  const filtered = selCat
    ? costItems.filter(({ ev }) => ev.catId === selCat.id)
    : costItems;

  if (filtered.length === 0) return '';

  // Group by day
  const byDay = new Map();
  for (const { day, ev } of filtered) {
    if (!byDay.has(day.id)) byDay.set(day.id, { day, events: [] });
    byDay.get(day.id).events.push(ev);
  }

  const totalCost = filtered.reduce((s, { ev }) => s + (Number(ev.cost) || 0), 0);

  let rows = '';
  for (const { day, events } of byDay.values()) {
    for (const ev of events) {
      const cat = cats.find(c => c.id === ev.catId);
      const catHtml = cat
        ? `<span style="font-size:9px;font-weight:800;padding:2px 7px;border-radius:999px;background:${_esc(cat.color || '#0d9488')}22;color:${_esc(cat.color || '#0d9488')};border:1px solid ${_esc(cat.color || '#0d9488')}44">${_esc(cat.icon || '')} ${_esc(cat.name)}</span>`
        : '';
      rows += `
        <tr>
          <td>
            <div style="font-size:12px;font-weight:600;color:var(--ink)">${_esc(ev.title || ev.name || '—')}</div>
            ${ev.note ? `<div style="font-size:10px;color:var(--ink4);margin-top:2px">${_esc(ev.note)}</div>` : ''}
          </td>
          <td>${catHtml}</td>
          <td style="font-weight:700;color:var(--ink)">${_fmtEur(ev.cost)}</td>
          <td><span style="font-size:10px;color:var(--ink4)">Jour ${day.num}</span></td>
        </tr>`;
    }
  }

  return `
    <div style="margin-bottom:4px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <div style="font-size:12px;font-weight:700;color:var(--ink2)">Dépenses planifiées (depuis planning)</div>
        <div style="font-size:11px;font-weight:700;color:var(--teal)">${_fmtEur(totalCost)}</div>
      </div>
      <table class="exp-table" style="opacity:.9">
        <thead>
          <tr>
            <th>Événement</th>
            <th>Catégorie</th>
            <th>Coût estimé</th>
            <th>Jour</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ── Lines table ───────────────────────────────────────────────────────────────

function _renderLinesTable(trip, cats, filteredLines) {
  const days = trip.days || [];

  if (filteredLines.length === 0) {
    return `
      <div style="text-align:center;padding:40px 20px;color:var(--ink4)">
        <div style="font-size:32px;margin-bottom:10px">📋</div>
        <div style="font-size:13px">Aucune ligne budgétaire</div>
        <div style="font-size:11px;margin-top:4px">Cliquez sur «&nbsp;Ajouter une ligne&nbsp;» pour commencer</div>
      </div>`;
  }

  let rows = '';
  for (const line of filteredLines) {
    const cat    = cats.find(c => c.id === line.catId);
    const day    = days.find(d => d.id === line.dayId);
    const catHtml = cat
      ? `<span style="font-size:9px;font-weight:800;padding:2px 7px;border-radius:999px;background:${_esc(cat.color || '#0d9488')}22;color:${_esc(cat.color || '#0d9488')};border:1px solid ${_esc(cat.color || '#0d9488')}44">${_esc(cat.icon || '')} ${_esc(cat.name)}</span>`
      : '—';
    const dayHtml = day
      ? `<span style="font-size:10px;color:var(--ink4)">Jour ${day.num}</span>`
      : '';

    rows += `
      <tr>
        <td>
          <div style="font-size:12px;font-weight:600;color:var(--ink)">${_esc(line.desc || '—')}</div>
          ${line.note ? `<div style="font-size:10px;color:var(--ink4);margin-top:2px">${_esc(line.note)}</div>` : ''}
        </td>
        <td>${catHtml}</td>
        <td style="font-weight:700;color:var(--ink)">${_fmtEur(line.amount)}</td>
        <td>${dayHtml}</td>
        <td>
          <div style="display:flex;gap:4px">
            <button class="tc-edit-btn" data-action="edit-line" data-line-id="${_esc(line.id)}" title="Modifier">✏️</button>
            <button class="tc-edit-btn" data-action="delete-line" data-line-id="${_esc(line.id)}" title="Supprimer" style="color:var(--coral)">🗑</button>
          </div>
        </td>
      </tr>`;
  }

  return `
    <table class="exp-table">
      <thead>
        <tr>
          <th>Description</th>
          <th>Catégorie</th>
          <th>Montant</th>
          <th>Jour</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ── Event delegation ──────────────────────────────────────────────────────────

function _handleClick(e, tripId) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;

  const action = btn.dataset.action;

  if (action === 'select-cat') {
    const catId = btn.dataset.catId || null;
    _selectedCatId = catId || null;
    _refresh(tripId);

  } else if (action === 'add-line') {
    _openLineModal(tripId, null);

  } else if (action === 'edit-line') {
    _openLineModal(tripId, btn.dataset.lineId);

  } else if (action === 'delete-line') {
    const lineId = btn.dataset.lineId;
    if (confirm('Supprimer cette ligne budgétaire ?')) {
      const trip = getTrip(tripId);
      updateTrip(tripId, {
        budgetLines: (trip.budgetLines || []).filter(l => l.id !== lineId)
      });
      notify('Ligne supprimée', '🗑');
      updateTopStats(tripId);
      _refresh(tripId);
    }

  } else if (action === 'add-cat') {
    _openCatModal(tripId, null);

  } else if (action === 'edit-cat') {
    _openCatModal(tripId, btn.dataset.catId);

  } else if (action === 'delete-cat') {
    const catId = btn.dataset.catId;
    if (confirm('Supprimer cette catégorie et toutes ses lignes ?')) {
      const trip = getTrip(tripId);
      updateTrip(tripId, {
        budgetCats:  (trip.budgetCats  || []).filter(c => c.id !== catId),
        budgetLines: (trip.budgetLines || []).filter(l => l.catId !== catId),
      });
      if (_selectedCatId === catId) _selectedCatId = null;
      notify('Catégorie supprimée', '🗑');
      updateTopStats(tripId);
      _refresh(tripId);
    }
  }
}

function _refresh(tripId) {
  const trip = getTrip(tripId);
  if (!trip) return;

  const cats  = trip.budgetCats  || [];
  const lines = trip.budgetLines || [];

  const sideEl = document.getElementById('bud-side-content');
  const mainEl = document.getElementById('bud-main-content');
  if (sideEl) sideEl.innerHTML = _renderSide(cats, lines);
  if (mainEl) mainEl.innerHTML = _renderMain(trip, cats, lines);
}

// ── Add/Edit Line Modal ───────────────────────────────────────────────────────

function _openLineModal(tripId, lineId) {
  const trip = getTrip(tripId);
  if (!trip) return;

  const cats  = trip.budgetCats  || [];
  const lines = trip.budgetLines || [];
  const days  = trip.days        || [];
  const isEdit = !!lineId;
  const line  = isEdit ? lines.find(l => l.id === lineId) : null;

  const defaultCatId = _selectedCatId || (cats[0]?.id || '');

  const catsOpts = cats.map(c =>
    `<option value="${_esc(c.id)}"${(line?.catId || defaultCatId) === c.id ? ' selected' : ''}>${_esc(c.icon + ' ' + c.name)}</option>`
  ).join('');

  const daysOpts = `<option value="">Aucun jour</option>` +
    days.map(d =>
      `<option value="${_esc(d.id)}"${line?.dayId === d.id ? ' selected' : ''}>Jour ${d.num}${d.title ? ' · ' + _esc(d.title) : ''}${d.date ? ' (' + fmtDateShort(d.date) + ')' : ''}</option>`
    ).join('');

  showModal(`
    <button class="mc" onclick="closeModal()">✕</button>
    <h3>${isEdit ? '✏️ Modifier la ligne' : '＋ Nouvelle ligne budgétaire'}</h3>

    <div class="fg">
      <label>Catégorie</label>
      <select id="bl-cat">${catsOpts}</select>
    </div>

    <div class="fg">
      <label>Description</label>
      <input type="text" id="bl-desc" placeholder="Ex : Billet d'avion Paris–Tokyo" value="${_esc(line?.desc || '')}">
    </div>

    <div class="fg">
      <label>Montant (€)</label>
      <input type="number" id="bl-amount" min="0" step="0.01" placeholder="0" value="${_esc(line?.amount ?? '')}">
    </div>

    <div class="fg">
      <label>Note</label>
      <input type="text" id="bl-note" placeholder="Remarque optionnelle" value="${_esc(line?.note || '')}">
    </div>

    <div class="fg">
      <label>Jour du voyage (optionnel)</label>
      <select id="bl-day">${daysOpts}</select>
    </div>

    <div class="ma">
      <button class="bc" onclick="closeModal()">Annuler</button>
      <button class="bs" id="bl-save">Enregistrer</button>
    </div>
  `);

  document.getElementById('bl-save')?.addEventListener('click', () => {
    const catId  = document.getElementById('bl-cat')?.value    || '';
    const desc   = document.getElementById('bl-desc')?.value?.trim() || '';
    const amount = parseFloat(document.getElementById('bl-amount')?.value || '0') || 0;
    const note   = document.getElementById('bl-note')?.value?.trim() || '';
    const dayId  = document.getElementById('bl-day')?.value    || null;

    if (!desc) { notify('Veuillez saisir une description', '⚠️'); return; }

    const freshTrip = getTrip(tripId);
    const newLines  = [...(freshTrip.budgetLines || [])];

    if (isEdit) {
      const idx = newLines.findIndex(l => l.id === lineId);
      if (idx !== -1) {
        newLines[idx] = { ...newLines[idx], catId, desc, amount, note, dayId: dayId || null };
      }
      notify('Ligne mise à jour', '✓');
    } else {
      newLines.push({ id: 'bl_' + uid(), catId, desc, amount, note, dayId: dayId || null });
      notify('Ligne ajoutée', '✓');
    }

    updateTrip(tripId, { budgetLines: newLines });

    // Reverse sync: if this line came from an event, update the event's cost too
    if (isEdit) {
      const updLine = newLines.find(l => l.id === lineId);
      if (updLine?.source === 'event' && updLine?.eventId) {
        const syncTrip = getTrip(tripId);
        if (syncTrip) {
          const syncDays = syncTrip.days || [];
          for (const day of syncDays) {
            const evt = (day.items || []).find(it => it.id === updLine.eventId);
            if (evt) { evt.cost = amount; evt.text = desc; break; }
          }
          updateTrip(tripId, { days: syncDays });
        }
      }
    }

    updateTopStats(tripId);
    closeModal();
    _refresh(tripId);
  });
}

// ── Add/Edit Category Modal ───────────────────────────────────────────────────

const _CAT_COLORS = ['#0d9488','#7c3aed','#e85d3e','#d97706','#db2777','#0284c7','#16a34a','#f59e0b'];
const _CAT_ICONS  = ['🚗','🏨','🍽️','🎯','🛍️','💡','✈️','🎪','🏖️','🎵','📸','🏃','🚢','🌿'];

function _openCatModal(tripId, catId) {
  const trip   = getTrip(tripId);
  const cats   = trip.budgetCats || [];
  const isEdit = !!catId;
  const cat    = isEdit ? cats.find(c => c.id === catId) : null;

  let selColor   = cat?.color   || _CAT_COLORS[0];
  let selIcon    = cat?.icon    || '📦';
  let selPlanned = Number(cat?.planned ?? 0);

  function buildHtml() {
    return `
      <button class="mc" onclick="closeModal()">✕</button>
      <h3>${isEdit ? '✏️ Modifier la catégorie' : '＋ Nouvelle catégorie'}</h3>

      <div class="fg">
        <label>Nom</label>
        <input type="text" id="bc-name" placeholder="Ex : Transport" value="${_esc(cat?.name || '')}">
      </div>

      <div class="fg">
        <label>Icône</label>
        <div style="display:flex;gap:5px;flex-wrap:wrap" id="bc-icons">
          ${_CAT_ICONS.map(ic =>
            `<button type="button" data-bc-icon="${ic}"
              style="font-size:18px;padding:5px 7px;border-radius:7px;cursor:pointer;background:${selIcon === ic ? 'var(--tl)' : 'var(--c2)'};border:1.5px solid ${selIcon === ic ? 'var(--teal)' : 'var(--c3)'}">${ic}</button>`
          ).join('')}
        </div>
      </div>

      <div class="fg">
        <label>Couleur</label>
        <div class="col-opts" id="bc-colors">
          ${_CAT_COLORS.map(c =>
            `<div class="col-o${selColor === c ? ' sel' : ''}" style="background:${c}" data-bc-color="${c}"></div>`
          ).join('')}
        </div>
      </div>

      <div class="fg">
        <label>Budget alloué (€)</label>
        <input type="number" id="bc-planned" min="0" step="0.01" placeholder="0" value="${_esc(selPlanned || '')}">
      </div>

      <div class="ma">
        <button class="bc" onclick="closeModal()">Annuler</button>
        ${isEdit ? `<button class="bd" id="bc-delete">Supprimer</button>` : ''}
        <button class="bs" id="bc-save">Enregistrer</button>
      </div>`;
  }

  function reRender() {
    const mbox = document.querySelector('.mbox');
    if (mbox) {
      const inp = document.getElementById('bc-planned');
      if (inp) selPlanned = parseFloat(inp.value || '0') || 0;
      mbox.innerHTML = buildHtml();
      attachEvents();
    }
  }

  function attachEvents() {
    document.getElementById('bc-icons')?.addEventListener('click', ev => {
      const btn = ev.target.closest('[data-bc-icon]');
      if (!btn) return;
      selIcon = btn.dataset.bcIcon;
      reRender();
    });

    document.getElementById('bc-colors')?.addEventListener('click', ev => {
      const sw = ev.target.closest('[data-bc-color]');
      if (!sw) return;
      selColor = sw.dataset.bcColor;
      reRender();
    });

    document.getElementById('bc-delete')?.addEventListener('click', () => {
      if (confirm('Supprimer cette catégorie et toutes ses lignes ?')) {
        const ft = getTrip(tripId);
        updateTrip(tripId, {
          budgetCats:  (ft.budgetCats  || []).filter(c => c.id !== catId),
          budgetLines: (ft.budgetLines || []).filter(l => l.catId !== catId),
        });
        if (_selectedCatId === catId) _selectedCatId = null;
        notify('Catégorie supprimée', '🗑');
        updateTopStats(tripId);
        closeModal();
        _refresh(tripId);
      }
    });

    document.getElementById('bc-save')?.addEventListener('click', () => {
      const name    = document.getElementById('bc-name')?.value?.trim() || '';
      const planned = parseFloat(document.getElementById('bc-planned')?.value || '0') || 0;

      if (!name) { notify('Veuillez saisir un nom', '⚠️'); return; }

      const ft   = getTrip(tripId);
      const newCats = [...(ft.budgetCats || [])];

      if (isEdit) {
        const idx = newCats.findIndex(c => c.id === catId);
        if (idx !== -1) {
          newCats[idx] = { ...newCats[idx], name, icon: selIcon, color: selColor, planned };
        }
        notify('Catégorie mise à jour', '✓');
      } else {
        newCats.push({ id: 'bc_' + uid(), name, icon: selIcon, color: selColor, planned });
        notify('Catégorie ajoutée', '✓');
      }

      updateTrip(tripId, { budgetCats: newCats });
      updateTopStats(tripId);
      closeModal();
      _refresh(tripId);
    });
  }

  showModal(buildHtml());
  attachEvents();
}
