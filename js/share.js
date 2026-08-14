/* ============================================================
   CARNET DE VOYAGES — Real-time Trip Sharing
   ============================================================
   Flow:
   1. Owner clicks "Partager" → openShareModal(tripId)
      → writes to shared_trips/{tripId} + invites/{token}
      → shows modal with link + QR code
   2. Invitee opens ?invite=TOKEN link
      → handlePendingInvite(user) reads the token after auth
      → shows companion picker
      → on pick: joinSharedTrip() + _loadAndListen(tripId)
   3. Any member edits a trip → updateTrip() in store.js
      → _onLocalSharedTripEdit() → saveSharedTrip() writes to Firestore
      → onSnapshot on all other clients fires
      → _onNetworkUpdate() → replaceTripFromNetwork() → re-render
*/

import {
  initSharedTripInFirestore, saveSharedTrip,
  listenSharedTrip, createInvite, loadInvite,
  loadSharedTrip, joinSharedTrip, updateLastPublished,
  isFirebaseConfigured, getCurrentUser,
  addComment, updatePresence, clearPresence, addActivityEntry,
  removeMemberFromSharedTrip,
  updateSharedTripFields, deleteSharedTripField,
  deleteSharedTripDoc,
} from './auth.js';
import {
  getTrip, markTripShared, unmarkTripShared, isTripShared,
  replaceTripFromNetwork, setSharedSyncCallback,
  getSharedTripIds, setSharedTripIds, getSettings,
  hasPendingLocalChanges, deleteTrip, clearDeletedTrip,
} from './store.js';
import { notifyCollaboratorChange } from './notifications.js';
import { showModal, closeModal, notify, compressTripsForFirestore } from './utils.js';

// ── Module state ────────────────────────────────────────────────────────────────

const _listeners      = new Map(); // tripId → unsubscribe fn
const _sharedDocData  = new Map(); // tripId → latest full Firestore doc
let   _sharedTripIds  = [];
let   _presenceInterval = null;    // heartbeat timer

// ── Observer role cache (localStorage) ───────────────────────────────────────
// Lets isCurrentUserObserver() return synchronously on first render, before
// _sharedDocData is populated by the async Firestore load.

function _obsRoleCacheKey(uid) { return `_obsroles_${uid}`; }

function _obsGetCachedIds(uid) {
  try { return new Set(JSON.parse(localStorage.getItem(_obsRoleCacheKey(uid)) || '[]')); }
  catch(_) { return new Set(); }
}

