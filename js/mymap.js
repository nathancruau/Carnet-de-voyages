/* ============================================================
   CARNET DE VOYAGES — MyMap: Global trip map (rich edition)
   ============================================================
   Layout: full-screen split — 280px left sidebar + Leaflet map
   Exports: renderMyMap(), destroyMyMap()
   ============================================================ */

import { getTrips, TRIP_TYPES, getPinTypes } from './store.js';
import { fmtDate, fmtDateShort } from './utils.js';

// ── PIN type helper (dynamic from settings) ────────────────────────────────────

function _pinTypeMap() {
  const map = {};
  for (const pt of getPinTypes()) map[pt.key] = pt.emoji;
  return map;
}

// ── Module-level state ─────────────────────────────────────────────────────────
let _map             = null;   // Leaflet map instance
let _markers         = [];     // { marker, trip, entry } objects currently on the map
let _allPins         = [];     // All { trip, entry, lat, lng } built from store
let _filters         = { type: 'all', pinType: 'all', tripId: 'all' };
let _collapsedGroups = new Set();  // trip ids whose sidebar group is folded
let _infoPanelEl     = null;   // info panel DOM element

// ── Country color mapping ──────────────────────────────────────────────────────

/** Extract ISO-2 country code from a flag emoji. */
function _isoFromFlag(flag) {
  if (!flag) return '';
  const pts = [...flag]
    .map(c => c.codePointAt(0))
    .filter(cp => cp >= 0x1F1E6 && cp <= 0x1F1FF);
  if (pts.length < 2) return '';
  return pts.slice(0, 2).map(cp => String.fromCharCode(cp - 0x1F1E6 + 65)).join('');
}

/** 12 visually distinct colors for country hashing. */
const _COLOR_PALETTE = [
  '#e85d3e', '#0284c7', '#16a34a', '#d97706',
  '#7c3aed', '#db2777', '#0d9488', '#f59e0b',
  '#06b6d4', '#8b5cf6', '#65a30d', '#dc2626',
];

/** Deterministic hash of a string → 0-based index in palette. */
function _hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % _COLOR_PALETTE.length;
}

/** Cache: ISO code → hex color. */
const _countryColors = {};

/** Return a stable color for a given flag emoji. */
function _colorForFlag(flag) {
  const iso = _isoFromFlag(flag) || flag || '??';
  if (!_countryColors[iso]) {
    _countryColors[iso] = _COLOR_PALETTE[_hashStr(iso)];
  }
  return _countryColors[iso];
}

// ── HTML escape ───────────────────────────────────────────────────────────────

function _esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Pin icon builder ───────────────────────────────────────────────────────────

function _makeIcon(color, size = 13, emoji = null) {
  if (emoji) {
    return L.divIcon({
      className: '',
      html: `<div style="background:${color};border:2px solid #fff;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:16px;box-shadow:0 1px 6px rgba(0,0,0,.4)">${emoji}</div>`,
      iconSize:    [28, 28],
      iconAnchor:  [14, 14],
      popupAnchor: [0, -20],
    });
  }
  return L.divIcon({
    className: '',
    html: `<div style="
      width:${size}px;height:${size}px;border-radius:50%;
      background:${color};
      border:2.5px solid #fff;
      box-shadow:0 1px 6px rgba(0,0,0,.45);
      cursor:pointer;
      transition:transform .15s;
    "></div>`,
    iconSize:    [size, size],
    iconAnchor:  [size / 2, size / 2],
    popupAnchor: [0, -(size / 2 + 6)],
  });
}

// ── Info panel (rich display on pin/legend click) ──────────────────────────────

