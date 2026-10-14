/* ============================================================
   CARNET DE VOYAGES — Écran d'une sortie (v244, style v2)
   ============================================================
   Même principe que l'écran voyage v2 (tripv2.js) : carte MapLibre de
   l'accueil en fond (le PIN de la sortie + sa trace GPX) et une feuille
   glissante (sheet.js) avec la fiche : photo, type, date, lieu, météo,
   coût, notes, statistiques et graphique de la trace GPX.
   Rendu dans #trip-v2 (préfixé dans #screen-app, classe tv2-on).
   ============================================================ */

import { getTrip, getEventTypes, getSettings } from '../store.js';
import { notify } from '../utils.js';
import { gpxStatsBlockHtml, initGpxChart, resolveGpxPoints } from '../gpx.js';
import { attachHomeMap, setHomeMapPins, setHomeMapRoute, fitHomeMap, collectTripPins } from '../homemap.js';
import { createSheet } from '../sheet.js';

const MAP_EXT = 260;
const WIDE = () => window.innerWidth > 900;

let _tripId = null;
let _sheet  = null;
let _snap   = 'mid';
let _bound  = false;

const _esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const ICON = {
  back: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
  down: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  edit: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
};

function _type(trip) {
  const ets = getEventTypes();
  return ets.find(e => e.key === (trip.pin?.pinType || 'visit')) || ets[0] || { emoji: '📍', label: 'Sortie', color: '#0d9488' };
}

function _pins(trip) {
  const pin = trip.pin || {};
  if (pin.lat == null || pin.lng == null) return [];
  const fake = { ...trip, days: [{ id: 's', date: pin.date, items: [{
    id: trip.id, text: trip.name, type: pin.pinType || 'visit', lat: pin.lat, lng: pin.lng,
    countryCode: pin.countryCode, countryFlag: pin.countryFlag, photo: trip.photo || null }] }] };
  return collectTripPins(fake, getEventTypes());
}

function _route(trip) {
  const pts = (resolveGpxPoints(trip.id, trip.pin || {}) || [])
    .filter(p => !isNaN(+p.lat) && !isNaN(+p.lng)).map(p => [+p.lng, +p.lat]);
  return pts.length > 1 ? [{ coords: pts, color: '#f97316' }] : null;
}

function _mapPadding() {
  const H = window.innerHeight;
  if (WIDE()) return { top: 70, bottom: 20, left: 400, right: 0 };
  return { top: 120 + MAP_EXT, bottom: Math.max(0, H - Math.round(H * 0.5)), left: 0, right: 0 };
}

export async function renderSortie(tripId) {
  _tripId = tripId;
  const trip = getTrip(tripId);
  const app = document.getElementById('screen-app');
  if (!trip || !app) return;

  let host = document.getElementById('trip-v2');
  if (!host) { host = document.createElement('div'); host.id = 'trip-v2'; app.prepend(host); }
  app.classList.add('tv2-on');
  host.hidden = false;
  const dark = document.documentElement.dataset.theme === 'dark';
  const bg = dark ? '#14181d' : '#ffffff';
  document.documentElement.style.setProperty('background', bg, 'important');
  document.body.style.setProperty('background', bg, 'important');
  window.scrollTo(0, 0);

  const et = _type(trip);
  host.innerHTML = `
    <div class="tv2 so" id="tv2" data-snap="${_snap}">
      <div class="tv2-map-slot" id="tv2-map-slot"></div>
      <div class="tv2-dim"></div>
      <div class="tv2-top" id="tv2-top">
        <button class="hv2-round" data-so="back" title="Retour">${ICON.back}</button>
        <div class="tv2-title"><small>${et.emoji} ${_esc(et.label || 'Sortie')}</small><b>${_esc(trip.name || 'Sortie')}</b></div>
        <div class="tv2-actions"><button class="hv2-round" data-so="edit" title="Modifier">${ICON.edit}</button></div>
      </div>
      <section class="tv2-sheet" id="tv2-sheet">
        <div class="tv2-grab"><span></span></div>
        <div class="tv2-scroll" id="tv2-scroll">
          <div class="tv2-sheet-head">
            <div class="tv2-head-l">
              <button class="hv2-round hv2-round-light tv2-sm" data-so="back" title="Retour">${ICON.back}</button>
              <button class="hv2-round hv2-round-light tv2-sm" data-so="collapse" title="Revenir à la carte">${ICON.down}</button>
            </div>
            <div class="tv2-head-r"><button class="hv2-round hv2-round-light tv2-sm" data-so="edit" title="Modifier">${ICON.edit}</button></div>
          </div>
          <div class="tv2-pane" id="tv2-pane">${_infoHtml(trip)}</div>
        </div>
      </section>
    </div>`;

  const root = host.querySelector('#tv2');
  _sheet?.destroy();
  _sheet = createSheet({
    root, sheet: root.querySelector('#tv2-sheet'), scroll: root.querySelector('#tv2-scroll'),
    grab: root.querySelector('.tv2-grab'), top: root.querySelector('#tv2-top'),
    dim: root.querySelector('.tv2-dim'), slot: root.querySelector('#tv2-map-slot'),
    mapExt: MAP_EXT, wide: WIDE, initial: _snap,
    snaps: () => {
      const H = window.innerHeight;
      return { full: 0, mid: Math.round(H * 0.5), peek: Math.max(0, H - 120) };
    },
    onSnap: s => { _snap = s; },
  });
  _sheet.setSnap(_snap, false);

  root.addEventListener('click', e => {
    const b = e.target.closest('[data-so]');
    if (!b) return;
    if (b.dataset.so === 'back') window.goHome?.();
    else if (b.dataset.so === 'collapse') _sheet?.setSnap('mid');
    else if (b.dataset.so === 'edit') window._openEditTripModal?.(_tripId);
  });

  _initChart(trip);

  attachHomeMap(root.querySelector('#tv2-map-slot'), {
    context: 'trip', pins: _pins(trip), route: _route(trip),
    ...((getSettings().homeMap) || {}),
    padding: _mapPadding(),
    onPinsTap: () => _sheet?.setSnap('mid'),
    onResize: () => _sheet?.refresh(),
    onError: () => notify('Carte indisponible (hors-ligne ?)', '🗺'),
  }).then(() => { if (_tripId === tripId) fitHomeMap(_mapPadding(), false); });

  if (!_bound) {
    _bound = true;
    window.addEventListener('trip-updated', e => {
      if (!_tripId || e.detail?.id !== _tripId || document.getElementById('trip-v2')?.hidden !== false) return;
      const t = getTrip(_tripId);
      if (!t || !document.querySelector('#tv2.so')) return;
      const pane = document.getElementById('tv2-pane');
      if (pane) pane.innerHTML = _infoHtml(t);
      _initChart(t);
      setHomeMapPins(_pins(t));
      setHomeMapRoute(_route(t));
    });
  }
}

