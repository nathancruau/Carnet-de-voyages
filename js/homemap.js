/* ============================================================
   CARNET DE VOYAGES — Carte de l'accueil (refonte bêta)
   ============================================================
   MapLibre GL (vendor/maplibre-gl.js, chargé à la demande) :
   - projection globe ou plate (réglage), zoom jusqu'au niveau rue
   - fonds raster Standard / Relief / Satellite (réglage)
   - PINs des voyages réalisés, regroupés quand ils sont proches
     (clustering de la source GeoJSON, rendu en marqueurs HTML)

   La carte est créée une seule fois puis son conteneur est
   déplacé dans chaque nouveau rendu de l'accueil (renderHome()
   reconstruit tout son innerHTML à chaque changement d'état —
   recréer un contexte WebGL et recharger les tuiles à chaque
   fois clignoterait).

   Exports :
     collectMapPins(trips)        → pins (mêmes règles que _buildAllPins de mymap.js)
     attachHomeMap(slot, opts)    → place la carte dans `slot`, la crée au besoin
     setHomeMapPins(pins)
     setHomeMapPadding(p, animate)
     flyToPin(pin)
   ============================================================ */

const MAPLIBRE_JS  = '/vendor/maplibre-gl.js';
const MAPLIBRE_CSS = '/vendor/maplibre-gl.css';

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';

// Fonds raster. Chaque entrée = liste de couches (id, tuiles, zooms).
const BASES = {
  standard: {
    attribution: '© OpenStreetMap © CARTO',
    layers: [{ tiles: ['a', 'b', 'c', 'd'].map(s => `https://${s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png`), maxzoom: 19 }],
  },
  relief: {
    attribution: '© Esri — Sources : Esri, USGS, NOAA, OpenStreetMap',
    layers: [
      // Relief physique stylisé à l'échelle du monde, carte topo détaillée en zoomant
      { tiles: [`${ESRI}/World_Physical_Map/MapServer/tile/{z}/{y}/{x}`], maxzoom: 8, layerMaxzoom: 7.5 },
      { tiles: [`${ESRI}/World_Topo_Map/MapServer/tile/{z}/{y}/{x}`], maxzoom: 19, layerMinzoom: 7.5 },
    ],
  },
  satellite: {
    attribution: '© Esri — Maxar, Earthstar Geographics',
    layers: [
      { tiles: [`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`], maxzoom: 19 },
      { tiles: [`${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`], maxzoom: 19, layerMinzoom: 3 },
    ],
  },
};

let _libPromise = null;
let _map        = null;
let _host       = null;           // div persistant qui contient la carte
let _pins       = [];
let _markers    = new Map();      // clé → maplibregl.Marker
let _opts       = {};
let _base       = null;           // clé du fond appliqué
let _proj       = null;           // 'globe' | 'flat'
let _syncQueued = false;
let _needsZoom  = false;          // carte créée dans un écran masqué (taille 0) : zoom initial à recalculer
let _padding    = null;           // dernier padding demandé (réappliqué au chargement du style)

function _loadLib() {
  if (window.maplibregl) return Promise.resolve(window.maplibregl);
  if (!_libPromise) {
    _libPromise = new Promise((resolve, reject) => {
      if (!document.querySelector(`link[href="${MAPLIBRE_CSS}"]`)) {
        const link = document.createElement('link');
        link.rel = 'stylesheet'; link.href = MAPLIBRE_CSS;
        document.head.appendChild(link);
      }
      const s = document.createElement('script');
      s.src = MAPLIBRE_JS; s.async = true;
      s.onload  = () => resolve(window.maplibregl);
      s.onerror = () => { _libPromise = null; reject(new Error('maplibre load failed')); };
      document.head.appendChild(s);
    });
  }
  return _libPromise;
}

/**
 * Mêmes règles que _buildAllPins (mymap.js, « Mes destinations ») : seulement les
 * voyages réalisés, PINs des jours + anciennes journalEntries + PIN unique d'une
 * sortie. Version allégée : position, de quoi filtrer et afficher une vignette.
 */
