/**
 * mapcal.js — Map & Planning tab for Carnet de Voyages
 *
 * Exported surface:
 *   renderMapCal(tripId)  — render the map + calendar + days panel
 *   destroyMap()          — destroy the Leaflet instance (called on tab leave)
 */

import { getTrip, updateTrip, saveData, uid, getEventTypes, getLanguage, isTripShared } from '../store.js';
import { parseGpx, generateGpx, downloadFile, getLocalGpxTracks, saveLocalGpxTrack, removeLocalGpxTrack, computeGpxStats, downsampleGpxPoints } from '../gpx.js';
import { getSharedDocData, submitComment, deleteDayComment } from '../share.js';
import { getCurrentUser } from '../auth.js';
import {
  notify, showModal, closeModal,
  fmtDate, fmtDateShort,
  isoToDate, dateToIso, generateDays,
  tCol, tIc, trIc, trNm, trCol, fmtFlag,
  MNS, DOW, customDayTitle,
} from '../utils.js';
import { updateTopStats } from './trip.js';

// ─── Module state ─────────────────────────────────────────────────────────────

let _map          = null;          // Leaflet map instance
let _tripId       = null;
let _openDayIds   = new Set();     // set of open day ids (multiple allowed)
let _activeEvtKey = null;          // { dayId, idx } or null
let _markers      = {};            // dayId → L.Marker
let _routeLayers  = [];            // polylines / dashed lines on map
let _routeLoading = false;
let _drawRouteGen = 0;             // incremented each time _refreshMapPins fires
let _pendingMapClick = null;       // callback when user clicks map to pick coords
let _tempSearchPin    = null;       // temporary search result pin
let _commentDayId    = null;       // day id for the open comment panel (null = closed)
// Tracked so it can be removed before re-attaching on each render (prevents leaks)
let _mapSearchOutsideClickFn = null;

// ─── Weather cache (key: "lat:lng:date") ──────────────────────────────────────
const _wxCache  = {};
// ─── Duration cache (key: "lat1,lng1→lat2,lng2:profile") ─────────────────────
const _durCache = {};

const _WMO_EMOJI = {
  0:'☀️', 1:'🌤', 2:'⛅', 3:'🌥',
  45:'🌫', 48:'🌫',
  51:'🌦', 53:'🌦', 55:'🌧',
  61:'🌧', 63:'🌧', 65:'🌧',
  71:'🌨', 73:'🌨', 75:'❄️',
  80:'🌧', 81:'🌧', 82:'🌧',
  85:'🌨', 86:'❄️',
  95:'⛈', 96:'⛈', 99:'⛈',
};

async function _fetchDayWeather(lat, lng, date) {
  const key = `${lat}:${lng}:${date}`;
  if (key in _wxCache) return _wxCache[key];
  try {
    const today = new Date().toISOString().slice(0, 10);
    const base  = date <= today
      ? 'https://archive-api.open-meteo.com/v1/archive'
      : 'https://api.open-meteo.com/v1/forecast';
    const url   = `${base}?latitude=${lat}&longitude=${lng}&daily=weathercode,temperature_2m_max&timezone=auto&start_date=${date}&end_date=${date}`;
    const resp  = await fetch(url);
    const data  = await resp.json();
    const code  = data.daily?.weathercode?.[0];
    const tmax  = data.daily?.temperature_2m_max?.[0];
    const result = (code != null && tmax != null)
      ? { emoji: _WMO_EMOJI[code] || '🌡', tmax: Math.round(tmax) }
      : null;
    _wxCache[key] = result;
    return result;
  } catch (_) {
    _wxCache[key] = null;
    return null;
  }
}

// Geocoding cache for day regions (key: region string → {lat, lng} | null)
const _geoCache = {};

async function _geocodeRegion(text) {
  if (!text) return null;
  const key = text.toLowerCase().trim();
  if (key in _geoCache) return _geoCache[key];
  try {
    const url  = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(text)}&format=json&limit=1`;
    const resp = await fetch(url, { headers: { 'Accept-Language': 'fr' } });
    const data = await resp.json();
    const result = data[0] ? { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) } : null;
    _geoCache[key] = result;
    return result;
  } catch (_) {
    _geoCache[key] = null;
    return null;
  }
}

function _haversineMeters(from, to) {
  const R = 6371000;
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(to.lat - from.lat);
  const dLng = toRad(to.lng - from.lng);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function _fetchDuration(from, to, mode) {
  // Train: estimate via haversine + 130 km/h average
  if (mode === 'train') {
    const key = `${from.lat},${from.lng}→${to.lat},${to.lng}:train`;
    if (key in _durCache) return _durCache[key];
    const meters  = _haversineMeters(from, to);
    const seconds = Math.round(meters / (130_000 / 3600));
    const result  = { seconds, meters };
    _durCache[key] = result;
    return result;
  }
  // Foot: haversine + 5 km/h walking speed
  if (mode === 'foot') {
    const key = `${from.lat},${from.lng}→${to.lat},${to.lng}:foot`;
    if (key in _durCache) return _durCache[key];
    const meters = _haversineMeters(from, to);
    return (_durCache[key] = { seconds: Math.round(meters / (5000 / 3600)), meters });
  }
  // Bike: haversine + 15 km/h cycling speed
  if (mode === 'bike') {
    const key = `${from.lat},${from.lng}→${to.lat},${to.lng}:bike`;
    if (key in _durCache) return _durCache[key];
    const meters = _haversineMeters(from, to);
    return (_durCache[key] = { seconds: Math.round(meters / (15000 / 3600)), meters });
  }
  const osrmProfile = { car:'driving', bus:'driving', ferry:'driving', plane:null }[mode] || 'driving';
  // Plane: estimate via haversine + 800 km/h
  if (mode === 'plane' || osrmProfile === null) {
    const key = `${from.lat},${from.lng}→${to.lat},${to.lng}:plane`;
    if (key in _durCache) return _durCache[key];
    const meters  = _haversineMeters(from, to);
    const seconds = Math.round(meters / (800_000 / 3600));
    const result  = { seconds, meters };
    _durCache[key] = result;
    return result;
  }
  const key = `${from.lat},${from.lng}→${to.lat},${to.lng}:${osrmProfile}`;
  if (key in _durCache) return _durCache[key];
  try {
    const url  = `https://router.project-osrm.org/route/v1/${osrmProfile}/${from.lng},${from.lat};${to.lng},${to.lat}?overview=false`;
    const resp = await fetch(url);
    const data = await resp.json();
    const route = data.routes?.[0];
    const result = route ? { seconds: route.duration, meters: route.distance } : null;
    _durCache[key] = result;
    return result;
  } catch (_) {
    _durCache[key] = null;
    return null;
  }
}

function _fmtDuration(seconds) {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h}h` : `${h}h ${m}`;
}

function _fmtDistance(meters) {
  if (!meters) return '';
  return meters >= 1000 ? `${(meters / 1000).toFixed(0)} km` : `${Math.round(meters)} m`;
}
let _dragEvt          = null;      // { dayId, idx } being dragged
let _pendingModeChange = null;     // callback for route-mode popup
let _showDurLabels     = false;    // toggle duration labels on map routes
let _gpxLayers         = [];       // Leaflet layers for GPX overlays
let _worldCopyMarkers  = [];       // non-interactive copies at ±360° offsets
let _worldCopyOffsets  = new Set();
let _calTab            = 'planning'; // 'planning' | 'transport'
let _mapcalMobTab      = 'carte';    // 'carte' | 'jours' (mobile only)

// ─── Public API ───────────────────────────────────────────────────────────────

// Toggle between Carte and Jours sub-modes on mobile.
// Both use body-scroll; mc-carte-mode class drives the CSS map-height layout.
function _applyMcScreenMode(isCarteMode) {
  if (window.innerWidth > 768) return;
  const app = document.getElementById('screen-app');
  if (!app) return;
  app.classList.toggle('mc-carte-mode', isCarteMode);
  document.body.style.overflowY            = '';
  document.documentElement.style.overflowY = '';
  window.scrollTo(0, 0);
  if (isCarteMode) {
    setTimeout(() => { if (_map) _map.invalidateSize(); }, 80);
  }
}

export function renderMapCal(tripId) {
  _tripId = tripId;

  // Reset per-trip UI state so stale selections from a previous trip don't bleed in
  _openDayIds.clear();
  _activeEvtKey    = null;
  _pendingMapClick = null;
  _commentDayId    = null;
  _calTab          = 'planning';

  // Remove stale outside-click handler attached by _initMapSearch
  if (_mapSearchOutsideClickFn) {
    document.removeEventListener('click', _mapSearchOutsideClickFn);
    _mapSearchOutsideClickFn = null;
  }

  // Destroy existing map before replacing panel HTML to prevent
  // "Map container is already initialized" on re-render.
  if (_map) {
    try { _map.remove(); } catch (_) {}
    _map = null;
    _markers = {};
    _routeLayers = [];
  }

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
    <div class="mc-mob-tabs">
      <button class="bm-tab${_mapcalMobTab==='carte'?' active':''}" data-action="mc-tab" data-tab="carte">🗺 Carte</button>
      <button class="bm-tab${_mapcalMobTab==='jours'?' active':''}" data-action="mc-tab" data-tab="jours">📅 Jours</button>
    </div>
    <div class="mapcal${_mapcalMobTab==='jours'?' mc-jours-mode':''}">
      <div class="left-panel">
        <div class="lp-tabs">
          <button class="lp-tab-btn${_calTab === 'planning' ? ' active' : ''}" data-cal-tab="planning">📅 Planning</button>
          <button class="lp-tab-btn${_calTab === 'transport' ? ' active' : ''}" data-cal-tab="transport">🚗 Déplacements</button>
        </div>
        <div class="lp-top" id="lp-top-section" style="padding:12px 14px 8px;flex-shrink:0${_calTab === 'transport' ? ';display:none' : ''}">
          <h3 id="lp-title" style="font-family:var(--sf);font-size:15px;font-weight:700;color:var(--ink)">Planning</h3>
          <p style="font-size:11px;color:var(--ink4);margin-top:2px">Cliquez sur un événement pour les détails</p>
        </div>
        <div class="cal-hdr" id="cal-hdr" style="${_calTab === 'transport' ? 'display:none' : ''}">
          <span class="cal-hdr-lbl">Calendrier</span>
          <span class="cal-hdr-btn" id="cal-toggle">▲</span>
        </div>
        <div class="mini-cal" id="mini-cal" style="${_calTab === 'transport' ? 'display:none' : ''}"></div>
        <div class="days-list-header" id="days-list-header" style="display:${_calTab === 'transport' ? 'none' : 'flex'};align-items:center;justify-content:space-between;padding:4px 14px 2px;flex-shrink:0">
          <span style="font-size:11px;font-weight:600;color:var(--ink4);text-transform:uppercase;letter-spacing:.04em">Jours</span>
          <div style="display:flex;gap:4px;align-items:center">
            <button class="bc" id="fold-all-btn"
              style="padding:2px 7px;font-size:12px;line-height:1.4;border-radius:8px;font-weight:700"
              title="Tout plier / déplier">⊟</button>
            <button class="bc" id="add-day-top-btn" data-action="add-day"
              style="padding:2px 8px;font-size:13px;line-height:1.4;border-radius:8px;font-weight:700"
              title="Ajouter un jour / étape">＋</button>
          </div>
        </div>
        <div class="days-scroll" id="days-list" style="${_calTab === 'transport' ? 'display:none' : ''}"></div>
        <div class="days-scroll" id="transport-list" style="${_calTab === 'transport' ? '' : 'display:none'}"></div>
      </div>
      <div class="map-col">
        <button class="lp-toggle-btn" id="lp-toggle" title="Masquer / afficher le panneau">◀</button>
        <div id="map" style="width:100%;height:100%"></div>
        <div class="route-loading" id="route-loading" style="display:none">Calcul des itinéraires…</div>
        <button id="dur-toggle"
          style="position:absolute;bottom:24px;right:10px;z-index:1001;background:rgba(255,255,255,.92);border:1px solid rgba(0,0,0,.15);border-radius:8px;padding:5px 10px;font-size:11px;font-weight:600;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.15);white-space:nowrap;color:#1a1a1a"
          title="Afficher/masquer les durées de trajet">⏱ Durées</button>
        <div id="gpx-toolbar" style="position:absolute;bottom:24px;left:10px;z-index:1001;display:flex;gap:5px">
          <button id="gpx-export-btn"
            style="background:rgba(255,255,255,.92);border:1px solid rgba(0,0,0,.15);border-radius:8px;padding:5px 10px;font-size:11px;font-weight:600;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.15);color:#1a1a1a"
            title="Exporter le voyage en GPX">⬇ GPX</button>
          <button id="gpx-import-btn"
            style="background:rgba(255,255,255,.92);border:1px solid rgba(0,0,0,.15);border-radius:8px;padding:5px 10px;font-size:11px;font-weight:600;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.15);color:#1a1a1a"
            title="Importer une trace GPX">↑ GPX</button>
        </div>
        <input type="file" id="gpx-file-input" accept=".gpx" style="display:none">
        <div id="map-srch" style="position:absolute;top:10px;left:50%;transform:translateX(-50%);z-index:1002;width:320px;max-width:calc(100% - 100px);pointer-events:all">
          <div style="display:flex;border-radius:10px;overflow:hidden;box-shadow:0 2px 14px rgba(0,0,0,.22)">
            <input id="ms-input" type="text" placeholder="🔍 Rechercher un lieu…" autocomplete="off"
              style="flex:1;padding:9px 14px;border:none;font-size:13px;outline:none;color:#1a1a1a;background:#fff;min-width:0">
            <button id="ms-btn" title="Chercher"
              style="background:#0d9488;color:#fff;border:none;padding:0 14px;font-size:15px;cursor:pointer;flex-shrink:0">→</button>
          </div>
          <div id="ms-results" style="display:none;background:#fff;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.15);margin-top:4px;max-height:220px;overflow-y:auto"></div>
          <div id="ms-action" style="display:none;flex-direction:row;align-items:center;flex-wrap:wrap;background:#fff;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.15);margin-top:4px;padding:8px 10px;gap:8px">
            <span id="ms-action-label" style="flex:1;min-width:0;font-size:11px;font-weight:600;color:#1a1a1a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>
            <button id="ms-action-add" style="background:#0d9488;color:#fff;border:none;border-radius:7px;padding:5px 10px;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0">＋ Planifier</button>
            <button id="ms-action-close" style="background:none;border:none;cursor:pointer;color:#888;font-size:14px;padding:0;line-height:1;flex-shrink:0">✕</button>
          </div>
        </div>
      </div>
      <div class="comment-panel" id="comment-panel">
        <div class="cmp-hdr">
          <div class="cmp-day-label" id="cmp-day-label">Commentaires</div>
          <button class="cmp-close" onclick="window._closeCommentPanel && window._closeCommentPanel()">✕</button>
        </div>
        <div class="cmp-body" id="cmp-body"></div>
        <div class="cmp-footer">
          <input type="text" id="cmp-input" class="cmp-input" placeholder="Écrire…" autocomplete="off">
          <button id="cmp-send" class="cmp-send">→</button>
        </div>
      </div>
    </div>
  `;

  // Wire mobile Carte/Jours tab switcher
  const isMobileMc = window.innerWidth <= 768;
  if (isMobileMc) {
    const lp = panel.querySelector('.left-panel');
    if (lp && _mapcalMobTab !== 'jours') lp.classList.add('collapsed');
    panel.querySelectorAll('[data-action="mc-tab"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        if (tab === _mapcalMobTab) return;
        _mapcalMobTab = tab;
        panel.querySelectorAll('[data-action="mc-tab"]').forEach(b => {
          b.classList.toggle('active', b.dataset.tab === tab);
        });
        const mapcal = panel.querySelector('.mapcal');
        const lpEl   = panel.querySelector('.left-panel');
        if (tab === 'jours') {
          if (mapcal) mapcal.classList.add('mc-jours-mode');
          if (lpEl)   lpEl.classList.remove('collapsed');
        } else {
          if (mapcal) mapcal.classList.remove('mc-jours-mode');
          if (lpEl)   lpEl.classList.add('collapsed');
        }
        _applyMcScreenMode(tab !== 'jours');
      });
    });
    // Apply correct mode for the current tab state on first render
    _applyMcScreenMode(_mapcalMobTab !== 'jours');
  }

  // Attach event delegation for left panel (including drag-and-drop)
  _attachLeftPanelListeners(panel);

  // Wire planning / transport tab switcher
  panel.querySelectorAll('[data-cal-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      _calTab = btn.dataset.calTab;
      panel.querySelectorAll('[data-cal-tab]').forEach(b => b.classList.toggle('active', b.dataset.calTab === _calTab));
      const isTransport = _calTab === 'transport';
      const hide = s => { if (s) s.style.display = 'none'; };
      const show = (s, disp = '') => { if (s) s.style.display = disp; };
      hide(panel.querySelector('#lp-top-section'));
      hide(panel.querySelector('#cal-hdr'));
      hide(panel.querySelector('#mini-cal'));
      hide(panel.querySelector('#days-list-header'));
      hide(panel.querySelector('#days-list'));
      hide(panel.querySelector('#transport-list'));
      if (isTransport) {
        show(panel.querySelector('#transport-list'));
        const freshTrip = getTrip(tripId);
        if (freshTrip) {
          _renderTransportContent(freshTrip, tripId);
          _populateTransportDurations(freshTrip);
        }
      } else {
        show(panel.querySelector('#lp-top-section'));
        show(panel.querySelector('#cal-hdr'));
        show(panel.querySelector('#mini-cal'));
        show(panel.querySelector('#days-list-header'), 'flex');
        show(panel.querySelector('#days-list'));
      }
    });
  });

  // Init or re-init Leaflet map
  _initMap(tripId);

  // Render days list + mini-cal
  _renderDaysList(tripId);
  _renderMiniCal(tripId);

  // Wire left panel toggle button
  const lpToggle = panel.querySelector('#lp-toggle');
  if (lpToggle) {
    const lp = panel.querySelector('.left-panel');
    const isMobile = window.innerWidth <= 768;
    if (lp && isMobile) {
      lp.classList.add('collapsed');
      lpToggle.innerHTML = '&#9776;&nbsp;Jours';
    }

    lpToggle.addEventListener('click', () => {
      if (!lp) return;
      const collapsed = lp.classList.toggle('collapsed');
      const mob = window.innerWidth <= 768;
      lpToggle.innerHTML = collapsed ? (mob ? '&#9776;&nbsp;Jours' : '▶') : '◀';
      setTimeout(() => { if (_map) _map.invalidateSize(); }, 280);
    });
  }

  // Auto-collapse the left panel on mobile so the map is immediately usable
  if (window.innerWidth <= 768) {
    const lp = panel.querySelector('.left-panel');
    if (lp) {
      lp.classList.add('collapsed');
      if (lpToggle) lpToggle.innerHTML = '&#9776;&nbsp;Jours';
    }
  }

  // Wire fold-all / unfold-all button
  const foldAllBtn = panel.querySelector('#fold-all-btn');
  if (foldAllBtn) {
    foldAllBtn.addEventListener('click', () => {
      const trip2 = getTrip(tripId);
      if (!trip2) return;
      if (_openDayIds.size > 0) {
        _openDayIds.clear();
        foldAllBtn.textContent = '⊞';
      } else {
        (trip2.days || []).forEach(d => _openDayIds.add(d.id));
        foldAllBtn.textContent = '⊟';
      }
      _closeEDP();
      _renderDaysList(tripId);
      _renderMiniCal(tripId);
    });
  }

  // Wire GPX buttons
  panel.querySelector('#gpx-export-btn')?.addEventListener('click', () => _exportGpx(tripId));
  const gpxInput = panel.querySelector('#gpx-file-input');
  panel.querySelector('#gpx-import-btn')?.addEventListener('click', () => gpxInput?.click());
  if (gpxInput) {
    gpxInput.addEventListener('change', async () => {
      const file = gpxInput.files?.[0];
      if (!file) return;
      gpxInput.value = '';
      try {
        const text    = await file.text();
        const { tracks, waypoints } = parseGpx(text);
        if (!tracks.length && !waypoints.length) { notify('Aucune trace dans ce fichier GPX.', '⚠️'); return; }
        const allPoints = tracks.flatMap(t => t.points);
        if (!allPoints.length) { notify('Aucun point GPS dans cette trace.', '⚠️'); return; }
        const colors = ['#e85d3e','#0284c7','#7c3aed','#16a34a','#d97706'];
        const id     = 'gpx_' + Date.now();
        const track  = {
          id,
          name:       tracks[0]?.name || file.name.replace(/\.gpx$/i, ''),
          color:      colors[getLocalGpxTracks(tripId).length % colors.length],
          points:     allPoints,
          importedAt: new Date().toISOString(),
        };
        const stats = computeGpxStats(allPoints);
        const trip2 = getTrip(tripId);
        if (!trip2?.days?.length) {
          // No days yet — save directly without creating an event
          saveLocalGpxTrack(tripId, track);
          _drawGpxOverlays(tripId);
          notify(`Trace "${track.name}" importée`, '🗺');
          return;
        }
        _openGpxImportModal(tripId, track, stats);
      } catch (err) { notify('Erreur GPX : ' + err.message, '⚠️'); }
    });
  }

  // Wire duration labels toggle button
  const durToggleBtn = panel.querySelector('#dur-toggle');
  if (durToggleBtn) {
    if (!_showDurLabels) {
      durToggleBtn.style.opacity = '0.45';
      durToggleBtn.style.textDecoration = 'line-through';
    }
    durToggleBtn.addEventListener('click', () => {
      _showDurLabels = !_showDurLabels;
      if (_map) _map.getContainer().classList.toggle('hide-dur-labels', !_showDurLabels);
      // closeTooltip() removes the DOM element, so CSS alone can't re-show it.
      // Must call openTooltip()/closeTooltip() on every route layer explicitly.
      _routeLayers.forEach(l => {
        try { _showDurLabels ? l.openTooltip() : l.closeTooltip(); } catch (_) {}
      });
      durToggleBtn.style.opacity = _showDurLabels ? '1' : '0.45';
      durToggleBtn.style.textDecoration = _showDurLabels ? '' : 'line-through';
    });
  }

  // Wire calendar collapse toggle
  const calHdr = panel.querySelector('#cal-hdr');
  if (calHdr) {
    calHdr.addEventListener('click', () => {
      const cal = panel.querySelector('#mini-cal');
      const btn = panel.querySelector('#cal-toggle');
      if (!cal) return;
      const collapsed = cal.classList.toggle('cal-collapsed');
      if (btn) btn.textContent = collapsed ? '▼' : '▲';
    });
  }

  // Wire map search bar
  _initMapSearch(tripId);

  // Wire comment panel send / delete
  const cmpSend = panel.querySelector('#cmp-send');
  if (cmpSend) {
    cmpSend.addEventListener('click', () => {
      const input = panel.querySelector('#cmp-input');
      const text = input?.value?.trim();
      if (!text || !_commentDayId) return;
      input.value = '';
      submitComment(tripId, _commentDayId, text)
        .then(() => _renderCommentList(tripId, _commentDayId))
        .catch(err => console.warn('[mapcal] cmp submitComment:', err));
    });
  }
  const cmpInput = panel.querySelector('#cmp-input');
  if (cmpInput) {
    cmpInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') cmpSend?.click();
    });
  }
  const cmpPanelEl = panel.querySelector('#comment-panel');
  if (cmpPanelEl) {
    cmpPanelEl.addEventListener('click', e => {
      const btn = e.target instanceof Element ? e.target.closest('[data-cmp-del]') : null;
      if (!btn) return;
      const { dayId, commentId } = btn.dataset;
      if (dayId && commentId) {
        deleteDayComment(tripId, dayId, commentId)
          .then(() => _renderCommentList(tripId, dayId))
          .catch(err => console.warn('[mapcal] cmp deleteDayComment:', err));
      }
    });
  }

  // Re-open comment panel if it was open before this render
  if (_commentDayId) _openCommentPanel(tripId, _commentDayId);
}

