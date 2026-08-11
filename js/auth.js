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
import { compressTripsForFirestore, transformTripPhotos, compressPhotoDataUrl, FIRESTORE_SIZE_LIMIT } from './utils.js';
import { initPhotoStore, isPhotoStoreReady, uploadPhoto, deletePhoto, cleanupOrphanedPhotos } from './photostore.js';

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

let _docFn, _getDocFn, _getDocFromServerFn, _setDocFn, _updateDocFn, _onSnapshotFn, _signOutFn, _GoogleProvider;
let _signInRedirectFn, _getRedirectResultFn;
let _arrayUnionFn, _deleteFieldFn, _deleteDocFn;

// Last confirmed server trips (fromCache:false snapshot).
// Used by syncToFirestore to merge before writing so we never silently
// overwrite trips added by another device in the same write window.
let _lastServerTrips = null;
let _onSyncError     = null;

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
    // Non-blocking — sync falls back to embedding compressed photos in
    // Firestore directly if Storage never becomes ready.
    initPhotoStore(app);
    _db   = dbMod.getFirestore(app);

    _docFn               = dbMod.doc;
    _getDocFn            = dbMod.getDoc;
    _getDocFromServerFn  = dbMod.getDocFromServer;
    _setDocFn            = dbMod.setDoc;
    _updateDocFn         = dbMod.updateDoc;
    _onSnapshotFn        = dbMod.onSnapshot;
    _signOutFn           = authMod.signOut;
    _GoogleProvider      = authMod.GoogleAuthProvider;
    _signInRedirectFn    = authMod.signInWithRedirect;
    _getRedirectResultFn = authMod.getRedirectResult;
    _arrayUnionFn        = dbMod.arrayUnion;
    _deleteFieldFn       = dbMod.deleteField;
    _deleteDocFn         = dbMod.deleteDoc;

    // Enable Firestore offline persistence (IndexedDB) so reads/writes work
    // without network and sync automatically when connection returns.
    if (dbMod.enableIndexedDbPersistence) {
      dbMod.enableIndexedDbPersistence(_db).catch(err => {
        if (err.code !== 'failed-precondition' && err.code !== 'unimplemented') {
          console.warn('[carnet] Firestore offline persistence:', err.code);
        }
      });
    }

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
      // Seed the merge cache so syncToFirestore has server trips available
      // immediately (before the first listenUserDoc event fires).
      if (cloudData?.trips) _lastServerTrips = cloudData.trips;
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
  // Do NOT clear _user/_uid here: a pending 400 ms debounce timer may still
  // be counting down, and syncToFirestore guards on _uid. Let signOut() fire
  // onAuthStateChanged which will clear them after Firebase confirms the logout.
  _lastServerTrips = null;
  await _signOutFn(_auth);
}

export function setSyncErrorCallback(fn) { _onSyncError = fn; }

/**
 * Push the full app state to the user's Firestore document.
 *
 * Before writing we reconcile against the last confirmed server snapshot
 * (_lastServerTrips):
 *  - Trips present on the server but missing locally (not deleted) are kept,
 *    so this write doesn't silently drop a trip added on another device that
 *    hasn't reached this one yet.
 *  - Trips present on BOTH sides keep whichever copy is actually newer. Without
 *    this, a device holding a stale local copy of a trip (e.g. it missed a
 *    real-time update while asleep/offline) would clobber a newer edit made
 *    on another device the next time it pushes its own full state — this is
 *    how an edit made on one device could silently fail to "stick" once a
 *    second device synced afterwards.
 *  - Trips tombstoned in state.deletedTrips (or the just-deleted ids passed
 *    in) are never re-added, even from a stale _lastServerTrips snapshot.
 *
 * Every trip's embedded base64 photos are also re-compressed before the
 * write. This document holds ALL of the user's trips at once, so it hits
 * Firestore's 1 MB limit far more easily than any single trip — without
 * this, a sync with real photos in it fails on every single attempt (not
 * just intermittently), leaving the device stuck saving to localStorage
 * only and never reaching the cloud. Local storage / display keep the
 * original full-resolution photos; only this synced copy is compressed.
 */

