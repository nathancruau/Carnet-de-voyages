/* ============================================================
   CARNET DE VOYAGES — Écran voyage v2 (refonte bêta, v237)
   ============================================================
   Même principe que l'accueil v2 : carte (globe ou plate selon les
   Paramètres → Carte de l'accueil) en fond, avec les étapes du voyage
   et l'itinéraire, et une feuille glissante (sheet.js) qui détaille le
   voyage. Barre flottante en bas : « Planifier » (les événements prévus,
   jour par jour) / « Suivre » (les publications du carnet).
   En haut à droite : ⚙️ réglages du voyage, 🗓 planning détaillé
   (ancien « Carte & Planning » complet), 🎒 bagages, 💶 budget/dépenses.

   Observateur : uniquement la partie « Suivre » — carte + carrousel des
   publications défilant de droite à gauche ; un tap ouvre la publication
   en plein écran (visionneuse façon « story »).

   Les fenêtres d'ajout/édition (planning, carnet) sont celles qui
   existaient déjà (mapcal.js / journal.js) : rien n'est perdu.
   ============================================================ */

import { getTrip, updateTrip, getEventTypes, getSettings, isTripShared } from '../store.js';
import { fmtDate, customDayTitle, trIc, trNm, trCol, notify, showModal, closeModal } from '../utils.js';
import { attachHomeMap, setHomeMapPins, setHomeMapRoute, setHomeMapPadding, fitHomeMap, flyToPin, collectTripPins } from '../homemap.js';
import { createSheet } from '../sheet.js';
import { haversineMeters } from '../gpx.js';
import { cachedRoute, fetchRoutes, isRoutedMode } from '../routing.js';
import { getCurrentUser } from '../auth.js';

const MAP_EXT = 260;
const WIDE = () => window.innerWidth > 900;

const _tripState = {};          // tripId → { mode, snap, scroll: { plan, follow }, fitted }
let _tripId     = null;
let _observer   = false;
let _sheet      = null;
let _opts       = {};
let _mapcal     = null;         // module mapcal.js (fenêtres du planning)
let _journal    = null;         // module journal.js (fenêtres du carnet)
let _share      = null;         // module share.js (réactions, commentaires)
let _pins       = [];
let _posts      = [];
let _refreshRaf = 0;

const _esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const ICON = {
  back:  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
  down:  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  gear:  '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  bag:   '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="7" width="16" height="13" rx="2.5"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M4 12h16"/></svg>',
  money: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="6" width="19" height="13" rx="2.5"/><circle cx="12" cy="12.5" r="2.6"/><path d="M6 9.5h.01M18 15.5h.01"/></svg>',
  menu:  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  heart: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 20.5s-7.5-4.6-9.3-9.4C1.4 7.6 3.6 4 7.2 4c2 0 3.6 1.1 4.8 2.8C13.2 5.1 14.8 4 16.8 4c3.6 0 5.8 3.6 4.5 7.1-1.8 4.8-9.3 9.4-9.3 9.4z"/></svg>',
  chat:  '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M21 12a8.5 8.5 0 0 1-12.3 7.6L3 21l1.5-5.2A8.5 8.5 0 1 1 21 12z"/></svg>',
  share: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>',
  dots:  '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  photo: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="5" width="18" height="15" rx="3"/><circle cx="12" cy="12.5" r="3.5"/></svg>',
};

// ── Données ────────────────────────────────────────────────────────────────────

function _st(tripId) {
  return (_tripState[tripId] ||= { mode: 'plan', snap: 'mid', scroll: {}, fitted: false });
}

function _dayCount(trip) {
  if (!trip.startDate || !trip.endDate) return (trip.days || []).length;
  return Math.max(1, Math.round((new Date(trip.endDate + 'T12:00:00') - new Date(trip.startDate + 'T12:00:00')) / 86400000) + 1);
}

function _flagOf(code, fallback) {
  if (fallback && /[\u{1F1E6}-\u{1F1FF}]/u.test(fallback)) return fallback;
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return fallback || '';
  const c = code.toUpperCase();
  return String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65, 0x1F1E6 + c.charCodeAt(1) - 65);
}

let _regionNames = null;
function _countryName(code) {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return '';
  try { _regionNames ||= new Intl.DisplayNames(['fr'], { type: 'region' }); return _regionNames.of(code.toUpperCase()) || ''; }
  catch (_) { return ''; }
}

/** Publications = activités documentées (journalData.validated), dans l'ordre du voyage. */
function _collectPosts(trip) {
  const posts = [];
  (trip.days || []).forEach(day => {
    (day.items || []).forEach((item, idx) => {
      const jd = item.journalData || {};
      if (!jd.validated) return;
      const photos = (jd.photos || []).filter(Boolean);
      const videos = (jd.videos || []).filter(Boolean);   // v242 : URLs Storage
      // media = photos puis vidéos, dans l'ordre de la visionneuse
      const media = [...photos.map(src => ({ t: 'img', src })), ...videos.map(src => ({ t: 'vid', src }))];
      posts.push({ day, item, idx, jd, photos, videos, media, id: item.id || `${day.id}_${idx}` });
    });
  });
  return posts;
}

function _sharedDoc() {
  try { return isTripShared(_tripId) ? _share?.getSharedDocData?.(_tripId) : null; } catch (_) { return null; }
}

// Noms des observateurs du voyage partagé (v244)
function _observerNames() {
  const doc = _sharedDoc();
  return Object.values(doc?.members || {}).filter(m => m.role === 'observer')
    .map(m => { const n = (m.companionName || '').trim(); return n && n !== 'Observateur' ? n : 'Sans nom'; });
}

// Commentaires regroupés par étape une fois par document (au lieu d'un filtre
// complet par publication à chaque rendu)
let _cmtDoc = null, _cmtCounts = null;
function _postCounts(post, doc) {
  if (!doc) return { likes: 0, comments: 0, mine: false };
  if (_cmtDoc !== doc.observerComments) {
    _cmtDoc = doc.observerComments; _cmtCounts = new Map();
    for (const c of Object.values(_cmtDoc || {})) _cmtCounts.set(c.itemId, (_cmtCounts.get(c.itemId) || 0) + 1);
  }
  const r = doc.reactions?.[post.item.id] || {};
  const uid = getCurrentUser()?.uid;
  const likes = Object.values(r).filter(e => e === '❤️').length;
  return { likes, comments: _cmtCounts.get(post.item.id) || 0, mine: !!(uid && r[uid] === '❤️') };
}

// Points de l'itinéraire, calculés une fois par version du voyage (updateTrip crée un
// nouvel objet) : ils servaient 3 fois par rendu (distance, tronçons, tracé)
let _wpTrip = null, _wpList = [];
function _waypoints(trip) {
  if (trip !== _wpTrip) {
    _wpTrip = trip;
    try { _wpList = _mapcal?.collectTripWaypoints(trip) || []; } catch (_) { _wpList = []; }
  }
  return _wpList;
}

const _todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// Géométrie d'un tronçon (v244) : tracé routier en cache si le mode suit les routes
// (voiture, bus, marche, vélo), sinon ligne droite — pointillée pour avion/bateau,
// pour un tracé pas encore calculé, ou sans itinéraire trouvé.
function _legGeom(from, to, mode) {
  const straight = [[Number(from.lng), Number(from.lat)], [Number(to.lng), Number(to.lat)]];
  const color = trCol(mode);
  const r = cachedRoute(from, to, mode);
  if (r) return { coords: r.coords, color, meters: r.meters, road: true };
  const meters = haversineMeters(from, to);
  if (r === undefined && isRoutedMode(mode)) return { coords: straight, color, dash: true, meters, pending: true };
  return { coords: straight, color, dash: mode === 'plane' || mode === 'ferry' || r === null, meters };
}

function _pairs(wps) {
  const out = [];
  for (let i = 1; i < wps.length; i++) {
    const from = wps[i - 1], to = wps[i];
    if ([from.lat, from.lng, to.lat, to.lng].some(v => isNaN(parseFloat(v)))) continue;
    if (haversineMeters(from, to) < 50) continue;
    out.push({ from, to, mode: to.mode || 'car' });
  }
  return out;
}