export function destroyMap() {
  _closeMobileEventSheet();
  if (_map) {
    if (_tempSearchPin) { try { _map.removeLayer(_tempSearchPin); } catch (_) {} _tempSearchPin = null; }
    try { _map.remove(); } catch (_) { /* already removed */ }
    _map = null;
  }
  _markers      = {};
  _routeLayers  = [];
  _gpxLayers    = [];
  _openDayIds   = new Set();
  _activeEvtKey = null;
  _pendingMapClick = null;
  _dragEvt      = null;
  _commentDayId = null;
}

// ─── GPX overlay rendering ────────────────────────────────────────────────────

function _drawGpxOverlays(tripId) {
  if (!_map) return;
  for (const layer of _gpxLayers) { try { _map.removeLayer(layer); } catch (_) {} }
  _gpxLayers = [];

  const trip = getTrip(tripId);

  for (const track of getLocalGpxTracks(tripId)) {
    if (!track.points?.length) continue;

    // Find the event item linked to this track via gpxTrackId
    let assocDayId  = null;
    let assocEvtIdx = -1;
    if (trip) {
      outer: for (const day of (trip.days || [])) {
        for (let i = 0; i < (day.items || []).length; i++) {
          if (day.items[i].gpxTrackId === track.id) {
            assocDayId  = day.id;
            assocEvtIdx = i;
            break outer;
          }
        }
      }
    }

    const color   = track.color || '#e85d3e';
    const latlngs = track.points.map(p => [p.lat, p.lng]);
    const line    = L.polyline(latlngs, { color, weight: 3.5, opacity: 0.8, dashArray: '6 3' });
    line.bindTooltip(track.name, { sticky: true });

    if (assocDayId !== null) {
      // Click on trace → open linked event EDP (stop propagation to prevent map click)
      line.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        _openDayIds.add(assocDayId);
        _openEDP(assocDayId, assocEvtIdx, tripId);
      });
      // Draw a start PIN marker for this trace
      const startPt  = track.points[0];
      const assocEvt = trip?.days?.flatMap(d => d.items || []).find(it => it.gpxTrackId === track.id);
      const et       = assocEvt ? getEventTypes().find(t => t.key === assocEvt.type) : null;
      const gpxIcon  = L.divIcon({
        className: '',
        html: `<div style="background:${color};border:2px solid #fff;border-radius:50%;width:26px;height:26px;display:flex;align-items:center;justify-content:center;font-size:14px;box-shadow:0 1px 5px rgba(0,0,0,.4);cursor:pointer">${et?.emoji || '🥾'}</div>`,
        iconSize: [26, 26], iconAnchor: [13, 13], popupAnchor: [0, -18],
      });
      const startMarker = L.marker([startPt.lat, startPt.lng], { icon: gpxIcon, zIndexOffset: 100 });
      startMarker.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        _openDayIds.add(assocDayId);
        _openEDP(assocDayId, assocEvtIdx, tripId);
      });
      startMarker.addTo(_map);
      _gpxLayers.push(startMarker);
    } else {
      // Legacy track (no linked event): right-click to delete
      line.on('contextmenu', () => {
        if (!confirm(`Supprimer la trace "${track.name}" ?`)) return;
        removeLocalGpxTrack(tripId, track.id);
        _drawGpxOverlays(tripId);
      });
    }

    line.addTo(_map);
    _gpxLayers.push(line);
  }
}

function _exportGpx(tripId) {
  const trip = getTrip(tripId);
  if (!trip) return;
  const waypoints = [];
  for (const day of (trip.days || [])) {
    for (const item of (day.items || [])) {
      if (item.lat != null && item.lng != null) {
        waypoints.push({ lat: item.lat, lng: item.lng, name: item.text || `Jour ${day.num}`, desc: day.date || '' });
      }
    }
    if (!waypoints.length && day.lat != null && day.lng != null) {
      waypoints.push({ lat: day.lat, lng: day.lng, name: `Jour ${day.num}`, desc: day.date || '' });
    }
  }
  if (!waypoints.length) { notify('Aucun PIN à exporter.', '⚠️'); return; }
  const gpx = generateGpx(trip.name, waypoints);
  downloadFile(`${trip.name.replace(/[^a-z0-9]/gi, '-')}.gpx`, gpx);
  notify(`${waypoints.length} waypoints exportés en GPX`, '✓');
}

// ─── GPX import modal ────────────────────────────────────────────────────────