/**
 * Build the trips array actually written to Firestore: try uploading every
 * photo to Cloud Storage first (the document then only ever holds short
 * download-URL strings, so it stays tiny no matter how large the photo
 * library grows). A photo whose upload fails (Storage not truly reachable —
 * wrong security rules, Blaze not active yet, offline, quota…) is NEVER
 * silently dropped: it falls back to being embedded as a compressed copy,
 * same as before the Storage migration. If that still doesn't fit the 1 MB
 * document limit (Storage genuinely down for a large library), the whole
 * batch falls back to the proven tiered-compression + strip-photos pipeline
 * in compressTripsForFirestore, which always succeeds.
 */
async function _buildCloudTrips(tripsToWrite) {
  if (!isPhotoStoreReady()) return compressTripsForFirestore(tripsToWrite);

  const uploaded = await Promise.all(tripsToWrite.map(t => transformTripPhotos(t, async b64 => {
    const url = await uploadPhoto(_uid, b64);
    if (url) return url;
    return (await compressPhotoDataUrl(b64)) || '';
  })));

  if (JSON.stringify(uploaded).length <= FIRESTORE_SIZE_LIMIT) return uploaded;
  return compressTripsForFirestore(tripsToWrite);
}

/** Every Storage download URL referenced anywhere across a set of trips. */
function _collectStorageUrls(trips) {
  const urls  = new Set();
  const check = url => { if (typeof url === 'string' && url.includes('firebasestorage')) urls.add(url); };
  for (const t of (trips || [])) {
    check(t.photo);
    for (const p of (t.photos || [])) check(p.url);
    for (const day of (t.days || [])) {
      for (const item of (day.items || [])) {
        check(item.photo);
        for (const p of (item.photos || [])) check(p.url);
        for (const p of (item.journalData?.photos || [])) check(p);
      }
    }
    for (const je of (t.journalEntries || [])) {
      for (const p of (je.photos || [])) check(p.url);
    }
  }
  return urls;
}

export async function syncToFirestore(localState, recentlyDeletedIds = []) {
  if (!_db || !_uid || !_setDocFn || !_docFn) return;
  try {
    const localTrips = localState.trips || [];
    let tripsToWrite = localTrips;

    if (_lastServerTrips) {
      const deletedSet = new Set([...recentlyDeletedIds, ...Object.keys(localState.deletedTrips || {})]);
      const serverById = new Map(_lastServerTrips.map(t => [t.id, t]));
      const localIds   = new Set(localTrips.map(t => t.id));

      const reconciled = localTrips.map(lt => {
        const st = serverById.get(lt.id);
        return (st && (st.updatedAt || 0) > (lt.updatedAt || 0)) ? st : lt;
      });

      const missing = _lastServerTrips.filter(t => !localIds.has(t.id) && !deletedSet.has(t.id));
      tripsToWrite = [...reconciled, ...missing];
    }

    const cloudTrips = await _buildCloudTrips(tripsToWrite);

    const stateToWrite = { ...localState, trips: cloudTrips };
    await _setDocFn(_docFn(_db, 'users', _uid), JSON.parse(JSON.stringify(stateToWrite)), { merge: true });

    // Clean up Storage files that dropped out of every trip since the last
    // confirmed write (photo removed, or the whole trip deleted) — otherwise
    // they'd sit in Storage forever as unreferenced, silently billed orphans.
    // Best-effort: never blocks or fails the sync (deletePhoto swallows its
    // own errors).
    if (_lastServerTrips) {
      const prevUrls = _collectStorageUrls(_lastServerTrips);
      const newUrls  = _collectStorageUrls(cloudTrips);
      for (const url of prevUrls) {
        if (!newUrls.has(url)) deletePhoto(url);
      }
    }

    // Keep our cache current with what we just wrote
    _lastServerTrips = stateToWrite.trips || null;
  } catch (err) {
    console.warn('[auth] Firestore sync failed:', err.message);
    if (_onSyncError) _onSyncError(err);
  }
}

/**
 * One-time bulk cleanup of Storage duplicates/orphans accumulated before the
 * per-sync cleanup in syncToFirestore existed (each app reopen used to
 * re-upload every photo as a brand-new file — see photostore.js's upload
 * cache). Force-fetches the server copy fresh (getDocFromServer, not the
 * IndexedDB cache) so a trip added on another device but not yet synced down
 * here still counts as "referenced" — its photos must never be deleted just
 * because this device hasn't caught up yet. Local trips are unioned in on
 * top for the same reason (this device may have unsynced local edits).
 * Returns { scanned, removed }.
 */