function _obsUpdateCache(uid, tripId, isObserver) {
  const ids = _obsGetCachedIds(uid);
  isObserver ? ids.add(tripId) : ids.delete(tripId);
  localStorage.setItem(_obsRoleCacheKey(uid), JSON.stringify([...ids]));
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

const _esc = s => String(s || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function _initials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return parts[0].slice(0, 2).toUpperCase();
}

function _genToken() {
  try { return crypto.randomUUID().replace(/-/g, ''); }
  catch { return Math.random().toString(36).slice(2, 11) + Date.now().toString(36); }
}

// ── Shared doc data accessors ────────────────────────────────────────────────────

/** Returns the latest full Firestore doc snapshot for a shared trip, or null. */
export function getSharedDocData(tripId) {
  return _sharedDocData.get(tripId) || null;
}

/** Returns true if the current user has the 'observer' role on this trip. */
export function isCurrentUserObserver(tripId) {
  const user = getCurrentUser();
  if (!user) return false;
  const doc = _sharedDocData.get(tripId);
  if (doc) return doc.members?.[user.uid]?.role === 'observer';
  // Synchronous fallback while the Firestore doc is still loading
  return _obsGetCachedIds(user.uid).has(tripId);
}

/**
 * Called when a traveler validates a journal day.
 * Writes lastPublished to Firestore so observers receive a real-time notification.
 */
export async function publishDay(tripId, dayNum, dayTitle, itemText = '') {
  const user = getCurrentUser();
  if (!user) return;
  const sharedDoc = _sharedDocData.get(tripId);
  if (!sharedDoc) return;
  const actorName = sharedDoc.members?.[user.uid]?.companionName
    || user.displayName || 'Un voyageur';
  const tripName = sharedDoc.trip?.name || 'ce voyage';
  const dayLabel = dayTitle ? `Jour ${dayNum} · ${dayTitle}` : `Jour ${dayNum}`;
  await updateLastPublished(tripId, {
    dayNum,
    dayTitle:  dayTitle  || '',
    itemText:  itemText  || '',
    actorName,
    tripName,
    dayLabel,
    ts: new Date().toISOString(),
  }).catch(() => {});
}

/**
 * Toggle a ❤️ reaction from the current user on a validated activity item.
 * Calling again removes the reaction (toggle).
 */
export async function addObserverReaction(tripId, itemId) {
  const user = getCurrentUser();
  if (!user) return;
  const sharedDoc = _sharedDocData.get(tripId);
  if (!sharedDoc) return;

  const existing = sharedDoc.reactions?.[itemId]?.[user.uid];
  const removing  = existing === '❤️';

  // Optimistic local update
  const reactions = JSON.parse(JSON.stringify(sharedDoc.reactions || {}));
  if (!reactions[itemId]) reactions[itemId] = {};
  if (removing) {
    delete reactions[itemId][user.uid];
  } else {
    reactions[itemId][user.uid] = '❤️';
  }
  _sharedDocData.set(tripId, { ...sharedDoc, reactions });
  _refreshJournalIfVisible(tripId);

  try {
    if (removing) {
      await deleteSharedTripField(tripId, `reactions.${itemId}.${user.uid}`);
    } else {
      await updateSharedTripFields(tripId, { [`reactions.${itemId}.${user.uid}`]: '❤️' });
    }
  } catch (_) {}
}

/**
 * Add a text comment from the current observer on a validated activity item.
 */
export async function addObserverComment(tripId, itemId, text) {
  const user = getCurrentUser();
  if (!user || !text?.trim()) return;
  const sharedDoc = _sharedDocData.get(tripId);
  if (!sharedDoc) return;

  const authorName = sharedDoc.members?.[user.uid]?.companionName
    || user.displayName || 'Observateur';
  const commentId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const comment = {
    itemId,
    uid: user.uid,
    name: authorName,
    text: text.trim(),
    ts: new Date().toISOString(),
  };

  // Optimistic local update
  const observerComments = { ...(sharedDoc.observerComments || {}), [commentId]: comment };
  _sharedDocData.set(tripId, { ...sharedDoc, observerComments });
  _refreshJournalIfVisible(tripId);

  try {
    await updateSharedTripFields(tripId, { [`observerComments.${commentId}`]: comment });
  } catch (_) {}
}

/**
 * Delete one of the current user's observer comments.
 */
export async function deleteObserverComment(tripId, commentId) {
  const user = getCurrentUser();
  if (!user) return;
  const sharedDoc = _sharedDocData.get(tripId);
  if (!sharedDoc) return;

  const comment = sharedDoc.observerComments?.[commentId];
  if (!comment) return;
  const myRole = sharedDoc.members?.[user.uid]?.role;
  const canDel = comment.uid === user.uid || myRole === 'owner' || myRole === 'member';
  if (!canDel) return;

  // Optimistic local update
  const observerComments = { ...(sharedDoc.observerComments || {}) };
  delete observerComments[commentId];
  _sharedDocData.set(tripId, { ...sharedDoc, observerComments });
  _refreshJournalIfVisible(tripId);

  try {
    await deleteSharedTripField(tripId, `observerComments.${commentId}`);
  } catch (_) {}
}

/**
 * Remove a specific UID's reaction on an item.
 * Observer can remove their own; owner/member can remove any.
 */
export async function deleteObserverReaction(tripId, itemId, targetUid) {
  const user = getCurrentUser();
  if (!user) return;
  const sharedDoc = _sharedDocData.get(tripId);
  if (!sharedDoc) return;
  const myRole = sharedDoc.members?.[user.uid]?.role;
  if (user.uid !== targetUid && myRole !== 'owner' && myRole !== 'member') return;

  const reactions = JSON.parse(JSON.stringify(sharedDoc.reactions || {}));
  if (reactions[itemId]) delete reactions[itemId][targetUid];
  _sharedDocData.set(tripId, { ...sharedDoc, reactions });
  _refreshJournalIfVisible(tripId);

  try {
    await deleteSharedTripField(tripId, `reactions.${itemId}.${targetUid}`);
  } catch (_) {}
}

/** Compress a single trip's photos for a shared_trips write (1 MB document limit). */
async function _compressForSharing(trip) {
  const [compressed] = await compressTripsForFirestore([trip]);
  return compressed;
}

function _refreshJournalIfVisible(tripId) {
  if (typeof window._refreshJournalInteractions === 'function') {
    window._refreshJournalInteractions(tripId);
  }
}

/**
 * Remove a companion from a shared trip by their companion ID.
 * Finds the UID of whoever claimed that companion slot, then revokes Firestore access.
 */
export async function removeSharedTripMember(tripId, companionId) {
  const doc = _sharedDocData.get(tripId);
  if (!doc?.members) return;
  const entry = Object.entries(doc.members).find(([, m]) => m.companionId === companionId);
  if (!entry) return;
  const [memberUid] = entry;
  await removeMemberFromSharedTrip(tripId, memberUid);
}

/**
 * Submit a comment on a day — authored as the current user's companion name.
 * Optimistically updates the local cache so the comment appears immediately.
 */
export async function submitComment(tripId, dayId, text) {
  const user = getCurrentUser();
  if (!user || !text?.trim()) return;
  const sharedDoc = _sharedDocData.get(tripId);
  const authorName = sharedDoc?.members?.[user.uid]?.companionName || user.displayName || 'Moi';

  // Optimistic local update so the comment appears before Firestore confirms
  if (sharedDoc) {
    const comment = {
      id: Date.now().toString(36),
      author: authorName,
      uid: user.uid,
      text: text.trim(),
      ts: new Date().toISOString(),
    };
    const dayComments = [...(sharedDoc.comments?.[dayId] || []), comment];
    _sharedDocData.set(tripId, {
      ...sharedDoc,
      comments: { ...(sharedDoc.comments || {}), [dayId]: dayComments },
    });
    if (typeof window._rerenderCurrentView === 'function') {
      window._rerenderCurrentView(tripId);
    }
  }

  await addComment(tripId, dayId, text.trim(), authorName);
}

/**
 * Delete a day comment by id. Removes it locally and overwrites the
 * day's comment array in Firestore (no arrayRemove — filter + rewrite).
 */
export async function deleteDayComment(tripId, dayId, commentId) {
  const sharedDoc = _sharedDocData.get(tripId);
  if (!sharedDoc) return;
  const filtered = (sharedDoc.comments?.[dayId] || []).filter(c => c.id !== commentId);
  _sharedDocData.set(tripId, {
    ...sharedDoc,
    comments: { ...(sharedDoc.comments || {}), [dayId]: filtered },
  });
  if (typeof window._rerenderCurrentView === 'function') {
    window._rerenderCurrentView(tripId);
  }
  await updateSharedTripFields(tripId, { [`comments.${dayId}`]: filtered });
}

// ── Initialisation ──────────────────────────────────────────────────────────────

/**
 * Called by the OWNER when permanently deleting a shared trip.
 * Writes deleted:true so all connected members/observers see it instantly,
 * then hard-deletes the document after a short delay.
 */
export async function deleteOwnerSharedTrip(tripId) {
  const user    = getCurrentUser();
  const doc     = _sharedDocData.get(tripId);
  const isOwner = doc?.members?.[user?.uid]?.role === 'owner';

  if (isOwner) {
    // Flag first so connected clients react before the doc disappears
    await updateSharedTripFields(tripId, { deleted: true }).catch(() => {});
    // Hard-delete after 3 s (enough time for Firestore to propagate the flag)
    setTimeout(() => deleteSharedTripDoc(tripId), 3000);
  }

  await leaveSharedTrip(tripId);
}

/**
 * Stop listening to a shared trip and remove it from the user's sharedTripIds.
 * Called when the user deletes a trip locally — the Firestore doc is kept intact
 * so other collaborators are unaffected.
 */
export async function leaveSharedTrip(tripId) {
  // Delete from _listeners FIRST — any in-transit Firestore event will see the
  // map is empty and bail out in _onNetworkUpdate, preventing the trip from
  // being re-injected into state after the delete.
  const unsub = _listeners.get(tripId);
  _listeners.delete(tripId);
  if (unsub) unsub();

  clearPresence(tripId).catch(() => {});
  _sharedDocData.delete(tripId);

  // Unmark so store.updateTrip no longer pushes edits to the shared doc.
  unmarkTripShared(tripId);

  // Clear observer-role localStorage cache so isCurrentUserObserver() returns false immediately.
  const user = getCurrentUser();
  if (user?.uid) _obsUpdateCache(user.uid, tripId, false);

  // Remove our own member entry from the shared doc too — otherwise this
  // cleanup only touched local device state, so the owner (and everyone
  // else) kept seeing this person in the traveler/observer list and count
  // forever, even though they'd actually left. Best-effort: the local
  // leave must still succeed even if this write fails (offline, etc.).
  if (user?.uid) removeMemberFromSharedTrip(tripId, user.uid).catch(() => {});

  // Remove from local list and persist via store state (syncToFirestore picks it up).
  _sharedTripIds = _sharedTripIds.filter(id => id !== tripId);
  setSharedTripIds(_sharedTripIds);
}

/**
 * Called once after login with the user's cloudData.
 * Loads any previously shared trips and starts real-time listeners.
 */
export async function initSharedTrips(cloudData) {
  if (!isFirebaseConfigured()) return;

  // Read from store state (set by setState(cloudData) before this call) so
  // sharedTripIds is always in sync with the rest of the persisted state.
  _sharedTripIds = [...getSharedTripIds()];

  setSharedSyncCallback(_onLocalSharedTripEdit);

  await Promise.all(_sharedTripIds.map(id => _loadAndListen(id)));

  // Presence heartbeat: refresh every 45 s so peers see us as online
  if (_presenceInterval) clearInterval(_presenceInterval);
  _presenceInterval = setInterval(_heartbeat, 45_000);

  // Clean up presence on tab/window close
  window.addEventListener('beforeunload', _onBeforeUnload, { once: true });
}

/**
 * Load a shared trip from Firestore, merge into local state, and start
 * an onSnapshot listener. Safe to call multiple times (idempotent) — but the
 * local-state sync below must always run, even on a repeat call: bailing out
 * early just because a listener already exists (as this used to do, checked
 * first thing) skipped populating _sharedDocData/replaceTripFromNetwork/the
 * observer cache on any call after the very first one for a given tripId,
 * which could leave a freshly-joined trip completely invisible locally
 * (never in "Mes observations") despite the Firestore membership write
 * having genuinely succeeded.
 */
async function _loadAndListen(tripId) {
  const doc = await loadSharedTrip(tripId);
  if (!doc?.trip) return;

  markTripShared(tripId);
  const user      = getCurrentUser();
  const myRole    = doc.members?.[user?.uid]?.role;
  const localTrip = getTrip(tripId);

  // Self-heal: on old shared trips created before the owner's real display
  // name was passed through, the owner's member entry was written with the
  // literal placeholder "Organisateur" and nothing ever rewrote it since —
  // fix it in place as soon as the owner's own device sees a real name to use.
  if (myRole === 'owner' && user.displayName
      && doc.members[user.uid].companionName === 'Organisateur'
      && user.displayName !== 'Organisateur') {
    const fixedName = user.displayName;
    doc.members[user.uid] = { ...doc.members[user.uid], companionName: fixedName };
    updateSharedTripFields(tripId, { [`members.${user.uid}.companionName`]: fixedName }).catch(() => {});
  }
  if (myRole === 'observer') {
    // Observers can't edit — always take the cloud version
    replaceTripFromNetwork(tripId, doc.trip);
  } else if (!localTrip || (doc.trip.updatedAt || 0) > (localTrip.updatedAt || 0)) {
    // Cloud is strictly newer — some other device edited since our last sync.
    replaceTripFromNetwork(tripId, doc.trip);
  } else if ((doc.trip.updatedAt || 0) < (localTrip.updatedAt || 0)) {
    // Local version is newer — push it to Firestore instead of overwriting
    _compressForSharing(localTrip).then(s => saveSharedTrip(tripId, s)).catch(() => {});
  }
  // else: same updatedAt — this is our own previously-synced edit. Keep the
  // local copy (full-resolution photos) rather than pulling back the
  // compressed shared_trips copy, which would silently degrade photo quality
  // (and cause a visible re-render/"flicker") on every reload for no reason.
  _sharedDocData.set(tripId, doc);

  // Persist observer role so isCurrentUserObserver() resolves synchronously on next load
  if (user?.uid) _obsUpdateCache(user.uid, tripId, myRole === 'observer');

  // Mark current user as present
  if (user) {
    const member = doc.members?.[user.uid];
    updatePresence(tripId, member?.companionId || null, member?.companionName || user.displayName)
      .catch(() => {});
  }

  if (_listeners.has(tripId)) return; // listener already live — don't double-subscribe
  const unsub = listenSharedTrip(tripId, (data, hasPendingWrites) => {
    _onNetworkUpdate(tripId, data, hasPendingWrites);
  });
  _listeners.set(tripId, unsub);
}

// ── Sync callbacks ──────────────────────────────────────────────────────────────

/** store.js calls this when a shared trip is mutated locally. */
function _onLocalSharedTripEdit(tripId, tripData, action = 'a modifié le voyage') {
  // Write an activity log entry so collaborators see who made the change
  const user = getCurrentUser();
  if (user) {
    const sharedDoc = _sharedDocData.get(tripId);
    const actorName = sharedDoc?.members?.[user.uid]?.companionName
      || user.displayName || 'Quelqu\'un';
    addActivityEntry(tripId, {
      actor: actorName,
      action,
      ts: new Date().toISOString(),
    }).catch(() => {});
  }

  _compressForSharing(tripData)
    .then(sanitized => saveSharedTrip(tripId, sanitized))
    .catch(err => console.warn('[share] failed to push shared trip:', err.message));
}

/** Firestore listener fires this for every snapshot (local + remote). */
function _onNetworkUpdate(tripId, data, hasPendingWrites) {
  // Drop events that arrive after the user left/deleted the trip.
  if (!_listeners.has(tripId)) return;

  // Document deleted or marked deleted by owner → auto-remove for all members/observers
  if (!data || data.deleted) {
    const user    = getCurrentUser();
    const isOwner = _sharedDocData.get(tripId)?.members?.[user?.uid]?.role === 'owner';
    if (!isOwner) {
      leaveSharedTrip(tripId);
      deleteTrip(tripId);
      notify('Ce voyage partagé a été supprimé par son propriétaire.', '🗑');
      if (typeof window.goHome === 'function') window.goHome();
    }
    return;
  }

  if (!data.trip) return;

  const prevData = _sharedDocData.get(tripId);

  // Detect if the current user was removed from members by the owner
  const user = getCurrentUser();
  if (user && prevData?.members?.[user.uid] && !data.members?.[user.uid]) {
    leaveSharedTrip(tripId);
    // leaveSharedTrip() only unmarks the trip as shared — without also
    // deleting the local copy, it stayed in state.trips looking like an
    // ordinary owned trip and reappeared in "Mes voyages" instead of
    // just disappearing.
    deleteTrip(tripId);
    notify('Vous avez été retiré de ce voyage partagé.', 'ℹ️');
    if (typeof window.goHome === 'function') window.goHome();
    return;
  }

  _sharedDocData.set(tripId, data);
  // Only overwrite local trip state when all local writes are confirmed.
  // hasPendingWrites: Firestore hasn't ACKed the last write yet.
  // hasPendingLocalChanges: within the 400ms debounce before we've even sent it.
  if (!hasPendingWrites && !hasPendingLocalChanges()) {
    replaceTripFromNetwork(tripId, data.trip);
  }

  // Lightweight presence-dot refresh (no full re-render needed)
  if (typeof window._refreshPresenceDots === 'function') {
    window._refreshPresenceDots(tripId, data.presence || {});
  }

  // Re-render: only when trip data changed (updatedAt) OR comments/reactions changed
  const tripChanged           = !prevData || prevData.updatedAt !== data.updatedAt;
  const commentsChanged       = JSON.stringify(prevData?.comments) !== JSON.stringify(data.comments);
  const reactionsChanged      = JSON.stringify(prevData?.reactions) !== JSON.stringify(data.reactions);
  const obsCommentsChanged    = JSON.stringify(prevData?.observerComments) !== JSON.stringify(data.observerComments);

  // Observer notification: fire when lastPublished.ts changes
  if (!hasPendingWrites && prevData) {
    const prevPubTs = prevData.lastPublished?.ts;
    const newPubTs  = data.lastPublished?.ts;
    if (newPubTs && newPubTs !== prevPubTs) {
      const user   = getCurrentUser();
      const myRole = data.members?.[user?.uid]?.role;
      if (myRole === 'observer') {
        _showPublishNotification(data.lastPublished, data.members);
      }
    }
  }

  // Browser notification for remote collaborator changes
  if (!hasPendingWrites && tripChanged) {
    const acts = data.activity || [];
    const latestActor = acts.length > 0 ? acts[acts.length - 1].actor : null;
    notifyCollaboratorChange(getTrip(tripId)?.name, latestActor, getSettings());
  }

  if ((!hasPendingWrites && tripChanged) || commentsChanged) {
    if (typeof window._rerenderCurrentView === 'function') {
      window._rerenderCurrentView(tripId);
    }
  }

  if (!hasPendingWrites && (reactionsChanged || obsCommentsChanged)) {
    _refreshJournalIfVisible(tripId);
  }
}

function _showPublishNotification(pub, members) {
  const { actorName, tripName, dayNum, dayTitle, itemText } = pub || {};

  // Build list of all trip collaborators (owner + members)
  const memberNames = Object.values(members || {})
    .filter(m => m.role === 'owner' || m.role === 'member')
    .map(m => m.companionName).filter(Boolean);

  let authorPart;
  if (memberNames.length === 0) {
    authorPart = actorName || 'Un voyageur';
  } else if (memberNames.length === 1) {
    authorPart = memberNames[0];
  } else {
    authorPart = memberNames.slice(0, -1).join(', ') + ' et ' + memberNames[memberNames.length - 1];
  }
  const verb     = memberNames.length > 1 ? 'ont' : 'a';
  const evtPart  = itemText ? `l'événement "${itemText}"` : 'un événement';
  const dayPart  = dayTitle ? `Jour ${dayNum} · ${dayTitle}` : `Jour ${dayNum}`;
  const msg      = `${authorPart} ${verb} publié ${evtPart} du ${dayPart} de leur voyage "${tripName || 'ce voyage'}"`;

  notify(msg, '📡');
  const s = getSettings();
  if (s?.notifications?.enabled && s.notifications.observerPublish !== false && Notification?.permission === 'granted') {
    try { new Notification('Carnet de Voyages', { body: msg, icon: '/icons/icon-192.png' }); } catch (_) {}
  }
}

/** Refresh presence heartbeat for all active shared trips. */
function _heartbeat() {
  const user = getCurrentUser();
  if (!user) return;
  for (const tripId of _listeners.keys()) {
    const sharedDoc = _sharedDocData.get(tripId);
    const member    = sharedDoc?.members?.[user.uid];
    updatePresence(tripId, member?.companionId || null, member?.companionName || user.displayName)
      .catch(() => {});
  }
}

/** Called on page/tab close — best-effort presence cleanup. */
function _onBeforeUnload() {
  if (_presenceInterval) { clearInterval(_presenceInterval); _presenceInterval = null; }
  const user = getCurrentUser();
  if (!user) return;
  for (const tripId of [..._listeners.keys()]) {
    clearPresence(tripId).catch(() => {});
  }
}

// ── Share modal (owner side) ────────────────────────────────────────────────────

/**
 * Open the share modal for a trip.
 * If the trip isn't shared yet, initialise the shared_trips document first.
 */
export async function openShareModal(tripId) {
  const trip = getTrip(tripId);
  if (!trip) return;

  if (!isFirebaseConfigured()) {
    showModal(`
      <button class="mc" onclick="closeModal()">✕</button>
      <h3 class="modal-title">Partager un voyage</h3>
      <p style="color:var(--ink3);font-size:13px;margin-bottom:16px">
        Le partage en temps réel nécessite Firebase.<br>
        Configurez <code>js/firebase-config.js</code> pour activer cette fonctionnalité.
      </p>
      <div class="ma"><button class="bc" onclick="closeModal()">Fermer</button></div>
    `);
    return;
  }

  const user = getCurrentUser();
  if (!user) return;

  // Loading state
  showModal(`
    <button class="mc" onclick="closeModal()">✕</button>
    <h3 class="modal-title">Partager — ${_esc(trip.flag)} ${_esc(trip.name)}</h3>
    <div style="display:flex;justify-content:center;padding:32px">
      <div class="login-spinner"></div>
    </div>
  `);

  try {
    // First share: create shared_trips document and start listener
    if (!isTripShared(tripId)) {
      const ownerName = user.displayName || user.email?.split('@')[0] || 'Organisateur';
      await initSharedTripInFirestore(tripId, await _compressForSharing(trip), user.uid, ownerName);
      markTripShared(tripId);
      setSharedSyncCallback(_onLocalSharedTripEdit);

      if (!_sharedTripIds.includes(tripId)) {
        _sharedTripIds.push(tripId);
        setSharedTripIds(_sharedTripIds);
      }

      if (!_listeners.has(tripId)) {
        const unsub = listenSharedTrip(tripId, (data, hasPendingWrites) =>
          _onNetworkUpdate(tripId, data, hasPendingWrites));
        _listeners.set(tripId, unsub);
      }

      // Mark owner as present
      updatePresence(tripId, null, user.displayName || 'Organisateur').catch(() => {});
    }

    // Generate two fresh invite tokens: one for collaborators, one for observers
    const collabToken = _genToken();
    const obsToken    = _genToken();
    await Promise.all([
      createInvite(collabToken, tripId, 'member'),
      createInvite(obsToken, tripId, 'observer'),
    ]);

    const baseUrl   = `${location.origin}${location.pathname}`;
    const collabUrl = `${baseUrl}?invite=${collabToken}`;
    const obsUrl    = `${baseUrl}?invite=${obsToken}`;

    const sharedDoc = await loadSharedTrip(tripId);
    const members   = sharedDoc?.members || {};
    const isOwner   = members[user.uid]?.role === 'owner';

    showModal(_shareModalHtml(trip, collabUrl, obsUrl, members, isOwner));

    document.getElementById('share-copy-collab')?.addEventListener('click', () => {
      navigator.clipboard?.writeText(collabUrl).then(() => {
        const btn = document.getElementById('share-copy-collab');
        if (btn) { btn.textContent = '✓ Copié !'; setTimeout(() => { btn.textContent = 'Copier'; }, 2000); }
      });
    });
    document.getElementById('share-copy-obs')?.addEventListener('click', () => {
      navigator.clipboard?.writeText(obsUrl).then(() => {
        const btn = document.getElementById('share-copy-obs');
        if (btn) { btn.textContent = '✓ Copié !'; setTimeout(() => { btn.textContent = 'Copier'; }, 2000); }
      });
    });

    document.getElementById('share-presentiel-btn')?.addEventListener('click', () => {
      closeModal();
      _showPresentielOverlay(trip, tripId, obsUrl);
    });

    // Owner-only: remove a participant (e.g. one who left before their own
    // self-removal fix existed, or whose device never got the chance to
    // write the removal — a manual escape hatch for a stale member/observer
    // entry that never disappears on its own).
    document.querySelectorAll('[data-action="remove-participant"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const uid  = btn.dataset.uid;
        const name = members[uid]?.companionName || 'ce participant';
        if (!confirm(`Retirer ${name} de ce voyage ?`)) return;
        btn.disabled = true;
        await removeMemberFromSharedTrip(tripId, uid).catch(() => {});
        openShareModal(tripId); // refresh the list + counts
      });
    });

  } catch (err) {
    console.error('[share] openShareModal failed:', err);
    showModal(`
      <button class="mc" onclick="closeModal()">✕</button>
      <h3 class="modal-title">Erreur</h3>
      <p style="color:var(--coral);font-size:13px;margin-bottom:16px">${_esc(err.message)}</p>
      <div class="ma"><button class="bc" onclick="closeModal()">Fermer</button></div>
    `);
  }
}

