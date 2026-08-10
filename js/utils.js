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
let _scrollLockY = 0;
let _bodyLocked  = false;

/**
 * Show the shared modal overlay.
 * @param {string} htmlContent - full HTML injected into .mbox
 * @param {object} [opts]
 * @param {Function} [opts.onClose] - called when the modal is closed
 * @param {boolean} [opts.fullscreenMobile] - on mobile, use the full viewport
 *   height instead of the ~92dvh rounded bottom sheet. For modals with a lot
 *   of dense content (maps, file uploads, long forms) that felt cramped in
 *   the generic sheet. Reset on every call so it never leaks into the next,
 *   unrelated modal that reuses the same .mbox element.
 */
export function showModal(htmlContent, { onClose, fullscreenMobile = false } = {}) {
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
  box.classList.toggle('mbox-fullscreen-mobile', fullscreenMobile);
  box.innerHTML = htmlContent;
  ov.classList.add('open');

  // Clicks inside the box must not bubble up to the overlay's close handler
  box.onclick = e => e.stopPropagation();

  // iOS Safari: lock the body so scrolling the modal doesn't scroll the page behind it.
  // Only needed on mobile body-scroll pages (desktop uses overflow:hidden on html/body).
  if (window.innerWidth <= 768 && !_bodyLocked) {
    _scrollLockY = window.scrollY;
    _bodyLocked  = true;
    document.body.style.position  = 'fixed';
    document.body.style.top       = `-${_scrollLockY}px`;
    document.body.style.width     = '100%';
  }
}

/** Close the modal and invoke the optional onClose callback. */
export function closeModal() {
  const ov = document.getElementById('modal-overlay');
  if (ov) ov.classList.remove('open');

  // Restore body scroll position locked by showModal
  if (_bodyLocked) {
    _bodyLocked = false;
    document.body.style.position = '';
    document.body.style.top      = '';
    document.body.style.width    = '';
    window.scrollTo(0, _scrollLockY);
  }

  if (_modalCloseCallback) {
    _modalCloseCallback();
    _modalCloseCallback = null;
  }
}

// Expose for onclick="" HTML attributes and for app.js
window.closeModal = closeModal;

// ── Photo compression for Firestore sync (1 MB document limit) ─────────────────
// Trips carry photos as inline base64 data: URLs. A single users/{uid} document
// holds every trip at once, so it hits Firestore's 1 MB limit far more easily
// than any individual trip — without compression, a sync with any real photos
// fails every single time (not intermittently), leaving the device stuck
// writing to localStorage only. Used for both the personal sync (auth.js) and
// the per-trip shared_trips document (share.js).

// Two compression tiers: try good quality first (plenty for most trips), and
// only escalate to the aggressive tier for the rare account with enough
// photos that even the good-quality pass wouldn't fit in a 1 MB document.
const GOOD_TIER  = { maxSize: 900, quality: 0.7 };
const TIGHT_TIER = { maxSize: 450, quality: 0.5 };
const FIRESTORE_SIZE_LIMIT = 900 * 1024; // safety margin under Firestore's ~1 MiB cap

const _compressedPhotoCache = new Map(); // `${data: URL}|${maxSize}|${quality}` → compressed data: URL

/** Compress a base64 photo to a JPEG at the given size/quality. Returns null on error. */
export async function compressPhotoDataUrl(b64, maxSize = GOOD_TIER.maxSize, quality = GOOD_TIER.quality) {
  if (!b64 || !b64.startsWith('data:')) return null;
  const cacheKey = `${b64}|${maxSize}|${quality}`;
  const cached = _compressedPhotoCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const result = await new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      try {
        const scale  = Math.min(1, maxSize / Math.max(img.width || 1, img.height || 1));
        const canvas = document.createElement('canvas');
        canvas.width  = Math.round((img.width  || maxSize) * scale);
        canvas.height = Math.round((img.height || maxSize) * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      } catch (_) { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = b64;
  });
  _compressedPhotoCache.set(cacheKey, result);
  return result;
}

