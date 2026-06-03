/* ============================================================
   CARNET DE VOYAGES — Packing list (bagages)
   ============================================================ */

import { getTrip, updateTrip, uid } from '../store.js';
import { notify, showModal, closeModal, colorOptsHtml } from '../utils.js';

// ── Panel listener registry (prevent accumulation) ────────────────────────────
const _handlers = new WeakMap();

// ── Public entry ───────────────────────────────────────────────────────────────

export function renderPacking(tripId) {
  const panel = document.getElementById('panel-packing');
  if (!panel) return;

  const trip = getTrip(tripId);
  if (!trip) return;

  if (_handlers.has(panel)) {
    panel.removeEventListener('click', _handlers.get(panel));
    _handlers.delete(panel);
  }

  panel.innerHTML = _buildHtml(trip);

  const handler = e => _handleClick(e, tripId);
  _handlers.set(panel, handler);
  panel.addEventListener('click', handler);
}

// ── HTML ──────────────────────────────────────────────────────────────────────

function _buildHtml(trip) {
  const cats    = trip.packingCats    || [];
  const checked = trip.packingChecked || {};

  const totalItems   = cats.reduce((s, c) => s + (c.items || []).length, 0);
  const checkedItems = Object.values(checked).filter(Boolean).length;
  const pct          = totalItems > 0 ? Math.round((checkedItems / totalItems) * 100) : 0;

  const progressHtml = totalItems > 0 ? `
    <div class="pack-progress">
      <div class="pack-progress-bar-wrap">
        <div class="pack-progress-bar" style="width:${pct}%;background:${pct === 100 ? 'var(--grn)' : 'var(--teal)'}"></div>
      </div>
      <span class="pack-progress-label">${checkedItems} / ${totalItems} articles emballés ${pct === 100 ? '🎉' : ''}</span>
    </div>` : '';

  const catsHtml = cats.length
    ? cats.map(cat => {
        const items       = cat.items || [];
        const catChecked  = items.filter(i => checked[i.id]).length;
        return `
          <div class="pack-cat-card" style="min-width:240px;max-width:300px;flex:0 0 260px">
            <div class="pack-cat-header">
              <span class="pack-cat-icon">${cat.icon || '📦'}</span>
              <span class="pack-cat-name">${_esc(cat.name)}</span>
              <span class="pack-cat-count" style="color:${cat.color || 'var(--teal)'}">${catChecked}/${items.length}</span>
              <button class="pack-cat-edit" data-action="edit-cat" data-cat="${cat.id}">✎</button>
              <button class="pack-cat-del"  data-action="del-cat"  data-cat="${cat.id}">×</button>
            </div>
            <div class="pack-items pack-items-grid">
              ${items.map(item => {
                const isChecked   = !!checked[item.id];
                const priority    = item.priority || 'rec';
                const prioLabel   = { must: '★', rec: '◆', opt: '◇' }[priority] || '◆';
                const prioColor   = { must: 'var(--coral)', rec: 'var(--amb)', opt: 'var(--ink4)' }[priority] || 'var(--ink4)';
                // Migration: support both old carrier (string) and new carriers (array)
                const carriers    = item.carriers ? item.carriers : (item.carrier ? [item.carrier] : []);
                const companions  = trip.companions || [];
                const carrierHtml = carriers.map(carrier => {
                  if (carrier === 'me') {
                    return `<span class="pack-carrier-av" title="Moi" style="background:var(--teal)">Moi</span>`;
                  } else {
                    const comp = companions.find(c => c.id === carrier);
                    if (comp) {
                      const initials = (comp.name || '?').slice(0, 2).toUpperCase();
                      return `<span class="pack-carrier-av" title="${_esc(comp.name)}" style="background:${_esc(comp.color || '#7c3aed')}">${initials}</span>`;
                    }
                    return '';
                  }
                }).join('');
                return `
                  <div class="pack-item ${isChecked ? 'checked' : ''}" data-action="toggle" data-cat="${cat.id}" data-item="${item.id}">
                    <div class="pack-item-check" style="border-color:${cat.color || 'var(--teal)'}${isChecked ? ';background:' + (cat.color || 'var(--teal)') : ''}">
                      ${isChecked ? '✓' : ''}
                    </div>
                    <div class="pack-item-info">
                      <span class="pack-item-name ${isChecked ? 'struck' : ''}" style="overflow-wrap:anywhere;word-break:break-all;display:block">${_esc(item.name)}</span>
                      ${item.subtitle ? `<span class="pack-item-sub">${_esc(item.subtitle)}</span>` : ''}
                    </div>
                    ${carrierHtml}
                    <span class="pack-item-prio" style="color:${prioColor}" title="${priority}">${prioLabel}</span>
                    <button class="pack-item-edit" data-action="edit-item" data-cat="${cat.id}" data-item="${item.id}" title="Modifier">✎</button>
                    <button class="pack-item-del" data-action="del-item" data-cat="${cat.id}" data-item="${item.id}">×</button>
                  </div>`;
              }).join('')}
              <button class="pack-item-add" data-action="add-item" data-cat="${cat.id}">＋ Ajouter</button>
            </div>
          </div>`;
      }).join('')
    : `<div class="empty-state" style="padding:60px 0">
        <div style="font-size:40px;margin-bottom:10px">🎒</div>
        <div>Aucune liste de bagages</div>
        <div style="font-size:12px;color:var(--ink4);margin-top:4px">Créez des catégories pour organiser vos affaires</div>
      </div>`;

  return `
    <div class="packing-wrap">
      <div class="packing-header">
        <h2 class="packing-title">Liste des bagages</h2>
        <div class="packing-actions">
          <button class="btn-sec-sm" data-action="reset-all">↺ Tout décocher</button>
          <button class="btn-add-cat" data-action="add-cat">＋ Catégorie</button>
        </div>
      </div>
      ${progressHtml}
      <div class="pack-cats" style="display:flex;flex-direction:row;flex-wrap:wrap;gap:12px;align-items:flex-start;padding-bottom:8px">${catsHtml}</div>
    </div>`;
}