/** Sorted owner → member → observer, each with a remove button for the owner. */
function _participantsListHtml(members, isOwner) {
  const order   = { owner: 0, member: 1, observer: 2 };
  const entries = Object.entries(members || {})
    .sort(([, a], [, b]) => (order[a.role] ?? 3) - (order[b.role] ?? 3));
  if (entries.length === 0) return '';

  const roleLabels = { owner: 'Organisateur', member: 'Voyageur', observer: 'Observateur' };
  const rows = entries.map(([uid, m]) => {
    const canRemove = isOwner && m.role !== 'owner';
    return `
      <div style="display:flex;align-items:center;gap:8px;padding:5px 0">
        <div class="comp-avatar" style="width:26px;height:26px;font-size:10px;flex-shrink:0">${_initials(m.companionName)}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:12px;font-weight:700;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(m.companionName || '?')}</div>
          <div style="font-size:10px;color:var(--ink4)">${roleLabels[m.role] || m.role}</div>
        </div>
        ${canRemove ? `<button type="button" data-action="remove-participant" data-uid="${_esc(uid)}" title="Retirer"
            style="background:none;border:none;color:var(--ink4);cursor:pointer;font-size:14px;padding:2px 6px;line-height:1;flex-shrink:0">✕</button>` : ''}
      </div>`;
  }).join('');

  return `
    <div class="share-section" style="margin-top:10px">
      <div class="share-section-title" style="margin-bottom:2px">Participants</div>
      ${rows}
    </div>`;
}

