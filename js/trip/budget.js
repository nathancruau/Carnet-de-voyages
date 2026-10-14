/* ============================================================
   CARNET DE VOYAGES — Budget (Prévisionnel) Module
   ============================================================ */

import { getTrip, updateTrip, uid, getEventTypes } from '../store.js';
import { notify, showModal, closeModal, fmtDateShort, customDayTitle } from '../utils.js';

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

function _totalLines(lines) {
  return lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
}

// ── Panel listener registry ───────────────────────────────────────────────────

const _handlers = new WeakMap();

// ── Render ────────────────────────────────────────────────────────────────────

export function renderBudget(tripId) {
  const panel = document.getElementById('panel-budget');
  if (!panel) return;

  let trip = getTrip(tripId);
  if (!trip) return;
  repairDuplicateCatColors(tripId, trip);
  trip = getTrip(tripId); // re-read: repair may have just persisted a fix

  if (_handlers.has(panel)) {
    panel.removeEventListener('click', _handlers.get(panel));
    _handlers.delete(panel);
  }
  // Reset category selection if the stored id doesn't belong to this trip
  if (_selectedCatId && !(trip.budgetCats || []).some(c => c.id === _selectedCatId)) _selectedCatId = null;

  panel.innerHTML = `<div class="tr bdg" id="bd-root">${_budgetHtml(trip)}</div>`;

  const handler = e => _handleClick(e, tripId);
  _handlers.set(panel, handler);
  panel.addEventListener('click', handler);
}

// ── Rendu v2 (v244 — même style que Dépenses partagées : .tr-*) ───────────────

// Dépensé réel (Dépenses partagées), en euros, virements exclus
function _spentByCat(trip) {
  const by = new Map();
  let total = 0;
  for (const e of trip.realExpenses || []) {
    if (e.type === 'transfer') continue;
    const v = Number(e.amountEur ?? e.amount) || 0;
    total += v;
    by.set(e.catId || '', (by.get(e.catId || '') || 0) + v);
  }
  return { by, total };
}

// Coûts saisis sur les activités du planning
function _plannedEvents(trip) {
  const out = [];
  for (const day of trip.days || []) for (const ev of day.items || []) if (Number(ev.cost) > 0) out.push({ day, ev });
  return out;
}

function _catChip(cat) {
  return cat ? `<span class="tr-ic tr-ic-s" style="--cc:${_esc(cat.color || '#0d9488')}">${_esc(cat.icon || '📦')}</span>`
             : `<span class="tr-ic tr-ic-s" style="--cc:#94a3b8">📋</span>`;
}

