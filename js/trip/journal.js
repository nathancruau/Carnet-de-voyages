/* ============================================================
   CARNET DE VOYAGES — Journal Module
   ============================================================ */

import { getTrip, updateTrip, uid, getEventTypes, getLanguage, isTripShared } from '../store.js';
import { notify, showModal, closeModal, fmtDate, fmtDateShort, isoToDate, dateToIso } from '../utils.js';
import { updateTopStats } from './trip.js';
import { getCurrentUser } from '../auth.js';

// ── Event type emoji map ──────────────────────────────────────────────────────

function _etMap() {
  const map = {};
  for (const et of getEventTypes()) map[et.key] = et;
  return map;
}

function _getTagSuggestions(trip, dayId) {
  const suggestions = [];
  const seen = new Set();
  if (!dayId) return suggestions;
  const day = (trip.days || []).find(d => d.id === dayId);
  if (!day) return suggestions;
  const etMap = _etMap();
  // Day region/title as tag
  if (day.region) { suggestions.push(day.region); seen.add(day.region); }
  // Event types as emoji-tags
  for (const item of (day.items || [])) {
    const et = etMap[item.type];
    if (et) {
      const tag = `${et.emoji} ${et.label}`;
      if (!seen.has(tag)) { seen.add(tag); suggestions.push(tag); }
    }
    if (item.text && !seen.has(item.text) && item.text.length < 30) {
      seen.add(item.text); suggestions.push(item.text);
    }
  }
  return suggestions.slice(0, 12);
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

function _gpxStatsHtml(item) {
  const s = item.gpxStats;
  if (!s) return '';
  const distKm = s.distanceM >= 1000 ? (s.distanceM / 1000).toFixed(1) + ' km' : s.distanceM + ' m';
  let durationLabel = '';
  if (s.durationSecs) {
    const h = Math.floor(s.durationSecs / 3600);
    const m = Math.floor((s.durationSecs % 3600) / 60);
    durationLabel = h > 0 ? `${h}h${m.toString().padStart(2, '0')}` : `${m} min`;
  }
  const parts = [
    `<span class="tl-meta-pill" style="background:#e0f2fe;color:#0284c7;border-color:#7dd3fc">📏 ${distKm}</span>`,
    s.elevGain ? `<span class="tl-meta-pill" style="background:#dcfce7;color:#16a34a;border-color:#86efac">↑ ${s.elevGain} m</span>` : '',
    s.elevLoss ? `<span class="tl-meta-pill" style="background:#fff7ed;color:#ea580c;border-color:#fdba74">↓ ${s.elevLoss} m</span>` : '',
    s.altMin != null ? `<span class="tl-meta-pill">⛰ ${s.altMin}–${s.altMax} m</span>` : '',
    s.speedAvgKph != null ? `<span class="tl-meta-pill">⚡ ${s.speedAvgKph} km/h moy.</span>` : '',
    s.speedMaxKph != null ? `<span class="tl-meta-pill">🏎 ${s.speedMaxKph} km/h max</span>` : '',
    durationLabel ? `<span class="tl-meta-pill">⏱ ${durationLabel}</span>` : '',
  ].filter(Boolean);
  if (!parts.length) return '';
  return `<div class="tl-meta" style="margin-top:4px">${parts.join('')}</div>`;
}

// ── Handler registry (avoids double-binding) ─────────────────────────────────

const _handlers = new WeakMap();

// ── Map state ─────────────────────────────────────────────────────────────────

let _journalMap              = null;
let _journalMarkers          = {};
let _journalRouteLayers      = [];
let _journalGpxLayers        = [];
let _journalTripId           = null;
let _journalWorldCopyMarkers = [];   // non-interactive copies at ±360° offsets
let _journalWorldCopyOffsets = new Set();

// ── Day filter state ──────────────────────────────────────────────────────────

let _activeDayFilter  = null;
let _observerMode     = false;
let _journalView      = 'map'; // 'map' | 'timeline'
let _journalMobTab    = 'carte';   // 'carte' | 'activite' | 'timeline' (mobile only)
let _shareMod         = null;  // cached dynamic import of share.js

export function destroyJournalMap() {
  if (_journalMap) {
    try { _journalMap.remove(); } catch (_) { /* already removed */ }
    _journalMap = null;
  }
  _journalMarkers     = {};
  _journalRouteLayers = [];
  _journalGpxLayers   = [];
  _journalTripId      = null;
}

// ── Route helpers (mirrors mapcal logic) ──────────────────────────────────────

function _jCollectWaypoints(trip) {
  const wps = [];
  for (const day of (trip.days || [])) {
    const itemPins = (day.items || []).filter(it => it.lat != null && it.lng != null);
    if (itemPins.length > 0) {
      for (const item of itemPins) {
        let mode = item.routeMode || 'car';
        if (item.type === 'drive' && item.transport) mode = item.transport;
        wps.push({ lat: item.lat, lng: item.lng, mode });
      }
    } else if (day.lat != null && day.lng != null) {
      wps.push({ lat: day.lat, lng: day.lng, mode: day.routeMode || 'car' });
    }
  }
  return wps;
}

function _jOsrmProfile(mode) {
  return { car: 'driving', bus: 'driving', foot: 'foot', bike: 'cycling' }[mode] || 'driving';
}

function _jModeColor(mode) {
  return { car: '#0284c7', foot: '#16a34a', bike: '#d97706', bus: '#7c3aed', plane: '#7c3aed', ferry: '#0d9488' }[mode] || '#9c9890';
}

async function _drawJournalRoutes(tripId) {
  if (!_journalMap) return;
  const trip = getTrip(tripId);
  if (!trip) return;

  _journalRouteLayers.forEach(l => { try { _journalMap.removeLayer(l); } catch (_) {} });
  _journalRouteLayers = [];

  const wps = _jCollectWaypoints(trip);
  if (wps.length < 2) return;

  for (let i = 0; i < wps.length - 1; i++) {
    if (!_journalMap) return;
    const from = wps[i];
    const to   = wps[i + 1];
    const mode = to.mode || 'car';
    let line   = null;

    if (mode === 'plane' || mode === 'ferry') {
      line = L.polyline([[from.lat, from.lng], [to.lat, to.lng]], {
        color: mode === 'plane' ? '#7c3aed' : '#0d9488', weight: 2, opacity: 0.6, dashArray: '6 6',
      });
    } else {
      try {
        const url = `https://router.project-osrm.org/route/v1/${_jOsrmProfile(mode)}/`
          + `${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
        const resp   = await fetch(url);
        const data   = await resp.json();
        if (!_journalMap) return;
        const coords = data.routes?.[0]?.geometry?.coordinates;
        if (coords && coords.length) {
          line = L.polyline(coords.map(([lng, lat]) => [lat, lng]), {
            color: _jModeColor(mode), weight: 3, opacity: 0.7,
          });
        }
      } catch (_) {}
      if (!line) {
        line = L.polyline([[from.lat, from.lng], [to.lat, to.lng]], {
          color: '#9c9890', weight: 2, opacity: 0.4, dashArray: '4 4',
        });
      }
    }

    if (line && _journalMap) {
      line.addTo(_journalMap);
      _journalRouteLayers.push(line);
    }
  }
}

// ── Observer "new item" tracking ──────────────────────────────────────────────

function _obsSeenKey(tripId) {
  const uid = getCurrentUser()?.uid;
  return uid ? `_obsLastSeen_${uid}_${tripId}` : null;
}

/** Call when the observer explicitly opens the journal tab — clears new badges. */
export function ackJournalSeen(tripId) {
  const key = _obsSeenKey(tripId);
  if (key) localStorage.setItem(key, new Date().toISOString());
}

/** True if the item was validated after the observer last acknowledged this trip. */
function _obsIsNew(item, tripId) {
  const vAt = item.journalData?.validatedAt;
  if (!vAt) return false;
  const key      = _obsSeenKey(tripId);
  const lastSeen = key ? localStorage.getItem(key) : null;
  if (!lastSeen) return true; // never visited — all items are new
  return vAt > lastSeen;
}

// ── Render ────────────────────────────────────────────────────────────────────

/** Re-render the journal preserving current view and observer state — called by window hook. */
export function rerenderJournal(tripId) {
  renderJournal(tripId, _observerMode);
}

export async function renderJournal(tripId, isObserver = false) {
  _observerMode = isObserver;
  const panel = document.getElementById('panel-journal');
  if (!panel) return;

  // Reset per-trip UI state when the trip changes so stale filter/view from a
  // previous trip doesn't bleed into the new one's render.
  if (tripId !== _journalTripId) {
    _activeDayFilter = null;
    _journalView     = 'map';
    _journalMobTab   = 'carte';
  }

  if (_journalMap) destroyJournalMap();

  const trip = getTrip(tripId);
  if (!trip) return;

  _journalTripId = tripId;

  // Pre-load share module for reactions/comments (resolves from cache instantly after first load)
  if (isTripShared(tripId) && !_shareMod) {
    try { _shareMod = await import('../share.js'); } catch (_) {}
  }

  if (_handlers.has(panel)) {
    panel.removeEventListener('click', _handlers.get(panel));
    _handlers.delete(panel);
  }

  if (_journalView === 'timeline') {
    _renderTimelineView(panel, trip, tripId, isObserver);
  } else if (isObserver) {
    _renderObserverView(panel, trip, tripId);
  } else {
    const isMobile = window.innerWidth <= 768;
    const isActivite = isMobile && _journalMobTab === 'activite';

    panel.innerHTML = `
      ${isMobile ? `
        <div class="jn-mob-tabs">
          <button class="bm-tab${_journalMobTab==='carte'?' active':''}" data-action="jn-tab" data-tab="carte">🗺 Carte</button>
          <button class="bm-tab${_journalMobTab==='activite'?' active':''}" data-action="jn-tab" data-tab="activite">📋 Activité</button>
          <button class="bm-tab${_journalMobTab==='timeline'?' active':''}" data-action="jn-tab" data-tab="timeline">📖 Timeline</button>
        </div>
      ` : ''}
      <div class="mapcal${isActivite ? ' jn-activite-mode' : ''}">
        <div class="left-panel${isMobile && !isActivite ? ' collapsed' : ''}" style="width:290px;min-width:240px;max-width:290px;display:flex;flex-direction:column">
          ${!isMobile ? _viewToggleHtml('map') : ''}
          <div style="padding:8px 14px 4px;flex-shrink:0">
            <h3 style="font-family:var(--sf);font-size:15px;font-weight:700;color:var(--ink);margin:0">📔 Carnet</h3>
            <p style="font-size:11px;color:var(--ink4);margin-top:2px">Validez vos activités · les PIN apparaissent sur la carte</p>
          </div>
          <div class="days-scroll" id="journal-activities-list" style="flex:1;overflow-y:auto;padding:6px 8px">
            ${_buildActivitiesHtml(trip)}
          </div>
        </div>
        <div class="map-col" style="flex:1;position:relative">
          ${!isMobile ? `<button class="lp-toggle-btn" id="jn-lp-toggle" title="Activités">◀</button>` : ''}
          <div id="journal-map" style="width:100%;height:100%"></div>
        </div>
      </div>`;

    // Wire left-panel toggle (desktop only)
    if (!isMobile) {
      const jnLp     = panel.querySelector('.left-panel');
      const jnToggle = panel.querySelector('#jn-lp-toggle');
      if (jnToggle && jnLp) {
        jnToggle.addEventListener('click', () => {
          const collapsed = jnLp.classList.toggle('collapsed');
          jnToggle.innerHTML = collapsed ? '▶' : '◀';
          setTimeout(() => { if (_journalMap) _journalMap.invalidateSize(); }, 280);
        });
      }
    }

    _initJournalMap(tripId);
  }

  const handler = e => _handleClick(e, tripId);
  _handlers.set(panel, handler);
  panel.addEventListener('click', handler);
}

// ── Observer view ─────────────────────────────────────────────────────────────

function _renderObserverView(panel, trip, tripId) {
  const days = trip.days || [];
  const validatedItems = [];

  for (const day of days) {
    for (const item of (day.items || [])) {
      if (item.journalData?.validated) {
        validatedItems.push({ day, item });
      }
    }
  }

  const hasItems = validatedItems.length > 0;

  panel.innerHTML = `
    <div class="mapcal">
      <div class="left-panel" style="width:320px;min-width:260px;max-width:320px;display:flex;flex-direction:column">
        ${_viewToggleHtml('map')}
        <div style="padding:8px 14px 4px;flex-shrink:0">
          <h3 style="font-family:var(--sf);font-size:15px;font-weight:700;color:var(--ink);margin:0">📔 Carnet de voyage</h3>
          <p style="font-size:11px;color:var(--ink4);margin-top:2px">Mis à jour en direct par les voyageurs</p>
        </div>
        <div class="days-scroll" id="observer-feed" style="flex:1;overflow-y:auto;padding:6px 8px">
          ${hasItems ? _buildObserverFeedHtml(validatedItems, tripId) : _buildObserverEmptyHtml()}
        </div>
      </div>
      <div class="map-col" style="flex:1;position:relative">
        <div id="journal-map" style="width:100%;height:100%"></div>
      </div>
    </div>`;

  _initJournalMap(tripId);
}

function _buildObserverEmptyHtml() {
  return `
    <div style="text-align:center;padding:40px 16px;color:var(--ink4)">
      <div style="font-size:40px;margin-bottom:12px">📡</div>
      <p style="font-size:13px;font-weight:600;color:var(--ink3)">En attente de nouvelles publications…</p>
      <p style="font-size:11px;margin-top:6px">Les voyageurs publieront leurs activités au fil du voyage</p>
    </div>`;
}

function _buildObserverFeedHtml(validatedItems, tripId) {
  // Group by day
  const groups = new Map();
  for (const { day, item } of validatedItems) {
    if (!groups.has(day.id)) groups.set(day.id, { day, items: [] });
    groups.get(day.id).items.push(item);
  }

  let html = '';
  for (const [, { day, items }] of groups) {
    const dayLabel  = `Jour ${day.num}${day.title ? ' · ' + day.title : ''}`;
    const hasNewInDay = items.some(it => _obsIsNew(it, tripId));
    html += `<div class="jn-day-group">
      <div class="jn-day-label">
        ${_esc(dayLabel)}${day.date ? `<span style="font-weight:400;font-size:10px;color:var(--ink4);margin-left:5px">${fmtDateShort(day.date)}</span>` : ''}
        ${hasNewInDay ? `<span class="obs-new-dot"></span>` : ''}
      </div>`;

    for (const item of items) {
      const jd       = item.journalData;
      const typeIcon = _eventTypeIcon(item.type);
      const photos   = jd.photos || [];
      const isNew    = _obsIsNew(item, tripId);

      html += `
        <div class="obs-entry${isNew ? ' obs-entry-new' : ''}">
          <div class="obs-entry-hd">
            <span style="font-size:16px">${typeIcon}</span>
            <div style="flex:1;min-width:0">
              <div style="font-weight:600;font-size:12px;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(item.text || '—')}</div>
              <div style="font-size:10px;color:var(--ink4);margin-top:1px;display:flex;gap:6px;flex-wrap:wrap">
                ${jd.weather ? `<span>${jd.weather}</span>` : ''}
                ${jd.amount  ? `<span>💶 ${jd.amount}€</span>` : ''}
                ${item.time  ? `<span>🕐 ${_esc(item.time)}</span>` : ''}
              </div>
            </div>
            ${isNew ? `<span class="obs-new-badge">Nouveau</span>` : `<span class="obs-validated-badge">✓</span>`}
          </div>
          ${jd.notes ? `<div class="obs-notes">${_esc(jd.notes).replace(/\n/g, '<br>')}</div>` : ''}
          ${_gpxStatsHtml(item)}
          ${photos.length > 0 ? `<div class="obs-photos">${photos.map(src =>
            `<img src="${_esc(src)}" class="obs-photo" onclick="window.open(this.src,'_blank')">`
          ).join('')}</div>` : ''}
        </div>`;
    }
    html += `</div>`;
  }
  return html;
}

// ── View toggle ───────────────────────────────────────────────────────────────

function _viewToggleHtml(activeView) {
  return `
    <div class="jn-view-toggle">
      <button class="jn-view-btn${activeView === 'map' ? ' active' : ''}" data-action="switch-view" data-view="map">🗺 Carte</button>
      <button class="jn-view-btn${activeView === 'timeline' ? ' active' : ''}" data-action="switch-view" data-view="timeline">📅 Timeline</button>
    </div>`;
}

// ── Timeline view ─────────────────────────────────────────────────────────────

function _renderTimelineView(panel, trip, tripId, isObserver) {
  const sharedDoc    = isTripShared(tripId) ? _shareMod?.getSharedDocData?.(tripId) : null;
  const currentUid   = getCurrentUser()?.uid || null;
  panel.innerHTML = `
    <div class="tl-wrap">
      ${_viewToggleHtml('timeline')}
      <div class="tl-scroll" id="tl-scroll">
        ${_buildTimelineHtml(trip, tripId, isObserver, sharedDoc, currentUid)}
      </div>
    </div>`;
}

function _buildTimelineHtml(trip, tripId, isObserver, sharedDoc, currentUid) {
  const days = trip.days || [];

  if (isObserver) {
    let html = '';
    for (const day of days) {
      const items = (day.items || []).filter(it => it.journalData?.validated);
      if (items.length === 0) continue;
      html += _tlDayHtml(day, items, true, tripId, sharedDoc, currentUid);
    }
    if (!html) return `
      <div class="tl-empty">
        <div style="font-size:40px;margin-bottom:12px">📡</div>
        <p style="font-size:13px;font-weight:600;color:var(--ink3)">En attente de publications…</p>
        <p style="font-size:11px;margin-top:6px;color:var(--ink4)">Les voyageurs publieront leurs activités au fil du voyage</p>
      </div>`;
    return html;
  }

  const hasAny = days.some(d => (d.items || []).length > 0);
  if (!hasAny) return `
    <div class="tl-empty">
      <div style="font-size:36px;margin-bottom:8px">📅</div>
      <p style="font-size:13px;font-weight:600;color:var(--ink3)">Aucune activité planifiée</p>
      <p style="font-size:11px;margin-top:6px;color:var(--ink4)">Ajoutez des activités dans Carte &amp; Planning pour les retrouver ici</p>
    </div>`;

  let html = '';
  for (const day of days) {
    if ((day.items || []).length === 0) continue;
    html += _tlDayHtml(day, day.items, false, tripId, sharedDoc, currentUid);
  }
  return html;
}

function _tlDayHtml(day, items, isObserver, tripId, sharedDoc, currentUid) {
  const dateLabel = day.date ? fmtDate(day.date) : '';
  const validatedCount = items.filter(i => i.journalData?.validated).length;
  const hasNewInDay    = isObserver && items.some(it => _obsIsNew(it, tripId));

  let html = `
    <div class="tl-day" id="tl-day-${_esc(day.id)}">
      <div class="tl-day-hd">
        <div class="tl-day-dot${hasNewInDay ? ' tl-day-dot-new' : ''}"></div>
        <div class="tl-day-info">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span class="tl-day-num">Jour ${day.num}</span>
            ${!isObserver ? `<span style="font-size:10px;color:var(--ink4);font-weight:600">${validatedCount}/${items.length} documenté${validatedCount !== 1 ? 's' : ''}</span>` : ''}
            ${hasNewInDay ? `<span class="obs-new-badge">Nouveau</span>` : ''}
          </div>
          ${day.title ? `<div class="tl-day-title">${_esc(day.title)}</div>` : ''}
          ${dateLabel ? `<div class="tl-day-date">${dateLabel}</div>` : ''}
        </div>
      </div>
      <div class="tl-day-body">`;

  items.forEach((item, idx) => {
    html += _tlItemHtml(day, item, idx, isObserver, tripId, sharedDoc, currentUid);
  });

  html += `</div></div>`;
  return html;
}

function _tlItemHtml(day, item, itemIdx, isObserver, tripId, sharedDoc, currentUid) {
  const jd        = item.journalData || {};
  const validated = jd.validated;
  const typeIcon  = _eventTypeIcon(item.type);
  const photos    = jd.photos || [];
  const isNew     = isObserver && _obsIsNew(item, tripId);

  const metaHtml = [];
  if (jd.weather) metaHtml.push(`<span class="tl-meta-pill">${jd.weather}</span>`);
  if (jd.amount)  metaHtml.push(`<span class="tl-meta-pill">💶 ${jd.amount} €</span>`);
  if (item.time)  metaHtml.push(`<span class="tl-meta-pill">🕐 ${_esc(item.time)}</span>`);
  if (item.lat != null && item.lng != null) {
    const svUrl = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${item.lat},${item.lng}`;
    metaHtml.push(`<a class="tl-meta-pill tl-sv-pill" href="${svUrl}" target="_blank" rel="noopener" title="Ouvrir Street View">🔭 Street View</a>`);
  }

  const photosHtml = photos.length > 0 ? `
    <div class="tl-photos">
      ${photos.map(src => `<img src="${_esc(src)}" class="tl-photo" loading="lazy" onclick="window.open(this.src,'_blank')">`).join('')}
    </div>` : '';

  const notesHtml = jd.notes
    ? `<div class="tl-notes">${_esc(jd.notes).replace(/\n/g, '<br>')}</div>` : '';

  const validateBtn = !isObserver ? `
    <button data-action="validate-item" data-day-id="${_esc(day.id)}" data-item-idx="${itemIdx}"
      class="tl-validate-btn${validated ? ' validated' : ''}"
      title="${validated ? 'Modifier' : 'Documenter'}">
      ${validated ? '✓' : '+ Documenter'}
    </button>` : '';

  // Reactions & comments — only on validated items of shared trips
  let interactionsHtml = '';
  if (validated && sharedDoc) {
    const itemReactions  = sharedDoc.reactions?.[item.id] || {};
    const allComments    = sharedDoc.observerComments || {};
    const itemComments   = Object.values(allComments).filter(c => c.itemId === item.id);
    const heartCount     = Object.values(itemReactions).filter(e => e === '❤️').length;
    const commentCount   = itemComments.length;
    const myReacted      = currentUid ? itemReactions[currentUid] === '❤️' : false;

    interactionsHtml = `
      <div class="tl-interactions">
        <button class="tl-react-btn${myReacted ? ' reacted' : ''}"
                data-action="toggle-reaction" data-item-id="${_esc(item.id)}">
          ❤️${heartCount > 0 ? `<span class="tl-react-count">${heartCount}</span>` : ''}
        </button>
        <button class="tl-comment-open-btn"
                data-action="open-comments"
                data-item-id="${_esc(item.id)}"
                data-item-text="${_esc(item.text || '')}">
          💬${commentCount > 0 ? `<span class="tl-react-count">${commentCount}</span>` : ''}
        </button>
      </div>`;
  }

  return `
    <div class="tl-item${validated ? ' validated' : ''}">
      <div class="tl-item-card${validated ? ' validated' : ''}${isNew ? ' tl-item-new' : ''}">
        <div class="tl-item-hd">
          <span class="tl-item-icon">${typeIcon}</span>
          <span class="tl-item-title">${_esc(item.text || '—')}</span>
          ${item.time ? `<span class="tl-item-time">${_esc(item.time)}</span>` : ''}
          ${isNew ? `<span class="obs-new-badge">Nouveau</span>` : ''}
          ${validateBtn}
        </div>
        ${photosHtml}
        ${notesHtml}
        ${_gpxStatsHtml(item)}
        ${metaHtml.length > 0 ? `<div class="tl-meta">${metaHtml.join('')}</div>` : ''}
        ${interactionsHtml}
      </div>
    </div>`;
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
  if (e.pinType && _etMap()[e.pinType]) metaPills += `<span class="jn-meta-pill" title="${_esc(e.pinType)}">${_etMap()[e.pinType]?.emoji || ''}</span>`;
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
    if (_journalMap) return; // concurrent init guard
    const el = document.getElementById('journal-map');
    if (!el) return;

    const trip = getTrip(tripId);
    let center = [46.5, 2.5];
    let zoom   = 5;
    if (trip) {
      // Try to center on first planning item pin
      outer: for (const day of (trip.days || [])) {
        for (const item of (day.items || [])) {
          if (item.lat != null && item.lng != null) {
            center = [item.lat, item.lng]; zoom = 7; break outer;
          }
        }
        if (day.lat != null && day.lng != null) {
          center = [day.lat, day.lng]; zoom = 7; break;
        }
      }
    }

    _journalMap = L.map('journal-map', {
      center, zoom, zoomControl: true,
      minZoom:            2,
      maxBounds:          [[-85.051129, -1e10], [85.051129, 1e10]],
      maxBoundsViscosity: 1.0,
    });

    _journalMap.on('moveend', _ensureJournalWorldCopies);

    const lang = getLanguage();
    const tileUrl = lang === 'en'
      ? 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png'
      : 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png';
    L.tileLayer(tileUrl, {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 18,
    }).addTo(_journalMap);

    _journalMap.invalidateSize();
    _refreshJournalPins(tripId);
    _drawJournalRoutes(tripId);
  });
}

function _refreshJournalPins(tripId) {
  if (!_journalMap) return;
  const trip = getTrip(tripId);
  if (!trip) return;

  Object.values(_journalMarkers).forEach(m => { try { _journalMap.removeLayer(m); } catch (_) {} });
  _journalMarkers = {};
  _journalGpxLayers.forEach(l => { try { _journalMap.removeLayer(l); } catch (_) {} });
  _journalGpxLayers = [];
  _journalWorldCopyMarkers.forEach(m => { try { _journalMap.removeLayer(m); } catch (_) {} });
  _journalWorldCopyMarkers = [];
  _journalWorldCopyOffsets.clear();

  const etMap = _etMap();
  const allPinLatLngs = [];

  for (const day of (trip.days || [])) {
    (day.items || []).forEach((item, itemIdx) => {
      if (item.lat == null || item.lng == null) return;

      const jd        = item.journalData;
      const validated = jd?.validated;
      const emoji     = etMap[item.type]?.emoji || '📍';
      const bgColor   = validated ? '#16a34a' : '#0891b2';

      const icon = L.divIcon({
        className: '',
        html: `<div style="background:${bgColor};border:2px solid #fff;border-radius:50%;width:30px;height:30px;display:flex;align-items:center;justify-content:center;font-size:16px;box-shadow:0 1px 6px rgba(0,0,0,.4);cursor:pointer">${emoji}</div>`,
        iconSize:   [30, 30],
        iconAnchor: [15, 15],
        popupAnchor:[0, -18],
      });

      const marker = L.marker([item.lat, item.lng], { icon });
      marker.on('click', () => _openJournalItemPanel(tripId, day.id, itemIdx));
      marker.addTo(_journalMap);
      _journalMarkers[item.id] = marker;
      allPinLatLngs.push([item.lat, item.lng]);

      // Draw GPX trace from synced gpxPoints (available to observers too)
      if (item.gpxPoints && item.gpxPoints.length >= 2) {
        const latlngs = item.gpxPoints.map(p => [p.lat, p.lng]);
        const line = L.polyline(latlngs, { color: item.color || '#0891b2', weight: 3, opacity: 0.75 });
        line.on('click', () => _openJournalItemPanel(tripId, day.id, itemIdx));
        line.addTo(_journalMap);
        _journalGpxLayers.push(line);
        for (const ll of latlngs) allPinLatLngs.push(ll);
      }
    });
  }

  if (allPinLatLngs.length === 1) {
    _journalMap.setView(allPinLatLngs[0], 10, { animate: true });
  } else if (allPinLatLngs.length > 1) {
    _journalMap.fitBounds(allPinLatLngs, { padding: [40, 40], maxZoom: 12 });
  }

  // Seed ±1 and ±2 world-copy marker sets immediately
  _placeJournalWorldCopies(1);
  _placeJournalWorldCopies(-1);
}

function _placeJournalWorldCopies(offsetMultiple) {
  if (!_journalMap) return;
  if (_journalWorldCopyOffsets.has(offsetMultiple)) return;
  _journalWorldCopyOffsets.add(offsetMultiple);
  const lngOffset = offsetMultiple * 360;
  Object.values(_journalMarkers).forEach(m => {
    const ll   = m.getLatLng();
    const copy = L.marker([ll.lat, ll.lng + lngOffset], {
      icon: m.options.icon, interactive: false, keyboard: false,
    });
    copy.addTo(_journalMap);
    _journalWorldCopyMarkers.push(copy);
  });
}

function _ensureJournalWorldCopies() {
  if (!_journalMap) return;
  const b      = _journalMap.getBounds();
  const minOff = Math.floor(b.getWest() / 360);
  const maxOff = Math.ceil(b.getEast() / 360);
  for (let o = minOff; o <= maxOff; o++) {
    if (o !== 0) _placeJournalWorldCopies(o);
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

  if (action === 'jn-tab') {
    const tab = btn.dataset.tab;
    if (tab === _journalMobTab) return;

    // Timeline requires a full re-render; switching back from timeline also does
    if (tab === 'timeline' || _journalMobTab === 'timeline') {
      _journalView   = tab === 'timeline' ? 'timeline' : 'map';
      _journalMobTab = tab;
      renderJournal(tripId, _observerMode);
      return;
    }

    _journalMobTab = tab;
    const pnl = document.getElementById('panel-journal');
    if (!pnl) return;

    pnl.querySelectorAll('.jn-mob-tabs .bm-tab').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === tab);
    });

    const mapcal   = pnl.querySelector('.mapcal');
    const leftPanel = pnl.querySelector('.left-panel');

    if (tab === 'activite') {
      if (mapcal) mapcal.classList.add('jn-activite-mode');
      if (leftPanel) leftPanel.classList.remove('collapsed');
    } else {
      if (mapcal) mapcal.classList.remove('jn-activite-mode');
      if (leftPanel) leftPanel.classList.add('collapsed');
      setTimeout(() => { if (_journalMap) _journalMap.invalidateSize(); }, 60);
    }
    return;
  }

  if (action === 'switch-view') {
    const newView = btn.dataset.view;
    if (newView === _journalView) return;
    _journalView = newView;
    renderJournal(tripId, _observerMode);
    return;
  }

  if (action === 'validate-item') {
    _openValidateModal(tripId, btn.dataset.dayId, parseInt(btn.dataset.itemIdx, 10));
    return;
  }

  if (action === 'toggle-reaction') {
    const itemId = btn.dataset.itemId;
    if (_shareMod && itemId) {
      _shareMod.addObserverReaction(tripId, itemId).catch(() => {});
    }
    return;
  }

  if (action === 'open-comments') {
    const itemId   = btn.dataset.itemId;
    const itemText = btn.dataset.itemText;
    _openCommentsModal(tripId, itemId, itemText);
    return;
  }
}

