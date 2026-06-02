/* ============================================================
   CARNET DE VOYAGES — Home / Library Screen
   ============================================================ */

import {
  getTrips, addTrip, updateTrip, deleteTrip,
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
import { getCurrentUser, logout, isFirebaseConfigured } from './auth.js';
import { requestNotificationPermission, notificationPermissionGranted } from './notifications.js';
import { openShareModal, leaveSharedTrip, removeSharedTripMember } from './share.js';

// ── Module state ───────────────────────────────────────────────────────────────

let _currentFilter    = 'all';
let _currentTab       = 'trips';   // 'trips' | 'stats'
let _listenerAttached = false;

// Companion list being edited in the open modal
let _modalComps  = [];
let _modalColor  = '#0d9488';
let _modalType   = 'voyage';
let _modalStatus = 'planning';
let _editingId   = null;

// Photo file mode state
let _photoMode   = 'url';   // 'url' | 'file'
let _photoBase64 = null;

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

function _getVisitedCodes(trips) {
  const codes = new Set();
  for (const trip of trips) {
    if (trip.countryCode) { codes.add(trip.countryCode.toUpperCase()); continue; }
    const dest = (trip.destination || '').toLowerCase().trim();
    if (!dest) continue;
    if (_DEST_TO_A2[dest]) { codes.add(_DEST_TO_A2[dest]); continue; }
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
  }
  return [...codes];
}

async function _initWorldMap(trips) {
  const canvas = document.getElementById('world-map-canvas');
  if (!canvas) return;
  try {
    const [topoMod, worldData] = await Promise.all([
      import('https://cdn.jsdelivr.net/npm/topojson-client@3/+esm'),
      fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json').then(r => r.json()),
    ]);
    const countries = topoMod.feature(worldData, worldData.objects.countries);
    const visited   = new Set(_getVisitedCodes(trips));
    _drawWorldMap(canvas, countries.features, visited);
  } catch (err) {
    console.warn('[stats] world map failed:', err.message);
    const wrap = document.getElementById('world-map-wrap');
    if (wrap) wrap.style.display = 'none';
  }
}

function _drawWorldMap(canvas, features, visitedSet) {
  const dpr = window.devicePixelRatio || 1;
  const W   = canvas.clientWidth || 600;
  const H   = Math.round(W * 0.46);
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  const isDark = document.documentElement.dataset.theme === 'dark';
  const proj = (lon, lat) => [
    (lon + 180) / 360 * W,
    (85 - lat) / 170 * H,
  ];
  for (const feat of features) {
    const code = _ISO_N_A2[Number(feat.id)] || '';
    ctx.fillStyle   = visitedSet.has(code) ? (isDark ? '#f0ede6' : '#1c1a17') : (isDark ? '#3a3834' : '#e0dcd4');
    ctx.strokeStyle = isDark ? '#252320' : '#faf7f2';
    ctx.lineWidth   = 0.4;
    const geom = feat.geometry;
    if (!geom) continue;
    const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
    for (const poly of polys) {
      const ring = poly[0];
      ctx.beginPath();
      let prevLon = null;
      ring.forEach(([lon, lat], i) => {
        const [x, y] = proj(lon, lat);
        if (i === 0 || (prevLon !== null && Math.abs(lon - prevLon) > 180)) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
        prevLon = lon;
      });
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }
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

  const tripsWithDates = trips.filter(t => t.startDate && t.endDate);
  let avgDays = 0;
  if (tripsWithDates.length > 0) {
    const totalD = tripsWithDates.reduce((sum, t) =>
      sum + Math.round((new Date(t.endDate + 'T12:00:00') - new Date(t.startDate + 'T12:00:00')) / 86400000) + 1, 0);
    avgDays = Math.round(totalD / tripsWithDates.length);
  }

  // Visited countries
  const visitedCodes = _getVisitedCodes(trips);
  const visitedCount = visitedCodes.length;

  // Self expenses (non-shared trips only)
  let selfSpent = 0;
  for (const t of trips) {
    if (!isTripShared(t.id)) {
      for (const exp of (t.realExpenses || [])) {
        if (exp.type !== 'transfer') selfSpent += Number(exp.amount) || 0;
      }
    }
  }

  // Top destinations
  const destCount = {};
  trips.forEach(t => { const d = (t.destination || '').trim(); if (d) destCount[d] = (destCount[d] || 0) + 1; });
  const topDests = Object.entries(destCount).sort((a, b) => b[1] - a[1]).slice(0, 5);

  // Per year
  const perYear = {};
  trips.forEach(t => { const y = (t.startDate || t.createdAt || '').slice(0, 4); if (y) perYear[y] = (perYear[y] || 0) + 1; });
  const years = Object.keys(perYear).sort();
  const maxPerYear = Math.max(...Object.values(perYear), 1);

  // Budget total
  let totalBudget = 0;
  trips.forEach(t => { if (Array.isArray(t.budgetLines)) totalBudget += t.budgetLines.reduce((s, b) => s + (Number(b.amount) || 0), 0); });

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
    return `<div style="margin-bottom:8px">
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px">
        <span>${meta}</span>
        <span style="font-weight:700;color:var(--ink)">${Math.round(dist).toLocaleString('fr-FR')} km</span>
      </div>
      <div style="background:var(--c3);border-radius:4px;height:6px;overflow:hidden">
        <div style="width:${pct}%;height:100%;background:var(--teal);border-radius:4px"></div>
      </div></div>`;
  }).join('');

  // Spending by month
  const spendByMonth = _calcSpendingByMonth(trips);
  const spendMonths  = Object.keys(spendByMonth).sort().slice(-12);
  const maxSpend     = Math.max(...spendMonths.map(m => spendByMonth[m]), 1);
  const spendBars = spendMonths.map(m => {
    const val  = spendByMonth[m];
    const barH = Math.max(Math.round((val / maxSpend) * 60), 4);
    const [yr, mo] = m.split('-');
    const label = new Date(Number(yr), Number(mo) - 1, 1).toLocaleDateString('fr-FR', { month: 'short' }) + ' ' + yr.slice(2);
    return `<div style="display:flex;flex-direction:column;align-items:center;gap:3px;min-width:32px">
      <div style="font-size:9px;font-weight:700;color:var(--ink3)">${Math.round(val)}</div>
      <div style="width:22px;background:var(--amb);border-radius:3px 3px 0 0;height:${barH}px"></div>
      <div style="font-size:8px;color:var(--ink4);writing-mode:vertical-rl;transform:rotate(180deg);white-space:nowrap">${label}</div>
    </div>`;
  }).join('');

  const perYearBars = years.map(y => {
    const count = perYear[y];
    const barH  = Math.max(Math.round((count / maxPerYear) * 80), 8);
    return `<div style="display:flex;flex-direction:column;align-items:center;gap:4px;min-width:36px">
      <div style="font-size:10px;font-weight:700;color:var(--ink3)">${count}</div>
      <div style="width:28px;background:var(--teal);border-radius:4px 4px 0 0;height:${barH}px;transition:height .3s"></div>
      <div style="font-size:10px;color:var(--ink4);transform:rotate(-45deg);white-space:nowrap;transform-origin:center;margin-top:2px">${y}</div>
    </div>`;
  }).join('');

  const topDestsHtml = topDests.length
    ? topDests.map(([dest, cnt]) => `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--c3)">
          <span style="font-size:13px;color:var(--ink)">${_esc(dest)}</span>
          <span style="font-size:12px;font-weight:700;color:var(--teal)">${cnt} voyage${cnt > 1 ? 's' : ''}</span>
        </div>`).join('')
    : `<div style="font-size:12px;color:var(--ink4)">Aucune destination renseignée</div>`;

  const _sc = 'background:var(--c2);border-radius:10px;padding:9px 14px;text-align:center;min-width:68px';
  const _sv = 'font-family:var(--sf);font-size:20px;font-weight:700;color:var(--ink)';
  const _sl = 'font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--ink3);margin-top:2px';

  return `
    <div style="max-width:700px;margin:0 auto;padding:8px 0">
      <div style="font-size:10px;color:var(--ink4);margin-bottom:12px;display:flex;align-items:center;gap:5px">
        <span>📊</span> Statistiques calculées sur les <strong>${trips.length}</strong> voyage${trips.length > 1 ? 's' : ''} réalisé${trips.length > 1 ? 's' : ''}
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:10px;margin-bottom:24px">
        <div style="${_sc}"><div style="${_sv}">${trips.length}</div><div style="${_sl}">Voyages</div></div>
        <div style="${_sc}"><div style="${_sv}">${s.totalDays}</div><div style="${_sl}">Jours voyagés</div></div>
        <div style="${_sc}"><div style="${_sv}">${visitedCount}</div><div style="${_sl}">Pays visités</div></div>
        <div style="${_sc}"><div style="${_sv}">${avgDays}</div><div style="${_sl}">Durée moy. (j)</div></div>
        ${totalKm > 0 ? `<div style="${_sc}"><div style="${_sv}">${Math.round(totalKm).toLocaleString('fr-FR')}</div><div style="${_sl}">km parcourus</div></div>` : ''}
        ${s.totalSpent > 0 ? `<div style="${_sc}"><div style="${_sv}">${Math.round(s.totalSpent).toLocaleString('fr-FR')} €</div><div style="${_sl}">Total dépensé</div></div>` : ''}
        ${selfSpent > 0 && selfSpent !== s.totalSpent ? `<div style="${_sc}"><div style="${_sv}">${Math.round(selfSpent).toLocaleString('fr-FR')} €</div><div style="${_sl}">Dépenses perso.</div></div>` : ''}
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
        <div style="background:var(--c2);border-radius:12px;padding:16px">
          <h4 style="font-size:13px;font-weight:700;color:var(--ink3);margin-bottom:12px">🏆 Top destinations</h4>
          ${topDestsHtml}
        </div>
        <div style="background:var(--c2);border-radius:12px;padding:16px">
          <h4 style="font-size:13px;font-weight:700;color:var(--ink3);margin-bottom:12px">📅 Voyages par année</h4>
          ${years.length > 0
            ? `<div style="display:flex;align-items:flex-end;gap:6px;height:130px;padding-bottom:26px;overflow-x:auto">${perYearBars}</div>`
            : `<div style="font-size:12px;color:var(--ink4)">Aucune date renseignée</div>`}
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
        ${totalKm > 0 ? `
        <div style="background:var(--c2);border-radius:12px;padding:16px">
          <h4 style="font-size:13px;font-weight:700;color:var(--ink3);margin-bottom:12px">🛣️ Distances par mode (estimation)</h4>
          ${kmRows}
          <div style="font-size:10px;color:var(--ink4);margin-top:8px">Total : ${Math.round(totalKm).toLocaleString('fr-FR')} km</div>
        </div>` : ''}
        ${spendMonths.length > 0 ? `
        <div style="background:var(--c2);border-radius:12px;padding:16px">
          <h4 style="font-size:13px;font-weight:700;color:var(--ink3);margin-bottom:12px">💶 Dépenses par mois</h4>
          <div style="display:flex;align-items:flex-end;gap:4px;height:100px;padding-bottom:22px;overflow-x:auto">${spendBars}</div>
          <div style="font-size:10px;color:var(--ink4);margin-top:4px">Total : ${Math.round(s.totalSpent).toLocaleString('fr-FR')} €</div>
        </div>` : ''}
      </div>

      <div id="world-map-wrap" style="background:var(--c2);border-radius:12px;padding:16px;margin-bottom:16px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <h4 style="font-size:13px;font-weight:700;color:var(--ink3)">🌍 Pays visités</h4>
          <span style="font-family:var(--sf);font-size:18px;font-weight:700;color:var(--teal)">${visitedCount}<span style="font-size:11px;font-weight:400;color:var(--ink4)"> / ~195</span></span>
        </div>
        <canvas id="world-map-canvas" class="world-map-canvas" width="600" height="276" aria-label="Carte du monde des pays visités"></canvas>
      </div>
    </div>
  `;
}

