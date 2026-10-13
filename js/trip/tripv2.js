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

import { getTrip, getEventTypes, getSettings, isTripShared } from '../store.js';
import { fmtDate, customDayTitle, trIc, trNm, trCol, notify, showModal, closeModal } from '../utils.js';
import { attachHomeMap, setHomeMapPins, setHomeMapRoute, setHomeMapPadding, fitHomeMap, flyToPin, collectTripPins } from '../homemap.js';
import { createSheet } from '../sheet.js';
import { haversineMeters } from '../gpx.js';
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
  cal:   '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="16.5" rx="2.5"/><path d="M16 2.5v4M8 2.5v4M3 10h18"/></svg>',
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
      posts.push({ day, item, idx, jd, photos: (jd.photos || []).filter(Boolean), id: item.id || `${day.id}_${idx}` });
    });
  });
  return posts;
}

function _sharedDoc() {
  try { return isTripShared(_tripId) ? _share?.getSharedDocData?.(_tripId) : null; } catch (_) { return null; }
}

function _postCounts(post, doc) {
  if (!doc) return { likes: 0, comments: 0, mine: false };
  const r = doc.reactions?.[post.item.id] || {};
  const uid = getCurrentUser()?.uid;
  const likes = Object.values(r).filter(e => e === '❤️').length;
  const comments = Object.values(doc.observerComments || {}).filter(c => c.itemId === post.item.id).length;
  return { likes, comments, mine: !!(uid && r[uid] === '❤️') };
}

function _routeLines(trip, observer) {
  if (!_mapcal) return null;
  let wps = [];
  try { wps = _mapcal.collectTripWaypoints(trip) || []; } catch (_) { return null; }
  if (observer) {
    // Observateur : seulement ce qui a été publié (ne pas dévoiler l'itinéraire prévu)
    const pub = new Set(_collectPosts(trip).map(p => p.item.id));
    wps = wps.filter(w => w.itemId && pub.has(w.itemId));
  }
  const line = wps.map(w => [Number(w.lng), Number(w.lat)]).filter(c => !isNaN(c[0]) && !isNaN(c[1]));
  return line.length > 1 ? [line] : null;
}

function _tripPins(trip, observer) {
  let pins = collectTripPins(trip, getEventTypes());
  if (observer) pins = pins.filter(p => p.validated).map((p, i) => ({ ...p, num: i + 1 }));
  return pins;
}

// ── Rendu principal ─────────────────────────────────────────────────────────────

