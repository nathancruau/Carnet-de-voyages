/* ============================================================
   CARNET DE VOYAGES — Sortie detail view
   ============================================================ */

import { getTrip, getEventTypes } from '../store.js';

let _map    = null;
let _marker = null;
let _tripId = null;

function _esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

export function renderSortie(tripId) {
  _tripId = tripId;
  const trip = getTrip(tripId);
  if (!trip) return;

  const panels = document.getElementById('panels');
  if (!panels) return;

  panels.innerHTML = `
    <div class="panel active" id="panel-sortie">
      <div class="sortie-layout">
        <div class="sortie-info-panel" id="sortie-info-panel">
          ${_sortieInfoHtml(trip)}
        </div>
        <div class="sortie-map-wrap">
          <div id="sortie-map"></div>
        </div>
      </div>
    </div>
  `;

  _initMap(trip);
  _attachListeners();
}

export function destroySortieMap() {
  if (_map) {
    try { _map.remove(); } catch (_) {}
    _map   = null;
    _marker = null;
  }
}

function _sortieInfoHtml(trip) {
  const pin        = trip.pin || {};
  const eventTypes = getEventTypes();
  const et         = eventTypes.find(e => e.key === (pin.pinType || 'visit')) || eventTypes[0];

  const dateStr = pin.date
    ? new Date(pin.date + 'T12:00:00').toLocaleDateString('fr-FR', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
      })
    : 'Date non définie';

  const hasCoords = pin.lat != null && pin.lng != null;

  return `
    <div class="si-inner">
      <div class="si-head">
        <div class="si-type-badge" style="background:${et.color}22;color:${et.color};border:1.5px solid ${et.color}55">
          ${et.emoji} ${et.label}
        </div>
        <button class="si-edit-btn" id="si-edit-btn" title="Modifier cette sortie">✎ Modifier</button>
      </div>

      <h2 class="si-title">${_esc(trip.name || 'Sortie')}</h2>

      ${trip.photo ? `<img class="si-photo" src="${_esc(trip.photo)}" alt="" onerror="this.style.display='none'">` : ''}

      <div class="si-meta">
        <div class="si-meta-row">
          <span class="si-ic">📅</span>
          <span class="si-val">${dateStr}${pin.time ? ' · <b>' + _esc(pin.time) + '</b>' : ''}</span>
        </div>
        ${trip.destination ? `
        <div class="si-meta-row">
          <span class="si-ic">📍</span>
          <span class="si-val">${_esc(trip.destination)}</span>
        </div>` : ''}
        ${pin.weather ? `
        <div class="si-meta-row">
          <span class="si-ic">🌡</span>
          <span class="si-val si-weather">${_esc(pin.weather)}</span>
        </div>` : ''}
        ${pin.cost ? `
        <div class="si-meta-row">
          <span class="si-ic">💶</span>
          <span class="si-val"><b>${Number(pin.cost).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b> ${_esc(pin.currency || 'EUR')}</span>
        </div>` : ''}
      </div>

      ${pin.description ? `
      <div class="si-desc">
        <div class="si-desc-lbl">Notes</div>
        <div class="si-desc-text">${_esc(pin.description).replace(/\n/g, '<br>')}</div>
      </div>` : ''}

      ${!hasCoords ? `<div class="si-no-coords">Aucune position définie — modifiez pour ajouter un lieu sur la carte.</div>` : ''}
    </div>
  `;
}

function _initMap(trip) {
  destroySortieMap();
  const container = document.getElementById('sortie-map');
  if (!container) return;

  const pin       = trip.pin || {};
  const hasCoords = pin.lat != null && pin.lng != null;
  const center    = hasCoords ? [pin.lat, pin.lng] : [20, 0];
  const zoom      = hasCoords ? 13 : 2;

  requestAnimationFrame(() => {
    try {
      _map = L.map('sortie-map', { zoomControl: true }).setView(center, zoom);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a>',
        maxZoom: 19,
      }).addTo(_map);

      if (hasCoords) {
        const eventTypes = getEventTypes();
        const et = eventTypes.find(e => e.key === (pin.pinType || 'visit')) || eventTypes[0];
        _marker = L.marker([pin.lat, pin.lng], {
          icon: L.divIcon({
            className: '',
            html: `<div class="wp-pin"><div class="pin-c" style="background:${et.color}">${et.emoji}</div><div class="pin-tail" style="background:${et.color}"></div></div>`,
            iconSize:  [36, 42],
            iconAnchor:[18, 42],
          })
        }).addTo(_map);
        if (trip.name) {
          _marker.bindPopup(
            `<b>${_esc(trip.name)}</b>${trip.destination ? '<br><small>' + _esc(trip.destination) + '</small>' : ''}`
          ).openPopup();
        }
      }
    } catch (e) {
      console.warn('[sortie] map init error', e);
    }
  });
}

function _attachListeners() {
  document.getElementById('si-edit-btn')?.addEventListener('click', () => {
    if (typeof window._openEditTripModal === 'function') {
      window._openEditTripModal(_tripId);
    }
  });
}