let _routeReq = 0;
function _routeLines(trip, observer) {
  if (!_mapcal) return null;
  let wps = [];
  wps = _waypoints(trip);
  const pubIds = observer ? new Set(_collectPosts(trip).map(p => p.item.id)) : null;
  if (observer) {
    // Observateur : seulement ce qui a été publié (ne pas dévoiler l'itinéraire prévu)
    wps = wps.filter(w => w.itemId && pubIds.has(w.itemId));
  }
  const lines = [], pending = [];
  for (const leg of _pairs(wps)) {
    const g = _legGeom(leg.from, leg.to, leg.mode);
    lines.push(g);
    if (g.pending) pending.push(leg);
  }
  // Traces GPX importées sur un événement (v244)
  const pub = observer ? pubIds : null;
  (trip.days || []).forEach(d => (d.items || []).forEach(it => {
    if (pub && !pub.has(it.id)) return;
    const pts = (it.gpxPoints || []).filter(p => !isNaN(+p.lat) && !isNaN(+p.lng)).map(p => [+p.lng, +p.lat]);
    if (pts.length > 1) lines.push({ coords: pts, color: '#f97316' });
  }));
  if (pending.length) {
    const req = ++_routeReq, tid = trip.id;
    fetchRoutes(pending).then(changed => {
      if (!changed || req !== _routeReq || _tripId !== tid) return;
      const fresh = getTrip(tid);
      if (!fresh) return;
      setHomeMapRoute(_routeLines(fresh, _observer));
      if (!_observer) { if (_drag) _dragDirty = true; else _renderPane(fresh); }
    });
  }
  return lines.length ? lines : null;
}

function _tripPins(trip, observer) {
  let pins = collectTripPins(trip, getEventTypes());
  if (observer) pins = pins.filter(p => p.validated).map((p, i) => ({ ...p, num: i + 1 }));
  return pins;
}

// ── Rendu principal ─────────────────────────────────────────────────────────────

/**
 * Affiche la vue d'ensemble du voyage dans #screen-app.
 * opts = { onOpenView(view) } — view : 'packing' | 'money'
 */
export async function renderTripV2(tripId, { observer = false, onOpenView } = {}) {
  _tripId = tripId; _observer = observer; _opts = { onOpenView };
  const trip = getTrip(tripId);
  if (!trip) return;
  const app = document.getElementById('screen-app');
  if (!app) return;

  // Modules utiles (fenêtres existantes) — chargés une fois
  [_mapcal, _journal, _share] = await Promise.all([
    _mapcal || import('./mapcal.js'),
    _journal || import('./journal.js'),
    _share || import('../share.js').catch(() => null),
  ]);
  if (_tripId !== tripId) return;   // un autre voyage a été ouvert entre-temps

  let host = document.getElementById('trip-v2');
  if (!host) { host = document.createElement('div'); host.id = 'trip-v2'; app.prepend(host); }
  app.classList.add('tv2-on');
  host.hidden = false;
  // Fond de page = couleur de la feuille (bande iOS en bas, cf. CLAUDE.md)
  const dark = document.documentElement.dataset.theme === 'dark';
  const bg = observer ? '#05080f' : (dark ? '#14181d' : '#ffffff');
  document.documentElement.style.setProperty('background', bg, 'important');
  document.body.style.setProperty('background', bg, 'important');
  window.scrollTo(0, 0);

  if (observer) _renderObserver(host, trip);
  else _renderOwner(host, trip);

  _bindUpdates();
}

/** Masque la vue d'ensemble (passage à une sous-vue : planning, bagages, budget). */
export function hideTripV2() {
  const host = document.getElementById('trip-v2');
  if (host) host.hidden = true;
  document.getElementById('screen-app')?.classList.remove('tv2-on');
  _closeStory();
}

/** Quitter l'écran voyage. */
export function destroyTripV2() {
  hideTripV2();
  const host = document.getElementById('trip-v2');
  if (host) host.innerHTML = '';
  _sheet?.destroy(); _sheet = null;
  _tripId = null;
}

/** Données du voyage modifiées (réseau ou autre appareil) : rafraîchit sans tout reconstruire. */
export function refreshTripV2(tripId) {
  if (tripId !== _tripId || document.getElementById('trip-v2')?.hidden !== false) return;
  _scheduleRefresh();
}

function _bindUpdates() {
  if (window._tv2UpdatesBound) return;
  window._tv2UpdatesBound = true;
  window.addEventListener('trip-updated', e => {
    if (e.detail?.id === _tripId && document.getElementById('trip-v2')?.hidden === false) _scheduleRefresh();
  });
}

function _scheduleRefresh() {
  // Pas de re-rendu pendant un glissé d'étape (il détruirait la poignée tenue) : après
  if (_drag) { _dragDirty = true; return; }
  cancelAnimationFrame(_refreshRaf);
  _refreshRaf = requestAnimationFrame(() => {
    const trip = getTrip(_tripId);
    if (!trip) return;
    if (_observer) { const host = document.getElementById('trip-v2'); if (host) _renderObserver(host, trip, true); return; }
    _renderPane(trip);
    _pins = _tripPins(trip, false);
    setHomeMapPins(_pins);
    setHomeMapRoute(_routeLines(trip, false));
  });
}

// ── Propriétaire / voyageur ─────────────────────────────────────────────────────

function _renderOwner(host, trip) {
  const st = _st(_tripId);
  const comps = (trip.companions || []).slice(0, 4).map(c =>
    `<span style="background:${_esc(c.color || '#64748b')}">${_esc((c.name || '?').trim().slice(0, 1).toUpperCase())}</span>`).join('');
  const actions = small => `
    <button class="hv2-round${small ? ' hv2-round-light tv2-sm' : ''}" data-tv="settings" title="Réglages du voyage">${ICON.gear}</button>
    <button class="hv2-round${small ? ' hv2-round-light tv2-sm' : ''}" data-tv="packing" title="Bagages">${ICON.bag}</button>
    <button class="hv2-round${small ? ' hv2-round-light tv2-sm' : ''}" data-tv="money" title="Budget & dépenses">${ICON.money}</button>`;

  host.innerHTML = `
    <div class="tv2" id="tv2" data-snap="${st.snap}">
      <div class="tv2-map-slot" id="tv2-map-slot"></div>
      <div class="tv2-dim"></div>
      <div class="tv2-top" id="tv2-top">
        <button class="hv2-round" data-tv="back" title="Retour">${ICON.back}</button>
        <div class="tv2-title">
          ${comps ? `<div class="tv2-title-comps">${comps}</div>` : ''}
          <b>${_esc(trip.name || 'Voyage')}</b>
        </div>
        <div class="tv2-actions">${actions(false)}</div>
      </div>
      <section class="tv2-sheet" id="tv2-sheet">
        <div class="tv2-grab"><span></span></div>
        <div class="tv2-scroll" id="tv2-scroll">
          <div class="tv2-sheet-head">
            <div class="tv2-head-l">
              <button class="hv2-round hv2-round-light tv2-sm" data-tv="back" title="Retour">${ICON.back}</button>
              <button class="hv2-round hv2-round-light tv2-sm" data-tv="collapse" title="Revenir à la carte">${ICON.down}</button>
            </div>
            <div class="tv2-head-r">${actions(true)}</div>
          </div>
          <div class="tv2-pane" id="tv2-pane"></div>
        </div>
      </section>
      <nav class="tv2-nav">
        <div class="tv2-seg" role="tablist">
          <button data-tv="mode" data-mode="plan" class="${st.mode === 'plan' ? 'active' : ''}">Planifier</button>
          <button data-tv="mode" data-mode="follow" class="${st.mode === 'follow' ? 'active' : ''}">Suivre</button>
        </div>
      </nav>
    </div>`;

  const root = host.querySelector('#tv2');
  _renderPane(trip);

  _sheet?.destroy();
  _sheet = createSheet({
    root, sheet: root.querySelector('#tv2-sheet'), scroll: root.querySelector('#tv2-scroll'),
    grab: root.querySelector('.tv2-grab'), top: root.querySelector('#tv2-top'),
    dim: root.querySelector('.tv2-dim'), slot: root.querySelector('#tv2-map-slot'),
    mapExt: MAP_EXT, wide: WIDE, initial: st.snap,
    snaps: () => {
      const H = window.innerHeight;
      const navTop = root.querySelector('.tv2-nav')?.getBoundingClientRect().top || H - 80;
      return { full: 0, mid: Math.round(H * 0.5), peek: Math.max(0, Math.round(navTop - 30)) };
    },
    onSnap: s => { st.snap = s; },
    onSwipe: dir => {
      const next = dir > 0 ? 'follow' : 'plan';
      if (next === st.mode) return false;
      _setMode(next, dir);
      return true;
    },
  });
  _sheet.setSnap(st.snap, false);

  root.addEventListener('click', _onOwnerClick);

  _pins = _tripPins(trip, false);
  attachHomeMap(root.querySelector('#tv2-map-slot'), {
    context: 'trip',
    pins: _pins,
    route: _routeLines(trip, false),
    ...((getSettings().homeMap) || {}),
    padding: _mapPadding(),
    onPinsTap: pins => { if (pins[0]) _onPinTap(pins[0]); },
    onResize: () => _sheet?.refresh(),
    onError: () => notify('Carte indisponible (hors-ligne ?)', '🗺'),
  }).then(() => {
    if (!st.fitted && _tripId === trip.id) { st.fitted = true; fitHomeMap(_mapPadding(), false); }
  });
}

