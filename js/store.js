/* ============================================================
   CARNET DE VOYAGES — Store (localStorage + Firestore bridge)
   localStorage key: 'carnet_voyages_v1'

   Architecture:
   - All reads/writes go through this module (single source of truth).
   - saveData() persists to localStorage immediately and schedules a
     debounced (400 ms) push to Firestore via _syncCallback.
   - setState() merges a cloud snapshot: for each trip it keeps whichever
     version has the higher updatedAt timestamp (last-write-wins).
   - replaceTripFromNetwork() is used by real-time listeners (share.js)
     to apply a single-trip update without triggering another cloud push.
   ============================================================ */

const STORAGE_KEY = 'carnet_voyages_v1';
// Small mirror of settings.theme, updated alongside every full-state write
// below. index.html's inline boot script reads only this key to decide dark
// mode before first paint — otherwise it (and loadData() moments later) would
// each need a full JSON.parse of the entire state blob just to read one
// field, and that blob can be multi-MB since local trips keep photos as
// base64 in localStorage (see CLAUDE.md "Photos & sync cloud").
const THEME_KEY = 'carnet_theme';

/** Persist the full state blob, keeping the small THEME_KEY mirror in sync. */
function _persistState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  try { localStorage.setItem(THEME_KEY, state.settings?.theme || ''); } catch (_) {}
}

export const APP_VERSION = '187';

export const COMP_COLORS = [
  '#0d9488','#7c3aed','#e85d3e','#d97706',
  '#db2777','#0284c7','#16a34a','#f59e0b'
];

export function uid() {
  return Math.random().toString(36).slice(2, 10);
}

export const TRIP_TYPES = {
  voyage:  { label: 'Voyage',   icon: '✈️',  color: '#0d9488', bg: '#ccfbf1' },
  weekend: { label: 'Week-end', icon: '🏕️',  color: '#7c3aed', bg: '#ede9fe' },
  sortie:  { label: 'Sortie',   icon: '🎯',  color: '#d97706', bg: '#fef3c7' },
};

export function defaultBudgetCats() {
  return [
    { id: uid(), name: 'Transport',    icon: '🚗', color: '#0284c7', planned: 0 },
    { id: uid(), name: 'Hébergement',  icon: '🏨', color: '#7c3aed', planned: 0 },
    { id: uid(), name: 'Restauration', icon: '🍽️', color: '#e85d3e', planned: 0 },
    { id: uid(), name: 'Activités',    icon: '🎯', color: '#d97706', planned: 0 },
    { id: uid(), name: 'Shopping',     icon: '🛍️', color: '#db2777', planned: 0 },
    { id: uid(), name: 'Divers',       icon: '💡', color: '#6b7280', planned: 0 },
  ];
}

export function defaultPackingCats() {
  return [
    { id: uid(), name: 'Documents',    icon: '📄', color: '#0284c7', items: [] },
    { id: uid(), name: 'Vêtements',    icon: '👕', color: '#7c3aed', items: [] },
    { id: uid(), name: 'Hygiène',      icon: '🧴', color: '#db2777', items: [] },
    { id: uid(), name: 'Électronique', icon: '🔌', color: '#d97706', items: [] },
    { id: uid(), name: 'Santé',        icon: '💊', color: '#16a34a', items: [] },
  ];
}

/**
 * Create a complete trip object with all required fields.
 * companions get IDs if they don't have them.
 * @param {object} data - partial trip data
 * @returns {object} complete trip object
 */
export function createTrip(data = {}) {
  const now = new Date().toISOString();
  const companions = (data.companions || []).map(c => ({
    id:    c.id    || ('c_' + uid()),
    name:  c.name  || 'Inconnu',
    color: c.color || COMP_COLORS[Math.floor(Math.random() * COMP_COLORS.length)],
  }));

  const trip = {
    id:             'trip_' + Date.now() + '_' + uid(),
    type:           data.type        || 'voyage',
    name:           data.name        || 'Nouveau voyage',
    destination:    data.destination || '',
    flag:           data.flag        || '🌍',
    color:          data.color       || '#0d9488',
    photo:          data.photo       || '',
    photos:         data.photos      || [],
    startDate:      data.startDate   || null,   // 'YYYY-MM-DD' or null
    endDate:        data.endDate     || null,   // 'YYYY-MM-DD' or null
    companions,
    createdAt:      now,
    updatedAt:      Date.now(),
    status:         data.status         || 'planning',  // 'planning' | 'done'
    countryCode:    data.countryCode    || '',
    multiCountry:   data.multiCountry   || false,

    days:           data.days           || [],
    budgetCats:     data.budgetCats     || defaultBudgetCats(),
    budgetLines:    data.budgetLines    || [],
    realExpenses:   data.realExpenses   || [],
    packingCats:    data.packingCats    || defaultPackingCats(),
    packingChecked: data.packingChecked || {},
    journalEntries: data.journalEntries || [],
  };
  // Sortie-specific: carry the pin sub-object through
  if (data.pin) trip.pin = data.pin;
  return trip;
}

