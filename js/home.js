/* ============================================================
   CARNET DE VOYAGES — Home / Library Screen
   ============================================================ */

import {
  getTrips, addTrip, updateTrip, deleteTrip,
  TRIP_TYPES, COMP_COLORS, uid,
} from './store.js';
import {
  notify, showModal, closeModal,
  fmtDate, fmtDateShort,
  dpInit, dpGetDates, renderDp,
  typeBadge,
  generateDays,
} from './utils.js';
import { navigateToTrip, goMyMap } from './app.js';
import { importFile } from './import.js';

// ── Module state ───────────────────────────────────────────────────────────────

let _currentFilter  = 'all';
let _listenerAttached = false;

// Companion list being edited in the open modal
let _modalComps = [];
let _modalColor = '#0d9488';
let _modalType  = 'voyage';
let _editingId  = null;

// ── Helpers ────────────────────────────────────────────────────────────────────

function _compColor(index) {
  return COMP_COLORS[index % COMP_COLORS.length];
}

function _initials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return parts[0].slice(0, 2).toUpperCase();
}

function _esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Statistics ─────────────────────────────────────────────────────────────────

function _calcStats(trips) {
  const voyageCount  = trips.filter(t => t.type === 'voyage').length;
  const weekendCount = trips.filter(t => t.type === 'weekend').length;
  const sortieCount  = trips.filter(t => t.type === 'sortie').length;

  let totalDays = 0;
  for (const t of trips) {
    if (t.startDate && t.endDate) {
      const diff = Math.round(
        (new Date(t.endDate + 'T12:00:00') - new Date(t.startDate + 'T12:00:00')) / 86400000
      ) + 1;
      if (diff > 0) totalDays += diff;
    }
  }

  const destinations = new Set(
    trips.map(t => (t.destination || '').trim().toLowerCase()).filter(Boolean)
  );

  return { voyageCount, weekendCount, sortieCount, totalDays, countries: destinations.size };
}

// ── Hero HTML ──────────────────────────────────────────────────────────────────

function _heroHtml(trips) {
  const s = _calcStats(trips);
  return `
    <div class="hero">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;width:100%">
        <div>
          <div class="hero-logo">Carnet de Voyages</div>
          <div class="hero-sub">Planifiez, organisez et vivez vos aventures</div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn-new" data-action="open-import" title="Importer KML/CSV">⬆ Importer</button>
          <button class="btn-new" data-action="open-mymap">🗺 MyMap</button>
        </div>
      </div>
      <div class="hero-stats">
        <div class="hs-card">
          <div class="hs-v">${s.voyageCount}</div>
          <div class="hs-l">Voyages</div>
        </div>
        <div class="hs-card">
          <div class="hs-v">${s.weekendCount}</div>
          <div class="hs-l">Week-ends</div>
        </div>
        <div class="hs-card">
          <div class="hs-v">${s.sortieCount}</div>
          <div class="hs-l">Sorties</div>
        </div>
        <div class="hs-card">
          <div class="hs-v">${s.totalDays}</div>
          <div class="hs-l">Jours</div>
        </div>
        <div class="hs-card">
          <div class="hs-v">${s.countries}</div>
          <div class="hs-l">Destinations</div>
        </div>
      </div>
    </div>
  `;
}

// ── Filter tabs HTML ───────────────────────────────────────────────────────────

function _filterTabsHtml(active) {
  const tabs = [
    { key: 'all',     label: 'Tous' },
    { key: 'voyage',  label: 'Voyages' },
    { key: 'weekend', label: 'Week-ends' },
    { key: 'sortie',  label: 'Sorties' },
  ];
  return `<div class="filter-tabs">
    ${tabs.map(t =>
      `<button class="filter-tab${active === t.key ? ' active' : ''}"
               data-action="filter" data-filter="${t.key}">${t.label}</button>`
    ).join('')}
  </div>`;
}

// ── Trip card HTML ─────────────────────────────────────────────────────────────

