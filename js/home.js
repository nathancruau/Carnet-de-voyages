/* ============================================================
   CARNET DE VOYAGES — Home / Library Screen
   ============================================================ */

import {
  getTrips, getTrip, getState, addTrip, updateTrip, deleteTrip,
  TRIP_TYPES, COMP_COLORS, uid,
  getSettings, updateSettings,
  getEventTypes, DEFAULT_EVENT_TYPES,
  getLanguage, isTripShared, APP_VERSION,
} from './store.js';
import {
  notify, showModal, closeModal,
  fmtDate, fmtDateShort,
  dpInit, dpGetDates, renderDp,
  typeBadge,
  generateDays, customDayTitle,
} from './utils.js';
// navigateToTrip / goMyMap accessed via window globals (set by app.js) to avoid circular import
// import.js / export.js / gpx.js are dynamically imported at their few call sites below —
// most sessions never touch import/export or upload a GPX track from a sortie,
// so none of them should be in the boot bundle.
import { getCurrentUser, logout, syncToFirestore, isFirebaseConfigured, cleanupDuplicatePhotos } from './auth.js';
import { requestNotificationPermission, notificationPermissionGranted } from './notifications.js';
import { openShareModal, leaveSharedTrip, deleteOwnerSharedTrip, removeSharedTripMember, isCurrentUserObserver, getSharedDocData, addObserverReaction, deleteObserverReaction, addObserverComment, deleteObserverComment, handlePendingInvite } from './share.js';

// ── Module state ───────────────────────────────────────────────────────────────

let _currentFilter    = 'all';
let _currentTab       = 'trips';   // 'trips' | 'stats'
let _statsTypeFilter  = 'all';     // 'all' | 'voyage' | 'weekend' | 'sortie'
let _homeLibTab       = 'mine';    // 'mine' | 'observing' | 'live'
let _listenerAttached = false;
let _fabOutsideClickBound = false; // guards the document-level FAB-closer below (see _bindHomeFab)
let _statsLastFiltered = [];       // cache for world-map re-render on expand

// ── Globe (stats world view) state ──────────────────────────────────────────────
let _globeFeaturesCache  = null;               // parsed GeoJSON country features (fetched once)
let _globeCentroidsCache = null;               // Map<ISO-2, {lon,lat}> (derived once from features)
let _globeData           = null;               // { visitedMap, centroids } used by the current draw/redraw
let _globeRotation        = { lambda: 10, phi: 15 };  // current view center (persists across re-renders)
let _globeZoom             = 1;                // current zoom factor (persists across re-renders)
let _globeTarget          = null;              // { lambda, phi } animation target when focusing a country
let _globeAnimId          = null;              // requestAnimationFrame id for focus animation
const _globeBoundCanvases = new WeakSet();     // avoid re-binding pointer listeners on the same canvas node
const _globeMarkerEls     = new Map();         // ISO-2 -> marker <button>, reused across redraws
let _globeMarkersContainer = null;             // the .globe-markers node the cache above belongs to

// Companion list being edited in the open modal
let _modalComps  = [];
let _modalColor  = '#0d9488';
let _modalType   = 'voyage';
let _modalStatus = 'planning';
let _editingId   = null;

// Photo file mode state
let _photoMode   = 'url';   // 'url' | 'file'
let _photoBase64 = null;

// ── Sortie modal state ─────────────────────────────────────────────────────────
let _sortieModalMap    = null;
let _sortieModalMarker = null;
let _sortieLat         = null;
let _sortieLng         = null;
let _sortieWeather     = null;
let _sortiePinType     = 'visit';
let _sortiePhotoMode   = 'url';
let _sortiePhotoBase64 = null;
let _sortieExtraPhotos = []; // [{url: base64|url}, ...] — additional carousel photos
let _sortieComps       = []; // companions being edited in the sortie modal
let _sortieGpxTrack   = null;   // GPX track uploaded in the current sortie modal session
let _sortieGpxStats   = null;   // computed stats for that track
let _sortieGpxDeleted = false;  // true when user removes an existing GPX during edit

const WEATHER_EMOJIS = ['☀️','🌤️','⛅','🌦️','🌧️','⛈️','🌨️','❄️','🌫️','💨','🌈'];

let _openTripMenuEl = null;

// ── Helpers ────────────────────────────────────────────────────────────────────

function _compColor(index) {
  return COMP_COLORS[index % COMP_COLORS.length];
}

/** Unique companion names across every trip, most-travelled-with first. */
function _knownCompanions() {
  const byLower = new Map(); // lowercase name -> { name, count }
  for (const trip of getTrips()) {
    for (const c of (trip.companions || [])) {
      const name = (c.name || '').trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const entry = byLower.get(key);
      if (entry) entry.count++;
      else byLower.set(key, { name, count: 1 });
    }
  }
  return [...byLower.values()].sort((a, b) => b.count - a.count);
}

/**
 * Suggestion chips for companions not already added to the given list.
 * With no query: the most frequent travel companions (quick pick). Once the
 * user starts typing, switches to a live filter over every known companion —
 * not just the frequent ones — so anyone can still be found by name.
 */
function _compSuggestChipsHtml(currentComps, query = '') {
  const already = new Set(currentComps.map(c => (c.name || '').trim().toLowerCase()));
  const q = query.trim().toLowerCase();
  let suggestions = _knownCompanions().filter(c => !already.has(c.name.toLowerCase()));
  suggestions = q ? suggestions.filter(c => c.name.toLowerCase().includes(q)) : suggestions;
  suggestions = suggestions.slice(0, 8);
  if (!suggestions.length) return '';
  return `
    <div class="comp-suggest-row">
      ${suggestions.map(c => `<button type="button" class="comp-suggest-chip" data-action="add-suggested-comp" data-name="${_esc(c.name)}">+ ${_esc(c.name)}</button>`).join('')}
    </div>`;
}

function _initials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return parts[0].slice(0, 2).toUpperCase();
}

function _esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── ISO numeric → alpha-2 lookup (topojson world-atlas uses numeric IDs) ────────
const _ISO_N_A2 = {
  4:'AF',8:'AL',12:'DZ',20:'AD',24:'AO',28:'AG',32:'AR',36:'AU',40:'AT',
  44:'BS',48:'BH',50:'BD',52:'BB',56:'BE',64:'BT',68:'BO',70:'BA',72:'BW',
  76:'BR',96:'BN',100:'BG',104:'MM',108:'BI',116:'KH',120:'CM',124:'CA',
  132:'CV',140:'CF',144:'LK',148:'TD',152:'CL',156:'CN',170:'CO',174:'KM',
  178:'CG',180:'CD',188:'CR',191:'HR',192:'CU',196:'CY',203:'CZ',204:'BJ',
  208:'DK',214:'DO',218:'EC',222:'SV',226:'GQ',231:'ET',232:'ER',246:'FI',
  250:'FR',262:'DJ',266:'GA',268:'GE',270:'GM',276:'DE',288:'GH',300:'GR',
  320:'GT',324:'GN',328:'GY',332:'HT',340:'HN',348:'HU',356:'IN',360:'ID',
  364:'IR',368:'IQ',372:'IE',376:'IL',380:'IT',384:'CI',388:'JM',392:'JP',
  398:'KZ',400:'JO',404:'KE',408:'KP',410:'KR',414:'KW',417:'KG',418:'LA',
  422:'LB',426:'LS',430:'LR',434:'LY',440:'LT',442:'LU',450:'MG',454:'MW',
  458:'MY',462:'MV',466:'ML',484:'MX',496:'MN',499:'ME',504:'MA',508:'MZ',
  512:'OM',516:'NA',524:'NP',528:'NL',554:'NZ',558:'NI',562:'NE',566:'NG',
  578:'NO',586:'PK',591:'PA',598:'PG',600:'PY',604:'PE',608:'PH',616:'PL',
  620:'PT',634:'QA',642:'RO',643:'RU',646:'RW',682:'SA',686:'SN',688:'RS',
  694:'SL',703:'SK',704:'VN',705:'SI',706:'SO',710:'ZA',716:'ZW',724:'ES',
  729:'SD',740:'SR',752:'SE',756:'CH',760:'SY',762:'TJ',764:'TH',788:'TN',
  792:'TR',795:'TM',800:'UG',804:'UA',807:'MK',818:'EG',826:'GB',840:'US',
  858:'UY',860:'UZ',862:'VE',887:'YE',894:'ZM',275:'PS',51:'AM',31:'AZ',
  84:'BZ',60:'BM',854:'BF',702:'SG',158:'TW',784:'AE',233:'EE',428:'LV',
  470:'MT',388:'JM',630:'PR',192:'CU',352:'IS',533:'AW',690:'SC',748:'SZ',
};

// ── Destination text → alpha-2 (French names first) ────────────────────────────
const _DEST_TO_A2 = {
  'france':'FR','espagne':'ES','spain':'ES','italie':'IT','italia':'IT','italy':'IT',
  'allemagne':'DE','germany':'DE','portugal':'PT','belgique':'BE','belgium':'BE',
  'pays-bas':'NL','netherlands':'NL','hollande':'NL','grèce':'GR','grece':'GR','greece':'GR',
  'royaume-uni':'GB','uk':'GB','angleterre':'GB','england':'GB','écosse':'GB','scotland':'GB',
  'états-unis':'US','etats-unis':'US','usa':'US','united states':'US','amérique':'US',
  'canada':'CA','mexique':'MX','mexico':'MX','japon':'JP','japan':'JP',
  'chine':'CN','china':'CN','australie':'AU','australia':'AU',
  'brésil':'BR','bresil':'BR','brazil':'BR','argentine':'AR','argentina':'AR',
  'maroc':'MA','morocco':'MA','tunisie':'TN','tunisia':'TN','turquie':'TR','turkey':'TR',
  'égypte':'EG','egypte':'EG','egypt':'EG','thaïlande':'TH','tailande':'TH','thailand':'TH',
  'inde':'IN','india':'IN','vietnam':'VN','cambodge':'KH','cambodia':'KH',
  'suisse':'CH','switzerland':'CH','autriche':'AT','austria':'AT',
  'croatie':'HR','croatia':'HR','pologne':'PL','poland':'PL',
  'hongrie':'HU','hungary':'HU','roumanie':'RO','romania':'RO',
  'suède':'SE','sweden':'SE','norvège':'NO','norway':'NO',
  'danemark':'DK','denmark':'DK','finlande':'FI','finland':'FI',
  'irlande':'IE','ireland':'IE','islande':'IS','iceland':'IS',
  'nouvelle-zélande':'NZ','new zealand':'NZ','afrique du sud':'ZA','south africa':'ZA',
  'kenya':'KE','pérou':'PE','peru':'PE','chili':'CL','chile':'CL',
  'colombie':'CO','colombia':'CO','singapour':'SG','singapore':'SG',
  'malaisie':'MY','malaysia':'MY','israël':'IL','israel':'IL',
  'jordanie':'JO','jordan':'JO','russie':'RU','russia':'RU','ukraine':'UA',
  'slovénie':'SI','slovenia':'SI','luxembourg':'LU','malte':'MT','malta':'MT',
  'chypre':'CY','cyprus':'CY','albanie':'AL','albania':'AL','serbie':'RS','serbia':'RS',
  'bulgarie':'BG','bulgaria':'BG','lituanie':'LT','lithuania':'LT',
  'lettonie':'LV','latvia':'LV','estonie':'EE','estonia':'EE',
  'slovaquie':'SK','slovakia':'SK','tchéquie':'CZ','czech republic':'CZ',
  'corée du sud':'KR','south korea':'KR','taïwan':'TW','taiwan':'TW',
  'philippines':'PH','indonésie':'ID','indonesia':'ID',
  'algérie':'DZ','algeria':'DZ','sénégal':'SN','senegal':'SN',
  'émirats':'AE','dubai':'AE','doha':'QA','qatar':'QA',
  'arabie saoudite':'SA','saudi arabia':'SA','koweït':'KW','kuwait':'KW',
  'iran':'IR','liban':'LB','lebanon':'LB','géorgie':'GE','georgia':'GE',
  'arménie':'AM','armenia':'AM','kazakhtan':'KZ','kazakhstan':'KZ',
  'tanzanie':'TZ','tanzania':'TZ','ghana':'GH','nigeria':'NG',
  'cameroun':'CM','cameroon':'CM','mozambique':'MZ','angola':'AO',
  'sri lanka':'LK','bangladesh':'BD','pakistan':'PK','népal':'NP','nepal':'NP',
  'myanmar':'MM','birmanie':'MM','laos':'LA','mongolie':'MN','mongolia':'MN',
  'équateur':'EC','ecuador':'EC','bolivie':'BO','bolivia':'BO','uruguay':'UY',
  'venezuela':'VE','paraguay':'PY','salvador':'SV',
};

// Country name lookup (French) for map tooltips
const _A2_NAME = {
  FR:'France',ES:'Espagne',IT:'Italie',DE:'Allemagne',PT:'Portugal',GB:'Royaume-Uni',
  NL:'Pays-Bas',BE:'Belgique',CH:'Suisse',AT:'Autriche',GR:'Grèce',HR:'Croatie',
  PL:'Pologne',CZ:'Tchéquie',HU:'Hongrie',RO:'Roumanie',SE:'Suède',NO:'Norvège',
  DK:'Danemark',FI:'Finlande',IE:'Irlande',IS:'Islande',LU:'Luxembourg',MT:'Malte',
  CY:'Chypre',AL:'Albanie',RS:'Serbie',SI:'Slovénie',SK:'Slovaquie',BG:'Bulgarie',
  LT:'Lituanie',LV:'Lettonie',EE:'Estonie',MK:'Macédoine',BA:'Bosnie',ME:'Monténégro',
  UA:'Ukraine',RU:'Russie',TR:'Turquie',
  MA:'Maroc',TN:'Tunisie',EG:'Égypte',ZA:'Afrique du Sud',KE:'Kenya',SN:'Sénégal',
  NG:'Nigéria',TZ:'Tanzanie',GH:'Ghana',CM:'Cameroun',MZ:'Mozambique',AO:'Angola',
  DZ:'Algérie',LY:'Libye',ET:'Éthiopie',
  US:'États-Unis',CA:'Canada',MX:'Mexique',BR:'Brésil',AR:'Argentine',CL:'Chili',
  CO:'Colombie',PE:'Pérou',BO:'Bolivie',UY:'Uruguay',EC:'Équateur',VE:'Venezuela',
  PY:'Paraguay',CR:'Costa Rica',CU:'Cuba',
  JP:'Japon',CN:'Chine',KR:'Corée du Sud',TH:'Thaïlande',VN:'Vietnam',ID:'Indonésie',
  MY:'Malaisie',SG:'Singapour',PH:'Philippines',IN:'Inde',NP:'Népal',LK:'Sri Lanka',
  BD:'Bangladesh',PK:'Pakistan',TW:'Taïwan',KH:'Cambodge',LA:'Laos',MM:'Myanmar',
  MN:'Mongolie',KZ:'Kazakhstan',GE:'Géorgie',AM:'Arménie',AZ:'Azerbaïdjan',
  IL:'Israël',JO:'Jordanie',LB:'Liban',AE:'Émirats arabes unis',SA:'Arabie Saoudite',
  QA:'Qatar',KW:'Koweït',IR:'Iran',AU:'Australie',NZ:'Nouvelle-Zélande',
};

// Continent lookup for stats breakdown
const _A2_CONTINENT = {
  FR:'EU',ES:'EU',IT:'EU',DE:'EU',PT:'EU',GB:'EU',NL:'EU',BE:'EU',CH:'EU',AT:'EU',
  GR:'EU',HR:'EU',PL:'EU',CZ:'EU',HU:'EU',RO:'EU',SE:'EU',NO:'EU',DK:'EU',FI:'EU',
  IE:'EU',IS:'EU',LU:'EU',MT:'EU',CY:'EU',AL:'EU',RS:'EU',SI:'EU',SK:'EU',BG:'EU',
  LT:'EU',LV:'EU',EE:'EU',MK:'EU',BA:'EU',ME:'EU',UA:'EU',RU:'EU',TR:'EU',MD:'EU',
  MA:'AF',TN:'AF',EG:'AF',ZA:'AF',KE:'AF',SN:'AF',NG:'AF',TZ:'AF',GH:'AF',CM:'AF',
  MZ:'AF',AO:'AF',DZ:'AF',LY:'AF',ET:'AF',CI:'AF',SD:'AF',CD:'AF',
  US:'AM',CA:'AM',MX:'AM',BR:'AM',AR:'AM',CL:'AM',CO:'AM',PE:'AM',BO:'AM',UY:'AM',
  EC:'AM',VE:'AM',PY:'AM',CR:'AM',CU:'AM',DO:'AM',
  JP:'AS',CN:'AS',KR:'AS',TH:'AS',VN:'AS',ID:'AS',MY:'AS',SG:'AS',PH:'AS',IN:'AS',
  NP:'AS',LK:'AS',BD:'AS',PK:'AS',TW:'AS',KH:'AS',LA:'AS',MM:'AS',MN:'AS',KZ:'AS',
  GE:'AS',AM:'AS',AZ:'AS',IL:'AS',JO:'AS',LB:'AS',AE:'AS',SA:'AS',QA:'AS',KW:'AS',
  IR:'AS',IQ:'AS',SY:'AS',BN:'AS',
  AU:'OC',NZ:'OC',PG:'OC',
};
const _CONTINENT_LABEL = { EU:'Europe',AF:'Afrique',AM:'Amériques',AS:'Asie',OC:'Océanie' };
const _CONTINENT_COLOR = { EU:'#0d9488',AF:'#d97706',AM:'#7c3aed',AS:'#0891b2',OC:'#16a34a' };

function _isoFromFlag(flag) {
  if (!flag) return '';
  const trimmed = flag.trim();
  const pts = [...trimmed].map(c => c.codePointAt(0)).filter(cp => cp >= 0x1F1E6 && cp <= 0x1F1FF);
  if (pts.length >= 2) return pts.slice(0, 2).map(cp => String.fromCharCode(cp - 0x1F1E6 + 65)).join('');
  if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();
  return '';
}

function _tripIsoCodes(trip) {
  const codes = new Set();
  const tripIso = _isoFromFlag(trip.flag);
  if (tripIso) codes.add(tripIso);
  for (const day of (trip.days || [])) {
    if (day.flag) { const iso = _isoFromFlag(day.flag); if (iso) codes.add(iso); }
  }
  if (trip.countryCode) { codes.add(trip.countryCode.toUpperCase()); return codes; }
  const dest = (trip.destination || '').toLowerCase().trim();
  if (!dest) return codes;
  if (_DEST_TO_A2[dest]) { codes.add(_DEST_TO_A2[dest]); return codes; }
  const parts = dest.split(/[,\/·\-–]/);
  let found = false;
  for (const part of [...parts].reverse()) {
    const p = part.trim();
    if (_DEST_TO_A2[p]) { codes.add(_DEST_TO_A2[p]); found = true; break; }
  }
  if (!found) {
    for (const [name, code] of Object.entries(_DEST_TO_A2)) {
      if (dest.includes(name)) { codes.add(code); break; }
    }
  }
  return codes;
}

// Returns Map<ISO-2, tripCount> — used for intensity coloring
function _getVisitedMap(trips) {
  const counts = new Map();
  for (const trip of trips) {
    for (const code of _tripIsoCodes(trip)) {
      counts.set(code, (counts.get(code) || 0) + 1);
    }
  }
  return counts;
}

function _getVisitedCodes(trips) {
  return [..._getVisitedMap(trips).keys()];
}

// ISO-2 → flag emoji
function _isoToFlag(iso) {
  if (!iso || iso.length !== 2) return '🌍';
  return String.fromCodePoint(iso.charCodeAt(0) - 65 + 0x1F1E6, iso.charCodeAt(1) - 65 + 0x1F1E6);
}

// Round flag badge fill: a real cropped flag image (so the circle is filled edge-to-
// edge with the flag's colors, not a small emoji glyph floating in a plain circle).
// Falls back to the flag emoji, underneath, if the image can't load (offline etc).
function _flagImgHtml(iso) {
  const code = (iso || '').toLowerCase();
  return `<span class="flag-emoji-fallback">${_isoToFlag(iso)}</span>
          <img class="flag-img" src="https://flagcdn.com/w80/${code}.png" alt="" loading="lazy" onerror="this.remove()">`;
}

// Count trips per travel season
function _calcSeasons(trips) {
  const s = { spring: 0, summer: 0, autumn: 0, winter: 0 };
  for (const trip of trips) {
    if (!trip.startDate) continue;
    const m = parseInt(trip.startDate.slice(5, 7), 10);
    if (m >= 3 && m <= 5) s.spring++;
    else if (m >= 6 && m <= 8) s.summer++;
    else if (m >= 9 && m <= 11) s.autumn++;
    else s.winter++;
  }
  return s;
}

// ── Globe (stats world view) ────────────────────────────────────────────────────

const _DEG2RAD = Math.PI / 180;

/** Average lon/lat of a country's largest ring — same naive-average simplification
 *  as before (breaks slightly for antimeridian-straddling countries like Russia/Fiji,
 *  acceptable for a small flag marker's placement). */
function _countryCentroidsLonLat(features) {
  const map = new Map();
  for (const feat of features) {
    const code = _ISO_N_A2[Number(feat.id)] || '';
    if (!code) continue;
    const geom = feat.geometry;
    if (!geom) continue;
    const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
    let bestRingSize = 0, lon = 0, lat = 0;
    for (const poly of polys) {
      const ring = poly[0];
      let sumLon = 0, sumLat = 0;
      for (const [lo, la] of ring) { sumLon += lo; sumLat += la; }
      if (ring.length > bestRingSize) {
        bestRingSize = ring.length;
        lon = sumLon / ring.length;
        lat = sumLat / ring.length;
      }
    }
    if (bestRingSize > 0) map.set(code, { lon, lat });
  }
  return map;
}

/** Orthographic projection of a (lon,lat) point given the current view center. */
function _globeProject(lon, lat, lambda0, phi0) {
  const λ    = (lon - lambda0) * _DEG2RAD;
  const φ    = lat * _DEG2RAD;
  const φ1   = phi0 * _DEG2RAD;
  const cosφ = Math.cos(φ),  sinφ  = Math.sin(φ);
  const cosφ1= Math.cos(φ1), sinφ1 = Math.sin(φ1);
  const cosλ = Math.cos(λ),  sinλ  = Math.sin(λ);
  const cosC = sinφ1 * sinφ + cosφ1 * cosφ * cosλ;
  return {
    x: cosφ * sinλ,
    y: cosφ1 * sinφ - sinφ1 * cosφ * cosλ,
    visible: cosC > 0.03,
  };
}

async function _initGlobe(trips) {
  const canvas = document.getElementById('globe-canvas');
  if (!canvas) return;
  try {
    if (!_globeFeaturesCache) {
      const [topoMod, worldData] = await Promise.all([
        import('https://cdn.jsdelivr.net/npm/topojson-client@3/+esm'),
        fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json').then(r => r.json()),
      ]);
      _globeFeaturesCache  = topoMod.feature(worldData, worldData.objects.countries).features;
      _globeCentroidsCache = _countryCentroidsLonLat(_globeFeaturesCache);
    }
    const visitedMap = _getVisitedMap(trips);
    _globeData = { visitedMap, centroids: _globeCentroidsCache };

    _drawGlobe(canvas);
    if (!_globeBoundCanvases.has(canvas)) {
      _globeBoundCanvases.add(canvas);
      _attachGlobeInteraction(canvas);
    }
  } catch (err) {
    console.warn('[stats] globe failed:', err.message);
    const wrap = document.getElementById('world-map-wrap');
    if (wrap) wrap.style.display = 'none';
  }
}

