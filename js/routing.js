/* ============================================================
   CARNET DE VOYAGES — Itinéraires routiers (v244)
   ============================================================
   Tracé qui suit les routes entre deux étapes, selon le moyen de
   transport du tronçon :
     car / bus → OSRM « driving »   (router.project-osrm.org)
     foot      → OSRM piéton        (routing.openstreetmap.de/routed-foot)
     bike      → OSRM vélo          (routing.openstreetmap.de/routed-bike)
     train / plane / ferry → ligne droite (pas de réseau routable)

   cachedRoute(from, to, mode) → { coords:[[lng,lat]…], meters, seconds } | null | undefined
     synchrone : undefined = pas encore demandé, null = pas d'itinéraire (repli ligne droite)
   fetchRoutes(legs) → Promise<boolean>  (true si au moins un nouveau tracé)
     demande les tronçons manquants, 2 à la fois.

   Cache persisté dans localStorage (géométrie simplifiée, ≤ 300 points,
   5 décimales) pour un affichage immédiat à la réouverture, hors-ligne compris.
   ============================================================ */

const LS_KEY  = 'carnet_route_cache_v1';
const MAX_ENT = 400;
const ROUTED  = new Set(['car', 'bus', 'foot', 'bike']);

let _cache = null;           // key → { c, m, s, t } | { n:1, t }
const _inflight = new Map(); // key → Promise
let _saveT = 0;

function _load() {
  if (_cache) return _cache;
  try { _cache = JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch (_) { _cache = {}; }
  return _cache;
}

function _save() {
  clearTimeout(_saveT);
  _saveT = setTimeout(() => {
    const c = _load();
    const keys = Object.keys(c);
    if (keys.length > MAX_ENT) {
      keys.sort((a, b) => (c[a].t || 0) - (c[b].t || 0)).slice(0, keys.length - MAX_ENT).forEach(k => delete c[k]);
    }
    try { localStorage.setItem(LS_KEY, JSON.stringify(c)); } catch (_) {}
  }, 800);
}

const _r5 = n => Math.round(n * 1e5) / 1e5;

function _key(from, to, mode) {
  const prof = mode === 'bus' ? 'car' : mode;
  return `${prof}:${_r5(+from.lng)},${_r5(+from.lat)};${_r5(+to.lng)},${_r5(+to.lat)}`;
}

/** Le tronçon suit-il les routes pour ce mode ? */
export function isRoutedMode(mode) { return ROUTED.has(mode || 'car'); }

function _url(from, to, mode) {
  const pts = `${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
  if (mode === 'foot') return `https://routing.openstreetmap.de/routed-foot/route/v1/driving/${pts}`;
  if (mode === 'bike') return `https://routing.openstreetmap.de/routed-bike/route/v1/driving/${pts}`;
  return `https://router.project-osrm.org/route/v1/driving/${pts}`;
}

// Simplification : garde au plus `max` points, régulièrement répartis (extrémités incluses)
function _thin(coords, max = 300) {
  if (coords.length <= max) return coords.map(([x, y]) => [_r5(x), _r5(y)]);
  const out = [], step = (coords.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) {
    const [x, y] = coords[Math.round(i * step)];
    out.push([_r5(x), _r5(y)]);
  }
  return out;
}

export function cachedRoute(from, to, mode) {
  if (!isRoutedMode(mode)) return null;
  const e = _load()[_key(from, to, mode)];
  if (!e) return undefined;
  if (e.n) return null;
  return { coords: e.c, meters: e.m, seconds: e.s };
}

async function _fetchOne(from, to, mode) {
  const key = _key(from, to, mode);
  if (_inflight.has(key)) return _inflight.get(key);
  const p = (async () => {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl && setTimeout(() => ctl.abort(), 12000);
    try {
      const resp = await fetch(_url(from, to, mode), ctl ? { signal: ctl.signal } : undefined);
      if (!resp.ok) throw new Error('http ' + resp.status);
      const data = await resp.json();
      const r = data.routes?.[0];
      const c = _load();
      if (r?.geometry?.coordinates?.length > 1) {
        c[key] = { c: _thin(r.geometry.coordinates), m: Math.round(r.distance), s: Math.round(r.duration), t: Date.now() };
      } else {
        c[key] = { n: 1, t: Date.now() };     // aucun itinéraire (île, océan…) → ligne droite
      }
      _save();
      return true;
    } catch (_) {
      return false;                            // réseau : on réessaiera au prochain affichage
    } finally {
      if (timer) clearTimeout(timer);
      _inflight.delete(key);
    }
  })();
  _inflight.set(key, p);
  return p;
}

/** legs = [{ from, to, mode }] — demande les tronçons manquants. */
export async function fetchRoutes(legs) {
  const todo = legs.filter(l => isRoutedMode(l.mode) && cachedRoute(l.from, l.to, l.mode) === undefined);
  if (!todo.length) return false;
  let changed = false, i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const l = todo[i++];
      if (await _fetchOne(l.from, l.to, l.mode)) changed = true;
    }
  };
  await Promise.all([worker(), worker()]);
  return changed;
}