function _openGpxImportModal(tripId, track, stats) {
  const trip      = getTrip(tripId);
  if (!trip) return;
  const evtTypes  = getEventTypes();
  const hikerType = evtTypes.find(t => t.key === 'hiker') || evtTypes.find(t => t.key === 'activity') || evtTypes[0];
  let selType     = hikerType?.key || 'activity';
  const days      = trip.days || [];
  const defaultDayId = [..._openDayIds][0] || days[0]?.id || '';

  function _fmtDist(m) {
    return m >= 1000 ? (m / 1000).toFixed(1) + ' km' : m + ' m';
  }
  function _fmtDur(s) {
    if (!s) return null;
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return h > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${m} min`;
  }

  const distStr = _fmtDist(stats.distanceM || 0);
  const gainStr = stats.elevGain ? '+' + Math.round(stats.elevGain) + ' m' : '—';
  const lossStr = stats.elevLoss ? '−' + Math.round(stats.elevLoss) + ' m' : '—';
  const durStr  = _fmtDur(stats.durationSecs);

  const dayOptions = days.map(d =>
    `<option value="${_esc(d.id)}"${d.id === defaultDayId ? ' selected' : ''}>Jour ${d.num}${customDayTitle(d) ? ' – ' + _esc(customDayTitle(d)) : ''}${d.date ? ' (' + d.date + ')' : ''}</option>`
  ).join('');

  showModal(`
    <h3>🗺 Importer une trace GPX</h3>

    <div class="fg">
      <label>Nom</label>
      <input type="text" id="gi-name" value="${_esc(track.name)}" placeholder="Nom de la randonnée…" autocomplete="off">
    </div>

    <div style="background:var(--c2);border-radius:8px;padding:10px 14px;margin-bottom:12px;border:1px solid var(--c3)">
      <div style="font-size:11px;font-weight:700;color:var(--ink3);margin-bottom:8px">Statistiques de la trace</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;text-align:center">
        <div>
          <div style="font-size:15px;font-weight:800;color:var(--ink)">${distStr}</div>
          <div style="font-size:10px;color:var(--ink4)">Distance</div>
        </div>
        <div>
          <div style="font-size:14px;font-weight:700;color:#16a34a">${gainStr}</div>
          <div style="font-size:10px;color:var(--ink4)">Dénivelé +</div>
        </div>
        <div>
          <div style="font-size:14px;font-weight:700;color:#e85d3e">${lossStr}</div>
          <div style="font-size:10px;color:var(--ink4)">Dénivelé −</div>
        </div>
        ${durStr ? `<div style="grid-column:1/-1;margin-top:2px">
          <div style="font-size:14px;font-weight:700;color:var(--ink)">${durStr}</div>
          <div style="font-size:10px;color:var(--ink4)">Durée</div>
        </div>` : ''}
      </div>
      <div style="font-size:10px;color:var(--ink4);text-align:center;margin-top:6px">${stats.pointCount} points GPS</div>
    </div>

    <div class="fg">
      <label>Type d'événement</label>
      <div style="display:flex;gap:6px;flex-wrap:wrap" id="gi-types">
        ${evtTypes.map(et => {
          const active = et.key === selType;
          return `<button class="tp${active ? ' sel' : ''}" data-gi-type="${_esc(et.key)}"
            style="${active ? `background:${et.color};border-color:${et.color};color:#fff` : ''}">${et.emoji} ${et.label}</button>`;
        }).join('')}
      </div>
    </div>

    <div class="fg">
      <label>Ajouter au jour</label>
      <select id="gi-day" style="width:100%;padding:7px 8px;border:1.5px solid var(--c3);border-radius:6px;font-size:12px;background:var(--bg);color:var(--ink)">
        ${dayOptions}
      </select>
    </div>

    <div class="fg">
      <label>Notes</label>
      <textarea id="gi-notes" class="notes-ta" placeholder="Conditions, remarques…" style="min-height:45px"></textarea>
    </div>

    <div class="ma">
      <button class="bc" id="gi-cancel">Annuler</button>
      <button class="bs" id="gi-save">Ajouter comme événement</button>
    </div>
  `);

  document.getElementById('gi-types')?.addEventListener('click', e => {
    const pill = e.target.closest('[data-gi-type]');
    if (!pill) return;
    selType = pill.dataset.giType;
    document.querySelectorAll('[data-gi-type]').forEach(p => {
      const tKey   = p.dataset.giType;
      const et     = evtTypes.find(t => t.key === tKey);
      const active = tKey === selType;
      p.classList.toggle('sel', active);
      p.style.background  = active ? (et?.color || '') : '';
      p.style.borderColor = active ? (et?.color || '') : '';
      p.style.color       = active ? '#fff' : '';
    });
  });

  document.getElementById('gi-cancel')?.addEventListener('click', closeModal);

  document.getElementById('gi-save')?.addEventListener('click', () => {
    const name  = (document.getElementById('gi-name')?.value  || '').trim() || track.name;
    const dayId = document.getElementById('gi-day')?.value;
    const notes = (document.getElementById('gi-notes')?.value || '').trim();

    const trip2 = getTrip(tripId);
    if (!trip2) return;
    const day = (trip2.days || []).find(d => d.id === dayId);
    if (!day) { notify('Jour introuvable', '⚠️'); return; }

    const startPt = track.points[0];
    const selEt   = evtTypes.find(t => t.key === selType);
    // Subsample track to ≤300 points for Firestore storage (available to observers).
    // Keeps the full point (lat/lng/ele/time) — stripping to lat/lng only, as this
    // used to, silently disabled the elevation/speed chart everywhere this track's
    // stats are shown, since it needs ele/time to build those series.
    const gpxPoints = downsampleGpxPoints(track.points);
    const event   = {
      id:         'e_' + uid(),
      type:       selType,
      emoji:      selEt?.emoji || null,
      color:      selEt?.color || null,
      text:       name,
      time:       null,
      cost:       0,
      notes,
      lat:        startPt.lat,
      lng:        startPt.lng,
      gpxTrackId: track.id,
      gpxStats:   stats,
      gpxPoints,
    };

    if (day.lat == null) {
      day.lat = startPt.lat;
      day.lng = startPt.lng;
    }
    day.items.push(event);
    updateTrip(tripId, { days: trip2.days });

    saveLocalGpxTrack(tripId, track);

    closeModal();
    _openDayIds.add(dayId);
    _renderDaysList(tripId);
    _refreshMapPins(tripId);
    _drawGpxOverlays(tripId);
    notify(`Trace "${name}" importée`, '🥾');
  });
}

// ─── Map initialization ───────────────────────────────────────────────────────

function _initMap(tripId) {
  if (_map) {
    try {
      const container = _map.getContainer();
      if (document.contains(container)) {
        setTimeout(() => { if (_map) _map.invalidateSize(); }, 80);
        _refreshMapPins(tripId);
        return;
      }
    } catch (_) {}
    // Container gone — destroy and reinitialize
    try { _map.remove(); } catch (_) {}
    _map = null;
    _markers = {};
    _routeLayers = [];
  }

  requestAnimationFrame(() => {
    if (_map) return; // concurrent init guard — prevent double-init
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

    _map = L.map('map', {
      center, zoom, zoomControl: true,
      minZoom:            2,
      maxBounds:          [[-85.051129, -1e10], [85.051129, 1e10]],
      maxBoundsViscosity: 1.0,
    });

    _map.on('moveend', _ensureWorldCopiesForViewport);
    if (!_showDurLabels) _map.getContainer().classList.add('hide-dur-labels');

    const _lang = getLanguage();
    const _tileUrl = _lang === 'en'
      ? 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png'
      : 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png';
    L.tileLayer(_tileUrl, {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 18,
    }).addTo(_map);

    // Map click handler
    _map.on('click', e => {
      if (_pendingMapClick) {
        _pendingMapClick(e.latlng.lat, e.latlng.lng);
        _pendingMapClick = null;
      } else if (_openDayIds.size > 0) {
        // Direct map click → add event to last open day
        const lastDayId = [..._openDayIds].at(-1);
        _openAddEventModal(lastDayId, tripId, { lat: e.latlng.lat, lng: e.latlng.lng });
      }
    });

    _map.invalidateSize();
    setTimeout(() => { if (_map) _map.invalidateSize(); }, 150);

    _refreshMapPins(tripId);
    _drawGpxOverlays(tripId);
  });
}

// ─── Map pins & routes ────────────────────────────────────────────────────────

function _refreshMapPins(tripId) {
  if (!_map) return;
  const trip = getTrip(tripId);
  if (!trip) return;

  // Remove existing markers and world-copy clones
  Object.values(_markers).forEach(m => { try { _map.removeLayer(m); } catch (_) {} });
  _markers = {};
  _worldCopyMarkers.forEach(m => { try { _map.removeLayer(m); } catch (_) {} });
  _worldCopyMarkers = [];
  _worldCopyOffsets.clear();

  // Remove existing route layers
  _routeLayers.forEach(l => { try { _map.removeLayer(l); } catch (_) {} });
  _routeLayers = [];

  const days = (trip.days || []).filter(d => _getDayMarkerPos(d) !== null);

  days.forEach(day => {
    const pos = _getDayMarkerPos(day);
    const marker = L.marker([pos.lat, pos.lng], {
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
    // First item with coords is covered by the number pin — skip its standalone marker
    const firstItemWithCoords = (day.items || []).find(it => it.lat != null && it.lng != null);
    (day.items || []).forEach((item, itemIdx) => {
      if (item.lat != null && item.lng != null) {
        if (item === firstItemWithCoords) return;
        const evtIcon = L.divIcon({
          className: '',
          html: `<div style="background:${day.color || '#0d9488'};border:2px solid #fff;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:13px;box-shadow:0 1px 4px rgba(0,0,0,.4);cursor:pointer">${tIc(item.type, item)}</div>`,
          iconSize:   [24, 24],
          iconAnchor: [12, 12],
          popupAnchor:[0, -16],
        });
        const evtMarker = L.marker([item.lat, item.lng], { icon: evtIcon, zIndexOffset: 50 });
        evtMarker.bindPopup(
          `<div style="padding:4px 2px;min-width:120px">
            <div style="font-weight:700;font-size:12px">${_esc(item.text || '—')}</div>
            <div style="font-size:10px;color:var(--ink4)">Jour ${day.num}${item.time ? ' · ' + item.time : ''}${item.cost ? ' · ' + Number(item.cost).toLocaleString('fr-FR') + ' €' : ''}</div>
          </div>`,
          { maxWidth: 200 }
        );
        evtMarker.on('click', () => {
          _openDayIds.add(day.id);
          _openEDP(day.id, itemIdx, tripId);
        });
        evtMarker.addTo(_map);
        _markers['e_' + item.id] = evtMarker;
      }
    });
  }

  // Draw routes through all georeferenced waypoints
  if (_collectAllWaypoints(trip).length > 1) {
    _drawRouteGen++;
    _drawRoutes(trip, days, _drawRouteGen);
  }

  // Seed ±1 world-copy marker sets so pins appear when scrolling left/right
  _placeWorldCopies(1);
  _placeWorldCopies(-1);

  // Fit bounds if we have pins
  if (days.length === 1) {
    const pos0 = _getDayMarkerPos(days[0]);
    _map.setView([pos0.lat, pos0.lng], 10, { animate: true });
  } else if (days.length > 1) {
    const bounds = days.map(d => { const p = _getDayMarkerPos(d); return [p.lat, p.lng]; });
    _map.fitBounds(bounds, { padding: [40, 40], maxZoom: 12 });
  }
}

function _placeWorldCopies(offsetMultiple) {
  if (!_map) return;
  if (_worldCopyOffsets.has(offsetMultiple)) return;
  _worldCopyOffsets.add(offsetMultiple);
  const lngOffset = offsetMultiple * 360;
  Object.values(_markers).forEach(m => {
    const ll   = m.getLatLng();
    const copy = L.marker([ll.lat, ll.lng + lngOffset], {
      icon: m.options.icon, interactive: false, keyboard: false,
    });
    copy.addTo(_map);
    _worldCopyMarkers.push(copy);
  });
}

function _ensureWorldCopiesForViewport() {
  if (!_map) return;
  const b      = _map.getBounds();
  const minOff = Math.floor(b.getWest() / 360);
  const maxOff = Math.ceil(b.getEast() / 360);
  for (let o = minOff; o <= maxOff; o++) {
    if (o !== 0) _placeWorldCopies(o);
  }
}

function _makeDayIcon(day) {
  const color      = day.color || '#0d9488';
  const num        = day.num != null ? String(day.num) : '•';
  const firstPin   = (day.items || []).find(it => it.lat != null && it.lng != null);
  const typeEmoji  = firstPin ? tIc(firstPin.type, firstPin) : null;
  const pinW       = typeEmoji ? 36 : 28;
  const innerHtml  = typeEmoji
    ? `<span style="font-size:10px;line-height:1;margin-right:1px">${typeEmoji}</span><span>${num}</span>`
    : num;
  const radius     = typeEmoji ? 'border-radius:10px' : 'border-radius:50%';
  return L.divIcon({
    className: '',
    html: `<div class="wp-pin">
      <div class="pin-c" style="background:${color};width:${pinW}px;${radius}">${innerHtml}</div>
      <div class="pin-tail" style="background:${color};"></div>
    </div>`,
    iconSize:   [pinW, 36],
    iconAnchor: [pinW / 2, 36],
    popupAnchor:[0, -38],
  });
}

// Returns effective map position for the day number pin: first event coords, or day fallback
function _getDayMarkerPos(day) {
  const firstPin = (day.items || []).find(it => it.lat != null && it.lng != null);
  if (firstPin) return { lat: firstPin.lat, lng: firstPin.lng };
  if (day.lat != null && day.lng != null) return { lat: day.lat, lng: day.lng };
  return null;
}

function _dayPopupHtml(day) {
  const items  = (day.items || []).slice(0, 3);
  const rows   = items.map(it => `<div class="lp-row">${tIc(it.type, it)} ${_esc(it.text || '')}</div>`).join('');
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

// Return the active night stay for a given ISO date (the night of that date)
function _nightForDate(trip, isoDate) {
  for (const day of (trip.days || [])) {
    for (const item of (day.items || [])) {
      if (item.type === 'sleep' && item.lat != null && item.lng != null &&
          item.dateFrom && item.dateTo &&
          item.dateFrom <= isoDate && isoDate <= item.dateTo) {
        return { id: item.id, lat: item.lat, lng: item.lng,
                 name: item.text, dateFrom: item.dateFrom, dateTo: item.dateTo,
                 color: item.color || '#7c3aed' };
      }
    }
  }
  return null;
}

// Collect ALL georeferenced waypoints from items + fallback to day pins.
// Night stays inject a "return home" waypoint at the end of each covered day,
// and a "depart from" waypoint at the start of the following day.
function _collectAllWaypoints(trip) {
  const wps  = [];
  const days = (trip.days || []).slice().sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  for (let di = 0; di < days.length; di++) {
    const day = days[di];

    // --- Departure from previous night ---
    if (day.date && di > 0) {
      const prev = days[di - 1];
      if (prev.date) {
        const depNight = _nightForDate(trip, prev.date);
        if (depNight) {
          const last = wps[wps.length - 1];
          // Avoid duplicate if previous day already ended at this night
          const already = last && last.nightId === depNight.id;
          if (!already) {
            wps.push({ dayId: day.id, itemId: null, lat: depNight.lat, lng: depNight.lng,
              mode: day.departNightMode || 'car', label: depNight.name || '🌙 Nuit',
              isNight: true, isDepartNight: true, nightId: depNight.id });
          }
        }
      }
    }

    // --- Regular day pins ---
    const itemPins = (day.items || []).filter(it => it.lat != null && it.lng != null && it.type !== 'sleep');
    if (itemPins.length > 0) {
      for (const item of itemPins) {
        let mode = item.routeMode || 'car';
        if (item.type === 'drive' && item.transport) mode = item.transport;
        wps.push({ dayId: day.id, itemId: item.id, lat: item.lat, lng: item.lng, mode, label: item.text });
      }
    } else if (day.lat != null && day.lng != null) {
      wps.push({ dayId: day.id, itemId: null, lat: day.lat, lng: day.lng, mode: day.routeMode || 'car', label: `Jour ${day.num}` });
    }

    // --- Return to night at end of day ---
    if (day.date) {
      const retNight = _nightForDate(trip, day.date);
      if (retNight) {
        const last = wps[wps.length - 1];
        const already = last && last.nightId === retNight.id;
        if (!already) {
          wps.push({ dayId: day.id, itemId: null, lat: retNight.lat, lng: retNight.lng,
            mode: day.returnNightMode || 'car', label: retNight.name || '🌙 Nuit',
            isNight: true, isReturnNight: true, nightId: retNight.id });
        }
      }
    }
  }
  return wps;
}

const _TRANSPORT_MODES = [
  { key: 'car',   emoji: '🚗', label: 'Voiture' },
  { key: 'train', emoji: '🚆', label: 'Train' },
  { key: 'bus',   emoji: '🚌', label: 'Bus/Taxi' },
  { key: 'bike',  emoji: '🚲', label: 'Vélo' },
  { key: 'foot',  emoji: '🚶', label: 'À pied' },
  { key: 'plane', emoji: '✈️', label: 'Avion' },
  { key: 'ferry', emoji: '⛴️', label: 'Bateau' },
];

function _renderTransportContent(trip, tripId) {
  const container = document.getElementById('transport-list');
  if (!container) return;

  const wps = _collectAllWaypoints(trip);
  if (wps.length < 2) {
    container.innerHTML = `
      <div style="text-align:center;padding:32px 16px;color:var(--ink4)">
        <div style="font-size:28px;margin-bottom:6px">🗺</div>
        <div style="font-size:12px">Ajoutez des étapes avec des coordonnées GPS<br>pour gérer les déplacements.</div>
      </div>`;
    return;
  }

  container.innerHTML = wps.slice(1).map((toWp, idx) => {
    const fromWp = wps[idx];
    const cur    = toWp.mode || 'car';
    const modeBtns = _TRANSPORT_MODES.map(m =>
      `<button class="tp-mode-btn${cur === m.key ? ' active' : ''}"
        data-action="pick-transport" data-seg="${idx}" data-mode="${m.key}"
        title="${m.label}">${m.emoji}</button>`
    ).join('');
    return `
      <div class="tp-seg">
        <div class="tp-seg-label">
          <span class="tp-seg-from">${_esc(fromWp.label || '—')}</span>
          <span class="tp-seg-arrow">→</span>
          <span class="tp-seg-to">${_esc(toWp.label || '—')}</span>
          <span class="tp-seg-dur" id="tp-dur-${idx}"></span>
        </div>
        <div class="tp-seg-modes">${modeBtns}</div>
      </div>`;
  }).join('');
}

async function _populateTransportDurations(trip) {
  const wps = _collectAllWaypoints(trip);
  for (let i = 0; i < wps.length - 1; i++) {
    const el = document.getElementById(`tp-dur-${i}`);
    if (!el) continue;
    try {
      const from = wps[i];
      const to   = wps[i + 1];
      const mode = to.mode || 'car';
      const dur  = await _fetchDuration(from, to, mode);
      if (dur && el.isConnected) {
        el.textContent = `${_fmtDuration(dur.seconds)} · ${_fmtDistance(dur.meters)}`;
      }
    } catch (_) {}
  }
}

// Make a polyline segment clickable for transport mode selection
function _bindRouteModeClick(polyline, toWp) {
  const MODES = [
    { key: 'car',   emoji: '🚗', label: 'Voiture' },
    { key: 'train', emoji: '🚆', label: 'Train' },
    { key: 'bus',   emoji: '🚌', label: 'Bus/Taxi' },
    { key: 'bike',  emoji: '🚲', label: 'Vélo' },
    { key: 'foot',  emoji: '🚶', label: 'À pied' },
    { key: 'plane', emoji: '✈️', label: 'Avion' },
    { key: 'ferry', emoji: '⛴️', label: 'Bateau' },
  ];

  polyline.on('click', e => {
    const cur = toWp.mode || 'car';
    const btns = MODES.map(m =>
      `<button onclick="window._mapcalPickMode('${m.key}')" title="${m.label}"
        style="padding:5px 9px;border-radius:6px;font-size:14px;cursor:pointer;
        background:${cur === m.key ? '#0d9488' : '#f5f5f5'};
        color:${cur === m.key ? '#fff' : '#333'};
        border:1.5px solid ${cur === m.key ? '#0d9488' : '#ddd'}">${m.emoji}</button>`
    ).join('');

    _pendingModeChange = (newMode) => {
      const trip = getTrip(_tripId);
      if (!trip) return;
      if (toWp.itemId) {
        const day  = (trip.days || []).find(d => d.id === toWp.dayId);
        const item = (day?.items || []).find(it => it.id === toWp.itemId);
        if (item) {
          // Same priority as _collectAllWaypoints: 'drive' items are read from
          // item.transport, so that's the field that must actually be written.
          if (item.type === 'drive') item.transport = newMode;
          else item.routeMode = newMode;
          toWp.mode = newMode;
        }
      } else {
        const day = (trip.days || []).find(d => d.id === toWp.dayId);
        if (day) {
          // Same field split as the write path above: a night pin's arrival edge
          // depends on whether it's the depart-from-night or return-to-night leg.
          if (toWp.isDepartNight) day.departNightMode = newMode;
          else if (toWp.isReturnNight) day.returnNightMode = newMode;
          else day.routeMode = newMode;
          toWp.mode = newMode;
        }
      }
      updateTrip(_tripId, { days: trip.days });
      _map?.closePopup();
      // Redraw routes — must bump gen counter or the guard in _drawRoutes exits early
      _routeLayers.forEach(l => { try { _map.removeLayer(l); } catch (_) {} });
      _routeLayers = [];
      const freshTrip = getTrip(_tripId);
      _drawRouteGen++;
      if (freshTrip) _drawRoutes(freshTrip, [], _drawRouteGen);
    };

    L.popup({ maxWidth: 260, closeButton: true })
      .setLatLng(e.latlng)
      .setContent(`
        <div style="font-size:11px;font-weight:700;color:#333;margin-bottom:7px">Mode de transport</div>
        <div style="display:flex;gap:5px;flex-wrap:wrap">${btns}</div>
      `)
      .openOn(_map);

    L.DomEvent.stopPropagation(e);
  });
}

