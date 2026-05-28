/**
 * mapcal.js — Map & Planning tab for Carnet de Voyages
 *
 * Exported surface:
 *   renderMapCal(tripId)  — render the map + calendar + days panel
 *   destroyMap()          — destroy the Leaflet instance (called on tab leave)
 */

import { getTrip, updateTrip, saveData, uid } from '../store.js';
import {
  notify, showModal, closeModal,
  fmtDate, fmtDateShort,
  isoToDate, dateToIso, generateDays,
  tCol, tIc, trIc, trNm, trCol,
  MNS, DOW,
} from '../utils.js';
import { updateTopStats } from './trip.js';

// ─── Module state ─────────────────────────────────────────────────────────────

let _map          = null;          // Leaflet map instance
let _tripId       = null;
let _activeDayId  = null;          // currently selected day id
let _activeEvtKey = null;          // { dayId, idx } or null
let _markers      = {};            // dayId → L.Marker
let _routeLayers  = [];            // polylines / dashed lines on map
let _routeLoading = false;
let _pendingMapClick = null;       // callback when user clicks map to pick coords

// ─── Public API ───────────────────────────────────────────────────────────────

export function renderMapCal(tripId) {
  _tripId = tripId;

  const panel = document.getElementById('panel-mapcal');
  if (!panel) return;

  const trip = getTrip(tripId);
  if (!trip) return;

  // Generate days if trip has dates but no days yet
  if (trip.startDate && trip.endDate && (!trip.days || trip.days.length === 0)) {
    const days = generateDays(trip);
    updateTrip(tripId, { days });
  }

  // Inject panel structure (no bottom add-day button; + button is in the days-list header)
  panel.innerHTML = `
    <div class="mapcal">
      <div class="left-panel">
        <div class="lp-top" style="padding:12px 14px 8px;flex-shrink:0">
          <h3 id="lp-title" style="font-family:var(--sf);font-size:15px;font-weight:700;color:var(--ink)">Planning</h3>
          <p style="font-size:11px;color:var(--ink4);margin-top:2px">Cliquez sur un événement pour les détails</p>
        </div>
        <div class="mini-cal" id="mini-cal"></div>
        <div class="days-list-header" style="display:flex;align-items:center;justify-content:space-between;padding:4px 14px 2px;flex-shrink:0">
          <span style="font-size:11px;font-weight:600;color:var(--ink4);text-transform:uppercase;letter-spacing:.04em">Jours</span>
          <button class="bc" id="add-day-top-btn" data-action="add-day"
            style="padding:2px 8px;font-size:13px;line-height:1.4;border-radius:8px;font-weight:700"
            title="Ajouter un jour / étape">＋</button>
        </div>
        <div class="days-scroll" id="days-list"></div>
      </div>
      <div class="map-col">
        <div id="map" style="width:100%;height:100%"></div>
        <div class="route-loading" id="route-loading" style="display:none">Calcul des itinéraires…</div>
      </div>
    </div>
  `;

  // Attach event delegation for left panel
  _attachLeftPanelListeners(panel);

  // Init or re-init Leaflet map
  _initMap(tripId);

  // Render days list + mini-cal
  _renderDaysList(tripId);
  _renderMiniCal(tripId);
}

export function destroyMap() {
  if (_map) {
    try { _map.remove(); } catch (_) { /* already removed */ }
    _map = null;
  }
  _markers      = {};
  _routeLayers  = [];
  _activeDayId  = null;
  _activeEvtKey = null;
  _pendingMapClick = null;
}

// ─── Map initialization ───────────────────────────────────────────────────────

function _initMap(tripId) {
  // If a map already exists for this trip, just invalidate size
  if (_map) {
    setTimeout(() => { if (_map) _map.invalidateSize(); }, 80);
    _refreshMapPins(tripId);
    return;
  }

  requestAnimationFrame(() => {
    const el = document.getElementById('map');
    if (!el) return;

    const trip = getTrip(tripId);
    // Pick a sensible default center
    let center = [46.5, 2.5];
    let zoom   = 5;
    if (trip && trip.days) {
      const geo = trip.days.find(d => d.lat != null && d.lng != null);
      if (geo) { center = [geo.lat, geo.lng]; zoom = 7; }
    }

    _map = L.map('map', { center, zoom, zoomControl: true });

    L.tileLayer('https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 18,
    }).addTo(_map);

    // Map click handler
    _map.on('click', e => {
      if (_pendingMapClick) {
        _pendingMapClick(e.latlng.lat, e.latlng.lng);
        _pendingMapClick = null;
      }
    });

    _map.invalidateSize();

    _refreshMapPins(tripId);
  });
}

// ─── Map pins & routes ────────────────────────────────────────────────────────

function _refreshMapPins(tripId) {
  if (!_map) return;
  const trip = getTrip(tripId);
  if (!trip) return;

  // Remove existing markers
  Object.values(_markers).forEach(m => { try { _map.removeLayer(m); } catch (_) {} });
  _markers = {};

  // Remove existing route layers
  _routeLayers.forEach(l => { try { _map.removeLayer(l); } catch (_) {} });
  _routeLayers = [];

  const days = (trip.days || []).filter(d => d.lat != null && d.lng != null);

  days.forEach(day => {
    const marker = L.marker([day.lat, day.lng], {
      icon: _makeDayIcon(day),
    });

    marker.bindPopup(_dayPopupHtml(day), { maxWidth: 220 });

    marker.on('click', () => {
      _selectDay(day.id, tripId);
    });

    marker.addTo(_map);
    _markers[day.id] = marker;
  });

  // Add separate event-level markers for events that have their own coordinates
  for (const day of (trip.days || [])) {
    for (const item of (day.items || [])) {
      if (item.lat != null && item.lng != null) {
        const evtIcon = L.divIcon({
          className: '',
          html: `<div style="width:16px;height:16px;border-radius:50%;background:${day.color || '#0d9488'};border:2.5px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);cursor:pointer"></div>`,
          iconSize:   [16, 16],
          iconAnchor: [8, 8],
          popupAnchor:[0, -14],
        });
        const evtMarker = L.marker([item.lat, item.lng], { icon: evtIcon, zIndexOffset: 50 });
        evtMarker.bindPopup(
          `<div style="padding:4px 2px;min-width:120px">
            <div style="font-weight:700;font-size:12px">${_esc(item.text || '—')}</div>
            <div style="font-size:10px;color:var(--ink4)">Jour ${day.num}${item.time ? ' · ' + item.time : ''}${item.cost ? ' · ' + Number(item.cost).toLocaleString('fr-FR') + ' €' : ''}</div>
          </div>`,
          { maxWidth: 200 }
        );
        evtMarker.on('click', () => _selectDay(day.id, tripId));
        evtMarker.addTo(_map);
        _markers['e_' + item.id] = evtMarker;
      }
    }
  }

  // Draw routes
  if (days.length > 1) {
    _drawRoutes(trip, days);
  }

  // Fit bounds if we have pins
  if (days.length === 1) {
    _map.setView([days[0].lat, days[0].lng], 10, { animate: true });
  } else if (days.length > 1) {
    const bounds = days.map(d => [d.lat, d.lng]);
    _map.fitBounds(bounds, { padding: [40, 40], maxZoom: 12 });
  }
}