function _openCommentsModal(tripId, itemId, itemText) {
  if (!_shareMod) return;
  const sharedDoc    = _shareMod.getSharedDocData?.(tripId);
  if (!sharedDoc) return;

  const currentUid   = getCurrentUser()?.uid;
  const allComments  = sharedDoc.observerComments || {};
  const itemComments = Object.entries(allComments)
    .filter(([, c]) => c.itemId === itemId)
    .sort(([, a], [, b]) => (a.ts || '').localeCompare(b.ts || ''));

  function _buildCommentsList() {
    if (itemComments.length === 0) {
      return `<div style="font-size:12px;color:var(--ink4);padding:8px 0;text-align:center">Aucun commentaire pour le moment</div>`;
    }
    return itemComments.map(([cid, c]) => {
      const dateLabel = new Date(c.ts).toLocaleString('fr-FR', {
        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
      });
      const canDelete = c.uid === currentUid;
      return `
        <div class="tl-comment-item">
          <div class="tl-comment-header">
            <span class="tl-comment-author">${_esc(c.name)}</span>
            <span class="tl-comment-date">${dateLabel}</span>
            ${canDelete ? `<button class="tl-comment-del" data-action="delete-comment" data-cid="${_esc(cid)}" title="Supprimer">🗑</button>` : ''}
          </div>
          <div class="tl-comment-text">${_esc(c.text)}</div>
        </div>`;
    }).join('');
  }

  showModal(`
    <button class="mc" onclick="closeModal()">✕</button>
    <h3 style="font-family:var(--sf);font-size:15px;font-weight:700;margin-bottom:4px">💬 Commentaires</h3>
    <div style="font-size:12px;color:var(--ink3);margin-bottom:12px;padding:6px 10px;background:var(--c2);border-radius:7px;border:1px solid var(--c3)">${_esc(itemText || '—')}</div>
    <div id="cmt-list" style="max-height:220px;overflow-y:auto;margin-bottom:4px">${_buildCommentsList()}</div>
    ${sharedDoc ? `
    <div style="display:flex;gap:8px;margin-top:10px">
      <input type="text" id="cmt-input" placeholder="Votre commentaire…"
             style="flex:1;padding:7px 10px;border:1.5px solid var(--c3);border-radius:7px;font-size:12px;background:var(--c);color:var(--ink)"
             maxlength="300">
      <button id="cmt-send" class="bs" style="padding:7px 14px;font-size:12px;flex-shrink:0">Envoyer</button>
    </div>` : ''}
    <div class="ma" style="margin-top:10px">
      <button class="bc" onclick="closeModal()">Fermer</button>
    </div>`);

  // Send comment
  const sendBtn = document.getElementById('cmt-send');
  const input   = document.getElementById('cmt-input');

  async function _doSend() {
    const text = input?.value?.trim();
    if (!text) return;
    input.disabled = true;
    sendBtn.disabled = true;
    await _shareMod.addObserverComment(tripId, itemId, text).catch(() => {});
    closeModal();
    // Re-open with latest data
    const latestDoc = _shareMod.getSharedDocData?.(tripId);
    if (latestDoc) _openCommentsModal(tripId, itemId, itemText);
  }

  sendBtn?.addEventListener('click', _doSend);
  // Guard: Enter key must not trigger a second send while the first is still in-flight
  input?.addEventListener('keydown', e => { if (e.key === 'Enter' && !sendBtn?.disabled) _doSend(); });

  // Delete comment
  document.getElementById('cmt-list')?.addEventListener('click', async e => {
    const delBtn = e.target.closest('[data-action="delete-comment"]');
    if (!delBtn) return;
    const cid = delBtn.dataset.cid;
    await _shareMod.deleteObserverComment(tripId, cid).catch(() => {});
    closeModal();
    const latestDoc = _shareMod.getSharedDocData?.(tripId);
    if (latestDoc) _openCommentsModal(tripId, itemId, itemText);
  });
}

