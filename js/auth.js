/**
 * auth.js — Firebase Authentication + Firestore sync
 *
 * Login strategy: popup first (instant, no cross-origin storage issue),
 * redirect as fallback only if popup is blocked by the browser.
 * onAuthStateChanged is wired before any async call so the spinner never hangs.
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

    // Wire up listener first — fires immediately with current auth state,
    // then again after any popup/redirect completes.
    authMod.onAuthStateChanged(_auth, async fbUser => {
      _user = fbUser;
      _uid  = fbUser?.uid ?? null;
      let cloudData = null;
      if (fbUser) cloudData = await _loadFromFirestore();
      onReady(fbUser, cloudData);
    });

    // Surface any redirect error on the login card (non-blocking)
    _getRedirectResultFn(_auth).catch(redirectErr => {
      const code = redirectErr.code || '';
      let msg = redirectErr.message || 'Erreur de connexion';
      if (code === 'auth/unauthorized-domain') {
        msg = 'Domaine non autorisé dans Firebase → Authentication → Authorized domains.';
      }
      console.warn('[auth] Redirect error:', code, msg);
      const errEl = document.getElementById('login-err');
      if (errEl) errEl.textContent = msg;
      else sessionStorage.setItem('_authRedirectError', msg);
    });

  } catch (err) {
    console.error('[auth] Firebase init failed:', err.message);
    onReady(null, null);
  }
}

/**
 * Sign in with Google.
 * Tries popup first (instant, no cross-origin storage issue).
 * Falls back to redirect only if the popup is blocked by the browser.
 */
export async function loginWithGoogle() {
  if (!_auth || !_GoogleProvider) throw new Error('Firebase not initialized');
  const provider = new _GoogleProvider();
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
    // 8s timeout — if Firestore is not set up yet, don't block the login flow
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