function _initChart(trip) {
  const pts = trip.pin ? resolveGpxPoints(trip.id, trip.pin) : null;
  if (pts?.length >= 2) initGpxChart('si', pts);
}

export function destroySortieMap() {
  _sheet?.destroy(); _sheet = null;
  if (document.querySelector('#tv2.so')) {
    const host = document.getElementById('trip-v2');
    if (host) { host.innerHTML = ''; host.hidden = true; }
    document.getElementById('screen-app')?.classList.remove('tv2-on');
  }
  _tripId = null;
}

function _infoHtml(trip) {
  const pin = trip.pin || {};
  const et  = _type(trip);
  const gpxPoints = resolveGpxPoints(trip.id, pin);
  const dateStr = pin.date
    ? new Date(pin.date + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    : 'Date non définie';

  // trip.photos[0] = la couverture (même photo que trip.photo), les suivantes = photos en plus
  const allPhotos = trip.photos?.length ? trip.photos : (trip.photo ? [{ url: trip.photo }] : []);
  window._siPhotos = allPhotos.map(p => p.url);
  const cover = allPhotos[0];
  const extra = allPhotos.slice(1);

  const gs = pin.gpxStats;
  const stats = [];
  if (gs?.distanceM) stats.push([(gs.distanceM / 1000).toFixed(1).replace('.', ','), 'km']);
  if (gs?.elevGain) stats.push(['+' + Math.round(gs.elevGain), 'm D+']);
  if (gs?.durationSecs) { const h = Math.floor(gs.durationSecs / 3600), m = Math.round((gs.durationSecs % 3600) / 60); stats.push([h ? `${h}h${String(m).padStart(2, '0')}` : `${m}`, h ? 'durée' : 'min']); }
  if (pin.cost) stats.push([Number(pin.cost).toLocaleString('fr-FR', { maximumFractionDigits: 2 }), pin.currency && pin.currency !== 'EUR' ? pin.currency : '€']);

  const rows = [
    ['📅', dateStr + (pin.time ? ` · ${_esc(pin.time)}` : '')],
    trip.destination ? ['📍', _esc(trip.destination)] : null,
    pin.weather ? ['🌡', _esc(pin.weather)] : null,
  ].filter(Boolean);

  return `
    <div class="tv2-hero so-hero">
      ${cover ? `<div class="tv2-cover" onclick="window._openSlides && window._openSlides(window._siPhotos || [], 0)"><img src="${_esc(cover.url)}" alt="" decoding="async" onerror="this.parentElement.remove()"></div>` : ''}
      ${extra.length ? `<div class="so-thumbs">${extra.map((p, i) => `<img src="${_esc(p.url)}" alt="" loading="lazy" decoding="async"
          onclick="window._openSlides && window._openSlides(window._siPhotos || [], ${i + 1})" onerror="this.remove()">`).join('')}</div>` : ''}
      <div class="tv2-hero-top"><span class="tv2-chip" style="background:color-mix(in srgb,${_esc(et.color || '#0d9488')} 16%,transparent);color:${_esc(et.color || '#0d9488')}">${et.emoji} ${_esc(et.label || 'Sortie')}</span></div>
      <h1>${_esc(trip.name || 'Sortie')}</h1>
      ${stats.length ? `<div class="tv2-hero-stats">${stats.map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join('')}</div>` : ''}
    </div>
    <div class="so-card">
      ${rows.map(([ic, v]) => `<div class="so-row"><span>${ic}</span><div>${v}</div></div>`).join('')}
    </div>
    ${pin.description ? `<div class="so-sec">Notes</div><div class="so-card so-notes">${_esc(pin.description).replace(/\n/g, '<br>')}</div>` : ''}
    ${pin.gpxTrackId && gs ? `<div class="so-sec">Trace GPX</div><div class="so-card so-gpx v2-skin">${gpxStatsBlockHtml('si', gs, gpxPoints)}</div>` : ''}
    ${pin.lat == null ? `<div class="so-card so-empty">Aucune position — « Modifier » pour placer la sortie sur la carte.</div>` : ''}
    <div style="height:40px"></div>`;
}
