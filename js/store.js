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
  const s = state.settings || {};
  return Array.isArray(s.pinTypes) && s.pinTypes.length > 0 ? s.pinTypes : DEFAULT_PIN_TYPES;
}

export function getEventTypes() {
  const s = state.settings || {};
  return Array.isArray(s.eventTypes) && s.eventTypes.length > 0 ? s.eventTypes : DEFAULT_EVENT_TYPES;
}

/* ── Internal state ── */
let state = { trips: [] };

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
  if (t.countryCode === undefined) t.countryCode = '';
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
    console.warn('Carnet: failed to save data', e);
  }
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

export function updateTrip(id, updates) {
  const idx = state.trips.findIndex(t => t.id === id);
  if (idx === -1) return null;
  state.trips[idx] = { ...state.trips[idx], ...updates };
  saveData();
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