// ── Hero HTML ──────────────────────────────────────────────────────────────────

function _heroHtml(trips) {
  const s = _calcStats(trips);
  const user = getCurrentUser();
  const userHtml = user ? `
    <div class="user-pill">
      ${user.photoURL ? `<img src="${_esc(user.photoURL)}" class="user-av" referrerpolicy="no-referrer">` : ''}
      <span class="user-nm">${_esc(user.displayName || user.email || '')}</span>
      <button data-action="logout" class="logout-btn">Déconnexion</button>
    </div>
  ` : '';
  return `
    <div class="hero">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;width:100%">
        <div>
          <div class="hero-logo">Carnet de Voyages</div>
          <div class="hero-sub">Planifiez, organisez et vivez vos aventures</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          ${userHtml}
          <button class="btn-new" data-action="open-import" title="Importer KML/CSV">⬆ Importer</button>
          <button class="btn-new" data-action="export-all" title="Exporter tous les voyages en CSV">⬇ Exporter</button>
          <button class="btn-new" data-action="show-stats">📊 Statistiques</button>
          <button class="btn-new" data-action="open-mymap">🗺 MyMap</button>
          <button class="btn-new" data-action="open-settings" title="Paramètres" style="padding:6px 10px;font-size:16px;line-height:1">⚙️</button>
        </div>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;width:100%">
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
        <input id="global-search" type="search" placeholder="🔍 Rechercher…" class="hero-search-input" autocomplete="off" style="width:220px;flex-shrink:0">
      </div>
    </div>
  `;
}