window._mapcalPickMode = function(mode) {
  if (_pendingModeChange) { _pendingModeChange(mode); _pendingModeChange = null; }
};

async function _drawRoutes(trip, _days, myGen) {
  if (!_map) return;

  const loadEl = document.getElementById('route-loading');
  if (loadEl) loadEl.style.display = 'block';
  _routeLoading = true;

  const wps = _collectAllWaypoints(trip);

  for (let i = 0; i < wps.length - 1; i++) {
    if (!_map || _drawRouteGen !== myGen) {
      // A newer generation started — clean up spinner so it doesn't freeze on screen
      if (loadEl) loadEl.style.display = 'none';
      _routeLoading = false;
      return;
    }
    const from = wps[i];
    const to   = wps[i + 1];
    const mode = to.mode || 'car';

    let line = null;
    let dur  = null; // { seconds, meters }

    if (mode === 'plane' || mode === 'ferry') {
      const speedKph = mode === 'plane' ? 800 : 30;
      const meters   = _haversineMeters(from, to);
      dur = { seconds: Math.round(meters / (speedKph * 1000 / 3600)), meters };
      line = L.polyline([[from.lat, from.lng], [to.lat, to.lng]], {
        color:     trCol(mode),
        weight:    2,
        opacity:   0.65,
        dashArray: '8 6',
      });
    } else {
      try {
        const profile = _osrmProfile(mode);
        const url = `https://router.project-osrm.org/route/v1/${profile}/`
          + `${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
        const resp  = await fetch(url);
        const data  = await resp.json();
        const route = data.routes?.[0];
        if (route?.geometry?.coordinates?.length) {
          // Train: use OSRM geometry for the visual path but estimate duration via
          // haversine×1.15 (rail is more direct than roads) at 150 km/h average.
          if (mode === 'train') {
            const straightM = _haversineMeters(from, to) * 1.15;
            dur = { seconds: Math.round(straightM / (150_000 / 3600)), meters: Math.round(straightM) };
          } else {
            dur = { seconds: route.duration, meters: route.distance };
          }
          line = L.polyline(route.geometry.coordinates.map(([lng, lat]) => [lat, lng]), {
            color:   trCol(mode),
            weight:  4,
            opacity: 0.75,
          });
        }
      } catch (_) {}

      if (!line) {
        line = L.polyline([[from.lat, from.lng], [to.lat, to.lng]], {
          color: '#9c9890', weight: 2, opacity: 0.4, dashArray: '4 4',
        });
      }
    }

    // Guard: user may have navigated away (destroyMap called) while the
    // fetch was in flight — _map is null in that case.
    if (!_map) return;

    if (line) {
      try {
        line.addTo(_map);
        _routeLayers.push(line);
        _bindRouteModeClick(line, to);
        if (dur) {
          const label = `${trIc(mode)} ${_fmtDuration(dur.seconds)} · ${_fmtDistance(dur.meters)}`;
          line.bindTooltip(label, {
            permanent:  true,
            direction:  'center',
            opacity:    0.92,
            className:  'route-dur-tip',
          });
          if (!_showDurLabels) line.closeTooltip();
        }
      } catch (_) {
        // Map destroyed while async route fetch was in flight — ignore
      }
    }
  }

  if (loadEl) loadEl.style.display = 'none';
  _routeLoading = false;
}

function _osrmProfile(mode) {
  const map = { car: 'driving', bus: 'driving', foot: 'foot', bike: 'cycling', train: 'driving' };
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

      if (day) {
        cls   += ' sd';
        style  = `background:${day.color || 'var(--teal)'};color:#fff;font-weight:700`;
        if (_openDayIds.has(day.id)) {
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

  const sharedDocData = isTripShared(tripId) ? getSharedDocData(tripId) : null;
  const html = days.map(day => _dayItemHtml(day, sharedDocData, trip)).join('');
  container.innerHTML = html;

  // Asynchronously populate weather (non-blocking); durations shown on map routes
  _populateWeather(days);
}

async function _populateWeather(days) {
  for (const day of days) {
    if (!day.date) continue;
    let coords = _getDayCoords(day);
    if (!coords) {
      // No pinned coords — try geocoding the day's region or title
      const label = day.region || day.title;
      if (label) coords = await _geocodeRegion(label);
    }
    if (!coords) continue;
    const wx = await _fetchDayWeather(coords.lat, coords.lng, day.date);
    if (!wx) continue;
    const el = document.getElementById(`wx-${day.id}`);
    if (el) el.textContent = `${wx.emoji} ${wx.tmax}°`;
  }
}

async function _populateDurations(days) {
  let prevPoint = null; // { lat, lng, dayId, elId }

  for (const day of days) {
    const items = day.items || [];

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.lat == null || it.lng == null) continue;

      let mode = it.routeMode || 'car';
      if (it.type === 'drive' && it.transport) mode = it.transport;

      if (prevPoint) {
        // Cross-day: connector goes in the "last-item" slot of the FROM day
        // Intra-day: connector goes after the FROM item
        const elId = prevPoint.dayId !== day.id
          ? `dur-last-${prevPoint.dayId}`
          : `dur-${prevPoint.dayId}-${prevPoint.idx}`;

        const el = document.getElementById(elId);
        if (el) {
          const dur = await _fetchDuration(prevPoint, it, mode);
          if (dur) {
            el.style.display = '';
            el.innerHTML = `<span style="display:inline-flex;align-items:center;gap:4px;background:var(--c2);border-radius:8px;padding:2px 8px;border:1px solid var(--c3);font-size:11px">${trIc(mode)} <b style="font-weight:600">${_fmtDuration(dur.seconds)}</b><span style="color:var(--ink4)">${_fmtDistance(dur.meters)}</span></span>`;
          }
        }
      }

      prevPoint = { lat: it.lat, lng: it.lng, dayId: day.id, idx: i };
    }

    // Day-level pin: acts as waypoint when no item in this day has coords
    if (items.every(it => it.lat == null || it.lng == null) && day.lat != null && day.lng != null) {
      const mode = day.routeMode || 'car';
      if (prevPoint) {
        const elId = prevPoint.dayId !== day.id
          ? `dur-last-${prevPoint.dayId}`
          : `dur-${prevPoint.dayId}-${prevPoint.idx}`;
        const el = document.getElementById(elId);
        if (el) {
          const dur = await _fetchDuration(prevPoint, day, mode);
          if (dur) {
            el.style.display = '';
            el.innerHTML = `<span style="display:inline-flex;align-items:center;gap:4px;background:var(--c2);border-radius:8px;padding:2px 8px;border:1px solid var(--c3);font-size:11px">${trIc(mode)} <b style="font-weight:600">${_fmtDuration(dur.seconds)}</b><span style="color:var(--ink4)">${_fmtDistance(dur.meters)}</span></span>`;
          }
        }
      }
      prevPoint = { lat: day.lat, lng: day.lng, dayId: day.id, idx: -1 };
    }
  }
}

function _getDayCoords(day) {
  if (day.lat != null && day.lng != null) return { lat: day.lat, lng: day.lng };
  const first = (day.items || []).find(it => it.lat != null && it.lng != null);
  if (first) return { lat: first.lat, lng: first.lng };
  return null;
}

function _dayItemHtml(day, sharedDocData = null, trip = null) {
  const isSelected = _openDayIds.has(day.id);
  const items = day.items || [];

  // Cost total
  const cost = items.reduce((s, it) => s + (Number(it.cost) || 0), 0);
  const costStr = cost > 0 ? `${cost.toLocaleString('fr-FR')} €` : '';

  let eventsHtml = '';
  if (isSelected) {
    const evtRows = items.map((it, idx) => {
      const isSelEvt = _activeEvtKey && _activeEvtKey.dayId === day.id && _activeEvtKey.idx === idx;
      // Sleep items render as a badge identical to the night badge on covered days
      if (it.type === 'sleep') {
        const slpCol = tCol('sleep', it);
        return `<div class="night-badge${isSelEvt ? ' sel-evt' : ''}"
                     style="cursor:pointer;color:${slpCol};background:${slpCol}1a;display:flex"
                     data-action="open-event" data-day-id="${day.id}" data-event-idx="${idx}">
          🌙 ${_esc(it.text || 'Nuit')}
        </div>`;
      }
      return `
        <div class="evt-row${isSelEvt ? ' sel-evt' : ''}"
             draggable="true"
             data-action="open-event"
             data-day-id="${day.id}"
             data-event-idx="${idx}"
             style="cursor:grab">
          <span class="evt-ic" style="color:${tCol(it.type, it)}">${it.type === 'drive' ? trIc(it.transport || 'car') : tIc(it.type, it)}</span>
          <div class="evt-info">
            <div class="evt-txt">${_esc(it.text || '—')}</div>
            <div class="evt-tm">${it.time ? it.time : ''}${it.cost ? (it.time ? ' · ' : '') + Number(it.cost).toLocaleString('fr-FR') + ' €' : ''}</div>
          </div>
          <div class="evt-move">
            <button class="evt-move-btn" data-action="move-event-up" data-day-id="${day.id}" data-event-idx="${idx}"
              title="Monter"${idx === 0 ? ' disabled' : ''}>▲</button>
            <button class="evt-move-btn" data-action="move-event-down" data-day-id="${day.id}" data-event-idx="${idx}"
              title="Descendre"${idx === items.length - 1 ? ' disabled' : ''}>▼</button>
          </div>
          <button class="evt-del" data-action="delete-event" data-day-id="${day.id}" data-event-idx="${idx}" title="Supprimer">✕</button>
        </div>`;
    }).join('');

    // Comments badge (shared trips only) — opens side panel on click
    let commentsHtml = '';
    if (sharedDocData) {
      const count = (sharedDocData.comments?.[day.id] || []).length;
      const isOpen = _commentDayId === day.id;
      commentsHtml = `
        <button class="dc-toggle${isOpen ? ' dc-toggle-active' : ''}"
                data-action="open-comments" data-day-id="${_esc(day.id)}">
          💬${count > 0 ? ` <span class="dc-count">${count}</span>` : ''}
        </button>`;
    }

    const _tripMC = getTrip(_tripId)?.multiCountry;
    const flagRowHtml = _tripMC ? `
        <div style="padding:4px 8px 6px;display:flex;align-items:center;gap:6px;border-top:1px solid var(--c3);margin-top:4px">
          <span style="font-size:11px;color:var(--ink4)">🏳 Pays :</span>
          <input class="day-flag-input" data-day-id="${day.id}" type="text"
            value="${_esc(day.flag || '')}" placeholder="🇫🇷" maxlength="8"
            style="width:56px;font-size:14px;border:1px solid var(--c3);border-radius:4px;padding:1px 4px;background:var(--bg);color:var(--ink)"
            title="Emoji drapeau du pays pour cette étape (utilisé dans MyMap)">
        </div>` : '';

    const nightBadge = (() => {
      if (!trip || !day.date) return '';
      const n = _nightForDate(trip, day.date);
      if (!n) return '';
      // Don't show badge on the day that already contains the sleep item in its list
      if ((day.items || []).some(it => it.id === n.id)) return '';
      const nbg = n.color + '1a'; // 10% opacity background
      return `<div class="night-badge" style="cursor:pointer;color:${n.color};background:${nbg}" data-action="open-sleep-evt" data-sleep-id="${n.id}">🌙 ${_esc(n.name || 'Nuit')}</div>`;
    })();

    eventsHtml = `
      <div class="di-body">
        <div class="evt-list">${evtRows}</div>
        ${nightBadge}
        <div class="add-evt" data-action="add-event" data-day-id="${day.id}">＋ Ajouter</div>
        ${flagRowHtml}
        ${commentsHtml}
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
        ${day.flag && getTrip(_tripId)?.multiCountry ? `<span class="day-flag-chip">${fmtFlag(day.flag)}</span>` : ''}
        ${day.date ? fmtDateShort(day.date) : ''}
        ${day.region ? `<span style="color:var(--ink4)"> · ${_esc(day.region)}</span>` : ''}
        <span id="wx-${day.id}" style="margin-left:4px;font-size:11px;color:var(--ink3)"></span>
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

// ─── Mobile full-screen event sheet ──────────────────────────────────────────

function _showMobileEventSheet(html) {
  document.getElementById('_evt-sheet')?.remove();
  const sheet = document.createElement('div');
  sheet.id = '_evt-sheet';
  sheet.style.cssText = [
    'position:fixed;inset:0;z-index:10000',
    'background:var(--c);color:var(--ink)',
    'overflow-x:hidden;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain',
    'padding:max(44px,env(safe-area-inset-top)) 20px calc(24px + env(safe-area-inset-bottom))',
    'font-family:var(--fn)',
    'transform:translateY(100%);transition:transform .28s cubic-bezier(.25,.8,.25,1)',
  ].join(';');
  sheet.innerHTML = html;
  document.body.appendChild(sheet);
  requestAnimationFrame(() => requestAnimationFrame(() => { sheet.style.transform = 'translateY(0)'; }));
}

function _closeMobileEventSheet() {
  const sheet = document.getElementById('_evt-sheet');
  if (!sheet) return;
  sheet.style.transform = 'translateY(100%)';
  setTimeout(() => sheet.remove(), 300);
}

// ─── Edit Event Modal (mobile — full-screen sheet replacing the desktop EDP) ──

function _openEditEventModal(dayId, evtIdx, tripId) {
  const trip = getTrip(tripId);
  if (!trip) return;
  const day = (trip.days || []).find(d => d.id === dayId);
  if (!day) return;
  const item = day.items?.[evtIdx];
  if (!item) return;

  const evtTypes = getEventTypes();
  let selType      = item.type      || 'visit';
  let selTransport = item.transport || 'car';

  const sorted    = (trip.days || []).filter(d => d.date).sort((a, b) => a.date.localeCompare(b.date));
  const tripStart = sorted[0]?.date || '';
  const tripEnd   = sorted[sorted.length - 1]?.date || '';

  function _typeBtnsHtml() {
    return evtTypes.map(et => {
      const active = et.key === selType;
      return `<button class="tp${active ? ' sel' : ''}" data-ee-type="${_esc(et.key)}"
        style="${active ? `background:${et.color};border-color:${et.color};color:#fff` : ''}">${et.emoji} ${et.label}</button>`;
    }).join('');
  }

  function _modeBtnsHtml() {
    return ['car','train','bus','plane','ferry','foot','bike'].map(m => {
      const active = m === selTransport;
      return `<button class="tp${active ? ' sel' : ''}" data-ee-mode="${m}"
        style="${active ? `background:${trCol(m)};border-color:${trCol(m)};color:#fff` : ''}">${trIc(m)} ${trNm(m)}</button>`;
    }).join('');
  }

  // Day picker — lets mobile users move an event to another day, since HTML5
  // drag-and-drop (used on desktop) doesn't work with touch.
  function _dayOptionsHtml() {
    return (trip.days || []).map(d => {
      const label = `Jour ${d.num}${d.date ? ' · ' + fmtDateShort(d.date) : ''}${customDayTitle(d) ? ' · ' + customDayTitle(d) : ''}`;
      return `<option value="${_esc(d.id)}"${d.id === dayId ? ' selected' : ''}>${_esc(label)}</option>`;
    }).join('');
  }

  _showMobileEventSheet(`
    <h3 style="margin-bottom:16px">✏️ Modifier l'événement</h3>
    ${(trip.days || []).length > 1 ? `
    <div class="fg">
      <label>Jour</label>
      <select id="ee-day">${_dayOptionsHtml()}</select>
    </div>` : ''}
    <div class="fg">
      <label>Type</label>
      <div style="display:flex;gap:6px;flex-wrap:wrap" id="ee-types">${_typeBtnsHtml()}</div>
    </div>
    <div id="ee-transport-row" style="display:${selType === 'drive' ? '' : 'none'}" class="fg">
      <label>Mode de transport</label>
      <div style="display:flex;gap:6px;flex-wrap:wrap" id="ee-modes">${_modeBtnsHtml()}</div>
    </div>
    <div id="ee-sleep-dates" style="display:${selType === 'sleep' ? '' : 'none'}" class="fg">
      <label>Première nuit</label>
      <input type="date" id="ee-sleep-from" value="${_esc(item.dateFrom || day.date || '')}" min="${tripStart}" max="${tripEnd}">
      <label style="display:block;margin-top:8px">Dernière nuit</label>
      <input type="date" id="ee-sleep-to" value="${_esc(item.dateTo || tripEnd || '')}" min="${tripStart}" max="${tripEnd}">
    </div>
    <div class="fg">
      <label>Description</label>
      <input type="text" id="ee-text" value="${_esc(item.text || '')}" placeholder="Description…" autocomplete="off">
    </div>
    <div class="fg">
      <label>Heure</label>
      <input type="time" id="ee-time" value="${_esc(item.time || '')}">
    </div>
    <div class="fg">
      <label>Coût (€)</label>
      <input type="number" id="ee-cost" min="0" step="0.01" value="${_esc(String(item.cost || ''))}" placeholder="0">
    </div>
    <div class="fg">
      <label>Notes</label>
      <textarea id="ee-notes" class="notes-ta" placeholder="Vos notes…" style="min-height:55px">${_esc(item.notes || '')}</textarea>
    </div>
    <div class="ma" style="justify-content:space-between">
      <button class="bc" id="ee-del" style="color:#e85d3e;border-color:#e85d3e">🗑 Supprimer</button>
      <div style="display:flex;gap:8px">
        <button class="bc" id="ee-cancel">Annuler</button>
        <button class="bs" id="ee-save">Enregistrer</button>
      </div>
    </div>
  `);

  const typesContainer = document.getElementById('ee-types');
  const transportRow   = document.getElementById('ee-transport-row');
  const sleepDatesRow  = document.getElementById('ee-sleep-dates');

  typesContainer?.addEventListener('click', e => {
    const pill = e.target.closest('[data-ee-type]');
    if (!pill) return;
    selType = pill.dataset.eeType;
    typesContainer.querySelectorAll('[data-ee-type]').forEach(p => {
      const tKey   = p.dataset.eeType;
      const etInfo = evtTypes.find(t => t.key === tKey);
      const active = tKey === selType;
      p.classList.toggle('sel', active);
      p.style.background  = active ? (etInfo?.color || tCol(tKey)) : '';
      p.style.borderColor = active ? (etInfo?.color || tCol(tKey)) : '';
      p.style.color       = active ? '#fff' : '';
    });
    if (transportRow)  transportRow.style.display  = selType === 'drive' ? '' : 'none';
    if (sleepDatesRow) sleepDatesRow.style.display  = selType === 'sleep' ? '' : 'none';
  });

  document.getElementById('ee-modes')?.addEventListener('click', e => {
    const pill = e.target.closest('[data-ee-mode]');
    if (!pill) return;
    selTransport = pill.dataset.eeMode;
    document.getElementById('ee-modes').querySelectorAll('[data-ee-mode]').forEach(p => {
      const m = p.dataset.eeMode;
      const active = m === selTransport;
      p.classList.toggle('sel', active);
      p.style.background  = active ? trCol(m) : '';
      p.style.borderColor = active ? trCol(m) : '';
      p.style.color       = active ? '#fff'   : '';
    });
  });

  document.getElementById('ee-cancel')?.addEventListener('click', _closeMobileEventSheet);

  document.getElementById('ee-del')?.addEventListener('click', () => {
    _closeMobileEventSheet();
    _deleteEvent(dayId, evtIdx, tripId);
  });

  document.getElementById('ee-save')?.addEventListener('click', () => {
    const text  = (document.getElementById('ee-text')?.value  || '').trim();
    const time  = document.getElementById('ee-time')?.value   || null;
    const cost  = parseFloat(document.getElementById('ee-cost')?.value  || '0') || 0;
    const notes = document.getElementById('ee-notes')?.value  || '';

    const sleepFrom = selType === 'sleep' ? (document.getElementById('ee-sleep-from')?.value || null) : null;
    const sleepTo   = selType === 'sleep' ? (document.getElementById('ee-sleep-to')?.value   || null) : null;
    if (selType === 'sleep') {
      if (!sleepFrom || !sleepTo) { notify('Les dates de début et de fin sont requises', '⚠️'); return; }
      if (sleepFrom > sleepTo)    { notify('La date de fin doit être après la date de début', '⚠️'); return; }
      if (tripStart && sleepFrom < tripStart) { notify('La date de début est avant le voyage', '⚠️'); return; }
      if (tripEnd   && sleepTo   > tripEnd)   { notify('La date de fin est après le voyage',   '⚠️'); return; }
    }

    const freshTrip = getTrip(tripId);
    if (!freshTrip) return;
    const freshDay = (freshTrip.days || []).find(d => d.id === dayId);
    if (!freshDay) return;

    const oldItem  = freshDay.items[evtIdx];
    const newEt    = getEventTypes().find(et => et.key === selType);

    const updatedItems = [...(freshDay.items || [])];
    updatedItems[evtIdx] = {
      ...oldItem,
      type:      selType,
      emoji:     newEt?.emoji || null,
      color:     newEt?.color || null,
      transport: selType === 'drive' ? selTransport : oldItem.transport,
      text,
      time:  time || null,
      cost,
      notes,
      ...(selType === 'sleep' ? { dateFrom: sleepFrom, dateTo: sleepTo } : {}),
    };

    updateTrip(tripId, { days: freshTrip.days.map(d => d.id === dayId ? { ...d, items: updatedItems } : d) });

    if (oldItem.id) {
      const t3 = getTrip(tripId);
      if (t3) {
        const bl = (t3.budgetLines || []).find(l => l.source === 'event' && l.eventId === oldItem.id);
        if (bl) {
          updateTrip(tripId, { budgetLines: (t3.budgetLines || []).map(l =>
            l.id === bl.id ? { ...l, amount: cost, desc: text } : l
          )});
        }
      }
    }

    // Move to another day if the picker selection changed — reuses the same
    // move logic as the desktop drag-and-drop, which doesn't work on touch.
    const newDayId = document.getElementById('ee-day')?.value;

    _closeMobileEventSheet();

    if (newDayId && newDayId !== dayId) {
      _moveEvent(dayId, evtIdx, newDayId, tripId);
    } else {
      notify('Événement mis à jour', '✅');
      _renderDaysList(tripId);
      _refreshMapPins(tripId);
      updateTopStats(tripId);
    }
  });
}

// ─── Event detail panel (EDP) ─────────────────────────────────────────────────

function _openEDP(dayId, evtIdx, tripId) {
  // Toggle: clicking the same active event closes the panel
  if (_activeEvtKey && _activeEvtKey.dayId === dayId && _activeEvtKey.idx === evtIdx) {
    _closeEDP();
    _activeEvtKey = null;
    _renderDaysList(tripId);
    return;
  }

  _activeEvtKey = { dayId, idx: evtIdx };

  // On mobile, the EDP is a desktop-only side panel — always use the full-screen sheet
  if (window.innerWidth <= 768) {
    _activeEvtKey = null;
    _renderDaysList(tripId);
    _openEditEventModal(dayId, evtIdx, tripId);
    return;
  }

  _renderDaysList(tripId);

  const trip = getTrip(tripId);
  if (!trip) return;

  const day = (trip.days || []).find(d => d.id === dayId);
  if (!day) return;

  const item = day.items[evtIdx];
  if (!item) return;

  const _edpSorted = (trip.days || []).filter(d => d.date).sort((a, b) => a.date.localeCompare(b.date));
  const _edpStart  = _edpSorted[0]?.date || '';
  const _edpEnd    = _edpSorted[_edpSorted.length - 1]?.date || '';

  // Synchronously remove any existing EDP — prevents stacking when clicking fast
  document.getElementById('edp')?.remove();

  const mapCol = document.querySelector('.map-col');
  if (!mapCol) return;

  let edpType      = item.type      || 'visit';
  let edpTransport = item.transport || 'car';

  const inputStyle = 'width:100%;padding:5px 8px;border:1.5px solid var(--c3);border-radius:6px;font-size:12px;background:var(--bg);color:var(--ink);box-sizing:border-box';

  // GPX stats block — shown only when this event is linked to a GPX track
  let gpxSectionHtml = '';
  let _gpxElevSeries = [], _gpxSpeedSeries = [], _gpxTimeSeries = [];
  if (item.gpxTrackId) {
    const st    = item.gpxStats || {};
    const distM = st.distanceM || 0;
    const dist  = distM >= 1000 ? (distM / 1000).toFixed(1) + ' km' : distM + ' m';
    const gain  = st.elevGain ? '+' + st.elevGain + ' m' : '—';
    const loss  = st.elevLoss ? '−' + st.elevLoss + ' m' : '—';
    let durLabel = '';
    if (st.durationSecs) {
      const h = Math.floor(st.durationSecs / 3600);
      const m = Math.round((st.durationSecs % 3600) / 60);
      durLabel = h > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${m} min`;
    }

    // Build chart series from localStorage track points
    const _gpxTrack = getLocalGpxTracks(tripId).find(t => t.id === item.gpxTrackId);
    if (_gpxTrack?.points?.length >= 2) {
      let cumDist = 0;
      const pts = _gpxTrack.points;
      const t0 = pts[0].time ? new Date(pts[0].time).getTime() : null;
      for (let i = 0; i < pts.length; i++) {
        if (i > 0) {
          const seg = _haversineMeters(pts[i - 1], pts[i]);
          cumDist += seg;
          if (pts[i - 1].time && pts[i].time) {
            const dt = (new Date(pts[i].time).getTime() - new Date(pts[i - 1].time).getTime()) / 1000;
            if (dt > 0) _gpxSpeedSeries.push({ d: cumDist - seg / 2, v: (seg / dt) * 3.6 });
          }
        }
        if (pts[i].ele != null) _gpxElevSeries.push({ d: cumDist, v: pts[i].ele });
        if (t0 && pts[i].time) _gpxTimeSeries.push({ d: cumDist, t: (new Date(pts[i].time).getTime() - t0) / 1000 });
      }
    }
    const hasChart = _gpxElevSeries.length >= 2 || _gpxSpeedSeries.length >= 2;

    const statCell = (val, lbl, color = 'var(--ink)') =>
      `<div><div style="font-size:13px;font-weight:700;color:${color}">${val}</div><div style="font-size:10px;color:var(--ink4)">${lbl}</div></div>`;

    gpxSectionHtml = `
      <div class="edp-sect">
        <div class="edp-sect-lbl">Trace GPS</div>
        <div style="background:var(--c2);border-radius:8px;padding:10px 12px;border:1px solid var(--c3)">
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px 4px;text-align:center;margin-bottom:8px">
            ${statCell(dist, 'Distance')}
            ${statCell(gain, 'D+', '#16a34a')}
            ${statCell(loss, 'D−', '#e85d3e')}
            ${durLabel ? statCell(durLabel, 'Durée') : ''}
            ${st.altMin != null ? statCell(st.altMin + '–' + st.altMax + ' m', 'Altitude') : ''}
            ${st.speedAvgKph != null ? statCell(st.speedAvgKph + ' km/h', 'Vit. moy.') : ''}
            ${st.speedMaxKph != null ? statCell(st.speedMaxKph + ' km/h', 'Vit. max') : ''}
          </div>
          ${hasChart ? `
          <div style="display:flex;gap:4px;margin-bottom:6px">
            <button id="edp-chart-elev" style="flex:1;font-size:10px;font-weight:700;padding:3px 0;border-radius:5px;cursor:pointer;border:1.5px solid var(--teal);background:var(--tl);color:var(--td)">⛰ Altitude</button>
            <button id="edp-chart-speed" style="flex:1;font-size:10px;font-weight:700;padding:3px 0;border-radius:5px;cursor:pointer;border:1.5px solid var(--c3);background:var(--c2);color:var(--ink3)">⚡ Vitesse</button>
          </div>
          <div id="edp-chart-wrap" style="position:relative;width:100%;touch-action:none;cursor:crosshair">
            <canvas id="edp-gpx-canvas" style="width:100%;height:130px;display:block;border-radius:6px"></canvas>
            <div id="edp-chart-cursor" style="display:none;position:absolute;top:0;bottom:18px;width:1px;background:rgba(0,0,0,.45);pointer-events:none">
              <div id="edp-chart-tip" style="position:absolute;top:4px;left:5px;background:rgba(15,15,15,.82);color:#fff;padding:3px 7px;border-radius:5px;font-size:10px;line-height:1.5;white-space:pre;pointer-events:none"></div>
            </div>
          </div>` : ''}
          <button id="edp-gpx-del" style="margin-top:8px;width:100%;background:none;border:1.5px solid #e85d3e;color:#e85d3e;border-radius:6px;padding:5px;font-size:11px;font-weight:700;cursor:pointer;font-family:var(--fn)">🗑 Supprimer la trace GPX</button>
        </div>
      </div>`;
  }

  function _typeButtons() {
    const evtTypesEdp = getEventTypes();
    return evtTypesEdp.map(et => {
      const active = et.key === edpType;
      return `<button type="button" class="tp${active ? ' sel' : ''}" data-edp-type="${_esc(et.key)}"
        style="font-size:11px;padding:3px 8px;${active ? `background:${et.color};border-color:${et.color};color:#fff` : ''}">${et.emoji} ${et.label}</button>`;
    }).join('');
  }

  function _modeButtons() {
    return ['car','train','bus','plane','ferry','foot','bike'].map(m => {
      const active = m === edpTransport;
      return `<button type="button" class="tp${active ? ' sel' : ''}" data-edp-mode="${m}"
        style="font-size:11px;padding:3px 8px;${active ? `background:${trCol(m)};border-color:${trCol(m)};color:#fff` : ''}">${trIc(m)} ${trNm(m)}</button>`;
    }).join('');
  }

  const edp = document.createElement('div');
  edp.className = 'edp';
  edp.id        = 'edp';
  edp.innerHTML = `
    <div class="edp-hd">
      <div class="edp-ic" id="edp-ic">${item.type === 'drive' ? trIc(item.transport || 'car') : tIc(item.type, item)}</div>
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
      <div class="edp-sect" id="edp-sleep-dates" style="display:${edpType === 'sleep' ? '' : 'none'}">
        <div class="edp-sect-lbl">Nuits passées ici</div>
        <div style="display:flex;gap:10px">
          <div style="flex:1">
            <div style="font-size:11px;color:var(--ink3);margin-bottom:3px">Première nuit</div>
            <input type="date" id="edp-sleep-from" value="${_esc(item.dateFrom || day.date || '')}" min="${_edpStart}" max="${_edpEnd}" style="${inputStyle}">
          </div>
          <div style="flex:1">
            <div style="font-size:11px;color:var(--ink3);margin-bottom:3px">Dernière nuit</div>
            <input type="date" id="edp-sleep-to" value="${_esc(item.dateTo || _edpEnd || '')}" min="${_edpStart}" max="${_edpEnd}" style="${inputStyle}">
          </div>
        </div>
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
      ${gpxSectionHtml}
    </div>
    <div class="edp-actions">
      <button class="edp-del" id="edp-del">🗑 Supprimer</button>
      <button class="edp-save" id="edp-save">Enregistrer</button>
    </div>
  `;

  mapCol.appendChild(edp);

  // Animate in
  requestAnimationFrame(() => { edp.classList.add('open'); });

  // GPX chart + delete
  if (item.gpxTrackId) {
    // Chart
    const canvas = edp.querySelector('#edp-gpx-canvas');
    if (canvas && (_gpxElevSeries.length >= 2 || _gpxSpeedSeries.length >= 2)) {
      let _chartMode = _gpxElevSeries.length >= 2 ? 'elevation' : 'speed';

      const _drawChart = (mode) => {
        const series = mode === 'elevation' ? _gpxElevSeries : _gpxSpeedSeries;
        const W = canvas.offsetWidth || 260;
        const H = 130;
        canvas.width  = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, W, H);
        if (series.length < 2) return;

        const xs = series.map(p => p.d);
        const ys = series.map(p => p.v);
        const xMin = xs[0], xMax = xs[xs.length - 1];
        const yMin = Math.min(...ys), yMax = Math.max(...ys);
        const yRange = yMax - yMin || 1;
        const pad = { t: 6, b: 18, l: 4, r: 4 };
        const toX = d => pad.l + (d - xMin) / (xMax - xMin) * (W - pad.l - pad.r);
        const toY = v => H - pad.b - (v - yMin) / yRange * (H - pad.t - pad.b);

        const color = mode === 'elevation' ? '#0891b2' : '#d97706';
        ctx.beginPath();
        ctx.moveTo(toX(xs[0]), toY(ys[0]));
        for (let i = 1; i < series.length; i++) ctx.lineTo(toX(xs[i]), toY(ys[i]));
        ctx.lineTo(toX(xs[xs.length - 1]), H - pad.b);
        ctx.lineTo(toX(xs[0]), H - pad.b);
        ctx.closePath();
        ctx.fillStyle = mode === 'elevation' ? 'rgba(8,145,178,.15)' : 'rgba(217,119,6,.15)';
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(toX(xs[0]), toY(ys[0]));
        for (let i = 1; i < series.length; i++) ctx.lineTo(toX(xs[i]), toY(ys[i]));
        ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();

        // Y axis labels
        ctx.fillStyle = 'rgba(100,100,100,.85)'; ctx.font = '9px sans-serif'; ctx.textAlign = 'left';
        const unit = mode === 'elevation' ? 'm' : 'km/h';
        ctx.fillText(Math.round(yMax) + unit, pad.l + 2, pad.t + 9);
        ctx.fillText(Math.round(yMin) + unit, pad.l + 2, H - pad.b - 2);
        // X axis labels
        ctx.textAlign = 'center';
        const distKm = xMax >= 1000;
        ctx.fillText('0', toX(xMin), H - 4);
        ctx.fillText(distKm ? (xMax / 1000).toFixed(1) + ' km' : Math.round(xMax) + ' m', toX(xMax), H - 4);
      };

      const _setMode = (mode) => {
        _chartMode = mode;
        _drawChart(mode);
        const elevBtn  = edp.querySelector('#edp-chart-elev');
        const speedBtn = edp.querySelector('#edp-chart-speed');
        if (elevBtn)  { elevBtn.style.background  = mode === 'elevation' ? 'var(--tl)' : 'var(--c2)';  elevBtn.style.borderColor  = mode === 'elevation' ? 'var(--teal)' : 'var(--c3)';  elevBtn.style.color  = mode === 'elevation' ? 'var(--td)' : 'var(--ink3)'; }
        if (speedBtn) { speedBtn.style.background = mode === 'speed'     ? 'var(--tl)' : 'var(--c2)';  speedBtn.style.borderColor = mode === 'speed'     ? 'var(--teal)' : 'var(--c3)';  speedBtn.style.color = mode === 'speed'     ? 'var(--td)' : 'var(--ink3)'; }
      };

      requestAnimationFrame(() => { _drawChart(_chartMode); });
      edp.querySelector('#edp-chart-elev')?.addEventListener('click',  () => _setMode('elevation'));
      edp.querySelector('#edp-chart-speed')?.addEventListener('click', () => _setMode('speed'));

      // Disable unavailable modes
      if (_gpxElevSeries.length  < 2) edp.querySelector('#edp-chart-elev')?.setAttribute('disabled', '');
      if (_gpxSpeedSeries.length < 2) edp.querySelector('#edp-chart-speed')?.setAttribute('disabled', '');

      // Scrubber — vertical cursor line + tooltip on hover/touch
      const wrap    = edp.querySelector('#edp-chart-wrap');
      const cursor  = edp.querySelector('#edp-chart-cursor');
      const tip     = edp.querySelector('#edp-chart-tip');
      if (wrap && cursor && tip) {
        const _nearest = (series, targetD) => {
          let lo = 0, hi = series.length - 1;
          while (lo < hi - 1) {
            const mid = (lo + hi) >> 1;
            if (series[mid].d < targetD) lo = mid; else hi = mid;
          }
          return Math.abs(series[lo].d - targetD) <= Math.abs(series[hi].d - targetD) ? series[lo] : series[hi];
        };

        const _showAt = (clientX) => {
          const rect = canvas.getBoundingClientRect();
          const xPct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
          const series = _chartMode === 'elevation' ? _gpxElevSeries : _gpxSpeedSeries;
          if (series.length < 2) return;

          const xMin = series[0].d, xMax = series[series.length - 1].d;
          const targetD = xMin + xPct * (xMax - xMin);
          const pt = _nearest(series, targetD);

          cursor.style.display = 'block';
          cursor.style.left    = (xPct * 100) + '%';

          const distStr = pt.d >= 1000 ? (pt.d / 1000).toFixed(2) + ' km' : Math.round(pt.d) + ' m';
          const valStr  = _chartMode === 'elevation'
            ? Math.round(pt.v) + ' m alt.'
            : pt.v.toFixed(1) + ' km/h';

          let lines = [distStr, valStr];
          if (_gpxTimeSeries.length >= 2) {
            const tPt = _nearest(_gpxTimeSeries, pt.d);
            const h = Math.floor(tPt.t / 3600);
            const m = Math.floor((tPt.t % 3600) / 60);
            const s = Math.floor(tPt.t % 60);
            lines.push(h > 0 ? `${h}h${String(m).padStart(2,'0')}` : `${m}m${String(s).padStart(2,'0')}s`);
          }
          tip.textContent = lines.join('\n');

          // Flip tooltip to left side when near right edge
          if (xPct > 0.65) {
            tip.style.left = 'auto'; tip.style.right = '5px';
          } else {
            tip.style.left = '5px'; tip.style.right = 'auto';
          }
        };

        wrap.addEventListener('mousemove',  e => _showAt(e.clientX));
        wrap.addEventListener('mouseleave', () => { cursor.style.display = 'none'; });
        wrap.addEventListener('touchmove',  e => { e.preventDefault(); _showAt(e.touches[0].clientX); }, { passive: false });
        wrap.addEventListener('touchend',   () => { cursor.style.display = 'none'; });
      }
    }

    edp.querySelector('#edp-gpx-del')?.addEventListener('click', () => {
      if (!confirm(`Supprimer la trace GPX et cet événement ?`)) return;
      removeLocalGpxTrack(tripId, item.gpxTrackId);
      _deleteEvent(dayId, evtIdx, tripId);
      _drawGpxOverlays(tripId);
    });
  }

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
    const curEvtTypes = getEventTypes();
    edp.querySelectorAll('[data-edp-type]').forEach(p => {
      const tKey   = p.dataset.edpType;
      const etInfo = curEvtTypes.find(t => t.key === tKey);
      const active = tKey === edpType;
      p.classList.toggle('sel', active);
      p.style.background  = active ? (etInfo?.color || tCol(tKey)) : '';
      p.style.borderColor = active ? (etInfo?.color || tCol(tKey)) : '';
      p.style.color       = active ? '#fff' : '';
    });
    const modeSect = edp.querySelector('#edp-mode-sect');
    if (modeSect) modeSect.style.display = edpType === 'drive' ? '' : 'none';
    const sleepSect = edp.querySelector('#edp-sleep-dates');
    if (sleepSect) sleepSect.style.display = edpType === 'sleep' ? '' : 'none';
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

    const oldItem  = d2.items[evtIdx];
    const newEt    = getEventTypes().find(et => et.key === edpType);

    const sleepFrom = edpType === 'sleep' ? (document.getElementById('edp-sleep-from')?.value || null) : null;
    const sleepTo   = edpType === 'sleep' ? (document.getElementById('edp-sleep-to')?.value   || null) : null;
    if (edpType === 'sleep') {
      if (!sleepFrom || !sleepTo) { notify('Les dates de début et de fin sont requises', '⚠️'); return; }
      if (sleepFrom > sleepTo) { notify('La date de fin doit être après la date de début', '⚠️'); return; }
      if (_edpStart && sleepFrom < _edpStart) { notify('La date de début est avant le voyage', '⚠️'); return; }
      if (_edpEnd   && sleepTo   > _edpEnd)   { notify('La date de fin est après le voyage',   '⚠️'); return; }
    }

    d2.items[evtIdx] = {
      ...oldItem,
      type:      edpType,
      emoji:     newEt?.emoji || null,
      color:     newEt?.color || null,
      transport: edpType === 'drive' ? edpTransport : oldItem.transport,
      text,
      time:  time || null,
      cost,
      notes,
      ...(edpType === 'sleep' ? { dateFrom: sleepFrom, dateTo: sleepTo } : {}),
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
  if (_openDayIds.has(dayId)) {
    _openDayIds.delete(dayId);
    _activeEvtKey = null;
    _closeEDP();
    _renderDaysList(tripId);
    _renderMiniCal(tripId);
    return;
  }

  _openDayIds.add(dayId);
  _activeEvtKey = null;
  _closeEDP();

  _renderDaysList(tripId);
  _renderMiniCal(tripId);

  // Scroll day into view
  const dayEl = document.querySelector(`[data-day-id="${dayId}"][data-action="select-day"]`);
  if (dayEl) dayEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // Fly map to day coords (derived from first event or day fallback)
  const trip = getTrip(tripId);
  if (trip) {
    const day = (trip.days || []).find(d => d.id === dayId);
    const pos = day ? _getDayMarkerPos(day) : null;
    if (pos && _map) {
      _map.flyTo([pos.lat, pos.lng], Math.max(_map.getZoom(), 10), { duration: 1 });
      const marker = _markers[dayId];
      if (marker) setTimeout(() => marker.openPopup(), 800);
    }
  }
}

// ─── Comment panel ────────────────────────────────────────────────────────────

function _openCommentPanel(tripId, dayId) {
  _commentDayId = dayId;
  const trip = getTrip(tripId);
  const day  = (trip?.days || []).find(d => d.id === dayId);
  const labelEl = document.getElementById('cmp-day-label');
  if (labelEl) labelEl.textContent = day?.title ? `💬 ${day.title}` : `💬 Jour ${day?.num ?? ''}`;
  _renderCommentList(tripId, dayId);
  document.getElementById('comment-panel')?.classList.add('open');
}

function _renderCommentList(tripId, dayId) {
  const bodyEl = document.getElementById('cmp-body');
  if (!bodyEl) return;

  const sharedDocData = getSharedDocData(tripId);
  if (!sharedDocData) {
    bodyEl.innerHTML = '<div class="cmp-empty">Partagez ce voyage pour utiliser les commentaires.</div>';
    return;
  }

  const currentUser = getCurrentUser();
  const isOwner = currentUser && (
    sharedDocData.ownerId === currentUser.uid ||
    sharedDocData.members?.[currentUser.uid]?.role === 'owner'
  );

  const comments = (sharedDocData.comments?.[dayId] || [])
    .slice()
    .sort((a, b) => new Date(a.ts) - new Date(b.ts));

  if (comments.length === 0) {
    bodyEl.innerHTML = '<div class="cmp-empty">Aucun commentaire.<br>Soyez le premier&nbsp;!</div>';
  } else {
    bodyEl.innerHTML = comments.map(c => {
      const isMine   = currentUser && c.uid === currentUser.uid;
      const canDel   = currentUser && (c.uid === currentUser.uid || isOwner);
      const delBtn   = canDel ? `<button class="cmp-del" data-cmp-del data-day-id="${_esc(dayId)}" data-comment-id="${_esc(c.id)}" title="Supprimer">×</button>` : '';
      return `
        <div class="cmp-msg${isMine ? ' cmp-mine' : ''}">
          <div class="cmp-meta">
            ${!isMine ? `<span class="cmp-author">${_esc(c.author)}</span>` : ''}
            <span class="cmp-ts">${_relativeTime(c.ts)}</span>
            ${delBtn}
          </div>
          <div class="cmp-bubble">${_esc(c.text)}</div>
        </div>`;
    }).join('');
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }
}

window._closeCommentPanel = function() {
  document.getElementById('comment-panel')?.classList.remove('open');
  _commentDayId = null;
};

// ─── Event delegation for left panel ─────────────────────────────────────────

// #panel-mapcal is a persistent DOM node re-used across tab switches (only its
// innerHTML is replaced by renderMapCal) — event delegation means it never
// needs re-binding for new content, so guard against calling this more than
// once per panel. Without this, revisiting the "Carte & Planning" tab kept
// stacking a fresh set of click/drag listeners on top of the old ones, so a
// single tap could fire _selectDay() (and every other delegated action) an
// even number of times and net out to nothing — "sometimes a day just won't open".
const _leftPanelBound = new WeakSet();

function _attachLeftPanelListeners(panel) {
  if (_leftPanelBound.has(panel)) return;
  _leftPanelBound.add(panel);

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
      // Don't trigger select when clicking inputs or interactive elements inside the body
      if (e.target.closest('.day-flag-input, .dc-toggle, .add-evt')) return;
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

    } else if (action === 'move-event-up' || action === 'move-event-down') {
      // Reorder within the day — the alternative to drag-and-drop on touch devices.
      e.stopPropagation();
      const dayId = target.dataset.dayId;
      const idx   = parseInt(target.dataset.eventIdx, 10);
      if (dayId && !isNaN(idx)) {
        _reorderEvent(dayId, idx, idx + (action === 'move-event-up' ? -1 : 1), _tripId);
      }

    } else if (action === 'open-sleep-evt') {
      e.stopPropagation();
      const sleepId = target.dataset.sleepId;
      if (!sleepId) return;
      const t = getTrip(_tripId);
      if (!t) return;
      for (const d of (t.days || [])) {
        const idx = (d.items || []).findIndex(it => it.id === sleepId);
        if (idx >= 0) {
          _openDayIds.add(d.id);
          _openEDP(d.id, idx, _tripId);
          return;
        }
      }

    } else if (action === 'open-comments') {
      e.stopPropagation();
      const dayId = target.dataset.dayId;
      if (!dayId) return;
      if (_commentDayId === dayId) {
        window._closeCommentPanel();
      } else {
        _openCommentPanel(_tripId, dayId);
        _renderDaysList(_tripId); // refresh badge active state
      }

    } else if (action === 'pick-transport') {
      e.stopPropagation();
      const segIdx    = parseInt(target.dataset.seg, 10);
      const mode      = target.dataset.mode;
      const freshTrip = getTrip(_tripId);
      if (!freshTrip) return;
      const allWps = _collectAllWaypoints(freshTrip);
      if (segIdx + 1 >= allWps.length) return;
      const toWp2 = allWps[segIdx + 1];
      const days  = (freshTrip.days || []).map(d => ({ ...d, items: [...(d.items || [])] }));
      if (toWp2.itemId) {
        const day   = days.find(d => d.id === toWp2.dayId);
        const itIdx = (day?.items || []).findIndex(it => it.id === toWp2.itemId);
        if (itIdx >= 0) {
          // _collectAllWaypoints reads item.transport (not routeMode) as the mode
          // for 'drive' items — write to whichever field is actually authoritative
          // for this item, or the picked mode gets silently overridden on redraw.
          const field = day.items[itIdx].type === 'drive' ? 'transport' : 'routeMode';
          day.items[itIdx] = { ...day.items[itIdx], [field]: mode };
        }
      } else {
        const dayIdx = days.findIndex(d => d.id === toWp2.dayId);
        if (dayIdx >= 0) {
          // Night pins aren't a real item — same field-mismatch issue as above:
          // depart-from-night and return-to-night are two distinct edges on the
          // same day and each needs its own field, or one silently overwrites
          // the read for the other (both used to be hardcoded to 'car').
          const field = toWp2.isDepartNight ? 'departNightMode'
                      : toWp2.isReturnNight ? 'returnNightMode'
                      : 'routeMode';
          days[dayIdx] = { ...days[dayIdx], [field]: mode };
        }
      }
      updateTrip(_tripId, { days });
      const updated = getTrip(_tripId);
      if (updated) {
        _renderTransportContent(updated, _tripId);
        _populateTransportDurations(updated);
      }
      _routeLayers.forEach(l => { try { _map?.removeLayer(l); } catch (_) {} });
      _routeLayers = [];
      _drawRouteGen++;
      if (updated) _drawRoutes(updated, [], _drawRouteGen);

    }
  });

  // Enter key in comment inputs

  // ── Drag-and-drop: move events between days ──────────────────────────────
  let _dropTarget = null;

  panel.addEventListener('dragstart', e => {
    const el = e.target instanceof Element ? e.target : null;
    const row = el?.closest('.evt-row');
    if (!row) return;
    _dragEvt = { dayId: row.dataset.dayId, idx: parseInt(row.dataset.eventIdx, 10) };
    e.dataTransfer.effectAllowed = 'move';
    setTimeout(() => { row.style.opacity = '0.4'; }, 0);
  });

  panel.addEventListener('dragend', e => {
    const el = e.target instanceof Element ? e.target : null;
    const row = el?.closest('.evt-row');
    if (row) row.style.opacity = '';
    if (_dropTarget) { _dropTarget.classList.remove('drop-target'); _dropTarget = null; }
    _dragEvt = null;
  });

  panel.addEventListener('dragover', e => {
    if (!_dragEvt) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const el = e.target instanceof Element ? e.target : null;

    // Same-day reorder: highlight the specific evt-row being hovered
    const evtRow = el?.closest('.evt-row');
    if (evtRow && evtRow.dataset.dayId === _dragEvt.dayId) {
      if (_dropTarget !== evtRow) {
        if (_dropTarget) _dropTarget.classList.remove('drop-target');
        _dropTarget = evtRow;
        evtRow.classList.add('drop-target');
      }
      return;
    }

    const dayItem = el?.closest('.day-item');
    if (!dayItem) return;
    if (_dropTarget !== dayItem) {
      if (_dropTarget) _dropTarget.classList.remove('drop-target');
      _dropTarget = dayItem;
      dayItem.classList.add('drop-target');
    }
  });

  panel.addEventListener('dragleave', e => {
    if (!e.currentTarget.contains(e.relatedTarget)) {
      if (_dropTarget) { _dropTarget.classList.remove('drop-target'); _dropTarget = null; }
    }
  });

  panel.addEventListener('drop', e => {
    e.preventDefault();
    if (_dropTarget) { _dropTarget.classList.remove('drop-target'); _dropTarget = null; }
    if (!_dragEvt) return;
    const el = e.target instanceof Element ? e.target : null;

    // Same-day reorder: drop on a specific evt-row within the same day
    const evtRow = el?.closest('.evt-row');
    if (evtRow && evtRow.dataset.dayId === _dragEvt.dayId) {
      const targetIdx = parseInt(evtRow.dataset.eventIdx, 10);
      if (!isNaN(targetIdx)) _reorderEvent(_dragEvt.dayId, _dragEvt.idx, targetIdx, _tripId);
      _dragEvt = null;
      return;
    }

    const dayItem = el?.closest('.day-item');
    if (!dayItem) return;
    const targetDayId = dayItem.dataset.dayId;
    _moveEvent(_dragEvt.dayId, _dragEvt.idx, targetDayId, _tripId);
    _dragEvt = null;
  });

  // Inline day flag editor
  panel.addEventListener('change', e => {
    if (!e.target.classList.contains('day-flag-input')) return;
    const dayId = e.target.dataset.dayId;
    const trip  = getTrip(_tripId);
    if (!trip) return;
    const day = (trip.days || []).find(d => d.id === dayId);
    if (!day) return;
    day.flag = e.target.value.trim() || null;
    updateTrip(_tripId, { days: trip.days });
    // Refresh subtitle (flag display) without full re-render
    const diS = document.querySelector(`[data-day-id="${dayId}"][data-action="select-day"] .di-s`);
    if (diS) {
      const flagSpan = diS.querySelector('.day-flag-chip');
      if (flagSpan) flagSpan.textContent = day.flag ? fmtFlag(day.flag) : '';
    }
    _refreshMapPins(_tripId);
  });
}