// ── Default app settings ───────────────────────────────────────────────────────

export const DEFAULT_EVENT_TYPES = [
  { key: 'sleep',      emoji: '🌙', label: 'Nuit',              color: '#7c3aed' },
  { key: 'drive',      emoji: '🚐', label: 'Transport',         color: '#0284c7' },
  { key: 'visit',      emoji: '📍', label: 'Visite',            color: '#16a34a' },
  { key: 'activity',   emoji: '⚡', label: 'Activité',          color: '#d97706' },
  { key: 'city',       emoji: '🏙️', label: 'Ville',             color: '#0369a1' },
  { key: 'ski',        emoji: '⛷️', label: 'Ski',               color: '#0891b2' },
  { key: 'museum',     emoji: '🏛️', label: 'Musée',             color: '#7c3aed' },
  { key: 'hiking',     emoji: '🥾', label: 'Randonnée',         color: '#16a34a' },
  { key: 'beach',      emoji: '🏖️', label: 'Plage',             color: '#d97706' },
  { key: 'nature',     emoji: '🌲', label: 'Parc / Forêt',      color: '#059669' },
  { key: 'panorama',   emoji: '🌅', label: 'Panorama',          color: '#0891b2' },
  { key: 'castle',     emoji: '⛩️', label: 'Temple / Château',  color: '#92400e' },
  { key: 'restaurant', emoji: '🍽️', label: 'Restaurant',        color: '#e85d3e' },
  { key: 'themepark',  emoji: '🎢', label: "Parc d'attraction", color: '#d97706' },
  { key: 'zoo',        emoji: '🦁', label: 'Zoo',               color: '#16a34a' },
  { key: 'snorkeling', emoji: '🤿', label: 'Snorkeling',        color: '#0891b2' },
];

export function getSettings() {
  return state.settings || {};
}

export function updateSettings(updates) {
  state.settings = { ...(state.settings || {}), ...updates };
  saveData();
  return state.settings;
}

export function getPinTypes() {
  // Unified with event types — same type system for planning and journal
  return getEventTypes().map(({ key, emoji, label }) => ({ key, emoji, label }));
}

export function getEventTypes() {
  const s = state.settings || {};
  if (!Array.isArray(s.eventTypes) || s.eventTypes.length === 0) return DEFAULT_EVENT_TYPES;
  // Forward migration: add any new default types the user doesn't have yet
  const types = [...s.eventTypes];
  const keys  = new Set(types.map(t => t.key));
  for (const def of DEFAULT_EVENT_TYPES) {
    if (!keys.has(def.key)) types.push(def);
  }
  // Ensure sleep is always first
  const sleepIdx = types.findIndex(t => t.key === 'sleep');
  if (sleepIdx <= 0) return types;
  return [types[sleepIdx], ...types.slice(0, sleepIdx), ...types.slice(sleepIdx + 1)];
}

export function getLanguage() {
  return (state.settings || {}).lang || 'fr';
}

/* ── Internal state ── */
let state = { trips: [], sharedTripIds: [], deletedTrips: {} };

// How long a deletion tombstone is kept around before being pruned.
// Must comfortably outlast the time it can take every device on an account
// to come back online and receive the deletion (days, not the old 400ms
// debounce window) — otherwise a device that synced late can resurrect a
// trip that was deleted from another device.
const DELETED_TRIP_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

/** Drop tombstones old enough that every device has certainly seen the deletion by now. */
function _pruneDeletedTrips(map) {
  const cutoff = Date.now() - DELETED_TRIP_TTL_MS;
  const pruned = {};
  for (const [id, ts] of Object.entries(map || {})) {
    if (ts >= cutoff) pruned[id] = ts;
  }
  return pruned;
}

let _syncCallback       = null;
let _syncTimer          = null;
const _recentlyDeletedIds = new Set();
let _sharedSyncCallback = null; // fn(tripId, tripData) — writes to shared_trips/{tripId}
const _sharedTripIds    = new Set();

export function getState() { return state; }

