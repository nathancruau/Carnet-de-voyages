/**
 * trip.js — Trip controller / tab router for Carnet de Voyages
 *
 * Exported surface:
 *   openTrip(id)        — called when user opens a trip from the home screen
 *   destroyTripMap()    — called by app.js when leaving the trip view
 *   switchTab(tabId)    — switch between the five panels
 *   updateTopStats(id)  — refresh budget / expense counters in the topbar
 */

import { getTrip } from '../store.js';
import { fmtDate, notify } from '../utils.js';

// ─── Module state ─────────────────────────────────────────────────────────────

let _tripId = null;

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
  const { destroyMap } = await import('./mapcal.js');
  destroyMap();
}

/**
 * Switch the active panel + re-render its content.
 * Exposed on window for inline handlers.
 * @param {string} tabId  one of: mapcal | journal | budget | tricount | packing
 */
export async function switchTab(tabId) {
  // Update nav-tab active states
  document.querySelectorAll('.nav-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tabId);
  });

  // Show / hide panels
  document.querySelectorAll('.panel').forEach(p => {
    p.classList.toggle('active', p.id === `panel-${tabId}`);
  });

  // Render content for the activated panel
  await _renderActiveTab(tabId, _tripId);
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

function _renderTopbar(trip) {
  const topbar = document.getElementById('topbar');
  if (!topbar) return;

  // Companion avatars
  const comps = (trip.companions || []).map(c => {
    return `<div class="comp-avatar" style="background:${c.color || '#9c9890'}" title="${_esc(c.name)}">${_initials(c.name)}</div>`;
  }).join('');

  const startLabel = fmtDate(trip.startDate);
  const endLabel   = fmtDate(trip.endDate);

  topbar.innerHTML = `
    <button class="back-btn" id="back-home-btn">← Bibliothèque</button>
    <span class="trip-tag">${_esc(trip.flag || '')} ${_esc(trip.name || 'Voyage')}</span>
    <span class="dates-tag">${startLabel} – ${endLabel}</span>
    ${comps ? `<div class="companions-row" style="display:flex;align-items:center;gap:3px;margin-left:4px">${comps}</div>` : ''}
    <div class="top-stat">
      <div class="dot" style="background:var(--teal)"></div>
      <span>Budget :</span>&nbsp;<span id="ts-b">—</span>
    </div>
    <div class="top-stat">
      <div class="dot" style="background:var(--amb)"></div>
      <span>Dépenses :</span>&nbsp;<span id="ts-e">—</span>
    </div>
    <div class="spacer"></div>
    <div class="nav-tabs">
      <span class="nav-tabs-group-lbl">Planifié</span>
      <div class="nav-tab active" data-tab="mapcal">🗺 Carte &amp; Planning</div>
      <div class="nav-tab" data-tab="budget">💰 Budget</div>
      <div class="nav-tab" data-tab="packing">🎒 Bagages</div>
      <div class="nav-tabs-sep"></div>
      <span class="nav-tabs-group-lbl">Réel</span>
      <div class="nav-tab" data-tab="journal">📔 Carnet</div>
      <div class="nav-tab" data-tab="tricount">💳 Dépenses</div>
    </div>
  `;

  // Back button
  topbar.querySelector('#back-home-btn').addEventListener('click', () => {
    window.goHome && window.goHome();
  });

  // Tab clicks via event delegation
  topbar.addEventListener('click', e => {
    const tab = e.target.closest('.nav-tab');
    if (tab && tab.dataset.tab) switchTab(tab.dataset.tab);
  });
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
async function _renderActiveTab(tabId, tripId) {
  if (!tripId) return;
  try {
    if (tabId === 'mapcal') {
      const { renderMapCal } = await import('./mapcal.js');
      renderMapCal(tripId);
    } else if (tabId === 'journal') {
      const { renderJournal } = await import('./journal.js');
      renderJournal(tripId);
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
