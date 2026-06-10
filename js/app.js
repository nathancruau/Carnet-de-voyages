/* ============================================================
   CARNET DE VOYAGES — App Entry Point & Router
   ============================================================ */

import { loadData, getState, setState, setSyncCallback, getSettings, getTrips, hasPendingLocalChanges } from './store.js';
import { renderHome } from './home.js';
import { renderMyMap, destroyMyMap } from './mymap.js';
import { openTrip, destroyTripMap } from './trip/trip.js';
import { closeModal } from './utils.js';
import { initAuth, loginWithGoogle, syncToFirestore, isFirebaseConfigured, listenUserDoc } from './auth.js';
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

// Stored so we can remove and re-add on each auth cycle without leaking
let _darkModeMediaListener = null;
let _userDocUnsub = null; // unsubscribe fn for the users/{uid} real-time listener

// Quick signature of trips (id + updatedAt) used to skip redundant re-renders
// when our own write echoes back through the onSnapshot listener.
function _tripsSignature(trips) {
  return (trips || []).map(t => `${t.id}:${t.updatedAt || 0}`).sort().join('|');
}

// ── Screen management ──────────────────────────────────────────────────────────

export function showScreen(id) {
  currentScreen = id;
  // Reset body scroll to top on every screen switch (browser mode: home uses body scroll)
  window.scrollTo(0, 0);
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById('screen-' + id);
  if (el) el.classList.add('active');
  // Sync html/body background with the screen's visual content so any viewport gap
  // (iOS safe area / Android nav bar) blends in rather than showing white
  const _screenBg = id === 'login' ? '#065f55' // bottom of login gradient
    : (id === 'app' || id === 'mymap') ? '#aad3df'
    : getComputedStyle(document.documentElement).getPropertyValue('--c').trim() || '#faf7f2';
  document.documentElement.style.setProperty('background', _screenBg, 'important');
  document.body.style.setProperty('background', _screenBg, 'important');

  if (id === 'app' || id === 'mymap') {
    setTimeout(() => window.dispatchEvent(new Event('resize')), 200);
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
  document.body.style.overflowY = '';
  document.documentElement.style.overflowY = '';
  showScreen('home');
  renderHome();
}

export function goMyMap() {
  destroyTripMap();
  document.body.style.overflowY = '';
  document.documentElement.style.overflowY = '';
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
    if (_userDocUnsub) { _userDocUnsub(); _userDocUnsub = null; }
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

    // Re-apply theme listener for 'auto' mode.
    // Remove any previous listener first to avoid accumulation across auth cycles.
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (_darkModeMediaListener) mq.removeEventListener('change', _darkModeMediaListener);
    if (getSettings().theme === 'auto') {
      _darkModeMediaListener = e => {
        document.documentElement.dataset.theme = e.matches ? 'dark' : '';
      };
      mq.addEventListener('change', _darkModeMediaListener);
    } else {
      _darkModeMediaListener = null;
    }

    // Real-time listener on users/{uid}: keeps all open tabs and devices in sync.
    // When another device pushes a state update, we merge it in immediately so that
    // device never overwrites Firestore with stale data (the root cause of data loss).
    if (_userDocUnsub) { _userDocUnsub(); _userDocUnsub = null; }
    _userDocUnsub = listenUserDoc(user.uid, (data, hasPendingWrites) => {
      // hasPendingWrites: true = our own write going up to Firestore — skip
      if (hasPendingWrites) return;
      // Skip if data matches what we already have (prevents re-renders on our own confirms)
      if (_tripsSignature(data?.trips) === _tripsSignature(getTrips())) return;
      setState(data);
      if (currentScreen === 'home') renderHome();
    });

    // Load shared trips and handle any pending invite link (non-blocking).
    // Re-render home after loading so observer trips are classified correctly.
    initSharedTrips(cloudData).then(() => {
      if (currentScreen === 'home') renderHome();
      return handlePendingInvite(user);
    });
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

// ── Service-worker update — safe reload ────────────────────────────────────────
// Waits until no modal is open AND no debounced Firestore write is pending,
// so users never lose in-progress edits when a new version is deployed.

function _isModalOpen() {
  return !!(
    document.getElementById('modal-overlay')?.classList.contains('ov-visible') ||
    document.querySelector('.mobile-sheet')
  );
}

function _scheduleSwReload() {
  window._swUpdatePending = false; // disarm fallback in index.html
  let waited = 0;
  const MAX_WAIT = 30000; // give up after 30 s and reload regardless
  function attempt() {
    if ((!hasPendingLocalChanges() && !_isModalOpen()) || waited >= MAX_WAIT) {
      location.reload();
    } else {
      waited += 500;
      setTimeout(attempt, 500);
    }
  }
  attempt();
}

// Handle flag set before this module loaded (SW message arrived during HTML parse)
if (window._swUpdatePending) _scheduleSwReload();
// Handle future SW messages (e.g. update while app is already running)
navigator.serviceWorker?.addEventListener('message', e => {
  if (e.data?.type === 'SW_UPDATED') _scheduleSwReload();
});

// ── Offline indicator ──────────────────────────────────────────────────────────

function _setOfflineBar(offline) {
  document.getElementById('offline-bar')?.classList.toggle('visible', offline);
}
window.addEventListener('online',  () => _setOfflineBar(false));
window.addEventListener('offline', () => _setOfflineBar(true));
if (!navigator.onLine) _setOfflineBar(true);

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

