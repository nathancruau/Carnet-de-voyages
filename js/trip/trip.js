/**
 * trip.js — Trip controller / tab router for Carnet de Voyages
 *
 * Exported surface:
 *   openTrip(id)        — called when user opens a trip from the home screen
 *                         (voyages/week-ends : écran voyage v2, tripv2.js ;
 *                          sorties : sortie.js, même style)
 *   refreshTrip(id)     — données modifiées : rafraîchit la vue affichée
 *   destroyTripMap()    — called by app.js when leaving the trip view
 *   openActivityModal(id) — historique des modifications (voyage partagé)
 */

import { getTrip } from '../store.js';
import { showModal } from '../utils.js';

// ─── Module state ─────────────────────────────────────────────────────────────

let _tripId     = null;
let _isObserver = false;
let _prevTabId  = null;
let _view       = 'overview';   // 'overview' (écran voyage v2) | 'packing' | 'money' | 'sortie'
let _v2Mod      = null;

// sortie.js n'est chargé que si une sortie est ouverte (destroyTripMap ne l'importe pas pour rien)
let _sortieMod  = null;

// ─── Public API ───────────────────────────────────────────────────────────────

/** Ouvre un voyage (vue d'ensemble v2) ou une sortie (sortie.js). */
export async function openTrip(id) {
  _tripId = id;

  const trip = getTrip(id);
  if (!trip) {
    console.error('[trip] openTrip: trip not found', id);
    return;
  }

  if (trip.type === 'sortie') {
    _isObserver = false;
    _view = 'sortie';
    _v2Mod?.destroyTripV2();
    const topbar = document.getElementById('topbar');
    const panels = document.getElementById('panels');
    if (topbar) topbar.innerHTML = '';
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
  document.getElementById('tv2-subnav')?.remove();
  document.getElementById('screen-app')?.classList.remove('tv2-sub-v2');
  const topbar = document.getElementById('topbar');
  const panels = document.getElementById('panels');
  if (topbar) topbar.innerHTML = '';
  if (panels) panels.innerHTML = '';
  _v2Mod = _v2Mod || await import('./tripv2.js');
  await _v2Mod.renderTripV2(_tripId, { observer: _isObserver, onOpenView: _openSubview });
}

/**
 * Sous-vue classique (anciens onglets) avec un en-tête au style v2 :
 * 'packing' = bagages (l'ancienne page « Planning détaillé » / Carte & Planning a été
 * retirée en v241 : tout se fait depuis la vue d'ensemble),
 * 'money' = Budget ↔ Dépenses partagées (bascule en bas de l'écran).
 */
async function _openSubview(view, tab) {
  const trip = getTrip(_tripId);
  if (!trip) return;
  _view = view;
  _v2Mod?.hideTripV2();
  const titles = { packing: 'Bagages', budget: 'Budget', tricount: 'Dépenses partagées' };
  // Budget/Dépenses : voyage en cours ou passé → Dépenses partagées d'abord ;
  // voyage à venir (ou sans dates) → Budget prévisionnel d'abord.
  if (view === 'money' && !tab) {
    const n = new Date();   // date LOCALE (toISOString = UTC : décalé d'un jour au Japon avant 9 h)
    const today = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
    tab = trip.startDate && trip.startDate <= today ? 'tricount' : 'budget';
  }
  const panelTab = view === 'packing' ? 'packing' : (tab || 'budget');
  // Sous-vues au style v2 : page grise sans bordure d'en-tête (fond html/body posé par switchTab)
  document.getElementById('screen-app')?.classList.add('tv2-sub-v2');
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
      switchTab(b.dataset.sub);
    });
  }
  await switchTab(panelTab);
}


/** Données modifiées (réseau, autre appareil) : rafraîchit la vue affichée sans la quitter. */
export function refreshTrip(id) {
  if (id !== _tripId) return;
  const trip = getTrip(id);
  if (!trip) { window.goHome?.(); return; }
  if (trip.type === 'sortie') return;   // sortie.js se rafraîchit sur « trip-updated »
  if (_view === 'overview') _v2Mod?.refreshTripV2(id);
  else if (_prevTabId) _renderActiveTab(_prevTabId, id);
}

/** Quitter l'écran voyage (appelé par app.js en revenant à l'accueil). */
export function destroyTripMap() {
  _v2Mod?.destroyTripV2();
  document.getElementById('tv2-subnav')?.remove();
  document.getElementById('screen-app')?.classList.remove('tv2-sub-v2');
  _sortieMod?.destroySortieMap();
}

/** Sous-vue affichée (budget | tricount | packing) : panneau actif + rendu. */
async function switchTab(tabId) {
  _prevTabId = tabId;
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === `panel-${tabId}`));

  // Fond html/body = celui de la sous-vue (bande iOS en bas, cf. CLAUDE.md) — gris v2
  const dark = document.documentElement.dataset.theme === 'dark';
  for (const el of [document.documentElement, document.body]) el.style.setProperty('background', dark ? '#1c2128' : '#f3f5f7', 'important');
  window.scrollTo(0, 0);

  await _renderActiveTab(tabId, _tripId);
}


// ─── Internal helpers ─────────────────────────────────────────────────────────


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

/** Charge le module de la sous-vue et l'affiche. */
async function _renderActiveTab(tabId, tripId) {
  if (!tripId) return;
  if (tabId === 'budget')        (await import('./budget.js')).renderBudget(tripId);
  else if (tabId === 'tricount') (await import('./tricount.js')).renderTricount(tripId);
  else if (tabId === 'packing')  (await import('./packing.js')).renderPacking(tripId);
}

/** Minimal HTML-escape for user content */
function _esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