function _makeDayIcon(day) {
  const color = day.color || '#0d9488';
  const label = day.num != null ? String(day.num) : '•';
  return L.divIcon({
    className: '',
    html: `<div class="wp-pin">
      <div class="pin-c" style="background:${color};">${label}</div>
      <div class="pin-tail" style="background:${color};"></div>
    </div>`,
    iconSize:   [28, 36],
    iconAnchor: [14, 36],
    popupAnchor:[0, -38],
  });
}

function _dayPopupHtml(day) {
  const items  = (day.items || []).slice(0, 3);
  const rows   = items.map(it => `<div class="lp-row">${tIc(it.type)} ${_esc(it.text || '')}</div>`).join('');
  const more   = (day.items || []).length > 3
    ? `<div class="lp-row" style="color:var(--ink4)">…et ${day.items.length - 3} de plus</div>`
    : '';
  return `
    <div style="padding:6px 2px;min-width:140px">
      <div class="lp-title" style="display:flex;align-items:center;gap:6px">
        <div style="width:12px;height:12px;border-radius:50%;background:${day.color || '#0d9488'};flex-shrink:0"></div>
        Jour ${day.num} · ${_esc(day.title || '')}
      </div>
      ${day.date ? `<div class="lp-row">${fmtDate(day.date)}</div>` : ''}
      ${day.region ? `<div class="lp-row" style="color:var(--ink4)">${_esc(day.region)}</div>` : ''}
      ${rows}${more}
    </div>
  `;
}

async function _drawRoutes(trip, days) {
  if (!_map) return;

  // Show loading
  const loadEl = document.getElementById('route-loading');
  if (loadEl) loadEl.style.display = 'block';
  _routeLoading = true;

  for (let i = 0; i < days.length - 1; i++) {
    const from = days[i];
    const to   = days[i + 1];

    // Find transport mode from the first transport item in the FROM day
    const transport = (from.items || []).find(it => it.type === 'drive');
    const mode      = transport ? (transport.transport || 'car') : 'car';

    if (mode === 'plane' || mode === 'ferry') {
      // Draw dashed direct line
      const line = L.polyline([[from.lat, from.lng], [to.lat, to.lng]], {
        color:     mode === 'plane' ? '#7c3aed' : '#0d9488',
        weight:    2,
        opacity:   0.6,
        dashArray: '6 6',
      });
      line.addTo(_map);
      _routeLayers.push(line);
    } else {
      // Fetch OSRM route
      try {
        const profile  = _osrmProfile(mode);
        const url = `https://router.project-osrm.org/route/v1/${profile}/`
          + `${from.lng},${from.lat};${to.lng},${to.lat}?overview=simplified&geometries=geojson`;

        const resp   = await fetch(url);
        const data   = await resp.json();
        const coords = data.routes?.[0]?.geometry?.coordinates;
        if (coords && coords.length) {
          const latlngs = coords.map(([lng, lat]) => [lat, lng]);
          const line = L.polyline(latlngs, {
            color:   trCol(mode),
            weight:  3,
            opacity: 0.7,
          });
          line.addTo(_map);
          _routeLayers.push(line);
        }
      } catch (err) {
        // Fallback: straight line
        const line = L.polyline([[from.lat, from.lng], [to.lat, to.lng]], {
          color:     '#9c9890',
          weight:    2,
          opacity:   0.4,
          dashArray: '4 4',
        });
        line.addTo(_map);
        _routeLayers.push(line);
      }
    }
  }

  if (loadEl) loadEl.style.display = 'none';
  _routeLoading = false;
}

function _osrmProfile(mode) {
  const map = { car: 'driving', bus: 'driving', foot: 'foot', bike: 'cycling' };
  return map[mode] || 'driving';
}

// ─── Mini calendar ────────────────────────────────────────────────────────────

function _renderMiniCal(tripId) {
  const container = document.getElementById('mini-cal');
  if (!container) return;

  const trip = getTrip(tripId);
  if (!trip) return;

  const days = trip.days || [];
  if (days.length === 0) {
    container.innerHTML = '<div style="font-size:11px;color:var(--ink4);padding:4px 2px;text-align:center">Aucun jour planifié</div>';
    return;
  }

  // Build a map of ISO date → day
  const byDate = {};
  days.forEach(d => { if (d.date) byDate[d.date] = d; });

  // Determine months to show
  const months = _getCalMonths(days);
  if (!months.length) return;

  let html = '';

  months.forEach(({ year, month }) => {
    const firstDay  = new Date(year, month, 1);
    const daysInMo  = new Date(year, month + 1, 0).getDate();
    const offset    = (firstDay.getDay() + 6) % 7; // Mon-based

    const today = new Date();
    const isoToday = dateToIso(today);

    let cells = '';
    for (let i = 0; i < offset; i++) {
      cells += '<div class="mc-cell empty"></div>';
    }
    for (let d = 1; d <= daysInMo; d++) {
      const iso  = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const day  = byDate[iso];
      const isToday = iso === isoToday;

      let cls  = 'mc-cell';
      let style = '';
      if (isToday) cls += ' td';

      if (day) {
        cls   += ' sd';
        style  = `background:${day.color || 'var(--teal)'};color:#fff;font-weight:700`;
        if (day.id === _activeDayId) {
          style += ';outline:2px solid var(--ink);outline-offset:1px';
        }
      }

      cells += `<div class="${cls}" style="${style}"
                     data-action="cal-day" data-date="${iso}">${d}</div>`;
    }

    const dowHtml = DOW.map(d => `<div class="mc-dow">${d}</div>`).join('');

    html += `
      <div class="mc-nav">
        <span class="mc-mn">${MNS[month].slice(0, 3)}. ${year}</span>
      </div>
      <div class="mc-grid">
        ${dowHtml}
        ${cells}
      </div>
    `;
  });

  container.innerHTML = html;

  // Event delegation
  container.addEventListener('click', e => {
    const cell = e.target.closest('[data-action="cal-day"]');
    if (!cell) return;
    const iso = cell.dataset.date;
    const trip2 = getTrip(_tripId);
    const day   = (trip2?.days || []).find(d => d.date === iso);
    if (day) _selectDay(day.id, _tripId);
  });
}

