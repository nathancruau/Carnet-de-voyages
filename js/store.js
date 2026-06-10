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

export const APP_VERSION = '137';

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

export const DEFAULT_PIN_TYPES = [
  { key: 'hiker',  emoji: '🥾', label: 'Randonnée' },
  { key: 'city',   emoji: '🏙️', label: 'Ville' },
  { key: 'temple', emoji: '⛩️', label: 'Temple / Patrimoine' },
  { key: 'beach',  emoji: '🏖️', label: 'Plage' },
  { key: 'park',   emoji: '🌲', label: 'Parc / Nature' },
];

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
let state = { trips: [], sharedTripIds: [] };

let _syncCallback       = null;
let _syncTimer          = null;
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
  const migrated = _migrateTrip({ ...tripData });
  const idx = state.trips.findIndex(t => t.id === id);
  if (idx !== -1) {
    // Only overwrite if the network version is at least as recent as the local version
    if ((migrated.updatedAt || 0) >= (state.trips[idx].updatedAt || 0)) {
      state.trips[idx] = migrated;
    }
  } else {
    state.trips.unshift(migrated);
  }
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
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
 */
export function setState(cloudData) {
  if (!cloudData || typeof cloudData !== 'object') return;

  const localTrips = Array.isArray(state.trips)          ? state.trips          : [];
  const cloudTrips = Array.isArray(cloudData.trips)       ? cloudData.trips      : [];
  const localById  = new Map(localTrips.map(t => [t.id, t]));

  const merged = cloudTrips.map(ct => {
    const lt = localById.get(ct.id);
    localById.delete(ct.id); // mark as seen
    // Keep local if it is strictly newer (unsaved local edit wins)
    if (lt && (lt.updatedAt || 0) > (ct.updatedAt || 0)) return lt;
    return ct;
  });

  // Trips that only exist locally (not yet synced to cloud)
  for (const lt of localById.values()) merged.push(lt);

  state = { ...cloudData, trips: merged };
  if (!Array.isArray(state.trips)) state.trips = [];
  // Run migration on every trip to fill missing fields from older schema versions
  state.trips = state.trips.map(t => _migrateTrip(t));
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
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
      // Migrate: fill any missing fields
      state.trips = state.trips.map(t => _migrateTrip(t));
    }
  } catch (e) {
    console.warn('Carnet: failed to load data', e);
    state = { trips: [] };
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('Carnet: localStorage full or unavailable — data may not persist', e);
  }
  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(() => {
    _syncTimer = null;
    if (_syncCallback) _syncCallback(state);
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
  state.trips = state.trips.filter(t => t.id !== id);
  saveData();
}

/**
 * Return a human-readable day label from an ISO date string.
 * e.g. 'lun. 3 janv.'
 */
export function getDayLabel(isoDate) {
  if (!isoDate) return '';
  const d = new Date(isoDate + 'T00:00:00');
  return d.toLocaleDateString('fr-FR', {
    weekday: 'short',
    day:     'numeric',
    month:   'short',
  });
}
