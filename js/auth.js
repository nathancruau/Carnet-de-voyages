/**
 * auth.js — Firebase Authentication + Firestore sync
 *
 * Login strategy: popup first on all platforms.
 * Falls back to redirect only if popup is explicitly blocked by the browser.
 *
 * Key fix for iOS Safari: when signInWithPopup redirects the current page
 * (iOS can't open a true popup window), onAuthStateChanged fires with null
 * immediately on reload — BEFORE getRedirectResult has processed the token.
 * We wait for getRedirectResult to settle before deciding to show the login
 * screen, preventing the redirect loop where the user sees login and clicks
 * again before auth has a chance to complete.
 *
 * If firebase-config.js has placeholder values the app runs in local-only mode.
 */

import { firebaseConfig } from './firebase-config.js';

const FB = 'https://www.gstatic.com/firebasejs/11.1.0';

const _configured = !!(
  firebaseConfig.apiKey &&
  !firebaseConfig.apiKey.startsWith('YOUR')
);

let _auth = null;
let _db   = null;
let _uid  = null;
let _user = null;

let _docFn, _getDocFn, _setDocFn, _signOutFn, _GoogleProvider;
let _signInPopupFn, _signInRedirectFn, _getRedirectResultFn;

export function isFirebaseConfigured() { return _configured; }
export function getCurrentUser()       { return _user; }

export async function initAuth(onReady) {
  if (!_configured) {
    onReady(null, null);
    return;
  }

  try {
    const [appMod, authMod, dbMod] = await Promise.all([
      import(`${FB}/firebase-app.js`),
      import(`${FB}/firebase-auth.js`),
      import(`${FB}/firebase-firestore.js`),
    ]);

    const app = appMod.initializeApp(firebaseConfig);
    _auth = authMod.getAuth(app);
    _db   = dbMod.getFirestore(app);

    _docFn               = dbMod.doc;
    _getDocFn            = dbMod.getDoc;
    _setDocFn            = dbMod.setDoc;
    _signOutFn           = authMod.signOut;
    _GoogleProvider      = authMod.GoogleAuthProvider;
    _signInPopupFn       = authMod.signInWithPopup;
    _signInRedirectFn    = authMod.signInWithRedirect;
    _getRedirectResultFn = authMod.getRedirectResult;

    // Start processing any pending redirect result immediately.
    // On iOS Safari, signInWithPopup may redirect the current page instead of
    // opening a true popup. getRedirectResult exchanges the OAuth code for a
    // token and updates _auth.currentUser before onAuthStateChanged fires again.
    const redirectSettled = _getRedirectResultFn(_auth).catch(redirectErr => {
      const code = redirectErr.code || '';
      let msg = redirectErr.message || 'Erreur de connexion';
      if (code === 'auth/unauthorized-domain') {
        msg = 'Domaine non autorisé dans Firebase → Authentication → Authorized domains.';
      }
      console.warn('[auth] Redirect error:', code, msg);
      const errEl = document.getElementById('login-err');
      if (errEl) errEl.textContent = msg;
      else sessionStorage.setItem('_authRedirectError', msg);
      return null;
    });

    authMod.onAuthStateChanged(_auth, async fbUser => {
      _user = fbUser;
      _uid  = fbUser?.uid ?? null;

      if (fbUser) {
        // User is authenticated — load cloud data and show home.
        const cloudData = await _loadFromFirestore();
        onReady(fbUser, cloudData);
        return;
      }

      // No user yet. Wait for getRedirectResult to settle (up to 6 s) before
      // concluding there is no authenticated user and showing the login screen.
      // This prevents the loop: redirect returns → null fires → login shown →
      // user clicks again → redirect again → loop.
      await Promise.race([
        redirectSettled,
        new Promise(r => setTimeout(r, 6000)),
      ]);

      // After waiting, re-check: getRedirectResult may have signed the user in.
      if (_auth.currentUser) return; // onAuthStateChanged will fire again with the user

      onReady(null, null);
    });

  } catch (err) {
    console.error('[auth] Firebase init failed:', err.message);
    onReady(null, null);
  }
}

/**
 * Sign in with Google.
 * On iOS/Android: popup opens as a new tab without window.opener, so Firebase
 * can't post the auth result back to the original tab — the button stays stuck
 * on "Connexion..." forever. Use redirect instead on mobile; initAuth already
 * waits for getRedirectResult to settle before deciding to show the login screen,
 * so there is no redirect loop.
 * On desktop: popup is preferred (instant, no page reload).
 */
export async function loginWithGoogle() {
  if (!_auth || !_GoogleProvider) throw new Error('Firebase not initialized');
  const provider = new _GoogleProvider();
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  if (isMobile) {
    await _signInRedirectFn(_auth, provider);
    // Page navigates away — no code runs after this
    return;
  }
  try {
    await _signInPopupFn(_auth, provider);
  } catch (err) {
    if (err.code === 'auth/popup-blocked') {
      await _signInRedirectFn(_auth, provider);
      // Page navigates away — no code runs after this
    } else {
      throw err;
    }
  }
}

export async function logout() {
  if (!_auth || !_signOutFn) return;
  _user = null;
  _uid  = null;
  await _signOutFn(_auth);
}

export async function syncToFirestore(state) {
  if (!_db || !_uid || !_setDocFn || !_docFn) return;
  try {
    await _setDocFn(_docFn(_db, 'users', _uid), state);
  } catch (err) {
    console.warn('[auth] Firestore sync failed:', err.message);
  }
}

async function _loadFromFirestore() {
  if (!_db || !_uid || !_getDocFn || !_docFn) return null;
  try {
    const snap = await Promise.race([
      _getDocFn(_docFn(_db, 'users', _uid)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    return snap.exists() ? snap.data() : null;
  } catch (err) {
    console.warn('[auth] Firestore load failed:', err.message);
    return null;
  }
}