// ─── Move event between days ──────────────────────────────────────────────────

function _moveEvent(sourceDayId, evtIdx, targetDayId, tripId) {
  if (!sourceDayId || !targetDayId || sourceDayId === targetDayId) return;
  const trip = getTrip(tripId);
  if (!trip) return;

  const days      = trip.days || [];
  const srcDay    = days.find(d => d.id === sourceDayId);
  const tgtDay    = days.find(d => d.id === targetDayId);
  if (!srcDay || !tgtDay) return;

  const srcItems = [...(srcDay.items || [])];
  if (evtIdx < 0 || evtIdx >= srcItems.length) return;
  const [moved] = srcItems.splice(evtIdx, 1);
  srcDay.items = srcItems;

  // If the event's coords were the source day's representative pin (no other items
  // with coords remain and they match the day's fallback), clear them so the target
  // day doesn't inherit the wrong location.
  const stillHaveCoords = srcItems.some(it => it.lat != null && it.lng != null);
  const movedEvent = (
    !stillHaveCoords &&
    moved.lat != null &&
    moved.lat === srcDay.lat &&
    moved.lng === srcDay.lng
  ) ? { ...moved, lat: null, lng: null } : moved;

  tgtDay.items = [...(tgtDay.items || []), movedEvent];

  updateTrip(tripId, { days });
  _activeEvtKey = null;
  _closeEDP();
  _renderDaysList(tripId);
  _renderMiniCal(tripId);
  _refreshMapPins(tripId);
  notify('Événement déplacé', '✅');
}