// ── Journal item side panel (EDP) ─────────────────────────────────────────────

function _openJournalItemPanel(tripId, dayId, itemIdx) {
  _closeJournalItemPanel();

  const trip = getTrip(tripId);
  if (!trip) return;
  const day = (trip.days || []).find(d => d.id === dayId);
  if (!day) return;
  const item = (day.items || [])[itemIdx];
  if (!item) return;

  const jd        = item.journalData || {};
  const typeIcon  = _eventTypeIcon(item.type);
  const dayLabel  = `Jour ${day.num}${day.title ? ' · ' + day.title : ''}`;

  const photosHtml = (jd.photos || []).length > 0
    ? `<div style="display:flex;gap:5px;flex-wrap:wrap;margin:6px 0">
        ${(jd.photos || []).map(src =>
          `<img src="${_esc(src)}" onclick="window.open(this.src,'_blank')"
            style="width:72px;height:56px;object-fit:cover;border-radius:6px;cursor:pointer;border:1px solid var(--c3)">`
        ).join('')}
       </div>`
    : '';

  const mapCol = document.querySelector('#panel-journal .map-col');
  if (!mapCol) return;

  const panel = document.createElement('div');
  panel.className = 'edp';
  panel.id = 'jn-edp';
  panel.innerHTML = `
    <div class="edp-hd">
      <div class="edp-ic">${typeIcon}</div>
      <div style="min-width:0;flex:1">
        <div class="edp-title">${_esc(item.text || '—')}</div>
        <div class="edp-day">${_esc(dayLabel)}${day.date ? ' · ' + fmtDateShort(day.date) : ''}</div>
      </div>
      <button class="edp-close" id="jn-edp-close">✕</button>
    </div>
    <div class="edp-body">
      ${jd.validated ? `<div style="font-size:11px;font-weight:700;color:#16a34a;margin-bottom:8px">✓ Activité validée</div>` : ''}
      ${jd.weather   ? `<div style="font-size:22px;margin-bottom:6px">${jd.weather}</div>` : ''}
      ${jd.notes     ? `<div style="font-size:12px;color:var(--ink2);white-space:pre-wrap;margin-bottom:8px">${_esc(jd.notes)}</div>` : ''}
      ${photosHtml}
      ${jd.amount    ? `<div style="font-size:12px;color:var(--ink3);margin-top:4px">💶 ${jd.amount} €</div>` : ''}
      ${item.gpxStats ? `<div style="margin-top:10px;border-top:1px solid var(--c3);padding-top:10px">${_gpxStatsHtml(item)}</div>` : ''}
      ${!jd.validated && !jd.notes && !jd.weather && !photosHtml && !item.gpxStats
        ? `<div style="font-size:12px;color:var(--ink4)">Aucune information enregistrée.<br>Cliquez sur "Valider" pour documenter cette activité.</div>`
        : ''}
    </div>
    <div class="edp-actions">
      ${item.lat != null && item.lng != null ? `
        <a class="edp-sv-btn"
           href="https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${item.lat},${item.lng}"
           target="_blank" rel="noopener" title="Ouvrir Street View">🔭</a>` : ''}
      ${jd.validated ? `<button class="edp-save" id="jn-edp-devalidate"
        style="background:var(--c2);color:var(--ink3);border:1.5px solid var(--c3);font-size:11px">✕ Dévalider</button>` : ''}
      <button class="edp-save" id="jn-edp-validate">${jd.validated ? '✎ Modifier' : '✓ Valider'}</button>
    </div>
  `;

  mapCol.appendChild(panel);
  requestAnimationFrame(() => panel.classList.add('open'));

  panel.querySelector('#jn-edp-close').addEventListener('click', _closeJournalItemPanel);
  panel.querySelector('#jn-edp-validate').addEventListener('click', () => {
    _closeJournalItemPanel();
    _openValidateModal(tripId, dayId, itemIdx);
  });
  panel.querySelector('#jn-edp-devalidate')?.addEventListener('click', () => {
    _devalidateItem(tripId, dayId, itemIdx);
    _closeJournalItemPanel();
  });
}