function _tripCardHtml(trip) {
  // Photo or colored emoji placeholder
  let imgHtml;
  if (trip.photo) {
    imgHtml = `
      <img class="tc-img" src="${_esc(trip.photo)}" alt=""
           loading="lazy"
           onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
      <div class="tc-img-ph" style="background:${trip.color || '#0d9488'};display:none">${trip.flag || '🌍'}</div>
    `;
  } else {
    imgHtml = `<div class="tc-img-ph" style="background:${trip.color || '#0d9488'}">${trip.flag || '🌍'}</div>`;
  }

  // Date range
  let dateStr = 'Dates à définir';
  if (trip.startDate && trip.endDate) {
    dateStr = `${fmtDateShort(trip.startDate)} → ${fmtDate(trip.endDate)}`;
  } else if (trip.startDate) {
    dateStr = `Dès ${fmtDate(trip.startDate)}`;
  }

  // Companions
  const comps = trip.companions || [];
  let compsHtml;
  if (comps.length === 0) {
    compsHtml = `<span style="font-size:11px;color:var(--ink4);font-weight:600">Solo</span>`;
  } else {
    const shown = comps.slice(0, 4);
    compsHtml = shown.map((c, i) => {
      const bg = c.color || _compColor(i);
      return `<div class="comp-avatar" style="background:${bg}" title="${_esc(c.name)}">${_initials(c.name)}</div>`;
    }).join('');
    if (comps.length > 4) {
      compsHtml += `<span style="font-size:10px;color:var(--ink4);font-weight:700">+${comps.length - 4}</span>`;
    }
  }

  // Stats
  const stats = [];
  if (trip.startDate && trip.endDate) {
    const days = Math.round(
      (new Date(trip.endDate + 'T12:00:00') - new Date(trip.startDate + 'T12:00:00')) / 86400000
    ) + 1;
    if (days > 0) stats.push(`${days} jour${days > 1 ? 's' : ''}`);
  }
  if (Array.isArray(trip.budgetLines) && trip.budgetLines.length > 0) {
    const total = trip.budgetLines.reduce((s, b) => s + (Number(b.amount) || 0), 0);
    if (total > 0) stats.push(`${total.toLocaleString('fr-FR')} €`);
  }
  const statsHtml = stats.length
    ? `<div class="tc-stats">${stats.map(s => `<span class="tc-s">${s}</span>`).join('')}</div>`
    : '';

  return `
    <div class="trip-card" data-action="open-trip" data-trip-id="${trip.id}">
      ${imgHtml}
      <div class="tc-body">
        <div class="tc-header">
          <div>${typeBadge(trip.type)}</div>
          <button class="tc-edit-btn"
                  data-action="edit-trip"
                  data-trip-id="${trip.id}"
                  title="Modifier">✎</button>
        </div>
        <div class="tc-title">${trip.flag || '🌍'} ${_esc(trip.name) || 'Sans titre'}</div>
        <div class="tc-dates">${dateStr}</div>
        <div class="tc-companions">${compsHtml}</div>
        ${statsHtml}
      </div>
    </div>
  `;
}

function _addCardHtml() {
  return `
    <div class="trip-card tc-add" data-action="new-trip">
      <div class="ai">＋</div>
      <span>Nouveau voyage</span>
    </div>
  `;
}

// ── Render home ────────────────────────────────────────────────────────────────

export function renderHome(filter = _currentFilter) {
  _currentFilter = filter;

  const wrap = document.getElementById('home-wrap');
  if (!wrap) return;

  const allTrips = getTrips();
  const filtered = filter === 'all'
    ? allTrips
    : allTrips.filter(t => t.type === filter);

  // Sort: newest startDate first, fallback to createdAt
  const sorted = [...filtered].sort((a, b) => {
    const da = a.startDate || a.createdAt || '';
    const db = b.startDate || b.createdAt || '';
    return da > db ? -1 : da < db ? 1 : 0;
  });

  wrap.innerHTML = `
    ${_heroHtml(allTrips)}
    <div class="home-sec">
      <div class="home-sec-hd">
        <h2>Mes voyages</h2>
        <button class="btn-new" data-action="new-trip">＋ Nouveau</button>
      </div>
      ${_filterTabsHtml(filter)}
      <div class="trips-grid" id="trips-grid">
        ${sorted.map(_tripCardHtml).join('')}
        ${_addCardHtml()}
      </div>
    </div>
  `;

  // Attach the click listener only once; subsequent renderHome calls reuse it
  if (!_listenerAttached) {
    _attachListeners(wrap);
    _listenerAttached = true;
  }
}

// ── Event delegation ───────────────────────────────────────────────────────────