function _mapPadding() {
  const H = window.innerHeight;
  if (WIDE()) return { top: 70, bottom: 20, left: 400, right: 0 };
  if (_observer) return { top: 90 + MAP_EXT, bottom: 250, left: 0, right: 0 };
  const topH = document.getElementById('tv2-top')?.getBoundingClientRect().bottom || 120;
  return { top: Math.min(topH, 160) + MAP_EXT, bottom: Math.max(0, H - Math.round(H * 0.5)), left: 0, right: 0 };
}

function _setMode(mode, dir = 0) {
  const st = _st(_tripId);
  const sc = document.getElementById('tv2-scroll');
  if (sc) st.scroll[st.mode] = sc.scrollTop;
  st.mode = mode;
  document.querySelectorAll('.tv2-seg [data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  const trip = getTrip(_tripId);
  if (!trip) return;
  _renderPane(trip, dir || (mode === 'follow' ? 1 : -1));
}

function _renderPane(trip, enterDir = 0) {
  const pane = document.getElementById('tv2-pane');
  if (!pane) return;
  const st = _st(_tripId);
  _posts = _collectPosts(trip);
  pane.innerHTML = _heroHtml(trip) + (st.mode === 'follow' ? _followHtml(trip) : _planHtml(trip));
  _bindStepDrag(pane);
  pane.style.transition = ''; pane.style.transform = '';
  pane.classList.remove('tv2-in-l', 'tv2-in-r');
  if (enterDir) { void pane.offsetWidth; pane.classList.add(enterDir > 0 ? 'tv2-in-r' : 'tv2-in-l'); }
  const sc = document.getElementById('tv2-scroll');
  if (sc && enterDir) sc.scrollTop = st.scroll[st.mode] || 0;
}

function _heroHtml(trip) {
  const days = _dayCount(trip);
  const items = (trip.days || []).reduce((n, d) => n + (d.items || []).length, 0);
  const countries = new Set();
  (trip.days || []).forEach(d => (d.items || []).forEach(it => { if (it.countryCode) countries.add(it.countryCode.toUpperCase()); }));
  const flags = [...countries].slice(0, 6).map(c => _flagOf(c)).join(' ');
  const today = _todayIso();
  let status = '';
  if (trip.startDate && today < trip.startDate) {
    const n = Math.round((new Date(trip.startDate + 'T12:00:00') - new Date(today + 'T12:00:00')) / 86400000);
    status = `<span class="tv2-chip tv2-chip-soon">Départ dans ${n} jour${n > 1 ? 's' : ''}</span>`;
  } else if (trip.endDate && today <= trip.endDate) {
    const n = Math.round((new Date(today + 'T12:00:00') - new Date(trip.startDate + 'T12:00:00')) / 86400000) + 1;
    status = `<span class="tv2-chip tv2-chip-live">En cours · jour ${n}</span>`;
  } else if (trip.endDate) {
    status = `<span class="tv2-chip">Terminé</span>`;
  }
  const dates = trip.startDate ? `${fmtDate(trip.startDate)}${trip.endDate && trip.endDate !== trip.startDate ? ' → ' + fmtDate(trip.endDate) : ''}` : '';
  const comps = (trip.companions || []).map(c =>
    `<span class="tv2-av" style="background:${_esc(c.color || '#64748b')}" title="${_esc(c.name)}">${_esc((c.name || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase())}</span>`).join('');
  const km = _distanceKm(trip);
  const obs = _observerNames();
  return `
    <div class="tv2-hero">
      <div class="tv2-hero-top">${status}${flags ? `<span class="tv2-flags">${flags}</span>` : ''}</div>
      <h1>${_esc(trip.name || 'Voyage')}</h1>
      ${dates ? `<div class="tv2-hero-dates">${dates}</div>` : ''}
      <div class="tv2-hero-stats">
        <div><b>${days}</b><span>jour${days > 1 ? 's' : ''}</span></div>
        <div><b>${items}</b><span>activité${items > 1 ? 's' : ''}</span></div>
        <div><b>${_posts.length}</b><span>publiée${_posts.length > 1 ? 's' : ''}</span></div>
        ${km ? `<div><b>${km.toLocaleString('fr-FR')}</b><span>km</span></div>` : ''}
      </div>
      ${obs.length ? `<div class="tv2-obsnames" title="Personnes qui suivent ce voyage"><span>👁</span><div><b>${obs.length} observateur${obs.length > 1 ? 's' : ''}</b><small>${_esc(obs.join(', '))}</small></div></div>` : ''}
      ${comps || isTripShared(trip.id) ? `<div class="tv2-hero-comps">${comps}${isTripShared(trip.id) ? '<button class="tv2-btn tv2-btn-sm tv2-hist" data-tv="activity">🕘 Historique</button>' : ''}</div>` : ''}
    </div>`;
}

function _distanceKm(trip) {
  if (!_mapcal) return 0;
  try {
    const wps = _waypoints(trip);
    const m = _pairs(wps).reduce((n, l) => n + _legGeom(l.from, l.to, l.mode).meters, 0);
    return Math.round(m / 1000);
  } catch (_) { return 0; }
}

// ── Planifier ─────────────────────────────────────────────────────────────────

// Tronçons du trajet, calculés sur les mêmes points que la carte (_collectAllWaypoints
// de mapcal.js : étapes géolocalisées + départ/retour de nuit). Chaque tronçon est
// rattaché au point où il ARRIVE — c'est là que mapcal.js lit et écrit son mode.
let _legs = [];
function _collectLegs(trip) {
  _legs = [];
  const byItem = new Map(), departs = new Map(), returns = new Map();
  let wps = [];
  wps = _waypoints(trip);
  for (let i = 1; i < wps.length; i++) {
    const from = wps[i - 1], to = wps[i];
    if (haversineMeters(from, to) < 50) continue;
    const mode = to.mode || 'car';
    const g = _legGeom(from, to, mode);
    const leg = { i: _legs.length, from, to, km: g.meters / 1000, road: !!g.road, mode };
    _legs.push(leg);
    if (to.itemId) byItem.set(to.itemId, leg);
    else if (to.isDepartNight) departs.set(to.dayId, leg);
    else if (to.isReturnNight) returns.set(to.dayId, leg);
  }
  return { byItem, departs, returns };
}

function _legHtml(leg, toLabel = '') {
  if (!leg) return '';
  const km = leg.km < 10 ? leg.km.toFixed(1).replace('.', ',') : Math.round(leg.km).toLocaleString('fr-FR');
  return `<button class="tv2-leg" data-tv="leg" data-leg="${leg.i}" style="--lc:${_esc(trCol(leg.mode))}" title="Changer le moyen de transport">
    <span>${trIc(leg.mode)} ${km} km${toLabel ? ` · ${_esc(toLabel)}` : ''}</span><i>✎</i></button>`;
}

function _openLegModes(legIdx) {
  const leg = _legs[legIdx];
  if (!leg) return;
  const modes = ['car', 'train', 'bus', 'plane', 'ferry', 'foot', 'bike'];
  const km = leg.km < 10 ? leg.km.toFixed(1).replace('.', ',') : Math.round(leg.km).toLocaleString('fr-FR');
  showModal(`
    <div class="hv2-modal-head"><h3>Moyen de transport</h3>
      <button class="hv2-round hv2-round-light" onclick="closeModal()" title="Fermer">✕</button></div>
    <div class="tv2-legmod-route"><b>${_esc(leg.from.label || 'Départ')}</b><span>→</span><b>${_esc(leg.to.label || 'Arrivée')}</b><small>${km} km ${leg.road ? 'par la route' : "à vol d'oiseau"}</small></div>
    <div class="hv2-tiles tv2-modes">${modes.map(m => `
      <button class="hv2-tile${m === leg.mode ? ' active' : ''}" data-mode="${m}"><b>${trIc(m)}</b><span>${_esc(trNm(m))}</span></button>`).join('')}
    </div>`, { boxClass: 'hv2-modal' });
  document.querySelector('.tv2-modes')?.addEventListener('click', e => {
    const b = e.target.closest('[data-mode]');
    if (!b) return;
    closeModal();
    if (b.dataset.mode !== leg.mode) _mapcal?.setWaypointMode(_tripId, leg.to, b.dataset.mode);
  });
}

function _nightCount(item) {
  return Math.max(1, Math.round((new Date(item.dateTo + 'T12:00:00') - new Date(item.dateFrom + 'T12:00:00')) / 86400000) + 1);
}

function _planHtml(trip) {
  const ets = Object.fromEntries(getEventTypes().map(et => [et.key, et]));
  const days = trip.days || [];
  if (!days.length) {
    return `<div class="tv2-empty"><div>🗓</div><b>Aucun jour planifié</b><span>Ajoutez les dates du voyage dans ses réglages, ou un premier jour.</span>
      <button class="tv2-btn" data-tv="add-day">＋ Ajouter un jour</button></div>`;
  }
  const { byItem, departs, returns } = _collectLegs(trip);
  const sleeps = [];
  days.forEach(d => (d.items || []).forEach((it, idx) => { if (it.type === 'sleep' && it.dateFrom && it.dateTo) sleeps.push({ day: d, idx, item: it }); }));
  let num = 0;
  const start = days[0]?.date || trip.startDate;
  const end = days[days.length - 1]?.date || trip.endDate;
  let html = `<div class="tv2-tl">
    <div class="tv2-tl-cap"><i>🏠</i><div><b>Le voyage commence</b>${start ? `<small>${_esc(_longDate(start))}</small>` : ''}</div></div>`;
  for (const day of days) {
    const items = day.items || [];
    const title = customDayTitle(day);
    html += `
      <div class="tv2-day">
        <div class="tv2-day-hd" data-tv="day" data-day-id="${_esc(day.id)}">
          <span class="tv2-day-num">J${day.num}</span>
          <div class="tv2-day-txt"><b>${title ? _esc(title) : `Jour ${day.num}`}</b>${day.date ? `<small>${_esc(_longDate(day.date))}</small>` : ''}</div>
          <button class="tv2-add" data-tv="add-evt" data-day-id="${_esc(day.id)}" title="Ajouter une activité">＋</button>
        </div>`;
    const dep = departs.get(day.id);
    if (dep) html += _legHtml(dep, `🌙 ${dep.to.label || 'Nuit'}`);
    let nightCards = '';
    if (!items.length) {
      html += `<button class="tv2-step-empty" data-tv="add-evt" data-day-id="${_esc(day.id)}">＋ Ajouter une activité</button>`;
    }
    items.forEach((item, idx) => {
      const et = ets[item.type] || {};
      const hasPos = !isNaN(parseFloat(item.lat)) && !isNaN(parseFloat(item.lng));
      if (hasPos) num++;
      if (item.id && byItem.has(item.id)) html += _legHtml(byItem.get(item.id));
      const jd = item.journalData || {};
      const thumb = (jd.photos || [])[0] || item.photo;
      const sub = [];
      if (item.type === 'sleep' && item.dateFrom && item.dateTo) {
        // dateTo = dernière nuit incluse (cf. mapcal.js _isoShift)
        const n = _nightCount(item);
        sub.push(n > 1 ? `Nuit 1/${n}` : '1 nuit');
      } else if (et.label) sub.push(_esc(et.label));
      if (item.time) sub.push(_esc(item.time));
      if (item.gpxStats?.distanceM) sub.push(`🥾 ${(item.gpxStats.distanceM / 1000).toFixed(1).replace('.', ',')} km`);
      if (jd.validated) sub.push('<em>✓ publié</em>');
      // Hébergement : affiché en fin de journée, APRÈS le trajet qui y mène (retour à la nuit)
      const target = item.type === 'sleep' ? 'night' : 'main';
      const dr = item.type !== 'sleep';   // les nuits restent en fin de journée : pas de glissé
      const cardHtml = `
        <button class="tv2-step${dr ? ' tv2-step-dr' : ''}" data-tv="edit-evt" data-day-id="${_esc(day.id)}" data-idx="${idx}">
          <span class="tv2-step-thumb" style="--sc:${_esc(et.color || '#0d9488')}">
            ${thumb ? `<img src="${_esc(thumb)}" alt="" loading="lazy" decoding="async">` : `<i>${et.emoji || '📍'}</i>`}
            ${hasPos ? `<b>${num}</b>` : ''}
          </span>
          <span class="tv2-step-txt"><b>${_esc(item.text || '—')}</b><small>${sub.join(' · ')}</small></span>
          ${dr ? '<span class="tv2-drag" data-drag title="Glisser pour déplacer"><i></i><i></i><i></i></span>' : '<span class="tv2-step-go">›</span>'}
        </button>`;
      if (target === 'night') nightCards += cardHtml; else html += cardHtml;
    });
    // Hébergement sur plusieurs nuits : il réapparaît sur chaque soir couvert
    // (affichage seulement — une seule donnée, ancrée au jour d'arrivée).
    for (const sl of sleeps) {
      if (sl.day.id === day.id || !day.date || !(sl.item.dateFrom <= day.date && day.date <= sl.item.dateTo)) continue;
      const et = ets.sleep || {};
      const k = Math.round((new Date(day.date + 'T12:00:00') - new Date(sl.item.dateFrom + 'T12:00:00')) / 86400000) + 1;
      nightCards += `
        <button class="tv2-step tv2-step-cont" data-tv="edit-evt" data-day-id="${_esc(sl.day.id)}" data-idx="${sl.idx}">
          <span class="tv2-step-thumb" style="--sc:${_esc(et.color || '#7c3aed')}"><i>${et.emoji || '🌙'}</i></span>
          <span class="tv2-step-txt"><b>${_esc(sl.item.text || 'Nuit')}</b><small>Nuit ${k}/${_nightCount(sl.item)}${sl.item.time ? ' · ' + _esc(sl.item.time) : ''}${sl.item.journalData?.validated ? ' · <em>✓ publié</em>' : ''}</small></span>
          <span class="tv2-step-go">›</span>
        </button>`;
    }
    const ret = returns.get(day.id);
    if (ret) html += _legHtml(ret, nightCards ? '' : `🌙 ${ret.to.label || 'Nuit'}`);
    html += nightCards;
    html += `</div>`;
  }
  html += `
    <button class="tv2-addday" data-tv="add-day">＋ Ajouter un jour</button>
    <div class="tv2-tl-cap tv2-tl-end"><i>🏁</i><div><b>Le voyage se termine</b>${end ? `<small>${_esc(_longDate(end))}</small>` : ''}</div></div>
  </div>`;
  return html;
}

function _longDate(iso) {
  try { return new Date(iso + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }); }
  catch (_) { return iso; }
}

