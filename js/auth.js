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
let _signInRedirectFn, _getRedirectResultFn;

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
    _signInRedirectFn    = authMod.signInWithRedirect;
    _getRedirectResultFn = authMod.getRedirectResult;

    // Start processing any pending redirect credential immediately (non-blocking).
    // When there is no pending redirect this resolves in <100 ms, so the
    // onAuthStateChanged callback below will not wait meaningfully.
    // When coming back from Google sign-in it takes 1-5 s on mobile.
    const redirectDone = _getRedirectResultFn(_auth).catch(redirectErr => {
      const code = redirectErr.code || '';
      let msg = redirectErr.message || 'Erreur de connexion';
      if (code === 'auth/unauthorized-domain') {
        msg = 'Domaine non autorisé dans Firebase → Authentication → Authorized domains.';
      }
      console.warn('[auth] Redirect error:', code, msg);
      sessionStorage.setItem('_authRedirectError', msg);
    });

    // Track last processed UID to prevent double-calling onReady after a redirect
    // (Firebase fires onAuthStateChanged twice: first null, then the user).
    let lastUid = undefined;

    authMod.onAuthStateChanged(_auth, async fbUser => {
      // On the very first null callback, wait for getRedirectResult to settle
      // before deciding no user is logged in. On a plain page-load with no
      // pending redirect, redirectDone resolves in <100 ms — no perceptible delay.
      // On return from Google sign-in it waits until the credential is processed.
      if (!fbUser && lastUid === undefined) {
        await Promise.race([redirectDone, new Promise(r => setTimeout(r, 5000))]);
        fbUser = _auth.currentUser;
      }

      const newUid = fbUser?.uid ?? null;
      // Skip if the auth state hasn't actually changed (avoids double-render).
      if (newUid === lastUid && lastUid !== undefined) return;
      lastUid = newUid;

      _user = fbUser;
      _uid  = newUid;
      let cloudData = null;
      if (fbUser) cloudData = await _loadFromFirestore();
      onReady(fbUser, cloudData);
    });

  } catch (err) {
    console.error('[auth] Firebase init failed:', err.message);
    onReady(null, null);
  }
}

// Always use redirect — Google's COOP headers on accounts.google.com sever
// window.opener inside any popup, making signInWithPopup permanently broken.
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
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ]);
    return snap.exists() ? snap.data() : null;
  } catch (err) {
    console.warn('[auth] Firestore load failed:', err.message);
    return null;
  }
}