/**
 * Return a copy of a trip with every embedded base64 photo re-compressed to a
 * JPEG (at the given size/quality tier) and heavy gpxPoints arrays stripped.
 * Local storage / display always keep the original full-resolution photos —
 * only the copy handed to Firestore goes through this.
 */
export async function compressTripPhotos(trip, maxSize = GOOD_TIER.maxSize, quality = GOOD_TIER.quality) {
  const isB64 = url => typeof url === 'string' && url.startsWith('data:');
  const t = JSON.parse(JSON.stringify(trip));

  const inputs = [];
  const scanUrl = (url) => {
    if (!isB64(url)) return url;
    const slot = inputs.length;
    inputs.push(url);
    return `__SLOT_${slot}__`;
  };
  const scanPhotoObjs = (arr) => (arr || []).map(p => ({ ...p, url: scanUrl(p.url) })).filter(p => p.url);
  const scanPhotoStrs = (arr) => (arr || []).map(scanUrl).filter(Boolean);

  if (t.photo) t.photo = scanUrl(t.photo);
  t.photos = scanPhotoObjs(t.photos);
  if (t.pin?.gpxPoints) delete t.pin.gpxPoints;
  t.days = (t.days || []).map(day => ({
    ...day,
    items: (day.items || []).map(item => {
      const i = { ...item };
      if (i.photo) i.photo = scanUrl(i.photo);
      i.photos = scanPhotoObjs(i.photos);
      // journalData.photos is a plain array of base64 strings (not {url} objects)
      if (i.journalData?.photos?.length) {
        i.journalData = { ...i.journalData, photos: scanPhotoStrs(i.journalData.photos) };
      }
      delete i.gpxPoints;
      return i;
    }),
  }));
  t.journalEntries = (t.journalEntries || []).map(je => ({ ...je, photos: scanPhotoObjs(je.photos) }));

  const compressed = await Promise.all(inputs.map(b64 => compressPhotoDataUrl(b64, maxSize, quality)));
  const replaceSlot = (url) => {
    if (typeof url !== 'string') return url;
    const m = url.match(/^__SLOT_(\d+)__$/);
    return m ? (compressed[parseInt(m[1], 10)] || '') : url;
  };
  const fixPhotoObjs = (arr) => (arr || []).map(p => ({ ...p, url: replaceSlot(p.url) })).filter(p => p.url);
  const fixPhotoStrs = (arr) => (arr || []).map(replaceSlot).filter(Boolean);

  if (t.photo) t.photo = replaceSlot(t.photo);
  t.photos = fixPhotoObjs(t.photos);
  t.days = t.days.map(day => ({
    ...day,
    items: day.items.map(item => ({
      ...item,
      photo:  item.photo ? replaceSlot(item.photo) : item.photo,
      photos: fixPhotoObjs(item.photos),
      journalData: item.journalData?.photos?.length
        ? { ...item.journalData, photos: fixPhotoStrs(item.journalData.photos) }
        : item.journalData,
    })),
  }));
  t.journalEntries = t.journalEntries.map(je => ({ ...je, photos: fixPhotoObjs(je.photos) }));

  return t;
}

/**
 * Compress a set of trips for a single Firestore write, escalating to the
 * more aggressive tier only if the good-quality pass would still be too
 * large for the ~1 MB document limit. Used for both the per-trip
 * shared_trips document (share.js, pass a 1-trip array) and the personal
 * users/{uid} document (auth.js, holds every trip at once).
 */
export async function compressTripsForFirestore(trips) {
  const good = await Promise.all(trips.map(t => compressTripPhotos(t, GOOD_TIER.maxSize, GOOD_TIER.quality)));
  if (JSON.stringify(good).length <= FIRESTORE_SIZE_LIMIT) return good;
  return Promise.all(trips.map(t => compressTripPhotos(t, TIGHT_TIER.maxSize, TIGHT_TIER.quality)));
}

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
