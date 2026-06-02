/* ============================================================
   CARNET DE VOYAGES — Utilities
   ============================================================ */

import { TRIP_TYPES, COMP_COLORS, getEventTypes } from './store.js';

// ── Constants ──────────────────────────────────────────────────────────────────
export const MNS = [
  'Janvier','Février','Mars','Avril','Mai','Juin',
  'Juillet','Août','Septembre','Octobre','Novembre','Décembre'
];
export const DOW = ['L','M','M','J','V','S','D'];

const DAY_COLORS = [
  '#0d9488','#7c3aed','#d97706','#16a34a',
  '#db2777','#0284c7','#e85d3e','#f59e0b',
  '#06b6d4','#8b5cf6'
];

// ── Notification toast ──────────────────────────────────────────────────────────
let _notifTimer = null;

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
let _modalCloseCallback = null;

/**
 * Show the shared modal overlay.
 * @param {string} htmlContent - full HTML injected into .mbox
 * @param {object} [opts]
 * @param {Function} [opts.onClose]
 */
export function showModal(htmlContent, { onClose } = {}) {
  _modalCloseCallback    = onClose || null;
  window._closeModalOnBg = true;

  const ov = document.getElementById('modal-overlay');
  if (!ov) return;

  // Ensure .mbox exists inside overlay
  let box = ov.querySelector('.mbox');
  if (!box) {
    box = document.createElement('div');
    box.className = 'mbox';
    ov.appendChild(box);
  }
  box.innerHTML = htmlContent;
  ov.classList.add('open');

  // Prevent overlay close when clicking inside the box
  box.onclick = e => e.stopPropagation();
}

export function closeModal() {
  const ov = document.getElementById('modal-overlay');
  if (ov) ov.classList.remove('open');
  if (_modalCloseCallback) {
    _modalCloseCallback();
    _modalCloseCallback = null;
  }
}

// Expose for onclick="" in HTML and in app.js
window.closeModal = closeModal;

// ── Date helpers ───────────────────────────────────────────────────────────────

/** Parse 'YYYY-MM-DD' → Date at noon (avoids timezone daylight-saving shifts) */
export function isoToDate(isoStr) {
  if (!isoStr) return null;
  return new Date(isoStr + 'T12:00:00');
}

