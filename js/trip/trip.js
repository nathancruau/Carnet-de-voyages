/**
 * trip.js — Trip controller / tab router for Carnet de Voyages
 *
 * Exported surface:
 *   openTrip(id)        — called when user opens a trip from the home screen
 *   destroyTripMap()    — called by app.js when leaving the trip view
 *   switchTab(tabId)    — switch between the five panels
 *   updateTopStats(id)  — refresh budget / expense counters in the topbar
 */

import { getTrip, isTripShared, getEventTypes } from '../store.js';
import { fmtDate, notify, showModal } from '../utils.js';

// ─── Module state ─────────────────────────────────────────────────────────────

let _tripId     = null;
let _isObserver = false;
let _prevTabId  = null;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Open a trip: render topbar + panels, then activate the mapcal tab.
 * @param {string} id
 */
export async function openTrip(id) {
  _tripId = id;

  const trip = getTrip(id);
  if (!trip) {
    console.error('[trip] openTrip: trip not found', id);
    return;
  }

  if (trip.type === 'sortie') {
    _isObserver = false;
    _renderSortieTopbar(trip);
    const panels = document.getElementById('panels');
    if (panels) panels.innerHTML = '';
    const { renderSortie } = await import('./sortie.js');
    renderSortie(id);
    return;
  }

  // Check if the current user is an observer of this shared trip
  try {
    const shareMod = await import('../share.js');
    _isObserver = shareMod.isCurrentUserObserver?.(id) || false;
  } catch (_) {
    _isObserver = false;
  }

  if (_isObserver) {
    _renderObserverTopbar(trip);
    _renderObserverPanels();
    await switchTab('journal');
    return;
  }

  _isObserver = false;
  _renderTopbar(trip);
  _renderPanels();
  updateTopStats(id);

  // Activate mapcal first; the panel is now in the DOM so the map can size itself.
  await switchTab('mapcal');
}

/**
 * Destroy the Leaflet map instance when leaving the trip screen.
 */
export async function destroyTripMap() {
  const mapcalMod = await import('./mapcal.js').catch(() => null);
  mapcalMod?.destroyMap();
  const sortieMod = await import('./sortie.js').catch(() => null);
  sortieMod?.destroySortieMap();
}

/**
 * Switch the active panel + re-render its content.
 * Exposed on window for inline handlers.
 * @param {string} tabId  one of: mapcal | journal | budget | tricount | packing
 */
export async function switchTab(tabId) {
  const prevTab = _prevTabId;
  _prevTabId    = tabId;

  // Update nav-tab active states
  document.querySelectorAll('.nav-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tabId);
  });

  // Show / hide panels
  document.querySelectorAll('.panel').forEach(p => {
    p.classList.toggle('active', p.id === `panel-${tabId}`);
  });

  // Map + complex panels (budget/tricount) need position:fixed layout
  const _isMapTab   = tabId === 'mapcal';
  const _isFixedTab = _isMapTab || tabId === 'budget' || tabId === 'tricount';
  const app = document.getElementById('screen-app');
  app?.classList.toggle('tab-map-active',   _isMapTab);
  app?.classList.toggle('tab-fixed-active', !_isMapTab && _isFixedTab);
  // Body scroll: disable during map/fixed tabs so Leaflet gets all touch events
  document.body.style.overflowY = _isFixedTab ? 'hidden' : '';
  // Sync body/html background with active tab content
  const _tabBg = _isMapTab
    ? '#aad3df'
    : (getComputedStyle(document.documentElement).getPropertyValue('--c').trim() || '#faf7f2');
  document.documentElement.style.setProperty('background', _tabBg, 'important');
  document.body.style.setProperty('background', _tabBg, 'important');
  window.scrollTo(0, 0);

  // Render content for the activated panel
  await _renderActiveTab(tabId, _tripId, _isObserver);

  // Acknowledge unread badges when observer explicitly navigates TO the journal tab
  if (tabId === 'journal' && prevTab !== 'journal' && _isObserver) {
    try {
      const { ackJournalSeen } = await import('./journal.js');
      ackJournalSeen(_tripId);
    } catch (_) {}
  }
}

window.switchTab = switchTab;

/**
 * Recalculate and display budget / expense totals in the topbar.
 * @param {string} tripId
 */
