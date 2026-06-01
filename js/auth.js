/**
 * auth.js — Firebase Authentication + Firestore sync
 *
 * Authentication strategy: signInWithRedirect (never popup).
 * Reason: Google enforces Cross-Origin-Opener-Policy: same-origin on
 * accounts.google.com, which severs window.opener in any popup that
 * navigates through their auth pages. signInWithPopup is permanently
 * broken on all browsers as a result.
 *
 * Redirect coordination with onAuthStateChanged:
 * After the OAuth redirect returns, Firebase fires onAuthStateChanged
 * with null before getRedirectResult has finished processing the
 * credential. Without special handling this shows the login screen
 * immediately, dropping the credential. The fix: call getRedirectResult
 * non-blocking at startup, then inside the first null onAuthStateChanged
 * callback wait for it to settle before deciding no user is logged in.
 * On visits with no pending redirect getRedirectResult resolves in
 * < 100 ms so there is no perceptible delay.
 */

import { firebaseConfig } from './firebase-config.js';

const FB = 'https://www.gstatic.com/firebasejs/11.1.0';

// False when firebase-config.js still has the placeholder API key.
const _configured = !!(
  firebaseConfig.apiKey &&
  !firebaseConfig.apiKey.startsWith('YOUR')
);

let _auth = null;
let _db   = null;
let _uid  = null;
let _user = null;

let _docFn, _getDocFn, _setDocFn, _signOutFn, _GoogleProvider;
let _signInRedirectFn, _getRedirectResultFn;

export function isFirebaseConfigured() { return _configured; }
export function getCurrentUser()       { return _user; }

/**
 * Initialise Firebase and call onReady(user, cloudData) once the auth
 * state is known. Called again on every subsequent auth-state change
 * (login / logout) so the UI stays in sync.
 */
export async function initAuth(onReady) {
  if (!_configured) {
    // No real config — run in local-only mode without any sign-in.
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

    // Kick off redirect-result processing immediately (non-blocking).
    // On a normal page-load this resolves with null in < 100 ms.
    // After returning from Google OAuth it resolves with the UserCredential
    // once Firebase has exchanged the auth code for tokens (1–5 s on mobile).
    const redirectDone = _getRedirectResultFn(_auth).catch(redirectErr => {
      const code = redirectErr.code || '';
      let msg = redirectErr.message || 'Erreur de connexion';
      if (code === 'auth/unauthorized-domain') {
        msg = 'Domaine non autorisé — vérifiez Firebase → Authentication → Authorized domains.';
      }
      console.warn('[auth] redirect error:', code, msg);
      sessionStorage.setItem('_authRedirectError', msg);
    });

    // Deduplication guard: only call onReady when the effective auth state
    // actually changes. Firebase fires onAuthStateChanged twice after a
    // redirect: first null (credential not yet processed) then the user
    // (after getRedirectResult finishes). Without this guard renderHome()
    // would be called twice.
    let lastUid = undefined; // undefined = initial, null = logged out, string = uid

    authMod.onAuthStateChanged(_auth, async fbUser => {
      if (!fbUser && lastUid === undefined) {
        // First callback arrived with no user. Wait for any in-flight
        // redirect to settle before concluding the user is not logged in.
        // 5 s safety net in case getRedirectResult hangs on a slow connection.
        await Promise.race([redirectDone, new Promise(r => setTimeout(r, 5000))]);
        fbUser = _auth.currentUser; // re-read after redirect processed
      }

      const newUid = fbUser?.uid ?? null;
      if (newUid === lastUid && lastUid !== undefined) return; // no change
      lastUid = newUid;

      _user = fbUser;
      _uid  = newUid;
      const cloudData = fbUser ? await _loadFromFirestore() : null;
      onReady(fbUser, cloudData);
    });

  } catch (err) {
    console.error('[auth] Firebase init failed:', err.message);
    onReady(null, null);
  }
}

/**
 * Trigger Google OAuth via full-page redirect.
 * signInWithPopup is intentionally not used — see file header.
 */
export async function loginWithGoogle() {
  if (!_auth || !_GoogleProvider) throw new Error('Firebase not initialized');
  const provider = new _GoogleProvider();
  await _signInRedirectFn(_auth, provider);
}

export async function logout() {
  if (!_auth || !_signOutFn) return;
  _user = null;
  _uid  = null;
  await _signOutFn(_auth);
}

/** Push the full app state to the user's Firestore document. */
export async function syncToFirestore(state) {
  if (!_db || !_uid || !_setDocFn || !_docFn) return;
  try {
    await _setDocFn(_docFn(_db, 'users', _uid), state);
  } catch (err) {
    console.warn('[auth] Firestore sync failed:', err.message);
  }
}

/** Load the user's state from Firestore with a 5 s timeout. */
async function _loadFromFirestore() {
  if (!_db || !_uid || !_getDocFn || !_docFn) return null;
  try {
    const snap = await Promise.race([
      _getDocFn(_docFn(_db, 'users', _uid)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ]);
    return snap.exists() ? snap.data() : null;
  } catch (err) {
    console.warn('[auth] Firestore load failed:', err.message);
    return null;
  }
}
