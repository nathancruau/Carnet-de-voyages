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

/**
 * Format a flag emoji as "🇫🇷 FR".
 * Non-flag values (ISO text, globe, etc.) are returned as-is.
 */
export function fmtFlag(flag) {
  if (!flag) return '';
  const pts = [...flag].map(c => c.codePointAt(0)).filter(v => v >= 0x1F1E6 && v <= 0x1F1FF);
  if (pts.length >= 2) {
    const iso = String.fromCharCode(pts[0] - 0x1F1E6 + 65) + String.fromCharCode(pts[1] - 0x1F1E6 + 65);
    return String.fromCodePoint(pts[0]) + String.fromCodePoint(pts[1]) + ' ' + iso;
  }
  if (/^[A-Za-z]{2}$/.test(flag.trim())) {
    const iso = flag.trim().toUpperCase();
    const emoji = String.fromCodePoint(0x1F1E6 + iso.charCodeAt(0) - 65) +
                  String.fromCodePoint(0x1F1E6 + iso.charCodeAt(1) - 65);
    return emoji + ' ' + iso;
  }
  return flag.trim();
}

// ── Date picker ────────────────────────────────────────────────────────────────

const MNS_SHORT = ['Jan','Fév','Mar','Avr','Mai','Jun','Jul','Aoû','Sep','Oct','Nov','Déc'];

let dpState = {
  id:       '',
  year:     new Date().getFullYear(),
  month:    new Date().getMonth(),
  start:    null,   // Date | null
  end:      null,   // Date | null
  picking:  'start', // 'start' | 'end'
  view:     'cal',  // 'cal' | 'year' | 'month'
  yearBase: new Date().getFullYear() - 11, // first year shown in year grid
};

export function dpInit(containerId, startIso, endIso) {
  dpState.id      = containerId;
  dpState.start   = isoToDate(startIso);
  dpState.end     = isoToDate(endIso);
  dpState.picking = dpState.start ? 'end' : 'start';
  dpState.view    = 'cal';

  const anchor = dpState.start || new Date();
  dpState.year  = anchor.getFullYear();
  dpState.month = anchor.getMonth();
  dpState.yearBase = dpState.year - 11;

  renderDp(containerId);
}

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

export function dpToggleView(id) {
  dpState.view = dpState.view === 'cal' ? 'year' : 'cal';
  renderDp(id);
}

export function dpPickYear(y, id) {
  dpState.year  = y;
  dpState.view  = 'month';
  renderDp(id);
}

export function dpPickMonth(m, id) {
  dpState.month = m;
  dpState.view  = 'cal';
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

  const { year, month, start, end, view, yearBase } = dpState;

  // ── Year picker view ─────────────────────────────────────────────────────────
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

  // ── Month picker view ────────────────────────────────────────────────────────
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

  // ── Calendar view (default) ──────────────────────────────────────────────────
  const today    = new Date();
  const firstDay = new Date(year, month, 1);
  const daysInMo = new Date(year, month + 1, 0).getDate();
  const offset   = (firstDay.getDay() + 6) % 7;

  const dowHtml = DOW.map(d => `<div class="dp-dow">${d}</div>`).join('');

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

function _sameDay(a, b) {
  return a.getFullYear() === b.getFullYear()
      && a.getMonth()    === b.getMonth()
      && a.getDate()     === b.getDate();
}

// Expose dp functions for onclick="" handlers
window.dpNav        = dpNav;
window.dpClick      = dpClick;
window.dpToggleView = dpToggleView;
window.dpPickYear   = dpPickYear;
window.dpPickMonth  = dpPickMonth;

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