function _attachListeners(wrap) {
  wrap.addEventListener('click', e => {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;

    switch (action) {
      case 'open-mymap':
        goMyMap();
        break;

      case 'open-import':
        _openImportModal();
        break;

      case 'new-trip':
        openEditTripModal(null);
        break;

      case 'edit-trip':
        e.stopPropagation();
        openEditTripModal(target.dataset.tripId);
        break;

      case 'open-trip':
        navigateToTrip(target.dataset.tripId);
        break;

      case 'filter':
        renderHome(target.dataset.filter);
        break;
    }
  });
}

// ── Modal: companion list HTML ─────────────────────────────────────────────────

function _compsListHtml() {
  if (_modalComps.length === 0) {
    return `<div style="font-size:11px;color:var(--ink4);font-style:italic">Aucun compagnon pour l'instant</div>`;
  }
  return _modalComps.map((c, i) => {
    const bg = c.color || _compColor(i);
    return `
      <div class="comp-tag" data-comp-idx="${i}">
        <div class="comp-avatar"
             style="background:${bg};width:18px;height:18px;font-size:9px">${_initials(c.name)}</div>
        <span>${_esc(c.name)}</span>
        <button class="comp-tag-rm" data-remove-comp="${i}" title="Retirer">✕</button>
      </div>
    `;
  }).join('');
}

// ── Modal: build HTML ──────────────────────────────────────────────────────────