function _shareModalHtml(trip, collabUrl, obsUrl, members, isOwner) {
  const guestCount  = Object.keys(members || {}).length - 1; // exclude owner
  const membersNote = guestCount > 0
    ? `<strong>${guestCount} participant${guestCount > 1 ? 's' : ''}</strong> a déjà rejoint.`
    : 'Aucun participant n\'a encore rejoint.';

  return `
    <button class="mc" onclick="closeModal()">✕</button>
    <h3 class="modal-title">Partager — ${_esc(trip.flag)} ${_esc(trip.name)}</h3>
    <p class="share-hint" style="margin-bottom:12px">${membersNote}</p>
    ${_participantsListHtml(members, isOwner)}

    <div class="share-section" style="margin-top:10px">
      <div class="share-section-hd">
        <span class="share-section-icon">✈️</span>
        <div>
          <div class="share-section-title">Inviter un voyageur</div>
          <div class="share-section-desc">Peut éditer le voyage et documenter le carnet</div>
        </div>
      </div>
      <div class="share-link-row">
        <input class="share-link-input" type="text" readonly value="${_esc(collabUrl)}" onclick="this.select()" />
        <button class="share-copy-btn" id="share-copy-collab">Copier</button>
      </div>
    </div>

    <div class="share-section" style="margin-top:10px">
      <div class="share-section-hd">
        <span class="share-section-icon">👁</span>
        <div>
          <div class="share-section-title">Inviter un observateur</div>
          <div class="share-section-desc">Suit le voyage en direct · lecture seule</div>
        </div>
      </div>
      <div class="share-link-row">
        <input class="share-link-input" type="text" readonly value="${_esc(obsUrl)}" onclick="this.select()" />
        <button class="share-copy-btn" id="share-copy-obs">Copier</button>
      </div>
      <button class="share-presentiel-btn" id="share-presentiel-btn">📺 Mode présentiel</button>
    </div>

    <div class="ma" style="margin-top:14px"><button class="bc" onclick="closeModal()">Fermer</button></div>
  `;
}