function _drawGlobe(canvas) {
  if (!canvas || !_globeData) return;
  const dpr = window.devicePixelRatio || 1;
  const W   = canvas.clientWidth || 320;
  const H   = W; // circular — keep the canvas square
  // Resizing canvas.width/height clears + reallocates the bitmap — skip it when
  // unchanged so drag-driven redraws (many per second) don't pay for that each frame.
  const pxW = Math.round(W * dpr), pxH = Math.round(H * dpr);
  if (canvas.width !== pxW || canvas.height !== pxH) {
    canvas.width  = pxW;
    canvas.height = pxH;
    canvas.style.height = H + 'px';
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const isDark = document.documentElement.dataset.theme === 'dark';
  const cx = W / 2, cy = H / 2, R = W / 2 * 0.94 * _globeZoom;
  const { lambda, phi } = _globeRotation;
  const { visitedMap } = _globeData;

  // Ocean sphere
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fillStyle = isDark ? '#1c3a3f' : '#cdeef2';
  ctx.fill();

  // Graticule (lightweight — every 30°)
  ctx.strokeStyle = isDark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.07)';
  ctx.lineWidth = 0.6;
  for (let lon = -180; lon < 180; lon += 30) {
    ctx.beginPath();
    let started = false;
    for (let lat = -90; lat <= 90; lat += 3) {
      const p = _globeProject(lon, lat, lambda, phi);
      if (!p.visible) { started = false; continue; }
      const x = cx + p.x * R, y = cy - p.y * R;
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    ctx.beginPath();
    let started = false;
    for (let lon = -180; lon <= 180; lon += 3) {
      const p = _globeProject(lon, lat, lambda, phi);
      if (!p.visible) { started = false; continue; }
      const x = cx + p.x * R, y = cy - p.y * R;
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  const LAND_UNVISITED = isDark ? '#3a3834' : '#e0dcd4';

  for (const feat of _globeFeaturesCache) {
    const code = _ISO_N_A2[Number(feat.id)] || '';
    const cont = _A2_CONTINENT[code];
    const visited = code && visitedMap.get(code) > 0;
    ctx.fillStyle   = visited ? (_CONTINENT_COLOR[cont] || '#0d9488') : LAND_UNVISITED;
    ctx.strokeStyle = isDark ? '#141311' : '#faf7f2';
    ctx.lineWidth   = 0.5;

    const geom = feat.geometry;
    if (!geom) continue;
    const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;

    for (const poly of polys) {
      const ring = poly[0];
      // Skip rings entirely on the far side of the globe (backface cull, per-ring)
      let anyVisible = false;
      const pts = ring.map(([lon, lat]) => {
        const p = _globeProject(lon, lat, lambda, phi);
        if (p.visible) anyVisible = true;
        return p;
      });
      if (!anyVisible) continue;

      ctx.beginPath();
      let started = false;
      pts.forEach((p, i) => {
        if (!p.visible) { started = false; return; }
        const x = cx + p.x * R, y = cy - p.y * R;
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }

  // Globe outline
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.strokeStyle = isDark ? 'rgba(255,255,255,.15)' : 'rgba(0,0,0,.12)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Flag markers are real HTML elements overlaid on the canvas (not canvas-drawn
  // text) so the flag emoji render at full native quality/color, same as the
  // "Drapeaux collectés" badges, and are natively clickable.
  _renderGlobeMarkers(canvas, W, H, cx, cy, R);
}

function _renderGlobeMarkers(canvas, W, H, cx, cy, R) {
  const container = canvas.parentElement?.querySelector('.globe-markers');
  if (!container || !_globeData) return;

  // Reuse existing marker elements across redraws instead of rebuilding innerHTML
  // every frame — recreating <img> nodes on every drag/zoom tick interrupted their
  // load and made them flash back to the emoji fallback.
  if (container !== _globeMarkersContainer) {
    _globeMarkersContainer = container;
    _globeMarkerEls.clear();
    container.innerHTML = '';
  }

  const { visitedMap, centroids } = _globeData;
  const { lambda, phi } = _globeRotation;
  // Marker size stays constant regardless of zoom (like a map pin, not part of the
  // zoomed sphere itself) — otherwise at high zoom the badges balloon and cover the map.
  const baseR = W / 2 * 0.94;
  const size  = Math.max(20, Math.round(baseR * 0.22));

  const seen = new Set();
  for (const [code, count] of visitedMap) {
    if (!count) continue;
    const c = centroids.get(code);
    if (!c) continue;
    const p = _globeProject(c.lon, c.lat, lambda, phi);
    if (!p.visible) continue;
    const x = cx + p.x * R, y = cy - p.y * R;
    seen.add(code);

    let el = _globeMarkerEls.get(code);
    if (!el) {
      el = document.createElement('button');
      el.type = 'button';
      el.className = 'globe-marker';
      el.dataset.action = 'focus-country';
      el.dataset.code   = code;
      el.title = _A2_NAME[code] || code;
      el.innerHTML = _flagImgHtml(code);
      container.appendChild(el);
      _globeMarkerEls.set(code, el);
    }
    el.style.left     = x.toFixed(1) + 'px';
    el.style.top      = y.toFixed(1) + 'px';
    el.style.width    = size + 'px';
    el.style.height   = size + 'px';
    el.style.fontSize = Math.round(size * 0.55) + 'px';
  }

  // Drop markers that rotated out of view
  for (const [code, el] of _globeMarkerEls) {
    if (!seen.has(code)) { el.remove(); _globeMarkerEls.delete(code); }
  }
}

function _attachGlobeInteraction(canvas) {
  canvas.style.touchAction = 'none';
  let dragging = false;
  let lastX = 0, lastY = 0;
  const pointers  = new Map();   // pointerId -> {x,y}, tracks active touches for pinch-zoom
  let pinchDist   = 0;

  const clampZoom = z => Math.max(0.6, Math.min(6, z));
  const pinchPointerDist = () => {
    const pts = [...pointers.values()];
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  };

  const onDown = e => {
    // A focus animation in progress gets cancelled by manual interaction
    if (_globeAnimId) { cancelAnimationFrame(_globeAnimId); _globeAnimId = null; _globeTarget = null; }
    canvas.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      dragging  = false;
      pinchDist = pinchPointerDist();
    } else {
      dragging = true;
      lastX = e.clientX; lastY = e.clientY;
    }
  };
  const onMove = e => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size >= 2) {
      const d = pinchPointerDist();
      if (pinchDist > 0) _globeZoom = clampZoom(_globeZoom * (d / pinchDist));
      pinchDist = d;
      _drawGlobe(canvas);
      return;
    }
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    // Natural "grab the sphere" feel: content follows the pointer. 0.4 is
    // calibrated for 1:1 tracking at zoom 1 — the sphere's on-screen radius
    // grows with zoom, so the same drag now covers more degrees of rotation
    // unless the sensitivity shrinks to match (otherwise it drags too fast
    // once zoomed in, spinning far more than the finger actually moved).
    const sens = 0.4 / _globeZoom;
    _globeRotation.lambda -= dx * sens;
    _globeRotation.phi     = Math.max(-85, Math.min(85, _globeRotation.phi + dy * sens));
    _drawGlobe(canvas);
  };
  const onUp = e => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchDist = 0;
    if (pointers.size === 1) {
      const [[, p]] = pointers;
      dragging = true; lastX = p.x; lastY = p.y;
    } else if (pointers.size === 0) {
      dragging = false;
    }
  };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('pointerleave', onUp);

  // Desktop: mouse-wheel zoom
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    _globeZoom = clampZoom(_globeZoom + (e.deltaY > 0 ? -0.1 : 0.1));
    _drawGlobe(canvas);
  }, { passive: false });
}

/** Smoothly rotate the globe so the given ISO-2 country faces the viewer. */
function _focusGlobeOnCountry(code) {
  const canvas = document.getElementById('globe-canvas');
  const centroid = _globeCentroidsCache?.get(code);
  if (!canvas || !centroid) return;

  const label = document.getElementById('globe-country-label');
  if (label) {
    label.style.display = '';
    label.innerHTML = `${_isoToFlag(code)} <b>${_esc(_A2_NAME[code] || code)}</b>`;
  }

  _globeTarget = { lambda: centroid.lon, phi: centroid.lat };
  if (_globeAnimId) cancelAnimationFrame(_globeAnimId);

  const step = () => {
    if (!_globeTarget) return;
    let dLambda = ((_globeTarget.lambda - _globeRotation.lambda + 540) % 360) - 180;
    let dPhi    = _globeTarget.phi - _globeRotation.phi;
    _globeRotation.lambda += dLambda * 0.12;
    _globeRotation.phi    += dPhi * 0.12;
    _globeRotation.lambda  = ((_globeRotation.lambda + 180) % 360 + 360) % 360 - 180;
    _drawGlobe(canvas);
    if (Math.abs(dLambda) > 0.3 || Math.abs(dPhi) > 0.3) {
      _globeAnimId = requestAnimationFrame(step);
    } else {
      _globeAnimId = null;
      _globeTarget = null;
    }
  };
  _globeAnimId = requestAnimationFrame(step);
}

// ── Global search ─────────────────────────────────────────────────────────────

function _searchAll(query) {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  const results = [];
  for (const trip of getTrips()) {
    if ((trip.name || '').toLowerCase().includes(q) || (trip.destination || '').toLowerCase().includes(q)) {
      results.push({ icon: trip.flag || '🌍', title: trip.name || 'Voyage', sub: trip.destination || '', tripId: trip.id });
    }
    for (const day of (trip.days || [])) {
      if ((day.title || '').toLowerCase().includes(q) || (day.region || '').toLowerCase().includes(q)) {
        results.push({ icon: '📅', title: day.title || `Jour ${day.num}`, sub: trip.name + (day.region ? ' · ' + day.region : ''), tripId: trip.id });
      }
      for (const item of (day.items || [])) {
        if ((item.text || '').toLowerCase().includes(q) || (item.notes || '').toLowerCase().includes(q)) {
          results.push({ icon: item.emoji || '📍', title: item.text || 'Événement', sub: `${trip.name} · Jour ${day.num}`, tripId: trip.id });
        }
      }
    }
    for (const comp of (trip.companions || [])) {
      if ((comp.name || '').toLowerCase().includes(q)) {
        results.push({ icon: '👤', title: comp.name, sub: trip.name, tripId: trip.id });
      }
    }
    for (const exp of (trip.realExpenses || [])) {
      const catName = (trip.budgetCats || []).find(c => c.id === exp.catId)?.name || '';
      if ((exp.desc || '').toLowerCase().includes(q) || (exp.note || '').toLowerCase().includes(q) || catName.toLowerCase().includes(q)) {
        results.push({ icon: '💳', title: exp.desc || catName || 'Dépense', sub: `${trip.name} · ${exp.amount ? exp.amount + ' €' : ''}`, tripId: trip.id });
      }
    }
    if (results.length >= 30) break;
  }
  return results.slice(0, 25);
}

function _searchResultsHtml(results, query) {
  if (!results.length) return `<div style="text-align:center;padding:28px;color:var(--ink4)">
    <div style="font-size:28px;margin-bottom:6px">🔍</div>
    <div style="font-size:13px">Aucun résultat pour «&nbsp;${_esc(query)}&nbsp;»</div>
  </div>`;
  return results.map(r => `
    <div class="sr-item" data-action="open-trip" data-trip-id="${r.tripId}">
      <span class="sr-icon">${r.icon}</span>
      <div><div class="sr-title">${_esc(r.title)}</div><div class="sr-sub">${_esc(r.sub)}</div></div>
    </div>`).join('');
}

function _handleSearchInput(query) {
  const area      = document.getElementById('search-results-area');
  const grid      = document.getElementById('trips-grid');
  const statsView = document.getElementById('stats-view');
  if (!area) return;
  if (!query.trim()) {
    area.innerHTML = ''; area.style.display = 'none';
    if (grid)      grid.style.display = '';
    if (statsView) statsView.style.display = '';
    return;
  }
  area.style.display = '';
  area.innerHTML     = _searchResultsHtml(_searchAll(query), query);
  if (grid)      grid.style.display = 'none';
  if (statsView) statsView.style.display = 'none';
}

// ── Statistics ─────────────────────────────────────────────────────────────────

function _haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, p = Math.PI / 180;
  const a = 0.5 - Math.cos((lat2 - lat1) * p) / 2
    + Math.cos(lat1 * p) * Math.cos(lat2 * p) * (1 - Math.cos((lng2 - lng1) * p)) / 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const _ROAD_FACTOR = { car: 1.3, bus: 1.3, bike: 1.2, foot: 1.15, plane: 1.05, ferry: 1.1 };

function _calcKmByMode(trips) {
  const km = {};
  for (const trip of trips) {
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
    for (let i = 0; i < wps.length - 1; i++) {
      const m = wps[i + 1].mode || 'car';
      const factor = _ROAD_FACTOR[m] || 1.2;
      km[m] = (km[m] || 0) + _haversineKm(wps[i].lat, wps[i].lng, wps[i + 1].lat, wps[i + 1].lng) * factor;
    }
  }
  return km;
}

function _calcSpendingByMonth(trips) {
  const by = {};
  for (const trip of trips) {
    for (const exp of (trip.realExpenses || [])) {
      if (exp.date && exp.type !== 'transfer') {
        const m = exp.date.slice(0, 7);
        by[m] = (by[m] || 0) + (Number(exp.amount) || 0);
      }
    }
  }
  return by;
}

function _calcStats(trips) {
  const voyageCount  = trips.filter(t => t.type === 'voyage').length;
  const weekendCount = trips.filter(t => t.type === 'weekend').length;
  const sortieCount  = trips.filter(t => t.type === 'sortie').length;

  let totalDays = 0;
  for (const t of trips) {
    if (t.startDate && t.endDate) {
      const diff = Math.round(
        (new Date(t.endDate + 'T12:00:00') - new Date(t.startDate + 'T12:00:00')) / 86400000
      ) + 1;
      if (diff > 0) totalDays += diff;
    }
  }

  const destinations = new Set(
    trips.map(t => (t.destination || '').trim().toLowerCase()).filter(Boolean)
  );

  let totalSpent = 0;
  for (const t of trips) {
    for (const exp of (t.realExpenses || [])) {
      if (exp.type !== 'transfer') totalSpent += Number(exp.amount) || 0;
    }
  }

  return { voyageCount, weekendCount, sortieCount, totalDays, countries: destinations.size, totalSpent };
}

// ── Stats view HTML ────────────────────────────────────────────────────────────