/** Date → 'YYYY-MM-DD' */
export function dateToIso(d) {
  if (!d) return null;
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, '0');
  const dy = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dy}`;
}

/** 'YYYY-MM-DD' → 'DD MMM YYYY' | null → '—' */
export function fmtDate(isoStr) {
  if (!isoStr) return '—';
  const d = isoToDate(isoStr);
  return `${d.getDate()} ${MNS[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`;
}

/** 'YYYY-MM-DD' → 'DD MMM' | null → '—' */
export function fmtDateShort(isoStr) {
  if (!isoStr) return '—';
  const d = isoToDate(isoStr);
  return `${d.getDate()} ${MNS[d.getMonth()].slice(0, 3)}`;
}

// ── Generate trip days from date range ────────────────────────────────────────

/**
 * Returns an array of day objects from trip.startDate to trip.endDate.
 * Returns [] if no dates set.
 * Each day: { id, num, date:'YYYY-MM-DD', title, region, lat, lng, color, photo, items }
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

export function tCol(t, item) {
  if (item?.color) return item.color;
  const found = getEventTypes().find(et => et.key === t);
  if (found) return found.color;
  return { drive: '#0284c7', visit: '#16a34a', activity: '#d97706', sleep: '#7c3aed' }[t] || '#888';
}
export function tIc(t, item) {
  if (item?.emoji) return item.emoji;
  const found = getEventTypes().find(et => et.key === t);
  if (found) return found.emoji;
  return { drive: '🚐', visit: '📍', activity: '⚡', sleep: '🌙' }[t] || '•';
}
export function trIc(m) {
  return { car: '🚗', ferry: '⛴', plane: '✈', bus: '🚌', foot: '🚶', bike: '🚲', train: '🚆' }[m] || '🚐';
}
export function trNm(m) {
  return { car: 'Voiture', ferry: 'Ferry', plane: 'Avion', bus: 'Bus', foot: 'À pied', bike: 'Vélo', train: 'Train' }[m] || 'Véhicule';
}
export function trCol(m) {
  return { car: '#0284c7', ferry: '#0d9488', plane: '#7c3aed', bus: '#d97706', foot: '#16a34a', bike: '#e85d3e', train: '#92400e' }[m] || '#0284c7';
}

// ── Date picker ────────────────────────────────────────────────────────────────

let dpState = {
  id:      '',
  year:    new Date().getFullYear(),
  month:   new Date().getMonth(),
  start:   null,   // Date | null
  end:     null,   // Date | null
  picking: 'start' // 'start' | 'end'
};

export function dpInit(containerId, startIso, endIso) {
  dpState.id      = containerId;
  dpState.start   = isoToDate(startIso);
  dpState.end     = isoToDate(endIso);
  dpState.picking = dpState.start ? 'end' : 'start';

  const anchor = dpState.start || new Date();
  dpState.year  = anchor.getFullYear();
  dpState.month = anchor.getMonth();

  renderDp(containerId);
}

export function dpNav(dir, id) {
  dpState.month += dir;
  if (dpState.month > 11) { dpState.month = 0;  dpState.year++; }
  if (dpState.month < 0)  { dpState.month = 11; dpState.year--; }
  renderDp(id);
}

export function dpClick(y, m, d, id) {
  const clicked = new Date(y, m, d, 12, 0, 0);

  if (dpState.picking === 'start' || (dpState.start && dpState.end)) {
    // Fresh selection
    dpState.start   = clicked;
    dpState.end     = null;
    dpState.picking = 'end';
  } else {
    // Second click: set end date
    if (clicked < dpState.start) {
      dpState.end   = dpState.start;
      dpState.start = clicked;
    } else {
      dpState.end = clicked;
    }
    dpState.picking = 'start';
  }
  renderDp(id);
}

export function dpGetDates() {
  return {
    start: dateToIso(dpState.start),
    end:   dateToIso(dpState.end),
  };
}

export function renderDp(id) {
  const container = document.getElementById(id);
  if (!container) return;

  const { year, month, start, end } = dpState;
  const today    = new Date();
  const firstDay = new Date(year, month, 1);
  const daysInMo = new Date(year, month + 1, 0).getDate();
  // Monday-based offset
  const offset   = (firstDay.getDay() + 6) % 7;

  // Day-of-week headers
  const dowHtml = DOW.map(d => `<div class="dp-dow">${d}</div>`).join('');

  // Build day cells
  let cells = '';
  for (let i = 0; i < offset; i++) {
    cells += '<div class="dp-cell dp-empty"></div>';
  }
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

  // Range label
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
        <span class="dp-nav-lbl">${MNS[month]} ${year}</span>
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

function _sameDay(a, b) {
  return a.getFullYear() === b.getFullYear()
      && a.getMonth()    === b.getMonth()
      && a.getDate()     === b.getDate();
}

// Expose dpNav and dpClick for onclick="" handlers
window.dpNav   = dpNav;
window.dpClick = dpClick;

// ── Type badge HTML ────────────────────────────────────────────────────────────

export function typeBadge(type) {
  const t = TRIP_TYPES[type] || TRIP_TYPES.voyage;
  let cls = 'badge-type';
  if (type === 'voyage')  cls += ' badge-voyage';
  if (type === 'weekend') cls += ' badge-weekend';
  if (type === 'sortie')  cls += ' badge-sortie';
  return `<span class="${cls}">${t.icon} ${t.label}</span>`;
}

// ── Color options HTML ─────────────────────────────────────────────────────────

/**
 * Render a row of color-swatch divs.
 * @param {string} selectedColor - currently selected hex
 * @param {string} onclickFn     - global JS function name called with (color)
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