function _mmShowInfo(trip, entry) {
  if (!_infoPanelEl) return;

  const photosHtml = (entry.photos || []).length > 0
    ? `<div style="display:flex;gap:5px;flex-wrap:nowrap;overflow-x:auto;padding:2px 0 6px;scrollbar-width:thin">
        ${entry.photos.slice(0, 6).map(p =>
          `<img src="${_esc(p.url)}" onclick="window.open(this.src,'_blank')"
            style="height:80px;min-width:80px;border-radius:8px;object-fit:cover;cursor:pointer;flex-shrink:0;border:1px solid var(--c3)"
            onerror="this.style.display='none'">`
        ).join('')}
       </div>`
    : '';

  const _ptm    = _pinTypeMap();
  const typeEmoji = (entry.pinType && _ptm[entry.pinType]) ? _ptm[entry.pinType] : '';
  const color   = _colorForFlag(trip.flag);

  _infoPanelEl.innerHTML = `
    <div style="padding:12px 14px;border-bottom:1px solid var(--c3);display:flex;align-items:flex-start;gap:8px;flex-shrink:0">
      <div style="flex:1;min-width:0">
        <div style="font-size:11px;font-weight:700;color:${color};margin-bottom:2px">${_esc(trip.flag || '')} ${_esc(trip.name)}</div>
        <div style="font-size:14px;font-weight:700;color:var(--ink)">${typeEmoji} ${_esc(entry.title)}</div>
        ${entry.dayLabel ? `<div style="font-size:11px;color:var(--ink4);margin-top:1px">📅 ${_esc(entry.dayLabel)}</div>` : ''}
        ${entry.date    ? `<div style="font-size:11px;color:var(--ink4)">${fmtDate(entry.date)}</div>` : ''}
      </div>
      <button onclick="_mmCloseInfo()"
        style="background:none;border:none;cursor:pointer;color:var(--ink4);font-size:16px;padding:0;line-height:1;flex-shrink:0">✕</button>
    </div>
    <div style="padding:12px 14px;flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:8px">
      ${entry._validated ? `<div style="font-size:11px;font-weight:700;color:#16a34a">✓ Activité validée</div>` : ''}
      ${entry.weather    ? `<div style="font-size:24px">${entry.weather}</div>` : ''}
      ${photosHtml}
      ${entry.content    ? `<div style="font-size:12px;color:var(--ink2);white-space:pre-wrap;line-height:1.5">${_esc(entry.content)}</div>` : ''}
      ${entry.amount     ? `<div style="font-size:12px;color:var(--ink3)">💶 ${entry.amount} €</div>` : ''}
      ${!entry._validated && !entry.weather && !photosHtml && !entry.content
        ? `<div style="font-size:12px;color:var(--ink4)">Aucune information enregistrée pour ce PIN.</div>` : ''}
      <button onclick="window.navigateToTrip && window.navigateToTrip('${trip.id}')"
        style="margin-top:6px;width:100%;background:var(--teal);color:#fff;border:none;border-radius:8px;
               padding:8px;font-size:12px;font-weight:700;cursor:pointer;font-family:var(--fn)">
        Ouvrir le voyage →
      </button>
    </div>
  `;

  _infoPanelEl.style.display = 'flex';
}

// ── Build the flat pin list from store ────────────────────────────────────────

function _buildAllPins() {
  _allPins = [];
  for (const trip of getTrips()) {
    // Planning item pins (source of truth for journal/carnet)
    for (const day of (trip.days || [])) {
      for (const item of (day.items || [])) {
        const lat = parseFloat(item.lat);
        const lng = parseFloat(item.lng);
        if (!isNaN(lat) && !isNaN(lng)) {
          const jd = item.journalData || {};
          const entry = {
            id:         item.id,
            title:      item.text  || '—',
            date:       day.date   || null,
            dayLabel:   `Jour ${day.num}${day.title ? ' · ' + day.title : ''}`,
            pinType:    item.type  || null,
            lat, lng,
            photos:     (jd.photos || []).map(p => ({ url: p })),
            content:    jd.notes   || '',
            weather:    jd.weather || '',
            amount:     jd.amount  || 0,
            tags:       [],
            _validated: !!jd.validated,
          };
          _allPins.push({ trip, entry, lat, lng });
        }
      }
    }
    // Legacy journal entries (backward compat)
    for (const entry of (trip.journalEntries || [])) {
      const lat = parseFloat(entry.lat);
      const lng = parseFloat(entry.lng);
      if (!isNaN(lat) && !isNaN(lng)) {
        _allPins.push({ trip, entry: { ...entry, lat, lng }, lat, lng });
      }
    }
  }
}

// ── Filter helpers ─────────────────────────────────────────────────────────────

function _visiblePins() {
  return _allPins.filter(({ trip, entry }) => {
    if (_filters.type !== 'all' && trip.type !== _filters.type) return false;
    if (_filters.pinType !== 'all') {
      if (entry?.pinType !== _filters.pinType) return false;
    }
    if (_filters.tripId !== 'all' && trip.id !== _filters.tripId) return false;
    return true;
  });
}