function _budgetHtml(trip) {
  const cats  = trip.budgetCats  || [];
  const lines = trip.budgetLines || [];
  const evts  = _plannedEvents(trip);
  const spent = _spentByCat(trip);
  const planned = _totalLines(lines);
  const evTotal = evts.reduce((n, o) => n + (Number(o.ev.cost) || 0), 0);
  const pct = planned > 0 ? Math.round(spent.total / planned * 100) : null;

  const hero = `
    <div class="tr-hero">
      <span class="tr-hero-l">Budget prévu</span>
      <b class="tr-hero-v">${_fmtEur(planned)}</b>
      <span class="tr-hero-s">${spent.total > 0 ? `Dépensé : <b class="${pct != null && pct > 100 ? 'neg' : ''}">${_fmtEur(spent.total)}</b>${pct != null ? ` · ${pct} %` : ''}` : 'Rien de dépensé pour l’instant'}</span>
      ${planned > 0 ? `<div class="tr-bil-bar bd-bar"><i class="${pct > 100 ? 'neg' : 'pos'}" style="width:${Math.min(100, pct || 0)}%"></i></div>` : ''}
      ${evTotal > 0 ? `<span class="tr-hero-s">＋ ${_fmtEur(evTotal)} de coûts d’activités dans le planning</span>` : ''}
    </div>
    <div class="tr-actions">
      <button class="pk-btn pk-btn-dark" data-action="add-line">＋ Ligne</button>
      <button class="pk-btn" data-action="add-cat">＋ Catégorie</button>
    </div>`;

  // Par catégorie : prévu vs dépensé ; tap = filtrer les lignes, ✎ = modifier
  const catRows = cats.map(cat => {
    const pl = _catLinesTotal(lines, cat.id);
    const sp = spent.by.get(cat.id) || 0;
    const n  = lines.filter(l => l.catId === cat.id).length;
    const w  = pl > 0 ? Math.min(100, sp / pl * 100) : (sp > 0 ? 100 : 0);
    const on = _selectedCatId === cat.id;
    return `
      <div class="tr-row bd-cat${on ? ' on' : ''}" data-action="select-cat" data-cat-id="${_esc(cat.id)}">
        <span class="tr-ic" style="--cc:${_esc(cat.color || '#0d9488')}">${_esc(cat.icon || '📦')}</span>
        <div class="tr-txt"><b>${_esc(cat.name)}</b>
          <small>${n} ligne${n > 1 ? 's' : ''}${sp > 0 ? ` · ${_fmtEur(sp)} dépensés` : ''}</small>
          <div class="tr-bil-bar"><i class="${pl > 0 && sp > pl ? 'neg' : 'pos'}" style="width:${w}%;${pl > 0 && sp > pl ? '' : `background:${_esc(cat.color || '#22c55e')}`}"></i></div>
        </div>
        <div class="tr-amt">${_fmtEur(pl)}<small>prévu</small></div>
        <button class="bd-edit" data-action="edit-cat" data-cat-id="${_esc(cat.id)}" title="Modifier la catégorie">✎</button>
      </div>`;
  }).join('');

  const selCat = _selectedCatId ? cats.find(c => c.id === _selectedCatId) : null;
  const shown = selCat ? lines.filter(l => l.catId === selCat.id) : lines;
  const days = trip.days || [];
  const lineRows = shown.map(line => {
    const cat = cats.find(c => c.id === line.catId);
    const day = days.find(d => d.id === line.dayId);
    const sub = [cat?.name, day ? `Jour ${day.num}` : '', line.note].filter(Boolean).map(_esc).join(' · ');
    return `
      <button class="tr-row" data-action="edit-line" data-line-id="${_esc(line.id)}">
        ${_catChip(cat)}
        <span class="tr-txt"><b>${_esc(line.desc || '—')}</b>${sub ? `<small>${sub}</small>` : ''}</span>
        <span class="tr-amt">${_fmtEur(line.amount)}</span>
      </button>`;
  }).join('');

  const evShown = selCat ? evts.filter(o => o.ev.catId === selCat.id) : evts;
  const ets = Object.fromEntries(getEventTypes().map(et => [et.key, et]));
  const evRows = evShown.map(({ day, ev }) => {
    const et = ets[ev.type] || {};
    return `
      <div class="tr-row bd-ro">
        <span class="tr-ic tr-ic-s" style="--cc:${_esc(et.color || '#0d9488')}">${et.emoji || '📍'}</span>
        <span class="tr-txt"><b>${_esc(ev.text || '—')}</b><small>Jour ${day.num}${et.label ? ' · ' + _esc(et.label) : ''}</small></span>
        <span class="tr-amt tr-amt-muted">${_fmtEur(ev.cost)}</span>
      </div>`;
  }).join('');

  const filters = cats.length ? `
    <div class="tr-filters">
      <button class="tr-fchip${!selCat ? ' on' : ''}" data-action="select-cat" data-cat-id="">Toutes</button>
      ${cats.map(c => `<button class="tr-fchip${selCat?.id === c.id ? ' on' : ''}" data-action="select-cat" data-cat-id="${_esc(c.id)}"><i>${_esc(c.icon || '📦')}</i>${_esc(c.name)}</button>`).join('')}
    </div>` : '';

  return `
    ${hero}
    ${!selCat && cats.length && planned > 0 ? `<div class="tr-sec">Répartition</div><div class="tr-card">${_renderBudgetDonut(cats, lines, planned)}</div>` : ''}
    <div class="tr-sec">Catégories</div>
    ${cats.length ? `<div class="tr-card">${catRows}</div>`
      : `<div class="tr-card tr-pad bd-empty">Aucune catégorie — ajoutez-en une (Hébergement, Transport…) pour répartir le budget.</div>`}
    ${filters}
    <div class="tr-sec">Lignes du budget${selCat ? ` · ${_esc(selCat.name)}` : ''}</div>
    ${lineRows ? `<div class="tr-card">${lineRows}</div>`
      : `<div class="tr-card tr-pad bd-empty">Aucune ligne${selCat ? ' dans cette catégorie' : ''}. « ＋ Ligne » pour prévoir une dépense.</div>`}
    ${evRows ? `<div class="tr-sec">Coûts des activités (planning)</div><div class="tr-card">${evRows}</div>` : ''}`;
}

