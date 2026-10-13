/* ============================================================
   CARNET DE VOYAGES — Packing list (bagages)
   ============================================================ */

import { getTrip, updateTrip, uid } from '../store.js';
import { notify, showModal, closeModal, colorOptsHtml } from '../utils.js';

// ── Panel listener registry (prevent accumulation) ────────────────────────────
const _handlers = new WeakMap();
const _filterBound = new WeakSet();

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
  if (!_filterBound.has(panel)) {
    _filterBound.add(panel);
    panel.addEventListener('change', e => {
      if (e.target.name !== 'pk-filter') return;
      _filter = e.target.value;
      renderPacking(panel.dataset.tripId);
    });
  }
  panel.dataset.tripId = tripId;
}

// ── HTML ──────────────────────────────────────────────────────────────────────
// Style v2 (même famille que l'écran voyage / les modales de l'accueil) :
// anneau de progression, filtre Tout / À emballer / Emballés, une carte par
// catégorie, lignes cochables. Format des données inchangé (packingCats,
// packingChecked, item.priority, item.carriers).

let _filter = 'all';   // 'all' | 'todo' | 'done' — état d'affichage seulement

const _PRIO = {
  must: { label: 'Indispensable', short: 'Indispensable', color: 'var(--hv-coral)' },
  rec:  { label: 'Recommandé',    short: '',              color: '#f59e0b' },
  opt:  { label: 'Optionnel',     short: 'Optionnel',     color: 'var(--hv-ink2)' },
};

function _ring(pct, done) {
  const r = 30, c = 2 * Math.PI * r;
  return `<svg class="pk-ring" viewBox="0 0 72 72" aria-hidden="true">
    <circle cx="36" cy="36" r="${r}" class="pk-ring-bg"/>
    <circle cx="36" cy="36" r="${r}" class="pk-ring-fg${done ? ' pk-ring-done' : ''}"
      stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - pct / 100)).toFixed(1)}"/>
  </svg>`;
}