// ── Event delegation ──────────────────────────────────────────────────────────

function _handleClick(e, tripId) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;

  if (action === 'add-cat')   { _openCatModal(tripId, null); return; }
  if (action === 'edit-cat')  { _openCatModal(tripId, el.dataset.cat); return; }
  if (action === 'del-cat')   { _deleteCat(tripId, el.dataset.cat); return; }
  if (action === 'add-item')  { _openItemModal(tripId, el.dataset.cat, null); return; }
  if (action === 'edit-item') { e.stopPropagation(); _openItemModal(tripId, el.dataset.cat, el.dataset.item); return; }
  if (action === 'del-item')  { e.stopPropagation(); _deleteItem(tripId, el.dataset.cat, el.dataset.item); return; }
  if (action === 'toggle')    { _toggleItem(tripId, el.dataset.item); return; }
  if (action === 'reset-all') { _resetAll(tripId); return; }
}

// ── Toggle ─────────────────────────────────────────────────────────────────────

function _toggleItem(tripId, itemId) {
  const trip    = getTrip(tripId);
  if (!trip) return;
  const checked = { ...(trip.packingChecked || {}) };
  checked[itemId] = !checked[itemId];
  updateTrip(tripId, { packingChecked: checked });
  renderPacking(tripId);
}

function _resetAll(tripId) {
  updateTrip(tripId, { packingChecked: {} });
  renderPacking(tripId);
  notify('Tout décoché');
}

// ── Category modal ─────────────────────────────────────────────────────────────

function _openCatModal(tripId, catId) {
  const trip = getTrip(tripId);
  if (!trip) return;
  const cat   = catId ? (trip.packingCats || []).find(c => c.id === catId) : null;
  const title = cat ? 'Modifier la catégorie' : 'Nouvelle catégorie';

  const icons = ['📄','👕','🧴','🔌','💊','👟','📷','🍫','🗺️','🧢','🩺','💻','📚','🎮','🔦'];

  showModal(`
    <div class="modal-head"><h3>${title}</h3></div>
    <div class="modal-body">
      <label class="ml">Nom
        <input id="pcat-name" class="mi" value="${_esc(cat?.name || '')}" placeholder="Ex: Vêtements" />
      </label>
      <label class="ml">Icône
        <div class="icon-grid" id="pcat-icon-grid">
          ${icons.map(ic => `<div class="icon-opt${(cat?.icon || '📦') === ic ? ' sel' : ''}" data-icon="${ic}">${ic}</div>`).join('')}
        </div>
        <input type="hidden" id="pcat-icon" value="${_esc(cat?.icon || '📦')}" />
      </label>
      <label class="ml">Couleur</label>
      ${colorOptsHtml(cat?.color || '#7c3aed', '_setPCatColor')}
      <input type="hidden" id="pcat-color" value="${_esc(cat?.color || '#7c3aed')}" />
    </div>
    <div class="modal-footer">
      <button class="btn-sec" onclick="closeModal()">Annuler</button>
      <button class="btn-pri" onclick="_savePCat('${tripId}','${catId || ''}')">Enregistrer</button>
    </div>`, {});

  document.getElementById('pcat-icon-grid')?.addEventListener('click', e => {
    const opt = e.target.closest('.icon-opt');
    if (!opt) return;
    document.querySelectorAll('.icon-opt').forEach(o => o.classList.remove('sel'));
    opt.classList.add('sel');
    document.getElementById('pcat-icon').value = opt.dataset.icon;
  });
}