function _getCalMonths(days) {
  const seen = new Set();
  const months = [];
  days.forEach(d => {
    if (!d.date) return;
    const dt = isoToDate(d.date);
    if (!dt) return;
    const key = `${dt.getFullYear()}-${dt.getMonth()}`;
    if (!seen.has(key)) {
      seen.add(key);
      months.push({ year: dt.getFullYear(), month: dt.getMonth() });
    }
  });
  return months;
}

// ─── Days list ────────────────────────────────────────────────────────────────

function _renderDaysList(tripId) {
  const container = document.getElementById('days-list');
  if (!container) return;

  const trip = getTrip(tripId);
  if (!trip) return;

  const days = trip.days || [];

  if (days.length === 0) {
    container.innerHTML = `
      <div style="text-align:center;padding:24px 12px;color:var(--ink4);font-size:12px">
        <div style="font-size:28px;margin-bottom:6px">📅</div>
        <div>Aucun jour planifié</div>
        <div style="font-size:10px;margin-top:4px">Cliquez sur «&nbsp;＋&nbsp;» pour ajouter un jour</div>
      </div>`;
    return;
  }

  const html = days.map(day => _dayItemHtml(day)).join('');
  container.innerHTML = html;
}

function _dayItemHtml(day) {
  const isSelected = day.id === _activeDayId;
  const items = day.items || [];

  // Cost total
  const cost = items.reduce((s, it) => s + (Number(it.cost) || 0), 0);
  const costStr = cost > 0 ? `${cost.toLocaleString('fr-FR')} €` : '';

  let eventsHtml = '';
  if (isSelected) {
    const evtRows = items.map((it, idx) => {
      const isSelEvt = _activeEvtKey && _activeEvtKey.dayId === day.id && _activeEvtKey.idx === idx;
      return `
        <div class="evt-row${isSelEvt ? ' sel-evt' : ''}"
             data-action="open-event"
             data-day-id="${day.id}"
             data-event-idx="${idx}">
          <span class="evt-ic" style="color:${tCol(it.type)}">${it.type === 'drive' ? trIc(it.transport || 'car') : tIc(it.type)}</span>
          <div class="evt-info">
            <div class="evt-txt">${_esc(it.text || '—')}</div>
            <div class="evt-tm">${it.time ? it.time : ''}${it.cost ? (it.time ? ' · ' : '') + Number(it.cost).toLocaleString('fr-FR') + ' €' : ''}</div>
          </div>
          <button class="evt-del" data-action="delete-event" data-day-id="${day.id}" data-event-idx="${idx}" title="Supprimer">✕</button>
        </div>`;
    }).join('');

    eventsHtml = `
      <div class="di-body">
        <div class="evt-list">${evtRows}</div>
        <div class="add-evt" data-action="add-event" data-day-id="${day.id}">＋ Ajouter</div>
      </div>`;
  }

  const titleText = _esc(day.title || `Jour ${day.num}`);

  return `
    <div class="day-item${isSelected ? ' sel' : ''}"
         data-action="select-day"
         data-day-id="${day.id}">
      <div class="di-head">
        <div class="di-badge" style="background:${day.color || '#0d9488'}">${day.num}</div>
        <div class="di-name" style="display:flex;align-items:center;gap:4px;flex:1;min-width:0">
          <span class="di-title-text" data-day-id="${day.id}">${titleText}</span>
          <button class="di-edit-title" data-action="edit-day-title" data-day-id="${day.id}"
            title="Modifier le titre"
            style="background:none;border:none;cursor:pointer;padding:0 2px;font-size:12px;color:var(--ink4);line-height:1;flex-shrink:0">✎</button>
        </div>
        ${costStr ? `<span class="di-cost">${costStr}</span>` : ''}
        <span class="di-t" style="margin-left:4px">${isSelected ? '▲' : '▼'}</span>
      </div>
      <div class="di-s">
        ${day.date ? fmtDateShort(day.date) : ''}
        ${day.region ? `<span style="color:var(--ink4)"> · ${_esc(day.region)}</span>` : ''}
      </div>
      ${eventsHtml}
    </div>`;
}

// ─── Inline day title editing ─────────────────────────────────────────────────

function _startInlineTitleEdit(dayId, tripId) {
  const trip = getTrip(tripId);
  if (!trip) return;
  const day = (trip.days || []).find(d => d.id === dayId);
  if (!day) return;

  // Find the title span and pencil button inside the rendered item
  const titleSpan = document.querySelector(`.di-title-text[data-day-id="${dayId}"]`);
  const editBtn   = document.querySelector(`.di-edit-title[data-day-id="${dayId}"]`);
  if (!titleSpan) return;

  const currentTitle = day.title || `Jour ${day.num}`;

  // Replace span with input
  const input = document.createElement('input');
  input.type  = 'text';
  input.value = currentTitle;
  input.style.cssText = 'flex:1;min-width:0;font-size:13px;font-weight:600;padding:1px 4px;border:1.5px solid var(--teal);border-radius:5px;outline:none;background:var(--bg);color:var(--ink)';
  input.className = 'di-title-input';

  titleSpan.replaceWith(input);
  if (editBtn) editBtn.style.display = 'none';
  input.focus();
  input.select();

  const save = () => {
    const newTitle = input.value.trim() || `Jour ${day.num}`;
    const trip2 = getTrip(tripId);
    if (trip2) {
      const day2 = (trip2.days || []).find(d => d.id === dayId);
      if (day2) {
        day2.title = newTitle;
        updateTrip(tripId, { days: trip2.days });
      }
    }
    _renderDaysList(tripId);
    _renderMiniCal(tripId);
    _refreshMapPins(tripId);
  };

  input.addEventListener('blur', save);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') {
      // Restore without saving
      input.removeEventListener('blur', save);
      _renderDaysList(tripId);
    }
  });
}

// ─── Event detail panel (EDP) ─────────────────────────────────────────────────