// ── Mode présentiel (QR plein écran) ────────────────────────────────────────────

function _showPresentielOverlay(trip, tripId, obsUrl) {
  document.getElementById('presentiel-overlay')?.remove();

  const sz    = Math.max(200, Math.min(Math.round(Math.min(window.innerWidth, window.innerHeight) * 0.55), 360));
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=${sz * 2}x${sz * 2}&data=${encodeURIComponent(obsUrl)}&bgcolor=ffffff&color=1a1a2e&margin=14`;

  const overlay = document.createElement('div');
  overlay.id        = 'presentiel-overlay';
  overlay.className = 'presentiel-overlay';
  overlay.setAttribute('tabindex', '-1');
  overlay.innerHTML = `
    <button class="presentiel-close" id="presentiel-close">✕</button>
    <button class="presentiel-fs-btn" id="presentiel-fs-btn" title="Plein écran">⛶</button>
    <div class="presentiel-content">
      <div class="presentiel-trip-title">${_esc(trip.flag || '')} ${_esc(trip.name)}</div>
      <div class="presentiel-qr-card">
        <img class="presentiel-qr" src="${_esc(qrUrl)}" width="${sz}" height="${sz}" alt="QR code" />
      </div>
      <div class="presentiel-hint">Scannez pour suivre ce voyage en direct</div>
      <div class="presentiel-counter" id="presentiel-counter">👁 — observateurs</div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.focus();

  let _pollTimer = null;

  async function _refreshCounter() {
    try {
      const doc = await loadSharedTrip(tripId);
      if (!doc) return;
      const members  = doc.members || {};
      const obsCount = Object.values(members).filter(m => m.role === 'observer').length;
      const el = document.getElementById('presentiel-counter');
      if (el) {
        el.textContent = obsCount === 0
          ? '👁 En attente de participants…'
          : `👁 ${obsCount} observateur${obsCount > 1 ? 's' : ''} connecté${obsCount > 1 ? 's' : ''}`;
      }
    } catch (_) {}
  }

  _refreshCounter();
  _pollTimer = setInterval(_refreshCounter, 5000);

  function _close() {
    clearInterval(_pollTimer);
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    overlay.remove();
  }

  document.getElementById('presentiel-close')?.addEventListener('click', _close);
  overlay.addEventListener('keydown', e => { if (e.key === 'Escape') _close(); });

  document.getElementById('presentiel-fs-btn')?.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      overlay.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  });

  document.addEventListener('fullscreenchange', () => {
    const btn = document.getElementById('presentiel-fs-btn');
    if (btn) btn.textContent = document.fullscreenElement ? '✕⛶' : '⛶';
  }, { once: false });
}

