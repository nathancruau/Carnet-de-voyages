/* ============================================================
   CARNET DE VOYAGES — Home / Library Screen
   ============================================================ */

import {
  getTrips, getState, addTrip, updateTrip, deleteTrip,
  TRIP_TYPES, COMP_COLORS, uid,
  getSettings, updateSettings,
  getEventTypes, DEFAULT_EVENT_TYPES,
  getLanguage, isTripShared,
} from './store.js';
import {
  notify, showModal, closeModal,
  fmtDate, fmtDateShort,
  dpInit, dpGetDates, renderDp,
  typeBadge,
  generateDays,
} from './utils.js';
// navigateToTrip / goMyMap accessed via window globals (set by app.js) to avoid circular import
import { importFile } from './import.js';
import { getCurrentUser, logout, syncToFirestore, isFirebaseConfigured } from './auth.js';
import { requestNotificationPermission, notificationPermissionGranted } from './notifications.js';
import { openShareModal, leaveSharedTrip, removeSharedTripMember, isCurrentUserObserver } from './share.js';

// ── Module state ───────────────────────────────────────────────────────────────

let _currentFilter    = 'all';
let _currentTab       = 'trips';   // 'trips' | 'stats'
let _statsTypeFilter  = 'all';     // 'all' | 'voyage' | 'weekend' | 'sortie'
let _homeLibTab       = 'mine';    // 'mine' | 'observing' | 'live'
let _listenerAttached = false;
let _statsLastFiltered = [];       // cache for world-map re-render on expand

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

const WEATHER_EMOJIS = ['☀️','🌤️','⛅','🌦️','🌧️','⛈️','🌨️','❄️','🌫️','💨','🌈'];

// ── Helpers ────────────────────────────────────────────────────────────────────