function _openEDP(dayId, evtIdx, tripId) {
  _activeEvtKey = { dayId, idx: evtIdx };
  _renderDaysList(tripId);

  const trip = getTrip(tripId);
  if (!trip) return;

  const day = (trip.days || []).find(d => d.id === dayId);
  if (!day) return;

  const item = day.items[evtIdx];
  if (!item) return;

  // Remove existing EDP
  _closeEDP();

  const mapCol = document.querySelector('.map-col');
  if (!mapCol) return;

  let edpType      = item.type      || 'visit';
  let edpTransport = item.transport || 'car';

  const inputStyle = 'width:100%;padding:5px 8px;border:1.5px solid var(--c3);border-radius:6px;font-size:12px;background:var(--bg);color:var(--ink);box-sizing:border-box';

  function _typeButtons() {
    return ['drive','visit','activity','sleep'].map(t => {
      const active = t === edpType;
      return `<button type="button" class="tp${active ? ' sel' : ''}" data-edp-type="${t}"
        style="font-size:11px;padding:3px 8px;${active ? `background:${tCol(t)};border-color:${tCol(t)};color:#fff` : ''}">${tIc(t)} ${{ drive:'Transport', visit:'Visite', activity:'Activité', sleep:'Nuit' }[t]}</button>`;
    }).join('');
  }

  function _modeButtons() {
    return ['car','ferry','plane','bus','foot','bike'].map(m => {
      const active = m === edpTransport;
      return `<button type="button" class="tp${active ? ' sel' : ''}" data-edp-mode="${m}"
        style="font-size:11px;padding:3px 8px;${active ? `background:${trCol(m)};border-color:${trCol(m)};color:#fff` : ''}">${trIc(m)} ${{ car:'Voiture', ferry:'Ferry', plane:'Avion', bus:'Bus', foot:'À pied', bike:'Vélo' }[m]}</button>`;
    }).join('');
  }

  const edp = document.createElement('div');
  edp.className = 'edp';
  edp.id        = 'edp';
  edp.innerHTML = `
    <div class="edp-hd">
      <div class="edp-ic" id="edp-ic">${item.type === 'drive' ? trIc(item.transport || 'car') : tIc(item.type)}</div>
      <div style="min-width:0;flex:1">
        <div class="edp-title">Modifier l'événement</div>
        <div class="edp-day">${_esc(day.title || 'Jour ' + day.num)} · ${day.date ? fmtDate(day.date) : ''}</div>
      </div>
      <button class="edp-close" id="edp-close">✕</button>
    </div>
    <div class="edp-body">
      <div class="edp-sect">
        <div class="edp-sect-lbl">Type</div>
        <div style="display:flex;gap:4px;flex-wrap:wrap" id="edp-types">${_typeButtons()}</div>
      </div>
      <div class="edp-sect" id="edp-mode-sect" style="display:${edpType === 'drive' ? '' : 'none'}">
        <div class="edp-sect-lbl">Mode de transport</div>
        <div style="display:flex;gap:4px;flex-wrap:wrap" id="edp-modes">${_modeButtons()}</div>
      </div>
      <div class="edp-sect">
        <div class="edp-sect-lbl">Description</div>
        <input type="text" id="edp-text" value="${_esc(item.text || '')}" placeholder="Description…" style="${inputStyle}">
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 10px">
        <div class="edp-sect">
          <div class="edp-sect-lbl">Heure</div>
          <input type="time" id="edp-time" value="${_esc(item.time || '')}" style="${inputStyle}">
        </div>
        <div class="edp-sect">
          <div class="edp-sect-lbl">Coût (€)</div>
          <input type="number" id="edp-cost" min="0" step="0.01" value="${_esc(item.cost || '')}" placeholder="0" style="${inputStyle}">
        </div>
      </div>
      <div class="edp-sect">
        <div class="edp-sect-lbl">Notes</div>
        <textarea class="notes-ta" id="edp-notes" placeholder="Vos notes…" style="min-height:55px">${_esc(item.notes || '')}</textarea>
      </div>
    </div>
    <div class="edp-actions">
      <button class="edp-del" id="edp-del">🗑 Supprimer</button>
      <button class="edp-save" id="edp-save">Enregistrer</button>
    </div>
  `;

  mapCol.appendChild(edp);

  // Animate in
  requestAnimationFrame(() => { edp.classList.add('open'); });

  // Close
  edp.querySelector('#edp-close').addEventListener('click', () => {
    _closeEDP();
    _activeEvtKey = null;
    _renderDaysList(tripId);
  });

  // Type pills
  edp.querySelector('#edp-types').addEventListener('click', ev => {
    const pill = ev.target.closest('[data-edp-type]');
    if (!pill) return;
    edpType = pill.dataset.edpType;
    edp.querySelectorAll('[data-edp-type]').forEach(p => {
      const t = p.dataset.edpType;
      const active = t === edpType;
      p.classList.toggle('sel', active);
      p.style.background  = active ? tCol(t) : '';
      p.style.borderColor = active ? tCol(t) : '';
      p.style.color       = active ? '#fff'  : '';
    });
    const modeSect = edp.querySelector('#edp-mode-sect');
    if (modeSect) modeSect.style.display = edpType === 'drive' ? '' : 'none';
    const ic = edp.querySelector('#edp-ic');
    if (ic) ic.textContent = edpType === 'drive' ? trIc(edpTransport) : tIc(edpType);
  });

  // Mode pills
  edp.querySelector('#edp-modes').addEventListener('click', ev => {
    const pill = ev.target.closest('[data-edp-mode]');
    if (!pill) return;
    edpTransport = pill.dataset.edpMode;
    edp.querySelectorAll('[data-edp-mode]').forEach(p => {
      const m = p.dataset.edpMode;
      const active = m === edpTransport;
      p.classList.toggle('sel', active);
      p.style.background  = active ? trCol(m) : '';
      p.style.borderColor = active ? trCol(m) : '';
      p.style.color       = active ? '#fff'   : '';
    });
    const ic = edp.querySelector('#edp-ic');
    if (ic) ic.textContent = trIc(edpTransport);
  });

  // Save all fields
  edp.querySelector('#edp-save').addEventListener('click', () => {
    const text  = (document.getElementById('edp-text')?.value  || '').trim();
    const time  = document.getElementById('edp-time')?.value   || null;
    const cost  = parseFloat(document.getElementById('edp-cost')?.value  || '0') || 0;
    const notes = document.getElementById('edp-notes')?.value  || '';

    const t2 = getTrip(tripId);
    if (!t2) return;
    const d2 = (t2.days || []).find(dx => dx.id === dayId);
    if (!d2) return;

    const oldItem = d2.items[evtIdx];
    d2.items[evtIdx] = {
      ...oldItem,
      type:      edpType,
      transport: edpType === 'drive' ? edpTransport : oldItem.transport,
      text,
      time:  time || null,
      cost,
      notes,
    };

    updateTrip(tripId, { days: t2.days });

    // Sync cost back to budget line if one exists for this event
    if (oldItem.id) {
      const t3 = getTrip(tripId);
      if (t3) {
        const bl = (t3.budgetLines || []).find(l => l.source === 'event' && l.eventId === oldItem.id);
        if (bl) {
          const newBL = (t3.budgetLines || []).map(l =>
            l.id === bl.id ? { ...l, amount: cost, desc: text } : l
          );
          updateTrip(tripId, { budgetLines: newBL });
        }
      }
    }

    notify('Événement mis à jour', '✅');
    _closeEDP();
    _activeEvtKey = null;
    _renderDaysList(tripId);
    _refreshMapPins(tripId);
    updateTopStats(tripId);
  });

  // Delete
  edp.querySelector('#edp-del').addEventListener('click', () => {
    _deleteEvent(dayId, evtIdx, tripId);
  });
}