function _statsViewHtml(trips) {
  if (trips.length === 0) {
    return `<div style="text-align:center;padding:40px 20px;color:var(--ink4)">
      <div style="font-size:36px;margin-bottom:8px">📊</div>
      <div style="font-size:14px">Aucun voyage réalisé pour calculer des statistiques.</div>
    </div>`;
  }

  const s = _calcStats(trips);

  // Dates
  const tripsWithDates = trips.filter(t => t.startDate && t.endDate);
  let avgDays = 0;
  let longestTrip = null, longestDays = 0;
  if (tripsWithDates.length > 0) {
    let totalD = 0;
    for (const t of tripsWithDates) {
      const d = Math.round((new Date(t.endDate + 'T12:00:00') - new Date(t.startDate + 'T12:00:00')) / 86400000) + 1;
      totalD += d;
      if (d > longestDays) { longestDays = d; longestTrip = t; }
    }
    avgDays = Math.round(totalD / tripsWithDates.length);
  }

  // Countries
  const visitedMap   = _getVisitedMap(trips);
  const visitedCount = visitedMap.size;

  // Continent breakdown
  const continentCount = {};
  for (const code of visitedMap.keys()) {
    const cont = _A2_CONTINENT[code];
    if (cont) continentCount[cont] = (continentCount[cont] || 0) + 1;
  }

  // Continent pills
  const contPillsHtml = Object.entries(continentCount)
    .sort((a, b) => b[1] - a[1])
    .map(([cont, cnt]) => {
      const color = _CONTINENT_COLOR[cont] || '#0d9488';
      return `<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:700;background:${color}22;color:${color};border:1px solid ${color}44">${_CONTINENT_LABEL[cont]} <b>${cnt}</b></span>`;
    }).join('');

  // Collected-flags badges — one per visited country (round icon, click to focus the globe)
  const visitedPct = Math.round((visitedCount / 195) * 100);
  const badgesHtml = [...visitedMap.keys()]
    .sort((a, b) => (_A2_NAME[a] || a).localeCompare(_A2_NAME[b] || b))
    .map(code => {
      const color = _CONTINENT_COLOR[_A2_CONTINENT[code]] || '#0d9488';
      const name  = _A2_NAME[code] || code;
      const count = visitedMap.get(code);
      return `<button type="button" class="globe-badge" data-action="focus-country" data-code="${code}"
                style="border-color:${color}66" title="${_esc(name)} · ${count} voyage${count > 1 ? 's' : ''}">
                ${_flagImgHtml(code)}
              </button>`;
    }).join('');

  // Km
  const kmByMode = _calcKmByMode(trips);
  const MODE_META = {
    car:'🚗 Voiture', bus:'🚌 Bus/Taxi', bike:'🚲 Vélo',
    foot:'🚶 À pied', plane:'✈️ Avion', ferry:'⛴️ Bateau',
  };
  const totalKm = Object.values(kmByMode).reduce((a, b) => a + b, 0);
  const kmRows = Object.entries(kmByMode).sort((a, b) => b[1] - a[1]).map(([mode, dist]) => {
    const meta = MODE_META[mode] || '🚌 ' + mode;
    const pct  = totalKm > 0 ? Math.round((dist / totalKm) * 100) : 0;
    return `<div style="margin-bottom:9px">
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px">
        <span style="color:var(--ink2)">${meta}</span>
        <span style="font-weight:700;color:var(--ink)">${Math.round(dist).toLocaleString('fr-FR')} km</span>
      </div>
      <div style="background:var(--c3);border-radius:4px;height:7px;overflow:hidden">
        <div style="width:${pct}%;height:100%;background:var(--teal);border-radius:4px;transition:width .4s"></div>
      </div></div>`;
  }).join('');

  // Top destinations with bar
  const destCount = {};
  trips.forEach(t => { const d = (t.destination || '').trim(); if (d) destCount[d] = (destCount[d] || 0) + 1; });
  const topDests    = Object.entries(destCount).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const maxDestCnt  = topDests[0]?.[1] || 1;
  const topDestsHtml = topDests.length
    ? topDests.map(([dest, cnt]) => {
        const pct = Math.round((cnt / maxDestCnt) * 100);
        return `<div style="margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px">
            <span style="color:var(--ink2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:70%">${_esc(dest)}</span>
            <span style="font-weight:700;color:var(--teal);flex-shrink:0">${cnt}×</span>
          </div>
          <div style="background:var(--c3);border-radius:4px;height:5px;overflow:hidden">
            <div style="width:${pct}%;height:100%;background:var(--teal);border-radius:4px;transition:width .4s;opacity:.7"></div>
          </div></div>`;
      }).join('')
    : `<div style="font-size:12px;color:var(--ink4)">Aucune destination renseignée</div>`;

  // Per year bars
  const perYear = {};
  trips.forEach(t => { const y = (t.startDate || t.createdAt || '').slice(0, 4); if (y) perYear[y] = (perYear[y] || 0) + 1; });
  const years      = Object.keys(perYear).sort();
  const maxPerYear = Math.max(...Object.values(perYear), 1);
  const perYearBars = years.map(y => {
    const count = perYear[y];
    const barH  = Math.max(Math.round((count / maxPerYear) * 64), 8);
    return `<div style="display:flex;flex-direction:column;align-items:center;min-width:34px">
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:82px;gap:2px">
        <span style="font-size:10px;font-weight:800;color:var(--teal)">${count}</span>
        <div style="width:26px;background:var(--teal);border-radius:5px 5px 0 0;height:${barH}px;opacity:.8;transition:height .3s"></div>
      </div>
      <div style="font-size:9px;color:var(--ink4);white-space:nowrap;margin-top:3px">${y}</div>
    </div>`;
  }).join('');

  // Seasons
  const seasons = _calcSeasons(trips);
  const maxSeason = Math.max(...Object.values(seasons), 1);
  const seasonData = [
    { key:'spring', label:'Printemps', emoji:'🌸', color:'#16a34a' },
    { key:'summer', label:'Été',       emoji:'☀️', color:'#d97706' },
    { key:'autumn', label:'Automne',   emoji:'🍂', color:'#ea580c' },
    { key:'winter', label:'Hiver',     emoji:'❄️', color:'#0891b2' },
  ];
  const seasonBars = seasonData.map(({ key, label, emoji, color }) => {
    const cnt  = seasons[key];
    const barH = Math.max(Math.round((cnt / maxSeason) * 60), cnt > 0 ? 6 : 2);
    return `<div style="display:flex;flex-direction:column;align-items:center;flex:1">
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:78px;gap:2px">
        <span style="font-size:10px;font-weight:800;color:${cnt > 0 ? color : 'var(--ink4)'}">${cnt || '—'}</span>
        <div style="width:30px;border-radius:5px 5px 0 0;height:${barH}px;background:${color};opacity:${cnt > 0 ? .8 : .2};transition:height .3s"></div>
      </div>
      <div style="font-size:14px;line-height:1;margin-top:4px">${emoji}</div>
      <div style="font-size:9px;color:var(--ink4);text-align:center;white-space:nowrap">${label}</div>
    </div>`;
  }).join('');

  // Spending by month
  const spendByMonth = _calcSpendingByMonth(trips);
  const spendMonths  = Object.keys(spendByMonth).sort().slice(-12);
  const maxSpend     = Math.max(...spendMonths.map(m => spendByMonth[m]), 1);
  const avgSpendDay  = s.totalDays > 0 ? Math.round(s.totalSpent / s.totalDays) : 0;
  const spendBars = spendMonths.map(m => {
    const val  = spendByMonth[m];
    const barH = Math.max(Math.round((val / maxSpend) * 72), 4);
    const [yr, mo] = m.split('-');
    const label = new Date(Number(yr), Number(mo) - 1, 1).toLocaleDateString('fr-FR', { month: 'short' }) + ' \'' + yr.slice(2);
    return `<div style="display:flex;flex-direction:column;align-items:center;min-width:26px">
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:88px;gap:2px">
        <span style="font-size:8px;font-weight:700;color:var(--ink3)">${Math.round(val)}</span>
        <div style="width:20px;background:var(--amb);border-radius:3px 3px 0 0;height:${barH}px;opacity:.85"></div>
      </div>
      <div style="font-size:7px;color:var(--ink4);writing-mode:vertical-rl;transform:rotate(180deg);white-space:nowrap;margin-top:3px">${label}</div>
    </div>`;
  }).join('');

  // Expenses by category (across all filtered trips)
  const catExpenses = {};
  for (const trip of trips) {
    const catMap = new Map((trip.budgetCats || []).map(c => [c.id, c]));
    for (const exp of (trip.realExpenses || [])) {
      if (exp.type === 'transfer') continue;
      const amt = Number(exp.amount) || 0;
      if (!amt) continue;
      const cat   = catMap.get(exp.catId);
      const name  = cat?.name  || 'Autre';
      const color = cat?.color || '#6b7280';
      const icon  = cat?.icon  || '💡';
      if (!catExpenses[name]) catExpenses[name] = { total: 0, color, icon };
      catExpenses[name].total += amt;
    }
  }
  const catTotal   = Object.values(catExpenses).reduce((s, v) => s + v.total, 0);
  const catEntries = Object.entries(catExpenses).sort((a, b) => b[1].total - a[1].total).slice(0, 8);

  // Companions statistics
  const compMap = {};
  for (const trip of trips) {
    const tripDays = trip.startDate && trip.endDate
      ? Math.round((new Date(trip.endDate + 'T12:00:00') - new Date(trip.startDate + 'T12:00:00')) / 86400000) + 1
      : 0;
    for (const comp of (trip.companions || [])) {
      const nm = comp.name || 'Inconnu';
      if (!compMap[nm]) compMap[nm] = { trips: 0, days: 0, color: comp.color || '#0d9488' };
      compMap[nm].trips++;
      compMap[nm].days += tripDays;
    }
  }
  const compEntries = Object.entries(compMap).sort((a, b) => b[1].trips - a[1].trips).slice(0, 8);

  // KPI tiles
  const kpis = [
    { icon:'✈️', val: trips.length,                                       lbl:'Voyages' },
    { icon:'📅', val: s.totalDays,                                        lbl:'Jours voyagés' },
    { icon:'🌍', val: visitedCount,                                       lbl:'Pays visités' },
    { icon:'📏', val: avgDays > 0 ? avgDays + ' j' : '—',                lbl:'Durée moy.' },
    ...(totalKm > 0 ? [{ icon:'🛣️', val: Math.round(totalKm).toLocaleString('fr-FR') + ' km', lbl:'Distance estimée' }] : []),
    ...(s.totalSpent > 0 ? [{ icon:'💶', val: Math.round(s.totalSpent).toLocaleString('fr-FR') + ' €', lbl:'Total dépensé' }] : []),
    ...(avgSpendDay > 0 ? [{ icon:'📊', val: avgSpendDay + ' €/j',        lbl:'Moy. par jour' }] : []),
    ...(longestTrip ? [{ icon:'🏆', val: longestDays + ' j',             lbl:'Voyage + long' }] : []),
  ];
  const kpiHtml = kpis.map(k => `
    <div class="stat-kpi-tile">
      <div class="stat-kpi-icon">${k.icon}</div>
      <div class="stat-kpi-val">${k.val}</div>
      <div class="stat-kpi-lbl">${k.lbl}</div>
    </div>`).join('');

  return `
    <div class="stats-wrap">
      <div style="font-size:10px;color:var(--ink4);margin-bottom:14px">
        📊 Statistiques sur <strong>${trips.length}</strong> voyage${trips.length > 1 ? 's' : ''} réalisé${trips.length > 1 ? 's' : ''}
      </div>

      <!-- KPI grid -->
      <div class="stat-kpi-grid">${kpiHtml}</div>

      <!-- World globe — full width, first -->
      <div id="world-map-wrap" class="stat-card" style="margin-bottom:14px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;flex-wrap:wrap;gap:8px">
          <div style="display:flex;align-items:center;gap:8px">
            <h4 class="stat-card-title" style="margin-bottom:0">🌍 Pays visités</h4>
            <button id="wm-expand-btn" title="Plein écran">⛶ Plein écran</button>
          </div>
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">${contPillsHtml}</div>
        </div>

        <div class="globe-wrap">
          <div class="globe-stage">
            <canvas id="globe-canvas" class="globe-canvas" aria-label="Globe des pays visités"></canvas>
            <div class="globe-markers"></div>
          </div>
        </div>
        <div style="text-align:center;font-size:10px;color:var(--ink4);margin-top:2px">glisser pour tourner · molette/pincer pour zoomer</div>

        <div class="globe-stats">
          <div><div class="globe-stat-val">${visitedCount}</div><div class="globe-stat-lbl">pays visités</div></div>
          <div><div class="globe-stat-val">${visitedPct}%</div><div class="globe-stat-lbl">du monde (~195 pays)</div></div>
        </div>

        ${badgesHtml ? `
        <div class="globe-flags-section">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px">
            <h5 class="globe-flags-title">🏅 Drapeaux collectés</h5>
            <div id="globe-country-label" class="globe-country-label" style="display:none"></div>
          </div>
          <div class="globe-badges" id="globe-badges">${badgesHtml}</div>
        </div>` : ''}
      </div>

      <!-- Row 2: par année + saisons -->
      <div class="stat-grid-2" style="margin-bottom:14px">
        <div class="stat-card">
          <h4 class="stat-card-title">📅 Voyages par année</h4>
          ${years.length > 0
            ? `<div style="display:flex;gap:5px;overflow-x:auto">${perYearBars}</div>`
            : `<div style="font-size:12px;color:var(--ink4)">Aucune date renseignée</div>`}
        </div>
        <div class="stat-card">
          <h4 class="stat-card-title">🌸 Saisons préférées</h4>
          <div style="display:flex;justify-content:space-around;gap:4px">${seasonBars}</div>
        </div>
      </div>

      <!-- Row 3: top destinations + distances -->
      <div class="stat-grid-2" style="margin-bottom:14px">
        <div class="stat-card">
          <h4 class="stat-card-title">🏆 Top destinations</h4>
          ${topDestsHtml}
        </div>
        ${totalKm > 0 ? `
        <div class="stat-card">
          <h4 class="stat-card-title">🛣️ Distances par mode</h4>
          ${kmRows}
          <div style="font-size:10px;color:var(--ink4);margin-top:6px">Total estimé : ${Math.round(totalKm).toLocaleString('fr-FR')} km</div>
        </div>` : ''}
      </div>

      <!-- Row 4: spending by month -->
      ${spendMonths.length > 0 ? `
      <div class="stat-card" style="margin-bottom:14px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <h4 class="stat-card-title" style="margin-bottom:0">💶 Dépenses par mois</h4>
          ${avgSpendDay > 0 ? `<span style="font-size:11px;color:var(--ink4)">moy. <b style="color:var(--amb)">${avgSpendDay} €/j</b></span>` : ''}
        </div>
        <div style="display:flex;gap:3px;overflow-x:auto">${spendBars}</div>
        <div style="font-size:10px;color:var(--ink4);margin-top:4px">Total : <b>${Math.round(s.totalSpent).toLocaleString('fr-FR')} €</b></div>
      </div>` : ''}

      <!-- Row 5: expenses by category + companions -->
      ${catEntries.length > 0 || compEntries.length > 0 ? `
      <div class="stat-grid-2" style="margin-bottom:14px">
        ${catEntries.length > 0 ? `
        <div class="stat-card">
          <h4 class="stat-card-title">💳 Dépenses par catégorie</h4>
          ${catEntries.map(([name, {total, color, icon}]) => {
            const pct = catTotal > 0 ? Math.round((total / catTotal) * 100) : 0;
            return `<div style="margin-bottom:8px">
              <div style="display:flex;justify-content:space-between;align-items:baseline;font-size:12px;margin-bottom:3px">
                <span style="color:var(--ink2)">${icon} ${_esc(name)}</span>
                <span style="font-weight:700;color:var(--ink);flex-shrink:0;white-space:nowrap">${Math.round(total).toLocaleString('fr-FR')} €<span style="font-size:10px;color:var(--ink4);font-weight:400"> (${pct}%)</span></span>
              </div>
              <div style="background:var(--c3);border-radius:4px;height:7px;overflow:hidden">
                <div style="width:${pct}%;height:100%;background:${color};border-radius:4px;transition:width .4s"></div>
              </div></div>`;
          }).join('')}
          <div style="font-size:10px;color:var(--ink4);margin-top:6px">Total : <b>${Math.round(catTotal).toLocaleString('fr-FR')} €</b></div>
        </div>` : '<div></div>'}
        ${compEntries.length > 0 ? `
        <div class="stat-card">
          <h4 class="stat-card-title">👥 Compagnons de voyage</h4>
          ${compEntries.map(([name, {trips: tc, days, color}]) => {
            const initials = name.trim().split(/\s+/).map(p => p[0] || '').slice(0, 2).join('').toUpperCase();
            return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
              <div style="width:32px;height:32px;border-radius:50%;background:${color};display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;flex-shrink:0">${_esc(initials || '?')}</div>
              <div style="flex:1;min-width:0">
                <div style="font-size:13px;font-weight:700;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_esc(name)}</div>
                <div style="font-size:11px;color:var(--ink3)">${tc} voyage${tc > 1 ? 's' : ''} · ${days} jour${days > 1 ? 's' : ''}</div>
              </div>
            </div>`;
          }).join('')}
        </div>` : '<div></div>'}
      </div>` : ''}
    </div>
  `;
}

// ── Hero HTML ──────────────────────────────────────────────────────────────────

function _heroHtml(trips) {
  const s = _calcStats(trips);
  const user = getCurrentUser();
  const isStandalone = window.matchMedia('(display-mode:standalone)').matches || !!navigator.standalone;
  const userHtml = user ? `
    <div class="user-pill">
      ${user.photoURL ? `<img src="${_esc(user.photoURL)}" class="user-av" referrerpolicy="no-referrer">` : ''}
      <span class="user-nm">${_esc(user.displayName || user.email || '')}</span>
      <button data-action="logout" class="logout-btn">Déconnexion</button>
    </div>
  ` : '';
  const installBtn = !isStandalone
    ? `<button class="btn-new hero-btn-install" data-action="pwa-install" title="Installer l'application">📲 Installer</button>`
    : '';
  return `
    <div class="hero">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%">
        <div>
          <div class="hero-logo">Carnet de Voyages <span style="font-size:11px;font-weight:400;opacity:.4;margin-left:3px">v${APP_VERSION}</span></div>
          <div class="hero-sub">Planifiez, organisez et vivez vos aventures</div>
        </div>
        <div class="hero-nav-group">
          ${userHtml}
          <button class="btn-new" data-action="show-stats" title="Statistiques" style="padding:6px 10px;font-size:14px;line-height:1.2">📊 <span class="btn-label">Statistiques</span></button>
          <button class="btn-new" data-action="open-mymap" title="Mes destinations" style="padding:6px 10px;font-size:14px;line-height:1.2">🗺 <span class="btn-label">Mes destinations</span></button>
          <button class="btn-new" data-action="open-settings" title="Paramètres" style="padding:6px 10px;font-size:14px;line-height:1.2">⚙️ <span class="btn-label">Paramètres</span></button>
        </div>
      </div>
      <div class="hero-secondary-actions">
        <button class="btn-new hero-btn-import" data-action="open-import" title="Importer KML/CSV">⬆ Importer</button>
        <button class="btn-new hero-btn-export" data-action="export-all" title="Exporter tous les voyages en CSV">⬇ Exporter</button>
        ${installBtn}
      </div>
      <div class="hero-row2">
        <div class="hero-stats">
          <div class="hs-card">
            <div class="hs-v">${s.voyageCount}</div>
            <div class="hs-l">Voyages</div>
          </div>
          <div class="hs-card">
            <div class="hs-v">${s.weekendCount}</div>
            <div class="hs-l">Week-ends</div>
          </div>
          <div class="hs-card">
            <div class="hs-v">${s.sortieCount}</div>
            <div class="hs-l">Sorties</div>
          </div>
          <div class="hs-card">
            <div class="hs-v">${s.totalDays}</div>
            <div class="hs-l">Jours</div>
          </div>
          <div class="hs-card">
            <div class="hs-v">${s.countries}</div>
            <div class="hs-l">Destinations</div>
          </div>
        </div>
        <input id="global-search" type="search" placeholder="🔍 Rechercher…" class="hero-search-input" autocomplete="off">
      </div>
    </div>
  `;
}

// ── Filter tabs HTML ───────────────────────────────────────────────────────────

function _filterTabsHtml(activeFilter, activeTab) {
  const tabs = [
    { key: 'all',     label: 'Tous' },
    { key: 'voyage',  label: '✈️ Voyages' },
    { key: 'weekend', label: '🌿 Week-ends' },
    { key: 'sortie',  label: '📍 Sorties' },
  ];
  if (activeTab === 'stats') {
    const filterBtns = tabs.map(t =>
      `<button class="filter-tab${_statsTypeFilter === t.key ? ' active' : ''}"
               data-stats-type="${t.key}">${t.label}</button>`
    ).join('');
    return `<div class="filter-tabs">
      <button class="filter-tab" data-action="go-home">🏠 Accueil</button>
      ${filterBtns}
    </div>`;
  }
  const filterBtns = tabs.map(t =>
    `<button class="filter-tab${activeFilter === t.key ? ' active' : ''}"
             data-action="filter" data-filter="${t.key}">${t.label}</button>`
  ).join('');
  return `<div class="filter-tabs">${filterBtns}</div>`;
}

// ── Sortie card HTML ───────────────────────────────────────────────────────────

function _sortieCardHtml(trip) {
  const pin        = trip.pin || {};
  const eventTypes = getEventTypes();
  const et         = eventTypes.find(e => e.key === (pin.pinType || 'visit')) || eventTypes[0];

  const _sd = pin.date || trip.startDate;
  const _ed = pin.endDate || (trip.endDate !== trip.startDate ? trip.endDate : null);
  const dateStr = !_sd
    ? 'Date non définie'
    : (_ed && _ed !== _sd)
      ? `${fmtDateShort(_sd)} – ${fmtDate(_ed)}`
      : new Date(_sd + 'T12:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });

  const preview = (pin.description || '').slice(0, 80) + ((pin.description || '').length > 80 ? '…' : '');

  let thumbHtml;
  if (trip.photo) {
    thumbHtml = `
      <img class="tc-img sortie-thumb-img" src="${_esc(trip.photo)}" alt=""
           loading="lazy"
           onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
      <div class="sortie-thumb" style="background:${et.color};display:none">${et.emoji}</div>
    `;
  } else {
    thumbHtml = `<div class="sortie-thumb" style="background:${et.color}">${et.emoji}</div>`;
  }

  return `
    <div class="trip-card sortie-card" data-action="open-trip" data-trip-id="${trip.id}">
      <div style="position:relative">${thumbHtml}</div>
      <div class="tc-body">
        <div class="tc-header">
          <div>${typeBadge(trip.type)}</div>
          <div style="display:flex;gap:3px">
            <button class="tc-edit-btn" data-action="edit-trip" data-trip-id="${trip.id}" title="Modifier">✎</button>
            <button class="tc-more-btn" data-action="trip-menu" data-trip-id="${trip.id}" title="Plus d'options">⋯</button>
          </div>
        </div>
        <div class="tc-title">${_esc(trip.name || 'Sortie')}</div>
        <div class="tc-dates">
          ${dateStr}${pin.time ? ' · ' + pin.time : ''}
          ${trip.destination ? `<br><span style="color:var(--ink3)">📍 ${_esc(trip.destination)}</span>` : ''}
        </div>
        ${preview ? `<div class="sortie-card-desc">${_esc(preview)}</div>` : ''}
        <div class="tc-stats" style="margin-top:6px">
          ${pin.weather ? `<span class="tc-s">${pin.weather}</span>` : ''}
          ${pin.cost ? `<span class="tc-s">💶 ${Number(pin.cost).toLocaleString('fr-FR', { minimumFractionDigits: 2 })} EUR</span>` : ''}
        </div>
        ${(trip.companions || []).length > 0 ? `
        <div style="display:flex;align-items:center;gap:3px;margin-top:5px;flex-wrap:wrap">
          ${(trip.companions).slice(0, 4).map((c, i) => `<div class="comp-avatar" style="background:${c.color || _compColor(i)}" title="${_esc(c.name)}">${_initials(c.name)}</div>`).join('')}
          ${trip.companions.length > 4 ? `<span style="font-size:10px;color:var(--ink4);font-weight:700">+${trip.companions.length - 4}</span>` : ''}
        </div>` : ''}
      </div>
    </div>
  `;
}

// ── Observed (shared) trip card — read-only for the observer ──────────────────

function _observedTripCardHtml(trip) {
  let imgHtml;
  if (trip.photo) {
    imgHtml = `
      <img class="tc-img" src="${_esc(trip.photo)}" alt=""
           loading="lazy"
           onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
      <div class="tc-img-ph" style="background:${trip.color || '#0d9488'};display:none">${trip.flag || '🌍'}</div>
    `;
  } else {
    imgHtml = `<div class="tc-img-ph" style="background:${trip.color || '#0d9488'}">${trip.flag || '🌍'}</div>`;
  }

  let dateStr = 'Dates non définies';
  if (trip.startDate && trip.endDate) {
    dateStr = `${fmtDateShort(trip.startDate)} → ${fmtDate(trip.endDate)}`;
  } else if (trip.startDate) {
    dateStr = `Dès ${fmtDate(trip.startDate)}`;
  }

  // Find owner names from shared doc. Observers are deliberately excluded from
  // this "who's actually on the trip" list (an observer is a spectator, not a
  // traveler) — their presence is only ever surfaced as a headcount below,
  // never by name here.
  let ownerHtml = '';
  const sharedDoc = getSharedDocData(trip.id);
  if (sharedDoc?.members) {
    const members = Object.values(sharedDoc.members);
    const owners  = members
      .filter(m => m.role === 'owner' || m.role === 'member')
      .map(m => m.companionName).filter(Boolean);
    const obsCount = members.filter(m => m.role === 'observer').length;
    if (owners.length > 0) {
      const names = owners.length === 1 ? owners[0]
        : owners.slice(0, -1).join(', ') + ' et ' + owners[owners.length - 1];
      ownerHtml = `<div class="tc-owner">✈️ ${_esc(names)}</div>`;
    }
    if (obsCount > 0) {
      ownerHtml += `<div class="tc-owner" style="opacity:.7">👁 ${obsCount} observateur${obsCount > 1 ? 's' : ''}</div>`;
    }
  }

  return `
    <div class="trip-card obs-trip-card" data-action="open-trip" data-trip-id="${trip.id}">
      <div style="position:relative">${imgHtml}</div>
      <div class="tc-body">
        <div class="tc-header">
          <div>${typeBadge(trip.type)}</div>
          <div style="display:flex;align-items:center;gap:6px">
            <span class="obs-card-badge">👁 Observation</span>
            <button class="obs-leave-card-btn"
                    data-action="leave-trip"
                    data-trip-id="${trip.id}"
                    title="Quitter ce voyage">✕ Quitter</button>
          </div>
        </div>
        <div class="tc-title">${trip.flag || '🌍'} ${_esc(trip.name || 'Voyage')}</div>
        <div class="tc-dates">${dateStr}</div>
        ${ownerHtml}
      </div>
    </div>
  `;
}

// ── Trip card HTML ─────────────────────────────────────────────────────────────

function _tripCardHtml(trip) {
  if (trip.type === 'sortie') return _sortieCardHtml(trip);

  // Photo or colored emoji placeholder
  let imgHtml;
  if (trip.photo) {
    imgHtml = `
      <img class="tc-img" src="${_esc(trip.photo)}" alt=""
           loading="lazy"
           onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
      <div class="tc-img-ph" style="background:${trip.color || '#0d9488'};display:none">${trip.flag || '🌍'}</div>
    `;
  } else {
    imgHtml = `<div class="tc-img-ph" style="background:${trip.color || '#0d9488'}">${trip.flag || '🌍'}</div>`;
  }

  // Date range
  let dateStr = 'Dates à définir';
  if (trip.startDate && trip.endDate) {
    dateStr = `${fmtDateShort(trip.startDate)} → ${fmtDate(trip.endDate)}`;
  } else if (trip.startDate) {
    dateStr = `Dès ${fmtDate(trip.startDate)}`;
  }

  // Companions
  const comps = trip.companions || [];
  let compsHtml;
  if (comps.length === 0) {
    compsHtml = `<span style="font-size:11px;color:var(--ink4);font-weight:600">Solo</span>`;
  } else {
    const shown = comps.slice(0, 4);
    compsHtml = shown.map((c, i) => {
      const bg = c.color || _compColor(i);
      return `<div class="comp-avatar" style="background:${bg}" title="${_esc(c.name)}">${_initials(c.name)}</div>`;
    }).join('');
    if (comps.length > 4) {
      compsHtml += `<span style="font-size:10px;color:var(--ink4);font-weight:700">+${comps.length - 4}</span>`;
    }
  }

  // Stats
  const stats = [];
  if (trip.startDate && trip.endDate) {
    const days = Math.round(
      (new Date(trip.endDate + 'T12:00:00') - new Date(trip.startDate + 'T12:00:00')) / 86400000
    ) + 1;
    if (days > 0) stats.push(`${days} jour${days > 1 ? 's' : ''}`);
  }
  if (Array.isArray(trip.realExpenses) && trip.realExpenses.length > 0) {
    const spent = trip.realExpenses.reduce((s, e) => s + (e.type !== 'transfer' ? (Number(e.amount) || 0) : 0), 0);
    if (spent > 0) stats.push(`${Math.round(spent).toLocaleString('fr-FR')} €`);
  }
  const statsHtml = stats.length
    ? `<div class="tc-stats">${stats.map(s => `<span class="tc-s">${s}</span>`).join('')}</div>`
    : '';

  // Status badge — overlaid on image top-right
  const isDone      = (trip.status || 'done') === 'done';
  const badgeBg     = isDone ? 'rgba(22,163,74,0.88)' : 'rgba(2,132,199,0.88)';
  const badgeIcon   = isDone ? '☑' : '☐';
  const badgeLabel  = isDone ? 'Réalisé' : 'En planification';
  const statusBadgeHtml = `<div
    data-action="toggle-status"
    data-trip-id="${trip.id}"
    style="position:absolute;top:8px;right:8px;z-index:2;cursor:pointer;background:${badgeBg};color:#fff;border-radius:999px;padding:3px 9px;font-size:10px;font-weight:700;display:flex;align-items:center;gap:4px;border:1.5px solid rgba(255,255,255,0.5);box-shadow:0 1px 4px rgba(0,0,0,.25);white-space:nowrap"
  ><span style="font-size:12px;line-height:1">${badgeIcon}</span>${badgeLabel}</div>`;

  return `
    <div class="trip-card" data-action="open-trip" data-trip-id="${trip.id}">
      <div style="position:relative">${imgHtml}${statusBadgeHtml}</div>
      <div class="tc-body">
        <div class="tc-header">
          <div>${typeBadge(trip.type)}</div>
          <div style="display:flex;gap:4px">
            <button class="tc-share-btn"
                    data-action="share-trip"
                    data-trip-id="${trip.id}"
                    title="Partager">🔗</button>
            <button class="tc-edit-btn"
                    data-action="edit-trip"
                    data-trip-id="${trip.id}"
                    title="Modifier">✎</button>
            <button class="tc-more-btn"
                    data-action="trip-menu"
                    data-trip-id="${trip.id}"
                    title="Plus d'options">⋯</button>
          </div>
        </div>
        <div class="tc-title">${trip.flag || '🌍'} ${_esc(trip.name) || 'Sans titre'}</div>
        <div class="tc-dates">${dateStr}</div>
        <div class="tc-companions">${compsHtml}</div>
        ${statsHtml}
      </div>
    </div>
  `;
}

function _addCardHtml() {
  return `
    <div class="trip-card tc-add" data-action="new-trip">
      <div class="ai">＋</div>
      <span>Nouveau voyage</span>
    </div>
  `;
}

// ── Live feed helpers ─────────────────────────────────────────────────────────

function _liveGpxSlide(item) {
  const s = item.gpxStats;
  if (!s) return null;
  const distKm = s.distanceM >= 1000 ? (s.distanceM / 1000).toFixed(1) + ' km' : s.distanceM + ' m';
  let dur = '';
  if (s.durationSecs) {
    const h = Math.floor(s.durationSecs / 3600);
    const m = Math.floor((s.durationSecs % 3600) / 60);
    dur = h > 0 ? `${h}h${m.toString().padStart(2, '0')}` : `${m} min`;
  }
  const stats = [
    { v: distKm,                         l: 'Distance' },
    s.elevGain  ? { v: `+${s.elevGain} m`,   l: 'Dénivelé +' }  : null,
    s.elevLoss  ? { v: `-${s.elevLoss} m`,   l: 'Dénivelé −' }  : null,
    dur         ? { v: dur,                   l: 'Durée' }       : null,
    s.speedAvgKph != null ? { v: `${s.speedAvgKph} km/h`, l: 'Vitesse moy.' } : null,
  ].filter(Boolean);
  return `<div class="tl-gpx-card">
    <div class="tl-gpx-icon">🥾</div>
    <div class="tl-gpx-name">${_esc(item.text || '')}</div>
    <div class="tl-gpx-stats">${stats.map(st =>
      `<div class="tl-gpx-stat"><span>${_esc(st.v)}</span><small>${_esc(st.l)}</small></div>`
    ).join('')}</div>
  </div>`;
}

function _liveCarouselHtml(slides, carId) {
  if (slides.length === 0) return '';
  const arrows = slides.length > 1 ? `
    <button class="tl-car-prev" data-car-nav="prev" data-car-id="${_esc(carId)}" aria-label="Précédente">❮</button>
    <button class="tl-car-next" data-car-nav="next" data-car-id="${_esc(carId)}" aria-label="Suivante">❯</button>` : '';
  const dots = slides.length > 1
    ? `<div class="tl-car-dots">${slides.map((_, i) =>
        `<div class="tl-dot${i === 0 ? ' active' : ''}"></div>`).join('')}</div>`
    : '';
  return `<div class="tl-carousel" data-car-id="${_esc(carId)}">
    <div class="tl-car-track" data-car-track="${_esc(carId)}">
      ${slides.map(s => `<div class="tl-car-slide">${s}</div>`).join('')}
    </div>
    ${arrows}
    ${dots}
  </div>`;
}

function _initHomeCarousels(el) {
  el.querySelectorAll('[data-car-track]').forEach(track => {
    const carEl = track.closest('[data-car-id]');
    const dots  = carEl?.querySelectorAll('.tl-dot');
    const updateDots = () => {
      if (!dots || dots.length < 2) return;
      const idx = Math.round(track.scrollLeft / track.clientWidth);
      dots.forEach((d, i) => d.classList.toggle('active', i === idx));
    };
    track.addEventListener('scroll', updateDots, { passive: true });
    carEl?.querySelectorAll('[data-car-nav]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const dir = btn.dataset.carNav === 'prev' ? -1 : 1;
        const idx = Math.round(track.scrollLeft / track.clientWidth);
        track.scrollTo({ left: (idx + dir) * track.clientWidth, behavior: 'smooth' });
      });
    });
  });
}

// ── Live feed (En direct) ──────────────────────────────────────────────────────

function _lvLastSeenKey() {
  const u = getCurrentUser()?.uid;
  return u ? `_lvLastSeen_${u}` : '_lvLastSeen';
}
function _lvMarkSeen() {
  localStorage.setItem(_lvLastSeenKey(), new Date().toISOString());
}
function _lvUnreadCount(observingTrips) {
  const lastSeen = localStorage.getItem(_lvLastSeenKey());
  if (!lastSeen) return 0;
  let count = 0;
  for (const trip of observingTrips) {
    for (const day of (trip.days || [])) {
      for (const item of (day.items || [])) {
        const ts = item.journalData?.validatedAt;
        if (item.journalData?.validated && ts && ts > lastSeen) count++;
      }
    }
  }
  return count;
}

function _buildLiveFeedHtml(observingTrips) {
  const posts = [];
  for (const trip of observingTrips) {
    for (const day of (trip.days || [])) {
      for (const item of (day.items || [])) {
        if (item.journalData?.validated) {
          posts.push({ trip, day, item, ts: item.journalData.validatedAt || 0 });
        }
      }
    }
  }
  posts.sort((a, b) => {
    const ta = a.ts ? new Date(a.ts).getTime() : 0;
    const tb = b.ts ? new Date(b.ts).getTime() : 0;
    return tb - ta;
  });

  if (posts.length === 0) {
    return `<div style="text-align:center;padding:50px 20px;color:var(--ink4)">
      <div style="font-size:44px;margin-bottom:12px">📡</div>
      <div style="font-size:15px;font-weight:600;color:var(--ink3)">Aucune publication pour l'instant</div>
      <div style="font-size:12px;margin-top:6px">Les voyageurs publieront leurs aventures au fil du voyage</div>
    </div>`;
  }

  return posts.map(({ trip, day, item }, idx) => {
    const jd     = item.journalData;
    const photos = jd.photos || [];
    const ts     = jd.validatedAt;
    const dateStr = ts
      ? new Date(ts).toLocaleDateString('fr-FR', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' })
      : '';

    // Build carousel: GPX card first (if trace), then photos
    const slides = [];
    if (item.gpxStats) {
      const gpx = _liveGpxSlide(item);
      if (gpx) slides.push(gpx);
    }
    photos.forEach(src => {
      slides.push(`<img src="${_esc(src)}" loading="lazy" onclick="window._pho && window._pho(this.src)">`);
    });
    const carousel = _liveCarouselHtml(slides, 'lv_' + (item.id || idx));

    // Traveler names: combine Firebase member names + trip companion names (deduplicated)
    const sharedDoc  = getSharedDocData(trip.id);
    const currentUid = getCurrentUser()?.uid || null;
    const _membersNames   = Object.values(sharedDoc?.members || {}).filter(m => m.role !== 'observer').map(m => m.companionName).filter(Boolean);
    const _companionNames = (trip.companions || []).map(c => c.name).filter(Boolean);
    const _allNamesSet    = new Set([..._membersNames, ..._companionNames]);
    const travelerNames   = _allNamesSet.size > 0 ? [..._allNamesSet].slice(0, 4).join(', ') : null;

    // Interactions (likes + comments) for this post
    let interactionsHtml = '';
    if (sharedDoc && item.id) {
      const itemReactions   = sharedDoc.reactions?.[item.id] || {};
      const allComments     = sharedDoc.observerComments || {};
      const itemComments    = Object.values(allComments).filter(c => c.itemId === item.id);
      const heartCount      = Object.values(itemReactions).filter(e => e === '❤️').length;
      const commentCount    = itemComments.length;
      const myReacted       = currentUid ? itemReactions[currentUid] === '❤️' : false;
      const isOwnerOrMember = currentUid && (sharedDoc.members?.[currentUid]?.role === 'owner' || sharedDoc.members?.[currentUid]?.role === 'member');

      let reactorChips = '';
      if (heartCount > 0) {
        const reactors = Object.entries(itemReactions).filter(([, v]) => v === '❤️');
        reactorChips = reactors.map(([uid]) => {
          const name   = sharedDoc.members?.[uid]?.companionName || '?';
          const delBtn = isOwnerOrMember
            ? `<button class="tl-reactor-del" data-action="lv-remove-reaction" data-trip-id="${_esc(trip.id)}" data-item-id="${_esc(item.id)}" data-target-uid="${_esc(uid)}" title="Retirer">×</button>`
            : '';
          return `<span class="tl-reactor-chip${uid === currentUid ? ' mine' : ''}">❤️ ${_esc(name)}${delBtn}</span>`;
        }).join('');
      }

      interactionsHtml = `
        <div class="tl-interactions" style="padding:6px 14px 10px">
          <button class="tl-react-btn${myReacted ? ' reacted' : ''}"
                  data-action="lv-toggle-reaction" data-trip-id="${_esc(trip.id)}" data-item-id="${_esc(item.id)}">
            ❤️${heartCount > 0 ? `<span class="tl-react-count">${heartCount}</span>` : ''}
          </button>
          ${reactorChips ? `<div class="tl-reactor-list">${reactorChips}</div>` : ''}
          <button class="tl-comment-open-btn"
                  data-action="lv-open-comments"
                  data-trip-id="${_esc(trip.id)}"
                  data-item-id="${_esc(item.id)}"
                  data-item-text="${_esc(item.text || '')}">
            💬${commentCount > 0 ? `<span class="tl-react-count">${commentCount}</span>` : ''}
          </button>
        </div>`;
    }

    return `<div class="live-post">
      <div class="live-post-hd">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:3px">
          <div class="live-post-badge" style="background:${trip.color||'#0d9488'};margin-bottom:0">${trip.flag||'🌍'} <span>${_esc(trip.name)}</span></div>
          ${dateStr ? `<div class="live-post-time">${dateStr}</div>` : ''}
        </div>
        ${travelerNames ? `<div class="live-post-travelers">🧳 ${_esc(travelerNames)}</div>` : ''}
        <div class="live-post-day">Jour ${day.num}${customDayTitle(day) ? ' · ' + _esc(customDayTitle(day)) : ''}</div>
        ${item.text ? `<div style="font-size:13px;font-weight:600;color:var(--ink);margin-top:3px">${_esc(item.text)}</div>` : ''}
      </div>
      ${carousel}
      ${jd.notes ? `<div class="live-post-notes">${_esc(jd.notes).replace(/\n/g,'<br>')}</div>` : ''}
      ${interactionsHtml}
    </div>`;
  }).join('');
}

function _openLiveCommentsModal(tripId, itemId, itemText) {
  const sharedDoc    = getSharedDocData(tripId);
  if (!sharedDoc) return;
  const currentUid   = getCurrentUser()?.uid;
  const allComments  = sharedDoc.observerComments || {};
  const itemComments = Object.entries(allComments)
    .filter(([, c]) => c.itemId === itemId)
    .sort(([, a], [, b]) => (a.ts || '').localeCompare(b.ts || ''));

  function _buildList() {
    if (itemComments.length === 0) {
      return `<div style="font-size:12px;color:var(--ink4);padding:8px 0;text-align:center">Aucun commentaire pour le moment</div>`;
    }
    return itemComments.map(([cid, c]) => {
      const dateLabel = new Date(c.ts).toLocaleString('fr-FR', {
        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
      });
      const myRole    = sharedDoc.members?.[currentUid]?.role;
      const canDelete = c.uid === currentUid || myRole === 'owner' || myRole === 'member';
      return `
        <div class="tl-comment-item">
          <div class="tl-comment-header">
            <span class="tl-comment-author">${_esc(c.name)}</span>
            <span class="tl-comment-date">${dateLabel}</span>
            ${canDelete ? `<button class="tl-comment-del" data-action="lv-delete-comment" data-trip-id="${_esc(tripId)}" data-cid="${_esc(cid)}" title="Supprimer">🗑</button>` : ''}
          </div>
          <div class="tl-comment-text">${_esc(c.text)}</div>
        </div>`;
    }).join('');
  }

  showModal(`
    <button class="mc" onclick="closeModal()">✕</button>
    <h3 style="font-family:var(--sf);font-size:15px;font-weight:700;margin-bottom:4px">💬 Commentaires</h3>
    <div style="font-size:12px;color:var(--ink3);margin-bottom:12px;padding:6px 10px;background:var(--c2);border-radius:7px;border:1px solid var(--c3)">${_esc(itemText || '—')}</div>
    <div id="lv-cmt-list" style="max-height:220px;overflow-y:auto;margin-bottom:4px">${_buildList()}</div>
    <div style="display:flex;gap:8px;margin-top:10px">
      <input type="text" id="lv-cmt-input" placeholder="Votre commentaire…"
             style="flex:1;padding:7px 10px;border:1.5px solid var(--c3);border-radius:7px;font-size:12px;background:var(--c);color:var(--ink)"
             maxlength="300">
      <button id="lv-cmt-send" class="bs" style="padding:7px 14px;font-size:12px;flex-shrink:0">Envoyer</button>
    </div>
    <div class="ma" style="margin-top:10px">
      <button class="bc" onclick="closeModal()">Fermer</button>
    </div>`);

  const sendBtn = document.getElementById('lv-cmt-send');
  const input   = document.getElementById('lv-cmt-input');

  async function _doSend() {
    const text = input?.value?.trim();
    if (!text) return;
    try {
      await addObserverComment(tripId, itemId, text);
      if (input) input.value = '';
      const list = document.getElementById('lv-cmt-list');
      const newList = document.createElement('div');
      newList.innerHTML = _buildList();
      if (list) list.replaceWith(newList);
      newList.id = 'lv-cmt-list';
    } catch (e) {
      notify('Erreur lors de l\'envoi', '⚠️');
    }
  }

  sendBtn?.addEventListener('click', _doSend);
  input?.addEventListener('keydown', e => { if (e.key === 'Enter') _doSend(); });

  document.getElementById('lv-cmt-list')?.addEventListener('click', async e => {
    const btn = e.target.closest('[data-action="lv-delete-comment"]');
    if (!btn) return;
    const cid    = btn.dataset.cid;
    const tId    = btn.dataset.tripId;
    if (!cid || !tId) return;
    try {
      await deleteObserverComment(tId, cid);
      btn.closest('.tl-comment-item')?.remove();
    } catch (_) {}
  });
}

// ── Render home ────────────────────────────────────────────────────────────────

export function renderHome(filter = _currentFilter) {
  _currentFilter = filter;
  _currentTab    = 'trips';

  const wrap = document.getElementById('home-wrap');
  if (!wrap) return;

  const allTrips = getTrips();
  const filtered = filter === 'all'
    ? allTrips
    : allTrips.filter(t => t.type === filter);

  // Sort: newest startDate first, fallback to createdAt
  const sorted = [...filtered].sort((a, b) => {
    const da = a.startDate || a.createdAt || '';
    const db = b.startDate || b.createdAt || '';
    return da > db ? -1 : da < db ? 1 : 0;
  });

  const myTrips        = sorted.filter(t => !isCurrentUserObserver(t.id));
  const observingTrips = allTrips.filter(t => isCurrentUserObserver(t.id));
  const heroTrips      = allTrips.filter(t => !isCurrentUserObserver(t.id));

  // Inline tab switcher — lives inside home-sec-hd so it adds no extra row
  const unreadLive = _lvUnreadCount(observingTrips);
  const tabSwitcher = `
    <div class="hl-tabs hl-tabs-inline">
      <button class="hl-tab${_homeLibTab === 'mine' ? ' active' : ''}" data-action="lib-tab" data-tab="mine">🧳 Mes voyages</button>
      <button class="hl-tab${_homeLibTab === 'observing' ? ' active' : ''}" data-action="lib-tab" data-tab="observing">🔭 Mes observations</button>
      <button class="hl-tab${_homeLibTab === 'live' ? ' active' : ''}" data-action="lib-tab" data-tab="live">📡 En direct${unreadLive > 0 ? `<span class="hl-tab-badge">${unreadLive}</span>` : ''}</button>
    </div>`;

  const settings = getSettings();

  // ── Grands-parents mode: ultra-simplified view ───────────────────────────────
  if (settings.grandParentsMode) {
    wrap.innerHTML = `
      <div class="hero gp-hero">
        <div style="display:flex;align-items:center;justify-content:space-between;width:100%">
          <div class="hero-logo">Carnet de Voyages</div>
          <button class="btn-new" data-action="open-settings" title="Paramètres" style="padding:8px 12px;font-size:20px;line-height:1">⚙️</button>
        </div>
      </div>
      <div class="home-sec" style="padding-top:12px">
        <h2 style="font-family:var(--sf);font-size:18px;font-weight:700;margin-bottom:14px">📡 En direct</h2>
        <div class="live-feed-wrap">${_buildLiveFeedHtml(observingTrips)}</div>
      </div>`;
    if (!_listenerAttached) { _attachListeners(wrap); _listenerAttached = true; }
    _initHomeCarousels(wrap);
    return;
  }

  let secContent;
  if (_homeLibTab === 'live') {
    secContent = `
      <div class="home-sec-hd">
        ${tabSwitcher}
      </div>
      <div class="live-feed-wrap">${_buildLiveFeedHtml(observingTrips)}</div>`;
  } else if (_homeLibTab === 'observing') {
    secContent = `
      <div class="home-sec-hd">
        ${tabSwitcher}
        <button class="btn-new hero-new-btn" data-action="join-trip">＋ Rejoindre</button>
      </div>
      ${observingTrips.length === 0 ? `
        <div style="text-align:center;padding:40px 16px;color:var(--ink4)">
          <div style="font-size:36px;margin-bottom:10px">🔭</div>
          <div style="font-size:14px;font-weight:600;margin-bottom:6px">Aucun voyage suivi</div>
          <div style="font-size:12px">Collez un lien d'invitation ou scannez son QR code<br>avec le bouton "＋ Rejoindre" ci-dessus.</div>
        </div>` : `
        <div class="trips-grid" id="trips-grid">
          ${observingTrips.map(_observedTripCardHtml).join('')}
        </div>`}`;
  } else {
    secContent = `
      <div class="home-sec-hd">
        ${tabSwitcher}
        <button class="btn-new hero-new-btn" data-action="new-trip">＋ Nouveau</button>
      </div>
      ${_filterTabsHtml(filter, 'trips')}
      <div id="search-results-area" class="sr-area" style="display:none"></div>
      <div class="trips-grid" id="trips-grid">
        ${myTrips.map(_tripCardHtml).join('')}
        ${_addCardHtml()}
      </div>`;
  }

  wrap.innerHTML = `
    ${_heroHtml(heroTrips)}
    <div class="home-sec">${secContent}</div>
    <button class="home-fab" id="home-fab" title="Ajouter un voyage">＋</button>
    <div class="home-fab-menu panel-fab-menu" id="home-fab-menu">
      <button class="pfm-btn" data-action="new-trip" data-type="sortie">📍 Sortie</button>
      <button class="pfm-btn" data-action="new-trip" data-type="weekend">🌿 Week-end</button>
      <button class="pfm-btn" data-action="new-trip" data-type="voyage">✈️ Voyage</button>
    </div>
  `;

  // Attach the click listener only once; subsequent renderHome calls reuse it
  if (!_listenerAttached) {
    _attachListeners(wrap);
    _listenerAttached = true;
  }

  _initHomeCarousels(wrap);

  // Home FAB toggle — #home-fab/#home-fab-menu are recreated by the innerHTML
  // above on every renderHome() call, so their own click listener is safe to
  // rebind each time (the old nodes + listeners are garbage collected
  // together). The outside-click closer below is bound to `document`, which
  // is never recreated, so it must only ever be attached once — otherwise
  // every renderHome() (triggered on nearly every state change) stacks one
  // more permanent listener on `document`, an unbounded leak over a session.
  const homeFab = document.getElementById('home-fab');
  const fabMenu = document.getElementById('home-fab-menu');
  if (homeFab && fabMenu) {
    homeFab.addEventListener('click', e => {
      e.stopPropagation();
      const open = fabMenu.classList.toggle('visible');
      homeFab.classList.toggle('open', open);
    });
  }
  if (!_fabOutsideClickBound) {
    document.addEventListener('click', () => {
      document.getElementById('home-fab-menu')?.classList.remove('visible');
      document.getElementById('home-fab')?.classList.remove('open');
    });
    _fabOutsideClickBound = true;
  }
}


function _renderStats() {
  _currentTab = 'stats';
  const wrap = document.getElementById('home-wrap');
  if (!wrap) return;
  const allTrips  = getTrips();
  const heroTrips = allTrips.filter(t => !isCurrentUserObserver(t.id));
  const doneTrips = heroTrips.filter(t => t.status === 'done');
  const filtered  = _statsTypeFilter === 'all' ? doneTrips : doneTrips.filter(t => t.type === _statsTypeFilter);
  _statsLastFiltered = filtered;

  wrap.innerHTML = `
    ${_heroHtml(heroTrips)}
    <div class="home-sec">
      <div class="home-sec-hd">
        <h2>Statistiques</h2>
        <button class="btn-new hero-new-btn" data-action="new-trip">＋ Nouveau</button>
      </div>
      ${_filterTabsHtml(_statsTypeFilter, 'stats')}
      <div id="search-results-area" class="sr-area" style="display:none"></div>
      <div id="stats-view" style="padding:8px 0">
        ${_statsViewHtml(filtered)}
      </div>
    </div>
  `;

  if (!_listenerAttached) {
    _attachListeners(wrap);
    _listenerAttached = true;
  }

  // Type filter tab clicks
  wrap.querySelectorAll('[data-stats-type]').forEach(btn => {
    btn.addEventListener('click', () => {
      _statsTypeFilter = btn.dataset.statsType;
      _renderStats();
    });
  });

  // Expand/collapse world map to fullscreen
  document.getElementById('wm-expand-btn')?.addEventListener('click', () => {
    const wmWrap = document.getElementById('world-map-wrap');
    if (!wmWrap) return;
    const isFs = wmWrap.classList.toggle('stat-fs');
    document.getElementById('wm-expand-btn').textContent = isFs ? '✕ Fermer' : '⛶ Plein écran';
    requestAnimationFrame(() => _initGlobe(_statsLastFiltered));
  });

  requestAnimationFrame(() => _initGlobe(filtered));
}

// ── Export helpers ─────────────────────────────────────────────────────────────

const _CSV_HEADERS = ['Nom','Destination','Type','Statut','DateDébut','DateFin','Budget€','Compagnons','Drapeau'];

function _tripToCsvRow(t) {
  const budget = (t.budgetLines || []).reduce((s, b) => s + (Number(b.amount) || 0), 0);
  return [
    t.name        || '',
    t.destination || '',
    t.type        || '',
    t.status      || '',
    t.startDate   || '',
    t.endDate     || '',
    budget,
    (t.companions || []).map(c => c.name).join(';'),
    t.flag        || '',
  ];
}

function _buildCsv(rows) {
  return [_CSV_HEADERS, ...rows]
    .map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
    .join('\r\n');
}

function _downloadCsv(csvContent, filename) {
  const blob = new Blob(['﻿' + csvContent], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Settings Modal ─────────────────────────────────────────────────────────────

function _openSettingsModal() {
  const eventTypes = getEventTypes();
  const settings   = getSettings();
  const curTheme   = settings.theme || 'light';
  const curNotif   = settings.notifications || { enabled: false, departure: true, collaborative: true };

  // ── Event type rows ────────────────────────────────────────────────────────

  const _etInputStyle = 'height:34px;box-sizing:border-box;border:1.5px solid var(--c3);border-radius:7px;background:var(--c)';
  function _etRowHtml(et, i) {
    return `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px" data-et-row="${i}">
        <input type="hidden" data-et-key="${i}"   value="${_esc(et.key)}">
        <input type="hidden" data-et-color="${i}" value="${_esc(et.color || '#0d9488')}">
        <input type="text" data-et-emoji="${i}" value="${_esc(et.emoji)}"
          style="width:48px;text-align:center;font-size:18px;padding:0 4px;${_etInputStyle}">
        <input type="text" data-et-label="${i}" value="${_esc(et.label)}" placeholder="Nom du type"
          style="flex:1;padding:0 8px;font-size:12px;${_etInputStyle}">
      </div>`;
  }

  function buildHtml(curEventTypes, curLang, curTheme, curNotif) {
    return `
      <button class="mc" onclick="closeModal()">✕</button>
      <h3 style="font-family:'Lora',serif;font-size:17px;font-weight:700;margin-bottom:4px">⚙️ Paramètres</h3>

      <div class="fg" style="margin-top:14px">
        <label style="font-size:12px;font-weight:700;color:var(--ink2)">Langue / Language</label>
        <div style="display:flex;gap:16px;margin-top:6px">
          <label style="display:flex;align-items:center;gap:7px;cursor:pointer;font-size:13px">
            <input type="radio" name="lang-sel" value="fr" ${curLang === 'fr' ? 'checked' : ''}>
            🇫🇷 Français
          </label>
          <label style="display:flex;align-items:center;gap:7px;cursor:pointer;font-size:13px">
            <input type="radio" name="lang-sel" value="en" ${curLang === 'en' ? 'checked' : ''}>
            🇬🇧 English
          </label>
        </div>
        <div style="font-size:10px;color:var(--ink4);margin-top:5px">Affecte la carte, la recherche et les étiquettes.</div>
      </div>

      <hr style="border:none;border-top:1px solid var(--c3);margin:16px 0">

      <div class="fg">
        <label style="font-size:12px;font-weight:700;color:var(--ink2)">Apparence</label>
        <div style="display:flex;gap:14px;margin-top:6px;flex-wrap:wrap">
          <label style="display:flex;align-items:center;gap:7px;cursor:pointer;font-size:13px">
            <input type="radio" name="theme-sel" value="light" ${curTheme === 'light' ? 'checked' : ''}>
            ☀️ Clair
          </label>
          <label style="display:flex;align-items:center;gap:7px;cursor:pointer;font-size:13px">
            <input type="radio" name="theme-sel" value="dark" ${curTheme === 'dark' ? 'checked' : ''}>
            🌙 Sombre
          </label>
          <label style="display:flex;align-items:center;gap:7px;cursor:pointer;font-size:13px">
            <input type="radio" name="theme-sel" value="auto" ${curTheme === 'auto' ? 'checked' : ''}>
            ⚙️ Système
          </label>
        </div>
      </div>

      <hr style="border:none;border-top:1px solid var(--c3);margin:16px 0">

      <div class="fg">
        <label style="font-size:12px;font-weight:700;color:var(--ink2)">Types d'activités (planning &amp; carnet)</label>
        <div style="font-size:11px;color:var(--ink4);margin-bottom:8px">Renommez ou changez l'emoji de chaque type.</div>
        <div id="et-rows">${curEventTypes.map(_etRowHtml).join('')}</div>
      </div>

      <hr style="border:none;border-top:1px solid var(--c3);margin:16px 0">

      <div class="fg">
        <label style="font-size:12px;font-weight:700;color:var(--ink2)">Données</label>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">
          <button type="button" data-action="export-all"
            style="background:var(--c2);border:1.5px solid var(--c3);border-radius:7px;padding:6px 12px;font-size:12px;font-weight:700;cursor:pointer;color:var(--ink3)">
            ⬇ Exporter (CSV)
          </button>
          <button type="button" id="settings-clear-data"
            style="background:#fee2e2;border:1.5px solid #fca5a5;border-radius:7px;padding:6px 12px;font-size:12px;font-weight:700;cursor:pointer;color:var(--coral,#e85d3e)">
            🗑 Effacer toutes les données
          </button>
          ${getCurrentUser() ? `
          <button type="button" id="settings-cleanup-photos"
            style="background:var(--c2);border:1.5px solid var(--c3);border-radius:7px;padding:6px 12px;font-size:12px;font-weight:700;cursor:pointer;color:var(--ink3)">
            🧹 Nettoyer les photos en double
          </button>` : ''}
        </div>
      </div>

      <hr style="border:none;border-top:1px solid var(--c3);margin:16px 0">

      <div class="fg">
        <label style="font-size:12px;font-weight:700;color:var(--ink2)">Notifications</label>
        <div style="margin-top:8px">
          <label class="s-toggle-row">
            <span>Activer les notifications</span>
            <input type="checkbox" id="notif-enabled" ${curNotif.enabled ? 'checked' : ''}>
          </label>
          <div id="notif-sub" style="margin-left:4px;margin-top:2px;transition:opacity .15s;${curNotif.enabled ? '' : 'opacity:0.45;pointer-events:none'}">
            <label class="s-toggle-row">
              <span style="font-size:12px">Rappel départ (jour J et veille)</span>
              <input type="checkbox" id="notif-departure" ${curNotif.departure !== false ? 'checked' : ''}>
            </label>
            <label class="s-toggle-row">
              <span style="font-size:12px">Modifications des voyages partagés</span>
              <input type="checkbox" id="notif-collaborative" ${curNotif.collaborative !== false ? 'checked' : ''}>
            </label>
            <label class="s-toggle-row">
              <span style="font-size:12px">Publications des voyages observés 📡</span>
              <input type="checkbox" id="notif-observer-publish" ${curNotif.observerPublish !== false ? 'checked' : ''}>
            </label>
          </div>
        </div>
        <div style="font-size:10px;color:var(--ink4);margin-top:5px">Requiert l'autorisation du navigateur. Désactivé par défaut.</div>
      </div>

      <hr style="border:none;border-top:1px solid var(--c3);margin:16px 0">

      <div class="fg">
        <label style="font-size:12px;font-weight:700;color:var(--ink2)">Mode Grands-parents 👴👵</label>
        <label class="s-toggle-row">
          <span>Affichage simplifié</span>
          <input type="checkbox" id="gp-mode" ${settings.grandParentsMode ? 'checked' : ''}>
        </label>
        <div style="font-size:10px;color:var(--ink4);margin-top:4px">N'affiche que le titre, ⚙️ et le fil En direct des voyages observés.</div>
      </div>

      <div class="ma">
        <button class="bs" onclick="closeModal()">Fermer</button>
      </div>
      <div style="text-align:center;font-size:10px;color:var(--ink4);margin-top:10px">Carnet de Voyages v${APP_VERSION}</div>`;
  }

  showModal(buildHtml(eventTypes, getLanguage(), curTheme, curNotif));

  // ── Collect helpers ──────────────────────────────────────────────────────────

  function collectEventTypes() {
    const result = [];
    document.querySelectorAll('[data-et-row]').forEach((_, i) => {
      const key   = document.querySelector(`[data-et-key="${i}"]`)?.value?.trim() || '';
      const emoji = document.querySelector(`[data-et-emoji="${i}"]`)?.value?.trim() || '';
      const label = document.querySelector(`[data-et-label="${i}"]`)?.value?.trim() || '';
      const color = document.querySelector(`[data-et-color="${i}"]`)?.value?.trim() || '#0d9488';
      if (emoji && label) {
        const resolvedKey = key || label.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '') || 'type_' + i;
        result.push({ key: resolvedKey, emoji, label, color });
      }
    });
    return result;
  }

  // ── Auto-save: apply settings immediately on any change ──────────────────────

  function _applySettings() {
    const newEventTypes   = collectEventTypes();
    const lang            = document.querySelector('input[name="lang-sel"]:checked')?.value    || 'fr';
    const theme           = document.querySelector('input[name="theme-sel"]:checked')?.value   || 'light';
    const notifEnabled    = document.getElementById('notif-enabled')?.checked                  ?? false;
    const notifDep        = document.getElementById('notif-departure')?.checked                ?? true;
    const notifCollab     = document.getElementById('notif-collaborative')?.checked            ?? true;
    const notifObsPub     = document.getElementById('notif-observer-publish')?.checked         ?? true;
    const grandParents    = document.getElementById('gp-mode')?.checked                       ?? false;

    updateSettings({
      eventTypes: newEventTypes.length > 0 ? newEventTypes : DEFAULT_EVENT_TYPES,
      lang, theme,
      notifications: { enabled: notifEnabled, departure: notifDep, collaborative: notifCollab, observerPublish: notifObsPub },
      grandParentsMode: grandParents,
    });

    const root = document.documentElement;
    if (theme === 'dark')      root.dataset.theme = 'dark';
    else if (theme === 'auto') root.dataset.theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : '';
    else                       delete root.dataset.theme;

    if (_currentTab === 'stats') _renderStats();
    else renderHome(_currentFilter);
  }

  // Delegate change events on the whole modal — covers all inputs/radios/checkboxes
  document.querySelector('.mbox')?.addEventListener('change', async e => {
    // Toggle notification sub-panel visibility
    if (e.target.id === 'notif-enabled') {
      const sub = document.getElementById('notif-sub');
      if (sub) {
        sub.style.opacity       = e.target.checked ? '1' : '0.45';
        sub.style.pointerEvents = e.target.checked ? ''  : 'none';
      }
    }
    _applySettings();
    // Request permission when enabling notifications
    if (e.target.id === 'notif-enabled' && e.target.checked && !notificationPermissionGranted()) {
      const granted = await requestNotificationPermission();
      if (!granted) notify('Permission refusée par le navigateur', '⚠️');
    }
  });

  // ── Clear data ────────────────────────────────────────────────────────────────

  document.getElementById('settings-clear-data')?.addEventListener('click', () => {
    if (confirm('Effacer TOUTES les données (voyages, journal, bagages) ? Cette action est irréversible.')) {
      localStorage.clear();
      location.reload();
    }
  });

  // ── Cleanup duplicate/orphaned Storage photos ───────────────────────────────────

  document.getElementById('settings-cleanup-photos')?.addEventListener('click', async e => {
    if (!confirm('Rechercher et supprimer les photos en double ou inutilisées dans le stockage cloud ? Vos photos actuelles ne sont jamais touchées.')) return;
    const btn = e.currentTarget;
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = '⏳ Nettoyage en cours…';
    try {
      const { scanned, removed } = await cleanupDuplicatePhotos(getTrips());
      notify(removed > 0
        ? `${removed} photo(s) en double supprimée(s) sur ${scanned} analysée(s)`
        : `Aucun doublon trouvé (${scanned} photo(s) analysée(s))`, '🧹');
    } catch (err) {
      notify('Échec du nettoyage : ' + err.message, '⚠️');
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });
}

// ── Event delegation ───────────────────────────────────────────────────────────

function _attachListeners(wrap) {
  wrap.addEventListener('click', e => {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;

    switch (action) {
      case 'logout':
        e.stopPropagation();
        // Flush any pending local changes to Firestore before wiping localStorage
        syncToFirestore(getState())
          .catch(() => {})
          .finally(() => {
            logout().then(() => {
              localStorage.removeItem('carnet_voyages_v1');
              window.location.reload();
            });
          });
        break;

      case 'open-mymap':
        window.goMyMap();
        break;

      case 'pwa-install': {
        const prompt = window._pwaPrompt;
        if (prompt) {
          prompt.prompt();
          prompt.userChoice.then(() => { window._pwaPrompt = null; renderHome(); });
        } else {
          const ua = navigator.userAgent;
          const isIos = /iPad|iPhone|iPod/.test(ua);
          const isSafariBased = !ua.includes('Chrome') && !ua.includes('CriOS') && (ua.includes('Safari') || isIos);
          const msg = (isIos && isSafariBased)
            ? 'Safari : appuyez sur Partager ⬆ → "Sur l\'écran d\'accueil"'
            : 'Chrome : icône ⊕ dans la barre d\'adresse, ou ⋮ → "Installer l\'application"';
          notify(msg, '📲');
        }
        break;
      }

      case 'open-import':
        _openImportModal();
        break;

      case 'export-all':
        _openExportModal();
        break;

      case 'new-trip':
        openEditTripModal(null, target.dataset.type || null);
        break;

      case 'join-trip':
        _openJoinTripModal();
        break;

      case 'share-trip':
        e.stopPropagation();
        openShareModal(target.dataset.tripId);
        break;

      case 'edit-trip':
        e.stopPropagation();
        openEditTripModal(target.dataset.tripId);
        break;

      case 'open-trip':
        window.navigateToTrip(target.dataset.tripId);
        break;

      case 'filter':
        renderHome(target.dataset.filter);
        break;

      case 'focus-country':
        _focusGlobeOnCountry(target.dataset.code);
        break;

      case 'go-home':
        renderHome(_currentFilter);
        break;

      case 'lib-tab':
        _homeLibTab = target.dataset.tab;
        if (target.dataset.tab === 'live') _lvMarkSeen();
        renderHome(_currentFilter);
        break;

      case 'show-stats':
        _renderStats();
        break;

      case 'open-settings':
        _openSettingsModal();
        break;

      case 'toggle-status': {
        e.stopPropagation();
        const tripId = target.dataset.tripId;
        const trip   = getTrips().find(t => t.id === tripId);
        if (!trip) break;
        const newStatus = (trip.status || 'done') === 'done' ? 'planning' : 'done';
        updateTrip(tripId, { status: newStatus });
        renderHome(_currentFilter);
        break;
      }

      case 'leave-trip': {
        e.stopPropagation();
        const tripId = target.dataset.tripId;
        const trip   = getTrips().find(t => t.id === tripId);
        const name   = trip?.name || 'ce voyage';
        if (!confirm(`Quitter "${name}" ? Vous ne recevrez plus ses mises à jour.`)) break;
        leaveSharedTrip(tripId).catch(() => {});
        deleteTrip(tripId);
        renderHome(_currentFilter);
        notify(`Vous avez quitté "${name}".`, '👁');
        break;
      }

      case 'trip-menu':
        e.stopPropagation();
        _openTripMenu(target.dataset.tripId, target);
        break;

      case 'lv-toggle-reaction': {
        const tripId = target.dataset.tripId;
        const itemId = target.dataset.itemId;
        if (tripId && itemId) addObserverReaction(tripId, itemId).catch(() => {});
        break;
      }

      case 'lv-remove-reaction': {
        e.stopPropagation();
        const tripId    = target.dataset.tripId;
        const itemId    = target.dataset.itemId;
        const targetUid = target.dataset.targetUid;
        if (tripId && itemId && targetUid) deleteObserverReaction(tripId, itemId, targetUid).catch(() => {});
        break;
      }

      case 'lv-open-comments':
        _openLiveCommentsModal(
          target.dataset.tripId,
          target.dataset.itemId,
          target.dataset.itemText
        );
        break;
    }
  });

  wrap.addEventListener('input', e => {
    if (e.target.id === 'global-search') _handleSearchInput(e.target.value);
  });
  wrap.addEventListener('search', e => {
    if (e.target.id === 'global-search') _handleSearchInput(e.target.value);
  });
}

// ── Modal: companion list HTML ─────────────────────────────────────────────────

function _compsListHtml(comps = _modalComps) {
  if (comps.length === 0) {
    return `<div style="font-size:11px;color:var(--ink4);font-style:italic">Aucun compagnon pour l'instant</div>`;
  }
  return comps.map((c, i) => {
    const bg = c.color || _compColor(i);
    return `
      <div class="comp-tag" data-comp-idx="${i}">
        <div class="comp-avatar"
             style="background:${bg};width:18px;height:18px;font-size:9px">${_initials(c.name)}</div>
        <span class="comp-name-lbl" data-rename-comp="${i}" title="Cliquer pour renommer">${_esc(c.name)}</span>
        <button class="comp-tag-rm" data-remove-comp="${i}" title="Retirer">✕</button>
      </div>
    `;
  }).join('');
}