// ── Suivre ────────────────────────────────────────────────────────────────────

function _followHtml(trip) {
  const doc = _sharedDoc();
  const ets = Object.fromEntries(getEventTypes().map(et => [et.key, et]));
  let html = '';
  if (_posts.length) {
    html += `<h2 class="tv2-h2">Publications</h2><div class="tv2-posts">`;
    _posts.forEach((p, i) => { html += _postCardHtml(p, i, doc, ets); });
    html += `</div>`;
  }
  // À documenter : activités prévues pas encore publiées
  const todo = [];
  (trip.days || []).forEach(day => (day.items || []).forEach((item, idx) => {
    if (!item.journalData?.validated) todo.push({ day, item, idx });
  }));
  if (todo.length) {
    html += `<h2 class="tv2-h2">À documenter <small>${todo.length}</small></h2><div class="tv2-todo">`;
    todo.slice(0, 60).forEach(({ day, item, idx }) => {
      const et = ets[item.type] || {};
      html += `
        <div class="tv2-todo-row">
          <span class="tv2-todo-ic" style="--sc:${_esc(et.color || '#0d9488')}">${et.emoji || '📍'}</span>
          <span class="tv2-todo-txt"><b>${_esc(item.text || '—')}</b><small>Jour ${day.num}${day.date ? ' · ' + _esc(fmtDate(day.date)) : ''}</small></span>
          <button class="tv2-btn tv2-btn-sm" data-tv="document" data-day-id="${_esc(day.id)}" data-idx="${idx}">Documenter</button>
        </div>`;
    });
    html += `</div>`;
  }
  if (!html) html = `<div class="tv2-empty"><div>📔</div><b>Rien à suivre pour l'instant</b><span>Planifiez des activités, puis documentez-les (photos, notes) pour les publier ici.</span></div>`;
  return html;
}

