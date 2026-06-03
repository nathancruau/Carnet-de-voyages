/* ============================================================
   CARNET DE VOYAGES — App Entry Point & Router
   ============================================================ */

import { loadData, getState, setState, setSyncCallback, getSettings, getTrips } from './store.js';
import { renderHome } from './home.js';
import { renderMyMap, destroyMyMap } from './mymap.js';
import { openTrip, destroyTripMap } from './trip/trip.js';
import { closeModal } from './utils.js';
import { initAuth, loginWithGoogle, syncToFirestore, isFirebaseConfigured } from './auth.js';
import { initSharedTrips, handlePendingInvite } from './share.js';
import { checkDepartureNotifications } from './notifications.js';

// Capture ?invite=TOKEN before anything else, store in sessionStorage, clean URL
{
  const params = new URLSearchParams(location.search);
  const token  = params.get('invite');
  if (token) {
    sessionStorage.setItem('_pendingInvite', token);
    history.replaceState(null, '', location.pathname + location.hash);
  }
}

// ── Current state ──────────────────────────────────────────────────────────────
export let currentScreen = 'home';
export let currentTripId = null;

// ── Screen management ──────────────────────────────────────────────────────────

export function showScreen(id) {
  currentScreen = id;
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById('screen-' + id);
  if (el) el.classList.add('active');

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

// ── Login screen ───────────────────────────────────────────────────────────────

function _googleBtnInner() {
  return `<svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg"><path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/><path d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853"/><path d="M3.964 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.039l3.007-2.332z" fill="#FBBC05"/><path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.961L3.964 6.293C4.672 4.166 6.656 3.58 9 3.58z" fill="#EA4335"/></svg> Continuer avec Google`;
}

function _renderLogin() {
  const wrap = document.getElementById('login-wrap');
  if (!wrap) return;
  wrap.innerHTML = `
    <div class="login-card">
      <div class="login-icon">✈️</div>
      <div class="login-logo">Carnet de Voyages</div>
      <div class="login-sub">Connectez-vous pour retrouver vos voyages sur tous vos appareils.</div>
      <button class="google-btn" id="login-google-btn">${_googleBtnInner()}</button>
      <div class="login-err" id="login-err"></div>
    </div>
  `;

  document.getElementById('login-google-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('login-google-btn');
    const err = document.getElementById('login-err');
    if (btn) { btn.disabled = true; btn.textContent = 'Connexion…'; }
    if (err) err.textContent = '';
    try {
      await loginWithGoogle();
      // Page redirects to Google — nothing runs after this line
    } catch (e) {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = _googleBtnInner();
      }
      if (err) err.textContent = e.message || 'Erreur de connexion';
    }
  });

  // Show any error stored before this render (from getRedirectResult .catch)
  const storedErr = sessionStorage.getItem('_authRedirectError');
  if (storedErr) {
    sessionStorage.removeItem('_authRedirectError');
    const err = document.getElementById('login-err');
    if (err) err.textContent = storedErr;
  }
}

// ── Auth bootstrap ─────────────────────────────────────────────────────────────

function _onAuthReady(user, cloudData) {
  if (!isFirebaseConfigured()) {
    // Local-only mode: no login required
    loadData();
    checkDepartureNotifications(getTrips(), getSettings());
    renderHome();
    showScreen('home');
    return;
  }

  if (!user) {
    _renderLogin();
    showScreen('login');
    return;
  }

  // Logged in — wire up sync callback so every saveData() pushes to Firestore
  try {
    setSyncCallback(syncToFirestore);

    if (cloudData) {
      // Read localStorage first so setState can merge local edits that didn't reach Firestore yet
      loadData();
      setState(cloudData);
    } else {
      // First login on this device: upload existing local trips to cloud
      loadData();
      const localState = getState();
      if (localState.trips && localState.trips.length > 0) {
        syncToFirestore(localState);
      }
    }

    renderHome();
    showScreen('home');

    checkDepartureNotifications(getTrips(), getSettings());
    // Re-apply theme listener for 'auto' mode
    if (getSettings().theme === 'auto') {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
        document.documentElement.dataset.theme = e.matches ? 'dark' : '';
      });
    }

    // Load shared trips and handle any pending invite link (non-blocking)
    initSharedTrips(cloudData).then(() => handlePendingInvite(user));
  } catch (err) {
    console.error('[app] render failed after login:', err);
    // The login form may not exist yet (spinner is still showing).
    // Render it first so the error message has a place to appear.
    _renderLogin();
    showScreen('login');
    const errEl = document.getElementById('login-err');
    if (errEl) errEl.textContent = 'Erreur lors du chargement. Réessayez.';
  }
}

// ── Global bindings (for onclick="" in HTML / modals / map popups) ─────────────
window.goHome         = goHome;
window.goMyMap        = goMyMap;
window.navigateToTrip = navigateToTrip;
window.closeModal     = closeModal;

// Called by share.js after a remote real-time update to refresh the visible screen
window._rerenderCurrentView = (updatedTripId) => {
  if (currentScreen === 'home') {
    renderHome();
  } else if (currentScreen === 'app' && currentTripId === updatedTripId) {
    openTrip(currentTripId);
  }
};

// Called by share.js when only reactions/comments change — re-renders journal panel
// in-place without switching the active tab.
window._refreshJournalInteractions = (updatedTripId) => {
  if (currentScreen !== 'app' || currentTripId !== updatedTripId) return;
  const journalPanel = document.getElementById('panel-journal');
  if (!journalPanel?.classList.contains('active')) return;
  import('./trip/journal.js').then(({ rerenderJournal }) => {
    rerenderJournal(updatedTripId);
  }).catch(() => {});
};

// ── Bootstrap ──────────────────────────────────────────────────────────────────
initAuth(_onAuthReady);