/**
 * Affiche la vue d'ensemble du voyage dans #screen-app.
 * opts = { onOpenView(view) } — view : 'events' | 'packing' | 'money'
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
  if (observer) { try { _journal.ackJournalSeen?.(tripId); } catch (_) {} }
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
    <button class="hv2-round${small ? ' hv2-round-light tv2-sm' : ''}" data-tv="events" title="Planning détaillé">${ICON.cal}</button>
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
  const today = new Date().toISOString().slice(0, 10);
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
      ${comps || isTripShared(trip.id) ? `<div class="tv2-hero-comps">${comps}${isTripShared(trip.id) ? '<button class="tv2-btn tv2-btn-sm tv2-hist" data-tv="activity">🕘 Historique</button>' : ''}</div>` : ''}
    </div>`;
}

function _distanceKm(trip) {
  if (!_mapcal) return 0;
  try {
    const wps = _mapcal.collectTripWaypoints(trip) || [];
    let m = 0;
    for (let i = 1; i < wps.length; i++) m += haversineMeters(wps[i - 1], wps[i]);
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
  try { wps = _mapcal?.collectTripWaypoints(trip) || []; } catch (_) {}
  for (let i = 1; i < wps.length; i++) {
    const from = wps[i - 1], to = wps[i];
    const km = haversineMeters(from, to) / 1000;
    if (km < 0.05) continue;
    const leg = { i: _legs.length, from, to, km, mode: to.mode || 'car' };
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
    <div class="tv2-legmod-route"><b>${_esc(leg.from.label || 'Départ')}</b><span>→</span><b>${_esc(leg.to.label || 'Arrivée')}</b><small>${km} km à vol d'oiseau</small></div>
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

function _planHtml(trip) {
  const ets = Object.fromEntries(getEventTypes().map(et => [et.key, et]));
  const days = trip.days || [];
  if (!days.length) {
    return `<div class="tv2-empty"><div>🗓</div><b>Aucun jour planifié</b><span>Ajoutez les dates du voyage dans ses réglages, ou un premier jour.</span>
      <button class="tv2-btn" data-tv="add-day">＋ Ajouter un jour</button></div>`;
  }
  const { byItem, departs, returns } = _collectLegs(trip);
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
        const n = Math.max(1, Math.round((new Date(item.dateTo + 'T12:00:00') - new Date(item.dateFrom + 'T12:00:00')) / 86400000));
        sub.push(`${n} nuit${n > 1 ? 's' : ''}`);
      } else if (et.label) sub.push(_esc(et.label));
      if (item.time) sub.push(_esc(item.time));
      if (jd.validated) sub.push('<em>✓ publié</em>');
      html += `
        <button class="tv2-step" data-tv="edit-evt" data-day-id="${_esc(day.id)}" data-idx="${idx}">
          <span class="tv2-step-thumb" style="--sc:${_esc(et.color || '#0d9488')}">
            ${thumb ? `<img src="${_esc(thumb)}" alt="" loading="lazy" decoding="async">` : `<i>${et.emoji || '📍'}</i>`}
            ${hasPos ? `<b>${num}</b>` : ''}
          </span>
          <span class="tv2-step-txt"><b>${_esc(item.text || '—')}</b><small>${sub.join(' · ')}</small></span>
          <span class="tv2-step-go">›</span>
        </button>`;
    });
    const ret = returns.get(day.id);
    if (ret) html += _legHtml(ret, `🌙 ${ret.to.label || 'Nuit'}`);
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

function _postCardHtml(p, i, doc, ets) {
  const et = ets[p.item.type] || {};
  const c = _postCounts(p, doc);
  const cover = p.photos[0];
  const flag = _flagOf(p.item.countryCode, p.item.countryFlag);
  return `
    <button class="tv2-post" data-tv="story" data-post="${i}">
      <span class="tv2-post-media" style="--sc:${_esc(et.color || '#0d9488')}">
        ${cover ? `<img src="${_esc(cover)}" alt="" loading="lazy" decoding="async">` : `<i>${et.emoji || '📍'}</i>`}
      </span>
      <span class="tv2-post-shade"></span>
      <span class="tv2-post-info">
        <b>${_esc(p.item.text || '—')}</b>
        <small>${flag ? flag + ' ' : ''}${p.day.date ? _esc(fmtDate(p.day.date)) : 'Jour ' + p.day.num}${p.jd.weather ? ' · ' + _esc(p.jd.weather) : ''}</small>
        <span class="tv2-post-meta">
          <span>${ICON.heart.replace('22', '15').replace('22', '15')} ${c.likes}</span>
          <span>${ICON.chat.replace('22', '15').replace('22', '15')} ${c.comments}</span>
          <span>${ICON.photo} ${p.photos.length}</span>
        </span>
      </span>
    </button>`;
}

// ── Actions ───────────────────────────────────────────────────────────────────

function _onOwnerClick(e) {
  const b = e.target.closest('[data-tv]');
  if (!b) return;
  const tripId = _tripId;
  switch (b.dataset.tv) {
    case 'back':     window.goHome?.(); break;
    case 'collapse': _sheet?.setSnap('mid'); break;
    case 'settings': window._openTripMenu?.(tripId, b); break;
    case 'events':
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

function _onPinTap(pin) {
  const st = _st(_tripId);
  if (st.mode === 'follow' || _observer) {
    const i = _posts.findIndex(p => p.item.id === pin.id);
    if (i >= 0) { _openStory(i); return; }
  }
  if (!_observer && pin.dayId != null) _mapcal?.openEditEventModal(pin.dayId, pin.itemIdx, _tripId);
}

// ── Observateur ───────────────────────────────────────────────────────────────

// Sélecteur de jours de la vue observateur : une pastille par jour publié, qu'on fait
// glisser à gauche/droite (le jour centré devient le jour affiché) ou qu'on touche.
function _daysStripHtml() {
  if (!_posts.length) return `<div class="tv2-days"><span class="tv2-dchip on">À venir</span></div>`;
  const seen = new Map();
  _posts.forEach((p, i) => { if (!seen.has(p.day.id)) seen.set(p.day.id, { num: p.day.num, date: p.day.date, first: i }); });
  return `<div class="tv2-days" id="tv2-days">${[...seen.values()].map((d, k) => `
    <button class="tv2-dchip${k === 0 ? ' on' : ''}" data-first="${d.first}" data-day-num="${d.num}">
      <b>Jour ${d.num}</b>${d.date ? `<small>${_esc(new Date(d.date + 'T12:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }))}</small>` : ''}
    </button>`).join('')}</div>`;
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
        <span class="tv2-post-media" style="--sc:${_esc(et.color || '#0d9488')}">${p.photos[0] ? `<img src="${_esc(p.photos[0])}" alt="" loading="lazy" decoding="async">` : `<i>${et.emoji || '📍'}</i>`}</span>
        <span class="tv2-post-shade"></span>
        ${flag ? `<span class="tv2-ocard-flag">${flag}</span>` : ''}
        <span class="tv2-post-info"><b>${_esc(p.item.text || '—')}</b>
          <span class="tv2-post-meta"><span>${ICON.heart.replace('22', '15').replace('22', '15')} ${c.likes}</span><span>${ICON.chat.replace('22', '15').replace('22', '15')} ${c.comments}</span><span>${ICON.photo} ${p.photos.length}</span></span>
        </span>
      </button>`;
  }).join('');
  const startCard = `
    <div class="tv2-ocard tv2-ocard-start">
      <i>🏠</i><b>Voyage ${trip.startDate && trip.startDate > new Date().toISOString().slice(0, 10) ? 'prévu' : 'entamé'}</b>
      <small>${trip.startDate ? _esc(fmtDate(trip.startDate)) : ''}</small>
    </div>`;

  if (isRefresh && host.querySelector('#tv2')) {
    const car = host.querySelector('.tv2-carousel');
    if (car) car.innerHTML = startCard + (cards || `<div class="tv2-ocard tv2-ocard-start"><i>📡</i><b>En attente de publications…</b><small>Les voyageurs publieront leurs étapes au fil du voyage</small></div>`);
    const strip = host.querySelector('.tv2-days');
    if (strip) strip.outerHTML = _daysStripHtml();
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
        ${_daysStripHtml()}
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
  // Défiler le carrousel recentre la carte sur l'étape affichée et le sélecteur de jours
  const car = root.querySelector('.tv2-carousel');
  let t = 0, tStrip = 0, progStrip = 0, progCar = 0;
  const centerChip = (chip, smooth = true) => {
    const strip = root.querySelector('.tv2-days');
    if (!strip || !chip) return;
    strip.querySelectorAll('.tv2-dchip').forEach(c => c.classList.toggle('on', c === chip));
    progStrip = Date.now();
    strip.scrollTo({ left: chip.offsetLeft + chip.offsetWidth / 2 - strip.clientWidth / 2, behavior: smooth ? 'smooth' : 'auto' });
  };
  const goToPost = idx => {
    const el = car.querySelector(`.tv2-ocard[data-post="${idx}"]`);
    if (!el) return;
    progCar = Date.now();
    car.scrollTo({ left: el.offsetLeft + el.offsetWidth / 2 - car.clientWidth / 2, behavior: 'smooth' });
    const post = _posts[idx];
    const pin = post && _pins.find(p => p.id === post.item.id);
    if (pin) flyToPin(pin);
  };
  car.addEventListener('scroll', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      const cardsEls = [...car.querySelectorAll('.tv2-ocard[data-post]')];
      const mid = car.scrollLeft + car.clientWidth / 2;
      let best = null, bd = Infinity;
      cardsEls.forEach(el => { const d = Math.abs(el.offsetLeft + el.offsetWidth / 2 - mid); if (d < bd) { bd = d; best = el; } });
      if (!best) return;
      const post = _posts[+best.dataset.post];
      const chip = [...root.querySelectorAll('.tv2-dchip[data-day-num]')].find(c => c.dataset.dayNum === best.dataset.dayNum);
      if (chip && !chip.classList.contains('on')) centerChip(chip);
      if (Date.now() - progCar < 700) return;   // déjà centrée par goToPost
      const pin = post && _pins.find(p => p.id === post.item.id);
      if (pin) flyToPin(pin);
    }, 160);
  }, { passive: true });
  // Sélecteur de jours : glisser = changer de jour (celui au centre), toucher = y aller
  root.addEventListener('click', e => {
    const chip = e.target.closest('.tv2-dchip[data-first]');
    if (!chip) return;
    centerChip(chip);
    goToPost(+chip.dataset.first);
  });
  root.addEventListener('scroll', e => {
    const strip = e.target;
    if (!strip.classList?.contains('tv2-days')) return;
    clearTimeout(tStrip);
    tStrip = setTimeout(() => {
      if (Date.now() - progStrip < 700) return;   // défilement provoqué par le code
      const mid = strip.scrollLeft + strip.clientWidth / 2;
      let best = null, bd = Infinity;
      strip.querySelectorAll('.tv2-dchip[data-first]').forEach(el => { const d = Math.abs(el.offsetLeft + el.offsetWidth / 2 - mid); if (d < bd) { bd = d; best = el; } });
      if (!best || best.classList.contains('on')) return;
      centerChip(best);
      goToPost(+best.dataset.first);
    }, 180);
  }, { capture: true, passive: true });

  _pins = _tripPins(trip, true);
  attachHomeMap(root.querySelector('#tv2-map-slot'), {
    context: 'trip', pins: _pins, route: _routeLines(trip, true),
    ...((getSettings().homeMap) || {}),
    padding: _mapPadding(),
    onPinsTap: pins => { if (pins[0]) _onPinTap(pins[0]); },
    onError: () => notify('Carte indisponible (hors-ligne ?)', '🗺'),
  }).then(() => { setHomeMapPadding(_mapPadding()); fitHomeMap(_mapPadding(), false); });
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
  const n = Math.max(1, post.photos.length);
  const next = _story.photo + dir;
  if (next >= 0 && next < n) { _story.photo = next; }
  else if (dir > 0 && _story.post < _posts.length - 1) { _story.post++; _story.photo = 0; }
  else if (dir < 0 && _story.post > 0) { _story.post--; _story.photo = Math.max(0, _posts[_story.post].photos.length - 1); }
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
  const n = Math.max(1, post.photos.length);
  const src = post.photos[_story.photo];
  const code = post.item.countryCode;
  const flag = _flagOf(code, post.item.countryFlag);
  const country = _countryName(code);
  const date = post.day.date ? new Date(post.day.date + 'T12:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }) : `Jour ${post.day.num}`;
  const meta = [country ? `${flag} ${country.toUpperCase()}` : flag, date.toUpperCase(), post.jd.weather ? _esc(post.jd.weather) : ''].filter(Boolean).join(' · ');
  _story.el.innerHTML = `
    <div class="tv2-story-card">
      <div class="tv2-story-media" style="--sc:${_esc(et.color || '#0d9488')}">
        ${src ? `<img src="${_esc(src)}" alt="">` : `<i>${et.emoji || '📍'}</i>`}
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
