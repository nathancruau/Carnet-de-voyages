/**
 * mapcal.js — Fenêtres du planning (événement, jour) et itinéraire du voyage
 *
 * L'ancienne page « Carte & Planning » (carte Leaflet, liste des jours, panneau
 * latéral) a été retirée (v241, code supprimé en v244) : tout se fait depuis
 * l'écran voyage v2 (tripv2.js), qui réutilise les fenêtres ci-dessous.
 *
 * Exported surface:
 *   openAddEventModal / openEditEventModal / openAddDayModal
 *   collectTripWaypoints(trip) — points de l'itinéraire (étapes + nuits)
 *   setWaypointMode(tripId, wp, mode) — moyen de transport d'un tronçon
 */

import { getTrip, updateTrip, uid, getEventTypes, getLanguage } from '../store.js';
import { parseGpx, saveLocalGpxTrack, removeLocalGpxTrack, computeGpxStats, downsampleGpxPoints } from '../gpx.js';
import {
  notify, showModal, closeModal,
  fmtDateShort,
  isoToDate, dateToIso,
  tCol, trIc, trNm, trCol, fmtFlag,
  customDayTitle,
  reverseGeocodeCountry,
} from '../utils.js';

// Hébergement : on saisit Arrivée / Départ, mais on stocke toujours première et
// dernière NUIT (dateFrom / dateTo incluses, format inchangé — compatible prod).
// Du 29 au 30 = 1 nuit (le 29) ; du 29 au 31 = 2 nuits (le 29 et le 30).
function _isoShift(iso, n) {
  if (!iso) return '';
  const d = isoToDate(iso);
  d.setDate(d.getDate() + n);
  return dateToIso(d);
}
function _nightsLabel(from, out) {
  if (!from || !out || out <= from) return '';
  const n = Math.round((isoToDate(out) - isoToDate(from)) / 86400000);
  return `🌙 ${n} nuit${n > 1 ? 's' : ''}`;
}

// Compteur « N nuits » en direct sous Arrivée / Départ (fenêtres d'ajout et de modification)
document.addEventListener('input', e => {
  const m = /^(ae|ee|edp)-sleep-(from|out)$/.exec(e.target?.id || '');
  if (!m) return;
  const from = document.getElementById(`${m[1]}-sleep-from`), out = document.getElementById(`${m[1]}-sleep-out`);
  if (m[2] === 'from' && from?.value && out && (!out.value || out.value <= from.value)) out.value = _isoShift(from.value, 1);
  const lbl = document.getElementById(`${m[1]}-sleep-n`);
  if (lbl) lbl.textContent = _nightsLabel(from?.value, out?.value) || 'Le départ doit être après l’arrivée';
});

// { dayId, idx } being dragged
// callback for route-mode popup
// toggle duration labels on map routes
// Leaflet layers for GPX overlays
// non-interactive copies at ±360° offsets
// 'planning' | 'transport'
// 'carte' | 'jours' (mobile only)

// ─── Map pins & routes ────────────────────────────────────────────────────────

// Return the active night stay for a given ISO date (the night of that date)
function _nightForDate(trip, isoDate) {
  for (const day of (trip.days || [])) {
    for (const item of (day.items || [])) {
      if (item.type === 'sleep' && item.lat != null && item.lng != null &&
          item.dateFrom && item.dateTo &&
          item.dateFrom <= isoDate && isoDate <= item.dateTo) {
        return { id: item.id, lat: item.lat, lng: item.lng,
                 name: item.text, dateFrom: item.dateFrom, dateTo: item.dateTo,
                 color: item.color || '#7c3aed' };
      }
    }
  }
  return null;
}

// Collect ALL georeferenced waypoints from items + fallback to day pins.
// Night stays inject a "return home" waypoint at the end of each covered day,
// and a "depart from" waypoint at the start of the following day.
function _collectAllWaypoints(trip) {
  const wps  = [];
  const days = (trip.days || []).slice().sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  for (let di = 0; di < days.length; di++) {
    const day = days[di];

    // --- Departure from previous night ---
    if (day.date && di > 0) {
      const prev = days[di - 1];
      if (prev.date) {
        const depNight = _nightForDate(trip, prev.date);
        if (depNight) {
          const last = wps[wps.length - 1];
          // Avoid duplicate if previous day already ended at this night
          const already = last && last.nightId === depNight.id;
          if (!already) {
            wps.push({ dayId: day.id, itemId: null, lat: depNight.lat, lng: depNight.lng,
              mode: day.departNightMode || 'car', label: depNight.name || '🌙 Nuit',
              isNight: true, isDepartNight: true, nightId: depNight.id });
          }
        }
      }
    }

    // --- Regular day pins ---
    const itemPins = (day.items || []).filter(it => it.lat != null && it.lng != null && it.type !== 'sleep');
    if (itemPins.length > 0) {
      for (const item of itemPins) {
        let mode = item.routeMode || 'car';
        if (item.type === 'drive' && item.transport) mode = item.transport;
        wps.push({ dayId: day.id, itemId: item.id, lat: item.lat, lng: item.lng, mode, label: item.text });
      }
    } else if (day.lat != null && day.lng != null) {
      wps.push({ dayId: day.id, itemId: null, lat: day.lat, lng: day.lng, mode: day.routeMode || 'car', label: `Jour ${day.num}` });
    }

    // --- Return to night at end of day ---
    if (day.date) {
      const retNight = _nightForDate(trip, day.date);
      if (retNight) {
        const last = wps[wps.length - 1];
        const already = last && last.nightId === retNight.id;
        if (!already) {
          wps.push({ dayId: day.id, itemId: null, lat: retNight.lat, lng: retNight.lng,
            mode: day.returnNightMode || 'car', label: retNight.name || '🌙 Nuit',
            isNight: true, isReturnNight: true, nightId: retNight.id });
        }
      }
    }
  }
  return wps;
}

// ─── Mobile full-screen event sheet ──────────────────────────────────────────

