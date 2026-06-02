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

let _docFn, _getDocFn, _setDocFn, _updateDocFn, _onSnapshotFn, _signOutFn, _GoogleProvider;
let _signInRedirectFn, _getRedirectResultFn;
let _arrayUnionFn, _deleteFieldFn;

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
    _updateDocFn         = dbMod.updateDoc;
    _onSnapshotFn        = dbMod.onSnapshot;
    _signOutFn           = authMod.signOut;
    _GoogleProvider      = authMod.GoogleAuthProvider;
    _signInRedirectFn    = authMod.signInWithRedirect;
    _getRedirectResultFn = authMod.getRedirectResult;
    _arrayUnionFn        = dbMod.arrayUnion;
    _deleteFieldFn       = dbMod.deleteField;

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
    await _setDocFn(_docFn(_db, 'users', _uid), state, { merge: true });
  } catch (err) {
    console.warn('[auth] Firestore sync failed:', err.message);
  }
}

// ── Shared trips ───────────────────────────────────────────────────────────────

/** Write the full shared trip document (first share). */
export async function initSharedTripInFirestore(tripId, tripData, ownerId, ownerName) {
  if (!_db || !_setDocFn || !_docFn) return;
  await _setDocFn(_docFn(_db, 'shared_trips', tripId), {
    trip: tripData,
    ownerId,
    members: { [ownerId]: { role: 'owner', companionId: null, companionName: ownerName || 'Organisateur' } },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

/** Remove a specific member (by UID) from a shared trip's members + presence. */
export async function removeMemberFromSharedTrip(tripId, memberUid) {
  if (!_db || !_updateDocFn || !_docFn || !_deleteFieldFn) return;
  await _updateDocFn(_docFn(_db, 'shared_trips', tripId), {
    [`members.${memberUid}`]:  _deleteFieldFn(),
    [`presence.${memberUid}`]: _deleteFieldFn(),
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
export async function createInvite(token, tripId, role = 'member') {
  if (!_db || !_setDocFn || !_docFn || !_uid) return;
  await _setDocFn(_docFn(_db, 'invites', token), {
    tripId,
    role,
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
export async function joinSharedTrip(tripId, companionId, companionName, role = 'member') {
  if (!_db || !_updateDocFn || !_docFn || !_uid) return;
  await _updateDocFn(_docFn(_db, 'shared_trips', tripId), {
    [`members.${_uid}`]: { role, companionId, companionName },
  });
}

/** Write a lastPublished record to a shared trip doc (called when a day is validated). */
export async function updateLastPublished(tripId, publishData) {
  if (!_db || !_updateDocFn || !_docFn) return;
  await _updateDocFn(_docFn(_db, 'shared_trips', tripId), {
    lastPublished: publishData,
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

/** Add a comment to a day's thread in a shared trip. */
export async function addComment(tripId, dayId, text, author) {
  if (!_db || !_updateDocFn || !_docFn || !_arrayUnionFn) return;
  const comment = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    author,
    uid: _user?.uid || null,
    text,
    ts: new Date().toISOString(),
  };
  await _updateDocFn(_docFn(_db, 'shared_trips', tripId), {
    [`comments.${dayId}`]: _arrayUnionFn(comment),
  });
}

/** Update specific top-level fields in a shared trip document. */
export async function updateSharedTripFields(tripId, fields) {
  if (!_db || !_updateDocFn || !_docFn) return;
  await _updateDocFn(_docFn(_db, 'shared_trips', tripId), fields);
}

/** Delete a specific field path in a shared trip document. */
export async function deleteSharedTripField(tripId, fieldPath) {
  if (!_db || !_updateDocFn || !_docFn || !_deleteFieldFn) return;
  await _updateDocFn(_docFn(_db, 'shared_trips', tripId), {
    [fieldPath]: _deleteFieldFn(),
  });
}

/** Write (or refresh) the current user's presence entry on a shared trip. */
export async function updatePresence(tripId, companionId, displayName) {
  if (!_db || !_updateDocFn || !_docFn || !_uid) return;
  await _updateDocFn(_docFn(_db, 'shared_trips', tripId), {
    [`presence.${_uid}`]: {
      companionId: companionId || null,
      displayName: displayName || 'Invité',
      lastSeen: new Date().toISOString(),
    },
  });
}

/** Remove the current user's presence from a shared trip. */
export async function clearPresence(tripId) {
  if (!_db || !_updateDocFn || !_docFn || !_uid || !_deleteFieldFn) return;
  try {
    await _updateDocFn(_docFn(_db, 'shared_trips', tripId), {
      [`presence.${_uid}`]: _deleteFieldFn(),
    });
  } catch (_) {}
}

/** Append an entry to the shared trip's activity log. */
export async function addActivityEntry(tripId, entry) {
  if (!_db || !_updateDocFn || !_docFn || !_arrayUnionFn) return;
  await _updateDocFn(_docFn(_db, 'shared_trips', tripId), {
    activity: _arrayUnionFn({
      ...entry,
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    }),
  });
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