/** Vignette d'une publication : 1ʳᵉ photo, sinon 1ʳᵉ image de la 1ʳᵉ vidéo. */
function _coverHtml(p) {
  const m = p.media[0];
  if (!m) return '';
  return m.t === 'img'
    ? `<img src="${_esc(m.src)}" alt="" loading="lazy" decoding="async">`
    : `<video src="${_esc(m.src)}#t=0.1" muted playsinline preload="metadata"></video><b class="tv2-play">▶</b>`;
}

function _postCardHtml(p, i, doc, ets) {
  const et = ets[p.item.type] || {};
  const c = _postCounts(p, doc);
  const cover = p.media[0];
  const flag = _flagOf(p.item.countryCode, p.item.countryFlag);
  return `
    <button class="tv2-post" data-tv="story" data-post="${i}">
      <span class="tv2-post-media" style="--sc:${_esc(et.color || '#0d9488')}">
        ${cover ? _coverHtml(p) : `<i>${et.emoji || '📍'}</i>`}
      </span>
      <span class="tv2-post-shade"></span>
      <span class="tv2-post-info">
        <b>${_esc(p.item.text || '—')}</b>
        <small>${flag ? flag + ' ' : ''}${p.day.date ? _esc(fmtDate(p.day.date)) : 'Jour ' + p.day.num}${p.jd.weather ? ' · ' + _esc(p.jd.weather) : ''}</small>
        <span class="tv2-post-meta">
          <span>${ICON.heart.replace('22', '15').replace('22', '15')} ${c.likes}</span>
          <span>${ICON.chat.replace('22', '15').replace('22', '15')} ${c.comments}</span>
          <span>${ICON.photo} ${p.media.length}</span>
        </span>
      </span>
    </button>`;
}

// ── Actions ───────────────────────────────────────────────────────────────────

function _onOwnerClick(e) {
  if (e.target.closest('[data-drag]') || Date.now() - _dragEndAt < 400) return;
  const b = e.target.closest('[data-tv]');
  if (!b) return;
  const tripId = _tripId;
  switch (b.dataset.tv) {
    case 'back':     window.goHome?.(); break;
    case 'collapse': _sheet?.setSnap('mid'); break;
    case 'settings': window._openTripMenu?.(tripId, b); break;
    case 'packing':
    case 'money':    _opts.onOpenView?.(b.dataset.tv); break;
    case 'mode':     if (b.dataset.mode !== _st(tripId).mode) _setMode(b.dataset.mode); break;
    case 'add-evt':  _mapcal?.openAddEventModal(b.dataset.dayId, tripId); break;
    case 'add-day':  _mapcal?.openAddDayModal(tripId); break;
    case 'edit-evt': _mapcal?.openEditEventModal(b.dataset.dayId, +b.dataset.idx, tripId); break;
    case 'document': _journal?.openValidateModal(tripId, b.dataset.dayId, +b.dataset.idx); break;
    case 'story':    _openStory(+b.dataset.post); break;
    case 'leg':      _openLegModes(+b.dataset.leg); break;
    case 'activity': import('./trip.js').then(m => m.openActivityModal(tripId)); break;
    case 'day': {
      const pins = _pins.filter(p => p.dayId === b.dataset.dayId);
      if (pins.length) { if (_sheet?.getSnap() === 'full') _sheet.setSnap('mid'); flyToPin(pins[0]); }
      break;
    }
  }
}

// ── Réordonner les étapes par glissé (v244) ────────────────────────────────────
// Poignée ⋮ à droite de chaque étape (hors hébergements) : on la tient et on glisse,
// dans la même journée ou vers un autre jour. Pointer Events + capture ; la feuille
// ne reçoit pas le geste (touch* arrêtés sur la poignée).
let _drag = null, _dragEndAt = 0, _dragDirty = false;

function _bindStepDrag(pane) {
  if (pane._tv2Drag) return;
  pane._tv2Drag = true;
  const stopTouch = e => { if (_drag || e.target.closest?.('[data-drag]')) e.stopPropagation(); };
  ['touchstart', 'touchmove', 'touchend', 'touchcancel'].forEach(t => pane.addEventListener(t, stopTouch, { passive: true }));
  pane.addEventListener('pointerdown', e => {
    const h = e.target.closest('[data-drag]');
    if (!h || _observer || (e.button != null && e.button > 0)) return;
    const card = h.closest('.tv2-step');
    if (!card) return;
    e.preventDefault(); e.stopPropagation();
    try { h.setPointerCapture(e.pointerId); } catch (_) {}
    const r = card.getBoundingClientRect();
    const ghost = card.cloneNode(true);
    ghost.classList.add('tv2-drag-ghost');
    Object.assign(ghost.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    document.documentElement.appendChild(ghost);
    const ind = document.createElement('div');
    ind.className = 'tv2-drop-ind';
    document.documentElement.appendChild(ind);
    card.classList.add('tv2-dragging');
    document.getElementById('tv2')?.classList.add('tv2-reorder');
    _drag = { h, card, ghost, ind, y0: e.clientY, top0: r.top, y: e.clientY, raf: 0, scrollRaf: 0, target: null,
      fromDay: card.dataset.dayId, fromIdx: +card.dataset.idx,
      fromId: getTrip(_tripId)?.days?.find(x => x.id === card.dataset.dayId)?.items?.[+card.dataset.idx]?.id || null };
    navigator.vibrate?.(8);
    const move = ev => { if (!_drag) return; _drag.y = ev.clientY; if (!_drag.raf) _drag.raf = requestAnimationFrame(_dragFrame); };
    const up = ev => {
      h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up);
      h.removeEventListener('pointercancel', up); h.removeEventListener('lostpointercapture', up);
      // Geste interrompu (appel, geste système…) : on annule au lieu de déposer
      _dragDrop(ev.type !== 'pointerup');
    };
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', up);
    h.addEventListener('pointercancel', up);
    h.addEventListener('lostpointercapture', up);
    _dragFrame();
    _dragAutoScroll();
  });
}

function _dragFrame() {
  const d = _drag;
  if (!d) return;
  d.raf = 0;
  d.ghost.style.transform = `translate3d(0,${d.y - d.y0}px,0) scale(1.02)`;
  // Jour sous le doigt (le plus proche verticalement)
  const days = [...document.querySelectorAll('#tv2-pane .tv2-day')];
  let day = null, best = Infinity;
  for (const el of days) {
    const r = el.getBoundingClientRect();
    const dist = d.y < r.top ? r.top - d.y : d.y > r.bottom ? d.y - r.bottom : 0;
    if (dist < best) { best = dist; day = el; }
  }
  if (!day) return;
  const cards = [...day.querySelectorAll('.tv2-step-dr')].filter(c => c !== d.card);
  let pos = 0;
  for (const c of cards) { const r = c.getBoundingClientRect(); if (d.y > r.top + r.height / 2) pos++; }
  const dayId = day.querySelector('.tv2-day-hd')?.dataset.dayId;
  // Ligne d'insertion
  let lineY;
  if (cards.length === 0) lineY = day.querySelector('.tv2-day-hd').getBoundingClientRect().bottom + 6;
  else if (pos < cards.length) lineY = cards[pos].getBoundingClientRect().top - 4;
  else lineY = cards[cards.length - 1].getBoundingClientRect().bottom + 4;
  const pr = document.getElementById('tv2-pane').getBoundingClientRect();
  Object.assign(d.ind.style, { top: lineY + 'px', left: (pr.left + 16) + 'px', width: (pr.width - 32) + 'px' });
  d.target = { dayId, pos };
}