// ── Sortie modal ───────────────────────────────────────────────────────────────

function _cleanupSortieModalMap() {
  if (_sortieModalMap) {
    try { _sortieModalMap.remove(); } catch (_) {}
    _sortieModalMap    = null;
    _sortieModalMarker = null;
  }
}

function _updateSortieCoordDisplay() {
  const el = document.getElementById('sm-coords');
  if (!el) return;
  el.textContent = _sortieLat != null
    ? `${_sortieLat.toFixed(5)}, ${_sortieLng.toFixed(5)}`
    : 'Aucune position — cliquez sur la carte';
}

function _renderExtraThumbs() {
  const container = document.getElementById('sm-extra-thumbs');
  if (!container) return;
  container.innerHTML = _sortieExtraPhotos.map((p, i) =>
    `<div style="position:relative;display:inline-block">
       <img src="${_esc(p.url)}" style="width:60px;height:60px;object-fit:cover;border-radius:6px;border:1.5px solid var(--c3)">
       <button type="button" data-rm-extra="${i}"
         style="position:absolute;top:-5px;right:-5px;background:var(--coral);color:#fff;border:none;border-radius:50%;width:17px;height:17px;font-size:10px;cursor:pointer;line-height:1;padding:0;display:flex;align-items:center;justify-content:center">✕</button>
     </div>`
  ).join('');
  container.querySelectorAll('[data-rm-extra]').forEach(btn => {
    btn.addEventListener('click', () => {
      _sortieExtraPhotos.splice(parseInt(btn.dataset.rmExtra), 1);
      _renderExtraThumbs();
    });
  });
}