export async function cleanupDuplicatePhotos(localTrips) {
  if (!_db || !_uid || !_docFn) return { scanned: 0, removed: 0 };
  let serverTrips = [];
  try {
    const fetchFn = _getDocFromServerFn || _getDocFn;
    const snap = await fetchFn(_docFn(_db, 'users', _uid));
    if (snap.exists()) serverTrips = snap.data().trips || [];
  } catch (err) {
    console.warn('[auth] cleanupDuplicatePhotos fetch failed:', err.message);
  }
  const referencedUrls = new Set([
    ..._collectStorageUrls(serverTrips),
    ..._collectStorageUrls(localTrips || []),
  ]);
  return cleanupOrphanedPhotos(_uid, referencedUrls);
}

// ── Shared trips ───────────────────────────────────────────────────────────────

/** Write the full shared trip document (first share). */
export async function initSharedTripInFirestore(tripId, tripData, ownerId, ownerName) {
  if (!_db || !_setDocFn || !_docFn) return;
  await _setDocFn(_docFn(_db, 'shared_trips', tripId), JSON.parse(JSON.stringify({
    trip: tripData,
    ownerId,
    members: { [ownerId]: { role: 'owner', companionId: null, companionName: ownerName || 'Organisateur' } },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })));
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
    JSON.parse(JSON.stringify({ trip: tripData, updatedAt: new Date().toISOString() })),
    { merge: true },
  );
}

/**
 * Subscribe to real-time updates on a shared trip.
 * Calls callback(data, hasPendingWrites) when the doc changes.
 * Calls callback(null, false) when the doc is deleted (owner removed it).
 * @returns {Function} unsubscribe function
 */
export function listenSharedTrip(tripId, callback) {
  if (!_db || !_onSnapshotFn || !_docFn) return () => {};
  return _onSnapshotFn(_docFn(_db, 'shared_trips', tripId), snap => {
    callback(snap.exists() ? snap.data() : null, snap.metadata.hasPendingWrites);
  });
}

/** Hard-delete the shared_trips/{tripId} document (called by owner after marking deleted). */
export async function deleteSharedTripDoc(tripId) {
  if (!_db || !_deleteDocFn || !_docFn) return;
  try { await _deleteDocFn(_docFn(_db, 'shared_trips', tripId)); } catch (_) {}
}

/**
 * Subscribe to real-time updates on the current user's personal document.
 * Used to keep multiple tabs / devices in sync: when another device pushes
 * a state update, the listener fires here and we can merge it in.
 * @returns {Function} unsubscribe function
 */
export function listenUserDoc(uid, callback) {
  if (!_db || !_onSnapshotFn || !_docFn || !uid) return () => {};
  // includeMetadataChanges: true lets us see fromCache flag on every event.
  // We skip cache-only snapshots so we only process confirmed server writes
  // from other devices — this prevents stale IndexedDB cache from blocking
  // real-time updates from other devices.
  return _onSnapshotFn(
    _docFn(_db, 'users', uid),
    { includeMetadataChanges: true },
    snap => {
      if (!snap.exists()) return;
      // fromCache: true = served from local IndexedDB before server confirmed — skip
      if (snap.metadata.fromCache) return;
      // Track the latest confirmed server trips so syncToFirestore can merge
      // before writing and avoid overwriting cross-device additions.
      _lastServerTrips = snap.data().trips || null;
      callback(snap.data(), snap.metadata.hasPendingWrites);
    },
    err => console.warn('[auth] listenUserDoc error:', err.message),
  );
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
  if (!_db || !_uid || !_docFn) return null;
  const ref = _docFn(_db, 'users', _uid);
  try {
    // getDocFromServer bypasses the IndexedDB cache so we always get the latest
    // data from the server, even if another device wrote while this one was offline.
    const fetchFn = _getDocFromServerFn || _getDocFn;
    const snap = await Promise.race([
      fetchFn(ref),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
    ]);
    return snap.exists() ? snap.data() : null;
  } catch (err) {
    console.warn('[auth] Firestore server load failed, falling back to cache:', err.message);
    // Fall back to cached read on timeout / offline
    try {
      if (_getDocFn) {
        const cached = await _getDocFn(ref);
        return cached.exists() ? cached.data() : null;
      }
    } catch (_) {}
    return null;
  }
}