// ─── Reorder event within same day ───────────────────────────────────────────

function _reorderEvent(dayId, fromIdx, toIdx, tripId) {
  if (fromIdx === toIdx) return;
  const trip = getTrip(tripId);
  if (!trip) return;
  const day = (trip.days || []).find(d => d.id === dayId);
  if (!day) return;

  const items = [...(day.items || [])];
  if (fromIdx < 0 || fromIdx >= items.length || toIdx < 0 || toIdx >= items.length) return;

  const [moved] = items.splice(fromIdx, 1);
  items.splice(toIdx, 0, moved);
  day.items = items;

  updateTrip(tripId, { days: trip.days });
  _activeEvtKey = null;
  _closeEDP();
  _renderDaysList(tripId);
  _refreshMapPins(tripId);
  notify('Événement réorganisé', '✅');
}

// ─── Delete event ─────────────────────────────────────────────────────────────

function _deleteEvent(dayId, evtIdx, tripId) {
  const trip = getTrip(tripId);
  if (!trip) return;

  // Deep-copy days so we never mutate the live store reference before the write
  const days = (trip.days || []).map(d =>
    d.id === dayId ? { ...d, items: [...(d.items || [])] } : d
  );
  const day = days.find(d => d.id === dayId);
  if (!day) return;

  day.items.splice(evtIdx, 1);

  // Re-derive day pin from remaining items to avoid ghost markers
  const firstPin = day.items.find(it => it.lat != null && it.lng != null);
  if (firstPin) {
    day.lat = firstPin.lat;
    day.lng = firstPin.lng;
  } else if (!day.items.some(it => it.lat != null)) {
    day.lat = null;
    day.lng = null;
  }

  updateTrip(tripId, { days });
  _activeEvtKey = null;
  _closeEDP();
  _renderDaysList(tripId);
  _refreshMapPins(tripId);
  updateTopStats(tripId);
  notify('Événement supprimé', '🗑');
}

