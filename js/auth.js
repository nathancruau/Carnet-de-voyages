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

    // CRITICAL: await getRedirectResult BEFORE registering onAuthStateChanged.
    // If onAuthStateChanged fires first it gets stale null state and drops the
    // redirect credential, sending the user back to the login screen.
    try {
      await Promise.race([
        _getRedirectResultFn(_auth),
        new Promise(resolve => setTimeout(resolve, 8000)),
      ]);
    } catch (redirectErr) {
      const code = redirectErr.code || '';
      let msg = redirectErr.message || 'Erreur de connexion';
      if (code === 'auth/unauthorized-domain') {
        msg = 'Domaine non autorisé dans Firebase → Authentication → Authorized domains.';
      }
      console.warn('[auth] Redirect error:', code, msg);
      sessionStorage.setItem('_authRedirectError', msg);
    }

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