export function collectMapPins(trips, eventTypes = []) {
  const emojiOf = Object.fromEntries(eventTypes.map(et => [et.key, et.emoji]));
  const pins = [];
  for (const trip of trips) {
    if (trip.status !== 'done') continue;
    const base = { tripId: trip.id, tripName: trip.name || 'Voyage', tripType: trip.type || 'voyage',
                   color: trip.color || '#0d9488' };
    for (const day of (trip.days || [])) {
      for (const item of (day.items || [])) {
        const lat = parseFloat(item.lat), lng = parseFloat(item.lng);
        if (isNaN(lat) || isNaN(lng)) continue;
        const jd = item.journalData || {};
        pins.push({ ...base, id: item.id, lat, lng, title: item.text || '—', date: day.date || null,
                    pinType: item.type || null, emoji: emojiOf[item.type] || '📍',
                    photo: (jd.photos || [])[0] || item.photo || null });
      }
    }
    for (const e of (trip.journalEntries || [])) {
      const lat = parseFloat(e.lat), lng = parseFloat(e.lng);
      if (isNaN(lat) || isNaN(lng)) continue;
      pins.push({ ...base, id: e.id, lat, lng, title: e.title || '—', date: e.date || null,
                  pinType: null, emoji: '📍', photo: null });
    }
    if (trip.type === 'sortie' && trip.pin) {
      const lat = parseFloat(trip.pin.lat), lng = parseFloat(trip.pin.lng);
      if (!isNaN(lat) && !isNaN(lng)) {
        const pt = trip.pin.pinType || 'visit';
        pins.push({ ...base, id: trip.id + '_pin', lat, lng, title: trip.name || 'Sortie',
                    date: trip.pin.date || trip.startDate || null, pinType: pt, emoji: emojiOf[pt] || '📍',
                    photo: trip.photo || null });
      }
    }
  }
  return pins;
}

function _geojson() {
  return {
    type: 'FeatureCollection',
    features: _pins.map((p, i) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
      properties: { idx: i },
    })),
  };
}

function _applyBase(key) {
  if (!_map || !BASES[key]) return;
  // Retire l'ancien fond
  for (const l of (_map.getStyle()?.layers || [])) if (l.id.startsWith('base-')) _map.removeLayer(l.id);
  for (const id of Object.keys(_map.getStyle()?.sources || {})) if (id.startsWith('base-')) _map.removeSource(id);
  const before = _map.getLayer('pins-anchor') ? 'pins-anchor' : undefined;
  BASES[key].layers.forEach((l, i) => {
    const id = `base-${key}-${i}`;
    _map.addSource(id, {
      type: 'raster', tiles: l.tiles, tileSize: l.tiles[0].includes('@2x') ? 512 : 256,
      maxzoom: l.maxzoom, attribution: i === 0 ? BASES[key].attribution : undefined,
    });
    const layer = { id, type: 'raster', source: id, paint: { 'raster-fade-duration': 150 } };
    if (l.layerMinzoom != null) layer.minzoom = l.layerMinzoom;
    if (l.layerMaxzoom != null) layer.maxzoom = l.layerMaxzoom;
    _map.addLayer(layer, before);
  });
  _base = key;
}

function _applyProjection(proj) {
  if (!_map) return;
  _map.setProjection({ type: proj === 'flat' ? 'mercator' : 'globe' });
  _proj = proj;
}

// Diamètre du globe ≈ 163 px × 2^zoom : on vise ~85 % de la zone visible.
function _globeZoomFor(w, h) {
  return Math.max(0, Math.log2(0.85 * Math.min(w, h) / 163));
}

function _initialView() {
  if (!_pins.length) return { center: [10, 35], zoom: null };
  const sorted = [..._pins].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const recent = sorted.filter(p => p.tripId === sorted[0].tripId);
  return {
    center: [recent.reduce((s, p) => s + p.lng, 0) / recent.length,
             Math.max(-60, Math.min(60, recent.reduce((s, p) => s + p.lat, 0) / recent.length))],
  };
}