function _closeJournalItemPanel() {
  const existing = document.getElementById('jn-edp');
  if (existing) {
    existing.classList.remove('open');
    setTimeout(() => { try { existing.remove(); } catch (_) {} }, 280);
  }
}

function _devalidateItem(tripId, dayId, itemIdx) {
  const freshTrip = getTrip(tripId);
  if (!freshTrip) return;
  const days   = [...(freshTrip.days || [])];
  const dayIdx = days.findIndex(d => d.id === dayId);
  if (dayIdx === -1) return;
  const items = [...(days[dayIdx].items || [])];
  if (!items[itemIdx]) return;

  const itemId = items[itemIdx].id;
  const prevJd = items[itemIdx].journalData || {};

  // Strip validated state, preserve notes/photos/weather for reference
  items[itemIdx] = {
    ...items[itemIdx],
    journalData: { ...prevJd, validated: false, validatedAt: null },
  };
  days[dayIdx] = { ...days[dayIdx], items };
  updateTrip(tripId, { days });

  // Remove the auto-created real expense that was linked to this item
  const freshTrip2 = getTrip(tripId);
  const expenses   = (freshTrip2.realExpenses || []).filter(ex => ex.journalItemId !== itemId);
  if (expenses.length !== (freshTrip2.realExpenses || []).length) {
    updateTrip(tripId, { realExpenses: expenses });
    updateTopStats(tripId);
  }

  notify('Activité dévalidée', '↩');
  renderJournal(tripId, _observerMode);
}

