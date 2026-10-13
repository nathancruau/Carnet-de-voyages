/**
 * trip.js — Trip controller / tab router for Carnet de Voyages
 *
 * Exported surface:
 *   openTrip(id)        — called when user opens a trip from the home screen
 *                         (voyages/week-ends : écran voyage v2, tripv2.js ;
 *                          sorties : écran sortie classique)
 *   refreshTrip(id)     — données modifiées : rafraîchit la vue affichée
 *   destroyTripMap()    — called by app.js when leaving the trip view
 *   switchTab(tabId)    — switch between the classic panels (sous-vues)
 *   updateTopStats(id)  — refresh budget / expense counters (legacy topbar, no-op en v2)
 *   openActivityModal(id) — historique des modifications (voyage partagé)
 */

import { getTrip, getEventTypes } from '../store.js';
import { showModal } from '../utils.js';

// ─── Module state ─────────────────────────────────────────────────────────────

let _tripId     = null;
let _isObserver = false;
let _prevTabId  = null;
let _view       = 'overview';   // 'overview' (écran voyage v2) | 'events' | 'packing' | 'money'
let _v2Mod      = null;

// Caches the resolved module for each tab that has actually been opened this
// session (set at the same dynamic-import call sites that render each tab).
// destroyTripMap() only tears down maps that were actually created instead of
// importing all three tab modules unconditionally on every trip-screen exit —
// e.g. a user who only ever looked at the mapcal tab shouldn't force a
// network fetch of journal.js/sortie.js just to leave the trip.
let _mapcalMod  = null;
let _journalMod = null;
let _sortieMod  = null;

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
    _sortieMod = await import('./sortie.js');
    _sortieMod.renderSortie(id);
    return;
  }

  // Check if the current user is an observer of this shared trip
  try {
    const shareMod = await import('../share.js');
    _isObserver = shareMod.isCurrentUserObserver?.(id) || false;
  } catch (_) {
    _isObserver = false;
  }

  // Écran voyage v2 (refonte) : carte + feuille Planifier / Suivre. Les anciens onglets
  // restent accessibles en sous-vues (planning détaillé, bagages, budget/dépenses).
  await _showOverview();
}

/** Vue d'ensemble du voyage (tripv2.js). Les sous-vues classiques sont vidées. */
async function _showOverview() {
  _view = 'overview';
  _mapcalMod?.destroyMap();
  _journalMod?.destroyJournalMap();
  document.getElementById('tv2-subnav')?.remove();
  document.getElementById('screen-app')?.classList.remove('tv2-sub-v2');
  const topbar = document.getElementById('topbar');
  const panels = document.getElementById('panels');
  if (topbar) topbar.innerHTML = '';
  if (panels) panels.innerHTML = '';
  const app = document.getElementById('screen-app');
  app?.classList.remove('tab-map-active', 'tab-fixed-active', 'mc-carte-mode');
  document.body.style.overflowY = '';
  document.documentElement.style.overflowY = '';
  _v2Mod = _v2Mod || await import('./tripv2.js');
  await _v2Mod.renderTripV2(_tripId, { observer: _isObserver, onOpenView: _openSubview });
}

/**
 * Sous-vue classique (anciens onglets) avec un en-tête au style v2 :
 * 'events' = Carte & Planning complet, 'packing' = bagages,
 * 'money' = Budget ↔ Dépenses partagées (bascule en bas de l'écran).
 */
async function _openSubview(view, tab) {
  const trip = getTrip(_tripId);
  if (!trip) return;
  _view = view;
  _v2Mod?.hideTripV2();
  _markV2Sub(view === 'packing' || (view === 'money' && tab === 'tricount'));
  const titles = { mapcal: 'Planning détaillé', packing: 'Bagages', budget: 'Budget', tricount: 'Dépenses partagées' };
  const panelTab = view === 'events' ? 'mapcal' : view === 'packing' ? 'packing' : (tab || 'budget');
  const topbar = document.getElementById('topbar');
  if (topbar) {
    topbar.innerHTML = `
      <div class="tv2-subbar">
        <button class="hv2-round hv2-round-light tv2-sm" id="tv2-sub-back" title="Retour au voyage">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
        </button>
        <div class="tv2-subbar-t"><small>${_esc(trip.name || 'Voyage')}</small><b id="tv2-sub-title">${titles[panelTab]}</b></div>
      </div>`;
    topbar.querySelector('#tv2-sub-back').addEventListener('click', () => _showOverview());
  }
  const panels = document.getElementById('panels');
  if (panels) {
    panels.innerHTML = view === 'money'
      ? `<div class="panel" id="panel-budget"></div><div class="panel" id="panel-tricount"></div>`
      : `<div class="panel" id="panel-${panelTab}"></div>`;
  }
  document.getElementById('tv2-subnav')?.remove();
  if (view === 'money') {
    // Budget prévu ↔ dépenses partagées : une seule vue, bascule en bas de l'écran
    const nav = document.createElement('nav');
    nav.id = 'tv2-subnav';
    nav.className = 'tv2-subnav';
    nav.innerHTML = `<div class="tv2-seg">
      <button data-sub="budget" class="${panelTab === 'budget' ? 'active' : ''}">Budget</button>
      <button data-sub="tricount" class="${panelTab === 'tricount' ? 'active' : ''}">Dépenses</button></div>`;
    document.getElementById('screen-app')?.appendChild(nav);
    nav.addEventListener('click', e => {
      const b = e.target.closest('[data-sub]');
      if (!b || b.dataset.sub === _prevTabId) return;
      nav.querySelectorAll('[data-sub]').forEach(x => x.classList.toggle('active', x === b));
      const t = document.getElementById('tv2-sub-title');
      if (t) t.textContent = titles[b.dataset.sub];
      _markV2Sub(b.dataset.sub === 'tricount');
      switchTab(b.dataset.sub);
    });
  }
  await switchTab(panelTab);
}