/** Whether a trip is being synced via shared_trips/{tripId} (not just personal). */
export function isTripShared(id)    { return _sharedTripIds.has(id); }
export function markTripShared(id)  { _sharedTripIds.add(id); }
export function unmarkTripShared(id){ _sharedTripIds.delete(id); }

/** Read persisted sharedTripIds from state (populated by setState/loadData). */
export function getSharedTripIds() {
  return Array.isArray(state.sharedTripIds) ? state.sharedTripIds : [];
}

/**
 * Update the sharedTripIds list and persist it via the normal saveData flow
 * (debounced syncToFirestore) — no separate Firestore call needed.
 */
export function setSharedTripIds(ids) {
  state.sharedTripIds = Array.isArray(ids) ? [...ids] : [];
  saveData();
}

/** Register the callback invoked when a shared trip is edited locally. */
export function setSharedSyncCallback(fn) { _sharedSyncCallback = fn; }

/**
 * Overwrite a trip's data from a network update without triggering any sync.
 * Used by the real-time listener in share.js.
 */
export function replaceTripFromNetwork(id, tripData) {
  // A tombstoned trip (deleted on this or another device) must never be
  // resurrected by a late-arriving snapshot, no matter which device it comes from.
  const delAt = (state.deletedTrips || {})[id];
  if (delAt != null && delAt >= (tripData?.updatedAt || 0)) return;

  const migrated = _migrateTrip({ ...tripData });
  const idx = state.trips.findIndex(t => t.id === id);
  if (idx !== -1) {
    // Only overwrite if the network version is strictly newer than the local one.
    // On a tie (same updatedAt) this is almost always the echo of our own edit
    // coming back from a shared_trips document, whose photos were compressed
    // for the 1 MB Firestore limit — keep the local (full-resolution) copy
    // instead of silently swapping in the lower-quality one.
    if ((migrated.updatedAt || 0) > (state.trips[idx].updatedAt || 0)) {
      state.trips[idx] = migrated;
    }
  } else {
    state.trips.unshift(migrated);
  }
  try { _persistState(); } catch (e) {}
}


/**
 * Merge a Firestore snapshot into local state (called on first auth + reconnect).
 *
 * Merge strategy (last-write-wins per trip):
 *  - For each trip that exists on both sides, keep the version with the
 *    higher updatedAt timestamp.
 *  - Local-only trips (not yet pushed) are appended so they are not lost.
 *  - Cloud settings / sharedTripIds overwrite local equivalents since they
 *    are only ever written from one device at a time.
 *  - Deletions are tracked as tombstones (state.deletedTrips: id → deletedAt)
 *    that travel with the synced state, so a trip deleted on one device stays
 *    deleted even if another device's stale copy resurfaces later.
 */
export function setState(cloudData) {
  if (!cloudData || typeof cloudData !== 'object') return;

  const localTrips = Array.isArray(state.trips)          ? state.trips          : [];
  const cloudTrips = Array.isArray(cloudData.trips)       ? cloudData.trips      : [];
  const localById  = new Map(localTrips.map(t => [t.id, t]));

  // Union of local + cloud tombstones, keeping the latest deletedAt per id.
  const deletedTrips = { ...(cloudData.deletedTrips || {}), ...(state.deletedTrips || {}) };
  for (const [id, ts] of Object.entries(deletedTrips)) {
    const cloudTs = (cloudData.deletedTrips || {})[id];
    if (cloudTs != null) deletedTrips[id] = Math.max(ts, cloudTs);
  }
  for (const id of _recentlyDeletedIds) deletedTrips[id] = Math.max(deletedTrips[id] || 0, Date.now());

  const isDeleted = t => {
    const delAt = deletedTrips[t.id];
    return delAt != null && delAt >= (t.updatedAt || 0);
  };

  const merged = cloudTrips.filter(ct => !isDeleted(ct)).map(ct => {
    const lt = localById.get(ct.id);
    localById.delete(ct.id); // mark as seen
    // Keep local unless the cloud copy is strictly newer. On a tie, the cloud
    // snapshot is almost always the confirmation echo of our own last write —
    // e.g. with compressed photos re-uploaded to the personal sync — so we
    // keep the local (uncompressed) copy rather than swap in the synced one.
    if (lt && (lt.updatedAt || 0) >= (ct.updatedAt || 0)) return lt;
    return ct;
  });

  // Trips that only exist locally (not yet synced to cloud)
  for (const lt of localById.values()) {
    if (!isDeleted(lt)) merged.push(lt);
  }

  state = { ...cloudData, trips: merged, deletedTrips: _pruneDeletedTrips(deletedTrips) };
  if (!Array.isArray(state.trips)) state.trips = [];
  // Run migration on every trip to fill missing fields from older schema versions
  state.trips = state.trips.map(t => _migrateTrip(t));
  try { _persistState(); }
  catch (e) { console.warn('Carnet: failed to persist merged state', e); }
}

