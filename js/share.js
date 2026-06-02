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
} from './auth.js';
import {
  getTrip, markTripShared, unmarkTripShared, isTripShared,
  replaceTripFromNetwork, setSharedSyncCallback,
  getSharedTripIds, setSharedTripIds, getSettings,
} from './store.js';
import { notifyCollaboratorChange } from './notifications.js';
import { showModal, closeModal, notify } from './utils.js';

// ── Module state ────────────────────────────────────────────────────────────────

const _listeners      = new Map(); // tripId → unsubscribe fn
const _sharedDocData  = new Map(); // tripId → latest full Firestore doc
let   _sharedTripIds  = [];
let   _presenceInterval = null;    // heartbeat timer

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
  return doc?.members?.[user.uid]?.role === 'observer';
}

/**
 * Called when a traveler validates a journal day.
 * Writes lastPublished to Firestore so observers receive a real-time notification.
 */
export async function publishDay(tripId, dayNum, dayTitle) {
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
    dayTitle: dayTitle || '',
    actorName,
    tripName,
    dayLabel,
    ts: new Date().toISOString(),
  }).catch(() => {});
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

// ── Initialisation ──────────────────────────────────────────────────────────────

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
 * an onSnapshot listener.  Safe to call multiple times (idempotent).
 */
async function _loadAndListen(tripId) {
  if (_listeners.has(tripId)) return;

  const doc = await loadSharedTrip(tripId);
  if (!doc?.trip) return;

  markTripShared(tripId);
  replaceTripFromNetwork(tripId, doc.trip);
  _sharedDocData.set(tripId, doc);

  // Mark current user as present
  const user = getCurrentUser();
  if (user) {
    const member = doc.members?.[user.uid];
    updatePresence(tripId, member?.companionId || null, member?.companionName || user.displayName)
      .catch(() => {});
  }

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

  saveSharedTrip(tripId, tripData).catch(err =>
    console.warn('[share] failed to push shared trip:', err.message),
  );
}

/** Firestore listener fires this for every snapshot (local + remote). */
function _onNetworkUpdate(tripId, data, hasPendingWrites) {
  // Drop events that arrive after the user left/deleted the trip.
  if (!_listeners.has(tripId)) return;
  if (!data?.trip) return;

  const prevData = _sharedDocData.get(tripId);

  // Detect if the current user was removed from members by the owner
  const user = getCurrentUser();
  if (user && prevData?.members?.[user.uid] && !data.members?.[user.uid]) {
    leaveSharedTrip(tripId);
    notify('Vous avez été retiré de ce voyage partagé.', 'ℹ️');
    if (typeof window.goHome === 'function') window.goHome();
    return;
  }

  _sharedDocData.set(tripId, data);
  // Only overwrite local trip state when all local writes are confirmed.
  // Skipping during hasPendingWrites prevents stale server snapshots from
  // undoing unsaved local edits (e.g. event type change not yet committed).
  if (!hasPendingWrites) {
    replaceTripFromNetwork(tripId, data.trip);
  }

  // Lightweight presence-dot refresh (no full re-render needed)
  if (typeof window._refreshPresenceDots === 'function') {
    window._refreshPresenceDots(tripId, data.presence || {});
  }

  // Re-render: only when trip data changed (updatedAt) OR comments changed
  const tripChanged     = !prevData || prevData.updatedAt !== data.updatedAt;
  const commentsChanged = JSON.stringify(prevData?.comments) !== JSON.stringify(data.comments);

  // Observer notification: fire when lastPublished.ts changes
  if (!hasPendingWrites && prevData) {
    const prevPubTs = prevData.lastPublished?.ts;
    const newPubTs  = data.lastPublished?.ts;
    if (newPubTs && newPubTs !== prevPubTs) {
      const user   = getCurrentUser();
      const myRole = data.members?.[user?.uid]?.role;
      if (myRole === 'observer') {
        _showPublishNotification(data.lastPublished);
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
}

function _showPublishNotification(pub) {
  const { actorName, tripName, dayLabel } = pub || {};
  const msg = `${actorName || 'Un voyageur'} a publié ${dayLabel || 'un jour'} de "${tripName || 'son voyage'}"`;
  notify(msg, '📖');
  if (Notification?.permission === 'granted') {
    try { new Notification('Carnet de Voyages', { body: msg, icon: '/favicon.ico' }); } catch (_) {}
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
      await initSharedTripInFirestore(tripId, trip, user.uid, ownerName);
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

    const sharedDoc    = await loadSharedTrip(tripId);
    const memberCount  = Object.keys(sharedDoc?.members || {}).length;

    showModal(_shareModalHtml(trip, collabUrl, obsUrl, memberCount));

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

function _shareModalHtml(trip, collabUrl, obsUrl, memberCount) {
  const guestCount  = memberCount - 1; // exclude owner
  const membersNote = guestCount > 0
    ? `<strong>${guestCount} participant${guestCount > 1 ? 's' : ''}</strong> a déjà rejoint.`
    : 'Aucun participant n\'a encore rejoint.';

  return `
    <button class="mc" onclick="closeModal()">✕</button>
    <h3 class="modal-title">Partager — ${_esc(trip.flag)} ${_esc(trip.name)}</h3>
    <p class="share-hint" style="margin-bottom:12px">${membersNote}</p>

    <div class="share-section">
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
    </div>

    <div class="ma" style="margin-top:14px"><button class="bc" onclick="closeModal()">Fermer</button></div>
  `;
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
      await _loadAndListen(tripId);
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
      await _loadAndListen(tripId);
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
      const compId   = btn.dataset.compId;
      const compName = btn.dataset.compName;
      closeModal();

      try {
        await joinSharedTrip(tripId, compId, compName);

        if (!_sharedTripIds.includes(tripId)) {
          _sharedTripIds.push(tripId);
          setSharedTripIds(_sharedTripIds);
        }

        await _loadAndListen(tripId);
        notify(`Bienvenue, ${compName} ! 🎉`);
        if (typeof window._rerenderCurrentView === 'function') window._rerenderCurrentView();

      } catch (err) {
        console.error('[share] join failed:', err);
        notify('Erreur lors de la connexion au voyage.', '❌');
      }
    });
  });
}