// ── Invite acceptance (guest side) ──────────────────────────────────────────────

/**
 * Check sessionStorage for a pending invite token and handle it.
 * Called after successful authentication.
 */
export async function handlePendingInvite(user) {
  if (!isFirebaseConfigured() || !user) return;

  const token = sessionStorage.getItem('_pendingInvite');
  if (!token) return;
  sessionStorage.removeItem('_pendingInvite');

  try {
    const invite = await loadInvite(token);
    if (!invite?.tripId) {
      notify('Lien d\'invitation invalide ou expiré.', '⚠️');
      return;
    }

    const tripId    = invite.tripId;
    const sharedDoc = await loadSharedTrip(tripId);
    if (!sharedDoc?.trip) {
      notify('Le voyage partagé est introuvable.', '⚠️');
      return;
    }

    // Already a member — just re-connect
    if (sharedDoc.members?.[user.uid]) {
      markTripShared(tripId);
      // A prior removal (kicked, or the trip itself deleted then re-shared)
      // may have left a local tombstone — an explicit rejoin must override it,
      // otherwise replaceTripFromNetwork() below silently refuses to resurrect it.
      clearDeletedTrip(tripId);
      replaceTripFromNetwork(tripId, sharedDoc.trip);
      _sharedDocData.set(tripId, sharedDoc);
      if (sharedDoc.members[user.uid].role === 'observer') _obsUpdateCache(user.uid, tripId, true);
      await _loadAndListen(tripId).catch(() => {});
      if (!_sharedTripIds.includes(tripId)) {
        _sharedTripIds.push(tripId);
        setSharedTripIds(_sharedTripIds);
      }
      notify('Voyage chargé !', '✅');
      if (typeof window._rerenderCurrentView === 'function') window._rerenderCurrentView();
      return;
    }

    // Observer invite — join directly without companion picker
    if (invite.role === 'observer') {
      const obsName = user.displayName || 'Observateur';
      await joinSharedTrip(tripId, null, obsName, 'observer');
      if (!_sharedTripIds.includes(tripId)) {
        _sharedTripIds.push(tripId);
        setSharedTripIds(_sharedTripIds);
      }
      // Reflect locally right away using the trip data already in hand
      // (fetched above, before we joined — trip.* itself doesn't depend on
      // our own membership) rather than relying solely on _loadAndListen's
      // own re-fetch below: if that second read ever fails for any reason,
      // this still makes the trip show up in "Mes observations" immediately.
      markTripShared(tripId);
      clearDeletedTrip(tripId);
      replaceTripFromNetwork(tripId, sharedDoc.trip);
      _sharedDocData.set(tripId, sharedDoc);
      _obsUpdateCache(user.uid, tripId, true);
      await _loadAndListen(tripId).catch(() => {}); // live listener + fresh membership map — best-effort
      // Request browser notification permission for future publications
      if (Notification?.permission === 'default') {
        Notification.requestPermission().catch(() => {});
      }
      notify(`Vous suivez désormais "${sharedDoc.trip?.name || 'ce voyage'}" en tant qu'observateur 👁`, '✅');
      if (typeof window._rerenderCurrentView === 'function') window._rerenderCurrentView();
      return;
    }

    // New member — show companion picker (pass members so taken slots are greyed out)
    _showCompanionPicker(sharedDoc.trip, sharedDoc.members || {}, tripId, user);

  } catch (err) {
    console.error('[share] handlePendingInvite failed:', err);
    notify('Erreur lors du chargement du voyage partagé.', '❌');
  }
}