export function setSyncCallback(fn) { _syncCallback = fn; }

export function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      state = parsed;
      if (!Array.isArray(state.trips)) state.trips = [];
      if (!state.deletedTrips || typeof state.deletedTrips !== 'object') state.deletedTrips = {};
      // Migrate: fill any missing fields
      state.trips = state.trips.map(t => _migrateTrip(t));
    }
  } catch (e) {
    console.warn('Carnet: failed to load data', e);
    state = { trips: [], deletedTrips: {} };
  }
}

/**
 * Fill any fields that are absent in trips saved by older app versions.
 * Called on every trip on load and after every cloud merge.
 * Mutates and returns the trip object (always operates on a copy from the caller).
 */
function _migrateTrip(t) {
  // Arrays / objects that were added in later versions
  if (!t.budgetCats)     t.budgetCats     = defaultBudgetCats();
  if (!t.budgetLines)    t.budgetLines    = [];
  if (!t.realExpenses)   t.realExpenses   = [];
  if (!t.packingCats)    t.packingCats    = defaultPackingCats();
  if (!t.packingChecked) t.packingChecked = {};
  if (!t.journalEntries) t.journalEntries = [];
  if (!t.companions)     t.companions     = [];
  if (!t.days)           t.days           = [];

  // Scalar fields with defaults
  if (t.flag   === undefined) t.flag   = '🌍';
  if (t.photo  === undefined) t.photo  = '';
  if (t.color  === undefined) t.color  = '#0d9488';
  if (t.type   === undefined) t.type   = 'voyage';

  // status: only default to 'done' for pre-status trips (undefined/null).
  // An explicit '' or 'planning' is left untouched.
  if (t.status == null) t.status = 'done';

  if (t.countryCode  === undefined) t.countryCode  = '';
  if (t.multiCountry === undefined) t.multiCountry = false;

  // updatedAt: Firestore timestamps arrive as ISO strings in some paths;
  // coerce to a numeric ms timestamp so comparisons in setState() work correctly.
  if (typeof t.updatedAt === 'string') {
    t.updatedAt = new Date(t.updatedAt).getTime() || 0;
  }

  // Sortie type: ensure the pin sub-object exists
  if (t.type === 'sortie' && !t.pin) {
    t.pin = {
      lat: null, lng: null, pinType: 'visit',
      date: t.startDate || null, time: '',
      description: '', weather: null, cost: 0, currency: 'EUR',
    };
  }

  // Ensure every companion has a stable id and colour
  t.companions = t.companions.map(c => ({
    id:    c.id    || ('c_' + uid()),
    name:  c.name  || 'Inconnu',
    color: c.color || COMP_COLORS[0],
  }));

  return t;
}

/**
 * Persist state to localStorage immediately, then schedule a debounced
 * Firestore sync (400 ms).  Rapid successive saves within the window share
 * a single cloud push — the last write always wins.
 *
 * Note: if the page is closed inside the 400 ms window the cloud push is
 * lost, but localStorage is already up to date so no data is actually lost.
 */
export function saveData() {
  try {
    _persistState();
  } catch (e) {
    console.warn('Carnet: localStorage full or unavailable — data may not persist', e);
  }
  clearTimeout(_syncTimer);
  const deletedSnapshot = [..._recentlyDeletedIds];
  _syncTimer = setTimeout(() => {
    _syncTimer = null;
    _recentlyDeletedIds.clear();
    if (_syncCallback) _syncCallback(state, deletedSnapshot);
  }, 400);
}

/** True during the 400 ms debounce window before a local edit reaches Firestore. */
export function hasPendingLocalChanges() { return !!_syncTimer; }

export function getTrips() {
  return state.trips;
}

export function getTrip(id) {
  return state.trips.find(t => t.id === id) || null;
}

export function addTrip(data) {
  const trip = createTrip(data);
  state.trips.unshift(trip);
  saveData();
  return trip;
}

