/* ============================================================
   CARNET DE VOYAGES — Utilities
   Shared helpers used across all modules:
   - HTML escaping (esc)
   - Toast notifications
   - Modal management
   - Date helpers & generateDays
   - Event type lookups (tCol, tIc, trIc, trNm, trCol)
   - Date picker widget (dpInit, dpClick, renderDp …)
   - Type badge & color swatches HTML
   ============================================================ */

import { TRIP_TYPES, COMP_COLORS, getEventTypes } from './store.js';

// ── Constants ──────────────────────────────────────────────────────────────────

export const MNS = [
  'Janvier','Février','Mars','Avril','Mai','Juin',
  'Juillet','Août','Septembre','Octobre','Novembre','Décembre'
];
export const DOW = ['L','M','M','J','V','S','D'];

/** 10-colour palette cycled over days to give each day a distinct pin colour. */
const DAY_COLORS = [
  '#0d9488','#7c3aed','#d97706','#16a34a',
  '#db2777','#0284c7','#e85d3e','#f59e0b',
  '#06b6d4','#8b5cf6'
];

// ── HTML escaping ──────────────────────────────────────────────────────────────

/**
 * Escape HTML special characters.
 * Use whenever inserting user-supplied text into innerHTML to prevent XSS.
 * Every module should import this instead of maintaining its own copy.
 */
export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Notification toast ──────────────────────────────────────────────────────────

let _notifTimer = null;

/**
 * Show the global toast notification for 3 seconds.
 * Safe to call multiple times — previous timer is cancelled.
 */