// ── Sidebar tree ───────────────────────────────────────────────────────────────

function _buildSidebarTree(pins) {
  // Group pins by trip id
  const tripMap = new Map();
  for (const pin of pins) {
    const id = pin.trip.id;
    if (!tripMap.has(id)) tripMap.set(id, { trip: pin.trip, pins: [] });
    tripMap.get(id).pins.push(pin);
  }

  if (tripMap.size === 0) {
    // Show all trips even if no visible pins (so user can click to filter)
    const allTrips = new Map();
    for (const { trip } of _allPins) {
      if (!allTrips.has(trip.id)) allTrips.set(trip.id, { trip, pins: [] });
      allTrips.get(trip.id).pins.push(..._allPins.filter(p => p.trip.id === trip.id));
    }
    if (allTrips.size === 0) {
      return `<div style="padding:24px 16px;text-align:center;color:var(--ink4);font-size:12px">
        Aucun voyage à afficher.<br>Ajoutez des entrées de journal avec des coordonnées GPS.
      </div>`;
    }
  }

  // Merge: always show all trips in sidebar (use allPins to build trip list), but pin rows show only visible pins
  const allTripMap = new Map();
  for (const { trip } of _allPins) {
    if (!allTripMap.has(trip.id)) allTripMap.set(trip.id, { trip, pins: [] });
  }
  for (const pin of pins) {
    allTripMap.get(pin.trip.id)?.pins.push(pin);
  }

  let html = '';
  for (const { trip, pins: tPins } of allTripMap.values()) {
    const typeInfo    = TRIP_TYPES[trip.type] || TRIP_TYPES.voyage;
    const color       = _colorForFlag(trip.flag);
    const groupId     = 'mm-grp-' + trip.id;
    const isCollapsed = _collapsedGroups.has(trip.id);
    const isFocused   = _filters.tripId === trip.id;

    const pinsHtml = tPins.map(pin => {
      const _ptm = _pinTypeMap();
      const pinEmoji = (pin.entry?.pinType && _ptm[pin.entry.pinType])
        ? _ptm[pin.entry.pinType]
        : '📍';
      const label = pin.entry.title || (pin.entry.date ? fmtDateShort(pin.entry.date) : 'Sans titre');
      const dateStr = pin.entry.date ? fmtDateShort(pin.entry.date) : '';
      return `
        <div class="mm-pin-row"
             data-lat="${pin.lat}" data-lng="${pin.lng}" data-tripid="${trip.id}"
             onclick="_mmFlyTo(${pin.lat}, ${pin.lng}, '${trip.id}')">
          <span style="color:${color};flex-shrink:0">${pinEmoji}</span>
          <span class="mm-pin-label">${label}</span>
          ${dateStr ? `<span style="font-size:9px;color:var(--ink4);flex-shrink:0;white-space:nowrap">${dateStr}</span>` : ''}
        </div>`;
    }).join('');

    html += `
      <div class="mm-trip-group${isCollapsed ? ' collapsed' : ''}" id="${groupId}">
        <div class="mm-trip-header">
          <span class="mm-trip-chevron" onclick="_mmFoldGroup('${trip.id}')" title="Plier/déplier">▼</span>
          <span style="font-size:15px">${typeInfo.icon}</span>
          <span class="mm-trip-name${isFocused ? ' mm-trip-focused' : ''}"
                onclick="_mmFocusTrip('${trip.id}')"
                title="${isFocused ? 'Voir tous les voyages' : 'Filtrer sur ce voyage'}"
                style="cursor:pointer">${trip.flag || ''} ${trip.name}</span>
          <span class="mm-pin-count">${tPins.length}</span>
        </div>
        <div class="mm-trip-body">${pinsHtml || '<div style="padding:4px 12px 4px 28px;font-size:10px;color:var(--ink4)">Aucun PIN visible</div>'}</div>
      </div>`;
  }
  return html;
}

// ── Full sidebar HTML ──────────────────────────────────────────────────────────