window._setPCatColor = function(color) {
  const el = document.getElementById('pcat-color');
  if (el) el.value = color;
  document.querySelectorAll('.col-o').forEach(o => o.classList.toggle('sel', o.style.background === color || o.style.backgroundColor === color));
};

window._savePCat = function(tripId, catId) {
  const name  = document.getElementById('pcat-name')?.value.trim();
  const icon  = document.getElementById('pcat-icon')?.value || '📦';
  const color = document.getElementById('pcat-color')?.value || '#7c3aed';

  if (!name) { notify('Veuillez entrer un nom', '⚠'); return; }

  const trip = getTrip(tripId);
  if (!trip) return;

  const cats = [...(trip.packingCats || [])];
  if (catId) {
    const idx = cats.findIndex(c => c.id === catId);
    if (idx !== -1) cats[idx] = { ...cats[idx], name, icon, color };
  } else {
    cats.push({ id: uid(), name, icon, color, items: [] });
  }

  updateTrip(tripId, { packingCats: cats });
  closeModal();
  renderPacking(tripId);
  notify(catId ? 'Catégorie modifiée' : 'Catégorie ajoutée');
};

function _deleteCat(tripId, catId) {
  if (!confirm('Supprimer cette catégorie et tous ses articles ?')) return;
  const trip = getTrip(tripId);
  if (!trip) return;

  const cats = (trip.packingCats || []).filter(c => c.id !== catId);
  updateTrip(tripId, { packingCats: cats });
  renderPacking(tripId);
  notify('Catégorie supprimée', '🗑');
}

// ── Item modal ─────────────────────────────────────────────────────────────────