export function notify(msg, icon = '✓') {
  const el = document.getElementById('notif');
  if (!el) return;
  document.getElementById('n-ic').textContent  = icon;
  document.getElementById('n-msg').textContent = msg;
  el.classList.add('show');
  clearTimeout(_notifTimer);
  _notifTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

// ── Modal ──────────────────────────────────────────────────────────────────────

/** Callback invoked when the currently-open modal is closed (optional). */
let _modalCloseCallback = null;

/**
 * Show the shared modal overlay.
 * @param {string} htmlContent - full HTML injected into .mbox
 * @param {object} [opts]
 * @param {Function} [opts.onClose] - called when the modal is closed
 */
export function showModal(htmlContent, { onClose } = {}) {
  _modalCloseCallback    = onClose || null;
  window._closeModalOnBg = true;

  const ov = document.getElementById('modal-overlay');
  if (!ov) return;

  // Lazily create the inner box so the overlay HTML can be minimal
  let box = ov.querySelector('.mbox');
  if (!box) {
    box = document.createElement('div');
    box.className = 'mbox';
    ov.appendChild(box);
  }
  box.innerHTML = htmlContent;
  ov.classList.add('open');

  // Clicks inside the box must not bubble up to the overlay's close handler
  box.onclick = e => e.stopPropagation();
}

/** Close the modal and invoke the optional onClose callback. */
export function closeModal() {
  const ov = document.getElementById('modal-overlay');
  if (ov) ov.classList.remove('open');
  if (_modalCloseCallback) {
    _modalCloseCallback();
    _modalCloseCallback = null;
  }
}

// Expose for onclick="" HTML attributes and for app.js
window.closeModal = closeModal;

// ── Date helpers ───────────────────────────────────────────────────────────────

/**
 * Parse 'YYYY-MM-DD' → Date at local noon.
 * Using T12:00:00 (not T00:00:00) avoids the date shifting by one day when the
 * local UTC offset causes midnight to fall in the previous UTC day.
 */
export function isoToDate(isoStr) {
  if (!isoStr) return null;
  return new Date(isoStr + 'T12:00:00');
}

/** Date → 'YYYY-MM-DD' string, or null if d is falsy. */
export function dateToIso(d) {
  if (!d) return null;
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, '0');
  const dy = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dy}`;
}

/** 'YYYY-MM-DD' → 'DD MMM YYYY', or '—' for missing values. */
export function fmtDate(isoStr) {
  if (!isoStr) return '—';
  const d = isoToDate(isoStr);
  return `${d.getDate()} ${MNS[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`;
}

/** 'YYYY-MM-DD' → 'DD MMM', or '—' for missing values. */
export function fmtDateShort(isoStr) {
  if (!isoStr) return '—';
  const d = isoToDate(isoStr);
  return `${d.getDate()} ${MNS[d.getMonth()].slice(0, 3)}`;
}

// ── Generate trip days from date range ────────────────────────────────────────

/**
 * Build a fresh array of day scaffolds from trip.startDate to trip.endDate.
 * Only called when a trip has no stored days yet (new trip or date-range change).
 * Each scaffold: { id, num, date, title, region, lat, lng, color, photo, items }
 * Returns [] if dates are missing or invalid.
 */
export function generateDays(trip) {
  if (!trip.startDate || !trip.endDate) return [];
  const start = isoToDate(trip.startDate);
  const end   = isoToDate(trip.endDate);
  if (!start || !end || start > end) return [];

  const days = [];
  const cur  = new Date(start);
  let n = 1;
  while (cur <= end) {
    days.push({
      id:     'd_' + Math.random().toString(36).slice(2, 9),
      num:    n,
      date:   dateToIso(cur),
      title:  `Jour ${n}`,
      region: trip.destination || '',
      lat:    null,
      lng:    null,
      color:  DAY_COLORS[(n - 1) % DAY_COLORS.length],
      photo:  '',
      items:  [],
    });
    cur.setDate(cur.getDate() + 1);
    n++;
  }
  return days;
}

// ── Event type helpers ─────────────────────────────────────────────────────────
// These look up colour/icon for a given event or transport type.
// The fallback maps mirror DEFAULT_EVENT_TYPES in store.js for offline safety.

/** Return the colour for an event, checking custom settings first. */
export function tCol(t, item) {
  if (item?.color) return item.color;
  const found = getEventTypes().find(et => et.key === t);
  if (found) return found.color;
  return { drive: '#0284c7', visit: '#16a34a', activity: '#d97706', sleep: '#7c3aed' }[t] || '#888';
}

/** Return the emoji icon for an event, checking custom settings first. */
export function tIc(t, item) {
  if (item?.emoji) return item.emoji;
  const found = getEventTypes().find(et => et.key === t);
  if (found) return found.emoji;
  return { drive: '🚐', visit: '📍', activity: '⚡', sleep: '🌙' }[t] || '•';
}

/** Emoji icon for a transport mode key. */
export function trIc(m) {
  return { car: '🚗', ferry: '⛴', plane: '✈', bus: '🚌', foot: '🚶', bike: '🚲', train: '🚆' }[m] || '🚐';
}

/** French label for a transport mode key. */
export function trNm(m) {
  return { car: 'Voiture', ferry: 'Ferry', plane: 'Avion', bus: 'Bus', foot: 'À pied', bike: 'Vélo', train: 'Train' }[m] || 'Véhicule';
}

/** Brand colour for a transport mode key. */
export function trCol(m) {
  return { car: '#0284c7', ferry: '#0d9488', plane: '#7c3aed', bus: '#d97706', foot: '#16a34a', bike: '#e85d3e', train: '#92400e' }[m] || '#0284c7';
}

/**
 * Extract the two-letter country code from a flag emoji, plain ISO text, or globe.
 * Examples: '🇫🇷' → 'FR',  'fr' → 'FR',  '🌍' → '🌍' (returned as-is).
 */
export function fmtFlag(flag) {
  if (!flag) return '';
  const trimmed = flag.trim();
  // Regional indicator symbols (flag emoji) sit in U+1F1E6–U+1F1FF
  const pts = [...trimmed].map(c => c.codePointAt(0)).filter(v => v >= 0x1F1E6 && v <= 0x1F1FF);
  if (pts.length >= 2)
    return String.fromCharCode(pts[0] - 0x1F1E6 + 65) + String.fromCharCode(pts[1] - 0x1F1E6 + 65);
  if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();
  return trimmed;
}

// ── Date picker ────────────────────────────────────────────────────────────────
// Single-instance calendar widget.  dpInit() attaches it to a container element;
// dpGetDates() returns the selected start/end ISO strings.

const MNS_SHORT = ['Jan','Fév','Mar','Avr','Mai','Jun','Jul','Aoû','Sep','Oct','Nov','Déc'];

/**
 * Internal picker state.  Only one active picker at a time is supported —
 * if two modals with date pickers are opened simultaneously they would share
 * this state (unlikely in practice since modals are sequential).
 */
let dpState = {
  id:       '',
  year:     new Date().getFullYear(),
  month:    new Date().getMonth(),
  start:    null,   // Date | null — selected range start
  end:      null,   // Date | null — selected range end
  picking:  'start', // which endpoint the next click will set
  view:     'cal',  // 'cal' | 'year' | 'month'
  yearBase: new Date().getFullYear() - 11,
};

/** Initialise the picker inside `containerId` with an optional pre-selected range. */
export function dpInit(containerId, startIso, endIso) {
  dpState.id      = containerId;
  dpState.start   = isoToDate(startIso);
  dpState.end     = isoToDate(endIso);
  // If a start date already exists, expect the user to pick the end next
  dpState.picking = dpState.start ? 'end' : 'start';
  dpState.view    = 'cal';

  const anchor = dpState.start || new Date();
  dpState.year     = anchor.getFullYear();
  dpState.month    = anchor.getMonth();
  dpState.yearBase = dpState.year - 11;

  renderDp(containerId);
}

/** Navigate forward/back one month (or one page of years in year-grid view). */
export function dpNav(dir, id) {
  if (dpState.view === 'year') {
    dpState.yearBase += dir * 16;
    renderDp(id);
    return;
  }
  dpState.month += dir;
  if (dpState.month > 11) { dpState.month = 0;  dpState.year++; }
  if (dpState.month < 0)  { dpState.month = 11; dpState.year--; }
  renderDp(id);
}

/** Toggle between calendar view and year-grid view. */
export function dpToggleView(id) {
  dpState.view = dpState.view === 'cal' ? 'year' : 'cal';
  renderDp(id);
}

/** User picked a year — switch to month-grid view. */
export function dpPickYear(y, id) {
  dpState.year = y;
  dpState.view = 'month';
  renderDp(id);
}

/** User picked a month — switch back to calendar view. */
export function dpPickMonth(m, id) {
  dpState.month = m;
  dpState.view  = 'cal';
  renderDp(id);
}

/**
 * Handle a day cell click.
 * First click always starts a new range.  Second click completes it,
 * swapping start/end if the user clicked an earlier date.
 */
export function dpClick(y, m, d, id) {
  const clicked = new Date(y, m, d, 12, 0, 0);

  if (dpState.picking === 'start' || (dpState.start && dpState.end)) {
    // Start a brand-new selection
    dpState.start   = clicked;
    dpState.end     = null;
    dpState.picking = 'end';
  } else {
    // Second click: finalise the range
    if (clicked < dpState.start) {
      // User clicked earlier than start — swap so range is always start ≤ end
      dpState.end   = dpState.start;
      dpState.start = clicked;
    } else {
      dpState.end = clicked;
    }
    dpState.picking = 'start';
  }
  renderDp(id);
}

/**
 * Return the currently selected date range as ISO strings.
 * Returns a snapshot — safe to read after the picker has been destroyed.
 */
export function dpGetDates() {
  return {
    start: dateToIso(dpState.start),
    end:   dateToIso(dpState.end),
  };
}

/** Re-render the picker into its container. Called after every state change. */
export function renderDp(id) {
  const container = document.getElementById(id);
  if (!container) return;

  const { year, month, start, end, view, yearBase } = dpState;

  // ── Year-grid view ──────────────────────────────────────────────────────────
  if (view === 'year') {
    let cells = '';
    for (let y = yearBase; y < yearBase + 16; y++) {
      const cur = y === year;
      cells += `<button class="dp-pick-cell${cur ? ' dp-pick-cur' : ''}" onclick="dpPickYear(${y},'${id}')">${y}</button>`;
    }
    container.innerHTML = `
      <div class="dp-wrap">
        <div class="dp-nav">
          <button class="dp-nav-btn" onclick="dpNav(-1,'${id}')">‹</button>
          <button class="dp-nav-lbl dp-nav-lbl-btn" onclick="dpToggleView('${id}')">${yearBase} – ${yearBase + 15}</button>
          <button class="dp-nav-btn" onclick="dpNav(1,'${id}')">›</button>
        </div>
        <div class="dp-pick-grid">${cells}</div>
      </div>
    `;
    return;
  }

  // ── Month-grid view ─────────────────────────────────────────────────────────
  if (view === 'month') {
    let cells = '';
    for (let m = 0; m < 12; m++) {
      const cur = m === month;
      cells += `<button class="dp-pick-cell${cur ? ' dp-pick-cur' : ''}" onclick="dpPickMonth(${m},'${id}')">${MNS_SHORT[m]}</button>`;
    }
    container.innerHTML = `
      <div class="dp-wrap">
        <div class="dp-nav">
          <button class="dp-nav-btn" style="visibility:hidden">‹</button>
          <button class="dp-nav-lbl dp-nav-lbl-btn" onclick="dpToggleView('${id}')">${year}</button>
          <button class="dp-nav-btn" style="visibility:hidden">›</button>
        </div>
        <div class="dp-pick-grid dp-pick-grid-3">${cells}</div>
      </div>
    `;
    return;
  }

  // ── Calendar view (default) ─────────────────────────────────────────────────
  const today    = new Date();
  const firstDay = new Date(year, month, 1);
  const daysInMo = new Date(year, month + 1, 0).getDate();

  // getDay() → 0 = Sunday … 6 = Saturday.
  // We want Monday = column 0, so: (0+6)%7 = 6 (Sun→last col), (1+6)%7 = 0 (Mon→first col).
  const offset = (firstDay.getDay() + 6) % 7;

  const dowHtml = DOW.map(d => `<div class="dp-dow">${d}</div>`).join('');

  let cells = '';
  // Empty cells before the first day of the month
  for (let i = 0; i < offset; i++) cells += '<div class="dp-cell dp-empty"></div>';

  for (let d = 1; d <= daysInMo; d++) {
    const date    = new Date(year, month, d, 12, 0, 0);
    const isStart = start && _sameDay(date, start);
    const isEnd   = end   && _sameDay(date, end);
    const isTd    = _sameDay(date, today);
    const inRange = start && end && date > start && date < end;

    let cls = 'dp-cell';
    if (isStart) cls += ' dp-range-start';
    if (isEnd)   cls += ' dp-range-end';
    if (inRange) cls += ' dp-in-range';
    if (isTd)    cls += ' dp-today';

    cells += `<div class="${cls}" onclick="dpClick(${year},${month},${d},'${id}')">${d}</div>`;
  }

  let rangeLabel = '';
  if (start || end) {
    const s = start ? fmtDate(dateToIso(start)) : '?';
    const e = end   ? fmtDate(dateToIso(end))   : '?';
    rangeLabel = `<div class="dp-label">${s} → ${e}</div>`;
  }

  container.innerHTML = `
    <div class="dp-wrap">
      <div class="dp-nav">
        <button class="dp-nav-btn" onclick="dpNav(-1,'${id}')">‹</button>
        <button class="dp-nav-lbl dp-nav-lbl-btn" onclick="dpToggleView('${id}')">${MNS[month]} ${year}</button>
        <button class="dp-nav-btn" onclick="dpNav(1,'${id}')">›</button>
      </div>
      ${rangeLabel}
      <div class="dp-grid">
        ${dowHtml}
        ${cells}
      </div>
    </div>
  `;
}

/** True when two Date objects fall on the same calendar day. */
function _sameDay(a, b) {
  return a.getFullYear() === b.getFullYear()
      && a.getMonth()    === b.getMonth()
      && a.getDate()     === b.getDate();
}

// Expose dp functions for onclick="" attributes in generated HTML
window.dpNav        = dpNav;
window.dpClick      = dpClick;
window.dpToggleView = dpToggleView;
window.dpPickYear   = dpPickYear;
window.dpPickMonth  = dpPickMonth;

// ── Type badge HTML ────────────────────────────────────────────────────────────

/** Return an inline badge `<span>` for a trip type ('voyage', 'weekend', 'sortie'). */
export function typeBadge(type) {
  const t = TRIP_TYPES[type] || TRIP_TYPES.voyage;
  let cls = 'badge-type';
  if (type === 'voyage')  cls += ' badge-voyage';
  if (type === 'weekend') cls += ' badge-weekend';
  if (type === 'sortie')  cls += ' badge-sortie';
  return `<span class="${cls}">${t.icon} ${t.label}</span>`;
}

// ── Colour-swatch options HTML ─────────────────────────────────────────────────

/**
 * Render a row of colour-swatch `<div>`s.
 * @param {string} selectedColor - currently active hex colour
 * @param {string} onclickFn     - name of a global JS function called with (hexColor)
 */
export function colorOptsHtml(selectedColor, onclickFn) {
  const cols = [
    '#0d9488','#7c3aed','#e85d3e','#d97706',
    '#db2777','#0284c7','#16a34a','#f59e0b'
  ];
  return `<div class="col-opts">
    ${cols.map(c =>
      `<div class="col-o${c === selectedColor ? ' sel' : ''}"
           style="background:${c}"
           onclick="${onclickFn}('${c}')"></div>`
    ).join('')}
  </div>`;
}