function _buildSortieModalHtml(trip) {
  const isEdit      = _editingId !== null;
  const pin         = trip?.pin || {};
  const name        = trip?.name        || '';
  const destination = trip?.destination || '';
  // Banner photo: prefer photos[0].url for consistency, fall back to trip.photo
  const photo       = trip?.photos?.[0]?.url ?? trip?.photo ?? '';

  // Seed sortie state from existing trip
  _sortieLat         = pin.lat  ?? null;
  _sortieLng         = pin.lng  ?? null;
  _sortieWeather     = pin.weather || null;
  _sortiePinType     = pin.pinType || 'visit';
  _sortiePhotoMode   = 'url';
  _sortiePhotoBase64 = null;
  _sortieExtraPhotos = trip?.photos?.slice(1) || [];
  _sortieComps       = (trip?.companions || []).map(c => ({ ...c }));
  _sortieGpxTrack    = null;
  _sortieGpxStats    = pin.gpxStats  || null;
  _sortieGpxDeleted  = false;

  const coordsText  = _sortieLat != null
    ? `${_sortieLat.toFixed(5)}, ${_sortieLng.toFixed(5)}`
    : 'Aucune position — cliquez sur la carte';

  const eventTypes   = getEventTypes();
  const typePills    = Object.entries(TRIP_TYPES).map(([key, t]) => {
    const isSel = key === 'sortie';
    return `<button class="tp${isSel ? ' sel' : ''}"
                    style="${isSel ? `background:${t.color};border-color:${t.color};color:#fff` : ''}"
                    data-modal-type="${key}">${t.icon} ${t.label}</button>`;
  }).join('');

  const pinTypePills = eventTypes.map(et =>
    `<button class="tp${_sortiePinType === et.key ? ' sel' : ''}"
             style="${_sortiePinType === et.key ? `background:${et.color};border-color:${et.color};color:#fff` : ''}"
             data-sortie-pin-type="${et.key}">${et.emoji} ${et.label}</button>`
  ).join('');

  const weatherHtml = WEATHER_EMOJIS.map(w =>
    `<button class="sw-btn${_sortieWeather === w ? ' sel' : ''}" data-sortie-weather="${w}" title="${w}">${w}</button>`
  ).join('');

  const urlTabActive  = _sortiePhotoMode === 'url';
  const photoPreview  = urlTabActive ? photo : (_sortiePhotoBase64 || '');
  const showPreview   = urlTabActive ? !!photo : !!_sortiePhotoBase64;

  const extraThumbsHtml = _sortieExtraPhotos.map((p, i) =>
    `<div style="position:relative;display:inline-block">
       <img src="${_esc(p.url)}" style="width:60px;height:60px;object-fit:cover;border-radius:6px;border:1.5px solid var(--c3)">
       <button type="button" data-rm-extra="${i}"
         style="position:absolute;top:-5px;right:-5px;background:var(--coral);color:#fff;border:none;border-radius:50%;width:17px;height:17px;font-size:10px;cursor:pointer;line-height:1;padding:0;display:flex;align-items:center;justify-content:center">✕</button>
     </div>`
  ).join('');

  const photoSection = `
    <div class="fg">
      <label>Photo bannière</label>
      <div style="display:flex;gap:6px;margin-bottom:6px">
        <button type="button" id="spt-url"
          style="background:${urlTabActive ? 'var(--teal)' : 'var(--c2)'};color:${urlTabActive ? '#fff' : 'var(--ink3)'};border:1.5px solid ${urlTabActive ? 'var(--teal)' : 'var(--c3)'};border-radius:7px;padding:5px 12px;font-size:12px;font-weight:700;cursor:pointer">
          🔗 URL</button>
        <button type="button" id="spt-file"
          style="background:${urlTabActive ? 'var(--c2)' : 'var(--teal)'};color:${urlTabActive ? 'var(--ink3)' : '#fff'};border:1.5px solid ${urlTabActive ? 'var(--c3)' : 'var(--teal)'};border-radius:7px;padding:5px 12px;font-size:12px;font-weight:700;cursor:pointer">
          📁 Fichier</button>
      </div>
      <div id="sp-url-sec" style="display:${urlTabActive ? 'block' : 'none'}">
        <input type="url" id="sm-photo" value="${_esc(photo)}" placeholder="https://…" autocomplete="off">
      </div>
      <div id="sp-file-sec" style="display:${urlTabActive ? 'none' : 'block'}">
        <input type="file" id="sm-photo-file" accept="image/*" style="width:100%;padding:6px 0;font-size:12px;cursor:pointer">
      </div>
      <img id="sm-photo-preview" class="ip" src="${_esc(photoPreview)}"
           style="${showPreview ? 'display:block' : 'display:none'}" alt="aperçu"
           onerror="this.style.display='none'">
    </div>
    <div class="fg">
      <label>Photos supplémentaires <span style="font-size:10px;font-weight:400;color:var(--ink4);text-transform:none">— carousel dans Mes Destinations</span></label>
      <input type="file" id="sm-photos-extra" accept="image/*" multiple style="width:100%;padding:6px 0;font-size:12px;cursor:pointer">
      <div id="sm-extra-thumbs" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px">${extraThumbsHtml}</div>
    </div>`;

  return `
    <h3 style="font-family:'Lora',serif;font-size:18px;font-weight:700;margin-bottom:16px">
      ${isEdit ? '✎ Modifier la sortie' : '🎯 Nouvelle sortie'}
    </h3>

    <div class="fg">
      <label>Type</label>
      <div class="t-row" id="m-types">${typePills}</div>
    </div>

    <div class="fg">
      <label>Nom de la sortie</label>
      <input type="text" id="sm-name" value="${_esc(name)}"
             placeholder="Randonnée en forêt, Musée d'Orsay…" autocomplete="off">
    </div>

    <div class="fg">
      <label>Lieu <span style="font-weight:400;color:var(--ink4);text-transform:none;font-size:10px">— rechercher ou cliquer sur la carte</span></label>
      <div style="display:flex;gap:6px;margin-bottom:6px">
        <input type="text" id="sm-search" placeholder="Chercher un lieu…" autocomplete="off" style="flex:1;min-width:0">
        <button type="button" id="sm-search-btn" class="bc" style="padding:6px 10px;white-space:nowrap">🔍</button>
      </div>
      <div id="sm-map"></div>
      <div style="font-size:10px;color:var(--ink4);margin-top:4px">📌 <span id="sm-coords">${_esc(coordsText)}</span></div>
    </div>

    <div class="fg">
      <label>Nom du lieu / destination</label>
      <input type="text" id="sm-dest" value="${_esc(destination)}"
             placeholder="Forêt de Fontainebleau…" autocomplete="off">
    </div>

    <div class="fg">
      <label>Dates</label>
      <div id="sm-dp"></div>
    </div>
    <div class="fg">
      <label>Heure de début</label>
      <input type="time" id="sm-time" value="${_esc(pin.time || '')}" autocomplete="off">
    </div>

    <div class="fg">
      <label>Type de point</label>
      <div class="t-row" id="sm-pin-types">${pinTypePills}</div>
    </div>

    <div class="fg">
      <label>Description / notes</label>
      <textarea id="sm-desc" rows="3" placeholder="Notes sur cette sortie…">${_esc(pin.description || '')}</textarea>
    </div>

    <div class="fg">
      <label>Avec qui ?</label>
      <div class="comp-list" id="sm-comp-list">${_compsListHtml(_sortieComps)}</div>
      <div class="comp-add-row" style="margin-top:6px">
        <input type="text" id="sm-comp-input" placeholder="Prénom ou nom…" autocomplete="off">
        <button class="comp-add-btn" id="sm-comp-add">Ajouter</button>
      </div>
      <div id="sm-comp-suggest">${_compSuggestChipsHtml(_sortieComps)}</div>
    </div>

    <div class="fg-row-2">
      <div class="fg">
        <label>Météo</label>
        <div class="sw-picker" id="sm-weather-picker">${weatherHtml}</div>
      </div>
      <div class="fg">
        <label>Coût (€)</label>
        <input type="number" id="sm-cost" value="${pin.cost || ''}" min="0" step="0.01" placeholder="0.00">
      </div>
    </div>

    ${photoSection}

    <div class="fg">
      <label>Trace GPX <span style="font-size:10px;font-weight:400;color:var(--ink4);text-transform:none">— optionnel</span></label>
      <div id="sm-gpx-exists" style="display:${pin.gpxTrackId ? 'block' : 'none'}">
        <div id="sm-gpx-stats-display" style="display:flex;flex-wrap:wrap;gap:4px;padding:8px 10px;background:var(--c2);border:1px solid var(--c3);border-radius:8px;margin-bottom:6px">
          ${_sortieGpxStats ? (() => {
              const s = _sortieGpxStats;
              const dist = s.distanceM >= 1000 ? (s.distanceM/1000).toFixed(1)+' km' : s.distanceM+' m';
              const h = s.durationSecs ? Math.floor(s.durationSecs/3600) : 0;
              const m = s.durationSecs ? Math.round((s.durationSecs%3600)/60) : 0;
              const dur = s.durationSecs ? (h > 0 ? h+'h'+(m+'').padStart(2,'0') : m+' min') : '';
              return [
                `📏 ${dist}`,
                s.elevGain ? `↑ ${s.elevGain} m` : '',
                s.elevLoss ? `↓ ${s.elevLoss} m` : '',
                dur        ? `⏱ ${dur}` : '',
                s.speedAvgKph ? `⚡ ${s.speedAvgKph} km/h` : '',
              ].filter(Boolean).map(t => `<span style="background:#e0f2fe;color:#0284c7;border:1px solid #7dd3fc;border-radius:5px;padding:2px 7px;font-size:10px;font-weight:700">${t}</span>`).join('');
            })() : ''}
        </div>
        <button type="button" id="sm-gpx-del" style="width:100%;background:none;border:1.5px solid var(--coral);color:var(--coral);border-radius:7px;padding:5px;font-size:11px;font-weight:700;cursor:pointer;font-family:var(--fn)">🗑 Supprimer la trace GPX</button>
      </div>
      <div id="sm-gpx-upload" style="display:${pin.gpxTrackId ? 'none' : 'block'}">
        <input type="file" id="sm-gpx-file" accept=".gpx" style="width:100%;font-size:12px;cursor:pointer;padding:4px 0">
        <div id="sm-gpx-preview" style="display:none;flex-wrap:wrap;gap:4px;padding:8px 10px;background:var(--c2);border:1px solid var(--c3);border-radius:8px;margin-top:6px"></div>
      </div>
    </div>

    <div class="ma">
      ${isEdit ? `<button class="bd" id="sm-delete">🗑 Supprimer</button>` : ''}
      <button class="bc" id="sm-cancel">Annuler</button>
      <button class="bs" id="sm-save">${isEdit ? 'Enregistrer' : 'Créer la sortie'}</button>
    </div>
  `;
}

function _initSortieModalListeners(trip) {
  // Type pill — switching away from sortie
  document.getElementById('m-types')?.addEventListener('click', e => {
    const pill = e.target.closest('[data-modal-type]');
    if (!pill) return;
    const newType = pill.dataset.modalType;
    if (newType === 'sortie') return;
    _cleanupSortieModalMap();
    _editingId   = null;   // don't try to overwrite the sortie
    _modalType   = newType;
    _modalComps  = [];
    _modalStatus = 'planning';
    _modalColor  = '#0d9488';
    _photoMode   = 'url';
    _photoBase64 = null;
    showModal(_buildModalHtml(null));
    _initModalListeners(null);
  });

  // Pin type pills
  document.getElementById('sm-pin-types')?.addEventListener('click', e => {
    const pill = e.target.closest('[data-sortie-pin-type]');
    if (!pill) return;
    _sortiePinType = pill.dataset.sortiePinType;
    const et = getEventTypes();
    document.querySelectorAll('#sm-pin-types [data-sortie-pin-type]').forEach(p => {
      const key  = p.dataset.sortiePinType;
      const info = et.find(x => x.key === key) || et[0];
      const sel  = key === _sortiePinType;
      p.classList.toggle('sel', sel);
      p.style.background  = sel ? info.color : '';
      p.style.borderColor = sel ? info.color : '';
      p.style.color       = sel ? '#fff'     : '';
    });
  });

  // Weather picker
  document.getElementById('sm-weather-picker')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-sortie-weather]');
    if (!btn) return;
    const w = btn.dataset.sortieWeather;
    _sortieWeather = _sortieWeather === w ? null : w;
    document.querySelectorAll('#sm-weather-picker [data-sortie-weather]').forEach(b => {
      b.classList.toggle('sel', b.dataset.sortieWeather === _sortieWeather);
    });
  });

  // Photo tabs
  document.getElementById('spt-url')?.addEventListener('click', () => {
    _sortiePhotoMode = 'url';
    _sortiePhotoBase64 = null;
    document.getElementById('sp-url-sec').style.display  = 'block';
    document.getElementById('sp-file-sec').style.display = 'none';
    const btn = document.getElementById('spt-url');
    const btn2 = document.getElementById('spt-file');
    if (btn)  { btn.style.background = 'var(--teal)'; btn.style.color = '#fff'; btn.style.borderColor = 'var(--teal)'; }
    if (btn2) { btn2.style.background = 'var(--c2)'; btn2.style.color = 'var(--ink3)'; btn2.style.borderColor = 'var(--c3)'; }
    const url = document.getElementById('sm-photo')?.value.trim() || '';
    const prev = document.getElementById('sm-photo-preview');
    if (prev) { prev.src = url; prev.style.display = url ? 'block' : 'none'; }
  });

  document.getElementById('spt-file')?.addEventListener('click', () => {
    _sortiePhotoMode = 'file';
    document.getElementById('sp-url-sec').style.display  = 'none';
    document.getElementById('sp-file-sec').style.display = 'block';
    const btn = document.getElementById('spt-file');
    const btn2 = document.getElementById('spt-url');
    if (btn)  { btn.style.background = 'var(--teal)'; btn.style.color = '#fff'; btn.style.borderColor = 'var(--teal)'; }
    if (btn2) { btn2.style.background = 'var(--c2)'; btn2.style.color = 'var(--ink3)'; btn2.style.borderColor = 'var(--c3)'; }
    const prev = document.getElementById('sm-photo-preview');
    if (prev && _sortiePhotoBase64) { prev.src = _sortiePhotoBase64; prev.style.display = 'block'; }
    else if (prev) prev.style.display = 'none';
  });

  document.getElementById('sm-photo')?.addEventListener('input', e => {
    if (_sortiePhotoMode !== 'url') return;
    const url  = e.target.value.trim();
    const prev = document.getElementById('sm-photo-preview');
    if (prev) { prev.src = url; prev.style.display = url ? 'block' : 'none'; }
  });

  document.getElementById('sm-photo-file')?.addEventListener('change', ev => {
    const file = ev.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      _sortiePhotoBase64 = e.target.result;
      const prev = document.getElementById('sm-photo-preview');
      if (prev) { prev.src = _sortiePhotoBase64; prev.style.display = 'block'; }
    };
    reader.readAsDataURL(file);
  });

  document.getElementById('sm-photos-extra')?.addEventListener('change', async ev => {
    const files = Array.from(ev.target.files || []);
    for (const file of files) {
      const b64 = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload  = e => resolve(e.target.result);
        r.onerror = reject;
        r.readAsDataURL(file);
      });
      _sortieExtraPhotos.push({ url: b64 });
    }
    ev.target.value = '';
    _renderExtraThumbs();
  });

  document.getElementById('sm-extra-thumbs')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-rm-extra]');
    if (!btn) return;
    _sortieExtraPhotos.splice(parseInt(btn.dataset.rmExtra), 1);
    _renderExtraThumbs();
  });

  // Companions
  const sortieCompInput = document.getElementById('sm-comp-input');
  const addSortieComp = (presetName) => {
    const name = presetName || sortieCompInput?.value.trim();
    if (!name) return;
    _sortieComps.push({ id: 'c_' + uid(), name, color: _compColor(_sortieComps.length) });
    if (sortieCompInput) sortieCompInput.value = '';
    _refreshSortieCompList();
    sortieCompInput?.focus();
  };
  document.getElementById('sm-comp-add')?.addEventListener('click', () => addSortieComp());
  sortieCompInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addSortieComp(); }
  });
  sortieCompInput?.addEventListener('input', () => {
    const suggest = document.getElementById('sm-comp-suggest');
    if (suggest) suggest.innerHTML = _compSuggestChipsHtml(_sortieComps, sortieCompInput.value);
  });
  document.getElementById('sm-comp-suggest')?.addEventListener('click', e => {
    const chip = e.target.closest('[data-action="add-suggested-comp"]');
    if (chip) addSortieComp(chip.dataset.name);
  });
  document.getElementById('sm-comp-list')?.addEventListener('click', e => {
    const rmBtn = e.target.closest('[data-remove-comp]');
    if (rmBtn) {
      _sortieComps.splice(parseInt(rmBtn.dataset.removeComp, 10), 1);
      _refreshSortieCompList();
      return;
    }
    const lbl = e.target.closest('[data-rename-comp]');
    if (lbl) _startInlineSortieCompRename(parseInt(lbl.dataset.renameComp, 10));
  });

  // Date picker
  const _pin = trip?.pin || {};
  dpInit('sm-dp', _pin.date || trip?.startDate || null, _pin.endDate || trip?.endDate || null);

  // GPX file upload
  document.getElementById('sm-gpx-file')?.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const { parseGpx, computeGpxStats } = await import('./gpx.js');
      const text        = await file.text();
      const { tracks }  = parseGpx(text);
      if (!tracks.length || !tracks[0].points.length) { notify('Fichier GPX invalide ou vide', '⚠️'); return; }
      const points      = tracks[0].points;
      const stats       = computeGpxStats(points);
      _sortieGpxTrack   = { id: 'gpx_' + uid(), name: file.name.replace(/\.gpx$/i, ''), color: '#e85d3e', points, importedAt: new Date().toISOString() };
      _sortieGpxStats   = stats;
      const preview     = document.getElementById('sm-gpx-preview');
      if (preview) {
        const dist = stats.distanceM >= 1000 ? (stats.distanceM/1000).toFixed(1)+' km' : stats.distanceM+' m';
        const h = stats.durationSecs ? Math.floor(stats.durationSecs/3600) : 0;
        const m = stats.durationSecs ? Math.round((stats.durationSecs%3600)/60) : 0;
        preview.innerHTML = [
          `📏 ${dist}`,
          stats.elevGain ? `↑ ${stats.elevGain} m` : '',
          stats.elevLoss ? `↓ ${stats.elevLoss} m` : '',
          stats.durationSecs ? `⏱ ${h > 0 ? h+'h'+(m+'').padStart(2,'0') : m+' min'}` : '',
          stats.speedAvgKph  ? `⚡ ${stats.speedAvgKph} km/h` : '',
        ].filter(Boolean).map(t => `<span style="background:#e0f2fe;color:#0284c7;border:1px solid #7dd3fc;border-radius:5px;padding:2px 7px;font-size:10px;font-weight:700">${t}</span>`).join('');
        preview.style.display = 'flex';
      }
      e.target.style.display = 'none';
      notify('Trace GPX chargée !', '✅');
    } catch (_) { notify('Impossible de lire le fichier GPX', '⚠️'); }
  });

  // Delete existing GPX
  document.getElementById('sm-gpx-del')?.addEventListener('click', () => {
    _sortieGpxDeleted = true;
    _sortieGpxStats   = null;
    _sortieGpxTrack   = null;
    const exists = document.getElementById('sm-gpx-exists');
    const upload = document.getElementById('sm-gpx-upload');
    if (exists) exists.style.display = 'none';
    if (upload) upload.style.display = 'block';
  });

  // Save / cancel / delete
  document.getElementById('sm-save')?.addEventListener('click', _handleSortieSave);
  document.getElementById('sm-cancel')?.addEventListener('click', () => { _cleanupSortieModalMap(); closeModal(); });
  document.getElementById('sm-delete')?.addEventListener('click', _handleDelete);

  // Init map with a small delay so the DOM has fully laid out
  setTimeout(() => _initSortieModalMap(), 80);
}

function _initSortieModalMap() {
  const container = document.getElementById('sm-map');
  if (!container) return;
  _cleanupSortieModalMap();

  const hasCoords = _sortieLat != null && _sortieLng != null;
  const center    = hasCoords ? [_sortieLat, _sortieLng] : [20, 0];
  const zoom      = hasCoords ? 10 : 2;

  try {
    _sortieModalMap = L.map('sm-map', { zoomControl: true }).setView(center, zoom);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap', maxZoom: 19,
    }).addTo(_sortieModalMap);

    if (hasCoords) {
      _sortieModalMarker = L.marker([_sortieLat, _sortieLng]).addTo(_sortieModalMap);
    }

    // Click → place pin
    _sortieModalMap.on('click', e => {
      _sortieLat = e.latlng.lat;
      _sortieLng = e.latlng.lng;
      if (_sortieModalMarker) {
        _sortieModalMarker.setLatLng([_sortieLat, _sortieLng]);
      } else {
        _sortieModalMarker = L.marker([_sortieLat, _sortieLng]).addTo(_sortieModalMap);
      }
      _updateSortieCoordDisplay();
    });
  } catch (e) {
    console.warn('[home] sortie modal map error', e);
  }

  // Search button
  const searchBtn = document.getElementById('sm-search-btn');
  const searchIn  = document.getElementById('sm-search');

  const doSearch = async () => {
    const q = searchIn?.value.trim();
    if (!q) return;
    try {
      const res  = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1&accept-language=fr`);
      const data = await res.json();
      if (data.length > 0) {
        _sortieLat = parseFloat(data[0].lat);
        _sortieLng = parseFloat(data[0].lon);
        _sortieModalMap?.setView([_sortieLat, _sortieLng], 13);
        if (_sortieModalMarker) {
          _sortieModalMarker.setLatLng([_sortieLat, _sortieLng]);
        } else if (_sortieModalMap) {
          _sortieModalMarker = L.marker([_sortieLat, _sortieLng]).addTo(_sortieModalMap);
        }
        _updateSortieCoordDisplay();
        // Auto-fill destination if empty
        const destInput = document.getElementById('sm-dest');
        if (destInput && !destInput.value.trim()) destInput.value = q;
      } else {
        notify('Lieu introuvable.', '⚠️');
      }
    } catch (_) {
      notify('Erreur de géocodage.', '⚠️');
    }
  };

  searchBtn?.addEventListener('click', doSearch);
  searchIn?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });
}

