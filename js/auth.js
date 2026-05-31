/**
 * auth.js — Firebase Authentication + Firestore sync
 *
 * Uses signInWithRedirect (not popup) for reliability on GitHub Pages / mobile.
 * onAuthStateChanged is wired BEFORE getRedirectResult so the spinner
 * never blocks even if the redirect result takes time.
 *
 * If firebase-config.js still has placeholder values, the app runs
 * in local-only mode (no login required, data stays in localStorage).
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

let _docFn, _getDocFn, _setDocFn, _signOutFn, _GoogleProvider, _signInRedirectFn, _getRedirectResultFn;

export function isFirebaseConfigured() { return _configured; }
export function getCurrentUser()       { return _user; }

/**
 * Initialize Firebase and listen for auth state changes.
 * @param {Function} onReady — called with (user, cloudData|null)
 */
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
    _signInRedirectFn    = authMod.signInWithRedirect;
    _getRedirectResultFn = authMod.getRedirectResult;

    // Wire up listener FIRST — fires immediately with current auth state
    // and again after a redirect completes. Never blocked by getRedirectResult.
    authMod.onAuthStateChanged(_auth, async fbUser => {
      _user = fbUser;
      _uid  = fbUser?.uid ?? null;

      let cloudData = null;
      if (fbUser) {
        cloudData = await _loadFromFirestore();
      }
      onReady(fbUser, cloudData);
    });

    // Non-blocking: surface any redirect error on the login card.
    // Writes directly to #login-err if it's already in the DOM,
    // otherwise stores in sessionStorage for _renderLogin to pick up.
    _getRedirectResultFn(_auth).catch(redirectErr => {
      const code = redirectErr.code || '';
      let msg = redirectErr.message || 'Erreur de connexion';
      if (code === 'auth/unauthorized-domain') {
        msg = 'Domaine non autorisé. Ajoutez nathancruau.github.io dans Firebase → Authentication → Authorized domains.';
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

export async function loginWithGoogle() {
  if (!_auth || !_signInRedirectFn || !_GoogleProvider) {
    throw new Error('Firebase not initialized');
  }
  const provider = new _GoogleProvider();
  await _signInRedirectFn(_auth, provider);
  // Page redirects to Google — no code runs after this line
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
    const snap = await _getDocFn(_docFn(_db, 'users', _uid));
    return snap.exists() ? snap.data() : null;
  } catch (err) {
    console.warn('[auth] Firestore load failed:', err.message);
    return null;
  }
}