function _showMobileEventSheet(html) {
  document.getElementById('_evt-sheet')?.remove();
  const sheet = document.createElement('div');
  sheet.id = '_evt-sheet';
  sheet.className = 'ev-sheet v2-skin';
  sheet.style.cssText = [
    'position:fixed;inset:0;z-index:10000',
    'background:var(--c);color:var(--ink)',
    'overflow-x:hidden;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain',
    'padding:max(44px,env(safe-area-inset-top)) 20px calc(24px + env(safe-area-inset-bottom))',
    'font-family:var(--fn)',
    'transform:translateY(100%);transition:transform .28s cubic-bezier(.25,.8,.25,1)',
  ].join(';');
  sheet.innerHTML = html;
  // Rattachée à <html> et pas à body (iOS 26 : body verrouillé découpe les fixed, cf. CLAUDE.md)
  document.documentElement.appendChild(sheet);
  requestAnimationFrame(() => requestAnimationFrame(() => { sheet.style.transform = 'translateY(0)'; }));
  _bindSheetSwipeClose(sheet);
}

/**
 * v242 : glisser la fenêtre d'événement vers le bas (depuis le haut de son contenu) la
 * ferme en ENREGISTRANT tel quel (clic sur « Enregistrer » / « Ajouter »). Ajout sans
 * description = simple fermeture. Si l'enregistrement est refusé (dates invalides…),
 * la fenêtre revient en place.
 */
function _bindSheetSwipeClose(sheet) {
  let y0 = 0, dy = 0, t0 = 0, active = false, armed = false;
  sheet.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    const ta = e.target.closest('textarea');
    armed = sheet.scrollTop <= 0 && !(ta && ta.scrollTop > 0);
    active = false; dy = 0; y0 = e.touches[0].clientY; t0 = performance.now();
  }, { passive: true });
  sheet.addEventListener('touchmove', e => {
    if (!armed) return;
    const d = e.touches[0].clientY - y0;
    if (!active) {
      if (d < 8) { if (d < -4) armed = false; return; }
      active = true; y0 = e.touches[0].clientY; sheet.style.transition = 'none';
      document.activeElement?.blur?.();
    }
    dy = Math.max(0, e.touches[0].clientY - y0);
    if (e.cancelable) e.preventDefault();
    sheet.style.transform = `translateY(${dy}px)`;
  }, { passive: false });
  const end = () => {
    if (!active) { armed = false; return; }
    active = armed = false;
    const v = dy / Math.max(1, performance.now() - t0);
    sheet.style.transition = 'transform .28s cubic-bezier(.25,.8,.25,1)';
    if (dy < 110 && v < 0.6) { sheet.style.transform = 'translateY(0)'; return; }
    const isAdd  = !!sheet.querySelector('#ae-save');
    const saveBtn = sheet.querySelector('#ee-save, #ae-save');
    const emptyAdd = isAdd && !(sheet.querySelector('#ae-text')?.value || '').trim();
    if (!saveBtn || emptyAdd) { _closeMobileEventSheet(); return; }
    sheet.style.transform = 'translateY(100%)';
    saveBtn.click();
    // Enregistrement refusé (notification d'erreur, fenêtre toujours là) → elle remonte ;
    // enregistrement asynchrone en cours (bouton désactivé, ex. détection du pays) → on attend.
    setTimeout(() => {
      if (!sheet.isConnected || sheet.dataset.closing || saveBtn.disabled) return;
      if (document.getElementById('_evt-sheet') === sheet && sheet.style.transform === 'translateY(100%)') {
        sheet.style.transform = 'translateY(0)';
      }
    }, 250);
  };
  sheet.addEventListener('touchend', end);
  sheet.addEventListener('touchcancel', end);
}

function _closeMobileEventSheet() {
  const sheet = document.getElementById('_evt-sheet');
  if (!sheet) return;
  sheet.dataset.closing = '1';
  sheet.style.transition = 'transform .28s cubic-bezier(.25,.8,.25,1)';
  sheet.style.transform = 'translateY(100%)';
  setTimeout(() => sheet.remove(), 300);
}

// ─── Edit Event Modal (mobile — full-screen sheet replacing the desktop EDP) ──

function _gpxSummaryHtml(st, name) {
  if (!st) return '<span style="color:var(--ink4)">Aucune trace</span>';
  const km = ((st.distanceM || 0) / 1000).toFixed(1).replace('.', ',');
  const d = st.elevGain ? ` · +${Math.round(st.elevGain)} m` : '';
  const h = st.durationSecs ? ` · ${Math.floor(st.durationSecs / 3600)}h${String(Math.round((st.durationSecs % 3600) / 60)).padStart(2, '0')}` : '';
  return `🥾 ${name ? _esc(name) + ' · ' : ''}<b>${km} km</b>${d}${h}`;
}