function _sidebarHtml(pins) {
  const typeButtons = [
    { key: 'all',     label: 'Tous' },
    { key: 'voyage',  label: 'Voyages' },
    { key: 'weekend', label: 'Week-ends' },
    { key: 'sortie',  label: 'Sorties' },
  ].map(({ key, label }) =>
    `<button class="mm-type-btn${_filters.type === key ? ' active' : ''}"
             onclick="_mmSetType('${key}')">${label}</button>`
  ).join('');

  const pinTypeFilters = [
    { val: 'all', label: 'Tous' },
    ...getPinTypes().map(pt => ({ val: pt.key, label: pt.emoji })),
  ].map(({ val, label }) =>
    `<button class="mm-type-btn${_filters.pinType === val ? ' active' : ''}"
             onclick="_mmSetPinType('${val}')">${label}</button>`
  ).join('');

  const tree = _buildSidebarTree(pins);

  return `
    <div class="mm-sidebar-header">
      <div style="font-family:'Lora',serif;font-size:17px;font-weight:700;color:var(--ink)">🗺 MyMap</div>
      <button class="back-btn" style="margin-left:auto;font-size:11px;padding:4px 10px"
              onclick="goHome()">← Bibliothèque</button>
    </div>

    <div class="mm-filter-row">
      <div class="mm-type-group">${typeButtons}</div>
    </div>
    <div class="mm-filter-row">
      <div style="font-size:11px;color:var(--ink4);font-weight:600;margin-right:4px;flex-shrink:0">Lieu :</div>
      <div class="mm-type-group">${pinTypeFilters}</div>
    </div>

    <div class="mm-tree" id="mm-tree">
      ${tree}
    </div>

    <div class="mm-sidebar-footer">
      <button class="mm-export-btn" onclick="_mmExportKml()">⬇ Exporter KML</button>
    </div>
  `;
}

// ── Redraw markers on the map ──────────────────────────────────────────────────

function _redrawMarkers(pins) {
  if (!_map) return;

  // Remove old markers
  for (const { marker } of _markers) {
    marker.remove();
  }
  _markers = [];

  const bounds = [];

  for (const pin of pins) {
    const color  = _colorForFlag(pin.trip.flag);
    const emoji  = _pinTypeMap()[pin.entry?.pinType] || null;
    const marker = L.marker([pin.lat, pin.lng], { icon: _makeIcon(color, 14, emoji) });
    marker.on('click', () => _mmShowInfo(pin.trip, pin.entry));
    marker.addTo(_map);
    _markers.push({ marker, trip: pin.trip, entry: pin.entry });
    bounds.push([pin.lat, pin.lng]);
  }

  // Fit map view
  if (bounds.length > 0) {
    if (bounds.length === 1) {
      _map.setView(bounds[0], 10);
    } else {
      try {
        _map.fitBounds(bounds, { padding: [48, 48], maxZoom: 12 });
      } catch (_) {
        _map.setView(bounds[0], 8);
      }
    }
  }
}

// ── Update (re-filter, re-render sidebar + markers) ───────────────────────────

function _update() {
  const pins = _visiblePins();

  // Update sidebar tree only
  const treeEl = document.getElementById('mm-tree');
  if (treeEl) treeEl.innerHTML = _buildSidebarTree(pins);

  // Redraw markers
  _redrawMarkers(pins);
}

// ── KML export ─────────────────────────────────────────────────────────────────