// ── Budget donut chart by category ───────────────────────────────────────────

function _renderBudgetDonut(cats, lines, total) {
  const segments = cats
    .map(cat => ({ label: cat.name, icon: cat.icon || '📦', color: cat.color || '#888', value: _catLinesTotal(lines, cat.id) }))
    .filter(s => s.value > 0);
  if (!segments.length || !total) return '';
  const R = 40, cx = 50, cy = 50, circ = 2 * Math.PI * R;
  let offset = 0, arcs = '';
  for (const seg of segments) {
    const dash = (seg.value / total) * circ;
    arcs += `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${_esc(seg.color)}" stroke-width="14"
      stroke-dasharray="${dash.toFixed(2)} ${(circ - dash).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`;
    offset += dash;
  }
  const legend = segments.map(sg => `
    <div class="tr-leg"><i style="background:${_esc(sg.color)}"></i><span>${_esc(sg.icon)} ${_esc(sg.label)}</span>
      <b>${_fmtEur(sg.value)} <small>${Math.round(sg.value / total * 100)} %</small></b></div>`).join('');
  return `
    <div class="tr-donut">
      <div class="tr-donut-svg"><svg viewBox="0 0 100 100"><circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="var(--hv-chip)" stroke-width="14"/>${arcs}</svg>
        <div>${_fmtEur(total)}</div></div>
      <div class="tr-legs">${legend}</div>
    </div>`;
}

// ── Event delegation ──────────────────────────────────────────────────────────

function _handleClick(e, tripId) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === 'select-cat') {
    const catId = btn.dataset.catId || null;
    _selectedCatId = catId && catId !== _selectedCatId ? catId : (btn.classList.contains('tr-fchip') ? catId : null);
    _refresh(tripId);
  } else if (action === 'add-line') {
    _openLineModal(tripId, null);
  } else if (action === 'edit-line') {
    _openLineModal(tripId, btn.dataset.lineId);
  } else if (action === 'add-cat') {
    _openCatModal(tripId, null);
  } else if (action === 'edit-cat') {
    e.stopPropagation();
    _openCatModal(tripId, btn.dataset.catId);
  }
}

