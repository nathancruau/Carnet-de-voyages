/* ============================================================
   CARNET DE VOYAGES — Journal Module
   ============================================================ */

import { getTrip, updateTrip, uid, getPinTypes } from '../store.js';
import { notify, showModal, closeModal, fmtDate, fmtDateShort, isoToDate, dateToIso } from '../utils.js';

// ── PIN type definitions (dynamic from settings) ──────────────────────────────

function _pinTypeMap() {
  const map = {};
  for (const pt of getPinTypes()) map[pt.key] = pt.emoji;
  return map;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _today() {
  return dateToIso(new Date());
}

function _starsHtml(rating) {
  let html = '<span class="rating-stars" style="display:inline-flex;gap:2px">';
  for (let i = 1; i <= 5; i++) {
    html += `<span class="star${rating >= i ? ' filled' : ''}" style="font-size:12px;cursor:default">★</span>`;
  }
  html += '</span>';
  return html;
}

function _dayLabel(trip, dayId) {
  if (!dayId) return null;
  const day = (trip.days || []).find(d => d.id === dayId);
  if (!day) return null;
  return `Jour ${day.num}${day.title ? ' · ' + day.title : ''}`;
}

// ── Handler registry (avoids double-binding) ─────────────────────────────────

const _handlers = new WeakMap();

// ── Map state ─────────────────────────────────────────────────────────────────

let _journalMap      = null;
let _journalMarkers  = {};
let _journalTripId   = null;

// ── Day filter state ──────────────────────────────────────────────────────────

let _activeDayFilter = null;

export function destroyJournalMap() {
  if (_journalMap) {
    try { _journalMap.remove(); } catch (_) { /* already removed */ }
    _journalMap = null;
  }
  _journalMarkers = {};
  _journalTripId  = null;
}

// ── Render ────────────────────────────────────────────────────────────────────

export function renderJournal(tripId) {
  const panel = document.getElementById('panel-journal');
  if (!panel) return;

  const trip = getTrip(tripId);
  if (!trip) return;

  _journalTripId = tripId;

  // Remove previous listener before re-rendering
  if (_handlers.has(panel)) {
    panel.removeEventListener('click', _handlers.get(panel));
    _handlers.delete(panel);
  }

  const allEntries = [...(trip.journalEntries || [])].sort((a, b) => {
    return (b.date || '').localeCompare(a.date || '');
  });

  panel.innerHTML = `
    <div class="mapcal">
      <div class="left-panel" style="width:290px;min-width:240px;max-width:290px;display:flex;flex-direction:column">
        <div style="padding:12px 14px 8px;flex-shrink:0;display:flex;align-items:center;justify-content:space-between;gap:8px">
          <h3 style="font-family:var(--sf);font-size:15px;font-weight:700;color:var(--ink);margin:0">📔 Journal</h3>
          <button class="btn-new" data-action="add-entry" style="font-size:11px;padding:5px 10px;white-space:nowrap">＋ Nouvelle</button>
        </div>
        <div style="flex-shrink:0;padding:0 8px 6px;border-bottom:1px solid var(--c3)">
          ${_buildDayChipsHtml(trip)}
        </div>
        <div class="days-scroll" id="journal-entries-list" style="flex:1;overflow-y:auto;padding:6px 8px">
          ${_buildEntriesListHtml(trip, allEntries)}
        </div>
      </div>
      <div class="map-col" style="flex:1;position:relative">
        <div id="journal-map" style="width:100%;height:100%"></div>
        ${allEntries.length === 0 ? `<div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center;color:var(--ink4);pointer-events:none"><div style="font-size:36px;margin-bottom:8px">🗺️</div><div style="font-size:13px;font-weight:600">Ajoutez des entrées avec une localisation<br>pour les voir sur la carte</div></div>` : ''}
      </div>
    </div>`;

  const handler = e => _handleClick(e, tripId);
  _handlers.set(panel, handler);
  panel.addEventListener('click', handler);

  // Init map
  _initJournalMap(tripId);
}

// ── Day chips ─────────────────────────────────────────────────────────────────

function _buildDayChipsHtml(trip) {
  const days = trip.days || [];
  const allActive = _activeDayFilter === null;

  let html = `<div style="display:flex;gap:5px;flex-wrap:nowrap;overflow-x:auto;padding:4px 0;scrollbar-width:none" class="jn-day-chips">`;
  html += `<button data-action="filter-day" data-day-id=""
    style="flex-shrink:0;font-size:11px;font-weight:700;padding:3px 10px;border-radius:999px;border:1.5px solid ${allActive ? 'var(--teal)' : 'var(--c3)'};
    background:${allActive ? 'var(--tl)' : 'var(--c2)'};color:${allActive ? 'var(--td)' : 'var(--ink3)'};cursor:pointer;white-space:nowrap">
    Tous
  </button>`;

  for (const day of days) {
    const active = _activeDayFilter === day.id;
    const label  = `J${day.num}${day.title ? ' · ' + day.title : ''}`;
    html += `<button data-action="filter-day" data-day-id="${_esc(day.id)}"
      style="flex-shrink:0;font-size:11px;font-weight:700;padding:3px 10px;border-radius:999px;border:1.5px solid ${active ? 'var(--teal)' : 'var(--c3)'};
      background:${active ? 'var(--tl)' : 'var(--c2)'};color:${active ? 'var(--td)' : 'var(--ink3)'};cursor:pointer;white-space:nowrap">
      ${_esc(label)}
    </button>`;
  }
  html += `</div>`;
  return html;
}

function _buildEntriesListHtml(trip, allEntries) {
  // Filter entries by active day filter
  const entries = _activeDayFilter
    ? allEntries.filter(e => e.dayId === _activeDayFilter)
    : allEntries;

  if (entries.length === 0) {
    return `
      <div class="jn-empty" style="text-align:center;padding:32px 12px;color:var(--ink4)">
        <div class="ei" style="font-size:36px;margin-bottom:8px">📔</div>
        <p style="font-size:13px;font-weight:600;color:var(--ink3)">Commencez à documenter votre voyage...</p>
        <p style="font-size:11px;margin-top:6px;color:var(--ink4)">Chaque journée mérite d'être racontée</p>
      </div>`;
  }

  // Group by dayId when available, else by date
  const groups = new Map();
  for (const e of entries) {
    let key, label;
    if (e.dayId) {
      key = 'day_' + e.dayId;
      const dl = _dayLabel(trip, e.dayId);
      label = dl || (e.date ? fmtDate(e.date) : 'Sans date');
    } else if (e.date) {
      key = 'date_' + e.date;
      label = fmtDate(e.date);
    } else {
      key = 'nodate';
      label = 'Sans date';
    }
    if (!groups.has(key)) groups.set(key, { label, entries: [] });
    groups.get(key).entries.push(e);
  }

  let html = '';
  for (const [, group] of groups) {
    html += `<div class="jn-day-group">
      <div class="jn-day-label">${_esc(group.label)}</div>`;
    for (const e of group.entries) {
      html += _entryCard(trip, e);
    }
    html += `</div>`;
  }
  return html;
}

// ── Entry card ────────────────────────────────────────────────────────────────

function _entryCard(trip, e) {
  const dateLabel = e.date ? fmtDate(e.date) : '—';
  const dayLabel  = e.dayId ? _dayLabel(trip, e.dayId) : null;

  let metaPills = `<span class="jn-meta-pill">${_esc(dateLabel)}</span>`;
  if (e.pinType && _pinTypeMap()[e.pinType]) metaPills += `<span class="jn-meta-pill" title="${_esc(e.pinType)}">${_pinTypeMap()[e.pinType]}</span>`;
  if (e.weather) metaPills += `<span class="jn-meta-pill">${_esc(e.weather)}</span>`;
  if (e.mood)    metaPills += `<span class="jn-meta-pill">${_esc(e.mood)}</span>`;
  if (e.rating)  metaPills += `<span class="jn-meta-pill">${_starsHtml(e.rating)}</span>`;
  if (dayLabel)  metaPills += `<span class="jn-meta-pill" style="background:var(--tl);color:var(--td);border-color:var(--teal)">${_esc(dayLabel)}</span>`;
  if (e.lat != null && e.lng != null) metaPills += `<span class="jn-meta-pill" style="background:#e0f2fe;color:#0284c7;border-color:#7dd3fc" title="${e.lat.toFixed(4)}, ${e.lng.toFixed(4)}">📍</span>`;

  const contentHtml = e.content
    ? `<div class="jn-content" style="display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden">${_esc(e.content)}</div>`
    : '';

  let photosHtml = '';
  if (e.photos && e.photos.length > 0) {
    photosHtml = `<div class="jn-photos">`;
    for (const ph of e.photos.slice(0, 5)) {
      photosHtml += `<img class="jn-photo" src="${_esc(ph.url)}" alt="${_esc(ph.caption || '')}" title="${_esc(ph.caption || '')}" onerror="this.style.display='none'">`;
    }
    if (e.photos.length > 5) {
      photosHtml += `<div class="jn-photo" style="display:flex;align-items:center;justify-content:center;background:var(--c2);font-size:10px;font-weight:700;color:var(--ink4)">+${e.photos.length - 5}</div>`;
    }
    photosHtml += `</div>`;
  }

  let tagsHtml = '';
  if (e.tags && e.tags.length > 0) {
    tagsHtml = `<div class="jn-tags">` +
      e.tags.map(t => `<span class="jn-tag">${_esc(t)}</span>`).join('') +
      `</div>`;
  }

  return `
    <div class="jn-entry" data-entry-id="${_esc(e.id)}" style="cursor:pointer">
      <div class="jn-entry-hd">
        <div class="jn-title" style="font-style:italic">${_esc(e.title || 'Sans titre')}</div>
        <div style="display:flex;gap:5px;flex-shrink:0">
          <button class="tc-edit-btn" data-action="edit-entry" data-entry-id="${_esc(e.id)}" title="Modifier">✏️</button>
          <button class="tc-edit-btn" data-action="delete-entry" data-entry-id="${_esc(e.id)}" title="Supprimer" style="color:var(--coral)">🗑</button>
        </div>
      </div>
      <div class="jn-meta">${metaPills}</div>
      ${contentHtml}
      ${photosHtml}
      ${tagsHtml}
    </div>`;
}

// ── Journal Map ───────────────────────────────────────────────────────────────

function _initJournalMap(tripId) {
  if (_journalMap) {
    try {
      const container = _journalMap.getContainer();
      if (document.contains(container)) {
        setTimeout(() => { if (_journalMap) _journalMap.invalidateSize(); }, 80);
        _refreshJournalPins(tripId);
        return;
      }
    } catch (_) {}
    // Container gone — destroy and reinitialize
    try { _journalMap.remove(); } catch (_) {}
    _journalMap = null;
    _journalMarkers = {};
  }

  requestAnimationFrame(() => {
    const el = document.getElementById('journal-map');
    if (!el) return;

    const trip = getTrip(tripId);
    // Default center
    let center = [46.5, 2.5];
    let zoom   = 5;
    if (trip) {
      const entry = (trip.journalEntries || []).find(e => e.lat != null && e.lng != null);
      if (entry) { center = [entry.lat, entry.lng]; zoom = 7; }
    }

    _journalMap = L.map('journal-map', { center, zoom, zoomControl: true });

    L.tileLayer('https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 18,
    }).addTo(_journalMap);

    _journalMap.invalidateSize();
    _refreshJournalPins(tripId);
  });
}

function _refreshJournalPins(tripId) {
  if (!_journalMap) return;
  const trip = getTrip(tripId);
  if (!trip) return;

  // Remove existing markers
  Object.values(_journalMarkers).forEach(m => { try { _journalMap.removeLayer(m); } catch (_) {} });
  _journalMarkers = {};

  const entries = (trip.journalEntries || []).filter(e => e.lat != null && e.lng != null);

  entries.forEach(entry => {
    const emoji = (entry.pinType && _pinTypeMap()[entry.pinType]) ? _pinTypeMap()[entry.pinType] : '📍';
    const icon = L.divIcon({
      className: '',
      html: `<div style="background:#0891b2;border:2px solid #fff;border-radius:50%;width:30px;height:30px;display:flex;align-items:center;justify-content:center;font-size:17px;box-shadow:0 1px 6px rgba(0,0,0,.4)"><span style="filter:grayscale(1) brightness(2)">${emoji}</span></div>`,
      iconSize:   [30, 30],
      iconAnchor: [15, 15],
      popupAnchor:[0, -18],
    });

    const marker = L.marker([entry.lat, entry.lng], { icon });

    const contentSnippet = entry.content
      ? entry.content.slice(0, 80) + (entry.content.length > 80 ? '…' : '')
      : '';

    marker.bindPopup(`
      <div style="padding:4px 2px;min-width:130px">
        <div style="font-weight:700;font-size:12px;margin-bottom:2px">${_esc(entry.title || 'Sans titre')}</div>
        ${entry.date ? `<div style="font-size:11px;color:#6b7280">${_esc(fmtDate(entry.date))}</div>` : ''}
        ${contentSnippet ? `<div style="font-size:11px;margin-top:4px;color:#374151">${_esc(contentSnippet)}</div>` : ''}
      </div>
    `, { maxWidth: 200 });

    marker.on('click', () => {
      _highlightEntry(entry.id);
    });

    marker.addTo(_journalMap);
    _journalMarkers[entry.id] = marker;
  });

  // Fit bounds
  if (entries.length === 1) {
    _journalMap.setView([entries[0].lat, entries[0].lng], 10, { animate: true });
  } else if (entries.length > 1) {
    const bounds = entries.map(e => [e.lat, e.lng]);
    _journalMap.fitBounds(bounds, { padding: [40, 40], maxZoom: 12 });
  }
}

function _highlightEntry(entryId) {
  // Remove highlight from all entries
  document.querySelectorAll('.jn-entry').forEach(el => {
    el.style.outline = '';
    el.style.background = '';
  });
  // Highlight the target entry
  const el = document.querySelector(`.jn-entry[data-entry-id="${CSS.escape(entryId)}"]`);
  if (el) {
    el.style.outline = '2px solid #0891b2';
    el.style.background = '#e0f2fe';
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    // Remove highlight after 2.5s
    setTimeout(() => {
      el.style.outline = '';
      el.style.background = '';
    }, 2500);
  }
}

// ── Event delegation ──────────────────────────────────────────────────────────

function _handleClick(e, tripId) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;

  const action = btn.dataset.action;

  if (action === 'add-entry') {
    _openEntryModal(tripId, null);
  } else if (action === 'edit-entry') {
    _openEntryModal(tripId, btn.dataset.entryId);
  } else if (action === 'delete-entry') {
    const entryId = btn.dataset.entryId;
    if (confirm('Supprimer cette entrée de journal ?')) {
      const trip = getTrip(tripId);
      updateTrip(tripId, {
        journalEntries: (trip.journalEntries || []).filter(en => en.id !== entryId)
      });
      notify('Entrée supprimée', '🗑');
      renderJournal(tripId);
    }
  } else if (action === 'filter-day') {
    const dayId = btn.dataset.dayId || null;
    _activeDayFilter = dayId || null;
    // Re-render just the chips and entries list
    const trip = getTrip(tripId);
    if (!trip) return;
    const allEntries = [...(trip.journalEntries || [])].sort((a, b) =>
      (b.date || '').localeCompare(a.date || '')
    );
    const chipsWrap = btn.closest('[style*="border-bottom"]') || btn.parentElement?.parentElement;
    if (chipsWrap) {
      chipsWrap.innerHTML = _buildDayChipsHtml(trip);
    }
    const listEl = document.getElementById('journal-entries-list');
    if (listEl) listEl.innerHTML = _buildEntriesListHtml(trip, allEntries);
  }
}

// ── Add / Edit Modal ──────────────────────────────────────────────────────────

function _openEntryModal(tripId, entryId) {
  const trip = getTrip(tripId);
  if (!trip) return;

  const isEdit = !!entryId;
  const entry  = isEdit ? (trip.journalEntries || []).find(e => e.id === entryId) : null;

  const state = {
    dayId:    entry?.dayId    || (_activeDayFilter || ''),
    date:     entry?.date     || _today(),
    title:    entry?.title    || '',
    content:  entry?.content  || '',
    weather:  entry?.weather  || '',
    mood:     entry?.mood     || '',
    rating:   entry?.rating   || 0,
    photos:   entry ? [...(entry.photos || [])] : [],
    tags:     entry ? [...(entry.tags   || [])] : [],
    lat:      entry?.lat      ?? null,
    lng:      entry?.lng      ?? null,
    pinType:  entry?.pinType  ?? null,
    // Nominatim search results
    _locResults: [],
    _locQuery:   '',
  };

  // Pre-fill from day data when creating a new entry with a day selected
  if (!isEdit && state.dayId) {
    const day = (trip.days || []).find(d => d.id === state.dayId);
    if (day) {
      if (state.title === '' && day.title) {
        state.title = day.title;
      }
      if (state.content === '') {
        const events = day.events || day.items || [];
        if (events.length > 0) {
          state.content = 'Activités du jour :\n' + events.map(ev => `- ${ev.title || ev.name || ev.type || ''}`).join('\n');
        }
      }
    }
  }

  const days = trip.days || [];

  const weatherEmojis = ['☀️', '⛅', '🌧️', '⛈️', '🌨️', '🌫️', '🌊', '🏔️'];
  const moodEmojis    = ['😊', '😎', '😍', '🥹', '😴', '🤔', '😤', '🙏'];

  function daysOptsHtml(selId) {
    return `<option value="">Aucun jour spécifique</option>` +
      days.map(d =>
        `<option value="${_esc(d.id)}"${selId === d.id ? ' selected' : ''}>Jour ${d.num}${d.title ? ' · ' + _esc(d.title) : ''}${d.date ? ' (' + fmtDateShort(d.date) + ')' : ''}</option>`
      ).join('');
  }

  function emojiBtn(emoji, selectedVal, groupName) {
    const sel = selectedVal === emoji;
    return `<button type="button" class="emoji-pick-btn${sel ? ' selected' : ''}" data-group="${groupName}" data-val="${_esc(emoji)}"
      style="background:${sel ? 'var(--tl)' : 'var(--c2)'};border:1.5px solid ${sel ? 'var(--teal)' : 'var(--c3)'};
      border-radius:8px;padding:4px 6px;font-size:18px;cursor:pointer;transition:all .1s">${emoji}</button>`;
  }

  function pinTypeButtons() {
    const btns = [
      { val: null, emoji: '—', label: 'Aucun' },
      ...getPinTypes().map(pt => ({ val: pt.key, emoji: pt.emoji, label: pt.label })),
    ];
    return btns.map(({ val, emoji, label }) => {
      const sel = state.pinType === val;
      const dataVal = val === null ? '' : val;
      return `<button type="button" class="emoji-pick-btn${sel ? ' selected' : ''}" data-group="pintype" data-val="${_esc(dataVal)}"
        title="${_esc(label)}"
        style="background:${sel ? 'var(--tl)' : 'var(--c2)'};border:1.5px solid ${sel ? 'var(--teal)' : 'var(--c3)'};
        border-radius:8px;padding:4px 8px;font-size:18px;cursor:pointer;transition:all .1s">${emoji}</button>`;
    }).join('');
  }

  function photosListHtml() {
    if (state.photos.length === 0) {
      return '<div style="font-size:11px;color:var(--ink4);padding:4px 0">Aucune photo ajoutée</div>';
    }
    return state.photos.map((ph, i) => `
      <div style="display:flex;align-items:center;gap:7px;margin-bottom:6px">
        <input type="text" placeholder="URL de la photo" value="${_esc(ph.url)}" data-photo-url="${i}"
          style="flex:1;background:var(--c);border:1.5px solid var(--c3);border-radius:7px;padding:6px 9px;font-size:12px;font-family:var(--fn);outline:none">
        <input type="text" placeholder="Légende" value="${_esc(ph.caption)}" data-photo-cap="${i}"
          style="flex:1;background:var(--c);border:1.5px solid var(--c3);border-radius:7px;padding:6px 9px;font-size:12px;font-family:var(--fn);outline:none">
        <button type="button" data-remove-photo="${i}" style="background:var(--crl);color:var(--coral);border:none;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:12px">✕</button>
      </div>`).join('');
  }

  function tagsHtml() {
    return state.tags.map((t, i) => `
      <span style="display:inline-flex;align-items:center;gap:4px;background:var(--tl);color:var(--td);border-radius:999px;padding:2px 8px;font-size:11px;font-weight:700">
        ${_esc(t)}
        <button type="button" data-remove-tag="${i}" style="background:none;border:none;color:var(--td);cursor:pointer;font-size:11px;padding:0;line-height:1">✕</button>
      </span>`).join('');
  }

  function starsHtml() {
    return [1, 2, 3, 4, 5].map(i =>
      `<span data-action="set-star" data-val="${i}"
        style="font-size:22px;cursor:pointer;opacity:${state.rating >= i ? '1' : '0.3'};transition:opacity .1s">★</span>`
    ).join('');
  }

  function locBadge() {
    if (state.lat != null && state.lng != null) {
      return `<div style="font-size:11px;color:#0891b2;margin-top:4px;display:flex;align-items:center;gap:4px">
        <span>📍</span>
        <span>${state.lat.toFixed(5)}, ${state.lng.toFixed(5)}</span>
        <button type="button" id="je-loc-clear" style="background:none;border:none;color:var(--coral);cursor:pointer;font-size:11px;padding:0 2px" title="Effacer">✕</button>
      </div>`;
    }
    return '';
  }

  function locResultsHtml() {
    if (!state._locResults.length) return '';
    return `<div id="je-loc-results" style="border:1.5px solid var(--c3);border-radius:7px;background:var(--c);margin-top:4px;max-height:160px;overflow-y:auto">
      ${state._locResults.map((r, i) =>
        `<div data-loc-idx="${i}" style="padding:7px 10px;cursor:pointer;font-size:12px;border-bottom:1px solid var(--c2)"
          onmouseover="this.style.background='var(--c2)'" onmouseout="this.style.background=''">${_esc(r.display_name)}</div>`
      ).join('')}
    </div>`;
  }

  function buildHtml() {
    return `
      <button class="mc" onclick="closeModal()">✕</button>
      <h3>${isEdit ? '✏️ Modifier l\'entrée' : '📝 Nouvelle entrée de journal'}</h3>

      <div class="fg">
        <label>Jour du voyage</label>
        <select id="je-day">${daysOptsHtml(state.dayId)}</select>
      </div>

      <div class="fg">
        <label>Date</label>
        <input type="date" id="je-date" value="${_esc(state.date)}">
      </div>

      <div class="fg">
        <label>Titre</label>
        <input type="text" id="je-title" placeholder="Titre de l'entrée" value="${_esc(state.title)}">
      </div>

      <div class="fg">
        <label>Récit</label>
        <textarea id="je-content" rows="6" placeholder="Racontez votre journée...">${_esc(state.content)}</textarea>
      </div>

      <div class="fg">
        <label>Type de lieu</label>
        <div style="display:flex;gap:5px;flex-wrap:wrap" id="pintype-row">
          ${pinTypeButtons()}
        </div>
      </div>

      <div class="fg">
        <label>Localisation <span style="font-size:10px;color:var(--ink4);font-weight:400">(optionnel — apparaît sur la carte)</span></label>
        <div style="display:flex;gap:6px">
          <input type="text" id="je-loc-input" placeholder="Ex : Paris, Reykjavik…" value="${_esc(state._locQuery)}"
            style="flex:1;background:var(--c);border:1.5px solid var(--c3);border-radius:7px;padding:7px 9px;font-size:12px;font-family:var(--fn);outline:none">
          <button type="button" id="je-loc-search"
            style="background:var(--teal);color:#fff;border:none;border-radius:7px;padding:7px 12px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap">
            🔍 Chercher
          </button>
        </div>
        ${locResultsHtml()}
        ${locBadge()}
      </div>

      <div class="fg">
        <label>Météo</label>
        <div style="display:flex;gap:5px;flex-wrap:wrap" id="weather-row">
          ${weatherEmojis.map(em => emojiBtn(em, state.weather, 'weather')).join('')}
        </div>
      </div>

      <div class="fg">
        <label>Humeur</label>
        <div style="display:flex;gap:5px;flex-wrap:wrap" id="mood-row">
          ${moodEmojis.map(em => emojiBtn(em, state.mood, 'mood')).join('')}
        </div>
      </div>

      <div class="fg">
        <label>Note</label>
        <div id="modal-star-row" style="display:flex;gap:6px">${starsHtml()}</div>
      </div>

      <div class="fg">
        <label>Photos</label>
        <div id="photos-list">${photosListHtml()}</div>
        <button type="button" id="add-photo-btn"
          style="margin-top:6px;background:var(--c2);border:1px solid var(--c3);border-radius:7px;padding:5px 12px;font-size:12px;font-weight:700;cursor:pointer;color:var(--ink3)">
          ＋ Ajouter une photo
        </button>
      </div>

      <div class="fg">
        <label>Tags</label>
        <div id="tags-list" style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:6px">${tagsHtml()}</div>
        <div style="display:flex;gap:6px">
          <input type="text" id="tag-input" placeholder="Nouveau tag, puis Entrée"
            style="flex:1;background:var(--c);border:1.5px solid var(--c3);border-radius:7px;padding:6px 9px;font-size:12px;font-family:var(--fn);outline:none">
          <button type="button" id="add-tag-btn"
            style="background:var(--teal);color:#fff;border:none;border-radius:7px;padding:6px 12px;font-size:12px;font-weight:700;cursor:pointer">＋</button>
        </div>
      </div>

      <div class="ma">
        <button class="bc" onclick="closeModal()">Annuler</button>
        <button class="bs" id="je-save">Enregistrer</button>
      </div>`;
  }

  function reRenderModal() {
    const mbox = document.querySelector('.mbox');
    if (mbox) {
      mbox.innerHTML = buildHtml();
      attachModalEvents();
    }
  }

  function reRenderTagsList() {
    const tl = document.getElementById('tags-list');
    if (tl) {
      tl.innerHTML = tagsHtml();
      tl.addEventListener('click', tagRemoveHandler);
    }
  }

  function tagRemoveHandler(ev) {
    const btn = ev.target.closest('[data-remove-tag]');
    if (!btn) return;
    state.tags.splice(parseInt(btn.dataset.removeTag, 10), 1);
    reRenderTagsList();
  }

  function attachModalEvents() {
    // Day selector
    document.getElementById('je-day')?.addEventListener('change', ev => {
      state.dayId = ev.target.value;
      if (state.dayId) {
        const d = days.find(d => d.id === state.dayId);
        if (d?.date) {
          state.date = d.date;
          const dateEl = document.getElementById('je-date');
          if (dateEl) dateEl.value = d.date;
        }
      }
    });

    // Date input
    document.getElementById('je-date')?.addEventListener('change', ev => {
      state.date = ev.target.value;
    });

    // Location search
    document.getElementById('je-loc-search')?.addEventListener('click', async () => {
      const q = (document.getElementById('je-loc-input')?.value || '').trim();
      if (!q) return;
      state._locQuery = q;
      try {
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=5&accept-language=fr`;
        const res = await fetch(url, { headers: { 'Accept-Language': 'fr' } });
        const results = await res.json();
        state._locResults = results;
        reRenderModal();
      } catch (err) {
        notify('Erreur de recherche de localisation', '⚠️');
      }
    });

    // Location input — search on Enter
    document.getElementById('je-loc-input')?.addEventListener('keydown', async ev => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        document.getElementById('je-loc-search')?.click();
      }
    });

    // Dynamic search on input (debounced)
    let _locDebTimer = null;
    document.getElementById('je-loc-input')?.addEventListener('input', () => {
      clearTimeout(_locDebTimer);
      const q = (document.getElementById('je-loc-input')?.value || '').trim();
      if (q.length < 3) {
        const res = document.getElementById('je-loc-results');
        if (res) res.innerHTML = '';
        return;
      }
      _locDebTimer = setTimeout(() => {
        document.getElementById('je-loc-search')?.click();
      }, 500);
    });

    // Location results — click to pick
    document.getElementById('je-loc-results')?.addEventListener('click', ev => {
      const row = ev.target.closest('[data-loc-idx]');
      if (!row) return;
      const idx = parseInt(row.dataset.locIdx, 10);
      const r   = state._locResults[idx];
      if (!r) return;
      state.lat = parseFloat(r.lat);
      state.lng = parseFloat(r.lon);
      state._locResults = [];
      state._locQuery = r.display_name.split(',')[0].trim();
      reRenderModal();
    });

    // Location clear
    document.getElementById('je-loc-clear')?.addEventListener('click', () => {
      state.lat = null;
      state.lng = null;
      state._locResults = [];
      reRenderModal();
    });

    // Pin type picker
    document.getElementById('pintype-row')?.addEventListener('click', ev => {
      const btn = ev.target.closest('.emoji-pick-btn[data-group="pintype"]');
      if (!btn) return;
      const val = btn.dataset.val || null;
      state.pinType = state.pinType === val ? null : val;
      reRenderModal();
    });

    // Weather picker
    document.getElementById('weather-row')?.addEventListener('click', ev => {
      const btn = ev.target.closest('.emoji-pick-btn[data-group="weather"]');
      if (!btn) return;
      state.weather = state.weather === btn.dataset.val ? '' : btn.dataset.val;
      reRenderModal();
    });

    // Mood picker
    document.getElementById('mood-row')?.addEventListener('click', ev => {
      const btn = ev.target.closest('.emoji-pick-btn[data-group="mood"]');
      if (!btn) return;
      state.mood = state.mood === btn.dataset.val ? '' : btn.dataset.val;
      reRenderModal();
    });

    // Rating stars
    document.getElementById('modal-star-row')?.addEventListener('click', ev => {
      const star = ev.target.closest('[data-action="set-star"]');
      if (!star) return;
      const val = parseInt(star.dataset.val, 10);
      state.rating = state.rating === val ? 0 : val;
      reRenderModal();
    });

    // Add photo button
    document.getElementById('add-photo-btn')?.addEventListener('click', () => {
      state.photos.push({ url: '', caption: '' });
      reRenderModal();
    });

    // Photo list — URL/caption changes and removals
    document.getElementById('photos-list')?.addEventListener('input', ev => {
      const urlIdx = ev.target.dataset.photoUrl;
      const capIdx = ev.target.dataset.photoCap;
      if (urlIdx !== undefined) state.photos[parseInt(urlIdx, 10)].url     = ev.target.value;
      if (capIdx !== undefined) state.photos[parseInt(capIdx, 10)].caption = ev.target.value;
    });
    document.getElementById('photos-list')?.addEventListener('click', ev => {
      const btn = ev.target.closest('[data-remove-photo]');
      if (!btn) return;
      state.photos.splice(parseInt(btn.dataset.removePhoto, 10), 1);
      reRenderModal();
    });

    // Add tag
    const doAddTag = () => {
      const inp = document.getElementById('tag-input');
      if (!inp) return;
      const raw = inp.value.trim();
      if (!raw) return;
      raw.split(',').map(t => t.trim()).filter(Boolean).forEach(t => {
        if (!state.tags.includes(t)) state.tags.push(t);
      });
      inp.value = '';
      reRenderTagsList();
    };
    document.getElementById('add-tag-btn')?.addEventListener('click', doAddTag);
    document.getElementById('tag-input')?.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') { ev.preventDefault(); doAddTag(); }
    });

    // Tag remove
    document.getElementById('tags-list')?.addEventListener('click', tagRemoveHandler);

    // Save
    document.getElementById('je-save')?.addEventListener('click', () => {
      // Collect latest input values
      state.title   = document.getElementById('je-title')?.value?.trim()  || '';
      state.content = document.getElementById('je-content')?.value         || '';
      state.date    = document.getElementById('je-date')?.value            || _today();
      state.dayId   = document.getElementById('je-day')?.value             || '';

      // Collect photo inputs (they may have changed since last rerender)
      state.photos = state.photos.map((ph, i) => ({
        url:     (document.querySelector(`[data-photo-url="${i}"]`)?.value ?? ph.url).trim(),
        caption: (document.querySelector(`[data-photo-cap="${i}"]`)?.value ?? ph.caption).trim(),
      })).filter(ph => ph.url !== '');

      const freshTrip = getTrip(tripId);
      const entries   = [...(freshTrip.journalEntries || [])];

      if (isEdit) {
        const idx = entries.findIndex(en => en.id === entryId);
        if (idx !== -1) {
          entries[idx] = {
            ...entries[idx],
            dayId:   state.dayId   || null,
            date:    state.date,
            title:   state.title,
            content: state.content,
            weather: state.weather,
            mood:    state.mood,
            rating:  state.rating  || null,
            photos:  state.photos,
            tags:    state.tags,
            lat:     state.lat,
            lng:     state.lng,
            pinType: state.pinType || null,
          };
        }
        notify('Entrée mise à jour', '✓');
      } else {
        entries.push({
          id:      'je_' + uid(),
          dayId:   state.dayId   || null,
          date:    state.date,
          title:   state.title,
          content: state.content,
          weather: state.weather,
          mood:    state.mood,
          rating:  state.rating  || null,
          photos:  state.photos,
          tags:    state.tags,
          lat:     state.lat,
          lng:     state.lng,
          pinType: state.pinType || null,
        });
        notify('Entrée ajoutée', '📔');
      }

      updateTrip(tripId, { journalEntries: entries });
      closeModal();
      renderJournal(tripId);
    });
  }

  showModal(buildHtml());
  attachModalEvents();
}