// ─── Geocoding helper — Photon with Nominatim fallback ───────────────────────

async function _geocode(q) {
  const lang = getLanguage();
  // 1st try: Photon (fast fuzzy matching)
  try {
    const resp = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lang=${lang}`);
    const gj   = await resp.json();
    const data  = (gj.features || []).map(f => {
      const [lng, lat] = f.geometry.coordinates;
      const p = f.properties;
      const parts = [p.name, p.street, p.city, p.state, p.country].filter(Boolean);
      return { lat: String(lat), lon: String(lng), display_name: parts.join(', ') };
    });
    if (data.length > 0) return data;
  } catch (_) {}
  // 2nd try: Nominatim (broader coverage, handles alt names / historical names)
  try {
    const resp = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=6&q=${encodeURIComponent(q)}`,
      { headers: { 'Accept-Language': lang } }
    );
    const d = await resp.json();
    return d.map(r => ({ lat: r.lat, lon: r.lon, display_name: r.display_name }));
  } catch (_) {}
  return [];
}

// ─── Map search bar ───────────────────────────────────────────────────────────

function _initMapSearch(tripId) {
  const input   = document.getElementById('ms-input');
  const btn     = document.getElementById('ms-btn');
  const results = document.getElementById('ms-results');
  const action  = document.getElementById('ms-action');
  const aLabel  = document.getElementById('ms-action-label');
  const aAdd    = document.getElementById('ms-action-add');
  const aClose  = document.getElementById('ms-action-close');
  if (!input || !btn || !results) return;

  // Remove stale temp pin on re-init
  if (_tempSearchPin && _map) {
    try { _map.removeLayer(_tempSearchPin); } catch (_) {}
    _tempSearchPin = null;
  }

  function _setActionBar(lat, lng, label) {
    if (!action || !aLabel) return;
    aLabel.textContent = label.split(',').slice(0, 2).join(',').trim();
    action.style.display = 'flex';

    aAdd.onclick = () => {
      action.style.display = 'none';
      if (_tempSearchPin && _map) { try { _map.removeLayer(_tempSearchPin); } catch (_) {} _tempSearchPin = null; }
      const trip     = getTrip(tripId);
      const targetId = [..._openDayIds][0] || (trip?.days || [])[0]?.id;
      if (!targetId) { notify('Aucun jour disponible — créez un jour d\'abord', '⚠️'); return; }
      _openAddEventModal(targetId, tripId, { lat, lng, label: label.split(',')[0].trim() });
    };

    aClose.onclick = () => {
      action.style.display = 'none';
      if (_tempSearchPin && _map) { try { _map.removeLayer(_tempSearchPin); } catch (_) {} _tempSearchPin = null; }
    };
  }

  function _placePin(lat, lng, label) {
    if (!_map) return;
    if (_tempSearchPin) { try { _map.removeLayer(_tempSearchPin); } catch (_) {} }
    const icon = L.divIcon({
      className: '',
      html: `<div style="background:#fff;border:3px solid #0d9488;border-radius:50%;width:30px;height:30px;display:flex;align-items:center;justify-content:center;font-size:16px;box-shadow:0 2px 8px rgba(0,0,0,.3)">📍</div>`,
      iconSize: [30, 30], iconAnchor: [15, 15],
    });
    _tempSearchPin = L.marker([lat, lng], { icon, zIndexOffset: 2000 }).addTo(_map);
    _map.flyTo([lat, lng], Math.max(_map.getZoom(), 13), { duration: 0.8 });
    _setActionBar(lat, lng, label);
  }

  function _showResults(data) {
    if (!data.length) {
      results.innerHTML = '<div style="padding:8px 12px;font-size:12px;color:#888">Aucun résultat</div>';
    } else {
      results.innerHTML = data.map(r =>
        `<div class="ms-result" data-lat="${r.lat}" data-lng="${r.lon}"
             data-label="${_esc(r.display_name)}"
             style="padding:8px 12px;font-size:12px;cursor:pointer;border-bottom:1px solid #f0f0f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
           📍 ${_esc(r.display_name)}
         </div>`
      ).join('');
      results.querySelectorAll('.ms-result').forEach(el => {
        el.addEventListener('mouseenter', () => { el.style.background = '#f0fafa'; });
        el.addEventListener('mouseleave', () => { el.style.background = ''; });
        el.addEventListener('click', () => {
          const lat   = parseFloat(el.dataset.lat);
          const lng   = parseFloat(el.dataset.lng);
          const label = el.dataset.label;
          input.value = label.split(',')[0].trim();
          results.style.display = 'none';
          _placePin(lat, lng, label);
        });
      });
    }
    results.style.display = 'block';
  }

  async function _doSearch() {
    const q = input.value.trim();
    if (!q) return;
    btn.textContent = '…';
    btn.disabled    = true;
    try {
      _showResults(await _geocode(q));
    } catch {
      results.innerHTML = '<div style="padding:8px 12px;font-size:12px;color:#e85d3e">Erreur réseau</div>';
      results.style.display = 'block';
    }
    btn.textContent = '→';
    btn.disabled    = false;
  }

  btn.addEventListener('click', _doSearch);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); _doSearch(); } });

  let _deb = null;
  input.addEventListener('input', () => {
    clearTimeout(_deb);
    const q = input.value.trim();
    if (q.length < 3) { results.style.display = 'none'; return; }
    _deb = setTimeout(_doSearch, 450);
  });

  // Close dropdown when clicking outside the search bar.
  // Store the handler at module scope so renderMapCal can clean it up on re-render.
  const _outsideClick = e => {
    if (!document.getElementById('ms-results')) {
      document.removeEventListener('click', _outsideClick);
      _mapSearchOutsideClickFn = null;
      return;
    }
    if (!e.target.closest('#map-srch')) results.style.display = 'none';
  };
  _mapSearchOutsideClickFn = _outsideClick;
  document.addEventListener('click', _outsideClick);
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
      const data = await _geocode(q);
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

  let _debTimer = null;
  queryInput.addEventListener('input', () => {
    clearTimeout(_debTimer);
    const q = (queryInput.value || '').trim();
    if (q.length < 3) { resultsEl.innerHTML = ''; return; }
    _debTimer = setTimeout(doSearch, 500);
  });

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
    ${trip?.multiCountry ? `<div class="fg">
      <label>Drapeau pays <span style="color:var(--ink4);font-weight:400">(pays de cette étape)</span></label>
      <input type="text" id="ad-flag" value="${_esc(trip?.flag || '')}" placeholder="🇫🇷" maxlength="8"
        style="width:64px;font-size:16px">
    </div>` : ''}
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
      flag:   (document.getElementById('ad-flag')?.value || '').trim() || null,
      lat:    pickedLat != null ? Number(pickedLat) : null,
      lng:    pickedLng != null ? Number(pickedLng) : null,
      color:  selColor,
      photo:  '',
      items:  [],
    };

    days.push(newDay);
    updateTrip(tripId, { days });
    closeModal();
    _openDayIds.add(newDay.id);
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
    ${trip?.multiCountry ? `<div class="fg">
      <label>Drapeau pays <span style="color:var(--ink4);font-weight:400">(pays de cette étape)</span></label>
      <input type="text" id="ad-flag" value="${_esc(trip?.flag || '')}" placeholder="🇫🇷" maxlength="8"
        style="width:64px;font-size:16px">
    </div>` : ''}
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
      flag:   (document.getElementById('ad-flag')?.value || '').trim() || null,
      lat:    Number(pickedLat),
      lng:    Number(pickedLng),
      color:  selColor,
      photo:  '',
      items:  [],
    };

    days.push(newDay);
    updateTrip(tripId, { days });
    closeModal();
    _openDayIds.add(newDay.id);
    _renderDaysList(tripId);
    _renderMiniCal(tripId);
    _refreshMapPins(tripId);
    notify('Jour ajouté !', '✅');
  });
}