// ── Activities sub-tab ────────────────────────────────────────────────────────

function _eventTypeIcon(type) {
  const et = getEventTypes().find(e => e.key === type);
  if (et) return et.emoji;
  // Fallback built-in map
  const m = { visit: '🏛️', activity: '🎯', sleep: '🏨', drive: '🚗', food: '🍽️', shop: '🛍️' };
  return m[type] || '📍';
}

function _buildActivitiesHtml(trip) {
  const days = trip.days || [];
  const hasAny = days.some(d => (d.items || []).length > 0);

  if (!hasAny) {
    return `
      <div class="jn-empty" style="text-align:center;padding:32px 12px;color:var(--ink4)">
        <div style="font-size:36px;margin-bottom:8px">📅</div>
        <p style="font-size:13px;font-weight:600;color:var(--ink3)">Aucune activité dans le planning</p>
        <p style="font-size:11px;margin-top:6px;color:var(--ink4)">Ajoutez des activités dans Carte &amp; Planning</p>
      </div>`;
  }

  let html = '';
  for (const day of days) {
    const items = day.items || [];
    if (items.length === 0) continue;

    const dayLabel = `Jour ${day.num}${day.title ? ' · ' + day.title : ''}`;
    html += `<div class="jn-day-group">
      <div class="jn-day-label">${_esc(dayLabel)}${day.date ? `<span style="font-weight:400;font-size:10px;color:var(--ink4);margin-left:5px">${fmtDateShort(day.date)}</span>` : ''}</div>`;

    items.forEach((item, idx) => {
      const jd        = item.journalData;
      const validated = jd?.validated;
      const typeIcon  = _eventTypeIcon(item.type);
      const metaParts = [
        item.time ? `🕐 ${item.time}` : '',
        item.cost ? `💶 ${item.cost}€` : '',
      ].filter(Boolean);

      html += `
        <div style="display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:8px;margin-bottom:4px;
          background:${validated ? 'var(--tl)' : 'var(--c2)'};border:1px solid ${validated ? 'var(--teal)' : 'var(--c3)'}">
          <div style="font-size:16px;flex-shrink:0">${typeIcon}</div>
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;color:var(--ink);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(item.text || '—')}</div>
            ${metaParts.length ? `<div style="font-size:10px;color:var(--ink4);margin-top:1px">${_esc(metaParts.join(' · '))}</div>` : ''}
            ${item.gpxStats ? `<div style="font-size:10px;color:#0284c7;margin-top:2px">📏 ${item.gpxStats.distanceM >= 1000 ? (item.gpxStats.distanceM/1000).toFixed(1)+' km' : item.gpxStats.distanceM+' m'}${item.gpxStats.elevGain ? ' · ↑'+item.gpxStats.elevGain+'m' : ''}</div>` : ''}
            ${validated ? `<div style="font-size:10px;color:var(--td);margin-top:2px;display:flex;gap:4px;flex-wrap:wrap;align-items:center">
              <span style="font-weight:700">✓ Validé</span>
              ${jd.weather ? `<span>${jd.weather}</span>` : ''}
              ${jd.amount  ? `<span>+${jd.amount}€</span>` : ''}
              ${(jd.photos || []).length > 0 ? `<span>📷 ${jd.photos.length}</span>` : ''}
            </div>` : ''}
          </div>
          <button data-action="validate-item" data-day-id="${_esc(day.id)}" data-item-idx="${idx}"
            style="flex-shrink:0;font-size:10px;font-weight:700;padding:4px 7px;border-radius:6px;cursor:pointer;white-space:nowrap;
            background:${validated ? 'var(--teal)' : 'var(--c)'};color:${validated ? '#fff' : 'var(--ink3)'};border:1.5px solid ${validated ? 'var(--teal)' : 'var(--c3)'}">
            ${validated ? '✓ Éditer' : '✓ Valider'}
          </button>
        </div>`;
    });

    html += `</div>`;
  }
  return html;
}