function _detectChange(prev, updates) {
  if ('name' in updates && updates.name !== prev.name)
    return `a renommé le voyage en "${updates.name}"`;
  if (('startDate' in updates || 'endDate' in updates) &&
      (updates.startDate !== prev.startDate || updates.endDate !== prev.endDate))
    return 'a modifié les dates du voyage';
  if ('destination' in updates && updates.destination !== prev.destination)
    return `a changé la destination : ${updates.destination || '?'}`;
  if ('status' in updates && updates.status !== prev.status)
    return updates.status === 'done' ? 'a marqué le voyage comme terminé' : 'a réouvert le voyage en planification';
  if ('realExpenses' in updates) {
    const pLen = (prev.realExpenses || []).length;
    const nLen = (updates.realExpenses || []).length;
    if (nLen > pLen) return 'a ajouté une dépense réelle';
    if (nLen < pLen) return 'a supprimé une dépense réelle';
    return 'a modifié les dépenses';
  }
  if ('budgetLines' in updates) return 'a modifié le budget prévisionnel';
  if ('companions' in updates) {
    const pLen = (prev.companions || []).length;
    const nLen = (updates.companions || []).length;
    if (nLen > pLen) return 'a ajouté un compagnon';
    if (nLen < pLen) return 'a retiré un compagnon';
    return 'a modifié les compagnons';
  }
  if ('packingCats' in updates || 'packingChecked' in updates)
    return 'a modifié la liste de bagages';
  if ('days' in updates) {
    const prevDays = prev.days || [];
    const newDays  = updates.days || [];
    if (newDays.length > prevDays.length)
      return `a ajouté le Jour ${newDays.at(-1)?.num ?? newDays.length}`;
    if (newDays.length < prevDays.length)
      return 'a supprimé un jour du planning';
    for (let i = 0; i < newDays.length; i++) {
      const nd = newDays[i], pd = prevDays[i];
      if (!pd) continue;
      const ndIt = nd.items || [], pdIt = pd.items || [];
      if (ndIt.length > pdIt.length) return `a ajouté un événement au Jour ${nd.num}`;
      if (ndIt.length < pdIt.length) return `a supprimé un événement du Jour ${nd.num}`;
      for (let j = 0; j < ndIt.length; j++) {
        if (!pdIt[j]) continue;
        if (ndIt[j].text !== pdIt[j].text)
          return `a modifié "${ndIt[j].text || '?'}" (Jour ${nd.num})`;
        if (ndIt[j].type !== pdIt[j].type)
          return `a changé le type d'un événement (Jour ${nd.num})`;
      }
      if (nd.title !== pd.title)
        return `a renommé "Jour ${nd.num}" en "${nd.title}"`;
    }
    return 'a modifié le planning';
  }
  return 'a modifié le voyage';
}

export function updateTrip(id, updates) {
  const idx = state.trips.findIndex(t => t.id === id);
  if (idx === -1) return null;
  const prev = state.trips[idx];
  state.trips[idx] = { ...prev, ...updates, updatedAt: Date.now() };
  saveData();
  if (_sharedSyncCallback && _sharedTripIds.has(id)) {
    _sharedSyncCallback(id, state.trips[idx], _detectChange(prev, updates));
  }
  return state.trips[idx];
}

export function deleteTrip(id) {
  _recentlyDeletedIds.add(id);
  state.trips = state.trips.filter(t => t.id !== id);
  // Persisted tombstone: travels with the synced state so the deletion sticks
  // even if another device (or a late snapshot) still has the old trip.
  state.deletedTrips = { ...(state.deletedTrips || {}), [id]: Date.now() };
  saveData();
}

export function getRecentlyDeletedIds() { return new Set(_recentlyDeletedIds); }

/**
 * Clear a trip's deletion tombstone so it can be resurrected by an explicit
 * rejoin (e.g. scanning a shared trip's invite again after having been
 * removed from it). Without this, replaceTripFromNetwork() keeps refusing
 * to re-add it, since the tombstone's timestamp (set when we were removed)
 * is usually newer than the shared trip's last updatedAt.
 *
 * Sets the tombstone to 0 rather than deleting the key outright (v186 did
 * that and regressed — see CLAUDE.md history): deleting it left setState()'s
 * cloud/local tombstone union vulnerable to a race against its own debounced
 * cloud push — an app reload landing before that push confirmed still saw
 * the OLD tombstone server-side, and merged it straight back in since the
 * key was simply absent locally (nothing to override it with). A 0-valued
 * entry, by contrast, is a key that's actually PRESENT locally, so it always
 * wins that union regardless of timing — and every isDeleted() check in this
 * file already treats 0 as "not deleted" (any real updatedAt is > 0), so
 * nothing downstream needs to know the difference between absent and 0.
 */
export function clearDeletedTrip(id) {
  if (!state.deletedTrips || !(id in state.deletedTrips)) return;
  state.deletedTrips = { ...state.deletedTrips, [id]: 0 };
  saveData();
}