async function _handleSortieSave() {
  const name = (document.getElementById('sm-name')?.value || '').trim();
  if (!name) {
    notify('Veuillez saisir un nom de sortie.', '⚠️');
    document.getElementById('sm-name')?.focus();
    return;
  }

  const { start: startDate, end: rawEnd } = dpGetDates();
  const endDate = rawEnd || startDate;
  const time    = (document.getElementById('sm-time')?.value || '').trim();
  const description = (document.getElementById('sm-desc')?.value || '').trim();
  const cost        = parseFloat(document.getElementById('sm-cost')?.value || '0') || 0;
  const destination = (document.getElementById('sm-dest')?.value || '').trim();

  let photo;
  if (_sortiePhotoMode === 'file' && _sortiePhotoBase64) {
    photo = _sortiePhotoBase64;
  } else {
    photo = (document.getElementById('sm-photo')?.value || '').trim();
  }

  // Build photos array: banner first, then carousel extras
  const photos = [];
  if (photo) photos.push({ url: photo });
  photos.push(..._sortieExtraPhotos);

  _cleanupSortieModalMap();

  const _existingTrip = _editingId ? getTrip(_editingId) : null;
  const _existingPin  = _existingTrip?.pin || {};

  // Reverse-geocode the pin position to get the country flag emoji so MyMap
  // can assign the correct country color. Skipped when editing without moving
  // the pin (reuses the existing flag) — on a slow/flaky mobile connection this
  // fetch had no timeout, so editing a sortie's name/date/notes could appear to
  // hang indefinitely on "Enregistrer" while waiting on a network call that
  // wasn't even needed since the location never changed.
  const _locationUnchanged = _existingTrip &&
    _existingPin.lat === _sortieLat && _existingPin.lng === _sortieLng;

  let flag = _locationUnchanged ? (_existingTrip.flag || '🎯') : '🎯';
  if (!_locationUnchanged && _sortieLat != null && _sortieLng != null) {
    try {
      const controller = new AbortController();
      const timeoutId  = setTimeout(() => controller.abort(), 6000);
      const r = await fetch(
        `https://nominatim.openstreetmap.org/reverse?lat=${_sortieLat}&lon=${_sortieLng}&format=json`,
        { signal: controller.signal }
      );
      clearTimeout(timeoutId);
      const d = await r.json();
      const cc = (d.address?.country_code || '').toUpperCase();
      if (cc.length === 2) {
        flag = String.fromCodePoint(
          cc.charCodeAt(0) - 65 + 0x1F1E6,
          cc.charCodeAt(1) - 65 + 0x1F1E6
        );
      }
    } catch (_) { /* keep default — includes the 6s timeout abort */ }
  }

  // GPX — resolve final state (new upload / existing / deleted). gpx.js is only
  // loaded here, on demand, when this save actually touches a GPX track.
  let finalGpxTrackId   = _existingPin.gpxTrackId  || null;
  let finalGpxStats     = _existingPin.gpxStats    || null;
  let finalGpxPoints    = _existingPin.gpxPoints   || null;
  const _gpxMod = (_sortieGpxDeleted || _sortieGpxTrack) ? await import('./gpx.js') : null;
  if (_sortieGpxDeleted) {
    if (finalGpxTrackId && _editingId) _gpxMod.removeLocalGpxTrack(_editingId, finalGpxTrackId);
    finalGpxTrackId = null; finalGpxStats = null; finalGpxPoints = null;
  }
  if (_sortieGpxTrack) {
    finalGpxTrackId = _sortieGpxTrack.id;
    finalGpxStats   = _sortieGpxStats;
    const step      = Math.max(1, Math.floor(_sortieGpxTrack.points.length / 300));
    finalGpxPoints  = _sortieGpxTrack.points.filter((_, i) => i % step === 0);
  }

  const pin = {
    lat:         _sortieLat,
    lng:         _sortieLng,
    pinType:     _sortiePinType,
    date:        startDate,
    time,
    description,
    weather:     _sortieWeather,
    cost,
    currency:    'EUR',
  };
  if (endDate && endDate !== startDate) pin.endDate = endDate;
  if (finalGpxTrackId) {
    pin.gpxTrackId = finalGpxTrackId;
    pin.gpxStats   = finalGpxStats;
    pin.gpxPoints  = finalGpxPoints;
  }

  const data = {
    name,
    destination,
    photo,
    photos,
    color:     '#d97706',
    flag,
    type:      'sortie',
    status:    'done',
    startDate,
    endDate:   endDate || startDate,
    pin,
    companions: _sortieComps,
    multiCountry: false,
  };

  if (_editingId) {
    updateTrip(_editingId, data);
    if (_sortieGpxTrack) _gpxMod.saveLocalGpxTrack(_editingId, _sortieGpxTrack);
    notify('Sortie mise à jour !', '✅');
  } else {
    const newTrip = addTrip(data);
    if (_sortieGpxTrack) _gpxMod.saveLocalGpxTrack(newTrip.id, _sortieGpxTrack);
    notify('Sortie créée !', '✅');
  }

  closeModal();
  renderHome(_currentFilter);
}

// ── Modal: build HTML ──────────────────────────────────────────────────────────