function _closeEDP() {
  const edp = document.getElementById('edp');
  if (edp) {
    edp.classList.remove('open');
    setTimeout(() => { try { edp.remove(); } catch (_) {} }, 280);
  }
}

// ─── Select day ───────────────────────────────────────────────────────────────

function _selectDay(dayId, tripId) {
  if (_activeDayId === dayId) {
    // Toggle off
    _activeDayId = null;
    _activeEvtKey = null;
    _closeEDP();
    _renderDaysList(tripId);
    _renderMiniCal(tripId);
    return;
  }

  _activeDayId  = dayId;
  _activeEvtKey = null;
  _closeEDP();

  _renderDaysList(tripId);
  _renderMiniCal(tripId);

  // Scroll day into view
  const dayEl = document.querySelector(`[data-day-id="${dayId}"][data-action="select-day"]`);
  if (dayEl) dayEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // Fly map to day coords
  const trip = getTrip(tripId);
  if (trip) {
    const day = (trip.days || []).find(d => d.id === dayId);
    if (day && day.lat != null && day.lng != null && _map) {
      _map.flyTo([day.lat, day.lng], Math.max(_map.getZoom(), 10), { duration: 1 });
      const marker = _markers[dayId];
      if (marker) setTimeout(() => marker.openPopup(), 800);
    }
  }
}

// ─── Event delegation for left panel ─────────────────────────────────────────

function _attachLeftPanelListeners(panel) {
  panel.addEventListener('click', e => {
    // Inline title edit — pencil button
    const editBtn = e.target.closest('[data-action="edit-day-title"]');
    if (editBtn) {
      e.stopPropagation();
      const dayId = editBtn.dataset.dayId;
      if (dayId) _startInlineTitleEdit(dayId, _tripId);
      return;
    }

    const target = e.target.closest('[data-action]');
    if (!target) return;

    const action = target.dataset.action;

    if (action === 'select-day') {
      // Don't trigger select when clicking edit button (already handled above)
      const dayId = target.dataset.dayId;
      if (dayId) _selectDay(dayId, _tripId);

    } else if (action === 'add-day') {
      e.stopPropagation();
      _openAddDayModal(_tripId);

    } else if (action === 'add-event') {
      e.stopPropagation();
      const dayId = target.dataset.dayId;
      if (dayId) _openAddEventModal(dayId, _tripId);

    } else if (action === 'open-event') {
      e.stopPropagation();
      const dayId = target.dataset.dayId;
      const idx   = parseInt(target.dataset.eventIdx, 10);
      if (dayId && !isNaN(idx)) _openEDP(dayId, idx, _tripId);

    } else if (action === 'delete-event') {
      e.stopPropagation();
      const dayId = target.dataset.dayId;
      const idx   = parseInt(target.dataset.eventIdx, 10);
      if (dayId && !isNaN(idx)) _deleteEvent(dayId, idx, _tripId);
    }
  });
}

// ─── Delete event ─────────────────────────────────────────────────────────────

function _deleteEvent(dayId, evtIdx, tripId) {
  const trip = getTrip(tripId);
  if (!trip) return;
  const day = (trip.days || []).find(d => d.id === dayId);
  if (!day) return;
  day.items.splice(evtIdx, 1);
  updateTrip(tripId, { days: trip.days });
  _activeEvtKey = null;
  _closeEDP();
  _renderDaysList(tripId);
  _refreshMapPins(tripId);
  updateTopStats(tripId);
  notify('Événement supprimé', '🗑');
}

// ─── Nominatim address search helper ─────────────────────────────────────────

/**
 * Renders an address search widget into `container` and returns a getter for
 * the currently selected { lat, lng, label } (or null if nothing chosen yet).
 *
 * @param {HTMLElement} container   - element to inject the widget into
 * @param {Function}    onSelect    - called with { lat, lng, label } when chosen
 * @param {Function}    onMapClick  - called when user clicks "📍 Cliquer sur la carte"
 */
