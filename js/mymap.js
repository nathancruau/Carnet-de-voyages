/* ============================================================
   CARNET DE VOYAGES — MyMap: Global trip map (rich edition)
   ============================================================
   Layout: full-screen split — 280px left sidebar + Leaflet map
   Exports: renderMyMap(), destroyMyMap()
   ============================================================ */

import { getTrips, TRIP_TYPES, getPinTypes } from './store.js';
import { fmtDate, fmtDateShort, trCol, fmtFlag } from './utils.js';
import { parseGpx, generateGpx, downloadFile, estimateTileCount } from './gpx.js';

// ── PIN type helper (dynamic from settings) ────────────────────────────────────

function _pinTypeMap() {
  const map = {};
  for (const pt of getPinTypes()) map[pt.key] = pt.emoji;
  return map;
}

// ── Module-level state ─────────────────────────────────────────────────────────
let _map             = null;   // Leaflet map instance
let _markers         = [];     // { marker, trip, entry } objects currently on the map
let _routeLayers     = [];     // L.Polyline instances for trip routes
let _gpxLayers       = [];     // L.Polyline instances for imported GPX overlays
let _legendControl   = null;   // Leaflet legend control
let _allPins         = [];     // All { trip, entry, lat, lng } built from store
let _filters         = { type: 'all', pinType: 'all', tripId: 'all' };
let _showRoutes      = false;  // whether itinerary lines are drawn
let _collapsedGroups = new Set();  // trip ids whose sidebar group is folded
let _footerExpanded  = false;      // tools/export footer collapsed by default
let _infoPanelEl     = null;   // info panel DOM element
let _mergedPinsCache  = [];     // current merged pins, kept for dynamic world-copy expansion
let _activeOffsets    = new Set(); // longitude offsets (multiples of 360) that have markers placed
let _lastFilteredPins = [];    // last pin set passed to _redrawMarkers (for zoom-triggered redraw)
let _gpxTrackLayer   = null;   // active GPX polyline drawn when info panel is open

// Transport mode metadata (mirrors mapcal.js / utils.trCol)
const _TR_MODES = [
  { mode: 'car',   emoji: '🚗', label: 'Voiture', dash: false },
  { mode: 'bus',   emoji: '🚌', label: 'Bus',     dash: false },
  { mode: 'foot',  emoji: '🚶', label: 'À pied',  dash: false },
  { mode: 'bike',  emoji: '🚲', label: 'Vélo',    dash: false },
  { mode: 'plane', emoji: '✈️', label: 'Avion',   dash: true  },
  { mode: 'ferry', emoji: '⛴️', label: 'Ferry',   dash: true  },
];
const _OSRM_PROFILE = { car: 'driving', bus: 'driving', foot: 'foot', bike: 'cycling' };

// ── Country color mapping ──────────────────────────────────────────────────────

/** Extract ISO-2 country code from a flag emoji or plain ISO text ("FR"). */
function _isoFromFlag(flag) {
  if (!flag) return '';
  const trimmed = flag.trim();
  const pts = [...trimmed].map(c => c.codePointAt(0)).filter(cp => cp >= 0x1F1E6 && cp <= 0x1F1FF);
  if (pts.length >= 2) return pts.slice(0, 2).map(cp => String.fromCharCode(cp - 0x1F1E6 + 65)).join('');
  if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();
  return '';
}