/**
 * Sous-vues déjà refaites au style v2 (Bagages, Dépenses partagées) : page grise
 * sans bordure d'en-tête, et html/body de la même couleur (bande iOS en bas).
 */
function _markV2Sub(on) {
  document.getElementById('screen-app')?.classList.toggle('tv2-sub-v2', on);
  const bg = !on ? '' : document.documentElement.dataset.theme === 'dark' ? '#1c2128' : '#f3f5f7';
  for (const el of [document.documentElement, document.body]) {
    if (bg) el.style.setProperty('background', bg, 'important');
    else el.style.removeProperty('background');
  }
}

/** Données modifiées (réseau, autre appareil) : rafraîchit la vue affichée sans la quitter. */
export function refreshTrip(id) {
  if (id !== _tripId) return;
  const trip = getTrip(id);
  if (!trip) { window.goHome?.(); return; }
  if (trip.type === 'sortie') { openTrip(id); return; }
  if (_view === 'overview') _v2Mod?.refreshTripV2(id);
  else if (_prevTabId) _renderActiveTab(_prevTabId, id, _isObserver);
}

/**
 * Destroy the Leaflet map instance when leaving the trip screen. Only tears
 * down tab modules that were actually loaded this session (see _mapcalMod /
 * _journalMod / _sortieMod above) — a trip closed without ever opening, say,
 * the journal tab has no journal map to destroy.
 */
export function destroyTripMap() {
  _v2Mod?.destroyTripV2();
  document.getElementById('tv2-subnav')?.remove();
  document.getElementById('screen-app')?.classList.remove('tv2-sub-v2');
  _mapcalMod?.destroyMap();
  _journalMod?.destroyJournalMap();
  _sortieMod?.destroySortieMap();
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

  // Show / hide panels — journal-timeline reuses panel-journal
  const _panelId = tabId === 'journal-timeline' ? 'journal' : tabId;
  document.querySelectorAll('.panel').forEach(p => {
    p.classList.toggle('active', p.id === `panel-${_panelId}`);
  });

  // Desktop: mapcal needs position:fixed for Leaflet. Mobile: body-scroll with explicit map height.
  const _isMapTab   = (tabId === 'mapcal' || (tabId === 'journal-timeline' && _isObserver)) && window.innerWidth > 768;
  const _isFixedTab = _isMapTab;
  const app = document.getElementById('screen-app');
  app?.classList.toggle('tab-map-active',   _isMapTab);
  app?.classList.toggle('tab-fixed-active', !_isMapTab && _isFixedTab);
  app?.classList.remove('mc-carte-mode'); // cleared here; re-added by _applyMcScreenMode if needed
  // Body scroll: disable during fixed tabs so Leaflet gets all touch events (desktop only)
  document.body.style.overflowY                = _isFixedTab ? 'hidden' : '';
  document.documentElement.style.overflowY     = _isFixedTab ? 'hidden' : '';
  // Sync body/html background with active tab content (mapcal always uses map blue)
  const _tabBg = (tabId === 'mapcal')
    ? '#aad3df'
    : (getComputedStyle(document.documentElement).getPropertyValue('--c').trim() || '#faf7f2');
  document.documentElement.style.setProperty('background', _tabBg, 'important');
  document.body.style.setProperty('background', _tabBg, 'important');
  window.scrollTo(0, 0);

  // Keep --topbar-h CSS var accurate so the map height calc fills edge-to-edge on mobile
  if (window.innerWidth <= 768) {
    const tb = document.getElementById('topbar');
    if (tb) document.documentElement.style.setProperty('--topbar-h', tb.offsetHeight + 'px');
  }

  // Render content for the activated panel
  await _renderActiveTab(tabId, _tripId, _isObserver);

  // Acknowledge unread badges when observer explicitly navigates TO the journal tab
  if ((tabId === 'journal' || tabId === 'journal-timeline') && prevTab !== tabId && _isObserver) {
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

/** Historique des modifications d'un voyage partagé (bouton dans l'écran voyage v2). */
export async function openActivityModal(tripId) {
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

/**
 * Dynamically import the correct sub-module and call its render function.
 */
async function _renderActiveTab(tabId, tripId, isObserver = false) {
  if (!tripId) return;
  try {
    if (tabId === 'mapcal') {
      _mapcalMod = await import('./mapcal.js');
      _mapcalMod.renderMapCal(tripId);
    } else if (tabId === 'journal' || tabId === 'journal-timeline') {
      _journalMod = await import('./journal.js');
      // For observers, always pass an explicit forceView so switching tabs resets the view
      const forceView = tabId === 'journal-timeline' ? 'timeline' : (isObserver ? 'map' : null);
      _journalMod.renderJournal(tripId, isObserver, forceView);
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