// ─── Add Event Modal ──────────────────────────────────────────────────────────

function _openAddEventModal(dayId, tripId, prefill = null) {
  const evtTypes   = getEventTypes();
  let selType      = prefill?.type || (evtTypes.find(t => t.key === 'visit') ? 'visit' : (evtTypes[0]?.key || 'visit'));
  let selTransport = prefill?.transport || 'car';
  let pickedLat    = prefill?.lat ?? null;
  let pickedLng    = prefill?.lng ?? null;
  const _aeTrip    = getTrip(tripId);
  const _aeSorted  = (_aeTrip?.days || []).filter(d => d.date).sort((a, b) => a.date.localeCompare(b.date));
  const _aeStart   = _aeSorted[0]?.date || '';
  const _aeEnd     = _aeSorted[_aeSorted.length - 1]?.date || '';
  const _aeDay     = (_aeTrip?.days || []).find(d => d.id === dayId);
  const _aeDate    = _aeDay?.date || '';
  const _isMob     = window.innerWidth <= 768;
  const _close     = _isMob ? _closeMobileEventSheet : closeModal;
  const _openSheet = _isMob ? _showMobileEventSheet  : showModal;

  function _aeTypeBtnsHtml() {
    return evtTypes.map(et => {
      const active = et.key === selType;
      return `<button class="tp${active ? ' sel' : ''}" data-ae-type="${_esc(et.key)}"
        style="${active ? `background:${et.color};border-color:${et.color};color:#fff` : ''}">${et.emoji} ${et.label}</button>`;
    }).join('');
  }

  _openSheet(`
    <h3 style="margin-bottom:16px">＋ Ajouter un événement</h3>

    <div class="fg">
      <label>Type</label>
      <div style="display:flex;gap:6px;flex-wrap:wrap" id="ae-types">
        ${_aeTypeBtnsHtml()}
      </div>
    </div>

    <div id="ae-transport-row" style="display:${selType === 'drive' ? '' : 'none'}" class="fg">
      <label>Mode de transport</label>
      <div style="display:flex;gap:6px;flex-wrap:wrap" id="ae-modes">
        <button class="tp sel" data-ae-mode="car"   style="background:${trCol('car')};border-color:${trCol('car')};color:#fff">🚗 Voiture</button>
        <button class="tp" data-ae-mode="train"  >🚆 Train</button>
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

    <div class="fg">
      <label>Heure</label>
      <input type="time" id="ae-time">
    </div>
    <div class="fg">
      <label>Coût (€)</label>
      <input type="number" id="ae-cost" min="0" step="0.01" placeholder="0">
    </div>

    <div id="ae-dest-row" style="display:${selType === 'drive' ? '' : 'none'}" class="fg">
      <label>Destination</label>
      <div id="ae-dest-widget"></div>
    </div>

    <div id="ae-sleep-dates" style="display:${selType === 'sleep' ? '' : 'none'}" class="fg">
      <label>Première nuit</label>
      <input type="date" id="ae-sleep-from" value="${_aeDate}" min="${_aeStart}" max="${_aeEnd}"
        style="width:100%;padding:5px 8px;border:1.5px solid var(--c3);border-radius:6px;font-size:14px;background:var(--c);color:var(--ink)">
      <label style="display:block;margin-top:8px">Dernière nuit</label>
      <input type="date" id="ae-sleep-to" value="${_aeEnd}" min="${_aeStart}" max="${_aeEnd}"
        style="width:100%;padding:5px 8px;border:1.5px solid var(--c3);border-radius:6px;font-size:14px;background:var(--c);color:var(--ink)">
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
  const _locWidget = _buildLocationSearch(
    locWidgetEl,
    ({ lat, lng }) => { pickedLat = lat; pickedLng = lng; },
    () => {
      _close();
      if (_map) {
        _map.getContainer().style.cursor = 'crosshair';
        const infoEl = document.createElement('div');
        infoEl.id = 'map-pick-info';
        infoEl.style.cssText = 'position:absolute;top:10px;left:50%;transform:translateX(-50%);z-index:1000;background:#fff;border:1.5px solid var(--teal);border-radius:20px;padding:6px 16px;font-size:12px;font-weight:700;color:var(--teal);box-shadow:0 2px 8px rgba(0,0,0,.12)';
        infoEl.textContent = '📍 Cliquez sur la carte pour définir la localisation';
        document.querySelector('.map-col')?.appendChild(infoEl);
      }
      _pendingMapClick = (lat, lng) => {
        if (_map) _map.getContainer().style.cursor = '';
        document.getElementById('map-pick-info')?.remove();
        _openAddEventModal(dayId, tripId, { lat, lng, type: selType, transport: selTransport });
        notify(`📍 ${lat.toFixed(5)}, ${lng.toFixed(5)} sélectionné`, '✅');
      };
    }
  );

  // Pre-fill location from map search
  if (prefill?.lat != null && _locWidget) {
    _locWidget.setSelected(`📍 ${prefill.label || (prefill.lat.toFixed(5) + ', ' + prefill.lng.toFixed(5))}`);
  }

  // Transport destination widget (shown only for drive)
  let destLat = null, destLng = null;
  const destWidgetEl = document.getElementById('ae-dest-widget');
  if (destWidgetEl) {
    _buildLocationSearch(
      destWidgetEl,
      ({ lat, lng }) => { destLat = lat; destLng = lng; },
      () => {
        _close();
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
    const selEt = evtTypes.find(t => t.key === selType);

    typesContainer.querySelectorAll('[data-ae-type]').forEach(p => {
      const tKey   = p.dataset.aeType;
      const etInfo = evtTypes.find(t => t.key === tKey);
      const active = tKey === selType;
      p.classList.toggle('sel', active);
      p.style.background  = active ? (etInfo?.color || tCol(tKey)) : '';
      p.style.borderColor = active ? (etInfo?.color || tCol(tKey)) : '';
      p.style.color       = active ? '#fff' : '';
    });

    if (transportRow) transportRow.style.display = selType === 'drive' ? '' : 'none';
    if (destRow)      destRow.style.display       = selType === 'drive' ? '' : 'none';
    const sleepRow = document.getElementById('ae-sleep-dates');
    if (sleepRow) sleepRow.style.display = selType === 'sleep' ? '' : 'none';
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

  document.getElementById('ae-cancel')?.addEventListener('click', _close);

  document.getElementById('ae-save')?.addEventListener('click', () => {
    const text  = (document.getElementById('ae-text')?.value  || '').trim();
    const time  = (document.getElementById('ae-time')?.value  || '').trim() || null;
    const cost  = parseFloat(document.getElementById('ae-cost')?.value || '0') || 0;
    const notes = (document.getElementById('ae-notes')?.value || '').trim();

    const _selEtFinal = evtTypes.find(t => t.key === selType);
    const event = {
      id:        'e_' + uid(),
      type:      selType,
      emoji:     _selEtFinal?.emoji  || null,
      color:     _selEtFinal?.color  || null,
      text,
      time,
      cost,
      notes,
      ...(selType === 'drive' ? {
        transport: selTransport,
        destLat,
        destLng,
      } : {}),
      ...(selType === 'sleep' ? {
        dateFrom: document.getElementById('ae-sleep-from')?.value || null,
        dateTo:   document.getElementById('ae-sleep-to')?.value   || null,
      } : {}),
    };

    const trip2 = getTrip(tripId);
    if (!trip2) return;
    const day = (trip2.days || []).find(d => d.id === dayId);
    if (!day) return;

    // Store location on the event; update day PIN only for non-sleep events
    if (pickedLat != null && pickedLng != null) {
      event.lat = pickedLat;
      event.lng = pickedLng;
      if (selType !== 'sleep' && day.lat == null) {
        day.lat = pickedLat;
        day.lng = pickedLng;
      }
    }

    // Date validation for sleep events
    if (selType === 'sleep') {
      const df = event.dateFrom, dt = event.dateTo;
      if (!df || !dt) { notify('Les dates de début et de fin sont requises', '⚠️'); return; }
      if (df > dt) { notify('La date de fin doit être après la date de début', '⚠️'); return; }
      if (_aeStart && df < _aeStart) { notify('La date de début est avant le voyage', '⚠️'); return; }
      if (_aeEnd   && dt > _aeEnd)   { notify('La date de fin est après le voyage',   '⚠️'); return; }
    }

    // Sleep items: anchor in the day matching dateFrom so they appear on the right day
    const targetDay = selType === 'sleep' && event.dateFrom
      ? ((trip2.days || []).find(d => d.date === event.dateFrom) || day)
      : day;
    (targetDay.items = targetDay.items || []).push(event);
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

    _close();
    _renderDaysList(tripId);
    _refreshMapPins(tripId);
    updateTopStats(tripId);
    notify('Événement ajouté !', '✅');
  });
}

// ─── Relative time helper ─────────────────────────────────────────────────────

function _relativeTime(isoTs) {
  const diff = Date.now() - new Date(isoTs).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'à l\'instant';
  if (mins < 60) return `il y a ${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `il y a ${hrs} h`;
  return `il y a ${Math.floor(hrs / 24)} j`;
}

// ─── HTML escape ──────────────────────────────────────────────────────────────

function _esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