function _dragAutoScroll() {
  const d = _drag;
  if (!d) return;
  const sc = document.getElementById('tv2-scroll');
  if (sc && sc.scrollHeight > sc.clientHeight + 2) {
    const r = sc.getBoundingClientRect();
    const edge = 70;
    // Bas de la zone VISIBLE (en cran « mid » la liste dépasse sous l'écran)
    const navTop = document.querySelector('.tv2-nav')?.getBoundingClientRect().top || window.innerHeight;
    const bottom = Math.min(r.bottom, navTop);
    let v = 0;
    if (d.y < r.top + edge) v = -Math.ceil((r.top + edge - d.y) / 6);
    else if (d.y > bottom - edge) v = Math.ceil((d.y - (bottom - edge)) / 6);
    if (v) { sc.scrollTop += v; _dragFrame(); }
  }
  d.scrollRaf = requestAnimationFrame(_dragAutoScroll);
}

function _dragDrop(cancel = false) {
  const d = _drag;
  if (!d) return;
  _drag = null;
  const dirty = _dragDirty; _dragDirty = false;
  _dragEndAt = Date.now();
  cancelAnimationFrame(d.raf); cancelAnimationFrame(d.scrollRaf);
  d.ghost.remove(); d.ind.remove();
  d.card.classList.remove('tv2-dragging');
  document.getElementById('tv2')?.classList.remove('tv2-reorder');
  if (!cancel && d.target && _moveStep(d.fromDay, d.fromIdx, d.target.dayId, d.target.pos, d.fromId)) return;
  if (dirty) _scheduleRefresh();   // une mise à jour est arrivée pendant le glissé
}

// pos = rang parmi les étapes « glissables » (hors nuits) du jour d'arrivée, étape déplacée exclue
// → true si le voyage a été modifié (le rafraîchissement suit via « trip-updated »)
function _moveStep(fromDayId, fromIdx, toDayId, pos, fromId = null) {
  const trip = getTrip(_tripId);
  if (!trip) return false;
  // Copie des jours (jamais l'objet du store) ; étape retrouvée par son id
  const days = (trip.days || []).map(d => ({ ...d, items: [...(d.items || [])] }));
  const src = days.find(d => d.id === fromDayId), dst = days.find(d => d.id === toDayId);
  if (fromId && src) fromIdx = src.items.findIndex(it => it.id === fromId);
  if (!src || !dst || !src.items?.[fromIdx]) return false;
  const srcItems = [...src.items];
  const [moved] = srcItems.splice(fromIdx, 1);
  const dstItems = src === dst ? srcItems : [...(dst.items || [])];
  const movable = dstItems.map((it, i) => ({ it, i })).filter(o => o.it.type !== 'sleep');
  let at;
  if (pos < movable.length) at = movable[pos].i;
  else at = movable.length ? movable[movable.length - 1].i + 1 : dstItems.filter(it => it.type !== 'sleep').length;
  if (movable.length === 0) {
    // jour sans étape glissable : avant le premier hébergement
    const firstSleep = dstItems.findIndex(it => it.type === 'sleep');
    at = firstSleep >= 0 ? firstSleep : dstItems.length;
  }
  dstItems.splice(at, 0, moved);
  if (src === dst) {
    if (dstItems.every((it, i) => it === src.items[i])) return false;   // rien n'a bougé
    src.items = dstItems;
  } else {
    src.items = srcItems; dst.items = dstItems;
  }
  updateTrip(_tripId, { days });
  notify(src === dst ? 'Étape déplacée' : `Étape déplacée au jour ${dst.num}`, '↕️');
  return true;
}

function _onPinTap(pin) {
  const st = _st(_tripId);
  if (st.mode === 'follow' || _observer) {
    const i = _posts.findIndex(p => p.item.id === pin.id);
    if (i >= 0) { _openStory(i); return; }
  }
  if (!_observer && pin.dayId != null) _mapcal?.openEditEventModal(pin.dayId, pin.itemIdx, _tripId);
}

// ── Observateur ───────────────────────────────────────────────────────────────