function _buildModalHtml(trip) {
  const name         = trip?.name         || '';
  const destination  = trip?.destination  || '';
  const flag         = trip?.flag         || '';
  const photo        = trip?.photo        || '';
  const status       = trip?.status       || 'done';
  const multiCountry = trip?.multiCountry || false;

  // Color swatches (using class names from CSS: .col-opts, .col-o, .sel)
  const colors = ['#0d9488','#7c3aed','#e85d3e','#d97706','#db2777','#0284c7','#16a34a'];
  const colorSwatches = colors.map(c =>
    `<div class="col-o${c === _modalColor ? ' sel' : ''}"
          style="background:${c}"
          data-modal-color="${c}"
          title="${c}"></div>`
  ).join('');

  // Type pills (using class names: .t-row, .tp, .sel)
  const typePills = Object.entries(TRIP_TYPES).map(([key, t]) => {
    const isSel = _modalType === key;
    return `<button class="tp${isSel ? ' sel' : ''}"
                    style="${isSel ? `background:${t.color};border-color:${t.color};color:#fff` : ''}"
                    data-modal-type="${key}">${t.icon} ${t.label}</button>`;
  }).join('');

  // Status pills — Réalisé left, En planification right
  const statuses = [
    { key: 'done',     label: '✅ Réalisé' },
    { key: 'planning', label: '📝 En planification' },
  ];
  const statusPills = statuses.map(s => {
    const isSel = _modalStatus === s.key;
    const col   = s.key === 'done' ? '#16a34a' : '#0284c7';
    return `<button class="tp${isSel ? ' sel' : ''}"
                    style="${isSel ? `background:${col};border-color:${col};color:#fff` : ''}"
                    data-modal-status="${s.key}">${s.label}</button>`;
  }).join('');

  const isEdit = _editingId !== null;

  // Photo section — tabs for URL vs file
  const urlTabActive  = _photoMode === 'url';
  const fileTabActive = _photoMode === 'file';

  const photoPreviewSrc = urlTabActive ? photo : (_photoBase64 || '');
  const showPreview     = urlTabActive ? !!photo : !!_photoBase64;

  const photoSection = `
    <div class="fg">
      <label>Photo</label>
      <div style="display:flex;gap:6px;margin-bottom:6px">
        <button type="button" id="photo-tab-url"
          style="background:${urlTabActive ? 'var(--teal)' : 'var(--c2)'};color:${urlTabActive ? '#fff' : 'var(--ink3)'};border:1.5px solid ${urlTabActive ? 'var(--teal)' : 'var(--c3)'};border-radius:7px;padding:5px 12px;font-size:12px;font-weight:700;cursor:pointer">
          🔗 URL
        </button>
        <button type="button" id="photo-tab-file"
          style="background:${fileTabActive ? 'var(--teal)' : 'var(--c2)'};color:${fileTabActive ? '#fff' : 'var(--ink3)'};border:1.5px solid ${fileTabActive ? 'var(--teal)' : 'var(--c3)'};border-radius:7px;padding:5px 12px;font-size:12px;font-weight:700;cursor:pointer">
          📁 Fichier
        </button>
      </div>
      <div id="photo-url-section" style="display:${urlTabActive ? 'block' : 'none'}">
        <input type="url" id="m-photo" value="${_esc(photo)}"
               placeholder="https://…" autocomplete="off">
      </div>
      <div id="photo-file-section" style="display:${fileTabActive ? 'block' : 'none'}">
        <input type="file" id="m-photo-file" accept="image/*"
               style="width:100%;padding:6px 0;font-size:12px;cursor:pointer">
      </div>
      <img id="m-photo-preview" class="ip"
           src="${_esc(photoPreviewSrc)}"
           style="${showPreview ? 'display:block' : 'display:none'}"
           alt="aperçu"
           onerror="this.style.display='none'">
    </div>`;

  return `
    <h3 style="font-family:'Lora',serif;font-size:18px;font-weight:700;margin-bottom:16px">
      ${isEdit ? '✎ Modifier le voyage' : '＋ Nouveau voyage'}
    </h3>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 14px">
      <div class="fg" style="grid-column:1/-1">
        <label>Nom du voyage</label>
        <input type="text" id="m-name" value="${_esc(name)}"
               placeholder="Mon beau voyage…" autocomplete="off">
      </div>
      <div class="fg">
        <label>Destination</label>
        <input type="text" id="m-dest" value="${_esc(destination)}"
               placeholder="Paris, Tokyo…" autocomplete="off">
      </div>
      <div class="fg">
        <label>Drapeau (emoji)</label>
        <input type="text" id="m-flag" value="${_esc(flag)}"
               placeholder="🇫🇷" maxlength="2" autocomplete="off"
               style="font-size:20px;text-align:center">
      </div>
    </div>

    ${photoSection}

    <div class="fg">
      <label>Couleur</label>
      <div class="col-opts" id="m-colors">${colorSwatches}</div>
    </div>

    <div class="fg">
      <label>Type de voyage</label>
      <div class="t-row" id="m-types">${typePills}</div>
    </div>

    <div class="fg">
      <label>Statut</label>
      <div class="t-row" id="m-statuses">${statusPills}</div>
    </div>

    <div class="fg">
      <label>Dates</label>
      <div id="m-dp"></div>
    </div>

    <div class="fg">
      <label>Compagnons de voyage</label>
      <div class="comp-list" id="m-comp-list">${_compsListHtml()}</div>
      <div class="comp-add-row" style="margin-top:6px">
        <input type="text" id="m-comp-input" placeholder="Prénom ou nom…" autocomplete="off">
        <button class="comp-add-btn" id="m-comp-add">Ajouter</button>
      </div>
      <div id="m-comp-suggest">${_compSuggestChipsHtml(_modalComps)}</div>
    </div>

    <div class="fg">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:600">
        <input type="checkbox" id="m-multicountry" ${multiCountry ? 'checked' : ''}
          style="width:16px;height:16px;accent-color:var(--teal);cursor:pointer;flex-shrink:0">
        Voyage multi-pays
      </label>
      <div style="font-size:11px;color:var(--ink4);margin-top:3px;padding-left:24px">
        Permet d'assigner un drapeau différent à chaque étape (pour MyMap)
      </div>
    </div>

    <div class="ma">
      <button class="bc" id="m-cancel">Annuler</button>
      <button class="bs" id="m-save">${isEdit ? 'Enregistrer' : 'Créer le voyage'}</button>
    </div>
  `;
}

// ── Modal: open ────────────────────────────────────────────────────────────────

export function openEditTripModal(id = null, presetType = null) {
  _editingId = id;
  const trip = id ? getTrips().find(t => t.id === id) : null;

  // Apply preset type when creating new (not editing existing)
  if (!trip && presetType) _modalType = presetType;

  // Sortie gets its own dedicated form
  if (trip?.type === 'sortie' || (!trip && _modalType === 'sortie')) {
    _modalType = 'sortie';
    showModal(_buildSortieModalHtml(trip), { onClose: _cleanupSortieModalMap, fullscreenMobile: true });
    _initSortieModalListeners(trip);
    return;
  }

  // Reset photo mode state
  _photoMode   = 'url';
  _photoBase64 = null;

  // Seed module state from the trip being edited (or defaults)
  _modalComps  = trip
    ? (trip.companions || []).map(c => ({ ...c }))
    : [];
  _modalColor  = trip?.color  || '#0d9488';
  _modalType   = trip?.type   || presetType || 'voyage';
  _modalStatus = trip?.status || 'planning';

  showModal(_buildModalHtml(trip));
  _initModalListeners(trip);
}

// Expose on window so sortie.js detail view can call it without circular imports
window._openEditTripModal = openEditTripModal;

// ── Crop modal ────────────────────────────────────────────────────────────────

function _openCropModal(imgSrc, onCrop) {
  // Standalone overlay — deliberately NOT showModal()/closeModal(), which share a
  // single global .mbox. Opening the crop step on top of the trip create/edit modal
  // used to overwrite that modal's content, and closing it afterwards closed the
  // whole thing — silently discarding the in-progress form (name, dates, etc. typed
  // by the user) since the "Enregistrer" button was gone by the time cropping ended.
  const overlay = document.createElement('div');
  overlay.className = 'ov open';
  overlay.style.zIndex = '9500';
  overlay.innerHTML = `
    <div class="mbox">
      <button class="mc" data-crop-close type="button">✕</button>
      <h3 class="modal-title">Recadrer la photo</h3>
      <p style="font-size:12px;color:var(--ink4);margin-bottom:10px">Faites glisser l'image pour choisir la zone visible (format 16:9).</p>
      <div id="crop-frame" style="position:relative;width:100%;aspect-ratio:16/9;overflow:hidden;background:#111;border-radius:10px;cursor:grab;touch-action:none;margin-bottom:12px">
        <img id="crop-img" src="${_esc(imgSrc)}" draggable="false"
             style="position:absolute;max-width:none;max-height:none;user-select:none;pointer-events:none;top:0;left:0">
      </div>
      <button id="crop-ok" type="button" style="width:100%;background:var(--teal);color:#fff;border:none;border-radius:10px;padding:11px;font-size:14px;font-weight:700;cursor:pointer">✓ Valider ce cadrage</button>
    </div>
  `;
  document.body.appendChild(overlay);

  const closeCrop = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) closeCrop(); });
  overlay.querySelector('[data-crop-close]')?.addEventListener('click', closeCrop);

  const frame = overlay.querySelector('#crop-frame');
  const img   = overlay.querySelector('#crop-img');
  let ox = 0, oy = 0, dragging = false, sx = 0, sy = 0;

  function clamp() {
    const fw = frame.clientWidth, fh = frame.clientHeight;
    const iw = img.clientWidth,   ih = img.clientHeight;
    ox = Math.min(0, Math.max(fw - iw, ox));
    oy = Math.min(0, Math.max(fh - ih, oy));
    img.style.left = ox + 'px';
    img.style.top  = oy + 'px';
  }

  img.addEventListener('load', () => {
    const fw = frame.clientWidth, fh = frame.clientHeight;
    const scale = Math.max(fw / img.naturalWidth, fh / img.naturalHeight);
    img.style.width  = Math.round(img.naturalWidth  * scale) + 'px';
    img.style.height = Math.round(img.naturalHeight * scale) + 'px';
    // Center initially
    ox = (fw - img.clientWidth)  / 2;
    oy = (fh - img.clientHeight) / 2;
    clamp();
  }, { once: true });

  frame.addEventListener('pointerdown', e => {
    dragging = true; sx = e.clientX - ox; sy = e.clientY - oy;
    frame.style.cursor = 'grabbing';
    frame.setPointerCapture(e.pointerId);
  });
  frame.addEventListener('pointermove', e => {
    if (!dragging) return;
    ox = e.clientX - sx; oy = e.clientY - sy;
    clamp();
  });
  frame.addEventListener('pointerup', () => { dragging = false; frame.style.cursor = 'grab'; });

  overlay.querySelector('#crop-ok')?.addEventListener('click', () => {
    const fw    = frame.clientWidth, fh = frame.clientHeight;
    const scale = img.clientWidth / img.naturalWidth;
    const sx2   = -ox / scale, sy2 = -oy / scale;
    const sw    = fw / scale,  sh  = fh / scale;

    function _drawAndExport(source) {
      const canvas = document.createElement('canvas');
      canvas.width  = 1200;
      canvas.height = Math.round(1200 * fh / fw);
      canvas.getContext('2d').drawImage(source, sx2, sy2, sw, sh, 0, 0, canvas.width, canvas.height);
      try {
        const dataUrl = canvas.toDataURL('image/jpeg', 0.88);
        closeCrop();
        onCrop(dataUrl);
      } catch (_) {
        closeCrop();
        notify('Recadrage impossible pour cette URL (restriction CORS). Téléchargez d\'abord l\'image.', '⚠️');
      }
    }

    // For data URLs (base64) draw directly — no CORS issue
    if (imgSrc.startsWith('data:')) {
      _drawAndExport(img);
      return;
    }

    // For external URLs, reload with crossOrigin to allow canvas export
    const corsImg = new Image();
    corsImg.crossOrigin = 'anonymous';
    corsImg.onload  = () => _drawAndExport(corsImg);
    corsImg.onerror = () => {
      // CORS load failed — draw the already-loaded display img (may taint canvas)
      _drawAndExport(img);
    };
    // Cache-bust to force a fresh CORS-enabled request (avoids opaque cached response)
    corsImg.src = imgSrc + (imgSrc.includes('?') ? '&' : '?') + '_cv=' + Date.now();
  });
}

// ── Modal: wire up listeners ───────────────────────────────────────────────────

function _initModalListeners(trip) {
  // Date picker
  dpInit('m-dp', trip?.startDate ?? null, trip?.endDate ?? null);

  // Photo tab switching
  document.getElementById('photo-tab-url')?.addEventListener('click', () => {
    _photoMode = 'url';
    _photoBase64 = null;
    document.getElementById('photo-url-section').style.display  = 'block';
    document.getElementById('photo-file-section').style.display = 'none';
    // Update tab button styles
    document.getElementById('photo-tab-url').style.background   = 'var(--teal)';
    document.getElementById('photo-tab-url').style.color        = '#fff';
    document.getElementById('photo-tab-url').style.borderColor  = 'var(--teal)';
    document.getElementById('photo-tab-file').style.background  = 'var(--c2)';
    document.getElementById('photo-tab-file').style.color       = 'var(--ink3)';
    document.getElementById('photo-tab-file').style.borderColor = 'var(--c3)';
    // Restore URL preview
    const url     = document.getElementById('m-photo')?.value?.trim() || '';
    const preview = document.getElementById('m-photo-preview');
    if (preview) {
      preview.src          = url;
      preview.style.display = url ? 'block' : 'none';
    }
  });

  document.getElementById('photo-tab-file')?.addEventListener('click', () => {
    _photoMode = 'file';
    document.getElementById('photo-url-section').style.display  = 'none';
    document.getElementById('photo-file-section').style.display = 'block';
    // Update tab button styles
    document.getElementById('photo-tab-file').style.background  = 'var(--teal)';
    document.getElementById('photo-tab-file').style.color       = '#fff';
    document.getElementById('photo-tab-file').style.borderColor = 'var(--teal)';
    document.getElementById('photo-tab-url').style.background   = 'var(--c2)';
    document.getElementById('photo-tab-url').style.color        = 'var(--ink3)';
    document.getElementById('photo-tab-url').style.borderColor  = 'var(--c3)';
    // Show existing base64 preview if any
    const preview = document.getElementById('m-photo-preview');
    if (preview && _photoBase64) {
      preview.src          = _photoBase64;
      preview.style.display = 'block';
    } else if (preview) {
      preview.style.display = 'none';
    }
  });

  // Photo URL preview + URL crop button
  const photoInput   = document.getElementById('m-photo');
  const photoPreview = document.getElementById('m-photo-preview');
  if (photoInput && photoPreview) {
    photoInput.addEventListener('input', () => {
      if (_photoMode !== 'url') return;
      const url = photoInput.value.trim();
      if (url) {
        photoPreview.src          = url;
        photoPreview.style.display = 'block';
        photoPreview.onerror      = () => { photoPreview.style.display = 'none'; };
        // Show/create URL crop button
        let cropBtn = document.getElementById('m-url-crop-btn');
        if (!cropBtn) {
          cropBtn = document.createElement('button');
          cropBtn.id   = 'm-url-crop-btn';
          cropBtn.type = 'button';
          cropBtn.textContent = '✂ Recadrer';
          cropBtn.style.cssText = 'display:block;margin-top:6px;font-size:11px;padding:4px 10px;border-radius:6px;background:var(--c2);border:1px solid var(--c3);cursor:pointer;color:var(--ink2);font-weight:600';
          photoPreview.insertAdjacentElement('afterend', cropBtn);
        }
        cropBtn.style.display = 'block';
        cropBtn.onclick = () => {
          _openCropModal(url, cropped => {
            _photoBase64 = cropped;
            photoPreview.src = _photoBase64;
            photoPreview.style.display = 'block';
          });
        };
      } else {
        photoPreview.style.display = 'none';
        const cropBtn = document.getElementById('m-url-crop-btn');
        if (cropBtn) cropBtn.style.display = 'none';
      }
    });
  }

  // Photo file input
  // Photo file input → open crop dialog after reading
  document.getElementById('m-photo-file')?.addEventListener('change', ev => {
    const file = ev.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      _openCropModal(e.target.result, cropped => {
        _photoBase64 = cropped;
        const preview = document.getElementById('m-photo-preview');
        if (preview) { preview.src = _photoBase64; preview.style.display = 'block'; }
        // Show a "Recadrer" button next to preview
        let btn = document.getElementById('m-crop-btn');
        if (!btn) {
          btn = document.createElement('button');
          btn.id = 'm-crop-btn';
          btn.type = 'button';
          btn.textContent = '✂ Recadrer';
          btn.style.cssText = 'margin-top:6px;font-size:11px;padding:4px 10px;border-radius:6px;background:var(--c2);border:1px solid var(--c3);cursor:pointer;color:var(--ink2);font-weight:600';
          document.getElementById('m-photo-preview')?.insertAdjacentElement('afterend', btn);
        }
        btn.onclick = () => _openCropModal(_photoBase64, cropped2 => {
          _photoBase64 = cropped2;
          const prev = document.getElementById('m-photo-preview');
          if (prev) prev.src = _photoBase64;
        });
      });
    };
    reader.readAsDataURL(file);
  });

  // Color swatches
  document.getElementById('m-colors')?.addEventListener('click', e => {
    const sw = e.target.closest('[data-modal-color]');
    if (!sw) return;
    _modalColor = sw.dataset.modalColor;
    document.querySelectorAll('#m-colors [data-modal-color]').forEach(s => {
      s.classList.toggle('sel', s.dataset.modalColor === _modalColor);
    });
  });

  // Type pills
  document.getElementById('m-types')?.addEventListener('click', e => {
    const pill = e.target.closest('[data-modal-type]');
    if (!pill) return;
    const newType = pill.dataset.modalType;

    // Switch to sortie-specific form
    if (newType === 'sortie') {
      _modalType = 'sortie';
      showModal(_buildSortieModalHtml(null), { onClose: _cleanupSortieModalMap, fullscreenMobile: true });
      _initSortieModalListeners(null);
      return;
    }

    _modalType = newType;
    document.querySelectorAll('#m-types [data-modal-type]').forEach(p => {
      const key    = p.dataset.modalType;
      const isSel  = key === _modalType;
      const tInfo  = TRIP_TYPES[key];
      p.classList.toggle('sel', isSel);
      p.style.background  = isSel ? tInfo.color : '';
      p.style.borderColor = isSel ? tInfo.color : '';
      p.style.color       = isSel ? '#fff'      : '';
    });
  });

  // Status pills
  document.getElementById('m-statuses')?.addEventListener('click', e => {
    const pill = e.target.closest('[data-modal-status]');
    if (!pill) return;
    _modalStatus = pill.dataset.modalStatus;
    const colMap = { done: '#16a34a', planning: '#0284c7' };
    document.querySelectorAll('#m-statuses [data-modal-status]').forEach(p => {
      const k     = p.dataset.modalStatus;
      const isSel = k === _modalStatus;
      const col   = colMap[k] || '#0d9488';
      p.classList.toggle('sel', isSel);
      p.style.background  = isSel ? col  : '';
      p.style.borderColor = isSel ? col  : '';
      p.style.color       = isSel ? '#fff' : '';
    });
  });

  // Add companion
  const compInput = document.getElementById('m-comp-input');
  const addCompFn = (presetName) => {
    const name = presetName || compInput?.value.trim();
    if (!name) return;
    _modalComps.push({
      id:    'c_' + uid(),
      name,
      color: _compColor(_modalComps.length),
    });
    if (compInput) compInput.value = '';
    _refreshCompList();
    compInput?.focus();
  };

  document.getElementById('m-comp-add')?.addEventListener('click', () => addCompFn());
  compInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addCompFn(); }
  });
  compInput?.addEventListener('input', () => {
    const suggest = document.getElementById('m-comp-suggest');
    if (suggest) suggest.innerHTML = _compSuggestChipsHtml(_modalComps, compInput.value);
  });

  // Suggested companions (people from previous trips)
  document.getElementById('m-comp-suggest')?.addEventListener('click', e => {
    const chip = e.target.closest('[data-action="add-suggested-comp"]');
    if (chip) addCompFn(chip.dataset.name);
  });

  // Remove / rename companion (delegated)
  document.getElementById('m-comp-list')?.addEventListener('click', e => {
    const rmBtn = e.target.closest('[data-remove-comp]');
    if (rmBtn) {
      _modalComps.splice(parseInt(rmBtn.dataset.removeComp, 10), 1);
      _refreshCompList();
      return;
    }
    const lbl = e.target.closest('[data-rename-comp]');
    if (lbl) _startInlineCompRename(parseInt(lbl.dataset.renameComp, 10));
  });

  // Save
  document.getElementById('m-save')?.addEventListener('click', _handleSave);

  // Cancel
  document.getElementById('m-cancel')?.addEventListener('click', closeModal);
}

function _refreshCompList() {
  const list = document.getElementById('m-comp-list');
  if (list) list.innerHTML = _compsListHtml();
  const suggest = document.getElementById('m-comp-suggest');
  if (suggest) suggest.innerHTML = _compSuggestChipsHtml(_modalComps);
}

function _refreshSortieCompList() {
  const list = document.getElementById('sm-comp-list');
  if (list) list.innerHTML = _compsListHtml(_sortieComps);
  const suggest = document.getElementById('sm-comp-suggest');
  if (suggest) suggest.innerHTML = _compSuggestChipsHtml(_sortieComps);
}

function _startInlineCompRename(idx) {
  const lbl = document.querySelector(`.comp-name-lbl[data-rename-comp="${idx}"]`);
  if (!lbl) return;
  const current = _modalComps[idx]?.name || '';
  const input = document.createElement('input');
  input.type = 'text';
  input.value = current;
  input.className = 'comp-rename-input';
  lbl.replaceWith(input);
  input.focus();
  input.select();
  const save = () => {
    if (_modalComps[idx]) _modalComps[idx].name = input.value.trim() || current;
    _refreshCompList();
  };
  input.addEventListener('blur', save);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.removeEventListener('blur', save); _refreshCompList(); }
  });
}

function _startInlineSortieCompRename(idx) {
  const lbl = document.querySelector(`.comp-name-lbl[data-rename-comp="${idx}"]`);
  if (!lbl) return;
  const current = _sortieComps[idx]?.name || '';
  const input = document.createElement('input');
  input.type = 'text';
  input.value = current;
  input.className = 'comp-rename-input';
  lbl.replaceWith(input);
  input.focus();
  input.select();
  const save = () => {
    if (_sortieComps[idx]) _sortieComps[idx].name = input.value.trim() || current;
    _refreshSortieCompList();
  };
  input.addEventListener('blur', save);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.removeEventListener('blur', save); _refreshSortieCompList(); }
  });
}

// ── Modal: save / delete ───────────────────────────────────────────────────────

function _handleSave() {
  const name = (document.getElementById('m-name')?.value || '').trim();
  if (!name) {
    notify('Veuillez saisir un nom de voyage.', '⚠️');
    document.getElementById('m-name')?.focus();
    return;
  }

  const destination = (document.getElementById('m-dest')?.value  || '').trim();
  const flag        = (document.getElementById('m-flag')?.value  || '').trim() || '🌍';
  const { start, end } = dpGetDates();

  // Resolve photo: base64 takes priority (from file upload or URL crop)
  let photo;
  if (_photoBase64) {
    photo = _photoBase64;
  } else {
    photo = (document.getElementById('m-photo')?.value || '').trim();
  }

  const data = {
    name,
    destination,
    flag,
    photo,
    color:        _modalColor,
    type:         _modalType,
    status:       _modalStatus,
    startDate:    start || null,
    endDate:      end   || null,
    companions:   _modalComps,
    multiCountry: document.getElementById('m-multicountry')?.checked || false,
  };

  if (_editingId) {
    // Capture old state before updating
    const existing   = getTrips().find(t => t.id === _editingId);
    const oldStart   = existing?.startDate || null;
    const oldEnd     = existing?.endDate   || null;
    const oldDays    = existing?.days      || [];
    const hadDays    = Array.isArray(existing?.days) && existing.days.length > 0;
    const oldCompIds = (existing?.companions || []).map(c => c.id);

    const updated = updateTrip(_editingId, data);

    // Revoke Firestore access for companions that were removed from a shared trip
    if (isTripShared(_editingId)) {
      const newCompIdSet = new Set(_modalComps.map(c => c.id));
      oldCompIds
        .filter(id => !newCompIdSet.has(id))
        .forEach(compId => removeSharedTripMember(_editingId, compId).catch(() => {}));
    }

    if (updated) {
      const dateChanged = data.startDate !== oldStart || data.endDate !== oldEnd;

      if (dateChanged && data.startDate && data.endDate) {
        // Regenerate day skeleton and merge with existing day data by date
        const newDays    = generateDays(updated);
        const mergedDays = newDays.map(nd => {
          const old = oldDays.find(od => od.date === nd.date);
          return old
            ? { ...nd, title: old.title, region: old.region, lat: old.lat, lng: old.lng, color: old.color, photo: old.photo, items: old.items }
            : nd;
        });
        updateTrip(_editingId, { days: mergedDays });
      } else if (!hadDays) {
        // No days existed before — generate fresh if possible
        const newDays = generateDays(updated);
        if (newDays.length > 0) {
          updateTrip(_editingId, { days: newDays });
        }
      }
    }
    notify('Voyage mis à jour !', '✅');
  } else {
    // Create new trip
    const trip    = addTrip(data);
    const newDays = generateDays(trip);
    if (newDays.length > 0) {
      updateTrip(trip.id, { days: newDays });
    }
    notify('Voyage créé !', '✅');
  }

  closeModal();
  renderHome(_currentFilter);
}

function _handleDelete() {
  if (!_editingId) return;
  const trip = getTrips().find(t => t.id === _editingId);
  const name = trip?.name || 'ce voyage';

  if (!confirm(`Supprimer "${name}" ? Cette action est irréversible.`)) return;

  const id = _editingId;
  leaveSharedTrip(id); // unsubscribe listener + clean sharedTripIds (no-op if not shared)
  deleteTrip(id);
  closeModal();
  renderHome(_currentFilter);
  notify(`"${name}" supprimé.`, '🗑');
}

// ── Join a shared trip (paste link or scan QR) ──────────────────────────────────

let _joinScanStream = null;
let _joinScanRAF    = null;

/** Extract an invite token from a pasted full link, or treat the input as a raw token. */
function _extractInviteToken(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const token = new URL(trimmed).searchParams.get('invite');
    if (token) return token;
  } catch (_) { /* not a full URL — fall through to raw-token below */ }
  return trimmed;
}

async function _submitJoinLink(raw) {
  const token    = _extractInviteToken(raw);
  const statusEl = document.getElementById('join-status');
  if (!token) {
    if (statusEl) statusEl.textContent = 'Collez un lien ou un code d\'invitation valide.';
    return;
  }
  const user = getCurrentUser();
  if (!user) { notify('Connectez-vous d\'abord.', '⚠️'); return; }
  _stopJoinScan();
  sessionStorage.setItem('_pendingInvite', token);
  closeModal();
  await handlePendingInvite(user);
}

/** Best-effort camera QR scan using the native BarcodeDetector API (Chrome/Android;
 *  not available on Safari/iOS, where pasting the link remains the only path). */
async function _startJoinScan() {
  const wrap   = document.getElementById('join-scan-wrap');
  const video  = document.getElementById('join-scan-video');
  if (!wrap || !video) return;

  if (!('BarcodeDetector' in window)) {
    notify('Scan QR non disponible sur ce navigateur — collez le lien à la place.', '⚠️');
    return;
  }

  try {
    _joinScanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch (_) {
    notify('Impossible d\'accéder à la caméra.', '⚠️');
    return;
  }

  wrap.style.display = 'block';
  video.srcObject = _joinScanStream;
  await video.play().catch(() => {});

  const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
  const scan = async () => {
    if (!_joinScanStream) return; // stopped
    try {
      const codes = await detector.detect(video);
      if (codes.length > 0) {
        const raw   = codes[0].rawValue;
        const input = document.getElementById('join-link-input');
        if (input) input.value = raw;
        await _submitJoinLink(raw);
        return;
      }
    } catch (_) { /* detection hiccup on this frame — keep trying */ }
    _joinScanRAF = requestAnimationFrame(scan);
  };
  _joinScanRAF = requestAnimationFrame(scan);
}

function _stopJoinScan() {
  if (_joinScanRAF) { cancelAnimationFrame(_joinScanRAF); _joinScanRAF = null; }
  if (_joinScanStream) { _joinScanStream.getTracks().forEach(t => t.stop()); _joinScanStream = null; }
  const wrap = document.getElementById('join-scan-wrap');
  if (wrap) wrap.style.display = 'none';
}

function _openJoinTripModal() {
  showModal(`
    <button class="mc" onclick="closeModal()">✕</button>
    <h3>🔭 Rejoindre un voyage</h3>
    <p style="font-size:13px;color:var(--ink3);margin-bottom:12px">
      Collez le lien d'invitation reçu, ou scannez son QR code directement avec l'appareil photo.
    </p>
    <div class="fg">
      <label>Lien ou code d'invitation</label>
      <input type="text" id="join-link-input" placeholder="https://…">
    </div>
    <div class="fg">
      <button type="button" id="join-scan-btn"
        style="width:100%;background:var(--c2);border:1.5px solid var(--c3);border-radius:8px;padding:9px;font-size:13px;font-weight:700;cursor:pointer;color:var(--ink2)">
        📷 Scanner un QR code
      </button>
      <div id="join-scan-wrap" style="display:none;margin-top:8px">
        <video id="join-scan-video" style="width:100%;border-radius:8px;background:#000;display:block" playsinline muted></video>
        <div style="font-size:11px;color:var(--ink4);margin-top:4px;text-align:center">Visez le QR code…</div>
      </div>
    </div>
    <div id="join-status" style="font-size:12px;color:var(--coral);min-height:16px;margin-top:2px"></div>
    <div class="ma">
      <button class="bc" onclick="closeModal()">Annuler</button>
      <button class="bs" id="join-confirm-btn">Rejoindre</button>
    </div>
  `, { onClose: _stopJoinScan });

  document.getElementById('join-scan-btn')?.addEventListener('click', _startJoinScan);
  document.getElementById('join-confirm-btn')?.addEventListener('click', () => {
    _submitJoinLink(document.getElementById('join-link-input')?.value);
  });
  document.getElementById('join-link-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); _submitJoinLink(e.target.value); }
  });
}

// ── Import modal ───────────────────────────────────────────────────────────────

function _openImportModal() {
  showModal(`
    <button class="mc" onclick="closeModal()">✕</button>
    <h3>⬆ Importer des voyages</h3>
    <p style="font-size:13px;color:var(--ink3);margin-bottom:12px">
      Importez depuis un fichier <strong>JSON</strong> (voyage exporté depuis l'appli ou export Polarsteps), <strong>ZIP</strong> (export complet Polarsteps avec photos), <strong>KML</strong> (Google Earth) ou <strong>CSV</strong>.
    </p>
    <div style="margin-bottom:12px">
      <button type="button" id="imp-download-sample"
        style="background:var(--c2);border:1.5px solid var(--c3);border-radius:8px;padding:7px 14px;font-size:12px;font-weight:700;cursor:pointer;color:var(--ink3);display:inline-flex;align-items:center;gap:6px">
        📥 Exemple CSV
      </button>
    </div>
    <div class="fg">
      <label>Type de voyage (pour KML/CSV)</label>
      <div class="t-row" id="imp-types">
        <button class="tp sel" data-imp-type="voyage"  style="background:#0d9488;border-color:#0d9488;color:#fff">✈️ Voyage</button>
        <button class="tp"     data-imp-type="weekend">🏕️ Week-end</button>
        <button class="tp"     data-imp-type="sortie" >🎯 Sortie</button>
      </div>
    </div>
    <div class="fg">
      <label>Fichier JSON, ZIP, KML ou CSV</label>
      <input type="file" id="imp-file" accept=".kml,.csv,.json,.zip" class="mi"
             style="padding:8px;cursor:pointer" />
    </div>
    <div id="imp-status" style="font-size:12px;color:var(--ink4);margin-top:8px;min-height:18px"></div>
    <div class="ma">
      <button class="bc" onclick="closeModal()">Annuler</button>
      <button class="bs" id="imp-go">Importer</button>
    </div>`);

  // Sample CSV download
  document.getElementById('imp-download-sample')?.addEventListener('click', () => {
    const csvContent = [
      'name,date,lat,lng,region',
      'Reykjavik,2024-06-01,64.1355,-21.8954,Islande',
      'Akureyri,2024-06-03,65.6885,-18.1006,Islande',
    ].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'exemple_voyage.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  // Type selection
  let selectedType = 'voyage';
  document.getElementById('imp-types')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-imp-type]');
    if (!btn) return;
    selectedType = btn.dataset.impType;
    const types = { voyage: { color: '#0d9488' }, weekend: { color: '#7c3aed' }, sortie: { color: '#d97706' } };
    document.querySelectorAll('#imp-types [data-imp-type]').forEach(b => {
      const isSel = b.dataset.impType === selectedType;
      const col   = types[b.dataset.impType]?.color || '#0d9488';
      b.classList.toggle('sel', isSel);
      b.style.background  = isSel ? col : '';
      b.style.borderColor = isSel ? col : '';
      b.style.color       = isSel ? '#fff' : '';
    });
  });

  document.getElementById('imp-go')?.addEventListener('click', async () => {
    const fileInput = document.getElementById('imp-file');
    const file      = fileInput?.files?.[0];
    const statusEl  = document.getElementById('imp-status');
    if (!file) {
      statusEl.textContent = 'Veuillez sélectionner un fichier.';
      return;
    }

    const { importFile, importAnyZip } = await import('./import.js');

    // ZIP: Polarsteps full export with photos
    if (file.name.toLowerCase().endsWith('.zip')) {
      statusEl.style.color = '';
      statusEl.textContent = 'Lecture du ZIP…';
      try {
        const result = await importAnyZip(file, (done, total) => {
          statusEl.textContent = total > 0 ? `Traitement : ${done} / ${total}…` : 'Chargement…';
        });
        const trips = result.trips || [];
        closeModal();
        renderHome(_currentFilter);
        if (result.format === 'polarsteps') {
          const t = trips[0];
          const steps = t?.days?.reduce((n, d) => n + (d.items?.length || 0), 0) || 0;
          notify(`Polarsteps importé : ${t?.name} — ${t?.days?.length || 0} jours, ${steps} étapes`, '✅');
        } else {
          const count = trips.length;
          notify(`${count} voyage${count > 1 ? 's' : ''} importé${count > 1 ? 's' : ''}`, '✅');
        }
      } catch (err) {
        statusEl.style.color = 'var(--coral)';
        statusEl.textContent = err.message;
      }
      return;
    }

    statusEl.style.color = '';
    statusEl.textContent = 'Import en cours…';
    await importFile(file, selectedType, count => {
      closeModal();
      renderHome(_currentFilter);
    });
  });
}

// ── Trip three-dot menu ────────────────────────────────────────────────────────

function _closeTripMenu() {
  if (_openTripMenuEl) { _openTripMenuEl.remove(); _openTripMenuEl = null; }
}

function _openTripMenu(tripId, btn) {
  _closeTripMenu();
  const menu = document.createElement('div');
  menu.className = 'tc-dropdown';
  menu.innerHTML = `
    <button data-tm="edit">✎ Modifier</button>
    <button data-tm="share">🔗 Partager</button>
    <button data-tm="duplicate">⧉ Dupliquer</button>
    <button data-tm="export-planning">📋 Exporter Planning</button>
    <button data-tm="export-all">📦 Exporter Tout</button>
    <button data-tm="export-pdf">🖨 Exporter / Imprimer</button>
    <button data-tm="delete" style="color:var(--coral)">🗑 Supprimer</button>
  `;
  document.body.appendChild(menu);
  _openTripMenuEl = menu;

  const rect = btn.getBoundingClientRect();
  const mw   = 210;
  let left   = rect.right - mw;
  if (left < 8) left = 8;
  if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
  // Tentative position below — flip above if it would overflow viewport bottom
  menu.style.cssText = `position:fixed;top:${rect.bottom + 4}px;left:${left}px;z-index:99999;min-width:${mw}px`;
  const mh = menu.getBoundingClientRect().height;
  if (rect.bottom + 4 + mh > window.innerHeight - 8) {
    menu.style.top = Math.max(8, rect.top - mh - 4) + 'px';
  }

  menu.addEventListener('click', async e2 => {
    const btn2 = e2.target.closest('[data-tm]');
    if (!btn2) return;
    _closeTripMenu();
    const trip = getTrip(tripId);
    if (!trip) return;
    switch (btn2.dataset.tm) {
      case 'edit':
        openEditTripModal(tripId);
        break;
      case 'share':
        openShareModal(tripId);
        break;
      case 'duplicate':
        _duplicateTrip(trip);
        break;
      case 'export-planning': {
        const { downloadTripPlanning } = await import('./export.js');
        downloadTripPlanning(trip);
        break;
      }
      case 'export-all': {
        notify('Préparation de l\'export…', '📦');
        try {
          const { downloadTripAll } = await import('./export.js');
          await downloadTripAll(trip);
        } catch (err) { notify(err.message, '⚠'); }
        break;
      }
      case 'export-pdf':
        _openPdfExportModal(trip);
        break;
      case 'delete': {
        const name = trip.name || 'ce voyage';
        if (!confirm(`Supprimer "${name}" ? Cette action est irréversible.`)) break;
        // If shared, notify all members/observers before cleaning up locally
        if (isTripShared(tripId)) {
          deleteOwnerSharedTrip(tripId).catch(() => {});
        } else {
          leaveSharedTrip(tripId);
        }
        deleteTrip(tripId);
        renderHome(_currentFilter);
        notify(`"${name}" supprimé.`, '🗑');
        break;
      }
    }
  });

  // Close on any scroll (once)
  const onScroll = () => _closeTripMenu();
  window.addEventListener('scroll', onScroll, { once: true, capture: true, passive: true });

  setTimeout(() => document.addEventListener('click', _closeTripMenu, { once: true }), 0);
}

// ── PDF / Word export customization modal ─────────────────────────────────────

function _openPdfExportModal(trip) {
  let _fmt     = 'pdf';
  let _theme   = 'classic';

  const themes = [
    { key: 'classic', label: '🎨 Classique', color: '#0d9488' },
    { key: 'nature',  label: '🌿 Nature',    color: '#16a34a' },
    { key: 'warm',    label: '🌅 Chaleureux', color: '#d97706' },
    { key: 'marine',  label: '🌊 Marin',      color: '#0284c7' },
  ];

  const themePills = () => themes.map(t => {
    const sel = t.key === _theme;
    return `<button class="tp${sel ? ' sel' : ''}"
      style="${sel ? `background:${t.color};border-color:${t.color};color:#fff` : ''}"
      data-pdf-theme="${t.key}">${t.label}</button>`;
  }).join('');

  showModal(`
    <button class="mc" onclick="closeModal()">✕</button>
    <h3>🖨 Exporter le carnet</h3>

    <div class="fg">
      <label>Format de sortie</label>
      <div class="t-row" id="pdf-fmt">
        <button class="tp sel" data-pdf-fmt="pdf"
          style="background:#0d9488;border-color:#0d9488;color:#fff">📄 PDF (impression)</button>
        <button class="tp" data-pdf-fmt="word">📝 Word (.doc)</button>
      </div>
    </div>

    <div class="fg">
      <label>Sections à inclure</label>
      <div style="display:flex;flex-direction:column;gap:4px;margin-top:4px">
        <label class="s-toggle-row"><span>📅 Planning &amp; Carnet</span><input type="checkbox" data-pdf-sec="planning" checked></label>
        <label class="s-toggle-row"><span>💳 Dépenses</span><input type="checkbox" data-pdf-sec="expenses" checked></label>
        <label class="s-toggle-row"><span>💶 Budget prévisionnel</span><input type="checkbox" data-pdf-sec="budget" checked></label>
        <label class="s-toggle-row"><span>🧳 Bagages</span><input type="checkbox" data-pdf-sec="packing" checked></label>
        <label class="s-toggle-row"><span>👥 Compagnons</span><input type="checkbox" data-pdf-sec="companions" checked></label>
      </div>
    </div>

    <div class="fg">
      <label>Thème visuel</label>
      <div class="t-row" id="pdf-themes">${themePills()}</div>
    </div>

    <div class="fg">
      <label>Mise en page</label>
      <div style="display:flex;flex-direction:column;gap:4px;margin-top:4px">
        <label class="s-toggle-row"><span>📖 Page de couverture</span><input type="checkbox" id="pdf-cover" checked></label>
        <label class="s-toggle-row"><span>📑 Table des matières</span><input type="checkbox" id="pdf-toc"></label>
        <label class="s-toggle-row"><span>🎨 Fond décoratif (couverture)</span><input type="checkbox" id="pdf-decor"></label>
        <label class="s-toggle-row"><span>🖼 Photos plein-largeur</span><input type="checkbox" id="pdf-fullphotos"></label>
      </div>
    </div>

    <div class="fg">
      <label>Anecdote / citation en couverture <span style="font-weight:400;color:var(--ink4);font-size:10px">(optionnel)</span></label>
      <textarea id="pdf-anecdote" rows="2"
        placeholder="Une phrase mémorable de ce voyage…"
        style="width:100%;resize:vertical"></textarea>
    </div>

    <div class="ma">
      <button class="bc" onclick="closeModal()">Annuler</button>
      <button class="bs" id="pdf-go">✦ Générer</button>
    </div>`);

  // Format switch
  document.getElementById('pdf-fmt')?.addEventListener('click', e => {
    const b = e.target.closest('[data-pdf-fmt]');
    if (!b) return;
    _fmt = b.dataset.pdfFmt;
    document.querySelectorAll('#pdf-fmt [data-pdf-fmt]').forEach(x => {
      const s = x.dataset.pdfFmt === _fmt;
      x.classList.toggle('sel', s);
      x.style.background  = s ? '#0d9488' : '';
      x.style.borderColor = s ? '#0d9488' : '';
      x.style.color       = s ? '#fff' : '';
    });
  });

  // Theme switch
  document.getElementById('pdf-themes')?.addEventListener('click', e => {
    const b = e.target.closest('[data-pdf-theme]');
    if (!b) return;
    _theme = b.dataset.pdfTheme;
    document.querySelectorAll('#pdf-themes [data-pdf-theme]').forEach(x => {
      const t   = themes.find(t => t.key === x.dataset.pdfTheme);
      const sel = x.dataset.pdfTheme === _theme;
      x.classList.toggle('sel', sel);
      x.style.background  = sel ? t?.color : '';
      x.style.borderColor = sel ? t?.color : '';
      x.style.color       = sel ? '#fff' : '';
    });
  });

  // Generate
  document.getElementById('pdf-go')?.addEventListener('click', async () => {
    const sections = [];
    document.querySelectorAll('[data-pdf-sec]').forEach(cb => { if (cb.checked) sections.push(cb.dataset.pdfSec); });
    closeModal();
    const { exportTripCustom } = await import('./export.js');
    exportTripCustom(trip, {
      format:     _fmt,
      sections,
      theme:      _theme,
      cover:      document.getElementById('pdf-cover')?.checked      ?? true,
      toc:        document.getElementById('pdf-toc')?.checked        ?? false,
      decorBg:    document.getElementById('pdf-decor')?.checked      ?? false,
      fullPhotos: document.getElementById('pdf-fullphotos')?.checked ?? false,
      anecdote:   (document.getElementById('pdf-anecdote')?.value    || '').trim(),
    });
  });
}

function _duplicateTrip(trip) {
  const days = (trip.days || []).map(day => ({
    ...day,
    id:    'd_' + uid(),
    items: (day.items || []).map(item => ({ ...item, id: 'i_' + uid() })),
  }));
  const copy = addTrip({
    ...trip,
    id:        undefined,
    name:      (trip.name || 'Voyage') + ' (copie)',
    createdAt: undefined,
    updatedAt: undefined,
    days,
  });
  renderHome(_currentFilter);
  notify(`"${copy.name}" créé.`, '⧉');
}

// ── Export modal ──────────────────────────────────────────────────────────────

function _openExportModal() {
  const trips    = getTrips();
  const listHtml = trips.map(t => `
    <div class="exp-trip-row">
      <input type="checkbox" class="exp-cb" value="${t.id}" checked>
      <div class="exp-trip-info">
        <span class="exp-trip-lbl">${t.flag || '🌍'} ${_esc(t.name || 'Voyage')}</span>
        ${t.startDate ? `<span class="exp-trip-meta">${t.startDate.slice(0, 7)}</span>` : ''}
      </div>
    </div>`).join('');

  showModal(`
    <button class="mc" onclick="closeModal()">✕</button>
    <h3>⬇ Exporter des voyages</h3>
    <div class="fg" style="margin-bottom:10px">
      <label>Format d'export</label>
      <div class="t-row" id="exp-types">
        <button class="tp sel" data-exp-type="planning" style="background:#0d9488;border-color:#0d9488;color:#fff">📋 Planning</button>
        <button class="tp" data-exp-type="all">📦 Tout (avec photos)</button>
        <button class="tp" data-exp-type="csv">📊 CSV</button>
      </div>
    </div>
    <div class="fg">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <label style="margin-bottom:0">Voyages à exporter</label>
        <button id="exp-sel-all" style="font-size:11px;font-weight:700;color:var(--teal);background:none;border:none;cursor:pointer;padding:2px 6px">Tout désélectionner</button>
      </div>
      <div id="exp-trips-list" style="max-height:260px;overflow-y:auto;border:1px solid var(--c3);border-radius:8px;padding:4px 0">
        ${listHtml || '<p style="padding:12px;font-size:12px;color:var(--ink4)">Aucun voyage</p>'}
      </div>
    </div>
    <div id="exp-status" style="font-size:12px;color:var(--ink4);margin-top:8px;min-height:18px"></div>
    <div class="ma">
      <button class="bc" onclick="closeModal()">Annuler</button>
      <button class="bs" id="exp-go">Exporter</button>
    </div>`);

  let selectedType = 'planning';
  let allSelected  = true;

  document.getElementById('exp-types')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-exp-type]');
    if (!btn) return;
    selectedType = btn.dataset.expType;
    const colors = { planning: '#0d9488', all: '#7c3aed', csv: '#d97706' };
    document.querySelectorAll('#exp-types [data-exp-type]').forEach(b => {
      const sel = b.dataset.expType === selectedType;
      const col = colors[b.dataset.expType] || '#0d9488';
      b.classList.toggle('sel', sel);
      b.style.background  = sel ? col : '';
      b.style.borderColor = sel ? col : '';
      b.style.color       = sel ? '#fff' : '';
    });
  });

  document.getElementById('exp-sel-all')?.addEventListener('click', () => {
    allSelected = !allSelected;
    document.querySelectorAll('#exp-trips-list .exp-cb').forEach(cb => { cb.checked = allSelected; });
    document.getElementById('exp-sel-all').textContent = allSelected ? 'Tout désélectionner' : 'Tout sélectionner';
  });

  document.getElementById('exp-go')?.addEventListener('click', async () => {
    const checked = [...document.querySelectorAll('#exp-trips-list .exp-cb:checked')].map(cb => cb.value);
    const statusEl = document.getElementById('exp-status');
    if (!checked.length) { statusEl.textContent = 'Sélectionnez au moins un voyage.'; return; }
    const selectedTrips = checked.map(id => getTrip(id)).filter(Boolean);

    if (selectedType === 'csv') {
      const blob = new Blob(['﻿' + _buildCsv(selectedTrips.map(_tripToCsvRow))], { type: 'text/csv;charset=utf-8' });
      const date = new Date().toISOString().slice(0, 10);
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = `carnet-voyages_${date}.csv`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      closeModal();
      return;
    }

    statusEl.style.color = '';
    statusEl.textContent = 'Préparation…';
    try {
      const { downloadTripsZip } = await import('./export.js');
      await downloadTripsZip(selectedTrips, selectedType, (done, total) => {
        statusEl.textContent = `${done} / ${total} voyage${total > 1 ? 's' : ''}…`;
      });
      closeModal();
      notify(`${selectedTrips.length} voyage${selectedTrips.length > 1 ? 's' : ''} exporté${selectedTrips.length > 1 ? 's' : ''}`, '✅');
    } catch (err) {
      statusEl.style.color = 'var(--coral)';
      statusEl.textContent = err.message;
    }
  });
}