function _pinEl(pin) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'hm-pin';
  el.style.setProperty('--pc', pin.color);
  el.innerHTML = `<span class="hm-pin-head"><span>${pin.emoji}</span></span>`;
  el.title = pin.title;
  el.addEventListener('click', e => {
    e.stopPropagation();
    if (el.style.opacity === '0') return; // face cachée du globe
    _opts.onPinsTap?.([pin]);
  });
  return el;
}

function _clusterEl(count, clusterId, coords) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'hm-cluster' + (count >= 10 ? ' hm-cluster-lg' : '');
  el.textContent = count;
  el.addEventListener('click', async e => {
    e.stopPropagation();
    if (el.style.opacity === '0') return; // face cachée du globe
    const src = _map.getSource('pins');
    try {
      const zoom = await src.getClusterExpansionZoom(clusterId);
      // Points superposés (même lieu) : le cluster ne se sépare jamais → liste
      if (zoom > 16 || _map.getZoom() >= 15) {
        const leaves = await src.getClusterLeaves(clusterId, 50, 0);
        _opts.onPinsTap?.(leaves.map(f => _pins[f.properties.idx]).filter(Boolean));
      } else {
        _map.easeTo({ center: coords, zoom: Math.min(zoom + 0.3, 18), duration: 600 });
      }
    } catch (_) { /* cluster disparu entre-temps */ }
  });
  return el;
}

/** Synchronise les marqueurs HTML avec les features (points + clusters) chargées. */
function _syncMarkers() {
  _syncQueued = false;
  if (!_map || !_map.getSource('pins') || !_map.isSourceLoaded('pins')) return;
  const seen = new Set();
  for (const f of _map.querySourceFeatures('pins')) {
    const p = f.properties;
    const key = p.cluster ? 'c' + p.cluster_id : 'p' + p.idx;
    if (seen.has(key)) continue; // une même feature peut figurer dans plusieurs tuiles
    seen.add(key);
    if (_markers.has(key)) continue;
    const coords = f.geometry.coordinates;
    let marker;
    if (p.cluster) {
      marker = new window.maplibregl.Marker({ element: _clusterEl(p.point_count, p.cluster_id, coords), opacityWhenCovered: '0' });
    } else {
      const pin = _pins[p.idx];
      if (!pin) continue;
      marker = new window.maplibregl.Marker({ element: _pinEl(pin), anchor: 'bottom', opacityWhenCovered: '0' });
    }
    marker.setLngLat(coords).addTo(_map);
    _markers.set(key, marker);
  }
  for (const [key, m] of _markers) if (!seen.has(key)) { m.remove(); _markers.delete(key); }
}

function _queueSync() {
  if (_syncQueued) return;
  _syncQueued = true;
  requestAnimationFrame(_syncMarkers);
}

function _clearMarkers() {
  for (const m of _markers.values()) m.remove();
  _markers.clear();
}

/**
 * Place la carte dans `slot` (la crée au premier appel).
 * opts : { pins, base: 'standard'|'relief'|'satellite', projection: 'globe'|'flat',
 *          padding: {top,bottom,left,right}, onPinsTap(pins[]), onError() }
 */
