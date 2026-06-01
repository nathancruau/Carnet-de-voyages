/**
 * auth.js — Firebase Authentication + Firestore sync
 *
 * Uses signInWithRedirect (not popup) for reliability on GitHub Pages / mobile.
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

let _docFn, _getDocFn, _setDocFn, _updateDocFn, _onSnapshotFn, _signOutFn, _GoogleProvider;
let _signInRedirectFn, _getRedirectResultFn;

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
    _updateDocFn         = dbMod.updateDoc;
    _onSnapshotFn        = dbMod.onSnapshot;
    _signOutFn           = authMod.signOut;
    _GoogleProvider      = authMod.GoogleAuthProvider;
    _signInRedirectFn    = authMod.signInWithRedirect;
    _getRedirectResultFn = authMod.getRedirectResult;

    // Handle errors from a previous signInWithRedirect call
    try {
      await _getRedirectResultFn(_auth);
    } catch (redirectErr) {
      console.warn('[auth] Redirect sign-in error:', redirectErr.message);
      window._authRedirectError = redirectErr.message;
    }

    authMod.onAuthStateChanged(_auth, async fbUser => {
      _user = fbUser;
      _uid  = fbUser?.uid ?? null;

      let cloudData = null;
      if (fbUser) {
        cloudData = await _loadFromFirestore();
      }
      onReady(fbUser, cloudData);
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
  // Page will redirect to Google — no code runs after this
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

// ── Shared trips ───────────────────────────────────────────────────────────────

/** Write the full shared trip document (first share). */
export async function initSharedTripInFirestore(tripId, tripData, ownerId) {
  if (!_db || !_setDocFn || !_docFn) return;
  await _setDocFn(_docFn(_db, 'shared_trips', tripId), {
    trip: tripData,
    ownerId,
    members: { [ownerId]: { role: 'owner', companionId: null, companionName: 'Organisateur' } },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

/** Merge-update only the trip data in an existing shared document. */
export async function saveSharedTrip(tripId, tripData) {
  if (!_db || !_setDocFn || !_docFn) return;
  await _setDocFn(
    _docFn(_db, 'shared_trips', tripId),
    { trip: tripData, updatedAt: new Date().toISOString() },
    { merge: true },
  );
}

/**
 * Subscribe to real-time updates on a shared trip.
 * @returns {Function} unsubscribe function
 */
export function listenSharedTrip(tripId, callback) {
  if (!_db || !_onSnapshotFn || !_docFn) return () => {};
  return _onSnapshotFn(_docFn(_db, 'shared_trips', tripId), snap => {
    if (snap.exists()) callback(snap.data(), snap.metadata.hasPendingWrites);
  });
}

/** Load a shared trip document once (no listener). */
export async function loadSharedTrip(tripId) {
  if (!_db || !_getDocFn || !_docFn) return null;
  try {
    const snap = await _getDocFn(_docFn(_db, 'shared_trips', tripId));
    return snap.exists() ? snap.data() : null;
  } catch (err) {
    console.warn('[auth] loadSharedTrip failed:', err.message);
    return null;
  }
}

/** Create an invite token document. */
export async function createInvite(token, tripId) {
  if (!_db || !_setDocFn || !_docFn || !_uid) return;
  await _setDocFn(_docFn(_db, 'invites', token), {
    tripId,
    createdBy: _uid,
    createdAt: new Date().toISOString(),
  });
}

/** Read an invite token document. */
export async function loadInvite(token) {
  if (!_db || !_getDocFn || !_docFn) return null;
  try {
    const snap = await _getDocFn(_docFn(_db, 'invites', token));
    return snap.exists() ? snap.data() : null;
  } catch (err) {
    console.warn('[auth] loadInvite failed:', err.message);
    return null;
  }
}

/** Add the current user to the members map of a shared trip. */
export async function joinSharedTrip(tripId, companionId, companionName) {
  if (!_db || !_updateDocFn || !_docFn || !_uid) return;
  await _updateDocFn(_docFn(_db, 'shared_trips', tripId), {
    [`members.${_uid}`]: { role: 'member', companionId, companionName },
  });
}

/** Persist the list of shared trip IDs on the user's personal Firestore document. */
export async function saveUserSharedTripIds(ids) {
  if (!_db || !_setDocFn || !_docFn || !_uid) return;
  try {
    await _setDocFn(
      _docFn(_db, 'users', _uid),
      { sharedTripIds: ids },
      { merge: true },
    );
  } catch (err) {
    console.warn('[auth] saveUserSharedTripIds failed:', err.message);
  }
}

/** Load the user's state from Firestore. */
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
