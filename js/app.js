/* ============================================================
   CARNET DE VOYAGES — App Entry Point & Router
   ============================================================ */

import { loadData } from './store.js?v=5';
import { renderHome } from './home.js?v=5';
import { renderMyMap, destroyMyMap } from './mymap.js?v=5';
import { openTrip, destroyTripMap } from './trip/trip.js?v=5';
import { closeModal } from './utils.js?v=5';

// ── Current state ──────────────────────────────────────────────────────────────
export let currentScreen = 'home';
export let currentTripId = null;

// ── Screen management ──────────────────────────────────────────────────────────

export function showScreen(id) {
  currentScreen = id;
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById('screen-' + id);
  if (el) el.classList.add('active');

  // Invalidate Leaflet maps after CSS transition
  if (id === 'app' || id === 'mymap') {
    setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
  }
}

// ── Navigation ─────────────────────────────────────────────────────────────────

export function navigateToTrip(id) {
  currentTripId = id;
  destroyMyMap();
  openTrip(id);
  showScreen('app');
}

export function goHome() {
  destroyTripMap();
  destroyMyMap();
  showScreen('home');
  renderHome();
}

export function goMyMap() {
  destroyTripMap();
  showScreen('mymap');
  renderMyMap();
}

// ── Global bindings (for onclick="" in HTML / modals / map popups) ─────────────
window.goHome         = goHome;
window.goMyMap        = goMyMap;
window.navigateToTrip = navigateToTrip;
window.closeModal     = closeModal;

// ── Bootstrap ──────────────────────────────────────────────────────────────────
loadData();
renderHome();