function _openEditEventModal(dayId, evtIdx, tripId) {
  const trip = getTrip(tripId);
  if (!trip) return;
  const day = (trip.days || []).find(d => d.id === dayId);
  if (!day) return;
  const item = day.items?.[evtIdx];
  if (!item) return;

  const evtTypes = getEventTypes();
  let selType      = item.type      || 'visit';
  let selTransport = item.transport || 'car';

  const sorted    = (trip.days || []).filter(d => d.date).sort((a, b) => a.date.localeCompare(b.date));
  const tripStart = sorted[0]?.date || '';
  const tripEnd   = sorted[sorted.length - 1]?.date || '';

  function _typeBtnsHtml() {
    return evtTypes.map(et => {
      const active = et.key === selType;
      return `<button class="tp${active ? ' sel' : ''}" data-ee-type="${_esc(et.key)}"
        style="${active ? `background:${et.color};border-color:${et.color};color:#fff` : ''}"><b>${et.emoji}</b><span>${_esc(et.label)}</span></button>`;
    }).join('');
  }

  function _modeBtnsHtml() {
    return ['car','train','bus','plane','ferry','foot','bike'].map(m => {
      const active = m === selTransport;
      return `<button class="tp${active ? ' sel' : ''}" data-ee-mode="${m}"
        style="${active ? `background:${trCol(m)};border-color:${trCol(m)};color:#fff` : ''}"><b>${trIc(m)}</b><span>${trNm(m)}</span></button>`;
    }).join('');
  }

  // Day picker — lets mobile users move an event to another day, since HTML5
  // drag-and-drop (used on desktop) doesn't work with touch.
  function _dayOptionsHtml() {
    return (trip.days || []).map(d => {
      const label = `Jour ${d.num}${d.date ? ' · ' + fmtDateShort(d.date) : ''}${customDayTitle(d) ? ' · ' + customDayTitle(d) : ''}`;
      return `<option value="${_esc(d.id)}"${d.id === dayId ? ' selected' : ''}>${_esc(label)}</option>`;
    }).join('');
  }

  _showMobileEventSheet(`
    <h3 style="margin-bottom:16px">✏️ Modifier l'événement</h3>
    ${(trip.days || []).length > 1 ? `
    <div class="fg">
      <label>Jour</label>
      <select id="ee-day">${_dayOptionsHtml()}</select>
    </div>` : ''}
    <div class="fg">
      <label>Type</label>
      <div class="ev-tiles" style="display:flex;gap:6px;flex-wrap:wrap" id="ee-types">${_typeBtnsHtml()}</div>
    </div>
    <div id="ee-transport-row" style="display:${selType === 'drive' ? '' : 'none'}" class="fg">
      <label>Mode de transport</label>
      <div class="ev-tiles" style="display:flex;gap:6px;flex-wrap:wrap" id="ee-modes">${_modeBtnsHtml()}</div>
    </div>
    <div id="ee-sleep-dates" style="display:${selType === 'sleep' ? '' : 'none'}" class="fg">
      <label>Arrivée</label>
      <input type="date" id="ee-sleep-from" value="${_esc(item.dateFrom || day.date || '')}" min="${tripStart}" max="${tripEnd}">
      <label style="display:block;margin-top:8px">Départ</label>
      <input type="date" id="ee-sleep-out" value="${_esc(_isoShift(item.dateTo || item.dateFrom || day.date, 1))}" min="${_isoShift(tripStart, 1)}" max="${_isoShift(tripEnd, 1)}">
      <div class="sleep-nights" id="ee-sleep-n">${_nightsLabel(item.dateFrom || day.date, _isoShift(item.dateTo || item.dateFrom || day.date, 1))}</div>
    </div>
    <div class="fg">
      <label>Description</label>
      <input type="text" id="ee-text" value="${_esc(item.text || '')}" placeholder="Description…" autocomplete="off">
    </div>
    <div class="fg">
      <label>Heure</label>
      <input type="time" id="ee-time" value="${_esc(item.time || '')}">
    </div>
    <div class="fg">
      <label>Coût (€)</label>
      <input type="number" id="ee-cost" min="0" step="0.01" value="${_esc(String(item.cost || ''))}" placeholder="0">
    </div>
    <div class="fg">
      <label>Notes</label>
      <textarea id="ee-notes" class="notes-ta" placeholder="Vos notes…" style="min-height:55px">${_esc(item.notes || '')}</textarea>
    </div>
    <div class="fg">
      <label>Emplacement</label>
      <div class="ee-loc-cur" id="ee-loc-cur">${item.lat != null
        ? `📍 ${_esc(item.placeName || item.text || 'Position')} <small>(${Number(item.lat).toFixed(4)}, ${Number(item.lng).toFixed(4)})</small>`
        : '<span style="color:var(--ink4)">Aucun emplacement</span>'}</div>
      <div id="ee-loc-widget"></div>
      <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap">
        <button type="button" class="bc" id="ee-loc-here" style="font-size:12px;padding:7px 10px">🎯 Ma position</button>
        ${item.lat != null ? `<button type="button" class="bc" id="ee-loc-clear" style="font-size:12px;padding:7px 10px;color:#e85d3e">Retirer l'emplacement</button>` : ''}
      </div>
    </div>
    <div class="fg">
      <label>Trace GPX</label>
      <div class="ee-loc-cur" id="ee-gpx-cur">${_gpxSummaryHtml(item.gpxStats)}</div>
      <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap">
        <button type="button" class="bc" id="ee-gpx-pick" style="font-size:12px;padding:7px 10px" onclick="document.getElementById('ee-gpx-file').click()">🥾 <span id="ee-gpx-lbl">${item.gpxStats ? 'Remplacer la trace' : 'Importer une trace GPX'}</span></button>
        <input type="file" id="ee-gpx-file" accept=".gpx,application/gpx+xml,application/octet-stream" hidden>
        ${item.gpxStats ? `<button type="button" class="bc" id="ee-gpx-del" style="font-size:12px;padding:7px 10px;color:#e85d3e">Retirer la trace</button>` : ''}
      </div>
    </div>
    ${item.lat != null ? `
    <div class="fg">
      <label>Pays du PIN</label>
      <input type="text" id="ee-country-flag" value="${_esc(item.countryFlag || '')}" placeholder="🇫🇷" maxlength="8"
        style="width:70px" title="Détecté automatiquement depuis la position — modifiable si besoin">
    </div>` : ''}
    <div class="ma" style="justify-content:space-between">
      <button class="bc" id="ee-del" style="color:#e85d3e;border-color:#e85d3e">🗑 Supprimer</button>
      <div style="display:flex;gap:8px">
        <button class="bc" id="ee-cancel">Annuler</button>
        <button class="bs" id="ee-save">Enregistrer</button>
      </div>
    </div>
  `);

  const typesContainer = document.getElementById('ee-types');
  const transportRow   = document.getElementById('ee-transport-row');
  const sleepDatesRow  = document.getElementById('ee-sleep-dates');

  // Emplacement : même recherche de lieu que la fenêtre d'ajout (sans « cliquer sur
  // la carte », la carte n'est pas forcément à l'écran). undefined = inchangé,
  // null = retiré, { lat, lng, label } = nouvel emplacement.
  let newLoc = undefined;
  const locCur = document.getElementById('ee-loc-cur');
  const setLoc = (loc) => {
    newLoc = loc;
    if (!locCur) return;
    locCur.innerHTML = loc
      ? `📍 ${_esc(loc.label || 'Position')} <small>(${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)})</small> <em>· modifié</em>`
      : '<span style="color:var(--ink4)">Emplacement retiré</span>';
  };
  const locWidgetEl = document.getElementById('ee-loc-widget');
  if (locWidgetEl) {
    _buildLocationSearch(locWidgetEl, ({ lat, lng, label }) => setLoc({ lat, lng, label: (label || '').split(',')[0] }));
    locWidgetEl.querySelector('#loc-selected')?.remove();
  }
  document.getElementById('ee-loc-here')?.addEventListener('click', () => {
    if (!navigator.geolocation) { notify('Géolocalisation indisponible', '⚠️'); return; }
    navigator.geolocation.getCurrentPosition(
      pos => setLoc({ lat: pos.coords.latitude, lng: pos.coords.longitude, label: 'Ma position' }),
      ()  => notify('Position introuvable', '⚠️'),
      { enableHighAccuracy: true, timeout: 10000 });
  });
  document.getElementById('ee-loc-clear')?.addEventListener('click', () => setLoc(null));

  // Trace GPX (v244) : undefined = inchangée, null = retirée, { track, stats } = nouvelle
  let newGpx = undefined;
  const gpxCur = document.getElementById('ee-gpx-cur');
  document.getElementById('ee-gpx-file')?.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const { tracks } = parseGpx(await file.text());
      const points = (tracks || []).flatMap(t => t.points || []);
      if (points.length < 2) { notify('Aucune trace dans ce fichier GPX', '⚠️'); return; }
      const track = { id: 'gpx_' + Date.now(), name: tracks[0]?.name || file.name.replace(/\.gpx$/i, ''),
        color: '#f97316', points, importedAt: new Date().toISOString() };
      newGpx = { track, stats: computeGpxStats(points) };
      if (gpxCur) gpxCur.innerHTML = _gpxSummaryHtml(newGpx.stats, track.name) + ' <em>· à enregistrer</em>';
      const lbl = document.getElementById('ee-gpx-lbl'); if (lbl) lbl.textContent = 'Remplacer la trace';
      // Pas encore d'emplacement : le départ de la trace devient le PIN
      if (item.lat == null && newLoc === undefined) setLoc({ lat: points[0].lat, lng: points[0].lng, label: track.name });
    } catch (err) { notify('Erreur GPX : ' + err.message, '⚠️'); }
  });
  document.getElementById('ee-gpx-del')?.addEventListener('click', () => {
    newGpx = null;
    if (gpxCur) gpxCur.innerHTML = '<span style="color:var(--ink4)">Trace retirée (à enregistrer)</span>';
  });

  typesContainer?.addEventListener('click', e => {
    const pill = e.target.closest('[data-ee-type]');
    if (!pill) return;
    selType = pill.dataset.eeType;
    typesContainer.querySelectorAll('[data-ee-type]').forEach(p => {
      const tKey   = p.dataset.eeType;
      const etInfo = evtTypes.find(t => t.key === tKey);
      const active = tKey === selType;
      p.classList.toggle('sel', active);
      p.style.background  = active ? (etInfo?.color || tCol(tKey)) : '';
      p.style.borderColor = active ? (etInfo?.color || tCol(tKey)) : '';
      p.style.color       = active ? '#fff' : '';
    });
    if (transportRow)  transportRow.style.display  = selType === 'drive' ? '' : 'none';
    if (sleepDatesRow) sleepDatesRow.style.display  = selType === 'sleep' ? '' : 'none';
  });

  document.getElementById('ee-modes')?.addEventListener('click', e => {
    const pill = e.target.closest('[data-ee-mode]');
    if (!pill) return;
    selTransport = pill.dataset.eeMode;
    document.getElementById('ee-modes').querySelectorAll('[data-ee-mode]').forEach(p => {
      const m = p.dataset.eeMode;
      const active = m === selTransport;
      p.classList.toggle('sel', active);
      p.style.background  = active ? trCol(m) : '';
      p.style.borderColor = active ? trCol(m) : '';
      p.style.color       = active ? '#fff'   : '';
    });
  });

  document.getElementById('ee-cancel')?.addEventListener('click', _closeMobileEventSheet);

  document.getElementById('ee-del')?.addEventListener('click', () => {
    _closeMobileEventSheet();
    _deleteEvent(dayId, evtIdx, tripId);
  });

  document.getElementById('ee-save')?.addEventListener('click', () => {
    const text  = (document.getElementById('ee-text')?.value  || '').trim();
    const time  = document.getElementById('ee-time')?.value   || null;
    const cost  = parseFloat(document.getElementById('ee-cost')?.value  || '0') || 0;
    const notes = document.getElementById('ee-notes')?.value  || '';

    const sleepFrom = selType === 'sleep' ? (document.getElementById('ee-sleep-from')?.value || null) : null;
    const sleepTo   = selType === 'sleep' ? (_isoShift(document.getElementById('ee-sleep-out')?.value, -1) || null) : null;
    if (selType === 'sleep') {
      if (!sleepFrom || !sleepTo) { notify("Les dates d'arrivée et de départ sont requises", '⚠️'); return; }
      if (sleepFrom > sleepTo)    { notify("Le départ doit être au moins le lendemain de l'arrivée", '⚠️'); return; }
      if (tripStart && sleepFrom < tripStart) { notify('La date de début est avant le voyage', '⚠️'); return; }
      if (tripEnd   && sleepTo   > tripEnd)   { notify('La date de fin est après le voyage',   '⚠️'); return; }
    }

    const freshTrip = getTrip(tripId);
    if (!freshTrip) return;
    const freshDay = (freshTrip.days || []).find(d => d.id === dayId);
    if (!freshDay) return;

    const oldItem  = freshDay.items[evtIdx];
    const newEt    = getEventTypes().find(et => et.key === selType);

    // Country override: only rendered (so only present) for a geolocated pin.
    // fmtFlag() re-derives the ISO code from whatever the user typed (emoji or
    // plain 2-letter text) so country-based grouping/stats stay usable even
    // after a manual correction of the auto-detected flag.
    const countryFlagInput = document.getElementById('ee-country-flag');
    const countryFlag = countryFlagInput ? (countryFlagInput.value.trim() || null) : undefined;

    const updatedItems = [...(freshDay.items || [])];
    updatedItems[evtIdx] = {
      ...oldItem,
      type:      selType,
      emoji:     newEt?.emoji || null,
      color:     newEt?.color || null,
      transport: selType === 'drive' ? selTransport : oldItem.transport,
      text,
      time:  time || null,
      cost,
      notes,
      ...(selType === 'sleep' ? { dateFrom: sleepFrom, dateTo: sleepTo } : {}),
      ...(countryFlag !== undefined ? { countryFlag, countryCode: countryFlag ? fmtFlag(countryFlag) : null } : {}),
      ...(newLoc === null ? { lat: null, lng: null } : {}),
      ...(newLoc ? { lat: newLoc.lat, lng: newLoc.lng, placeName: newLoc.label || oldItem.placeName || null } : {}),
      ...(newGpx === null ? { gpxTrackId: null, gpxStats: null, gpxPoints: null } : {}),
      ...(newGpx ? { gpxTrackId: newGpx.track.id, gpxStats: newGpx.stats, gpxPoints: downsampleGpxPoints(newGpx.track.points) } : {}),
    };
    if (newGpx !== undefined && oldItem.gpxTrackId) removeLocalGpxTrack(tripId, oldItem.gpxTrackId);
    if (newGpx) saveLocalGpxTrack(tripId, newGpx.track);

    updateTrip(tripId, { days: freshTrip.days.map(d => d.id === dayId ? { ...d, items: updatedItems } : d) });

    // Nouvel emplacement : le pays du PIN est re-détecté (en arrière-plan, comme à l'ajout)
    if (newLoc && oldItem.id) {
      reverseGeocodeCountry(newLoc.lat, newLoc.lng).then(geo => {
        if (!geo) return;
        const t = getTrip(tripId);
        if (!t) return;
        updateTrip(tripId, { days: t.days.map(d => ({ ...d, items: (d.items || []).map(it =>
          it.id === oldItem.id && it.lat === newLoc.lat ? { ...it, countryCode: geo.code, countryFlag: geo.flag } : it) })) });
      }).catch(() => {});
    }

    if (oldItem.id) {
      const t3 = getTrip(tripId);
      if (t3) {
        const bl = (t3.budgetLines || []).find(l => l.source === 'event' && l.eventId === oldItem.id);
        if (bl) {
          updateTrip(tripId, { budgetLines: (t3.budgetLines || []).map(l =>
            l.id === bl.id ? { ...l, amount: cost, desc: text } : l
          )});
        }
      }
    }

    // Move to another day if the picker selection changed — reuses the same
    // move logic as the desktop drag-and-drop, which doesn't work on touch.
    const newDayId = document.getElementById('ee-day')?.value;

    _closeMobileEventSheet();

    if (newDayId && newDayId !== dayId) {
      _moveEvent(dayId, evtIdx, newDayId, tripId);
    } else {
      notify('Événement mis à jour', '✅');
    }
  });
}

// ─── Move event between days ──────────────────────────────────────────────────

function _moveEvent(sourceDayId, evtIdx, targetDayId, tripId) {
  if (!sourceDayId || !targetDayId || sourceDayId === targetDayId) return;
  const trip = getTrip(tripId);
  if (!trip) return;

  const days      = trip.days || [];
  const srcDay    = days.find(d => d.id === sourceDayId);
  const tgtDay    = days.find(d => d.id === targetDayId);
  if (!srcDay || !tgtDay) return;

  const srcItems = [...(srcDay.items || [])];
  if (evtIdx < 0 || evtIdx >= srcItems.length) return;
  const [moved] = srcItems.splice(evtIdx, 1);
  srcDay.items = srcItems;

  // If the event's coords were the source day's representative pin (no other items
  // with coords remain and they match the day's fallback), clear them so the target
  // day doesn't inherit the wrong location.
  const stillHaveCoords = srcItems.some(it => it.lat != null && it.lng != null);
  const movedEvent = (
    !stillHaveCoords &&
    moved.lat != null &&
    moved.lat === srcDay.lat &&
    moved.lng === srcDay.lng
  ) ? { ...moved, lat: null, lng: null } : moved;

  tgtDay.items = [...(tgtDay.items || []), movedEvent];

  updateTrip(tripId, { days });
  notify('Événement déplacé', '✅');
}

// ─── Delete event ─────────────────────────────────────────────────────────────

function _deleteEvent(dayId, evtIdx, tripId) {
  const trip = getTrip(tripId);
  if (!trip) return;

  // Deep-copy days so we never mutate the live store reference before the write
  const days = (trip.days || []).map(d =>
    d.id === dayId ? { ...d, items: [...(d.items || [])] } : d
  );
  const day = days.find(d => d.id === dayId);
  if (!day) return;

  day.items.splice(evtIdx, 1);

  // Re-derive day pin from remaining items to avoid ghost markers
  const firstPin = day.items.find(it => it.lat != null && it.lng != null);
  if (firstPin) {
    day.lat = firstPin.lat;
    day.lng = firstPin.lng;
  } else if (!day.items.some(it => it.lat != null)) {
    day.lat = null;
    day.lng = null;
  }

  updateTrip(tripId, { days });
  notify('Événement supprimé', '🗑');
}

// ─── Geocoding helper — Photon with Nominatim fallback ───────────────────────

async function _geocode(q) {
  const lang = getLanguage();
  // 1st try: Photon (fast fuzzy matching)
  try {
    const resp = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lang=${lang}`);
    const gj   = await resp.json();
    const data  = (gj.features || []).map(f => {
      const [lng, lat] = f.geometry.coordinates;
      const p = f.properties;
      const parts = [p.name, p.street, p.city, p.state, p.country].filter(Boolean);
      return { lat: String(lat), lon: String(lng), display_name: parts.join(', ') };
    });
    if (data.length > 0) return data;
  } catch (_) {}
  // 2nd try: Nominatim (broader coverage, handles alt names / historical names)
  try {
    const resp = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=6&q=${encodeURIComponent(q)}`,
      { headers: { 'Accept-Language': lang } }
    );
    const d = await resp.json();
    return d.map(r => ({ lat: r.lat, lon: r.lon, display_name: r.display_name }));
  } catch (_) {}
  return [];
}

// ─── Nominatim address search helper ─────────────────────────────────────────

/**
 * Renders an address search widget into `container` and returns a getter for
 * the currently selected { lat, lng, label } (or null if nothing chosen yet).
 *
 * @param {HTMLElement} container   - element to inject the widget into
 * @param {Function}    onSelect    - called with { lat, lng, label } when chosen
 */
function _buildLocationSearch(container, onSelect) {
  container.innerHTML = `
    <div style="display:flex;gap:6px;align-items:center">
      <input type="text" id="loc-query" placeholder="Rechercher un lieu…" autocomplete="off" style="flex:1">
      <button class="bc" id="loc-search-btn" style="white-space:nowrap;padding:8px 10px;font-size:11px">🔍 Chercher</button>
    </div>
    <div id="loc-results" style="margin-top:4px"></div>
    <div id="loc-selected" style="margin-top:4px;font-size:11px;color:var(--teal);min-height:16px"></div>
  `;

  const queryInput  = container.querySelector('#loc-query');
  const searchBtn   = container.querySelector('#loc-search-btn');
  const resultsEl   = container.querySelector('#loc-results');
  const selectedEl  = container.querySelector('#loc-selected');

  const doSearch = async () => {
    const q = (queryInput.value || '').trim();
    if (!q) return;
    searchBtn.disabled = true;
    searchBtn.textContent = '…';
    resultsEl.innerHTML = '<div style="font-size:11px;color:var(--ink4)">Recherche…</div>';
    try {
      const data = await _geocode(q);
      if (!data.length) {
        resultsEl.innerHTML = '<div style="font-size:11px;color:var(--ink4)">Aucun résultat</div>';
      } else {
        resultsEl.innerHTML = data.map((r, i) =>
          `<div class="loc-result" data-idx="${i}"
               style="padding:5px 8px;font-size:12px;cursor:pointer;border-radius:5px;border:1px solid var(--brd);margin-top:3px;background:var(--bg2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis"
               data-lat="${r.lat}" data-lng="${r.lon}" data-label="${_esc(r.display_name)}">
            📍 ${_esc(r.display_name)}
          </div>`
        ).join('');

        resultsEl.querySelectorAll('.loc-result').forEach(el => {
          el.addEventListener('mouseenter', () => { el.style.background = 'var(--teal-l, #ccfbf1)'; });
          el.addEventListener('mouseleave', () => { el.style.background = 'var(--bg2)'; });
          el.addEventListener('click', () => {
            const lat   = parseFloat(el.dataset.lat);
            const lng   = parseFloat(el.dataset.lng);
            const label = el.dataset.label;
            selectedEl.textContent = `📍 ${label} (${lat.toFixed(5)}, ${lng.toFixed(5)})`;
            resultsEl.innerHTML = '';
            onSelect({ lat, lng, label });
          });
        });
      }
    } catch (err) {
      resultsEl.innerHTML = '<div style="font-size:11px;color:var(--err,#dc2626)">Erreur de recherche</div>';
    }
    searchBtn.disabled = false;
    searchBtn.textContent = '🔍 Chercher';
  };

  searchBtn.addEventListener('click', doSearch);
  queryInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });

  let _debTimer = null;
  queryInput.addEventListener('input', () => {
    clearTimeout(_debTimer);
    const q = (queryInput.value || '').trim();
    if (q.length < 3) { resultsEl.innerHTML = ''; return; }
    _debTimer = setTimeout(doSearch, 500);
  });

  // Libellé du lieu choisi (pré-rempli à l'ouverture)
  return {
    setSelected(label) {
      selectedEl.textContent = label;
      resultsEl.innerHTML    = '';
    },
  };
}

// ─── Add Day Modal ────────────────────────────────────────────────────────────

function _openAddDayModal(tripId) {
  const trip       = getTrip(tripId);
  const dayCount   = (trip?.days || []).length;
  const colors     = ['#0d9488','#7c3aed','#d97706','#16a34a','#db2777','#0284c7','#e85d3e','#f59e0b','#06b6d4','#8b5cf6'];
  let   selColor   = colors[dayCount % colors.length];
  let   pickedLat  = null;
  let   pickedLng  = null;

  showModal(`
    <h3>＋ Nouveau jour / étape</h3>
    <div class="fg">
      <label>Titre</label>
      <input type="text" id="ad-title" placeholder="Ex : Arrivée à Kyoto…" autocomplete="off">
    </div>
    <div class="fg">
      <label>Région / Ville</label>
      <input type="text" id="ad-region" value="${_esc(trip?.destination || '')}" placeholder="Ex : Kyoto, Japon" autocomplete="off">
    </div>
    <div class="fg">
      <label>Date</label>
      <input type="date" id="ad-date" value="${trip?.startDate || ''}">
    </div>
    <div class="fg">
      <label>Localisation</label>
      <div id="ad-location-widget"></div>
    </div>
    <div class="fg">
      <label>Couleur</label>
      <div style="display:flex;gap:7px;flex-wrap:wrap;padding:2px 0" id="ad-colors">
        ${colors.map((c, i) => `<div class="col-o${i === dayCount % 10 ? ' sel' : ''}"
                                     style="background:${c}"
                                     data-ad-color="${c}"></div>`).join('')}
      </div>
    </div>
    <div class="ma">
      <button class="bc" id="ad-cancel">Annuler</button>
      <button class="bs" id="ad-save">Ajouter</button>
    </div>
  `);

  // Build location search widget
  const locWidget = document.getElementById('ad-location-widget');
  _buildLocationSearch(
    locWidget,
    ({ lat, lng }) => { pickedLat = lat; pickedLng = lng; });

  // Color picker
  document.getElementById('ad-colors')?.addEventListener('click', e => {
    const sw = e.target.closest('[data-ad-color]');
    if (!sw) return;
    selColor = sw.dataset.adColor;
    document.querySelectorAll('[data-ad-color]').forEach(s => {
      s.classList.toggle('sel', s.dataset.adColor === selColor);
    });
  });

  document.getElementById('ad-cancel')?.addEventListener('click', closeModal);

  document.getElementById('ad-save')?.addEventListener('click', () => {
    const title  = (document.getElementById('ad-title')?.value  || '').trim();
    const region = (document.getElementById('ad-region')?.value || '').trim();
    const date   = (document.getElementById('ad-date')?.value   || '').trim() || null;

    const trip2  = getTrip(tripId);
    const days   = trip2?.days || [];
    const newDay = {
      id:     'd_' + uid(),
      num:    days.length + 1,
      date,
      title:  title || `Jour ${days.length + 1}`,
      region,
      lat:    pickedLat != null ? Number(pickedLat) : null,
      lng:    pickedLng != null ? Number(pickedLng) : null,
      color:  selColor,
      photo:  '',
      items:  [],
    };

    days.push(newDay);
    updateTrip(tripId, { days });
    closeModal();
    notify('Jour ajouté !', '✅');
  });
}

// ─── Add Event Modal ──────────────────────────────────────────────────────────

function _openAddEventModal(dayId, tripId, prefill = null) {
  const evtTypes   = getEventTypes();
  let selType      = prefill?.type || (evtTypes.find(t => t.key === 'visit') ? 'visit' : (evtTypes[0]?.key || 'visit'));
  let selTransport = prefill?.transport || 'car';
  let pickedLat    = prefill?.lat ?? null;
  let pickedLng    = prefill?.lng ?? null;
  const _aeTrip    = getTrip(tripId);
  const _aeSorted  = (_aeTrip?.days || []).filter(d => d.date).sort((a, b) => a.date.localeCompare(b.date));
  const _aeStart   = _aeSorted[0]?.date || '';
  const _aeEnd     = _aeSorted[_aeSorted.length - 1]?.date || '';
  const _aeDay     = (_aeTrip?.days || []).find(d => d.id === dayId);
  const _aeDate    = _aeDay?.date || '';
  const _isMob     = window.innerWidth <= 768;
  const _close     = _isMob ? _closeMobileEventSheet : closeModal;
  const _openSheet = _isMob ? _showMobileEventSheet  : showModal;

  function _aeTypeBtnsHtml() {
    return evtTypes.map(et => {
      const active = et.key === selType;
      return `<button class="tp${active ? ' sel' : ''}" data-ae-type="${_esc(et.key)}"
        style="${active ? `background:${et.color};border-color:${et.color};color:#fff` : ''}"><b>${et.emoji}</b><span>${_esc(et.label)}</span></button>`;
    }).join('');
  }

  _openSheet(`
    <h3 style="margin-bottom:16px">＋ Ajouter un événement</h3>

    <div class="fg">
      <label>Type</label>
      <div class="ev-tiles" style="display:flex;gap:6px;flex-wrap:wrap" id="ae-types">
        ${_aeTypeBtnsHtml()}
      </div>
    </div>

    <div id="ae-transport-row" style="display:${selType === 'drive' ? '' : 'none'}" class="fg">
      <label>Mode de transport</label>
      <div class="ev-tiles" style="display:flex;gap:6px;flex-wrap:wrap" id="ae-modes">
        <button class="tp sel" data-ae-mode="car"   style="background:${trCol('car')};border-color:${trCol('car')};color:#fff">🚗 Voiture</button>
        <button class="tp" data-ae-mode="train"  >🚆 Train</button>
        <button class="tp" data-ae-mode="ferry"  >⛴ Ferry</button>
        <button class="tp" data-ae-mode="plane"  >✈ Avion</button>
        <button class="tp" data-ae-mode="bus"    >🚌 Bus</button>
        <button class="tp" data-ae-mode="foot"   >🚶 À pied</button>
        <button class="tp" data-ae-mode="bike"   >🚲 Vélo</button>
      </div>
    </div>

    <div class="fg">
      <label>Description</label>
      <input type="text" id="ae-text" placeholder="Ex : Visite du temple Fushimi Inari…" autocomplete="off">
    </div>

    <div class="fg">
      <label>Heure</label>
      <input type="time" id="ae-time">
    </div>
    <div class="fg">
      <label>Coût (€)</label>
      <input type="number" id="ae-cost" min="0" step="0.01" placeholder="0">
    </div>

    <div id="ae-dest-row" style="display:${selType === 'drive' ? '' : 'none'}" class="fg">
      <label>Destination</label>
      <div id="ae-dest-widget"></div>
    </div>

    <div id="ae-sleep-dates" style="display:${selType === 'sleep' ? '' : 'none'}" class="fg">
      <label>Arrivée</label>
      <input type="date" id="ae-sleep-from" value="${_aeDate}" min="${_aeStart}" max="${_aeEnd}"
        style="width:100%;padding:5px 8px;border:1.5px solid var(--c3);border-radius:6px;font-size:14px;background:var(--c);color:var(--ink)">
      <label style="display:block;margin-top:8px">Départ</label>
      <input type="date" id="ae-sleep-out" value="${_isoShift(_aeDate, 1)}" min="${_isoShift(_aeStart, 1)}" max="${_isoShift(_aeEnd, 1)}"
        style="width:100%;padding:5px 8px;border:1.5px solid var(--c3);border-radius:6px;font-size:14px;background:var(--c);color:var(--ink)">
      <div class="sleep-nights" id="ae-sleep-n">${_nightsLabel(_aeDate, _isoShift(_aeDate, 1))}</div>
    </div>

    <div class="fg">
      <label>Localisation PIN</label>
      <div id="ae-location-widget"></div>
    </div>

    <div class="fg">
      <label>Notes</label>
      <textarea id="ae-notes" class="notes-ta" placeholder="Infos utiles, réservation…" style="min-height:55px"></textarea>
    </div>

    <div class="ma">
      <button class="bc" id="ae-cancel">Annuler</button>
      <button class="bs" id="ae-save">Ajouter</button>
    </div>
  `);

  // Build main location search widget (updates day PIN)
  const locWidgetEl = document.getElementById('ae-location-widget');
  const _locWidget = _buildLocationSearch(
    locWidgetEl,
    ({ lat, lng }) => { pickedLat = lat; pickedLng = lng; });

  // Pre-fill location from map search
  if (prefill?.lat != null && _locWidget) {
    _locWidget.setSelected(`📍 ${prefill.label || (prefill.lat.toFixed(5) + ', ' + prefill.lng.toFixed(5))}`);
  }

  // Transport destination widget (shown only for drive)
  let destLat = null, destLng = null;
  const destWidgetEl = document.getElementById('ae-dest-widget');
  if (destWidgetEl) {
    _buildLocationSearch(
      destWidgetEl,
      ({ lat, lng }) => { destLat = lat; destLng = lng; });
  }

  // Type pill selection
  const typesContainer = document.getElementById('ae-types');
  const transportRow   = document.getElementById('ae-transport-row');
  const destRow        = document.getElementById('ae-dest-row');

  typesContainer?.addEventListener('click', e => {
    const pill = e.target.closest('[data-ae-type]');
    if (!pill) return;
    selType = pill.dataset.aeType;

    typesContainer.querySelectorAll('[data-ae-type]').forEach(p => {
      const tKey   = p.dataset.aeType;
      const etInfo = evtTypes.find(t => t.key === tKey);
      const active = tKey === selType;
      p.classList.toggle('sel', active);
      p.style.background  = active ? (etInfo?.color || tCol(tKey)) : '';
      p.style.borderColor = active ? (etInfo?.color || tCol(tKey)) : '';
      p.style.color       = active ? '#fff' : '';
    });

    if (transportRow) transportRow.style.display = selType === 'drive' ? '' : 'none';
    if (destRow)      destRow.style.display       = selType === 'drive' ? '' : 'none';
    const sleepRow = document.getElementById('ae-sleep-dates');
    if (sleepRow) sleepRow.style.display = selType === 'sleep' ? '' : 'none';
  });

  // Mode pill selection
  const modesContainer = document.getElementById('ae-modes');
  modesContainer?.addEventListener('click', e => {
    const pill = e.target.closest('[data-ae-mode]');
    if (!pill) return;
    selTransport = pill.dataset.aeMode;

    modesContainer.querySelectorAll('[data-ae-mode]').forEach(p => {
      const m      = p.dataset.aeMode;
      const active = m === selTransport;
      p.classList.toggle('sel', active);
      p.style.background  = active ? trCol(m) : '';
      p.style.borderColor = active ? trCol(m) : '';
      p.style.color       = active ? '#fff'   : '';
    });
  });

  document.getElementById('ae-cancel')?.addEventListener('click', _close);

  document.getElementById('ae-save')?.addEventListener('click', async ev => {
    const saveBtn = ev.currentTarget;
    const text  = (document.getElementById('ae-text')?.value  || '').trim();
    const time  = (document.getElementById('ae-time')?.value  || '').trim() || null;
    const cost  = parseFloat(document.getElementById('ae-cost')?.value || '0') || 0;
    const notes = (document.getElementById('ae-notes')?.value || '').trim();

    const _selEtFinal = evtTypes.find(t => t.key === selType);
    const event = {
      id:        'e_' + uid(),
      type:      selType,
      emoji:     _selEtFinal?.emoji  || null,
      color:     _selEtFinal?.color  || null,
      text,
      time,
      cost,
      notes,
      ...(selType === 'drive' ? {
        transport: selTransport,
        destLat,
        destLng,
      } : {}),
      ...(selType === 'sleep' ? {
        dateFrom: document.getElementById('ae-sleep-from')?.value || null,
        // Départ → dernière nuit = la veille du départ
        dateTo:   _isoShift(document.getElementById('ae-sleep-out')?.value, -1) || null,
      } : {}),
    };

    // Store location on the event; auto-detect its country (ISO code + flag)
    // via reverse geocoding so pins no longer need a flag typed in by hand —
    // stays editable afterwards from the event's edit modal if it got it wrong.
    if (pickedLat != null && pickedLng != null) {
      event.lat = pickedLat;
      event.lng = pickedLng;
      saveBtn.disabled = true;
      const prevLabel = saveBtn.textContent;
      saveBtn.textContent = 'Localisation du pays…';
      const geo = await reverseGeocodeCountry(pickedLat, pickedLng);

      // The lookup above can take up to ~6s — if the user cancelled/closed
      // this form (or opened a different modal entirely) while it was in
      // flight, bail out instead of silently adding the event anyway.
      // #ae-save no longer being *this* button covers both a replaced
      // modal (desktop showModal overwrites innerHTML) and the mobile
      // sheet (removed outright on close); the overlay-class check catches
      // a plain desktop close that leaves the hidden markup untouched.
      const stillOpen = document.getElementById('ae-save') === saveBtn &&
        (_isMob || document.getElementById('modal-overlay')?.classList.contains('open'));
      if (!stillOpen) return;

      if (geo) { event.countryCode = geo.code; event.countryFlag = geo.flag; }
      saveBtn.disabled = false;
      saveBtn.textContent = prevLabel;
    }

    const trip2 = getTrip(tripId);
    if (!trip2) return;
    const day = (trip2.days || []).find(d => d.id === dayId);
    if (!day) return;

    if (pickedLat != null && pickedLng != null && selType !== 'sleep' && day.lat == null) {
      day.lat = pickedLat;
      day.lng = pickedLng;
    }

    // Date validation for sleep events
    if (selType === 'sleep') {
      const df = event.dateFrom, dt = event.dateTo;
      if (!df || !dt) { notify("Les dates d'arrivée et de départ sont requises", '⚠️'); return; }
      if (df > dt) { notify("Le départ doit être au moins le lendemain de l'arrivée", '⚠️'); return; }
      if (_aeStart && df < _aeStart) { notify('La date de début est avant le voyage', '⚠️'); return; }
      if (_aeEnd   && dt > _aeEnd)   { notify('La date de fin est après le voyage',   '⚠️'); return; }
    }

    // Sleep items: anchor in the day matching dateFrom so they appear on the right day
    const targetDay = selType === 'sleep' && event.dateFrom
      ? ((trip2.days || []).find(d => d.date === event.dateFrom) || day)
      : day;
    (targetDay.items = targetDay.items || []).push(event);
    updateTrip(tripId, { days: trip2.days });

    // ── Cost → Budget sync ────────────────────────────────────────────────
    if (cost > 0) {
      const catMap = { drive: 'Transport', visit: 'Activités', activity: 'Activités', sleep: 'Hébergement' };
      const catName = catMap[selType] || null;
      if (catName) {
        const trip3 = getTrip(tripId);
        const budgetCats  = trip3?.budgetCats  || [];
        const budgetLines = trip3?.budgetLines || [];
        const cat = budgetCats.find(c => c.name === catName);
        if (cat) {
          const newLine = {
            id:     'bl_' + uid(),
            catId:  cat.id,
            desc:   text,
            amount: cost,
            note:   'Via Carte & Planning',
            dayId,
            source: 'event',
            eventId: event.id,
          };
          updateTrip(tripId, { budgetLines: [...budgetLines, newLine] });
        }
      }
    }
    // ─────────────────────────────────────────────────────────────────────

    _close();
    notify('Événement ajouté !', '✅');
  });
}

// ─── HTML escape ──────────────────────────────────────────────────────────────

function _esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Écran voyage v2 (tripv2.js) ──────────────────────────────────────────────
// Le nouvel écran réutilise telles quelles les fenêtres d'ajout/édition du planning
export const openEditEventModal   = (dayId, evtIdx, tripId) => _openEditEventModal(dayId, evtIdx, tripId);
export const openAddEventModal    = (dayId, tripId, prefill) => _openAddEventModal(dayId, tripId, prefill);
export const openAddDayModal      = tripId => _openAddDayModal(tripId);
export const collectTripWaypoints = trip => _collectAllWaypoints(trip);

/**
 * Mode de transport du tronçon qui ARRIVE au point `wp` (un élément de
 * collectTripWaypoints) — même règle d'écriture que le clic sur le tracé :
 * item.transport pour un « trajet » (drive), sinon item.routeMode ; pour un point
 * de nuit, day.departNightMode / day.returnNightMode ; sinon day.routeMode.
 */
export function setWaypointMode(tripId, wp, mode) {
  const trip = getTrip(tripId);
  if (!trip || !wp) return;
  const days = (trip.days || []).map(day => {
    if (day.id !== wp.dayId) return day;
    if (wp.itemId) {
      return { ...day, items: (day.items || []).map(it => it.id !== wp.itemId ? it
        : it.type === 'drive' ? { ...it, transport: mode } : { ...it, routeMode: mode }) };
    }
    const field = wp.isDepartNight ? 'departNightMode' : wp.isReturnNight ? 'returnNightMode' : 'routeMode';
    return { ...day, [field]: mode };
  });
  updateTrip(tripId, { days });
}