function _buildLocationSearch(container, onSelect, onMapClick) {
  container.innerHTML = `
    <div style="display:flex;gap:6px;align-items:center">
      <input type="text" id="loc-query" placeholder="Rechercher un lieu…" autocomplete="off" style="flex:1">
      <button class="bc" id="loc-search-btn" style="white-space:nowrap;padding:8px 10px;font-size:11px">🔍 Chercher</button>
    </div>
    <div id="loc-results" style="margin-top:4px"></div>
    <div style="margin-top:4px">
      <button class="bc" id="loc-map-click" style="font-size:11px;padding:5px 10px;width:100%">📍 Cliquer sur la carte</button>
    </div>
    <div id="loc-selected" style="margin-top:4px;font-size:11px;color:var(--teal);min-height:16px"></div>
  `;

  const queryInput  = container.querySelector('#loc-query');
  const searchBtn   = container.querySelector('#loc-search-btn');
  const resultsEl   = container.querySelector('#loc-results');
  const selectedEl  = container.querySelector('#loc-selected');
  const mapClickBtn = container.querySelector('#loc-map-click');

  const doSearch = async () => {
    const q = (queryInput.value || '').trim();
    if (!q) return;
    searchBtn.disabled = true;
    searchBtn.textContent = '…';
    resultsEl.innerHTML = '<div style="font-size:11px;color:var(--ink4)">Recherche…</div>';
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(q)}`;
      const resp = await fetch(url, { headers: { 'Accept-Language': 'fr' } });
      const data = await resp.json();
      if (!data.length) {
        resultsEl.innerHTML = '<div style="font-size:11px;color:var(--ink4)">Aucun résultat</div>';
      } else {
        resultsEl.innerHTML = data.map((r, i) =>
          `<div class="loc-result" data-idx="${i}"
               style="padding:5px 8px;font-size:12px;cursor:pointer;border-radius:5px;border:1px solid var(--brd);margin-top:3px;background:var(--bg2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis"
               data-lat="${r.lat}" data-lng="${r.lon}" data-label="${_esc(r.display_name)}">
            📍 ${_esc(r.display_name)}
          </div>`
        ).join('');

        resultsEl.querySelectorAll('.loc-result').forEach(el => {
          el.addEventListener('mouseenter', () => { el.style.background = 'var(--teal-l, #ccfbf1)'; });
          el.addEventListener('mouseleave', () => { el.style.background = 'var(--bg2)'; });
          el.addEventListener('click', () => {
            const lat   = parseFloat(el.dataset.lat);
            const lng   = parseFloat(el.dataset.lng);
            const label = el.dataset.label;
            selectedEl.textContent = `📍 ${label} (${lat.toFixed(5)}, ${lng.toFixed(5)})`;
            resultsEl.innerHTML = '';
            onSelect({ lat, lng, label });
          });
        });
      }
    } catch (err) {
      resultsEl.innerHTML = '<div style="font-size:11px;color:var(--err,#dc2626)">Erreur de recherche</div>';
    }
    searchBtn.disabled = false;
    searchBtn.textContent = '🔍 Chercher';
  };

  searchBtn.addEventListener('click', doSearch);
  queryInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });

  mapClickBtn.addEventListener('click', () => {
    if (onMapClick) onMapClick();
  });

  // Expose a method to set the selected display (e.g. after map click)
  return {
    setSelected(label) {
      selectedEl.textContent = label;
      resultsEl.innerHTML    = '';
    },
  };
}

// ─── Add Day Modal ────────────────────────────────────────────────────────────

function _openAddDayModal(tripId) {
  const trip       = getTrip(tripId);
  const dayCount   = (trip?.days || []).length;
  const colors     = ['#0d9488','#7c3aed','#d97706','#16a34a','#db2777','#0284c7','#e85d3e','#f59e0b','#06b6d4','#8b5cf6'];
  let   selColor   = colors[dayCount % colors.length];
  let   pickedLat  = null;
  let   pickedLng  = null;

  showModal(`
    <h3>＋ Nouveau jour / étape</h3>
    <div class="fg">
      <label>Titre</label>
      <input type="text" id="ad-title" placeholder="Ex : Arrivée à Kyoto…" autocomplete="off">
    </div>
    <div class="fg">
      <label>Région / Ville</label>
      <input type="text" id="ad-region" value="${_esc(trip?.destination || '')}" placeholder="Ex : Kyoto, Japon" autocomplete="off">
    </div>
    <div class="fg">
      <label>Date</label>
      <input type="date" id="ad-date" value="${trip?.startDate || ''}">
    </div>
    <div class="fg">
      <label>Localisation</label>
      <div id="ad-location-widget"></div>
    </div>
    <div class="fg">
      <label>Couleur</label>
      <div style="display:flex;gap:7px;flex-wrap:wrap;padding:2px 0" id="ad-colors">
        ${colors.map((c, i) => `<div class="col-o${i === dayCount % 10 ? ' sel' : ''}"
                                     style="background:${c}"
                                     data-ad-color="${c}"></div>`).join('')}
      </div>
    </div>
    <div class="ma">
      <button class="bc" id="ad-cancel">Annuler</button>
      <button class="bs" id="ad-save">Ajouter</button>
    </div>
  `);

  // Build location search widget
  const locWidget = document.getElementById('ad-location-widget');
  const locCtrl   = _buildLocationSearch(
    locWidget,
    ({ lat, lng }) => { pickedLat = lat; pickedLng = lng; },
    () => {
      // Map click mode
      closeModal();
      if (_map) {
        _map.getContainer().style.cursor = 'crosshair';
        const infoEl = document.createElement('div');
        infoEl.id = 'map-pick-info';
        infoEl.style.cssText = 'position:absolute;top:10px;left:50%;transform:translateX(-50%);z-index:1000;background:#fff;border:1.5px solid var(--teal);border-radius:20px;padding:6px 16px;font-size:12px;font-weight:700;color:var(--teal);box-shadow:0 2px 8px rgba(0,0,0,.12)';
        infoEl.textContent = '📍 Cliquez sur la carte pour choisir la localisation';
        document.querySelector('.map-col')?.appendChild(infoEl);
      }
      _pendingMapClick = (lat, lng) => {
        pickedLat = lat; pickedLng = lng;
        if (_map) _map.getContainer().style.cursor = '';
        document.getElementById('map-pick-info')?.remove();
        _openAddDayModalWithCoords(tripId, lat, lng);
      };
    }
  );

  // Color picker
  document.getElementById('ad-colors')?.addEventListener('click', e => {
    const sw = e.target.closest('[data-ad-color]');
    if (!sw) return;
    selColor = sw.dataset.adColor;
    document.querySelectorAll('[data-ad-color]').forEach(s => {
      s.classList.toggle('sel', s.dataset.adColor === selColor);
    });
  });

  document.getElementById('ad-cancel')?.addEventListener('click', closeModal);

  document.getElementById('ad-save')?.addEventListener('click', () => {
    const title  = (document.getElementById('ad-title')?.value  || '').trim();
    const region = (document.getElementById('ad-region')?.value || '').trim();
    const date   = (document.getElementById('ad-date')?.value   || '').trim() || null;

    const trip2  = getTrip(tripId);
    const days   = trip2?.days || [];
    const newDay = {
      id:     'd_' + uid(),
      num:    days.length + 1,
      date,
      title:  title || `Jour ${days.length + 1}`,
      region,
      lat:    pickedLat != null ? Number(pickedLat) : null,
      lng:    pickedLng != null ? Number(pickedLng) : null,
      color:  selColor,
      photo:  '',
      items:  [],
    };

    days.push(newDay);
    updateTrip(tripId, { days });
    closeModal();
    _activeDayId = newDay.id;
    _renderDaysList(tripId);
    _renderMiniCal(tripId);
    _refreshMapPins(tripId);
    notify('Jour ajouté !', '✅');
  });
}

function _openAddDayModalWithCoords(tripId, lat, lng) {
  const trip     = getTrip(tripId);
  const dayCount = (trip?.days || []).length;
  const colors   = ['#0d9488','#7c3aed','#d97706','#16a34a','#db2777','#0284c7','#e85d3e','#f59e0b','#06b6d4','#8b5cf6'];
  let   selColor = colors[dayCount % colors.length];
  let   pickedLat = lat;
  let   pickedLng = lng;

  showModal(`
    <h3>＋ Nouveau jour / étape</h3>
    <div class="fg">
      <label>Titre</label>
      <input type="text" id="ad-title" placeholder="Ex : Arrivée à Kyoto…" autocomplete="off">
    </div>
    <div class="fg">
      <label>Région / Ville</label>
      <input type="text" id="ad-region" value="${_esc(trip?.destination || '')}" placeholder="Ex : Kyoto, Japon" autocomplete="off">
    </div>
    <div class="fg">
      <label>Date</label>
      <input type="date" id="ad-date" value="${trip?.startDate || ''}">
    </div>
    <div class="fg">
      <label>Localisation</label>
      <div id="ad-location-widget"></div>
    </div>
    <div class="fg">
      <label>Couleur</label>
      <div style="display:flex;gap:7px;flex-wrap:wrap;padding:2px 0" id="ad-colors">
        ${colors.map((c, i) => `<div class="col-o${i === dayCount % 10 ? ' sel' : ''}"
                                     style="background:${c}"
                                     data-ad-color="${c}"></div>`).join('')}
      </div>
    </div>
    <div class="ma">
      <button class="bc" id="ad-cancel">Annuler</button>
      <button class="bs" id="ad-save">Ajouter</button>
    </div>
  `);

  const locWidget = document.getElementById('ad-location-widget');
  const locCtrl   = _buildLocationSearch(
    locWidget,
    ({ lat: la, lng: lo }) => { pickedLat = la; pickedLng = lo; },
    () => {
      closeModal();
      if (_map) {
        _map.getContainer().style.cursor = 'crosshair';
        const infoEl = document.createElement('div');
        infoEl.id = 'map-pick-info';
        infoEl.style.cssText = 'position:absolute;top:10px;left:50%;transform:translateX(-50%);z-index:1000;background:#fff;border:1.5px solid var(--teal);border-radius:20px;padding:6px 16px;font-size:12px;font-weight:700;color:var(--teal);box-shadow:0 2px 8px rgba(0,0,0,.12)';
        infoEl.textContent = '📍 Cliquez sur la carte pour choisir la localisation';
        document.querySelector('.map-col')?.appendChild(infoEl);
      }
      _pendingMapClick = (la, lo) => {
        pickedLat = la; pickedLng = lo;
        if (_map) _map.getContainer().style.cursor = '';
        document.getElementById('map-pick-info')?.remove();
        _openAddDayModalWithCoords(tripId, la, lo);
      };
    }
  );

  // Pre-fill selected label
  locCtrl.setSelected(`📍 ${lat.toFixed(5)}, ${lng.toFixed(5)}`);

  document.getElementById('ad-colors')?.addEventListener('click', e => {
    const sw = e.target.closest('[data-ad-color]');
    if (!sw) return;
    selColor = sw.dataset.adColor;
    document.querySelectorAll('[data-ad-color]').forEach(s => {
      s.classList.toggle('sel', s.dataset.adColor === selColor);
    });
  });

  document.getElementById('ad-cancel')?.addEventListener('click', closeModal);

  document.getElementById('ad-save')?.addEventListener('click', () => {
    const title  = (document.getElementById('ad-title')?.value  || '').trim();
    const region = (document.getElementById('ad-region')?.value || '').trim();
    const date   = (document.getElementById('ad-date')?.value   || '').trim() || null;

    const trip2  = getTrip(tripId);
    const days   = trip2?.days || [];
    const newDay = {
      id:     'd_' + uid(),
      num:    days.length + 1,
      date,
      title:  title || `Jour ${days.length + 1}`,
      region,
      lat:    Number(pickedLat),
      lng:    Number(pickedLng),
      color:  selColor,
      photo:  '',
      items:  [],
    };

    days.push(newDay);
    updateTrip(tripId, { days });
    closeModal();
    _activeDayId = newDay.id;
    _renderDaysList(tripId);
    _renderMiniCal(tripId);
    _refreshMapPins(tripId);
    notify('Jour ajouté !', '✅');
  });
}

// ─── Add Event Modal ──────────────────────────────────────────────────────────

function _openAddEventModal(dayId, tripId) {
  let selType      = 'visit';
  let selTransport = 'car';
  let pickedLat    = null;
  let pickedLng    = null;

  showModal(`
    <h3>＋ Ajouter un événement</h3>

    <div class="fg">
      <label>Type</label>
      <div style="display:flex;gap:6px;flex-wrap:wrap" id="ae-types">
        <button class="tp" data-ae-type="drive"    style="">🚐 Transport</button>
        <button class="tp sel" data-ae-type="visit" style="background:${tCol('visit')};border-color:${tCol('visit')};color:#fff">📍 Visite</button>
        <button class="tp" data-ae-type="activity">⚡ Activité</button>
        <button class="tp" data-ae-type="sleep"    >🌙 Nuit</button>
      </div>
    </div>

    <div id="ae-transport-row" style="display:none" class="fg">
      <label>Mode de transport</label>
      <div style="display:flex;gap:6px;flex-wrap:wrap" id="ae-modes">
        <button class="tp sel" data-ae-mode="car"   style="background:${trCol('car')};border-color:${trCol('car')};color:#fff">🚗 Voiture</button>
        <button class="tp" data-ae-mode="ferry"  >⛴ Ferry</button>
        <button class="tp" data-ae-mode="plane"  >✈ Avion</button>
        <button class="tp" data-ae-mode="bus"    >🚌 Bus</button>
        <button class="tp" data-ae-mode="foot"   >🚶 À pied</button>
        <button class="tp" data-ae-mode="bike"   >🚲 Vélo</button>
      </div>
    </div>

    <div class="fg">
      <label>Description</label>
      <input type="text" id="ae-text" placeholder="Ex : Visite du temple Fushimi Inari…" autocomplete="off">
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 12px">
      <div class="fg">
        <label>Heure</label>
        <input type="time" id="ae-time">
      </div>
      <div class="fg">
        <label>Coût (€)</label>
        <input type="number" id="ae-cost" min="0" step="0.01" placeholder="0">
      </div>
    </div>

    <div id="ae-dest-row" style="display:none" class="fg">
      <label>Destination</label>
      <div id="ae-dest-widget"></div>
    </div>

    <div class="fg">
      <label>Localisation PIN</label>
      <div id="ae-location-widget"></div>
    </div>

    <div class="fg">
      <label>Notes</label>
      <textarea id="ae-notes" class="notes-ta" placeholder="Infos utiles, réservation…" style="min-height:55px"></textarea>
    </div>

    <div class="ma">
      <button class="bc" id="ae-cancel">Annuler</button>
      <button class="bs" id="ae-save">Ajouter</button>
    </div>
  `);

  // Build main location search widget (updates day PIN)
  const locWidgetEl = document.getElementById('ae-location-widget');
  _buildLocationSearch(
    locWidgetEl,
    ({ lat, lng }) => { pickedLat = lat; pickedLng = lng; },
    () => {
      closeModal();
      if (_map) {
        _map.getContainer().style.cursor = 'crosshair';
        const infoEl = document.createElement('div');
        infoEl.id = 'map-pick-info';
        infoEl.style.cssText = 'position:absolute;top:10px;left:50%;transform:translateX(-50%);z-index:1000;background:#fff;border:1.5px solid var(--teal);border-radius:20px;padding:6px 16px;font-size:12px;font-weight:700;color:var(--teal);box-shadow:0 2px 8px rgba(0,0,0,.12)';
        infoEl.textContent = '📍 Cliquez sur la carte pour définir la localisation';
        document.querySelector('.map-col')?.appendChild(infoEl);
      }
      _pendingMapClick = (lat, lng) => {
        pickedLat = lat; pickedLng = lng;
        if (_map) _map.getContainer().style.cursor = '';
        document.getElementById('map-pick-info')?.remove();
        // Reopen modal — simplest approach: just notify and re-open
        _openAddEventModal(dayId, tripId);
        // Note: pickedLat/pickedLng are local; user may search again after reopen
        notify(`📍 ${lat.toFixed(5)}, ${lng.toFixed(5)} sélectionné`, '✅');
      };
    }
  );

  // Transport destination widget (shown only for drive)
  let destLat = null, destLng = null;
  const destWidgetEl = document.getElementById('ae-dest-widget');
  if (destWidgetEl) {
    _buildLocationSearch(
      destWidgetEl,
      ({ lat, lng }) => { destLat = lat; destLng = lng; },
      () => {
        closeModal();
        if (_map) {
          _map.getContainer().style.cursor = 'crosshair';
          const infoEl = document.createElement('div');
          infoEl.id = 'map-pick-info';
          infoEl.style.cssText = 'position:absolute;top:10px;left:50%;transform:translateX(-50%);z-index:1000;background:#fff;border:1.5px solid var(--teal);border-radius:20px;padding:6px 16px;font-size:12px;font-weight:700;color:var(--teal);box-shadow:0 2px 8px rgba(0,0,0,.12)';
          infoEl.textContent = '📍 Cliquez sur la carte pour choisir la destination';
          document.querySelector('.map-col')?.appendChild(infoEl);
        }
        _pendingMapClick = (lat, lng) => {
          destLat = lat; destLng = lng;
          if (_map) _map.getContainer().style.cursor = '';
          document.getElementById('map-pick-info')?.remove();
          _openAddEventModal(dayId, tripId);
          notify(`📍 Destination : ${lat.toFixed(5)}, ${lng.toFixed(5)}`, '✅');
        };
      }
    );
  }

  // Type pill selection
  const typesContainer = document.getElementById('ae-types');
  const transportRow   = document.getElementById('ae-transport-row');
  const destRow        = document.getElementById('ae-dest-row');

  typesContainer?.addEventListener('click', e => {
    const pill = e.target.closest('[data-ae-type]');
    if (!pill) return;
    selType = pill.dataset.aeType;

    typesContainer.querySelectorAll('[data-ae-type]').forEach(p => {
      const t      = p.dataset.aeType;
      const active = t === selType;
      p.classList.toggle('sel', active);
      p.style.background   = active ? tCol(t) : '';
      p.style.borderColor  = active ? tCol(t) : '';
      p.style.color        = active ? '#fff'  : '';
    });

    if (transportRow) transportRow.style.display = selType === 'drive' ? '' : 'none';
    if (destRow)      destRow.style.display       = selType === 'drive' ? '' : 'none';
  });

  // Mode pill selection
  const modesContainer = document.getElementById('ae-modes');
  modesContainer?.addEventListener('click', e => {
    const pill = e.target.closest('[data-ae-mode]');
    if (!pill) return;
    selTransport = pill.dataset.aeMode;

    modesContainer.querySelectorAll('[data-ae-mode]').forEach(p => {
      const m      = p.dataset.aeMode;
      const active = m === selTransport;
      p.classList.toggle('sel', active);
      p.style.background  = active ? trCol(m) : '';
      p.style.borderColor = active ? trCol(m) : '';
      p.style.color       = active ? '#fff'   : '';
    });
  });

  document.getElementById('ae-cancel')?.addEventListener('click', closeModal);

  document.getElementById('ae-save')?.addEventListener('click', () => {
    const text  = (document.getElementById('ae-text')?.value  || '').trim();
    const time  = (document.getElementById('ae-time')?.value  || '').trim() || null;
    const cost  = parseFloat(document.getElementById('ae-cost')?.value || '0') || 0;
    const notes = (document.getElementById('ae-notes')?.value || '').trim();

    const event = {
      id:        'e_' + uid(),
      type:      selType,
      text,
      time,
      cost,
      notes,
      ...(selType === 'drive' ? {
        transport: selTransport,
        destLat,
        destLng,
      } : {}),
    };

    const trip2 = getTrip(tripId);
    if (!trip2) return;
    const day = (trip2.days || []).find(d => d.id === dayId);
    if (!day) return;

    // Store location on the event; update day PIN only if day has none yet
    if (pickedLat != null && pickedLng != null) {
      event.lat = pickedLat;
      event.lng = pickedLng;
      if (day.lat == null) {
        day.lat = pickedLat;
        day.lng = pickedLng;
      }
    }

    day.items.push(event);
    updateTrip(tripId, { days: trip2.days });

    // ── Cost → Budget sync ────────────────────────────────────────────────
    if (cost > 0) {
      const catMap = { drive: 'Transport', visit: 'Activités', activity: 'Activités', sleep: 'Hébergement' };
      const catName = catMap[selType] || null;
      if (catName) {
        const trip3 = getTrip(tripId);
        const budgetCats  = trip3?.budgetCats  || [];
        const budgetLines = trip3?.budgetLines || [];
        const cat = budgetCats.find(c => c.name === catName);
        if (cat) {
          const newLine = {
            id:     'bl_' + uid(),
            catId:  cat.id,
            desc:   text,
            amount: cost,
            note:   'Via Carte & Planning',
            dayId,
            source: 'event',
            eventId: event.id,
          };
          updateTrip(tripId, { budgetLines: [...budgetLines, newLine] });
        }
      }
    }
    // ─────────────────────────────────────────────────────────────────────

    closeModal();
    _renderDaysList(tripId);
    _refreshMapPins(tripId);
    updateTopStats(tripId);
    notify('Événement ajouté !', '✅');
  });
}

// ─── HTML escape ──────────────────────────────────────────────────────────────

function _esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