function _carriersHtml(item, companions) {
  const carriers = item.carriers ? item.carriers : (item.carrier ? [item.carrier] : []);
  const avs = carriers.map(id => {
    if (id === 'me') return `<span class="pk-av" style="background:var(--hv-accent)" title="Moi">Moi</span>`;
    const comp = companions.find(c => c.id === id);
    if (!comp) return '';
    const ini = (comp.name || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
    return `<span class="pk-av" style="background:${_esc(comp.color || '#7c3aed')}" title="${_esc(comp.name)}">${_esc(ini)}</span>`;
  }).join('');
  return avs ? `<span class="pk-avs">${avs}</span>` : '';
}

function _buildHtml(trip) {
  const cats    = trip.packingCats    || [];
  const checked = trip.packingChecked || {};
  const companions = trip.companions || [];

  const all = cats.flatMap(c => c.items || []);
  const total = all.length;
  const done  = all.filter(i => checked[i.id]).length;
  const pct   = total ? Math.round(done / total * 100) : 0;
  const mustLeft = all.filter(i => (i.priority || 'rec') === 'must' && !checked[i.id]).length;

  const hero = `
    <div class="pk-hero">
      <div class="pk-ring-wrap">${_ring(pct, total && done === total)}<b>${pct}%</b></div>
      <div class="pk-hero-txt">
        <b>${total ? (done === total ? 'Valise prête 🎉' : `${done} / ${total} emballés`) : 'Liste de bagages'}</b>
        <span>${total
          ? (mustLeft ? `${mustLeft} indispensable${mustLeft > 1 ? 's' : ''} à ne pas oublier` : (done === total ? 'Tout est dans le sac.' : 'Tous les indispensables sont prêts'))
          : 'Créez des catégories pour organiser vos affaires.'}</span>
      </div>
    </div>`;

  const seg = total ? `
    <div class="hv2-seg pk-seg">
      ${[['all', 'Tout'], ['todo', 'À emballer'], ['done', 'Emballés']].map(([v, l]) =>
        `<label><input type="radio" name="pk-filter" value="${v}" ${_filter === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}
    </div>` : '';

  const actions = `
    <div class="pk-actions">
      <button class="pk-btn pk-btn-dark" data-action="add-cat">＋ Catégorie</button>
      ${done ? `<button class="pk-btn" data-action="reset-all">↺ Tout décocher</button>` : ''}
    </div>`;

  const catsHtml = cats.length ? cats.map(cat => {
    const items = cat.items || [];
    const n = items.filter(i => checked[i.id]).length;
    const shown = items.filter(i => _filter === 'all' || (_filter === 'done') === !!checked[i.id]);
    const cp = items.length ? Math.round(n / items.length * 100) : 0;
    const rows = shown.map(item => {
      const on = !!checked[item.id];
      const pr = _PRIO[item.priority || 'rec'] || _PRIO.rec;
      const sub = [pr.short ? `<em style="color:${pr.color}">${pr.short}</em>` : '', item.subtitle ? _esc(item.subtitle) : ''].filter(Boolean).join(' · ');
      return `
        <div class="pk-item${on ? ' on' : ''}" data-action="toggle" data-cat="${_esc(cat.id)}" data-item="${_esc(item.id)}">
          <span class="pk-check">${on ? '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>' : ''}</span>
          <span class="pk-txt"><b>${_esc(item.name)}</b>${sub ? `<small>${sub}</small>` : ''}</span>
          ${_carriersHtml(item, companions)}
          <button class="pk-edit" data-action="edit-item" data-cat="${_esc(cat.id)}" data-item="${_esc(item.id)}" title="Modifier">›</button>
        </div>`;
    }).join('');
    const empty = !shown.length && items.length
      ? `<div class="pk-none">${_filter === 'todo' ? '✓ Tout est emballé' : 'Rien d’emballé pour l’instant'}</div>` : '';
    return `
      <section class="pk-cat" style="--pc:${_esc(cat.color || '#0d9488')}">
        <header class="pk-cat-hd">
          <span class="pk-cat-ic">${cat.icon || '📦'}</span>
          <div class="pk-cat-t">
            <b>${_esc(cat.name)}</b>
            <span class="pk-cat-meta"><i class="pk-bar"><i style="width:${cp}%"></i></i>${n}/${items.length}</span>
          </div>
          <button class="pk-cat-more" data-action="edit-cat" data-cat="${_esc(cat.id)}" title="Modifier la catégorie">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
          </button>
        </header>
        <div class="pk-items">${rows}${empty}</div>
        <button class="pk-add" data-action="add-item" data-cat="${_esc(cat.id)}">＋ Ajouter un article</button>
      </section>`;
  }).join('') : `
    <div class="pk-empty">
      <div>🎒</div><b>Aucune liste de bagages</b>
      <span>Commencez par une catégorie : Documents, Vêtements, Trousse de toilette…</span>
      <button class="pk-btn pk-btn-dark" data-action="add-cat">＋ Créer une catégorie</button>
    </div>`;

  return `<div class="pk">${hero}${seg}${cats.length ? actions : ''}<div class="pk-cats">${catsHtml}</div></div>`;
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

  const icons = ['📄','👕','🧴','🔌','💊','👟','📷','🍫','🗺️','🧢','🩺','💻','📚','🎮','🔦','🎒','🏖️','⛷️','👶','📦'];

  showModal(`
    <div class="hv2-modal-head">
      <h3>${title}</h3>
      <button class="hv2-round hv2-round-light" onclick="closeModal()" title="Fermer">✕</button>
    </div>
    <div class="pk-form">
      <div class="hv2-fsec">Nom</div>
      <div class="hv2-card-group"><input id="pcat-name" class="pk-in" value="${_esc(cat?.name || '')}" placeholder="Ex : Vêtements" /></div>
      <div class="hv2-fsec">Icône</div>
      <div class="hv2-card-group pk-pad">
        <div class="pk-icons" id="pcat-icon-grid">
          ${icons.map(ic => `<button type="button" class="pk-icon${(cat?.icon || '📦') === ic ? ' sel' : ''}" data-icon="${ic}">${ic}</button>`).join('')}
        </div>
        <input type="hidden" id="pcat-icon" value="${_esc(cat?.icon || '📦')}" />
      </div>
      <div class="hv2-fsec">Couleur</div>
      <div class="hv2-card-group pk-pad">${colorOptsHtml(cat?.color || '#7c3aed', '_setPCatColor')}</div>
      <input type="hidden" id="pcat-color" value="${_esc(cat?.color || '#7c3aed')}" />
      <button class="pk-save" onclick="_savePCat('${tripId}','${catId || ''}')">Enregistrer</button>
      ${cat ? `<button class="pk-del" onclick="closeModal();_delPCat('${tripId}','${catId}')">Supprimer la catégorie</button>` : ''}
    </div>`, { boxClass: 'hv2-modal pk-modal' });

  document.getElementById('pcat-icon-grid')?.addEventListener('click', e => {
    const opt = e.target.closest('.pk-icon');
    if (!opt) return;
    document.querySelectorAll('.pk-icon').forEach(o => o.classList.remove('sel'));
    opt.classList.add('sel');
    document.getElementById('pcat-icon').value = opt.dataset.icon;
  });
}

window._setPCatColor = function(color) {
  const el = document.getElementById('pcat-color');
  if (el) el.value = color;
  document.querySelectorAll('.col-o').forEach(o => o.classList.toggle('sel', o.style.background === color || o.style.backgroundColor === color));
};

window._delPCat = (tripId, catId) => _deleteCat(tripId, catId);

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
      const initials   = av.id === 'me' ? 'Moi' : (av.label || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
      const isSelected = state.carriers.has(av.id);
      return `<button type="button" class="pk-pick${isSelected ? ' sel' : ''}" data-carrier-id="${_esc(av.id)}" title="${_esc(av.label)}" style="--ac:${av.color}">
        <span class="pk-av">${_esc(initials)}</span><span>${_esc(av.id === 'me' ? 'Moi' : av.label)}</span></button>`;
    }).join('');
  }

  function refreshCarrierRow() {
    const row = document.getElementById('pitem-carrier-row');
    if (row) row.innerHTML = buildCarrierButtons();
  }

  const prio = item?.priority || 'rec';
  showModal(`
    <div class="hv2-modal-head">
      <h3>${title}</h3>
      <button class="hv2-round hv2-round-light" onclick="closeModal()" title="Fermer">✕</button>
    </div>
    <div class="pk-form">
      <div class="hv2-fsec">${_esc(cat.icon || '📦')} ${_esc(cat.name)}</div>
      <div class="hv2-card-group">
        <input id="pitem-name" class="pk-in" value="${_esc(item?.name || '')}" placeholder="Article — ex : Passeport" />
        <input id="pitem-sub" class="pk-in pk-in-sub" value="${_esc(item?.subtitle || '')}" placeholder="Détail (optionnel) — ex : valide 6 mois" />
      </div>
      <div class="hv2-fsec">Priorité</div>
      <div class="hv2-seg pk-prio">
        <label><input type="radio" name="prio" value="must" ${prio === 'must' ? 'checked' : ''}><span>★ Indispensable</span></label>
        <label><input type="radio" name="prio" value="rec" ${prio === 'rec' ? 'checked' : ''}><span>◆ Recommandé</span></label>
        <label><input type="radio" name="prio" value="opt" ${prio === 'opt' ? 'checked' : ''}><span>◇ Optionnel</span></label>
      </div>
      <div class="hv2-fsec">Qui l'apporte ?</div>
      <div class="pk-picks" id="pitem-carrier-row">${buildCarrierButtons()}</div>
      <button class="pk-save" onclick="_savePItem('${tripId}','${catId}','${itemId || ''}')">Enregistrer</button>
      ${item ? `<button class="pk-del" onclick="closeModal();_delPItem('${tripId}','${catId}','${itemId}')">Supprimer l'article</button>` : ''}
    </div>`, { boxClass: 'hv2-modal pk-modal' });
  if (!item) setTimeout(() => document.getElementById('pitem-name')?.focus(), 250);

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

window._delPItem = (tripId, catId, itemId) => _deleteItem(tripId, catId, itemId);

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