function _mmExportKml() {
  const pins = _visiblePins();

  const placemarks = pins.map(({ trip, entry, lat, lng }) => {
    const name = `${trip.name}${entry.title ? ' – ' + entry.title : ''}`;
    const desc = [
      trip.flag || '',
      trip.type,
      entry.date ? fmtDate(entry.date) : '',
    ].filter(Boolean).join(' · ');
    return `  <Placemark>
    <name>${_escXml(name)}</name>
    <description>${_escXml(desc)}</description>
    <Point><coordinates>${lng},${lat},0</coordinates></Point>
  </Placemark>`;
  }).join('\n');

  const kmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>Carnet de Voyages</name>
${placemarks}
</Document>
</kml>`;

  const blob = new Blob([kmlContent], { type: 'application/vnd.google-earth.kml+xml' });
  const a = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = 'carnet-voyages.kml';
  a.click();
}

function _escXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ── Global callbacks used in inline onclick= ──────────────────────────────────

window._mmFlyTo = function(lat, lng, tripId) {
  if (!_map) return;
  _map.flyTo([lat, lng], 12, { duration: 1 });
  // Find pin and open info panel
  const pin = _allPins.find(p => p.trip.id === tripId && p.lat == lat && p.lng == lng);
  if (pin) setTimeout(() => _mmShowInfo(pin.trip, pin.entry), 500);
};

window._mmCloseInfo = function() {
  if (_infoPanelEl) _infoPanelEl.style.display = 'none';
};

/** Toggle fold/unfold of a trip group in the sidebar (no filter change). */
window._mmFoldGroup = function(tripId) {
  if (_collapsedGroups.has(tripId)) {
    _collapsedGroups.delete(tripId);
  } else {
    _collapsedGroups.add(tripId);
  }
  const groupEl = document.getElementById('mm-grp-' + tripId);
  if (groupEl) {
    groupEl.classList.toggle('collapsed', _collapsedGroups.has(tripId));
  }
};

/** Toggle map filter to show only this trip (click again to show all). */
window._mmFocusTrip = function(tripId) {
  _filters.tripId = (_filters.tripId === tripId) ? 'all' : tripId;
  const sidebar = document.getElementById('mm-sidebar');
  if (sidebar) {
    const pins = _visiblePins();
    sidebar.innerHTML = _sidebarHtml(pins);
  }
  _update();
};

window._mmSetType = function(key) {
  _filters.type = key;
  const sidebar = document.getElementById('mm-sidebar');
  if (sidebar) {
    const pins = _visiblePins();
    sidebar.innerHTML = _sidebarHtml(pins);
  }
  _update();
};

window._mmSetPinType = function(val) {
  _filters.pinType = val;
  const sidebar = document.getElementById('mm-sidebar');
  if (sidebar) {
    const pins = _visiblePins();
    sidebar.innerHTML = _sidebarHtml(pins);
  }
  _update();
};

window._mmExportKml = _mmExportKml;

// ── Public API ─────────────────────────────────────────────────────────────────

export function renderMyMap() {
  const wrap = document.getElementById('mymap-wrap');
  if (!wrap) return;

  // Reset filters to default
  _filters         = { type: 'all', pinType: 'all', tripId: 'all' };
  _collapsedGroups = new Set();

  // Build pin data
  _buildAllPins();
  const pins = _visiblePins();

  // Full layout
  wrap.className = 'mymap-wrap';
  wrap.style.cssText = '';

  wrap.innerHTML = `
    <div class="mm-sidebar" id="mm-sidebar">
      ${_sidebarHtml(pins)}
    </div>
    <div class="map-col" id="mm-map-col">
      <button class="lp-toggle-btn" id="mm-toggle" title="Masquer / afficher le panneau">◀</button>
      <div id="mymap" style="width:100%;height:100%"></div>
      <div id="mm-info-panel" class="mm-info-panel" style="display:none;flex-direction:column"></div>
    </div>
  `;

  // Wire sidebar toggle button
  const mmToggle = document.getElementById('mm-toggle');
  if (mmToggle) {
    mmToggle.addEventListener('click', () => {
      const sidebar = document.getElementById('mm-sidebar');
      if (!sidebar) return;
      const collapsed = sidebar.classList.toggle('collapsed');
      mmToggle.textContent = collapsed ? '▶' : '◀';
      setTimeout(() => { if (_map) _map.invalidateSize(); }, 280);
    });
  }

  // Auto-collapse on mobile so the map is immediately usable
  if (window.innerWidth <= 768) {
    const sidebar = document.getElementById('mm-sidebar');
    if (sidebar) {
      sidebar.classList.add('collapsed');
      if (mmToggle) mmToggle.textContent = '▶';
    }
  }

  // Wire info panel reference
  _infoPanelEl = null;

  // Destroy any stale map instance first
  destroyMyMap();

  // Defer Leaflet init so #mymap has layout dimensions
  requestAnimationFrame(() => {
    const mapEl = document.getElementById('mymap');
    if (!mapEl) return;

    _infoPanelEl = document.getElementById('mm-info-panel');

    _map = L.map('mymap', {
      center:      [46.5, 2.5],
      zoom:        5,
      zoomControl: true,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(_map);

    _redrawMarkers(pins);
  });
}

export function destroyMyMap() {
  if (_map) {
    try { _map.remove(); } catch (_) { /* already removed */ }
    _map = null;
  }
  _markers = [];
}