// Curseur de jours de la vue observateur (v241) : une poignée « Jour 1 » qu'on fait
// glisser vers la droite → « Jour 2 », « Jour 3 »… (du 1er jour au dernier jour publié).
// Chaque jour mène à sa 1ʳᵉ publication (ou la suivante s'il n'y en a pas ce jour-là).
let _obsDays = [];
let _bindDaySlider = null;   // posé par _renderObserver (rebranche le curseur après un rafraîchissement)
function _daysSliderHtml(trip) {
  _obsDays = [];
  if (!_posts.length) return `<div class="tv2-dsl tv2-dsl-empty"><div class="tv2-dsl-knob"><b>À venir</b></div></div>`;
  const days = trip.days || [];
  const lastIdx = Math.max(...(_posts.map(p => days.findIndex(d => d.id === p.day.id))));
  // Un hébergement publié compte pour toutes ses nuits (un seul événement, publié une fois)
  const covers = (p, d) => p.day.id === d.id ||
    (p.item.type === 'sleep' && d.date && p.item.dateFrom && p.item.dateTo && p.item.dateFrom <= d.date && d.date <= p.item.dateTo);
  const lastCovered = Math.max(lastIdx, ...days.map((d, i) => _posts.some(p => covers(p, d)) ? i : -1));
  for (let i = 0; i <= lastCovered; i++) {
    const d = days[i];
    let post = _posts.findIndex(p => p.day.id === d.id);
    if (post < 0) post = _posts.findIndex(p => covers(p, d));
    if (post < 0) post = _posts.findIndex(p => days.findIndex(x => x.id === p.day.id) >= i);
    if (post < 0) post = _posts.length - 1;
    _obsDays.push({ num: d.num, date: d.date, post, has: _posts.some(p => covers(p, d)) });
  }
  const n = _obsDays.length;
  return `
    <div class="tv2-dsl${n < 2 ? ' tv2-dsl-one' : ''}" id="tv2-dsl">
      <div class="tv2-dsl-track">${_obsDays.map((d, i) => `<i class="tv2-dsl-tick${d.has ? ' has' : ''}" style="left:${n > 1 ? (i / (n - 1)) * 100 : 50}%"></i>`).join('')}</div>
      <div class="tv2-dsl-knob" id="tv2-dsl-knob"><b>Jour ${_obsDays[0].num}</b><small>${_dslDate(_obsDays[0])}</small></div>
    </div>`;
}
function _dslDate(d) {
  if (!d?.date) return d && !d.has ? 'rien de publié' : '';
  const s = new Date(d.date + 'T12:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  return d.has ? s : `${s} · rien de publié`;
}

function _renderObserver(host, trip, isRefresh = false) {
  _posts = _collectPosts(trip);
  const doc = _sharedDoc();
  const ets = Object.fromEntries(getEventTypes().map(et => [et.key, et]));
  const owners = doc ? Object.values(doc.members || {}).filter(m => m.role === 'owner' || m.role === 'member').map(m => m.companionName).filter(Boolean) : [];
  const cards = _posts.map((p, i) => {
    const et = ets[p.item.type] || {};
    const c = _postCounts(p, doc);
    const flag = _flagOf(p.item.countryCode, p.item.countryFlag);
    return `
      <button class="tv2-ocard" data-tv="story" data-post="${i}" data-day-num="${p.day.num}">
        <span class="tv2-post-media" style="--sc:${_esc(et.color || '#0d9488')}">${p.media[0] ? _coverHtml(p) : `<i>${et.emoji || '📍'}</i>`}</span>
        <span class="tv2-post-shade"></span>
        ${flag ? `<span class="tv2-ocard-flag">${flag}</span>` : ''}
        <span class="tv2-post-info"><b>${_esc(p.item.text || '—')}</b>
          <span class="tv2-post-meta"><span>${ICON.heart.replace('22', '15').replace('22', '15')} ${c.likes}</span><span>${ICON.chat.replace('22', '15').replace('22', '15')} ${c.comments}</span><span>${ICON.photo} ${p.media.length}</span></span>
        </span>
      </button>`;
  }).join('');
  // 1ʳᵉ carte = couverture du voyage (sa photo, v244)
  const startCard = `
    <div class="tv2-ocard tv2-ocard-start${trip.photo ? ' tv2-ocard-cover' : ''}">
      ${trip.photo ? `<img class="tv2-ocard-bg" src="${_esc(trip.photo)}" alt="" decoding="async"><span class="tv2-post-shade"></span>` : '<i>🏠</i>'}
      <b>${trip.photo ? _esc(trip.name || 'Voyage') : `Voyage ${trip.startDate && trip.startDate > _todayIso() ? 'prévu' : 'entamé'}`}</b>
      <small>${trip.startDate ? _esc(fmtDate(trip.startDate)) : ''}</small>
    </div>`;

  if (isRefresh && host.querySelector('#tv2')) {
    const car = host.querySelector('.tv2-carousel');
    if (car) car.innerHTML = startCard + (cards || `<div class="tv2-ocard tv2-ocard-start"><i>📡</i><b>En attente de publications…</b><small>Les voyageurs publieront leurs étapes au fil du voyage</small></div>`);
    const sl = host.querySelector('.tv2-dsl');
    if (sl) { sl.outerHTML = _daysSliderHtml(trip); _bindDaySlider?.(); }
    _pins = _tripPins(trip, true); setHomeMapPins(_pins); setHomeMapRoute(_routeLines(trip, true));
    return;
  }

  host.innerHTML = `
    <div class="tv2 tv2-obs" id="tv2">
      <div class="tv2-map-slot tv2-map-fixed" id="tv2-map-slot"></div>
      <div class="tv2-top" id="tv2-top">
        <button class="hv2-round" data-tv="back" title="Retour">${ICON.back}</button>
        <div class="tv2-title">
          ${owners.length ? `<small>${_esc(owners.join(', '))}</small>` : ''}
          <b>${_esc(trip.name || 'Voyage')} ${_esc(trip.flag && trip.flag !== '🌍' ? trip.flag : '')}</b>
        </div>
        <div class="tv2-actions"><button class="hv2-round" data-tv="obs-menu" title="Options">${ICON.menu}</button></div>
      </div>
      <div class="tv2-obs-bottom">
        ${_daysSliderHtml(trip)}
        <div class="tv2-carousel">${startCard}${cards || `<div class="tv2-ocard tv2-ocard-start"><i>📡</i><b>En attente de publications…</b><small>Les voyageurs publieront leurs étapes au fil du voyage</small></div>`}</div>
      </div>
    </div>`;
  const root = host.querySelector('#tv2');
  root.addEventListener('click', e => {
    const b = e.target.closest('[data-tv]');
    if (!b) return;
    if (b.dataset.tv === 'back') window.goHome?.();
    else if (b.dataset.tv === 'story') _openStory(+b.dataset.post);
    else if (b.dataset.tv === 'obs-menu') _openObserverMenu();
  });
  // Défiler le carrousel recentre la carte sur l'étape affichée et le curseur de jours
  const car = root.querySelector('.tv2-carousel');
  let t = 0, progCar = 0, curDay = 0;
  const goToPost = idx => {
    const el = car.querySelector(`.tv2-ocard[data-post="${idx}"]`);
    if (!el) return;
    progCar = Date.now();
    car.scrollTo({ left: el.offsetLeft + el.offsetWidth / 2 - car.clientWidth / 2, behavior: 'smooth' });
    const post = _posts[idx];
    const pin = post && _pins.find(p => p.id === post.item.id);
    if (pin) flyToPin(pin);
  };
  // Curseur : la poignée suit le doigt, le jour change dès qu'on passe un cran
  const placeKnob = (frac, animate) => {
    const sl = root.querySelector('#tv2-dsl'), knob = root.querySelector('#tv2-dsl-knob');
    if (!sl || !knob) return;
    const w = sl.clientWidth - knob.offsetWidth;
    knob.style.transition = animate ? 'transform .28s cubic-bezier(.22,.7,.25,1)' : 'none';
    knob.style.transform = `translate3d(${Math.max(0, Math.min(1, frac)) * w}px,0,0)`;
  };
  const setDay = (i, { go = false, animate = true, place = true } = {}) => {
    const n = _obsDays.length;
    if (!n) return;
    i = Math.max(0, Math.min(n - 1, i));
    const knob = root.querySelector('#tv2-dsl-knob');
    if (knob && i !== curDay) {
      knob.innerHTML = `<b>Jour ${_obsDays[i].num}</b><small>${_dslDate(_obsDays[i])}</small>`;
      knob.classList.remove('tv2-dsl-bump'); void knob.offsetWidth; knob.classList.add('tv2-dsl-bump');
    }
    const changed = i !== curDay;
    curDay = i;
    if (place) placeKnob(n > 1 ? i / (n - 1) : 0.5, animate);
    if (go && changed) goToPost(_obsDays[i].post);
  };
  _bindDaySlider = () => {
    const sl = root.querySelector('#tv2-dsl');
    curDay = 0;
    if (!sl || _obsDays.length < 2) { placeKnob(0.5, false); return; }
    placeKnob(0, false);
    let drag = null;
    const fracAt = x => {
      const knob = root.querySelector('#tv2-dsl-knob');
      const r = sl.getBoundingClientRect(), kw = knob.offsetWidth;
      return (x - r.left - kw / 2) / Math.max(1, r.width - kw);
    };
    sl.addEventListener('pointerdown', e => {
      drag = { id: e.pointerId };
      sl.setPointerCapture(e.pointerId);
      sl.classList.add('drag');
      const f = fracAt(e.clientX);
      placeKnob(f, false);
      setDay(Math.round(f * (_obsDays.length - 1)), { go: true, place: false });
    });
    sl.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.id) return;
      const f = fracAt(e.clientX);
      placeKnob(f, false);
      setDay(Math.round(f * (_obsDays.length - 1)), { go: true, place: false });
    });
    const end = e => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null;
      sl.classList.remove('drag');
      setDay(curDay, { animate: true });   // la poignée se cale sur le jour choisi
    };
    sl.addEventListener('pointerup', end);
    sl.addEventListener('pointercancel', end);
  };
  _bindDaySlider();
  car.addEventListener('scroll', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      const cardsEls = [...car.querySelectorAll('.tv2-ocard[data-post]')];
      const mid = car.scrollLeft + car.clientWidth / 2;
      let best = null, bd = Infinity;
      cardsEls.forEach(el => { const d = Math.abs(el.offsetLeft + el.offsetWidth / 2 - mid); if (d < bd) { bd = d; best = el; } });
      if (!best) return;
      const post = _posts[+best.dataset.post];
      if (Date.now() - progCar < 700) return;   // défilement provoqué par le curseur
      const di = _obsDays.findIndex(d => d.num === post?.day.num);
      if (di >= 0 && di !== curDay) setDay(di);
      const pin = post && _pins.find(p => p.id === post.item.id);
      if (pin) flyToPin(pin);
    }, 160);
  }, { passive: true });

  _pins = _tripPins(trip, true);
  attachHomeMap(root.querySelector('#tv2-map-slot'), {
    context: 'trip', pins: _pins, route: _routeLines(trip, true),
    ...((getSettings().homeMap) || {}),
    padding: _mapPadding(),
    onPinsTap: pins => { if (pins[0]) _onPinTap(pins[0]); },
    onError: () => notify('Carte indisponible (hors-ligne ?)', '🗺'),
  }).then(() => {
    // l'observateur a pu revenir à l'accueil avant le chargement de la carte
    if (_tripId !== trip.id || !_observer) return;
    setHomeMapPadding(_mapPadding()); fitHomeMap(_mapPadding(), false);
  });
}

