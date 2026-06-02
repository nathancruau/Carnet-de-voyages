/* ============================================================
   CARNET DE VOYAGES — Store (localStorage)
   Key: 'carnet_voyages_v1'
   ============================================================ */

const STORAGE_KEY = 'carnet_voyages_v1';

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

  return {
    id:             'trip_' + Date.now() + '_' + uid(),
    type:           data.type        || 'voyage',
    name:           data.name        || 'Nouveau voyage',
    destination:    data.destination || '',
    flag:           data.flag        || '🌍',
    color:          data.color       || '#0d9488',
    photo:          data.photo       || '',
    startDate:      data.startDate   || null,   // 'YYYY-MM-DD' or null
    endDate:        data.endDate     || null,   // 'YYYY-MM-DD' or null
    companions,
    createdAt:      now,
    status:         data.status         || 'planning',  // 'planning' | 'done'
    countryCode:    data.countryCode    || '',

    days:           data.days           || [],
    budgetCats:     data.budgetCats     || defaultBudgetCats(),
    budgetLines:    data.budgetLines    || [],
    realExpenses:   data.realExpenses   || [],
    packingCats:    data.packingCats    || defaultPackingCats(),
    packingChecked: data.packingChecked || {},
    journalEntries: data.journalEntries || [],
  };
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
  { key: 'drive',    emoji: '🚐', label: 'Transport', color: '#0284c7' },
  { key: 'visit',    emoji: '📍', label: 'Visite',    color: '#16a34a' },
  { key: 'activity', emoji: '⚡', label: 'Activité',  color: '#d97706' },
  { key: 'sleep',    emoji: '🌙', label: 'Nuit',      color: '#7c3aed' },
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
  return Array.isArray(s.eventTypes) && s.eventTypes.length > 0 ? s.eventTypes : DEFAULT_EVENT_TYPES;
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
    state.trips[idx] = migrated;
  } else {
    state.trips.unshift(migrated);
  }
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
}


export function setState(data) {
  if (!data || typeof data !== 'object') return;
  state = { trips: [], ...data };
  if (!Array.isArray(state.trips)) state.trips = [];
  state.trips = state.trips.map(t => _migrateTrip(t));
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch (e) { console.warn('Carnet: failed to save state', e); }
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

function _migrateTrip(t) {
  if (!t.budgetCats)      t.budgetCats      = defaultBudgetCats();
  if (!t.budgetLines)     t.budgetLines     = [];
  if (!t.realExpenses)    t.realExpenses    = [];
  if (!t.packingCats)     t.packingCats     = defaultPackingCats();
  if (!t.packingChecked)  t.packingChecked  = {};
  if (!t.journalEntries)  t.journalEntries  = [];
  if (!t.companions)      t.companions      = [];
  if (!t.days)            t.days            = [];
  if (t.flag    === undefined) t.flag       = '🌍';
  if (t.photo   === undefined) t.photo      = '';
  if (t.color   === undefined) t.color      = '#0d9488';
  if (t.type    === undefined) t.type       = 'voyage';
  if (!t.status)               t.status    = 'done';   // legacy trips assumed done
  if (t.countryCode   === undefined) t.countryCode   = '';
  if (t.multiCountry  === undefined) t.multiCountry  = false;
  // Ensure companions have ids
  t.companions = t.companions.map(c => ({
    id:    c.id    || ('c_' + uid()),
    name:  c.name  || 'Inconnu',
    color: c.color || COMP_COLORS[0],
  }));
  return t;
}

export function saveData() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('Carnet: failed to save to localStorage', e);
  }
  // Debounce Firestore pushes so rapid edits don't flood the cloud.
  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(() => {
    if (_syncCallback) _syncCallback(state);
  }, 400);
}

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
  state.trips[idx] = { ...prev, ...updates };
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
