/* ============================================================
   CARNET DE VOYAGES — MyMap: Global trip map
   ============================================================ */

import { getTrips, TRIP_TYPES } from './store.js';
import { typeBadge, fmtDate, fmtDateShort } from './utils.js';

// ── Module-level Leaflet instance ──────────────────────────────────────────────
let _map = null;

// ── Helpers ────────────────────────────────────────────────────────────────────

function _typeColor(type) {
  return (TRIP_TYPES[type] || TRIP_TYPES.voyage).color;
}

/**
 * Create a filled circular Leaflet divIcon with the given color.
 */
function _makeIcon(color, size = 13) {
  return L.divIcon({
    className: '',
    html: `<div style="
      width:${size}px;height:${size}px;border-radius:50%;
      background:${color};
      border:2.5px solid #fff;
      box-shadow:0 1px 5px rgba(0,0,0,.4);
      cursor:pointer;
    "></div>`,
    iconSize:    [size, size],
    iconAnchor:  [size / 2, size / 2],
    popupAnchor: [0, -(size / 2 + 5)],
  });
}

/**
 * Count chips displayed next to the legend.
 */
function _countChipsHtml(trips) {
  const counts = { voyage: 0, weekend: 0, sortie: 0 };
  for (const t of trips) {
    if (Object.prototype.hasOwnProperty.call(counts, t.type)) counts[t.type]++;
  }

  return Object.entries(counts)
    .map(([type, n]) => {
      const info = TRIP_TYPES[type];
      return `
        <div style="display:flex;align-items:center;gap:4px;font-size:11px;font-weight:700;color:var(--ink3)">
          <div style="width:8px;height:8px;border-radius:50%;background:${info.color}"></div>
          ${n}
        </div>
      `;
    })
    .join('');
}

/**
 * Build popup HTML for a marker.
 * @param {object} trip
 * @param {object|null} day  — specific day (may be null for a trip-level pin)
 */
function _popupHtml(trip, day) {
  const dates = trip.startDate
    ? `${fmtDateShort(trip.startDate)}${trip.endDate ? ` → ${fmtDate(trip.endDate)}` : ''}`
    : '—';

  const companions = (trip.companions || []).map(c => c.name).join(', ') || 'Solo';

  // Photo: prefer day photo, then trip cover photo
  let photoHtml = '';
  const dayPhoto = day && Array.isArray(day.photos) && day.photos.length > 0
    ? day.photos[0]
    : null;
  const imgSrc = dayPhoto || trip.photo || null;
  if (imgSrc) {
    photoHtml = `
      <img src="${imgSrc}"
           style="width:100%;height:72px;object-fit:cover;border-radius:6px;margin-bottom:6px;display:block"
           onerror="this.style.display='none'"
           alt="">
    `;
  }

  // Day-level details (city / title)
  const dayLine = day
    ? `<div style="font-size:10px;color:var(--ink4);margin-bottom:3px">
         ${day.title || ''}${day.region ? ` · ${day.region}` : ''}
       </div>`
    : '';

  return `
    <div style="padding:10px;min-width:180px;max-width:220px">
      ${photoHtml}
      <div class="mymap-popup-title">${trip.flag || '🌍'} ${trip.name || 'Sans titre'}</div>
      ${dayLine}
      <div class="mymap-popup-meta">${typeBadge(trip.type)} · ${dates}</div>
      <div style="font-size:10px;color:var(--ink3);margin-bottom:8px">${companions}</div>
      <button class="mymap-popup-btn"
              onclick="navigateToTrip('${trip.id}')">Ouvrir →</button>
    </div>
  `;
}

// ── Add markers to the map ─────────────────────────────────────────────────────

function _addMarkers(trips) {
  if (!_map) return;

  const bounds = [];

  for (const trip of trips) {
    const color = _typeColor(trip.type);
    const days  = Array.isArray(trip.days) ? trip.days : [];

    // Collect days with coordinates
    const geoDays = days.filter(d => d.lat != null && d.lng != null);

    if (geoDays.length === 0) {
      // No geocoordinated days → skip (no geocoding per spec)
      continue;
    }

    for (const day of geoDays) {
      const lat = parseFloat(day.lat);
      const lng = parseFloat(day.lng);
      if (isNaN(lat) || isNaN(lng)) continue;

      const marker = L.marker([lat, lng], { icon: _makeIcon(color) });
      marker.bindPopup(_popupHtml(trip, day), {
        maxWidth: 240,
      });
      marker.addTo(_map);
      bounds.push([lat, lng]);
    }
  }

  // Fit view to all pins, or show default France view
  if (bounds.length > 0) {
    if (bounds.length === 1) {
      _map.setView(bounds[0], 10);
    } else {
      try {
        _map.fitBounds(bounds, { padding: [48, 48], maxZoom: 12 });
      } catch (_) {
        // fitBounds can fail if map not yet sized
        _map.setView(bounds[0], 8);
      }
    }
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

export function renderMyMap() {
  const wrap = document.getElementById('mymap-wrap');
  if (!wrap) return;

  const trips = getTrips();

  wrap.innerHTML = `
    <div class="mymap-header">
      <button class="back-btn" onclick="goHome()">← Bibliothèque</button>
      <div class="mymap-title">🗺 MyMap — Tous mes voyages</div>
      <div class="mymap-legend">
        <div class="legend-item">
          <div class="legend-dot" style="background:#0d9488"></div>Voyages
        </div>
        <div class="legend-item">
          <div class="legend-dot" style="background:#7c3aed"></div>Week-ends
        </div>
        <div class="legend-item">
          <div class="legend-dot" style="background:#d97706"></div>Sorties
        </div>
        <div class="legend-item">
          <div class="legend-dot" style="background:#9c9890"></div>À planifier
        </div>
      </div>
      <div style="display:flex;gap:10px;margin-left:10px;align-items:center">
        ${_countChipsHtml(trips)}
      </div>
    </div>
    <div id="mymap" style="flex:1;width:100%;"></div>
  `;

  // Destroy any previous map instance first
  destroyMyMap();

  // Defer Leaflet init to next frame so #mymap has layout dimensions
  requestAnimationFrame(() => {
    const mapEl = document.getElementById('mymap');
    if (!mapEl) return;

    _map = L.map('mymap', {
      center:      [46.5, 2.5],
      zoom:        5,
      zoomControl: true,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(_map);

    _addMarkers(trips);
  });
}

export function destroyMyMap() {
  if (_map) {
    try { _map.remove(); } catch (_) { /* already removed */ }
    _map = null;
  }
}