function _openObserverMenu() {
  import('../utils.js').then(({ showModal, closeModal }) => {
    showModal(`
      <div class="hv2-modal-head"><h3>Voyage observé</h3>
        <button class="hv2-round hv2-round-light" onclick="closeModal()" title="Fermer">✕</button></div>
      <div class="hv2-card-group">
        <button class="hv2-row hv2-row-btn hv2-row-danger" id="tv2-leave"><span>Quitter ce voyage</span><i>›</i></button>
      </div>`, { boxClass: 'hv2-modal' });
    document.getElementById('tv2-leave')?.addEventListener('click', async () => {
      if (!confirm('Quitter ce voyage partagé ? Vous ne recevrez plus ses mises à jour.')) return;
      closeModal();
      try {
        const { leaveSharedTrip } = await import('../share.js');
        const { deleteTrip } = await import('../store.js');
        await leaveSharedTrip(_tripId);
        deleteTrip(_tripId);
      } catch (_) {}
      window.goHome?.();
    });
  });
}

// ── Visionneuse plein écran (publication) ─────────────────────────────────────

let _story = null;   // { el, post, photo, savedBg }

function _openStory(postIdx) {
  if (!_posts[postIdx]) return;
  _closeStory();
  const el = document.createElement('div');
  el.className = 'tv2-story';
  // Rattachée à <html> et non à body (cf. CLAUDE.md : bande iOS / découpe)
  document.documentElement.appendChild(el);
  const savedBg = document.documentElement.style.getPropertyValue('background');
  document.documentElement.style.setProperty('background', '#000', 'important');
  document.body.style.setProperty('background', '#000', 'important');
  _story = { el, post: postIdx, photo: 0, savedBg };
  _renderStory();
  requestAnimationFrame(() => el.classList.add('open'));

  el.addEventListener('click', e => {
    const b = e.target.closest('[data-st]');
    if (!b) return;
    const post = _posts[_story.post];
    switch (b.dataset.st) {
      case 'close': _closeStory(); break;
      case 'prev':  _storyStep(-1); break;
      case 'next':  _storyStep(1); break;
      case 'like':
        if (_share?.addObserverReaction && isTripShared(_tripId)) {
          _share.addObserverReaction(_tripId, post.item.id).then(() => _renderStory()).catch(() => {});
          setTimeout(() => _story && _renderStory(), 60);
        } else notify('Les réactions sont disponibles sur les voyages partagés', 'ℹ️');
        break;
      case 'comment':
        if (isTripShared(_tripId)) _journal?.openCommentsModal(_tripId, post.item.id, post.item.text || '');
        else notify('Les commentaires sont disponibles sur les voyages partagés', 'ℹ️');
        break;
      case 'share': {
        const trip = getTrip(_tripId);
        _journal?.shareJournalItem({
          tripName: trip?.name || 'Mon voyage',
          dayLabel: `Jour ${post.day.num}${customDayTitle(post.day) ? ' · ' + customDayTitle(post.day) : ''}`,
          itemLabel: `${_journal.eventTypeIcon?.(post.item.type) || ''} ${post.item.text || 'Activité'}`,
          notes: post.jd.notes || '', weather: post.jd.weather || '', photos: post.jd.photos || [],
        });
        break;
      }
      case 'edit': _closeStory(); _journal?.openValidateModal(_tripId, post.day.id, post.idx); break;
    }
  });
  // Glisser vers le bas pour fermer
  let y0 = null, x0 = 0;
  el.addEventListener('touchstart', e => { y0 = e.touches[0].clientY; x0 = e.touches[0].clientX; }, { passive: true });
  el.addEventListener('touchmove', e => {
    if (y0 == null) return;
    const dy = e.touches[0].clientY - y0;
    if (dy > 0 && Math.abs(dy) > Math.abs(e.touches[0].clientX - x0)) el.querySelector('.tv2-story-card').style.transform = `translate3d(0,${dy}px,0) scale(${Math.max(.9, 1 - dy / 2000)})`;
  }, { passive: true });
  el.addEventListener('touchend', e => {
    if (y0 == null) return;
    const dy = (e.changedTouches[0]?.clientY ?? y0) - y0; y0 = null;
    const card = el.querySelector('.tv2-story-card');
    if (dy > 110) _closeStory();
    else if (card) { card.style.transition = 'transform .22s ease'; card.style.transform = ''; setTimeout(() => { if (card) card.style.transition = ''; }, 240); }
  });
  document.addEventListener('keydown', _storyKeys);
}

function _storyKeys(e) {
  if (!_story) return;
  if (e.key === 'Escape') _closeStory();
  else if (e.key === 'ArrowRight') _storyStep(1);
  else if (e.key === 'ArrowLeft') _storyStep(-1);
}

function _storyStep(dir) {
  if (!_story) return;
  const post = _posts[_story.post];
  const n = Math.max(1, post.media.length);
  const next = _story.photo + dir;
  if (next >= 0 && next < n) { _story.photo = next; }
  else if (dir > 0 && _story.post < _posts.length - 1) { _story.post++; _story.photo = 0; }
  else if (dir < 0 && _story.post > 0) { _story.post--; _story.photo = Math.max(0, _posts[_story.post].media.length - 1); }
  else if (dir > 0) { _closeStory(); return; }
  _renderStory();
}

function _renderStory() {
  if (!_story) return;
  const post = _posts[_story.post];
  if (!post) { _closeStory(); return; }
  const ets = Object.fromEntries(getEventTypes().map(et => [et.key, et]));
  const et = ets[post.item.type] || {};
  const doc = _sharedDoc();
  const c = _postCounts(post, doc);
  const n = Math.max(1, post.media.length);
  const m = post.media[_story.photo];
  const code = post.item.countryCode;
  const flag = _flagOf(code, post.item.countryFlag);
  const country = _countryName(code);
  const date = post.day.date ? new Date(post.day.date + 'T12:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }) : `Jour ${post.day.num}`;
  const meta = [country ? `${flag} ${country.toUpperCase()}` : flag, date.toUpperCase(), post.jd.weather ? _esc(post.jd.weather) : ''].filter(Boolean).join(' · ');
  _story.el.innerHTML = `
    <div class="tv2-story-card${m?.t === 'vid' ? ' tv2-story-isvid' : ''}">
      <div class="tv2-story-media" style="--sc:${_esc(et.color || '#0d9488')}">
        ${!m ? `<i>${et.emoji || '📍'}</i>`
          // Photo entière (paysage ou portrait) sur un fond flou de la même photo, au lieu
          // d'un recadrage plein écran qui coupait une grande partie des photos en paysage.
          : m.t === 'img' ? `<img class="tv2-story-bg" src="${_esc(m.src)}" alt="" aria-hidden="true"><img class="tv2-story-img" src="${_esc(m.src)}" alt="">`
          : `<video class="tv2-story-img" src="${_esc(m.src)}" autoplay muted playsinline loop controls preload="auto"></video>`}
      </div>
      <div class="tv2-story-shade"></div>
      <div class="tv2-story-bars">${Array.from({ length: n }, (_, i) => `<span class="${i < _story.photo ? 'done' : i === _story.photo ? 'cur' : ''}"></span>`).join('')}</div>
      <button class="tv2-story-close" data-st="close" title="Fermer">${ICON.close}</button>
      <button class="tv2-story-zone tv2-story-prev" data-st="prev" aria-label="Précédent"></button>
      <button class="tv2-story-zone tv2-story-next" data-st="next" aria-label="Suivant"></button>
      <div class="tv2-story-info">
        <h2>${_esc(post.item.text || '—')}</h2>
        <div class="tv2-story-meta">${meta}</div>
        ${post.jd.notes ? `<p>${_esc(post.jd.notes).replace(/\n/g, '<br>')}</p>` : ''}
        <div class="tv2-story-actions">
          <button data-st="like" class="${c.mine ? 'on' : ''}">${ICON.heart}${c.likes ? `<small>${c.likes}</small>` : ''}</button>
          <button data-st="comment">${ICON.chat}${c.comments ? `<small>${c.comments}</small>` : ''}</button>
          <button data-st="share">${ICON.share}</button>
          ${!_observer ? `<button data-st="edit" title="Modifier">${ICON.dots}</button>` : ''}
        </div>
      </div>
    </div>`;
}

function _closeStory() {
  if (!_story) return;
  const { el, savedBg } = _story;
  _story = null;
  document.removeEventListener('keydown', _storyKeys);
  el.classList.remove('open');
  setTimeout(() => el.remove(), 220);
  if (savedBg) {
    document.documentElement.style.setProperty('background', savedBg, 'important');
    document.body.style.setProperty('background', savedBg, 'important');
  }
}