function _openItemModal(tripId, catId, itemId) {
  const trip = getTrip(tripId);
  if (!trip) return;
  const cat  = (trip.packingCats || []).find(c => c.id === catId);
  if (!cat) return;
  const item       = itemId ? (cat.items || []).find(i => i.id === itemId) : null;
  const title      = item ? 'Modifier l\'article' : 'Nouvel article';
  const companions = trip.companions || [];

  // Migration: support both old carrier (string) and new carriers (array)
  const initialCarriers = item
    ? (item.carriers ? [...item.carriers] : (item.carrier ? [item.carrier] : []))
    : [];

  // Local multi-selection state
  const state = { carriers: new Set(initialCarriers) };

  const allAvatars = [
    { id: 'me', label: 'Moi', color: 'var(--teal)' },
    ...companions.map(c => ({ id: c.id, label: c.name, color: c.color || '#7c3aed' }))
  ];

  function buildCarrierButtons() {
    return allAvatars.map(av => {
      const initials   = av.id === 'me' ? 'Moi' : (av.label || '?').slice(0, 2).toUpperCase();
      const isSelected = state.carriers.has(av.id);
      return `<button type="button"
        class="pack-carrier-pick${isSelected ? ' sel' : ''}"
        data-carrier-id="${_esc(av.id)}"
        title="${_esc(av.label)}"
        style="background:${isSelected ? av.color : 'var(--c2)'};color:${isSelected ? '#fff' : 'var(--ink3)'};border:1.5px solid ${isSelected ? av.color : 'var(--c3)'}"
      >${initials}</button>`;
    }).join('');
  }

  function refreshCarrierRow() {
    const row = document.getElementById('pitem-carrier-row');
    if (row) row.innerHTML = buildCarrierButtons();
  }

  showModal(`
    <div class="modal-head"><h3>${title}</h3></div>
    <div class="modal-body">
      <label class="ml">Article
        <input id="pitem-name" class="mi" value="${_esc(item?.name || '')}" placeholder="Ex: Passeport" autofocus />
      </label>
      <label class="ml">Détail (optionnel)
        <input id="pitem-sub" class="mi" value="${_esc(item?.subtitle || '')}" placeholder="Ex: Valide 6 mois" />
      </label>
      <label class="ml">Priorité
        <div class="prio-opts">
          <label class="prio-opt"><input type="radio" name="prio" value="must" ${(item?.priority || 'rec') === 'must' ? 'checked' : ''} /> <span style="color:var(--coral)">★ Indispensable</span></label>
          <label class="prio-opt"><input type="radio" name="prio" value="rec"  ${(item?.priority || 'rec') === 'rec'  ? 'checked' : ''} /> <span style="color:var(--amb)">◆ Recommandé</span></label>
          <label class="prio-opt"><input type="radio" name="prio" value="opt"  ${(item?.priority || 'rec') === 'opt'  ? 'checked' : ''} /> <span style="color:var(--ink4)">◇ Optionnel</span></label>
        </div>
      </label>
      <div class="ml">
        <span style="font-size:12px;font-weight:600;color:var(--ink2);display:block;margin-bottom:6px">Qui l'apporte ? <span style="font-size:10px;font-weight:400;color:var(--ink4)">(sélection multiple)</span></span>
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center" id="pitem-carrier-row">
          ${buildCarrierButtons()}
        </div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn-sec" onclick="closeModal()">Annuler</button>
      <button class="btn-pri" onclick="_savePItem('${tripId}','${catId}','${itemId || ''}')">Enregistrer</button>
    </div>`, {});

  // Carrier picker: toggle multi-selection
  document.getElementById('pitem-carrier-row')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-carrier-id]');
    if (!btn) return;
    const carrierId = btn.dataset.carrierId;
    if (!carrierId) return; // ignore clicks on non-carrier elements
    if (state.carriers.has(carrierId)) {
      state.carriers.delete(carrierId);
    } else {
      state.carriers.add(carrierId);
    }
    refreshCarrierRow();
  });

  // Expose state so _savePItem can access it via closure
  window._currentPackingItemState = state;
}

window._savePItem = function(tripId, catId, itemId) {
  const name     = document.getElementById('pitem-name')?.value.trim();
  const subtitle = document.getElementById('pitem-sub')?.value.trim() || '';
  const priority = document.querySelector('input[name="prio"]:checked')?.value || 'rec';
  // Read carriers from the closure state set by _openItemModal
  const carriersSet = window._currentPackingItemState?.carriers || new Set();
  const carriers = Array.from(carriersSet);

  if (!name) { notify('Veuillez entrer un nom', '⚠'); return; }

  const trip = getTrip(tripId);
  if (!trip) return;

  const cats = [...(trip.packingCats || [])];
  const catIdx = cats.findIndex(c => c.id === catId);
  if (catIdx === -1) return;

  const items = [...(cats[catIdx].items || [])];
  if (itemId) {
    const idx = items.findIndex(i => i.id === itemId);
    if (idx !== -1) {
      // Remove old carrier field if present, save as carriers array
      const { carrier: _oldCarrier, ...rest } = items[idx];
      items[idx] = { ...rest, name, subtitle, priority, carriers };
    }
  } else {
    items.push({ id: uid(), name, subtitle, priority, carriers });
  }
  cats[catIdx] = { ...cats[catIdx], items };

  window._currentPackingItemState = null;
  updateTrip(tripId, { packingCats: cats });
  closeModal();
  renderPacking(tripId);
  notify(itemId ? 'Article modifié' : 'Article ajouté');
};

function _deleteItem(tripId, catId, itemId) {
  const trip = getTrip(tripId);
  if (!trip) return;

  const cats   = [...(trip.packingCats || [])];
  const catIdx = cats.findIndex(c => c.id === catId);
  if (catIdx === -1) return;

  // Guard: a category imported from an older data version may lack an items array
  cats[catIdx] = { ...cats[catIdx], items: (cats[catIdx].items || []).filter(i => i.id !== itemId) };
  updateTrip(tripId, { packingCats: cats });
  renderPacking(tripId);
  notify('Article supprimé', '🗑');
}

function _esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