export function updateTopStats(tripId) {
  const trip = getTrip(tripId);
  if (!trip) return;

  // ── Planned budget: sum of budget lines ─────────────────────────────────────
  let planned = 0;
  (trip.budgetLines || []).forEach(l => { planned += Number(l.amount || 0); });

  // Legacy fallback
  if (planned === 0 && Array.isArray(trip.budget)) {
    trip.budget.forEach(b => { planned += Number(b.amount || 0); });
  }

  // ── Real expenses: sum realExpenses amounts ──────────────────────────────────
  let spent = 0;
  const expenses = trip.realExpenses || [];
  expenses.forEach(e => { spent += Number(e.amount || 0); });

  const fmtEur = v =>
    v === 0 ? '0 €' : v.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });

  const bEl = document.getElementById('ts-b');
  const eEl = document.getElementById('ts-e');
  if (bEl) bEl.textContent = planned > 0 ? fmtEur(planned) : '—';
  if (eEl) {
    if (expenses.length) {
      eEl.textContent = `${fmtEur(spent)} (${expenses.length})`;
    } else {
      eEl.textContent = '—';
    }
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function _renderSortieTopbar(trip) {
  const topbar = document.getElementById('topbar');
  if (!topbar) return;

  const pin        = trip.pin || {};
  const eventTypes = getEventTypes();
  const et         = eventTypes.find(e => e.key === (pin.pinType || 'visit')) || eventTypes[0];
  const dateStr    = pin.date
    ? new Date(pin.date + 'T12:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })
    : '';

  topbar.innerHTML = `
    <div class="topbar-row1 sortie-topbar-row">
      <button class="back-btn" id="back-home-btn">← Bibliothèque</button>
      <span class="trip-tag">${et.emoji} ${_esc(trip.name || 'Sortie')}</span>
      <div class="topbar-right">
        ${dateStr ? `<span class="dates-tag">${dateStr}</span>` : ''}
        ${pin.cost ? `<span class="ts-pill">💶&nbsp;${Number(pin.cost).toLocaleString('fr-FR', { minimumFractionDigits: 2 })} ${_esc(pin.currency || 'EUR')}</span>` : ''}
      </div>
    </div>
  `;

  topbar.querySelector('#back-home-btn').addEventListener('click', () => window.goHome?.());
}

function _renderObserverTopbar(trip) {
  const topbar = document.getElementById('topbar');
  if (!topbar) return;

  const startLabel = fmtDate(trip.startDate);
  const endLabel   = fmtDate(trip.endDate);

  topbar.innerHTML = `
    <div class="topbar-row1">
      <button class="back-btn" id="back-home-btn">← Bibliothèque</button>
      <span class="trip-tag">${_esc(trip.flag || '')} ${_esc(trip.name || 'Voyage')}</span>
      <div class="topbar-right">
        <span class="dates-tag">${startLabel} – ${endLabel}</span>
        <span class="observer-badge">👁 Observateur</span>
      </div>
    </div>
    <div class="topbar-row2">
      <div class="nav-tabs">
        <div class="nav-tab active" data-tab="journal">📔 Carnet de voyage</div>
      </div>
    </div>
  `;

  topbar.querySelector('#back-home-btn').addEventListener('click', () => window.goHome?.());
  topbar.addEventListener('click', e => {
    const tab = e.target.closest('.nav-tab');
    if (tab && tab.dataset.tab) switchTab(tab.dataset.tab);
  });
}

function _renderObserverPanels() {
  const panels = document.getElementById('panels');
  if (!panels) return;
  panels.innerHTML = `<div class="panel active" id="panel-journal"></div>`;
}

function _renderTopbar(trip) {
  const topbar = document.getElementById('topbar');
  if (!topbar) return;

  // Companion avatars — wrapped for presence-dot overlay; UID added later by _enrichSharedTopbar
  const comps = (trip.companions || []).map(c =>
    `<div class="comp-avatar-wrap" data-comp-id="${_esc(c.id)}">
      <div class="comp-avatar" style="background:${c.color || '#9c9890'}" title="${_esc(c.name)}">${_initials(c.name)}</div>
    </div>`
  ).join('');

  const startLabel = fmtDate(trip.startDate);
  const endLabel   = fmtDate(trip.endDate);
  const isShared   = isTripShared(_tripId);

  topbar.innerHTML = `
    <div class="topbar-row1">
      <button class="back-btn" id="back-home-btn">← Bibliothèque</button>
      <span class="trip-tag">${_esc(trip.flag || '')} ${_esc(trip.name || 'Voyage')}</span>
      <div class="topbar-right">
        <span class="dates-tag">${startLabel} – ${endLabel}</span>
        ${comps ? `<div class="companions-row" style="display:flex;align-items:center;gap:3px">${comps}</div>` : ''}
        ${isShared ? `<button class="activity-log-btn" id="activity-log-btn" title="Historique des modifications">📋</button>` : ''}
        <span class="ts-pill" title="Budget planifié">💰&nbsp;<span id="ts-b">—</span></span>
        <span class="ts-pill" title="Dépenses réelles">💳&nbsp;<span id="ts-e">—</span></span>
      </div>
    </div>
    <div class="topbar-row2">
      <div class="nav-tabs">
        <span class="nav-tabs-group-lbl">Planifié</span>
        <div class="nav-tab active" data-tab="mapcal"><span class="nav-tab-em">🗺</span><span class="nav-tab-lbl"> Carte &amp; Planning</span></div>
        <div class="nav-tab" data-tab="budget"><span class="nav-tab-em">💰</span><span class="nav-tab-lbl"> Budget</span></div>
        <div class="nav-tab" data-tab="packing"><span class="nav-tab-em">🎒</span><span class="nav-tab-lbl"> Bagages</span></div>
        <div class="nav-tabs-sep"></div>
        <span class="nav-tabs-group-lbl">Réel</span>
        <div class="nav-tab" data-tab="journal"><span class="nav-tab-em">📔</span><span class="nav-tab-lbl"> Carnet</span></div>
        <div class="nav-tab" data-tab="tricount"><span class="nav-tab-em">💳</span><span class="nav-tab-lbl"> Dépenses</span></div>
      </div>
    </div>
  `;

  // Back button
  topbar.querySelector('#back-home-btn').addEventListener('click', () => {
    window.goHome && window.goHome();
  });

  // Tab clicks via event delegation on the whole topbar
  topbar.addEventListener('click', e => {
    const tab = e.target.closest('.nav-tab');
    if (tab && tab.dataset.tab) switchTab(tab.dataset.tab);
  });

  // Shared-trip extras
  if (isShared) {
    topbar.querySelector('#activity-log-btn')?.addEventListener('click', () => {
      _openActivityModal(_tripId);
    });
    // Add owner avatar + map UIDs → apply initial presence dots
    _enrichSharedTopbar(_tripId).catch(() => {});
  }

  // Called by share.js on every Firestore presence snapshot
  window._refreshPresenceDots = (tripId, presenceData) => {
    if (tripId !== _tripId) return;
    _updatePresenceDots(presenceData);
  };
}

/**
 * For shared trips: add the owner's avatar (if missing) and tag every
 * companion avatar with data-uid so presence dots can match by UID.
 */
async function _enrichSharedTopbar(tripId) {
  const { getSharedDocData } = await import('../share.js');
  const doc = getSharedDocData(tripId);
  if (!doc) return;

  const members = doc.members || {};

  // Tag each companion avatar with the UID of whoever claimed it
  document.querySelectorAll('.comp-avatar-wrap[data-comp-id]').forEach(wrap => {
    const entry = Object.entries(members).find(([, m]) => m.companionId === wrap.dataset.compId);
    if (entry) wrap.dataset.uid = entry[0];
  });

  // Add the trip owner's avatar if they don't already have one shown
  const ownerEntry = Object.entries(members).find(([, m]) => m.role === 'owner');
  if (ownerEntry) {
    const [ownerUid, ownerMember] = ownerEntry;
    if (!document.querySelector(`.comp-avatar-wrap[data-uid="${ownerUid}"]`)) {
      const row = document.querySelector('.companions-row');
      if (row) {
        const wrap = document.createElement('div');
        wrap.className = 'comp-avatar-wrap';
        wrap.dataset.uid = ownerUid;
        const name = ownerMember.companionName || 'Org';
        wrap.innerHTML = `<div class="comp-avatar" style="background:#0d9488" title="${_esc(name)}">${_initials(name)}</div>`;
        row.insertBefore(wrap, row.firstChild);
      }
    }
  }

  // Apply initial presence dots now that UIDs are in place
  if (doc.presence) _updatePresenceDots(doc.presence);
}

/** Add / remove green presence dots — matched by data-uid on each avatar wrap. */
function _updatePresenceDots(presenceData) {
  const TIMEOUT_MS = 2 * 60 * 1000;
  const now = Date.now();

  const onlineUids = new Set();
  for (const [uid, p] of Object.entries(presenceData || {})) {
    if (p.lastSeen && now - new Date(p.lastSeen).getTime() < TIMEOUT_MS) {
      onlineUids.add(uid);
    }
  }

  document.querySelectorAll('.comp-avatar-wrap[data-uid]').forEach(wrap => {
    const online = onlineUids.has(wrap.dataset.uid);
    let dot      = wrap.querySelector('.presence-dot');
    if (online && !dot) {
      dot = document.createElement('div');
      dot.className = 'presence-dot';
      wrap.appendChild(dot);
    } else if (!online && dot) {
      dot.remove();
    }
  });
}

async function _openActivityModal(tripId) {
  const { getSharedDocData } = await import('../share.js');
  const doc      = getSharedDocData(tripId);
  const activity = (doc?.activity || [])
    .sort((a, b) => new Date(b.ts) - new Date(a.ts))
    .slice(0, 50);

  if (!activity.length) {
    showModal(`
      <button class="mc" onclick="closeModal()">✕</button>
      <h3 class="modal-title">📋 Historique des modifications</h3>
      <p style="color:var(--ink4);font-size:13px;padding:8px 0">Aucune activité récente.</p>
      <div class="ma"><button class="bc" onclick="closeModal()">Fermer</button></div>
    `);
    return;
  }

  const rows = activity.map(e => `
    <div class="activity-row">
      <span class="activity-actor">${_esc(e.actor)}</span>
      <span class="activity-action"> ${_esc(e.action)}</span>
      <span class="activity-when"> · ${_relativeTime(e.ts)}</span>
    </div>`).join('');

  showModal(`
    <button class="mc" onclick="closeModal()">✕</button>
    <h3 class="modal-title">📋 Historique des modifications</h3>
    <div class="activity-list">${rows}</div>
    <div class="ma"><button class="bc" onclick="closeModal()">Fermer</button></div>
  `);
}

function _relativeTime(isoTs) {
  const diff = Date.now() - new Date(isoTs).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'à l\'instant';
  if (mins < 60) return `il y a ${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `il y a ${hrs} h`;
  return `il y a ${Math.floor(hrs / 24)} j`;
}

function _renderPanels() {
  const panels = document.getElementById('panels');
  if (!panels) return;
  panels.innerHTML = `
    <div class="panel active" id="panel-mapcal"></div>
    <div class="panel" id="panel-journal"></div>
    <div class="panel" id="panel-budget"></div>
    <div class="panel" id="panel-tricount"></div>
    <div class="panel" id="panel-packing"></div>
  `;
}

/**
 * Dynamically import the correct sub-module and call its render function.
 */
async function _renderActiveTab(tabId, tripId, isObserver = false) {
  if (!tripId) return;
  try {
    if (tabId === 'mapcal') {
      const { renderMapCal } = await import('./mapcal.js');
      renderMapCal(tripId);
    } else if (tabId === 'journal') {
      const { renderJournal } = await import('./journal.js');
      renderJournal(tripId, isObserver);
    } else if (tabId === 'budget') {
      const { renderBudget } = await import('./budget.js');
      renderBudget(tripId);
    } else if (tabId === 'tricount') {
      const { renderTricount } = await import('./tricount.js');
      renderTricount(tripId);
    } else if (tabId === 'packing') {
      const { renderPacking } = await import('./packing.js');
      renderPacking(tripId);
    }
  } catch (err) {
    console.warn(`[trip] tab "${tabId}" module not yet implemented:`, err.message);
    const panel = document.getElementById(`panel-${tabId}`);
    if (panel) {
      panel.style.alignItems = 'center';
      panel.style.justifyContent = 'center';
      panel.innerHTML = `<div style="color:var(--ink4);font-size:13px;text-align:center;padding:40px">
        <div style="font-size:32px;margin-bottom:10px">🚧</div>
        <div>Module en cours de développement</div>
      </div>`;
    }
  }
}

/** Minimal HTML-escape for user content */
function _esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** First letter of each word, max 2 chars — matches home.js behaviour */
function _initials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return parts[0].slice(0, 2).toUpperCase();
}