export async function attachHomeMap(slot, opts) {
  _opts = opts;
  if (!_host) {
    _host = document.createElement('div');
    _host.className = 'hm-host';
    // L'accueil peut être rendu alors que son écran est encore masqué (taille 0) :
    // quand il devient visible, on redimensionne et on laisse l'appelant recadrer.
    new ResizeObserver(() => {
      if (!_map || !_host.clientWidth || !_host.clientHeight) return;
      _map.resize();
      _opts.onResize?.();
      if (_needsZoom) {
        const pad = _padding || {};
        _map.jumpTo({ zoom: _globeZoomFor(
          Math.max(200, _host.clientWidth  - (pad.left || 0) - (pad.right || 0)),
          Math.max(200, _host.clientHeight - (pad.top  || 0) - (pad.bottom || 0))) });
        _needsZoom = false;
      }
    }).observe(_host);
  }
  slot.appendChild(_host);

  let lib;
  try { lib = await _loadLib(); }
  catch (err) { opts.onError?.(err); return; }
  if (!_host.isConnected) return; // l'accueil a été quitté pendant le chargement

  if (!_map) {
    _pins = opts.pins || [];
    const { center } = _initialView();
    const pad = opts.padding || {};
    const visW = _host.clientWidth  - (pad.left || 0) - (pad.right || 0);
    const visH = _host.clientHeight - (pad.top  || 0) - (pad.bottom || 0);
    _needsZoom = !_host.clientWidth || !_host.clientHeight;
    _map = new lib.Map({
      container: _host,
      style: {
        version: 8,
        projection: { type: opts.projection === 'flat' ? 'mercator' : 'globe' },
        sky: { 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0] },
        sources: { pins: { type: 'geojson', data: _geojson(), cluster: true, clusterRadius: 46, clusterMaxZoom: 16 } },
        layers: [
          { id: 'ocean', type: 'background', paint: { 'background-color': '#0f3a6b' } },
          // Couche invisible : force le chargement de la source (les marqueurs sont en HTML)
          { id: 'pins-anchor', type: 'circle', source: 'pins', paint: { 'circle-radius': 0, 'circle-opacity': 0 } },
        ],
      },
      center,
      zoom: _globeZoomFor(Math.max(200, visW), Math.max(200, visH)),
      minZoom: 0,
      maxZoom: 19,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
      renderWorldCopies: false,
    });
    _map.touchZoomRotate.disableRotation();
    _map.setPadding(pad);
    _proj = opts.projection === 'flat' ? 'flat' : 'globe';
    _padding = pad;
    _map.on('load', () => {
      _applyBase(opts.base || 'relief');
      // Le padding posé avant le chargement du style n'est pas toujours conservé ;
      // le zoom initial est recalculé avec la zone visible réelle (feuille en place)
      if (_padding) {
        _map.jumpTo({ padding: _padding, zoom: _globeZoomFor(
          Math.max(200, _host.clientWidth  - (_padding.left || 0) - (_padding.right || 0)),
          Math.max(200, _host.clientHeight - (_padding.top  || 0) - (_padding.bottom || 0))) });
        _needsZoom = false;
      }
      _queueSync();
    });
    // Attribution repliée en (i) — dépliée par défaut, elle masque le haut de la carte
    _map.once('idle', () => _host.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'));
    _map.on('render', _queueSync);
    _map.on('click', () => _opts.onPinsTap?.([]));
  } else {
    _map.resize();
    if (opts.padding) setHomeMapPadding(opts.padding);
    if (_needsZoom && _host.clientWidth && _host.clientHeight) {
      const pad = opts.padding || {};
      _map.jumpTo({ zoom: _globeZoomFor(
        Math.max(200, _host.clientWidth  - (pad.left || 0) - (pad.right || 0)),
        Math.max(200, _host.clientHeight - (pad.top  || 0) - (pad.bottom || 0))) });
      _needsZoom = false;
    }
    if (_map.loaded() || _map.isStyleLoaded()) {
      if ((opts.base || 'relief') !== _base) _applyBase(opts.base || 'relief');
      if ((opts.projection || 'globe') !== _proj) _applyProjection(opts.projection || 'globe');
    }
    setHomeMapPins(opts.pins || []);
  }
}

export function setHomeMapPins(pins) {
  const same = pins.length === _pins.length && pins.every((p, i) => p.id === _pins[i]?.id && p.lat === _pins[i].lat && p.lng === _pins[i].lng);
  _pins = pins;
  if (!_map || same) return;
  const src = _map.getSource('pins');
  if (!src) return;
  _clearMarkers();          // les cluster_id changent avec les données
  src.setData(_geojson());
}

export function setHomeMapPadding(padding, animate = false) {
  _padding = padding;
  if (!_map || !_map.isStyleLoaded()) return;
  if (animate) _map.easeTo({ padding, duration: 320 });
  else _map.setPadding(padding);
}

export function flyToPin(pin) {
  if (!_map || !pin) return;
  _map.flyTo({ center: [pin.lng, pin.lat], zoom: Math.max(_map.getZoom(), 12), duration: 1400, essential: true });
}

export function homeMapResize() { _map?.resize(); }