// ── Validate activity modal ────────────────────────────────────────────────────

function _openValidateModal(tripId, dayId, itemIdx) {
  const trip = getTrip(tripId);
  if (!trip) return;

  const day = (trip.days || []).find(d => d.id === dayId);
  if (!day) return;

  const item = (day.items || [])[itemIdx];
  if (!item) return;

  const jd = item.journalData || {};

  const state = {
    weather: jd.weather || '',
    notes:   jd.notes   || '',
    amount:  jd.amount  || 0,
    photos:  jd.photos  ? [...jd.photos] : [],
  };

  const weatherEmojis = ['☀️', '⛅', '🌧️', '⛈️', '🌨️', '🌫️', '🌊', '🏔️'];

  async function _compressImg(file) {
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = ev => {
        const img = new Image();
        img.onload = () => {
          const maxSize = 800;
          const canvas  = document.createElement('canvas');
          let { width, height } = img;
          if (width > maxSize || height > maxSize) {
            const r = Math.min(maxSize / width, maxSize / height);
            width = Math.round(width * r); height = Math.round(height * r);
          }
          canvas.width = width; canvas.height = height;
          canvas.getContext('2d').drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', 0.8));
        };
        img.src = ev.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function buildWeatherRow() {
    return weatherEmojis.map(em => {
      const sel = state.weather === em;
      return `<button type="button" data-weather="${_esc(em)}"
        style="background:${sel ? 'var(--tl)' : 'var(--c2)'};border:1.5px solid ${sel ? 'var(--teal)' : 'var(--c3)'};
        border-radius:8px;padding:4px 6px;font-size:18px;cursor:pointer">${em}</button>`;
    }).join('');
  }

  function buildPhotosHtml() {
    if (state.photos.length === 0) return '<div style="font-size:11px;color:var(--ink4)">Aucune photo ajoutée</div>';
    return `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px">` +
      state.photos.map((src, i) =>
        `<div style="position:relative;display:inline-block">
          <img src="${_esc(src)}" style="width:56px;height:56px;object-fit:cover;border-radius:6px;border:1px solid var(--c3);cursor:pointer" onclick="window.open(this.src,'_blank')">
          <button type="button" data-rm-photo="${i}"
            style="position:absolute;top:-4px;right:-4px;background:var(--coral);color:#fff;border:none;border-radius:50%;width:16px;height:16px;font-size:9px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;line-height:1">✕</button>
        </div>`
      ).join('') + `</div>`;
  }

  showModal(`
    <button class="mc" onclick="closeModal()">✕</button>
    <h3>✓ Valider l'activité</h3>
    <div style="font-size:13px;font-weight:600;color:var(--ink);margin-bottom:14px;padding:8px 10px;background:var(--c2);border-radius:8px;border:1px solid var(--c3)">
      ${_eventTypeIcon(item.type)} ${_esc(item.text || '—')}
    </div>

    <div class="fg">
      <label>Météo</label>
      <div style="display:flex;gap:5px;flex-wrap:wrap" id="vld-weather-row">${buildWeatherRow()}</div>
    </div>

    <div class="fg">
      <label>Notes</label>
      <textarea id="vld-notes" rows="3" placeholder="Comment s'est passée cette activité…">${_esc(state.notes)}</textarea>
    </div>

    <div class="fg">
      <label>Montant réel (€) <span style="font-size:10px;color:var(--ink4);font-weight:400">— crée une dépense réelle</span></label>
      <input type="number" id="vld-amount" min="0" step="0.01" placeholder="0" value="${state.amount || ''}">
    </div>

    <div class="fg">
      <label>Photos</label>
      <div id="vld-photos-list">${buildPhotosHtml()}</div>
      <input type="file" id="vld-photo-file" accept="image/*" style="font-size:12px;color:var(--ink3);margin-top:6px">
    </div>

    <div class="ma">
      ${jd.validated ? `<button class="bc" id="vld-devalidate" style="color:var(--coral);border-color:var(--coral)">✕ Dévalider</button>` : ''}
      <button class="bc" onclick="closeModal()">Annuler</button>
      <button class="bs" id="vld-save">Enregistrer</button>
    </div>`);

  // Dévalider
  document.getElementById('vld-devalidate')?.addEventListener('click', () => {
    closeModal();
    _devalidateItem(tripId, dayId, itemIdx);
  });

  // Weather picker
  document.getElementById('vld-weather-row')?.addEventListener('click', ev => {
    const btn = ev.target.closest('[data-weather]');
    if (!btn) return;
    const em = btn.dataset.weather;
    state.weather = state.weather === em ? '' : em;
    const row = document.getElementById('vld-weather-row');
    if (row) row.innerHTML = buildWeatherRow();
  });

  // Photo remove (delegation — survives innerHTML updates)
  document.getElementById('vld-photos-list')?.addEventListener('click', ev => {
    const btn = ev.target.closest('[data-rm-photo]');
    if (!btn) return;
    state.photos.splice(parseInt(btn.dataset.rmPhoto, 10), 1);
    const list = document.getElementById('vld-photos-list');
    if (list) list.innerHTML = buildPhotosHtml();
  });

  // Photo upload
  document.getElementById('vld-photo-file')?.addEventListener('change', async ev => {
    const file = ev.target.files?.[0];
    if (!file) return;
    const base64 = await _compressImg(file);
    state.photos.push(base64);
    const list = document.getElementById('vld-photos-list');
    if (list) list.innerHTML = buildPhotosHtml();
    ev.target.value = '';
  });

  // Save
  document.getElementById('vld-save')?.addEventListener('click', () => {
    state.notes  = document.getElementById('vld-notes')?.value?.trim()  || '';
    state.amount = parseFloat(document.getElementById('vld-amount')?.value || '0') || 0;

    const freshTrip = getTrip(tripId);
    // Guard: trip may have been deleted while the modal was open
    if (!freshTrip) { closeModal(); return; }
    const days      = [...(freshTrip.days || [])];
    const dayIdx    = days.findIndex(d => d.id === dayId);
    if (dayIdx === -1) { closeModal(); return; }

    const items = [...(days[dayIdx].items || [])];
    if (!items[itemIdx]) { closeModal(); return; }

    const itemId = items[itemIdx].id;
    const prevJd = items[itemIdx].journalData || {};
    items[itemIdx] = {
      ...items[itemIdx],
      journalData: {
        validated:   true,
        validatedAt: prevJd.validatedAt || new Date().toISOString(),
        weather:     state.weather,
        notes:       state.notes,
        amount:      state.amount,
        photos:      state.photos,
      },
    };
    days[dayIdx] = { ...days[dayIdx], items };
    updateTrip(tripId, { days });

    if (state.amount > 0) {
      const freshTrip2 = getTrip(tripId);
      const expenses   = [...(freshTrip2.realExpenses || [])];
      const cats       = freshTrip2.budgetCats || [];
      const actCat     = cats.find(c => c.name === 'Activités');
      const existIdx   = expenses.findIndex(ex => ex.journalItemId === itemId);

      const newExp = {
        id:            existIdx >= 0 ? expenses[existIdx].id : 'ex_' + uid(),
        desc:          items[itemIdx].text || 'Activité validée',
        amount:        state.amount,
        catId:         actCat?.id || null,
        paidById:      'moi',
        sharedWith:    ['moi'],
        date:          days[dayIdx].date || new Date().toISOString().slice(0, 10),
        dayId,
        note:          state.notes ? 'Via Journal · ' + state.notes : 'Via Journal',
        journalItemId: itemId,
      };

      if (existIdx >= 0) expenses[existIdx] = newExp;
      else expenses.push(newExp);

      updateTrip(tripId, { realExpenses: expenses });
      updateTopStats(tripId);
      notify('Activité validée · dépense créée', '✓');
    } else {
      notify('Activité validée', '✓');
    }

    // Notify observers if this is a shared trip
    if (isTripShared(tripId)) {
      const day = days[dayIdx];
      import('../share.js').then(({ publishDay }) => {
        publishDay(tripId, day.num, day.title || '');
      }).catch(() => {});
    }

    closeModal();
    renderJournal(tripId);
  });
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
      ...getEventTypes().map(pt => ({ val: pt.key, emoji: pt.emoji, label: pt.label })),
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
        <div id="tag-suggestions" style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:6px">
          ${_getTagSuggestions(trip, state.dayId).filter(s => !state.tags.includes(s)).map(s =>
            `<button type="button" class="tag-suggest-btn" data-tag="${_esc(s)}"
              style="background:var(--c2);border:1px dashed var(--c4);border-radius:999px;padding:2px 9px;
                     font-size:11px;color:var(--ink3);cursor:pointer;font-family:var(--fn)">+ ${_esc(s)}</button>`
          ).join('')}
        </div>
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

  function reRenderTagSuggestions() {
    const el = document.getElementById('tag-suggestions');
    if (!el) return;
    const available = _getTagSuggestions(trip, state.dayId).filter(s => !state.tags.includes(s));
    el.innerHTML = available.map(s =>
      `<button type="button" class="tag-suggest-btn" data-tag="${_esc(s)}"
        style="background:var(--c2);border:1px dashed var(--c4);border-radius:999px;padding:2px 9px;
               font-size:11px;color:var(--ink3);cursor:pointer;font-family:var(--fn)">+ ${_esc(s)}</button>`
    ).join('');
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
    reRenderTagSuggestions();
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
      reRenderTagSuggestions();
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
        const res  = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=5&lang=fr`);
        const gj   = await res.json();
        state._locResults = (gj.features || []).map(f => {
          const [lng, lat] = f.geometry.coordinates;
          const p = f.properties;
          const parts = [p.name, p.street, p.city, p.state, p.country].filter(Boolean);
          return { lat: String(lat), lon: String(lng), display_name: parts.join(', ') };
        });
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

    // Tag suggestions
    document.getElementById('tag-suggestions')?.addEventListener('click', ev => {
      const btn = ev.target.closest('.tag-suggest-btn');
      if (!btn) return;
      const tag = btn.dataset.tag;
      if (tag && !state.tags.includes(tag)) {
        state.tags.push(tag);
        reRenderTagsList();
        reRenderTagSuggestions();
      }
    });

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
