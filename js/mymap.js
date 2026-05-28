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
let _map          = null;   // Leaflet map instance
let _markers      = [];     // { marker, trip, entry } objects currently on the map
let _allPins      = [];     // All { trip, entry, lat, lng } built from store
let _filters      = { type: 'all', country: 'all', status: 'done', pinType: 'all', tripId: 'all' };

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

// ── Pin icon builder ───────────────────────────────────────────────────────────

function _makeIcon(color, size = 13, emoji = null) {
  if (emoji) {
    return L.divIcon({
      className: '',
      html: `<div style="background:${color};border:2px solid #fff;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:16px;box-shadow:0 1px 6px rgba(0,0,0,.4)"><span style="filter:grayscale(1) brightness(2)">${emoji}</span></div>`,
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

// ── Popup HTML ─────────────────────────────────────────────────────────────────

function _popupHtml(trip, entry) {
  const imgSrc = entry.photos?.[0]?.url || trip.photo || null;
  const photoHtml = imgSrc
    ? `<img src="${imgSrc}"
             style="width:100%;height:68px;object-fit:cover;border-radius:6px;margin-bottom:7px;display:block"
             onerror="this.style.display='none'" alt="">`
    : '';

  const entryTitle = entry.title || 'Sans titre';
  const entryDate  = entry.date ? `<span style="color:var(--ink4)">${fmtDate(entry.date)}</span>` : '';

  const contentSnippet = entry.content ? entry.content.slice(0, 100) : '';
  const contentHtml = contentSnippet
    ? `<div style="font-size:10px;color:var(--ink3);margin:4px 0 5px;white-space:pre-wrap;overflow:hidden">${contentSnippet}${entry.content.length > 100 ? '…' : ''}</div>`
    : '';

  const tags = (entry.tags || []).slice(0, 3);
  const tagsHtml = tags.length > 0
    ? `<div style="margin:4px 0 5px;display:flex;gap:3px;flex-wrap:wrap">
        ${tags.map(t => `<span style="font-size:9px;background:var(--tl);color:var(--td);border-radius:999px;padding:1px 6px;font-weight:700">${t}</span>`).join('')}
       </div>`
    : '';

  return `
    <div style="padding:10px 12px;min-width:185px;max-width:230px;font-family:'Nunito',sans-serif">
      ${photoHtml}
      <div class="mymap-popup-title">${trip.flag || '🌍'} ${trip.name || 'Sans titre'}</div>
      <div style="font-size:11px;font-weight:600;color:var(--ink2);margin-bottom:2px">${entryTitle}</div>
      ${entryDate ? `<div class="mymap-popup-meta">${entryDate}</div>` : ''}
      ${contentHtml}
      ${tagsHtml}
      <button class="mymap-popup-btn"
              onclick="window.navigateToTrip && window.navigateToTrip('${trip.id}')">Ouvrir →</button>
    </div>
  `;
}

// ── Build the flat pin list from store ────────────────────────────────────────

function _buildAllPins() {
  _allPins = [];
  for (const trip of getTrips()) {
    const entries = Array.isArray(trip.journalEntries) ? trip.journalEntries : [];
    for (const entry of entries) {
      const lat = parseFloat(entry.lat);
      const lng = parseFloat(entry.lng);
      if (!isNaN(lat) && !isNaN(lng)) {
        _allPins.push({ trip, entry, lat, lng });
      }
    }
  }
}

// ── Filter helpers ─────────────────────────────────────────────────────────────

function _visiblePins() {
  return _allPins.filter(({ trip, entry }) => {
    if (_filters.type !== 'all' && trip.type !== _filters.type) return false;
    if (_filters.country !== 'all') {
      const iso = _isoFromFlag(trip.flag);
      if (iso !== _filters.country) return false;
    }
    if (_filters.status === 'done' && trip.status !== 'done') return false;
    if (_filters.pinType !== 'all') {
      if (entry?.pinType !== _filters.pinType) return false;
    }
    if (_filters.tripId !== 'all' && trip.id !== _filters.tripId) return false;
    return true;
  });
}

/** Unique sorted list of { iso, flag } for country dropdown. */
function _countryOptions() {
  const seen = new Map();
  for (const { trip } of _allPins) {
    const iso = _isoFromFlag(trip.flag);
    if (iso && !seen.has(iso)) {
      seen.set(iso, trip.flag);
    }
  }
  return [...seen.entries()].map(([iso, flag]) => ({ iso, flag }));
}

/** Unique trips that have at least one pin. */
function _tripsWithPins() {
  const seen = new Map();
  for (const { trip } of _allPins) {
    if (!seen.has(trip.id)) seen.set(trip.id, trip);
  }
  return [...seen.values()];
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
    return `<div style="padding:24px 16px;text-align:center;color:var(--ink4);font-size:12px">
      Aucun voyage à afficher.<br>Ajoutez des entrées de journal avec des coordonnées GPS.
    </div>`;
  }

  let html = '';
  for (const { trip, pins: tPins } of tripMap.values()) {
    const typeInfo  = TRIP_TYPES[trip.type] || TRIP_TYPES.voyage;
    const color     = _colorForFlag(trip.flag);
    const groupId   = 'mm-grp-' + trip.id;

    const pinsHtml = tPins.map(pin => {
      const _ptm = _pinTypeMap();
      const pinEmoji = (pin.entry?.pinType && _ptm[pin.entry.pinType])
        ? _ptm[pin.entry.pinType]
        : '📍';
      const label = pin.entry.title || (pin.entry.date ? fmtDateShort(pin.entry.date) : 'Sans titre');
      return `
        <div class="mm-pin-row"
             data-lat="${pin.lat}" data-lng="${pin.lng}" data-tripid="${trip.id}"
             onclick="_mmFlyTo(${pin.lat}, ${pin.lng}, '${trip.id}')">
          <span style="color:${color};flex-shrink:0">${pinEmoji}</span>
          <span class="mm-pin-label">${label}</span>
        </div>`;
    }).join('');

    html += `
      <div class="mm-trip-group" id="${groupId}">
        <div class="mm-trip-header" onclick="_mmToggleGroup('${groupId}')">
          <span class="mm-trip-chevron">▼</span>
          <span style="font-size:15px">${typeInfo.icon}</span>
          <span class="mm-trip-name">${trip.flag || ''} ${trip.name}</span>
          <span class="mm-pin-count">${tPins.length}</span>
        </div>
        <div class="mm-trip-body">${pinsHtml}</div>
      </div>`;
  }
  return html;
}

// ── Sidebar country dropdown ───────────────────────────────────────────────────

function _countryDropdownHtml() {
  const opts = _countryOptions();
  const options = `<option value="all">Tous pays</option>` +
    opts.map(({ iso, flag }) =>
      `<option value="${iso}"${_filters.country === iso ? ' selected' : ''}>${flag} ${iso}</option>`
    ).join('');
  return `<select class="mm-select" onchange="_mmSetCountry(this.value)">${options}</select>`;
}

// ── Sidebar trip dropdown ──────────────────────────────────────────────────────

function _tripDropdownHtml() {
  const trips = _tripsWithPins();
  const options = `<option value="all">Tous les voyages</option>` +
    trips.map(t =>
      `<option value="${t.id}"${_filters.tripId === t.id ? ' selected' : ''}>${t.flag || ''} ${t.name}</option>`
    ).join('');
  return `<select class="mm-select" onchange="_mmSetTrip(this.value)">${options}</select>`;
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

  const statusToggle = `
    <div class="mm-status-toggle">
      <button class="mm-st-btn${_filters.status === 'all'  ? ' active' : ''}" onclick="_mmSetStatus('all')">Tous</button>
      <button class="mm-st-btn${_filters.status === 'done' ? ' active' : ''}" onclick="_mmSetStatus('done')">Réalisés</button>
    </div>`;

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
    <div class="mm-filter-row" style="gap:6px">
      ${_tripDropdownHtml()}
      ${_countryDropdownHtml()}
      ${statusToggle}
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
    marker.bindPopup(_popupHtml(pin.trip, pin.entry), { maxWidth: 250 });
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

  // Update sidebar tree
  const treeEl = document.getElementById('mm-tree');
  if (treeEl) treeEl.innerHTML = _buildSidebarTree(pins);

  // Update filter buttons — type
  document.querySelectorAll('.mm-type-btn').forEach(btn => {
    btn.classList.toggle('active', btn.textContent.trim() === _filterTypeLabel(_filters.type));
  });

  // Redraw markers
  _redrawMarkers(pins);
}

function _filterTypeLabel(key) {
  return { all: 'Tous', voyage: 'Voyages', weekend: 'Week-ends', sortie: 'Sorties' }[key] || 'Tous';
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
  // Open the popup for this marker
  const found = _markers.find(m => m.trip.id === tripId && m.entry.lat == lat && m.entry.lng == lng);
  if (found) {
    setTimeout(() => found.marker.openPopup(), 400);
  }
};

window._mmToggleGroup = function(groupId) {
  // Extract tripId from groupId: 'mm-grp-{tripId}'
  const tripId = groupId.replace('mm-grp-', '');
  // Toggle: click same trip again to show all
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
  // Refresh entire sidebar to update button states
  const sidebar = document.getElementById('mm-sidebar');
  if (sidebar) {
    const pins = _visiblePins();
    sidebar.innerHTML = _sidebarHtml(pins);
  }
  _update();
};

window._mmSetCountry = function(val) {
  _filters.country = val;
  _update();
};

window._mmSetStatus = function(val) {
  _filters.status = val;
  // Refresh sidebar for button states
  const sidebar = document.getElementById('mm-sidebar');
  if (sidebar) {
    const pins = _visiblePins();
    sidebar.innerHTML = _sidebarHtml(pins);
  }
  _update();
};

window._mmSetPinType = function(val) {
  _filters.pinType = val;
  _update();
};

window._mmSetTrip = function(val) {
  _filters.tripId = val;
  _update();
};

window._mmExportKml = _mmExportKml;

// ── Public API ─────────────────────────────────────────────────────────────────

export function renderMyMap() {
  const wrap = document.getElementById('mymap-wrap');
  if (!wrap) return;

  // Reset filters to default
  _filters = { type: 'all', country: 'all', status: 'done', pinType: 'all', tripId: 'all' };

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
    <div id="mymap" style="flex:1;height:100%;min-width:0"></div>
  `;

  // Destroy any stale map instance first
  destroyMyMap();

  // Defer Leaflet init so #mymap has layout dimensions
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