// ── Filter tabs HTML ───────────────────────────────────────────────────────────

function _filterTabsHtml(activeFilter, activeTab) {
  const tabs = [
    { key: 'all',     label: 'Tous' },
    { key: 'voyage',  label: 'Voyages' },
    { key: 'weekend', label: 'Week-ends' },
    { key: 'sortie',  label: 'Sorties' },
  ];
  const filterBtns = tabs.map(t =>
    `<button class="filter-tab${activeTab === 'trips' && activeFilter === t.key ? ' active' : ''}"
             data-action="filter" data-filter="${t.key}">${t.label}</button>`
  ).join('');
  return `<div class="filter-tabs">${filterBtns}</div>`;
}

// ── Trip card HTML ─────────────────────────────────────────────────────────────

function _tripCardHtml(trip) {
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

  wrap.innerHTML = `
    ${_heroHtml(allTrips)}
    <div class="home-sec">
      <div class="home-sec-hd">
        <h2>Mes voyages</h2>
        <button class="btn-new" data-action="new-trip">＋ Nouveau</button>
      </div>
      ${_filterTabsHtml(filter, 'trips')}
      <div id="search-results-area" class="sr-area" style="display:none"></div>
      <div class="trips-grid" id="trips-grid">
        ${sorted.map(_tripCardHtml).join('')}
        ${_addCardHtml()}
      </div>
    </div>
  `;

  // Attach the click listener only once; subsequent renderHome calls reuse it
  if (!_listenerAttached) {
    _attachListeners(wrap);
    _listenerAttached = true;
  }
}