/** Return only the flag emoji characters (no ISO text suffix) for compact display. */
function _flagEmojiOnly(flag) {
  if (!flag) return '';
  const trimmed = flag.trim();
  const pts = [...trimmed].map(c => c.codePointAt(0)).filter(v => v >= 0x1F1E6 && v <= 0x1F1FF);
  if (pts.length >= 2) return String.fromCodePoint(pts[0]) + String.fromCodePoint(pts[1]);
  if (/^[A-Za-z]{2}$/.test(trimmed)) {
    const iso = trimmed.toUpperCase();
    return String.fromCodePoint(0x1F1E6 + iso.charCodeAt(0) - 65) +
           String.fromCodePoint(0x1F1E6 + iso.charCodeAt(1) - 65);
  }
  return trimmed;
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

/** Merge overlapping pins (within ~11 m, 4 decimal places) into clusters. */
function _mergedPins(rawPins) {
  const grid = new Map();
  for (const pin of rawPins) {
    const key = pin.lat.toFixed(4) + ',' + pin.lng.toFixed(4);
    if (!grid.has(key)) grid.set(key, { lat: pin.lat, lng: pin.lng, entries: [] });
    grid.get(key).entries.push(pin);
  }
  return [...grid.values()];
}

/** Multi-visit icon: teal circle with count badge. */
function _makeMultiIcon(count) {
  return L.divIcon({
    className: '',
    html: `<div style="position:relative;width:28px;height:28px">
      <div style="width:28px;height:28px;border-radius:50%;background:#0d9488;border:2.5px solid #fff;box-shadow:0 1px 6px rgba(0,0,0,.45);cursor:pointer"></div>
      <span style="position:absolute;top:-4px;right:-4px;background:#e85d3e;color:#fff;border-radius:50%;min-width:16px;height:16px;font-size:9px;font-weight:800;display:flex;align-items:center;justify-content:center;border:1.5px solid #fff;padding:0 2px">${count}</span>
    </div>`,
    iconSize:    [28, 28],
    iconAnchor:  [14, 14],
    popupAnchor: [0, -20],
  });
}

/** Cluster icon for geographic groups of nearby destinations. */
function _makeGeoClusterIcon(count, color = '#0d9488') {
  const sz = count >= 10 ? 42 : 36;
  return L.divIcon({
    className: '',
    html: `<div style="background:${color};color:#fff;border:3px solid rgba(255,255,255,.9);border-radius:50%;width:${sz}px;height:${sz}px;display:flex;align-items:center;justify-content:center;font-size:${count >= 10 ? 11 : 12}px;font-weight:800;box-shadow:0 2px 12px rgba(0,0,0,.25);cursor:pointer">${count}</div>`,
    iconSize:   [sz, sz],
    iconAnchor: [sz / 2, sz / 2],
    popupAnchor:[0, -sz / 2],
  });
}

/**
 * Group geographically close merged-pins into geo-clusters based on screen-pixel
 * distance at the current zoom level. Pins from different countries are never merged.
 * Returns the same `mergedPins` array with some entries replaced by cluster objects
 * { lat, lng, entries[], isGeoCluster, clusterColor, clusterPoints[] }.
 * Disabled above zoom 9 — individual pins are shown at high zoom.
 */
function _geoCluster(mergedPins, map, threshold = 52) {
  if (!map || map.getZoom() >= 9 || mergedPins.length < 2) return mergedPins;
  const pts = mergedPins.map(mp => map.latLngToContainerPoint([mp.lat, mp.lng]));
  // Country key per merged-pin: used to prevent cross-country clustering
  const countryOf = mergedPins.map(mp => {
    const flag = mp.entries[0]?.entry?.dayFlag || mp.entries[0]?.trip?.flag || '';
    return _isoFromFlag(flag) || flag || '?';
  });
  const assigned = new Uint8Array(mergedPins.length);
  const result   = [];
  for (let i = 0; i < mergedPins.length; i++) {
    if (assigned[i]) continue;
    assigned[i] = 1;
    const members = [i];
    for (let j = i + 1; j < mergedPins.length; j++) {
      if (!assigned[j] && countryOf[i] === countryOf[j] && pts[i].distanceTo(pts[j]) <= threshold) {
        assigned[j] = 1;
        members.push(j);
      }
    }
    if (members.length === 1) {
      result.push(mergedPins[i]);
    } else {
      const allEntries = members.flatMap(idx => mergedPins[idx].entries);
      const latC = members.reduce((s, idx) => s + mergedPins[idx].lat, 0) / members.length;
      const lngC = members.reduce((s, idx) => s + mergedPins[idx].lng, 0) / members.length;
      const flag = mergedPins[members[0]].entries[0]?.entry?.dayFlag || mergedPins[members[0]].entries[0]?.trip?.flag || '';
      result.push({
        lat: latC, lng: lngC,
        entries: allEntries,
        isGeoCluster: true,
        clusterColor: _colorForFlag(flag),
        clusterPoints: members.map(idx => mergedPins[idx]),
      });
    }
  }
  return result;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _fmtDuration(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h > 0 ? `${h}h${m > 0 ? m + 'min' : ''}` : `${m}min`;
}

function _mmClearGpxTrack() {
  if (_gpxTrackLayer && _map) {
    try { _map.removeLayer(_gpxTrackLayer); } catch (_) {}
    _gpxTrackLayer = null;
  }
}

// ── Info panel (rich display on pin/legend click) ──────────────────────────────

function _mmShowInfo(trip, entry) {
  if (!_infoPanelEl) return;

  // Clear any GPX track drawn for a previous pin
  _mmClearGpxTrack();

  const _ptm      = _pinTypeMap();
  const typeEmoji = (entry.pinType && _ptm[entry.pinType]) ? _ptm[entry.pinType] : '📍';
  const color     = _colorForFlag(trip.flag);
  const photos    = entry.photos || [];

  // Store photos for carousel (accessed via onclick in innerHTML)
  window._mmInfoPhotos = photos.map(p => p.url);

  // Hero photo — large banner at the top
  const heroPhoto = photos[0];
  const photoHeroHtml = heroPhoto
    ? `<div style="width:100%;height:130px;overflow:hidden;flex-shrink:0;position:relative;cursor:pointer"
            onclick="window._openSlides && window._openSlides(window._mmInfoPhotos || [], 0)">
         <img src="${_esc(heroPhoto.url)}"
              style="width:100%;height:100%;object-fit:cover"
              onerror="this.parentElement.style.display='none'">
         ${photos.length > 1
           ? `<span style="position:absolute;bottom:6px;right:8px;background:rgba(0,0,0,.6);color:#fff;
                            border-radius:12px;padding:2px 8px;font-size:10px;font-weight:700">
                +${photos.length - 1} photo${photos.length > 2 ? 's' : ''}
              </span>`
           : ''}
       </div>`
    : '';

  // Metadata pills row
  const pills = [
    entry.dayLabel  ? `<span class="mm-pill">📅 ${_esc(entry.dayLabel)}</span>` : '',
    entry.date && !entry.dayLabel ? `<span class="mm-pill">📅 ${fmtDate(entry.date)}</span>` : '',
    entry.weather   ? `<span class="mm-pill">${entry.weather}</span>` : '',
    entry.amount    ? `<span class="mm-pill">💶 ${Number(entry.amount).toLocaleString('fr-FR',{minimumFractionDigits:2})} €</span>` : '',
    entry._validated ? `<span class="mm-pill" style="background:#dcfce7;border-color:#bbf7d0;color:#16a34a">✓ Validé</span>` : '',
  ].filter(Boolean).join('');

  // GPX stats section + draw polyline on map
  let gpxHtml = '';
  if (entry.gpxStats) {
    const gs   = entry.gpxStats;
    const dist = gs.distanceM >= 1000
      ? `${(gs.distanceM / 1000).toFixed(1)} km`
      : `${gs.distanceM} m`;
    const gpxPills = [
      `<span class="mm-pill mm-pill-gpx">📏 ${dist}</span>`,
      gs.elevGain   ? `<span class="mm-pill mm-pill-gpx">↑ ${gs.elevGain} m</span>`              : '',
      gs.elevLoss   ? `<span class="mm-pill mm-pill-gpx">↓ ${gs.elevLoss} m</span>`              : '',
      gs.durationSecs ? `<span class="mm-pill mm-pill-gpx">⏱ ${_fmtDuration(gs.durationSecs)}</span>` : '',
      gs.speedAvgKph  ? `<span class="mm-pill mm-pill-gpx">⚡ ${gs.speedAvgKph.toFixed(1)} km/h</span>` : '',
    ].filter(Boolean).join('');
    gpxHtml = `
      <div style="border-top:1px solid var(--c3);padding-top:10px;margin-top:4px">
        <div style="font-size:10px;font-weight:700;color:var(--ink4);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">🛤 Trace GPX</div>
        <div style="display:flex;flex-wrap:wrap;gap:5px">${gpxPills}</div>
      </div>`;

    // Draw the GPX polyline on the map
    if (entry.gpxPoints && entry.gpxPoints.length > 1 && _map) {
      const latlngs = entry.gpxPoints.map(p => [p.lat, p.lng]);
      _gpxTrackLayer = L.polyline(latlngs, {
        color: '#e85d3e', weight: 3.5, opacity: 0.85,
      }).addTo(_map);
    }
  }

  // Notes / content
  const contentHtml = entry.content
    ? `<div style="font-size:12px;color:var(--ink2);white-space:pre-wrap;line-height:1.55;background:var(--c2);border-radius:8px;padding:10px 12px;border:1px solid var(--c3)">${_esc(entry.content)}</div>`
    : '';

  const emptyHtml = !entry._validated && !entry.weather && !photos.length && !entry.content && !entry.gpxStats
    ? `<div style="font-size:12px;color:var(--ink4);text-align:center;padding:8px 0">Aucune information enregistrée pour ce PIN.</div>`
    : '';

  _infoPanelEl.innerHTML = `
    ${photoHeroHtml}
    <div style="padding:12px 14px;border-bottom:1px solid var(--c3);display:flex;align-items:flex-start;gap:8px;flex-shrink:0">
      <div style="flex:1;min-width:0">
        <div style="font-size:10px;font-weight:700;color:${color};margin-bottom:3px">${_esc(fmtFlag(trip.flag))} ${_esc(trip.name)}</div>
        <div style="font-size:15px;font-weight:700;color:var(--ink);line-height:1.25">${typeEmoji} ${_esc(entry.title)}</div>
        ${pills ? `<div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:7px">${pills}</div>` : ''}
      </div>
      <button onclick="_mmCloseInfo()"
        style="background:none;border:none;cursor:pointer;color:var(--ink4);font-size:16px;padding:0;line-height:1;flex-shrink:0;margin-top:2px">✕</button>
    </div>
    <div style="padding:12px 14px;flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:10px;min-height:0">
      ${contentHtml}
      ${gpxHtml}
      ${emptyHtml}
      <div style="margin-top:auto;display:flex;flex-direction:column;gap:6px;padding-top:8px">
        ${entry.lat != null && entry.lng != null ? `
          <a href="https://maps.google.com/maps?layer=c&cbll=${entry.lat},${entry.lng}"
             target="_blank" rel="noopener"
             style="display:block;width:100%;background:var(--c2);border:1.5px solid var(--c3);
                    border-radius:8px;padding:8px;font-size:12px;font-weight:700;cursor:pointer;
                    font-family:var(--fn);text-align:center;color:var(--ink3);text-decoration:none">
            🔭 Street View
          </a>` : ''}
        <button onclick="window.navigateToTrip && window.navigateToTrip('${trip.id}')"
          style="width:100%;background:linear-gradient(135deg,var(--teal) 0%,var(--td) 100%);color:#fff;border:none;border-radius:8px;
                 padding:9px;font-size:12px;font-weight:700;cursor:pointer;font-family:var(--fn)">
          Ouvrir le voyage →
        </button>
      </div>
    </div>
  `;

  _infoPanelEl.style.display = 'flex';
}

/** Show info panel for a merged pin (one or many entries at same location). */
function _mmShowMergedInfo(mp) {
  if (!_infoPanelEl) return;
  if (mp.entries.length === 1) {
    _mmShowInfo(mp.entries[0].trip, mp.entries[0].entry);
    return;
  }

  const _ptm = _pinTypeMap();
  const visitBlocks = mp.entries.map(({ trip, entry }) => {
    const color    = _colorForFlag(entry.dayFlag || trip.flag);
    const typeEmoji = (entry.pinType && _ptm[entry.pinType]) ? _ptm[entry.pinType] : '📍';
    const photosHtml = (entry.photos || []).slice(0, 3).map(p =>
      `<img src="${_esc(p.url)}" style="height:56px;min-width:56px;border-radius:6px;object-fit:cover;flex-shrink:0;border:1px solid var(--c3)" onerror="this.style.display='none'">`
    ).join('');
    return `
      <div style="padding:10px 14px;border-bottom:1px solid var(--c3)">
        <div style="font-size:10px;font-weight:700;color:${color};margin-bottom:3px">${_esc(fmtFlag(entry.dayFlag || trip.flag))} ${_esc(trip.name)}</div>
        <div style="font-size:13px;font-weight:700;color:var(--ink);margin-bottom:2px">${typeEmoji} ${_esc(entry.title)}</div>
        ${entry.dayLabel ? `<div style="font-size:11px;color:var(--ink4)">📅 ${_esc(entry.dayLabel)}</div>` : ''}
        ${entry.date     ? `<div style="font-size:11px;color:var(--ink4)">${fmtDate(entry.date)}</div>` : ''}
        ${entry.content  ? `<div style="font-size:11px;color:var(--ink2);margin-top:4px;white-space:pre-wrap;line-height:1.4">${_esc(entry.content)}</div>` : ''}
        ${entry.weather  ? `<div style="font-size:18px;margin-top:2px">${entry.weather}</div>` : ''}
        ${photosHtml     ? `<div style="display:flex;gap:4px;margin-top:6px;overflow-x:auto">${photosHtml}</div>` : ''}
        ${entry._validated ? `<div style="font-size:10px;font-weight:700;color:#16a34a;margin-top:3px">✓ Validé</div>` : ''}
        <button onclick="window.navigateToTrip && window.navigateToTrip('${trip.id}')"
          style="margin-top:7px;width:100%;background:var(--c2);border:1px solid var(--c3);border-radius:7px;
                 padding:6px;font-size:11px;font-weight:600;cursor:pointer;font-family:var(--fn);color:var(--ink3)">
          Ouvrir le voyage →
        </button>
      </div>`;
  }).join('');

  _infoPanelEl.innerHTML = `
    <div style="padding:10px 14px;border-bottom:1px solid var(--c3);display:flex;align-items:center;gap:8px;flex-shrink:0">
      <div style="font-size:13px;font-weight:700;color:var(--ink);flex:1">📍 ${mp.entries.length} visites de ce lieu</div>
      <button onclick="_mmCloseInfo()" style="background:none;border:none;cursor:pointer;color:var(--ink4);font-size:16px;padding:0;line-height:1">✕</button>
    </div>
    <div style="flex:1;overflow-y:auto">${visitBlocks}</div>
  `;
  _infoPanelEl.style.display = 'flex';
}

// ── Build the flat pin list from store ────────────────────────────────────────

function _buildAllPins() {
  _allPins = [];
  for (const trip of getTrips()) {
    // MyMap only shows places from realized trips (status = 'done').
    // Planned trips are excluded — their pins don't represent visited places.
    if (trip.status !== 'done') continue;

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
            dayFlag:    day.flag   || null,
            lat, lng,
            photos:     (jd.photos || []).map(p => ({ url: p })),
            content:    jd.notes   || '',
            weather:    jd.weather || '',
            gpxStats:   item.gpxStats  || null,
            gpxPoints:  item.gpxPoints || null,
            gpxTrackId: item.gpxTrackId || null,
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

    // Sortie pin (single-pin trip — stored in trip.pin, not days)
    if (trip.type === 'sortie' && trip.pin) {
      const lat = parseFloat(trip.pin.lat);
      const lng = parseFloat(trip.pin.lng);
      if (!isNaN(lat) && !isNaN(lng)) {
        const entry = {
          id:         trip.id + '_pin',
          title:      trip.name || 'Sortie',
          date:       trip.pin.date || trip.startDate || null,
          dayLabel:   null,
          pinType:    trip.pin.pinType || 'visit',
          dayFlag:    trip.flag || null,   // country flag set during save
          lat, lng,
          photos:     trip.photos?.length ? trip.photos : (trip.photo ? [{ url: trip.photo }] : []),
          content:    trip.pin.description || '',
          weather:    trip.pin.weather || '',
          amount:     trip.pin.cost || 0,
          tags:       [],
          _validated: false,
        };
        _allPins.push({ trip, entry, lat, lng });
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

  // Build trip list respecting the active type and tripId filters (pin-type filter only hides rows)
  const allTripMap = new Map();
  for (const { trip } of _allPins) {
    if (allTripMap.has(trip.id)) continue;
    if (_filters.type   !== 'all' && trip.type  !== _filters.type)  continue;
    if (_filters.tripId !== 'all' && trip.id    !== _filters.tripId) continue;
    allTripMap.set(trip.id, { trip, pins: [] });
  }
  for (const pin of pins) {
    allTripMap.get(pin.trip.id)?.pins.push(pin);
  }

  let html = '';
  for (const { trip, pins: tPins } of allTripMap.values()) {
    const typeInfo = TRIP_TYPES[trip.type] || TRIP_TYPES.voyage;
    const color    = _colorForFlag(trip.flag);
    const groupId  = 'mm-grp-' + trip.id;
    const isFocused = _filters.tripId === trip.id;

    // Sorties have a single PIN — render as a flat clickable row (no collapsible body)
    if (trip.type === 'sortie') {
      if (tPins.length === 0) continue;
      const pin = tPins[0];
      const _ptm = _pinTypeMap();
      const pinEmoji = (pin.entry?.pinType && _ptm[pin.entry.pinType]) ? _ptm[pin.entry.pinType] : '📍';
      const dateStr = pin.entry.date ? fmtDateShort(pin.entry.date) : '';
      html += `
        <div class="mm-trip-group" id="${groupId}">
          <div class="mm-trip-header" style="cursor:pointer"
               onclick="_mmFlyTo(${pin.lat}, ${pin.lng}, '${trip.id}')">
            <span class="mm-trip-chevron" style="pointer-events:none;cursor:default">▶</span>
            <span style="font-size:15px">${typeInfo.icon}</span>
            <span class="mm-trip-name${isFocused ? ' mm-trip-focused' : ''}" style="cursor:pointer">
              ${_isoFromFlag(trip.flag)} ${_esc(trip.name)}
            </span>
            <span style="font-size:11px;flex-shrink:0">${pinEmoji}</span>
            ${dateStr ? `<span style="font-size:9px;color:var(--ink4);flex-shrink:0;margin-left:2px">${dateStr}</span>` : ''}
          </div>
        </div>`;
      continue;
    }

    const isCollapsed = _collapsedGroups.has(trip.id);

    const pinsHtml = tPins.map(pin => {
      const _ptm = _pinTypeMap();
      const pinEmoji = (pin.entry?.pinType && _ptm[pin.entry.pinType])
        ? _ptm[pin.entry.pinType]
        : '📍';
      const label = pin.entry.title || (pin.entry.date ? fmtDateShort(pin.entry.date) : 'Sans titre');
      const dateStr = pin.entry.date ? fmtDateShort(pin.entry.date) : '';
      const pinColor = _colorForFlag(pin.entry?.dayFlag || trip.flag);
      return `
        <div class="mm-pin-row"
             data-lat="${pin.lat}" data-lng="${pin.lng}" data-tripid="${trip.id}"
             onclick="_mmFlyTo(${pin.lat}, ${pin.lng}, '${trip.id}')">
          <span style="font-size:11px;font-weight:600;color:${pinColor};flex-shrink:0">${fmtFlag(pin.entry?.dayFlag) || pinEmoji}</span>
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
                style="cursor:pointer">${_isoFromFlag(trip.flag)} ${_esc(trip.name)}</span>
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
      <div style="font-family:'Lora',serif;font-size:17px;font-weight:700;color:var(--ink)">🗺 Mes destinations</div>
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
    <div class="mm-filter-row">
      <button class="mm-type-btn${_showRoutes ? ' active' : ''}" onclick="_mmToggleRoutes()" style="gap:5px">
        〰 Itinéraires
      </button>
    </div>

    <div class="mm-tree" id="mm-tree">
      ${tree}
    </div>

    <div class="mm-sidebar-footer" id="mm-footer">
      <div class="mm-footer-toggle" onclick="_mmToggleFooter()">
        <span class="mm-trip-chevron">${_footerExpanded ? '▼' : '▶'}</span>
        <span style="font-size:11px;font-weight:700;color:var(--ink3)">Outils &amp; Export</span>
      </div>
      ${_footerExpanded ? `<div class="mm-footer-body">
        <button class="mm-export-btn" onclick="_mmExportKml()">⬇ KML</button>
        <button class="mm-export-btn" onclick="_mmExportGpx()">⬇ GPX</button>
        <button class="mm-export-btn" onclick="_mmImportGpx()">↑ GPX</button>
        <button class="mm-export-btn" onclick="_mmDownloadOffline()" title="Mettre les tuiles de carte en cache pour consultation hors-ligne">📶 Hors-ligne</button>
      </div>` : ''}
    </div>
    <input type="file" id="mm-gpx-input" accept=".gpx" style="display:none">
  `;
}

// ── Infinite world-copy marker management ─────────────────────────────────────

/** Place all current merged pins at a given longitude offset (one world copy). */
function _addOffsetMarkers(offset) {
  if (!_map || _activeOffsets.has(offset)) return;
  _activeOffsets.add(offset);
  for (const mp of _mergedPinsCache) {
    let icon;
    if (mp.isGeoCluster) {
      icon = _makeGeoClusterIcon(mp.entries.length, mp.clusterColor);
    } else {
      const isMulti = mp.entries.length > 1;
      const primary = mp.entries[0];
      const color   = _colorForFlag(primary.entry?.dayFlag || primary.trip.flag);
      const emoji   = isMulti ? null : (_pinTypeMap()[primary.entry?.pinType] || null);
      icon = isMulti ? _makeMultiIcon(mp.entries.length) : _makeIcon(color, 14, emoji);
    }
    const marker  = L.marker([mp.lat, mp.lng + offset], { icon });
    marker.on('click', () => {
      if (mp.isGeoCluster) {
        _map.fitBounds(
          L.latLngBounds(mp.clusterPoints.map(p => [p.lat, p.lng])),
          { padding: [60, 60], maxZoom: 11 }
        );
      } else {
        _mmShowMergedInfo(mp);
      }
    });
    marker.addTo(_map);
    _markers.push({ marker, trip: mp.entries[0].trip, entry: mp.entries[0].entry });
  }
}

/**
 * Called on every map moveend: ensures pins exist at every 360° offset that
 * overlaps (or is adjacent to) the current viewport.  This makes panning
 * east or west infinitely seamless — new world copies get markers on demand.
 */
function _ensureMarkersForViewport() {
  if (!_map || _mergedPinsCache.length === 0) return;
  const bounds = _map.getBounds();
  const lo = Math.floor((bounds.getWest() - 360) / 360) * 360;
  const hi = Math.ceil ((bounds.getEast() + 360) / 360) * 360;
  for (let offset = lo; offset <= hi; offset += 360) {
    _addOffsetMarkers(offset);
  }
}

// ── Redraw markers on the map ──────────────────────────────────────────────────

function _redrawMarkers(pins, fitView = true) {
  if (!_map) return;
  _lastFilteredPins = pins;

  for (const { marker } of _markers) marker.remove();
  _markers        = [];
  _activeOffsets  = new Set();
  _mergedPinsCache = _geoCluster(_mergedPins(pins), _map);

  const rawBounds = _mergedPins(pins).map(mp => [mp.lat, mp.lng]);

  // Seed the canonical copy + whatever the current viewport needs
  _addOffsetMarkers(0);
  _ensureMarkersForViewport();

  // Fit map view (only on initial draw, not on zoom-triggered redraws)
  if (fitView && rawBounds.length > 0) {
    if (rawBounds.length === 1) {
      _map.setView(rawBounds[0], 10);
    } else {
      try {
        _map.fitBounds(rawBounds, { padding: [48, 48], maxZoom: 12 });
      } catch (_) {
        _map.setView(rawBounds[0], 8);
      }
    }
  }
}

// ── Collect ordered waypoints from a trip (same logic as mapcal._collectAllWaypoints) ──

function _buildTripWaypoints(trip) {
  const wps = [];
  for (const day of (trip.days || [])) {
    const itemPins = (day.items || []).filter(it => it.lat != null && it.lng != null);
    if (itemPins.length > 0) {
      for (const item of itemPins) {
        let mode = item.routeMode || 'car';
        if (item.type === 'drive' && item.transport) mode = item.transport;
        wps.push({ lat: item.lat, lng: item.lng, mode });
      }
    } else if (day.lat != null && day.lng != null) {
      wps.push({ lat: day.lat, lng: day.lng, mode: day.routeMode || 'car' });
    }
  }
  return wps;
}

// ── Draw itinerary polylines (same styles as mapcal.js) ───────────────────────

async function _redrawRoutes() {
  for (const layer of _routeLayers) layer.remove();
  _routeLayers = [];
  _updateLegend();
  if (!_showRoutes || !_map) return;

  // Build trip list respecting current filters
  const trips = getTrips().filter(t => {
    if (t.status !== 'done') return false;
    if (_filters.tripId !== 'all' && t.id !== _filters.tripId) return false;
    if (_filters.type   !== 'all' && t.type !== _filters.type)  return false;
    return true;
  });

  for (const trip of trips) {
    const wps = _buildTripWaypoints(trip);
    if (wps.length < 2) continue;

    for (let i = 0; i < wps.length - 1; i++) {
      if (!_map) return; // navigated away mid-fetch
      const from = wps[i];
      const to   = wps[i + 1];
      const mode = to.mode || 'car';
      const color = trCol(mode);

      let line = null;

      if (mode === 'plane' || mode === 'ferry') {
        // Straight dashed line (no road routing for these)
        line = L.polyline([[from.lat, from.lng], [to.lat, to.lng]], {
          color, weight: 2, opacity: 0.65, dashArray: '8 5',
        });
      } else {
        try {
          const profile = _OSRM_PROFILE[mode] || 'driving';
          const url = `https://router.project-osrm.org/route/v1/${profile}/`
            + `${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
          const resp  = await fetch(url);
          const data  = await resp.json();
          const coords = data.routes?.[0]?.geometry?.coordinates;
          if (coords?.length) {
            line = L.polyline(coords.map(([lng, lat]) => [lat, lng]), {
              color, weight: 3.5, opacity: 0.75,
            });
          }
        } catch (_) {}

        if (!line) {
          // Fallback: straight dashed line if OSRM fails
          line = L.polyline([[from.lat, from.lng], [to.lat, to.lng]], {
            color, weight: 2, opacity: 0.5, dashArray: '5 5',
          });
        }
      }

      if (!_map || !line) return;
      line.bindTooltip(`${_isoFromFlag(trip.flag)} ${trip.name}`, { sticky: true, className: 'mm-route-tooltip' });
      line.addTo(_map);
      _routeLayers.push(line);
    }
  }
}

// ── Legend control ────────────────────────────────────────────────────────────

function _updateLegend() {
  if (_legendControl) { _legendControl.remove(); _legendControl = null; }
  if (!_showRoutes || !_map) return;

  const LegendControl = L.Control.extend({
    onAdd() {
      const div = L.DomUtil.create('div', 'mm-legend');
      L.DomEvent.disableClickPropagation(div);
      div.innerHTML = _TR_MODES.map(m => {
        const color = trCol(m.mode);
        const dash  = m.dash ? '6,4' : 'none';
        return `
          <div class="mm-legend-row">
            <svg width="30" height="12" viewBox="0 0 30 12" style="flex-shrink:0">
              <line x1="2" y1="6" x2="28" y2="6"
                stroke="${color}" stroke-width="3"
                stroke-dasharray="${dash}"
                stroke-linecap="round"/>
            </svg>
            <span>${m.emoji} ${m.label}</span>
          </div>`;
      }).join('');
      return div;
    },
    onRemove() {},
  });

  _legendControl = new LegendControl({ position: 'bottomright' });
  _legendControl.addTo(_map);
}

// ── Update (re-filter, re-render sidebar + markers) ───────────────────────────

function _update() {
  const pins = _visiblePins();

  const treeEl = document.getElementById('mm-tree');
  if (treeEl) treeEl.innerHTML = _buildSidebarTree(pins);

  _redrawMarkers(pins);
  _redrawRoutes(); // async, fire-and-forget
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

/** Show pin detail as an overlay inside the sidebar (used in destinations mode). */
function _mmShowInfoInSidebar(mp) {
  if (!_infoPanelEl) return;
  // Populate the (hidden) info panel to get its HTML
  if (mp.entries.length === 1) {
    _mmShowInfo(mp.entries[0].trip, mp.entries[0].entry);
  } else {
    _mmShowMergedInfo(mp);
  }
  _infoPanelEl.style.display = 'none';

  const sidebar = document.getElementById('mm-sidebar');
  if (!sidebar) return;

  document.getElementById('mm-dest-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'mm-dest-overlay';
  overlay.style.cssText =
    'position:absolute;inset:0;z-index:200;background:var(--c);display:flex;flex-direction:column;overflow:hidden';

  const header = document.createElement('div');
  header.style.cssText =
    'padding:8px 14px;border-bottom:1px solid var(--c3);flex-shrink:0;background:var(--c)';
  header.innerHTML =
    '<button onclick="document.getElementById(\'mm-dest-overlay\')?.remove()" ' +
    'style="background:none;border:none;cursor:pointer;font-size:13px;font-weight:600;' +
    'color:var(--teal);padding:0;font-family:var(--fn)">← Retour à la liste</button>';

  const body = document.createElement('div');
  body.style.cssText = 'flex:1;overflow-y:auto';
  body.innerHTML = _infoPanelEl.innerHTML;
  // Replace the info-panel close button with the overlay dismiss
  body.querySelectorAll('button[onclick="_mmCloseInfo()"]').forEach(b => b.remove());

  overlay.appendChild(header);
  overlay.appendChild(body);
  sidebar.appendChild(overlay);
}

window._mmFlyTo = function(lat, lng, tripId) {
  const key = parseFloat(lat).toFixed(4) + ',' + parseFloat(lng).toFixed(4);
  const visible = _visiblePins();
  const merged  = _mergedPins(visible);
  const mp = merged.find(m => m.lat.toFixed(4) + ',' + m.lng.toFixed(4) === key);

  // In destinations mode: show info inline in sidebar, don't switch to map
  const wrap = document.getElementById('mymap-wrap');
  if (wrap && wrap.classList.contains('mm-destinations-mode')) {
    if (mp) _mmShowInfoInSidebar(mp);
    return;
  }

  if (!_map) return;
  _map.flyTo([parseFloat(lat), parseFloat(lng)], 13, { duration: 0.8 });
  if (mp) setTimeout(() => _mmShowMergedInfo(mp), 450);
};

window._mmCloseInfo = function() {
  _mmClearGpxTrack();
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

// ── GPX import / export ───────────────────────────────────────────────────────

window._mmExportGpx = function() {
  const pins = _visiblePins();
  const waypoints = pins.map(({ trip, entry }) => ({
    lat:  entry.lat,
    lng:  entry.lng,
    name: `${trip.name}${entry.title ? ' – ' + entry.title : ''}`,
    desc: entry.date || '',
  }));
  const gpx = generateGpx('Carnet de Voyages', waypoints);
  downloadFile('carnet-voyages.gpx', gpx);
};

window._mmImportGpx = function() {
  const input = document.getElementById('mm-gpx-input');
  if (!input) return;
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    input.value = '';
    try {
      const text    = await file.text();
      const { tracks, waypoints } = parseGpx(text);
      if (!tracks.length && !waypoints.length) {
        alert('Aucune trace trouvée dans ce fichier GPX.');
        return;
      }
      // Draw tracks on map
      const colors = ['#e85d3e','#0284c7','#16a34a','#7c3aed','#d97706','#db2777'];
      tracks.forEach((trk, i) => {
        const latlngs = trk.points.map(p => [p.lat, p.lng]);
        const color   = colors[i % colors.length];
        const line    = L.polyline(latlngs, { color, weight: 3, opacity: 0.8 });
        line.bindTooltip(trk.name, { sticky: true });
        line.addTo(_map);
        _gpxLayers.push(line);
      });
      // Draw waypoints as small markers
      waypoints.forEach(w => {
        const mk = L.circleMarker([w.lat, w.lng], { radius: 5, color: '#f59e0b', fillColor: '#f59e0b', fillOpacity: 1 });
        if (w.name) mk.bindTooltip(w.name);
        mk.addTo(_map);
        _gpxLayers.push(mk);
      });
      if (_gpxLayers.length && _map) {
        const group = L.featureGroup(_gpxLayers.filter(l => l.getBounds || l.getLatLng));
        try { _map.fitBounds(group.getBounds?.() || _map.getBounds(), { padding: [30, 30] }); } catch (_) {}
      }
    } catch (err) {
      alert('Erreur : ' + err.message);
    }
  };
  input.click();
};

window._mmClearGpx = function() {
  for (const layer of _gpxLayers) { try { layer.remove(); } catch (_) {} }
  _gpxLayers = [];
};

// ── Offline tile pre-cache ────────────────────────────────────────────────────

window._mmDownloadOffline = function() {
  if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) {
    alert('Le mode hors-ligne n\'est pas encore prêt. Rechargez la page et réessayez.');
    return;
  }

  const pins = _visiblePins();
  if (!pins.length) { alert('Aucun PIN visible à mettre en cache.'); return; }

  const lats = pins.map(p => p.lat);
  const lngs = pins.map(p => p.lng);
  const bounds = {
    north: Math.min(90,  Math.max(...lats) + 0.5),
    south: Math.max(-90, Math.min(...lats) - 0.5),
    east:  Math.min(180, Math.max(...lngs) + 0.5),
    west:  Math.max(-180,Math.min(...lngs) - 0.5),
  };

  const MIN_Z = 5, MAX_Z = 13;
  const count = estimateTileCount(bounds, MIN_Z, MAX_Z);
  if (!confirm(`Télécharger environ ${count.toLocaleString()} tuiles pour cette zone (zoom ${MIN_Z}–${MAX_Z}) ?\nCela peut prendre quelques minutes.`)) return;

  navigator.serviceWorker.controller.postMessage({ type: 'PRECACHE_TILES', ...bounds, minZoom: MIN_Z, maxZoom: MAX_Z });

  const onMsg = e => {
    if (e.data?.type === 'PRECACHE_PROGRESS') {
      const pct = Math.round(e.data.done / e.data.total * 100);
      document.getElementById('offline-bar')?.classList.add('visible');
      const bar = document.getElementById('offline-bar');
      if (bar) bar.textContent = `📶 Mise en cache hors-ligne : ${pct}% (${e.data.done}/${e.data.total})`;
    }
    if (e.data?.type === 'PRECACHE_DONE') {
      navigator.serviceWorker.removeEventListener('message', onMsg);
      const bar = document.getElementById('offline-bar');
      if (bar) { bar.textContent = `✓ ${e.data.total.toLocaleString()} tuiles mises en cache — carte disponible hors-ligne`; }
      setTimeout(() => {
        document.getElementById('offline-bar')?.classList.remove('visible');
        const b = document.getElementById('offline-bar');
        if (b) b.textContent = '📶 Hors-ligne — les modifications sont enregistrées et se synchroniseront à la reconnexion';
      }, 4000);
    }
  };
  navigator.serviceWorker.addEventListener('message', onMsg);
};

window._mmToggleRoutes = function() {
  _showRoutes = !_showRoutes;
  const sidebar = document.getElementById('mm-sidebar');
  if (sidebar) sidebar.innerHTML = _sidebarHtml(_visiblePins());
  _redrawRoutes(); // async
};

window._mmToggleFooter = function() {
  _footerExpanded = !_footerExpanded;
  const footer = document.getElementById('mm-footer');
  if (!footer) return;
  const chevron = footer.querySelector('.mm-trip-chevron');
  if (chevron) chevron.textContent = _footerExpanded ? '▼' : '▶';
  let body = footer.querySelector('.mm-footer-body');
  if (_footerExpanded && !body) {
    body = document.createElement('div');
    body.className = 'mm-footer-body';
    body.innerHTML = `
      <button class="mm-export-btn" onclick="_mmExportKml()">⬇ KML</button>
      <button class="mm-export-btn" onclick="_mmExportGpx()">⬇ GPX</button>
      <button class="mm-export-btn" onclick="_mmImportGpx()">↑ GPX</button>
      <button class="mm-export-btn" onclick="_mmDownloadOffline()" title="Mettre les tuiles de carte en cache pour consultation hors-ligne">📶 Hors-ligne</button>
    `;
    footer.appendChild(body);
  } else if (!_footerExpanded && body) {
    body.remove();
  }
};

// ── Public API ─────────────────────────────────────────────────────────────────

export function renderMyMap() {
  const wrap = document.getElementById('mymap-wrap');
  if (!wrap) return;

  // Reset filters and UI state to default
  _filters        = { type: 'all', pinType: 'all', tripId: 'all' };
  _footerExpanded = false;

  // Build pin data
  _buildAllPins();
  // Start with all trip groups collapsed — user expands to see events
  _collapsedGroups = new Set(_allPins.map(p => p.trip.id));
  const pins = _visiblePins();

  // Full layout
  wrap.className = 'mymap-wrap';
  wrap.style.cssText = '';

  const isMobile = window.innerWidth <= 768;

  wrap.innerHTML = `
    ${isMobile ? `
      <div class="mm-mob-tabs" id="mm-mob-tabs">
        <button class="bm-tab" onclick="goHome()">← Bibliothèque</button>
        <button class="bm-tab active" data-mm-tab="carte">🗺 Carte</button>
        <button class="bm-tab" data-mm-tab="destinations">📋 Destinations</button>
      </div>` : ''}
    <div class="mm-content" id="mm-content">
      <div class="mm-sidebar${isMobile ? ' collapsed' : ''}" id="mm-sidebar">
        ${_sidebarHtml(pins)}
      </div>
      <div class="map-col" id="mm-map-col">
        ${!isMobile ? `<button class="lp-toggle-btn" id="mm-toggle" title="Masquer / afficher le panneau">◀</button>` : ''}
        <div id="mymap" style="width:100%;height:100%"></div>
        <div id="mm-info-panel" class="mm-info-panel" style="display:none;flex-direction:column"></div>
      </div>
    </div>
  `;

  if (isMobile) {
    // Measure tab bar height so CSS can fill map/sidebar edge-to-edge
    const tabsForMeasure = document.getElementById('mm-mob-tabs');
    if (tabsForMeasure) {
      document.documentElement.style.setProperty('--mm-tabs-h', tabsForMeasure.offsetHeight + 'px');
    }

    // Mobile tab switcher
    const tabs = document.getElementById('mm-mob-tabs');
    if (tabs) {
      tabs.addEventListener('click', e => {
        const btn = e.target.closest('[data-mm-tab]');
        if (!btn) return;
        const tab = btn.dataset.mmTab;
        tabs.querySelectorAll('.bm-tab').forEach(b => b.classList.toggle('active', b === btn));
        const sidebar = document.getElementById('mm-sidebar');
        if (tab === 'destinations') {
          wrap.classList.add('mm-destinations-mode');
          if (sidebar) sidebar.classList.remove('collapsed');
        } else {
          wrap.classList.remove('mm-destinations-mode');
          if (sidebar) sidebar.classList.add('collapsed');
          setTimeout(() => { if (_map) _map.invalidateSize(); }, 50);
        }
      });
    }
  } else {
    // Desktop: wire sidebar toggle button
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
      center:             [46.5, 2.5],
      zoom:               5,
      zoomControl:        true,
      minZoom:            2,
      maxBounds:          [[-85.051129, -1e10], [85.051129, 1e10]],
      maxBoundsViscosity: 1.0,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 18,
    }).addTo(_map);

    // Lazily add marker copies for every world-copy the user pans into
    _map.on('moveend', _ensureMarkersForViewport);
    // Re-cluster when zoom changes (clusters expand/collapse based on screen density)
    _map.on('zoomend', () => { if (_lastFilteredPins.length) _redrawMarkers(_lastFilteredPins, false); });

    _redrawMarkers(pins);
    _redrawRoutes(); // async
    // Re-measure after layout settles (iOS flex chain can resolve after rAF)
    setTimeout(() => { if (_map) _map.invalidateSize(); }, 150);
  });
}

export function destroyMyMap() {
  _mmClearGpxTrack();
  if (_legendControl) { try { _legendControl.remove(); } catch (_) {} _legendControl = null; }
  if (_map) {
    try { _map.remove(); } catch (_) { /* already removed */ }
    _map = null;
  }
  _markers         = [];
  _routeLayers     = [];
  _gpxLayers       = [];
  _mergedPinsCache = [];
  _activeOffsets   = new Set();
}
