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
  loadSharedTrip, joinSharedTrip, saveUserSharedTripIds,
  isFirebaseConfigured, getCurrentUser,
} from './auth.js';
import {
  getTrip, markTripShared, isTripShared,
  replaceTripFromNetwork, setSharedSyncCallback,
} from './store.js';
import { showModal, closeModal, notify } from './utils.js';

// ── Module state ────────────────────────────────────────────────────────────────

const _listeners    = new Map(); // tripId → unsubscribe fn
let   _sharedTripIds = [];       // mutable list for saveUserSharedTripIds

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

// ── Initialisation ──────────────────────────────────────────────────────────────

/**
 * Called once after login with the user's cloudData.
 * Loads any previously shared trips and starts real-time listeners.
 */
export async function initSharedTrips(cloudData) {
  if (!isFirebaseConfigured()) return;

  _sharedTripIds = Array.isArray(cloudData?.sharedTripIds) ? [...cloudData.sharedTripIds] : [];

  // Wire the callback so store.updateTrip() pushes to shared collection
  setSharedSyncCallback(_onLocalSharedTripEdit);

  await Promise.all(_sharedTripIds.map(id => _loadAndListen(id)));
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

  const unsub = listenSharedTrip(tripId, (data, hasPendingWrites) => {
    _onNetworkUpdate(tripId, data, hasPendingWrites);
  });
  _listeners.set(tripId, unsub);
}

// ── Sync callbacks ──────────────────────────────────────────────────────────────

/** store.js calls this when a shared trip is mutated locally. */
function _onLocalSharedTripEdit(tripId, tripData) {
  saveSharedTrip(tripId, tripData).catch(err =>
    console.warn('[share] failed to push shared trip:', err.message),
  );
}

/** Firestore listener fires this for every snapshot (local + remote). */
function _onNetworkUpdate(tripId, data, hasPendingWrites) {
  if (!data?.trip) return;
  replaceTripFromNetwork(tripId, data.trip);

  // Skip re-render for the local user's own writes (hasPendingWrites = true)
  if (!hasPendingWrites && typeof window._rerenderCurrentView === 'function') {
    window._rerenderCurrentView(tripId);
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
      await initSharedTripInFirestore(tripId, trip, user.uid);
      markTripShared(tripId);
      setSharedSyncCallback(_onLocalSharedTripEdit);

      if (!_sharedTripIds.includes(tripId)) {
        _sharedTripIds.push(tripId);
        await saveUserSharedTripIds(_sharedTripIds);
      }

      if (!_listeners.has(tripId)) {
        const unsub = listenSharedTrip(tripId, (data, hasPendingWrites) =>
          _onNetworkUpdate(tripId, data, hasPendingWrites));
        _listeners.set(tripId, unsub);
      }
    }

    // Always generate a fresh invite token so each share creates a new link
    const token    = _genToken();
    await createInvite(token, tripId);

    const inviteUrl = `${location.origin}${location.pathname}?invite=${token}`;
    const qrUrl     = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(inviteUrl)}`;

    const sharedDoc    = await loadSharedTrip(tripId);
    const memberCount  = Object.keys(sharedDoc?.members || {}).length;

    showModal(_shareModalHtml(trip, inviteUrl, qrUrl, memberCount));

    document.getElementById('share-copy-btn')?.addEventListener('click', () => {
      navigator.clipboard?.writeText(inviteUrl).then(() => {
        const btn = document.getElementById('share-copy-btn');
        if (btn) { btn.textContent = '✓ Copié !'; setTimeout(() => { btn.textContent = 'Copier le lien'; }, 2000); }
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

function _shareModalHtml(trip, inviteUrl, qrUrl, memberCount) {
  const guestCount = memberCount - 1; // exclude owner
  const membersNote = guestCount > 0
    ? `<strong>${guestCount} compagnon${guestCount > 1 ? 's' : ''}</strong> a déjà rejoint.`
    : 'Aucun compagnon n\'a encore rejoint.';

  return `
    <button class="mc" onclick="closeModal()">✕</button>
    <h3 class="modal-title">Partager — ${_esc(trip.flag)} ${_esc(trip.name)}</h3>
    <div class="share-modal-body">
      <div class="share-qr-wrap">
        <img src="${_esc(qrUrl)}" alt="QR Code" class="share-qr" width="180" height="180" />
      </div>
      <p class="share-subtitle">Scannez le QR code ou copiez le lien :</p>
      <div class="share-link-row">
        <input class="share-link-input" type="text" readonly value="${_esc(inviteUrl)}" onclick="this.select()" />
        <button class="share-copy-btn" id="share-copy-btn">Copier le lien</button>
      </div>
      <p class="share-hint">${membersNote}</p>
    </div>
    <div class="ma"><button class="bc" onclick="closeModal()">Fermer</button></div>
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
        await saveUserSharedTripIds(_sharedTripIds);
      }
      notify('Voyage chargé !', '✅');
      if (typeof window._rerenderCurrentView === 'function') window._rerenderCurrentView();
      return;
    }

    // New member — show companion picker
    _showCompanionPicker(sharedDoc.trip, tripId, user);

  } catch (err) {
    console.error('[share] handlePendingInvite failed:', err);
    notify('Erreur lors du chargement du voyage partagé.', '❌');
  }
}

function _showCompanionPicker(trip, tripId, user) {
  const companions = trip.companions || [];

  const compsHtml = companions.map(c => `
    <button class="comp-pick-btn" data-comp-id="${_esc(c.id)}" data-comp-name="${_esc(c.name)}">
      <div class="comp-avatar" style="background:${_esc(c.color || '#0d9488')}">${_initials(c.name)}</div>
      <span>${_esc(c.name)}</span>
    </button>
  `).join('');

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
          await saveUserSharedTripIds(_sharedTripIds);
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