function _buildModalHtml(trip) {
  const name        = trip?.name        || '';
  const destination = trip?.destination || '';
  const flag        = trip?.flag        || '';
  const photo       = trip?.photo       || '';

  // Color swatches (using class names from CSS: .col-opts, .col-o, .sel)
  const colors = ['#0d9488','#7c3aed','#e85d3e','#d97706','#db2777','#0284c7','#16a34a'];
  const colorSwatches = colors.map(c =>
    `<div class="col-o${c === _modalColor ? ' sel' : ''}"
          style="background:${c}"
          data-modal-color="${c}"
          title="${c}"></div>`
  ).join('');

  // Type pills (using class names: .t-row, .tp, .sel)
  const typePills = Object.entries(TRIP_TYPES).map(([key, t]) => {
    const isSel = _modalType === key;
    return `<button class="tp${isSel ? ' sel' : ''}"
                    style="${isSel ? `background:${t.color};border-color:${t.color};color:#fff` : ''}"
                    data-modal-type="${key}">${t.icon} ${t.label}</button>`;
  }).join('');

  const isEdit = _editingId !== null;

  return `
    <h3 style="font-family:'Lora',serif;font-size:18px;font-weight:700;margin-bottom:16px">
      ${isEdit ? '✎ Modifier le voyage' : '＋ Nouveau voyage'}
    </h3>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 14px">
      <div class="fg" style="grid-column:1/-1">
        <label>Nom du voyage</label>
        <input type="text" id="m-name" value="${_esc(name)}"
               placeholder="Mon beau voyage…" autocomplete="off">
      </div>
      <div class="fg">
        <label>Destination</label>
        <input type="text" id="m-dest" value="${_esc(destination)}"
               placeholder="Paris, Tokyo…" autocomplete="off">
      </div>
      <div class="fg">
        <label>Drapeau (emoji)</label>
        <input type="text" id="m-flag" value="${_esc(flag)}"
               placeholder="🇫🇷" maxlength="2" autocomplete="off"
               style="font-size:20px;text-align:center">
      </div>
    </div>

    <div class="fg">
      <label>Photo (URL)</label>
      <input type="url" id="m-photo" value="${_esc(photo)}"
             placeholder="https://…" autocomplete="off">
      <img id="m-photo-preview" class="ip"
           src="${_esc(photo)}"
           style="${photo ? 'display:block' : 'display:none'}"
           alt="aperçu"
           onerror="this.style.display='none'">
    </div>

    <div class="fg">
      <label>Couleur</label>
      <div class="col-opts" id="m-colors">${colorSwatches}</div>
    </div>

    <div class="fg">
      <label>Type de voyage</label>
      <div class="t-row" id="m-types">${typePills}</div>
    </div>

    <div class="fg">
      <label>Dates</label>
      <div id="m-dp"></div>
    </div>

    <div class="fg">
      <label>Compagnons de voyage</label>
      <div class="comp-list" id="m-comp-list">${_compsListHtml()}</div>
      <div class="comp-add-row" style="margin-top:6px">
        <input type="text" id="m-comp-input" placeholder="Prénom ou nom…" autocomplete="off">
        <button class="comp-add-btn" id="m-comp-add">Ajouter</button>
      </div>
    </div>

    <div class="ma">
      ${isEdit ? `<button class="bd" id="m-delete">🗑 Supprimer</button>` : ''}
      <button class="bc" id="m-cancel">Annuler</button>
      <button class="bs" id="m-save">${isEdit ? 'Enregistrer' : 'Créer le voyage'}</button>
    </div>
  `;
}

// ── Modal: open ────────────────────────────────────────────────────────────────

export function openEditTripModal(id = null) {
  _editingId  = id;
  const trip  = id ? getTrips().find(t => t.id === id) : null;

  // Seed module state from the trip being edited (or defaults)
  _modalComps = trip
    ? (trip.companions || []).map(c => ({ ...c }))
    : [];
  _modalColor = trip?.color || '#0d9488';
  _modalType  = trip?.type  || 'voyage';

  showModal(_buildModalHtml(trip));
  _initModalListeners(trip);
}

// ── Modal: wire up listeners ───────────────────────────────────────────────────

function _initModalListeners(trip) {
  // Date picker
  dpInit('m-dp', trip?.startDate ?? null, trip?.endDate ?? null);

  // Photo preview
  const photoInput   = document.getElementById('m-photo');
  const photoPreview = document.getElementById('m-photo-preview');
  if (photoInput && photoPreview) {
    photoInput.addEventListener('input', () => {
      const url = photoInput.value.trim();
      if (url) {
        photoPreview.src          = url;
        photoPreview.style.display = 'block';
        photoPreview.onerror      = () => { photoPreview.style.display = 'none'; };
      } else {
        photoPreview.style.display = 'none';
      }
    });
  }

  // Color swatches
  document.getElementById('m-colors')?.addEventListener('click', e => {
    const sw = e.target.closest('[data-modal-color]');
    if (!sw) return;
    _modalColor = sw.dataset.modalColor;
    document.querySelectorAll('#m-colors [data-modal-color]').forEach(s => {
      s.classList.toggle('sel', s.dataset.modalColor === _modalColor);
    });
  });

  // Type pills
  document.getElementById('m-types')?.addEventListener('click', e => {
    const pill = e.target.closest('[data-modal-type]');
    if (!pill) return;
    _modalType = pill.dataset.modalType;
    document.querySelectorAll('#m-types [data-modal-type]').forEach(p => {
      const key    = p.dataset.modalType;
      const isSel  = key === _modalType;
      const tInfo  = TRIP_TYPES[key];
      p.classList.toggle('sel', isSel);
      p.style.background  = isSel ? tInfo.color : '';
      p.style.borderColor = isSel ? tInfo.color : '';
      p.style.color       = isSel ? '#fff'      : '';
    });
  });

  // Add companion
  const compInput = document.getElementById('m-comp-input');
  const addCompFn = () => {
    const name = compInput?.value.trim();
    if (!name) return;
    _modalComps.push({
      id:    'c_' + uid(),
      name,
      color: _compColor(_modalComps.length),
    });
    if (compInput) compInput.value = '';
    _refreshCompList();
    compInput?.focus();
  };

  document.getElementById('m-comp-add')?.addEventListener('click', addCompFn);
  compInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addCompFn(); }
  });

  // Remove companion (delegated)
  document.getElementById('m-comp-list')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-remove-comp]');
    if (!btn) return;
    _modalComps.splice(parseInt(btn.dataset.removeComp, 10), 1);
    _refreshCompList();
  });

  // Save
  document.getElementById('m-save')?.addEventListener('click', _handleSave);

  // Delete
  document.getElementById('m-delete')?.addEventListener('click', _handleDelete);

  // Cancel
  document.getElementById('m-cancel')?.addEventListener('click', closeModal);
}

function _refreshCompList() {
  const list = document.getElementById('m-comp-list');
  // Only replace innerHTML — the click listener on the container
  // was already attached in _initModalListeners and survives innerHTML updates.
  if (list) list.innerHTML = _compsListHtml();
}

// ── Modal: save / delete ───────────────────────────────────────────────────────

function _handleSave() {
  const name = (document.getElementById('m-name')?.value || '').trim();
  if (!name) {
    notify('Veuillez saisir un nom de voyage.', '⚠️');
    document.getElementById('m-name')?.focus();
    return;
  }

  const destination = (document.getElementById('m-dest')?.value  || '').trim();
  const flag        = (document.getElementById('m-flag')?.value  || '').trim() || '🌍';
  const photo       = (document.getElementById('m-photo')?.value || '').trim();
  const { start, end } = dpGetDates();

  const data = {
    name,
    destination,
    flag,
    photo,
    color:      _modalColor,
    type:       _modalType,
    startDate:  start || null,
    endDate:    end   || null,
    companions: _modalComps,
  };

  if (_editingId) {
    // Update existing trip
    const existing = getTrips().find(t => t.id === _editingId);
    const hadDays  = existing && Array.isArray(existing.days) && existing.days.length > 0;
    const updated  = updateTrip(_editingId, data);

    // Only generate days if there were none before
    if (updated && !hadDays) {
      const newDays = generateDays(updated);
      if (newDays.length > 0) {
        updateTrip(_editingId, { days: newDays });
      }
    }
    notify('Voyage mis à jour !', '✅');
  } else {
    // Create new trip
    const trip    = addTrip(data);
    const newDays = generateDays(trip);
    if (newDays.length > 0) {
      updateTrip(trip.id, { days: newDays });
    }
    notify('Voyage créé !', '✅');
  }

  closeModal();
  renderHome(_currentFilter);
}

function _handleDelete() {
  if (!_editingId) return;
  const trip = getTrips().find(t => t.id === _editingId);
  const name = trip?.name || 'ce voyage';

  if (!confirm(`Supprimer "${name}" ? Cette action est irréversible.`)) return;

  deleteTrip(_editingId);
  closeModal();
  renderHome(_currentFilter);
  notify(`"${name}" supprimé.`, '🗑');
}

// ── Import modal ───────────────────────────────────────────────────────────────

function _openImportModal() {
  showModal(`
    <div class="modal-head"><h3>⬆ Importer des voyages</h3></div>
    <div class="modal-body">
      <p style="font-size:13px;color:var(--ink3);margin-bottom:12px">
        Importez vos anciens voyages depuis un fichier KML (Google Earth) ou CSV.
        Les points seront regroupés automatiquement par date et région.
      </p>
      <label class="ml">Type de voyage importé
        <div class="t-row" id="imp-types">
          <button class="tp sel" data-imp-type="voyage"  style="background:#0d9488;border-color:#0d9488;color:#fff">✈️ Voyage</button>
          <button class="tp"     data-imp-type="weekend">🏕️ Week-end</button>
          <button class="tp"     data-imp-type="sortie" >🎯 Sortie</button>
        </div>
      </label>
      <label class="ml" style="margin-top:12px">Fichier KML ou CSV
        <input type="file" id="imp-file" accept=".kml,.csv" class="mi"
               style="padding:8px;cursor:pointer" />
      </label>
      <div id="imp-status" style="font-size:12px;color:var(--ink4);margin-top:8px;min-height:18px"></div>
    </div>
    <div class="modal-footer">
      <button class="btn-sec" onclick="closeModal()">Annuler</button>
      <button class="btn-pri" id="imp-go">Importer</button>
    </div>`, {});

  // Type selection
  let selectedType = 'voyage';
  document.getElementById('imp-types')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-imp-type]');
    if (!btn) return;
    selectedType = btn.dataset.impType;
    const types = { voyage: { color: '#0d9488' }, weekend: { color: '#7c3aed' }, sortie: { color: '#d97706' } };
    document.querySelectorAll('#imp-types [data-imp-type]').forEach(b => {
      const isSel = b.dataset.impType === selectedType;
      const col   = types[b.dataset.impType]?.color || '#0d9488';
      b.classList.toggle('sel', isSel);
      b.style.background  = isSel ? col : '';
      b.style.borderColor = isSel ? col : '';
      b.style.color       = isSel ? '#fff' : '';
    });
  });

  document.getElementById('imp-go')?.addEventListener('click', async () => {
    const fileInput = document.getElementById('imp-file');
    const file = fileInput?.files?.[0];
    if (!file) {
      document.getElementById('imp-status').textContent = 'Veuillez sélectionner un fichier.';
      return;
    }
    document.getElementById('imp-status').textContent = 'Import en cours…';
    await importFile(file, selectedType, count => {
      closeModal();
      renderHome(_currentFilter);
    });
  });
}