function _renderStats() {
  _currentTab = 'stats';
  const wrap = document.getElementById('home-wrap');
  if (!wrap) return;
  const allTrips  = getTrips();
  const doneTrips = allTrips.filter(t => t.status === 'done');

  wrap.innerHTML = `
    ${_heroHtml(allTrips)}
    <div class="home-sec">
      <div class="home-sec-hd">
        <h2>Statistiques</h2>
        <button class="btn-new" data-action="new-trip">＋ Nouveau</button>
      </div>
      ${_filterTabsHtml(_currentFilter, 'stats')}
      <div id="search-results-area" class="sr-area" style="display:none"></div>
      <div id="stats-view" style="padding:8px 0">
        ${_statsViewHtml(doneTrips)}
      </div>
    </div>
  `;

  if (!_listenerAttached) {
    _attachListeners(wrap);
    _listenerAttached = true;
  }

  requestAnimationFrame(() => _initWorldMap(doneTrips));
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
    return `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px" data-et-row="${i}">
        <input type="hidden" data-et-key="${i}" value="${_esc(et.key)}">
        <input type="text" data-et-emoji="${i}" value="${_esc(et.emoji)}"
          style="width:48px;text-align:center;font-size:18px;padding:4px;border:1.5px solid var(--c3);border-radius:7px;background:var(--c)">
        <input type="text" data-et-label="${i}" value="${_esc(et.label)}" placeholder="Nom du type"
          style="flex:1;padding:5px 8px;border:1.5px solid var(--c3);border-radius:7px;font-size:12px;background:var(--c)">
        <input type="color" data-et-color="${i}" value="${_esc(et.color || '#0d9488')}"
          style="width:34px;height:30px;padding:2px;border:1.5px solid var(--c3);border-radius:7px;cursor:pointer;background:var(--c)">
        <button type="button" data-et-del="${i}" style="background:var(--crl,#fee2e2);color:var(--coral,#e85d3e);border:none;border-radius:6px;padding:4px 8px;font-size:12px;cursor:pointer">✕</button>
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
          </div>
        </div>
        <div style="font-size:10px;color:var(--ink4);margin-top:5px">Requiert l'autorisation du navigateur. Désactivé par défaut.</div>
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
      types.splice(parseInt(btn.dataset.etDel, 10), 1);
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
    const notifEnabled  = document.getElementById('notif-enabled')?.checked ?? false;
    const notifDep      = document.getElementById('notif-departure')?.checked ?? true;
    const notifCollab   = document.getElementById('notif-collaborative')?.checked ?? true;

    updateSettings({
      eventTypes: newEventTypes.length > 0 ? newEventTypes : DEFAULT_EVENT_TYPES,
      lang,
      theme,
      notifications: { enabled: notifEnabled, departure: notifDep, collaborative: notifCollab },
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
        logout().then(() => {
          localStorage.removeItem('carnet_voyages_v1');
          window.location.reload();
        });
        break;

      case 'open-mymap':
        window.goMyMap();
        break;

      case 'open-import':
        _openImportModal();
        break;

      case 'export-all':
        _downloadCsv(_buildCsv(getTrips().map(_tripToCsvRow)), 'carnet-voyages.csv');
        break;

      case 'new-trip':
        openEditTripModal(null);
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

// ── Modal: build HTML ──────────────────────────────────────────────────────────

function _buildModalHtml(trip) {
  const name        = trip?.name        || '';
  const destination = trip?.destination || '';
  const flag        = trip?.flag        || '';
  const photo       = trip?.photo       || '';
  const status      = trip?.status      || 'done';

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

    <div class="ma">
      ${isEdit ? `<button class="bd" id="m-delete">🗑 Supprimer</button>` : ''}
      ${isEdit ? `<button class="bc" id="m-export">⬇ Exporter</button>` : ''}
      <button class="bc" id="m-cancel">Annuler</button>
      <button class="bs" id="m-save">${isEdit ? 'Enregistrer' : 'Créer le voyage'}</button>
    </div>
  `;
}

// ── Modal: open ────────────────────────────────────────────────────────────────

export function openEditTripModal(id = null) {
  _editingId   = id;
  const trip   = id ? getTrips().find(t => t.id === id) : null;

  // Reset photo mode state
  _photoMode   = 'url';
  _photoBase64 = null;

  // Seed module state from the trip being edited (or defaults)
  _modalComps  = trip
    ? (trip.companions || []).map(c => ({ ...c }))
    : [];
  _modalColor  = trip?.color  || '#0d9488';
  _modalType   = trip?.type   || 'voyage';
  _modalStatus = trip?.status || 'planning';

  showModal(_buildModalHtml(trip));
  _initModalListeners(trip);
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
    _modalType = pill.dataset.modalType;
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
    color:      _modalColor,
    type:       _modalType,
    status:     _modalStatus,
    startDate:  start || null,
    endDate:    end   || null,
    companions: _modalComps,
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