function _refresh(tripId) {
  const trip = getTrip(tripId);
  const root = document.getElementById('bd-root');
  if (!trip || !root) return;
  if (_selectedCatId && !(trip.budgetCats || []).some(c => c.id === _selectedCatId)) _selectedCatId = null;
  root.innerHTML = _budgetHtml(trip);
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
      `<option value="${_esc(d.id)}"${line?.dayId === d.id ? ' selected' : ''}>Jour ${d.num}${customDayTitle(d) ? ' · ' + _esc(customDayTitle(d)) : ''}${d.date ? ' (' + fmtDateShort(d.date) + ')' : ''}</option>`
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
      ${isEdit ? `<button class="bc" id="bl-delete" style="color:var(--coral)">🗑 Supprimer</button>` : ''}
      <button class="bs" id="bl-save">Enregistrer</button>
    </div>
  `);

  if (isEdit) {
    document.getElementById('bl-delete')?.addEventListener('click', () => {
      if (confirm('Supprimer cette ligne budgétaire ?')) {
        const freshTrip = getTrip(tripId);
        updateTrip(tripId, {
          budgetLines: (freshTrip.budgetLines || []).filter(l => l.id !== lineId)
        });
        notify('Ligne supprimée', '🗑');
        closeModal();
        _refresh(tripId);
      }
    });
  }

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

    // Reverse sync: if this line came from an event, update the event's cost/title too.
    // Deep-copy days before mutating to avoid dirtying the live store reference
    // before the write is persisted.
    if (isEdit) {
      const updLine = newLines.find(l => l.id === lineId);
      if (updLine?.source === 'event' && updLine?.eventId) {
        const syncTrip = getTrip(tripId);
        if (syncTrip) {
          let changed = false;
          const syncDays = (syncTrip.days || []).map(day => {
            const evtIdx = (day.items || []).findIndex(it => it.id === updLine.eventId);
            if (evtIdx === -1) return day;
            changed = true;
            const items = [...day.items];
            items[evtIdx] = { ...items[evtIdx], cost: amount, text: desc };
            return { ...day, items };
          });
          if (changed) updateTrip(tripId, { days: syncDays });
        }
      }
    }

    closeModal();
    _refresh(tripId);
  });
}

// ── Add/Edit Category Modal ───────────────────────────────────────────────────

export const CAT_COLORS = ['#0d9488','#7c3aed','#e85d3e','#d97706','#db2777','#0284c7','#16a34a','#f59e0b'];

/**
 * Reassign any budget category sharing its color with an earlier one to the
 * next unused palette color, persisting the fix once if anything changed.
 * Repairs trips created before _openCatModal's selColor started avoiding
 * collisions below: every category added without manually picking a swatch
 * used to default to the exact same first palette color, which made
 * Tricount's "Répartition par catégorie" donut show several categories as
 * one indistinguishable slice. Called once per render from both budget.js
 * and tricount.js, since they share the same trip.budgetCats.
 */
export function repairDuplicateCatColors(tripId, trip) {
  const cats = trip.budgetCats || [];
  if (cats.length < 2) return;
  const used = new Set();
  let changed = false;
  const fixed = cats.map(cat => {
    if (!used.has(cat.color)) { used.add(cat.color); return cat; }
    const next = CAT_COLORS.find(c => !used.has(c));
    if (!next) return cat; // palette exhausted — leave the collision rather than reuse a color
    used.add(next);
    changed = true;
    return { ...cat, color: next };
  });
  if (changed) updateTrip(tripId, { budgetCats: fixed });
}
const _CAT_ICONS  = ['🚗','🏨','🍽️','🎯','🛍️','💡','✈️','🎪','🏖️','🎵','📸','🏃','🚢','🌿'];

function _openCatModal(tripId, catId) {
  const trip   = getTrip(tripId);
  const cats   = trip.budgetCats || [];
  const isEdit = !!catId;
  const cat    = isEdit ? cats.find(c => c.id === catId) : null;

  // For a new category, default to the first palette color not already used
  // by an existing one — always falling back to CAT_COLORS[0] regardless of
  // how many categories existed meant every category added without manually
  // picking a different swatch ended up the exact same color, which is
  // exactly what made the Tricount "Répartition par catégorie" donut show
  // several categories sharing one indistinguishable color/slice.
  let selColor = cat?.color
    || CAT_COLORS.find(c => !cats.some(existing => existing.color === c))
    || CAT_COLORS[0];
  let selIcon  = cat?.icon  || '📦';

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
          ${CAT_COLORS.map(c =>
            `<div class="col-o${selColor === c ? ' sel' : ''}" style="background:${c}" data-bc-color="${c}"></div>`
          ).join('')}
        </div>
      </div>

      <div class="ma">
        <button class="bc" onclick="closeModal()">Annuler</button>
        ${isEdit ? `<button class="bd" id="bc-delete">Supprimer</button>` : ''}
        <button class="bs" id="bc-save">Enregistrer</button>
      </div>`;
  }

  let typedName = null;   // nom saisi, gardé quand on change d'icône/couleur (v247)
  function reRender() {
    const mbox = document.querySelector('.mbox');
    if (mbox) {
      typedName = document.getElementById('bc-name')?.value ?? typedName;
      mbox.innerHTML = buildHtml();
      const nm = document.getElementById('bc-name');
      if (nm && typedName != null) nm.value = typedName;
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
        closeModal();
        _refresh(tripId);
      }
    });

    document.getElementById('bc-save')?.addEventListener('click', () => {
      const name = document.getElementById('bc-name')?.value?.trim() || '';

      if (!name) { notify('Veuillez saisir un nom', '⚠️'); return; }

      const ft      = getTrip(tripId);
      const newCats = [...(ft.budgetCats || [])];

      if (isEdit) {
        const idx = newCats.findIndex(c => c.id === catId);
        if (idx !== -1) {
          newCats[idx] = { ...newCats[idx], name, icon: selIcon, color: selColor };
        }
        notify('Catégorie mise à jour', '✓');
      } else {
        newCats.push({ id: 'bc_' + uid(), name, icon: selIcon, color: selColor });
        notify('Catégorie ajoutée', '✓');
      }

      updateTrip(tripId, { budgetCats: newCats });
      closeModal();
      _refresh(tripId);
    });
  }

  showModal(buildHtml());
  attachEvents();
}