function _compColor(index) {
  return COMP_COLORS[index % COMP_COLORS.length];
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

async function _initWorldMap(trips) {
  const canvas = document.getElementById('world-map-canvas');
  if (!canvas) return;
  try {
    const [topoMod, worldData] = await Promise.all([
      import('https://cdn.jsdelivr.net/npm/topojson-client@3/+esm'),
      fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json').then(r => r.json()),
    ]);
    const countries  = topoMod.feature(worldData, worldData.objects.countries);
    const visitedMap = _getVisitedMap(trips);
    const { centroids, W, H } = _drawWorldMap(canvas, countries.features, visitedMap);

    // Hover tooltip
    const tooltip = document.getElementById('wm-tooltip');
    if (!tooltip) return;
    canvas.addEventListener('mousemove', e => {
      const rect = canvas.getBoundingClientRect();
      const mx = (e.clientX - rect.left) * (W / rect.width);
      const my = (e.clientY - rect.top)  * (H / rect.height);
      let best = null, bestDist = 28;
      for (const c of centroids) {
        const d = Math.hypot(c.cx - mx, c.cy - my);
        if (d < bestDist) { bestDist = d; best = c; }
      }
      if (best) {
        tooltip.style.display = 'block';
        tooltip.style.left = (e.clientX - rect.left + 10) + 'px';
        tooltip.style.top  = Math.max(0, e.clientY - rect.top - 36) + 'px';
        const name = _A2_NAME[best.code] || best.code;
        tooltip.innerHTML = `${_isoToFlag(best.code)} <b>${name}</b> · ${best.count} voyage${best.count > 1 ? 's' : ''}`;
      } else {
        tooltip.style.display = 'none';
      }
    });
    canvas.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
  } catch (err) {
    console.warn('[stats] world map failed:', err.message);
    const wrap = document.getElementById('world-map-wrap');
    if (wrap) wrap.style.display = 'none';
  }
}

function _drawWorldMap(canvas, features, visitedMap) {
  const dpr = window.devicePixelRatio || 1;
  const W   = canvas.clientWidth || 640;
  const H   = Math.round(W * 0.46);
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  const isDark = document.documentElement.dataset.theme === 'dark';

  // Intensity palette: 0 visits → muted, 1 → teal-400, 2 → teal-600, 3+ → teal-800
  const PALETTE_LIGHT = ['#e0dcd4', '#5eead4', '#0d9488', '#0f766e', '#134e4a'];
  const PALETTE_DARK  = ['#3a3834', '#99f6e4', '#2dd4bf', '#0d9488', '#0f766e'];
  const palette = isDark ? PALETTE_DARK : PALETTE_LIGHT;

  const proj = (lon, lat) => [
    (lon + 180) / 360 * W,
    (85 - lat) / 170 * H,
  ];

  const centroids = [];

  for (const feat of features) {
    const code  = _ISO_N_A2[Number(feat.id)] || '';
    const count = visitedMap.get(code) || 0;
    const ci    = Math.min(count, palette.length - 1);
    ctx.fillStyle   = palette[ci];
    ctx.strokeStyle = isDark ? '#252320' : '#faf7f2';
    ctx.lineWidth   = 0.4;

    const geom = feat.geometry;
    if (!geom) continue;
    const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;

    // Compute centroid from largest polygon for hover hit-testing
    let bestRingSize = 0, centX = 0, centY = 0;

    for (const poly of polys) {
      const ring = poly[0];
      ctx.beginPath();
      let prevLon = null;
      let sumX = 0, sumY = 0;
      ring.forEach(([lon, lat], i) => {
        const [x, y] = proj(lon, lat);
        sumX += x; sumY += y;
        if (i === 0 || (prevLon !== null && Math.abs(lon - prevLon) > 180)) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        prevLon = lon;
      });
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      if (ring.length > bestRingSize) {
        bestRingSize = ring.length;
        centX = sumX / ring.length;
        centY = sumY / ring.length;
      }
    }

    if (count > 0 && code) {
      centroids.push({ code, count, cx: centX, cy: centY });
    }
  }

  return { centroids, W, H };
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

  // Visited flags strip — normalise to ISO code so "🇫🇷" and "FR" merge into one entry
  const tripFlagMap = new Map(); // key = ISO-2 code
  for (const trip of trips) {
    if (!trip.flag) continue;
    const code = _isoFromFlag(trip.flag);
    if (!code) continue;
    const name = _A2_NAME[code] || trip.destination || trip.flag;
    const prev = tripFlagMap.get(code) || { name, count: 0 };
    tripFlagMap.set(code, { name, count: prev.count + 1 });
  }
  const flagsHtml = [...tripFlagMap.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([code, { name, count }]) =>
      `<span class="wm-flag-chip" title="${_esc(name)} · ${count} voyage${count > 1 ? 's' : ''}">${code}</span>`
    ).join('');

  // Continent pills
  const contPillsHtml = Object.entries(continentCount)
    .sort((a, b) => b[1] - a[1])
    .map(([cont, cnt]) => {
      const color = _CONTINENT_COLOR[cont] || '#0d9488';
      return `<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:700;background:${color}22;color:${color};border:1px solid ${color}44">${_CONTINENT_LABEL[cont]} <b>${cnt}</b></span>`;
    }).join('');

  // Map intensity legend
  const legendHtml = `
    <div style="display:flex;align-items:center;gap:5px;font-size:9px;color:var(--ink4)">
      <span>1 visite</span>
      <div style="display:flex;gap:2px">
        <div style="width:12px;height:10px;border-radius:2px;background:#5eead4"></div>
        <div style="width:12px;height:10px;border-radius:2px;background:#0d9488"></div>
        <div style="width:12px;height:10px;border-radius:2px;background:#0f766e"></div>
        <div style="width:12px;height:10px;border-radius:2px;background:#134e4a"></div>
      </div>
      <span>4+ visites</span>
    </div>`;

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

      <!-- World map — full width, first -->
      <div id="world-map-wrap" class="stat-card" style="margin-bottom:14px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;flex-wrap:wrap;gap:8px">
          <div style="display:flex;align-items:center;gap:8px">
            <h4 class="stat-card-title" style="margin-bottom:0">🌍 Pays visités</h4>
            <button id="wm-expand-btn" title="Plein écran">⛶ Plein écran</button>
          </div>
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            ${contPillsHtml}
            ${legendHtml}
            <span style="font-family:var(--sf);font-size:18px;font-weight:800;color:var(--teal)">${visitedCount}<span style="font-size:11px;font-weight:400;color:var(--ink4)"> / ~195</span></span>
          </div>
        </div>
        <div style="position:relative">
          <canvas id="world-map-canvas" class="world-map-canvas" aria-label="Carte du monde des pays visités"></canvas>
          <div id="wm-tooltip" class="wm-tooltip"></div>
        </div>
        ${flagsHtml ? `<div class="wm-flags-strip">${flagsHtml}</div>` : ''}
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
          <div class="hero-logo">Carnet de Voyages</div>
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

  const dateStr = pin.date
    ? new Date(pin.date + 'T12:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })
    : (trip.startDate ? fmtDate(trip.startDate) : 'Date non définie');

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
          <button class="tc-edit-btn" data-action="edit-trip" data-trip-id="${trip.id}" title="Modifier">✎</button>
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
  if (Array.isArray(trip.budgetLines) && trip.budgetLines.length > 0) {
    const total = trip.budgetLines.reduce((s, b) => s + (Number(b.amount) || 0), 0);
    if (total > 0) stats.push(`${total.toLocaleString('fr-FR')} €`);
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

// ── Live feed (En direct) ──────────────────────────────────────────────────────

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
  posts.sort((a, b) => (b.ts || 0) - (a.ts || 0));

  if (posts.length === 0) {
    return `<div style="text-align:center;padding:50px 20px;color:var(--ink4)">
      <div style="font-size:44px;margin-bottom:12px">📡</div>
      <div style="font-size:15px;font-weight:600;color:var(--ink3)">Aucune publication pour l'instant</div>
      <div style="font-size:12px;margin-top:6px">Les voyageurs publieront leurs aventures au fil du voyage</div>
    </div>`;
  }

  return posts.map(({ trip, day, item }) => {
    const jd      = item.journalData;
    const photos  = jd.photos || [];
    const ts      = jd.validatedAt;
    const dateStr = ts
      ? new Date(ts).toLocaleDateString('fr-FR', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' })
      : '';
    const dayInfo = `Jour ${day.num}${day.title ? ' · ' + _esc(day.title) : ''}`;

    return `<div class="live-post">
      <div class="live-post-hd">
        <div class="live-post-badge" style="background:${trip.color||'#0d9488'}">${trip.flag||'🌍'} <span>${_esc(trip.name)}</span></div>
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
          <div class="live-post-day">${dayInfo}${item.text ? ` · <strong style="color:var(--ink)">${_esc(item.text)}</strong>` : ''}</div>
          ${dateStr ? `<div class="live-post-time">${dateStr}</div>` : ''}
        </div>
      </div>
      ${photos.length > 0 ? `<div class="live-post-photos">${photos.map(src =>
        `<img src="${_esc(src)}" class="live-photo" loading="lazy" onclick="window.open(this.src,'_blank')">`
      ).join('')}</div>` : ''}
      ${jd.notes ? `<div class="live-post-notes">${_esc(jd.notes).replace(/\n/g,'<br>')}</div>` : ''}
    </div>`;
  }).join('');
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

  // Inline tab switcher — lives inside home-sec-hd so it adds no extra row
  const tabSwitcher = `
    <div class="hl-tabs hl-tabs-inline">
      <button class="hl-tab${_homeLibTab === 'mine' ? ' active' : ''}" data-action="lib-tab" data-tab="mine">🧳 Mes voyages</button>
      <button class="hl-tab${_homeLibTab === 'observing' ? ' active' : ''}" data-action="lib-tab" data-tab="observing">🔭 Mes observations${observingTrips.length > 0 ? `<span class="hl-tab-badge">${observingTrips.length}</span>` : ''}</button>
      <button class="hl-tab${_homeLibTab === 'live' ? ' active' : ''}" data-action="lib-tab" data-tab="live">📡 En direct</button>
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
        ${_buildLiveFeedHtml(observingTrips)}
      </div>`;
    if (!_listenerAttached) { _attachListeners(wrap); _listenerAttached = true; }
    return;
  }

  let secContent;
  if (_homeLibTab === 'live') {
    secContent = `
      <div class="home-sec-hd">
        ${tabSwitcher}
      </div>
      ${_buildLiveFeedHtml(observingTrips)}`;
  } else if (_homeLibTab === 'observing') {
    secContent = `
      <div class="home-sec-hd">
        ${tabSwitcher}
      </div>
      ${observingTrips.length === 0 ? `
        <div style="text-align:center;padding:40px 16px;color:var(--ink4)">
          <div style="font-size:36px;margin-bottom:10px">🔭</div>
          <div style="font-size:14px;font-weight:600;margin-bottom:6px">Aucun voyage suivi</div>
          <div style="font-size:12px">Rejoignez un voyage en tant qu'observateur<br>avec le lien d'invitation du voyageur.</div>
        </div>` : `
        <div class="trips-grid" id="trips-grid">
          ${observingTrips.map(_tripCardHtml).join('')}
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
    ${_heroHtml(allTrips)}
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

  // Home FAB toggle
  const homeFab  = document.getElementById('home-fab');
  const fabMenu  = document.getElementById('home-fab-menu');
  if (homeFab && fabMenu) {
    homeFab.addEventListener('click', e => {
      e.stopPropagation();
      const open = fabMenu.classList.toggle('visible');
      homeFab.classList.toggle('open', open);
    });
    document.addEventListener('click', () => {
      fabMenu.classList.remove('visible');
      homeFab.classList.remove('open');
    });
  }
}


function _renderStats() {
  _currentTab = 'stats';
  const wrap = document.getElementById('home-wrap');
  if (!wrap) return;
  const allTrips  = getTrips();
  const doneTrips = allTrips.filter(t => t.status === 'done');
  const filtered  = _statsTypeFilter === 'all' ? doneTrips : doneTrips.filter(t => t.type === _statsTypeFilter);
  _statsLastFiltered = filtered;

  wrap.innerHTML = `
    ${_heroHtml(allTrips)}
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
    requestAnimationFrame(() => _initWorldMap(_statsLastFiltered));
  });

  requestAnimationFrame(() => _initWorldMap(filtered));
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

  function _etRowHtml(et, i) {
    const isProtected = et.key === 'sleep';
    return `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px" data-et-row="${i}">
        <input type="hidden" data-et-key="${i}" value="${_esc(et.key)}">
        <input type="text" data-et-emoji="${i}" value="${_esc(et.emoji)}"
          style="width:48px;text-align:center;font-size:18px;padding:4px;border:1.5px solid var(--c3);border-radius:7px;background:var(--c)">
        <input type="text" data-et-label="${i}" value="${_esc(et.label)}" placeholder="Nom du type"
          style="flex:1;padding:5px 8px;border:1.5px solid var(--c3);border-radius:7px;font-size:12px;background:var(--c)">
        <input type="color" data-et-color="${i}" value="${_esc(et.color || '#0d9488')}"
          style="width:34px;height:30px;padding:2px;border:1.5px solid var(--c3);border-radius:7px;cursor:pointer;background:var(--c)">
        ${isProtected
          ? `<span style="display:inline-flex;align-items:center;justify-content:center;width:28px;height:30px;font-size:14px;color:var(--ink4);flex-shrink:0" title="Ce type est protégé et ne peut pas être supprimé">🔒</span>`
          : `<button type="button" data-et-del="${i}" style="background:var(--crl,#fee2e2);color:var(--coral,#e85d3e);border:none;border-radius:6px;padding:4px 8px;font-size:12px;cursor:pointer;flex-shrink:0">✕</button>`
        }
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
        <div style="font-size:11px;color:var(--ink4);margin-bottom:8px">Types disponibles pour les événements du planning.</div>
        <div id="et-rows">${curEventTypes.map(_etRowHtml).join('')}</div>
        <button type="button" id="et-add"
          style="margin-top:6px;background:var(--c2);border:1.5px solid var(--c3);border-radius:7px;padding:5px 12px;font-size:12px;font-weight:700;cursor:pointer;color:var(--ink3)">
          ＋ Ajouter un type
        </button>
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
        <button class="bc" onclick="closeModal()">Annuler</button>
        <button class="bs" id="settings-save">Enregistrer</button>
      </div>`;
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

  // ── Event type add/delete ────────────────────────────────────────────────────

  function reRenderEtRows(types) {
    const el = document.getElementById('et-rows');
    if (el) { el.innerHTML = types.map(_etRowHtml).join(''); attachEtDelete(); }
  }

  function attachEtDelete() {
    document.getElementById('et-rows')?.addEventListener('click', e => {
      const btn = e.target.closest('[data-et-del]');
      if (!btn) return;
      const types = collectEventTypes();
      const idx = parseInt(btn.dataset.etDel, 10);
      if (types[idx]?.key === 'sleep') return;
      types.splice(idx, 1);
      reRenderEtRows(types);
    });
  }
  attachEtDelete();

  document.getElementById('notif-enabled')?.addEventListener('change', e => {
    const sub = document.getElementById('notif-sub');
    if (sub) {
      sub.style.opacity = e.target.checked ? '1' : '0.45';
      sub.style.pointerEvents = e.target.checked ? '' : 'none';
    }
  });

  document.getElementById('et-add')?.addEventListener('click', () => {
    const types = collectEventTypes();
    types.push({ key: 'evt_' + uid(), emoji: '📌', label: 'Nouveau type', color: '#0d9488' });
    reRenderEtRows(types);
  });

  // ── Clear / save ─────────────────────────────────────────────────────────────

  document.getElementById('settings-clear-data')?.addEventListener('click', () => {
    if (confirm('Effacer TOUTES les données (voyages, journal, bagages) ? Cette action est irréversible.')) {
      localStorage.clear();
      location.reload();
    }
  });

  document.getElementById('settings-save')?.addEventListener('click', async () => {
    const newEventTypes = collectEventTypes();
    const lang    = document.querySelector('input[name="lang-sel"]:checked')?.value || 'fr';
    const theme   = document.querySelector('input[name="theme-sel"]:checked')?.value || 'light';
    const notifEnabled       = document.getElementById('notif-enabled')?.checked ?? false;
    const notifDep           = document.getElementById('notif-departure')?.checked ?? true;
    const notifCollab        = document.getElementById('notif-collaborative')?.checked ?? true;
    const notifObsPublish    = document.getElementById('notif-observer-publish')?.checked ?? true;
    const grandParentsMode   = document.getElementById('gp-mode')?.checked ?? false;

    updateSettings({
      eventTypes: newEventTypes.length > 0 ? newEventTypes : DEFAULT_EVENT_TYPES,
      lang,
      theme,
      notifications: { enabled: notifEnabled, departure: notifDep, collaborative: notifCollab, observerPublish: notifObsPublish },
      grandParentsMode,
    });

    // Apply theme immediately
    const root = document.documentElement;
    if (theme === 'dark') root.dataset.theme = 'dark';
    else if (theme === 'auto') root.dataset.theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : '';
    else delete root.dataset.theme;

    // Request notification permission if just enabled
    if (notifEnabled && !notificationPermissionGranted()) {
      const granted = await requestNotificationPermission();
      if (!granted) notify('Permission refusée par le navigateur', '⚠️');
    }

    notify('Paramètres enregistrés', '✅');
    closeModal();
    // Re-render home immediately so grands-parents mode applies without restart
    if (_currentTab === 'trips' || _currentTab === 'stats') {
      _currentTab === 'stats' ? _renderStats() : renderHome(_currentFilter);
    } else {
      renderHome(_currentFilter);
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
        _downloadCsv(_buildCsv(getTrips().map(_tripToCsvRow)), 'carnet-voyages.csv');
        break;

      case 'new-trip':
        openEditTripModal(null, target.dataset.type || null);
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

      case 'go-home':
        renderHome(_currentFilter);
        break;

      case 'lib-tab':
        _homeLibTab = target.dataset.tab;
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

function _compsListHtml() {
  if (_modalComps.length === 0) {
    return `<div style="font-size:11px;color:var(--ink4);font-style:italic">Aucun compagnon pour l'instant</div>`;
  }
  return _modalComps.map((c, i) => {
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

function _buildSortieModalHtml(trip) {
  const isEdit      = _editingId !== null;
  const pin         = trip?.pin || {};
  const name        = trip?.name        || '';
  const destination = trip?.destination || '';
  const photo       = trip?.photo       || '';

  // Seed sortie state from existing trip
  _sortieLat         = pin.lat  ?? null;
  _sortieLng         = pin.lng  ?? null;
  _sortieWeather     = pin.weather || null;
  _sortiePinType     = pin.pinType || 'visit';
  _sortiePhotoMode   = 'url';
  _sortiePhotoBase64 = null;

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

  const photoSection = `
    <div class="fg">
      <label>Photo</label>
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

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 14px">
      <div class="fg">
        <label>Nom du lieu / destination</label>
        <input type="text" id="sm-dest" value="${_esc(destination)}"
               placeholder="Forêt de Fontainebleau…" autocomplete="off">
      </div>
      <div></div>
      <div class="fg">
        <label>Date</label>
        <input type="date" id="sm-date" value="${_esc(pin.date || '')}" autocomplete="off">
      </div>
      <div class="fg">
        <label>Heure</label>
        <input type="time" id="sm-time" value="${_esc(pin.time || '')}" autocomplete="off">
      </div>
    </div>

    <div class="fg">
      <label>Type de point</label>
      <div class="t-row" id="sm-pin-types">${pinTypePills}</div>
    </div>

    <div class="fg">
      <label>Description / notes</label>
      <textarea id="sm-desc" rows="3" placeholder="Notes sur cette sortie…">${_esc(pin.description || '')}</textarea>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 14px">
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

  const date        = document.getElementById('sm-date')?.value || null;
  const time        = (document.getElementById('sm-time')?.value || '').trim();
  const description = (document.getElementById('sm-desc')?.value || '').trim();
  const cost        = parseFloat(document.getElementById('sm-cost')?.value || '0') || 0;
  const destination = (document.getElementById('sm-dest')?.value || '').trim();

  let photo;
  if (_sortiePhotoMode === 'file' && _sortiePhotoBase64) {
    photo = _sortiePhotoBase64;
  } else {
    photo = (document.getElementById('sm-photo')?.value || '').trim();
  }

  _cleanupSortieModalMap();

  // Reverse-geocode the pin position to get the country flag emoji
  // so MyMap can assign the correct country color.
  let flag = '🎯';
  if (_sortieLat != null && _sortieLng != null) {
    try {
      const r = await fetch(
        `https://nominatim.openstreetmap.org/reverse?lat=${_sortieLat}&lon=${_sortieLng}&format=json`
      );
      const d = await r.json();
      const cc = (d.address?.country_code || '').toUpperCase();
      if (cc.length === 2) {
        flag = String.fromCodePoint(
          cc.charCodeAt(0) - 65 + 0x1F1E6,
          cc.charCodeAt(1) - 65 + 0x1F1E6
        );
      }
    } catch (_) { /* keep default */ }
  }

  const pin = {
    lat:         _sortieLat,
    lng:         _sortieLng,
    pinType:     _sortiePinType,
    date,
    time,
    description,
    weather:     _sortieWeather,
    cost,
    currency:    'EUR',
  };

  const data = {
    name,
    destination,
    photo,
    color:     '#d97706',
    flag,
    type:      'sortie',
    status:    'done',
    startDate: date,
    endDate:   date,
    pin,
    companions: [],
    multiCountry: false,
  };

  if (_editingId) {
    updateTrip(_editingId, data);
    notify('Sortie mise à jour !', '✅');
  } else {
    addTrip(data);
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
      ${isEdit ? `<button class="bd" id="m-delete">🗑 Supprimer</button>` : ''}
      ${isEdit ? `<button class="bc" id="m-export">⬇ Exporter</button>` : ''}
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
    showModal(_buildSortieModalHtml(trip), { onClose: _cleanupSortieModalMap });
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

  // Photo URL preview
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
      } else {
        photoPreview.style.display = 'none';
      }
    });
  }

  // Photo file input
  document.getElementById('m-photo-file')?.addEventListener('change', ev => {
    const file = ev.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      _photoBase64 = e.target.result;
      const preview = document.getElementById('m-photo-preview');
      if (preview) {
        preview.src          = _photoBase64;
        preview.style.display = 'block';
      }
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
      showModal(_buildSortieModalHtml(null), { onClose: _cleanupSortieModalMap });
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
  const addCompFn = () => {
    const name = compInput?.value.trim();
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

  document.getElementById('m-comp-add')?.addEventListener('click', addCompFn);
  compInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addCompFn(); }
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

  // Delete
  document.getElementById('m-delete')?.addEventListener('click', _handleDelete);

  // Cancel
  document.getElementById('m-cancel')?.addEventListener('click', closeModal);

  // Export single trip — full JSON (all data)
  document.getElementById('m-export')?.addEventListener('click', () => {
    const t = getTrips().find(tr => tr.id === _editingId);
    if (!t) return;
    const safeName = (t.name || 'voyage').replace(/[^a-zA-Z0-9À-ɏ_-]/g, '-');
    const json = JSON.stringify(t, null, 2);
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `voyage-${safeName}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    notify('Voyage exporté (JSON complet)', '⬇');
  });
}

function _refreshCompList() {
  const list = document.getElementById('m-comp-list');
  // Only replace innerHTML — the click listener on the container
  // was already attached in _initModalListeners and survives innerHTML updates.
  if (list) list.innerHTML = _compsListHtml();
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

  // Resolve photo value: file mode uses base64, URL mode reads input
  let photo;
  if (_photoMode === 'file' && _photoBase64) {
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

// ── Import modal ───────────────────────────────────────────────────────────────

function _openImportModal() {
  showModal(`
    <button class="mc" onclick="closeModal()">✕</button>
    <h3>⬆ Importer des voyages</h3>
    <p style="font-size:13px;color:var(--ink3);margin-bottom:12px">
      Importez depuis un fichier <strong>JSON</strong> (voyage exporté depuis l'appli), <strong>KML</strong> (Google Earth) ou <strong>CSV</strong>.
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
      <label>Fichier JSON, KML ou CSV</label>
      <input type="file" id="imp-file" accept=".kml,.csv,.json" class="mi"
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
    const file = fileInput?.files?.[0];
    if (!file) {
      document.getElementById('imp-status').textContent = 'Veuillez sélectionner un fichier.';
      return;
    }
    document.getElementById('imp-status').textContent = 'Import en cours…';
    await importFile(file, selectedType, count => {
      closeModal();
      renderHome(_currentFilter);
    });
  });
}