function _showCompanionPicker(trip, members, tripId, user) {
  const companions = trip.companions || [];

  // Collect companion IDs that are already claimed by another member
  const takenIds = new Set(
    Object.values(members)
      .map(m => m.companionId)
      .filter(Boolean),
  );

  const compsHtml = companions.map(c => {
    const taken = takenIds.has(c.id);
    return `
      <button class="comp-pick-btn${taken ? ' comp-pick-taken' : ''}"
        data-comp-id="${_esc(c.id)}" data-comp-name="${_esc(c.name)}"
        ${taken ? 'disabled' : ''}>
        <div class="comp-avatar" style="background:${_esc(c.color || '#0d9488')}">${_initials(c.name)}</div>
        <span>${_esc(c.name)}</span>
        ${taken ? '<span class="comp-pick-badge">Pris</span>' : ''}
      </button>`;
  }).join('');

  showModal(`
    <button class="mc" onclick="closeModal()">✕</button>
    <h3 class="modal-title">Rejoindre — ${_esc(trip.flag)} ${_esc(trip.name)}</h3>
    <p class="share-subtitle" style="margin-bottom:14px">Qui êtes-vous dans ce voyage ?</p>
    <div class="comp-pick-list">
      ${compsHtml}
      <button class="comp-pick-btn comp-pick-observer" data-comp-id="" data-comp-name="Observateur">
        <div class="comp-avatar" style="background:#6b7280">👁</div>
        <span>Observateur</span>
      </button>
    </div>
  `);

  document.querySelectorAll('.comp-pick-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const compId     = btn.dataset.compId;
      const compName   = btn.dataset.compName;
      // The "Observateur" button (no companion slot) must join with the
      // read-only role — without this it silently fell back to joinSharedTrip's
      // default 'member' role, so this person counted as a real traveler
      // (e.g. showing up as "Voyage de X et Observateur" instead of being
      // excluded from the traveler list and counted separately).
      const isObserver = btn.classList.contains('comp-pick-observer');
      closeModal();

      try {
        await joinSharedTrip(tripId, compId || null, compName, isObserver ? 'observer' : 'member');

        if (!_sharedTripIds.includes(tripId)) {
          _sharedTripIds.push(tripId);
          setSharedTripIds(_sharedTripIds);
        }

        // Reflect locally right away with the trip data already in hand
        // (the `trip` param, fetched by the caller before this picker even
        // opened) — see the identical comment on the observer-invite path
        // above for why this doesn't just rely on _loadAndListen alone.
        markTripShared(tripId);
        clearDeletedTrip(tripId);
        replaceTripFromNetwork(tripId, trip);
        if (isObserver) _obsUpdateCache(user.uid, tripId, true);
        await _loadAndListen(tripId).catch(() => {});
        notify(`Bienvenue, ${compName} ! 🎉`);
        if (typeof window._rerenderCurrentView === 'function') window._rerenderCurrentView();

      } catch (err) {
        console.error('[share] join failed:', err);
        notify('Erreur lors de la connexion au voyage.', '❌');
      }
    });
  });
}
