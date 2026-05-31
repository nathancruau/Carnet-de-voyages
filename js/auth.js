/**
 * auth.js — Firebase Authentication + Firestore sync
 *
 * getRedirectResult MUST be awaited BEFORE onAuthStateChanged is set up.
 * Firebase processes the OAuth token in getRedirectResult and updates
 * currentUser; only then does onAuthStateChanged fire with the user.
 * Reversing this order causes getRedirectResult to return null because
 * onAuthStateChanged fires first with a stale (null) state.
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

    // ── Step 1: process any pending redirect result FIRST ─────────────────────
    // getRedirectResult exchanges the OAuth code for a token and updates
    // _auth.currentUser. This MUST complete before onAuthStateChanged is
    // registered; otherwise the listener fires with null (stale state) and
    // the redirect result is silently dropped.
    const hadRedirect = !!sessionStorage.getItem('_redirectPending');

    try {
      await Promise.race([
        _getRedirectResultFn(_auth),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
      ]);
    } catch (err) {
      const code = err.code || '';
      if (err.message !== 'timeout') {
        let msg = err.message || 'Erreur de connexion';
        if (code === 'auth/unauthorized-domain') {
          msg = 'Domaine non autorisé dans Firebase → Authentication → Authorized domains.';
        }
        console.warn('[auth] Redirect error:', code, msg);
        sessionStorage.setItem('_authRedirectError', msg);
      } else if (hadRedirect) {
        console.warn('[auth] Redirect result timed out');
        sessionStorage.setItem('_authRedirectError',
          'La connexion a expiré. Réessayez.');
      }
    }

    // Clear the redirect flag — we've processed (or timed out) the result
    sessionStorage.removeItem('_redirectPending');

    // If redirect happened but produced no user, show a diagnostic error
    if (hadRedirect && !_auth.currentUser) {
      const msg = sessionStorage.getItem('_authRedirectError')
        || 'Session non récupérée après connexion. Réessayez.';
      sessionStorage.setItem('_authRedirectError', msg);
    }

    // ── Step 2: subscribe to auth state ───────────────────────────────────────
    // currentUser is now fully resolved (redirect processed above).
    authMod.onAuthStateChanged(_auth, async fbUser => {
      _user = fbUser;
      _uid  = fbUser?.uid ?? null;
      let cloudData = null;
      if (fbUser) cloudData = await _loadFromFirestore();
      onReady(fbUser, cloudData);
    });

  } catch (err) {
    console.error('[auth] Firebase init failed:', err.message);
    onReady(null, null);
  }
}

/**
 * Sign in with Google — always uses redirect (no popup).
 * Popup requires window.opener.postMessage from firebaseapp.com back to
 * nathancruau.github.io, which is blocked by cross-origin restrictions.
 * Redirect navigates the current tab; getRedirectResult (awaited in initAuth
 * before onAuthStateChanged) processes the result cleanly.
 */
export async function loginWithGoogle() {
  if (!_auth || !_GoogleProvider) throw new Error('Firebase not initialized');
  // Mark that a redirect is starting so initAuth can diagnose failures
  sessionStorage.setItem('_redirectPending', '1');
  const provider = new _GoogleProvider();
  await _signInRedirectFn(_auth, provider);
  // Page navigates away — no code runs after this
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
