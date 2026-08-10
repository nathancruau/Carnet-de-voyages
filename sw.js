/* ============================================================
   CARNET DE VOYAGES — Service Worker
   Strategies:
   - App shell  : stale-while-revalidate
   - OSM tiles  : cache-first (tiles are stable, large cache)
   - Firebase   : network-only (handles its own offline via IndexedDB)
   ============================================================ */

const SHELL_CACHE = 'cv-shell-153';
const TILE_CACHE  = 'cv-tiles-1';

const SHELL_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/style.css',
  '/vendor/leaflet.css',
  '/vendor/leaflet.js',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png',
  '/js/app.js',
  '/js/auth.js',
  '/js/gpx.js',
  '/js/home.js',
  '/js/export.js',
  '/js/import.js',
  '/js/mymap.js',
  '/js/notifications.js',
  '/js/share.js',
  '/js/store.js',
  '/js/utils.js',
  '/js/trip/budget.js',
  '/js/trip/journal.js',
  '/js/trip/mapcal.js',
  '/js/trip/packing.js',
  '/js/trip/sortie.js',
  '/js/trip/tricount.js',
  '/js/trip/trip.js',
];

// Install: cache app shell
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(SHELL_CACHE)
      .then(c => c.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()) // don't block install on partial failures
  );
});

// Activate: delete old shell caches, then tell all open tabs to reload
// so they immediately get the fresh files instead of serving stale cached content.
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => {
      const staleShells = keys.filter(k => k.startsWith('cv-shell-') && k !== SHELL_CACHE);
      const wasUpdate   = staleShells.length > 0;
      return Promise.all(keys.filter(k => k !== SHELL_CACHE && k !== TILE_CACHE).map(k => caches.delete(k)))
        .then(() => self.clients.claim())
        .then(() => {
          if (!wasUpdate) return;
          // This was a version update — notify every open window to reload
          // so they switch from stale cached files to the freshly installed ones.
          return self.clients.matchAll({ type: 'window' }).then(clients =>
            clients.forEach(c => c.postMessage({ type: 'SW_UPDATED' }))
          );
        });
    })
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // OSM tiles: cache-first
  if (url.hostname.includes('openstreetmap') || url.hostname.includes('openstreetmap.fr') || url.hostname.includes('osrm')) {
    e.respondWith(_cacheFirst(e.request));
    return;
  }

  // Firebase / Google APIs: network-only (Firebase manages its own IndexedDB offline cache)
  if (url.hostname.includes('firebase') || url.hostname.includes('googleapis') || url.hostname.includes('gstatic')) {
    return;
  }

  // Same-origin app files
  if (url.origin === self.location.origin) {
    // Navigation requests (HTML document) get a guaranteed app-shell fallback.
    // Without this, a 503 would show the browser "Aw Snap / Aie aie aie" error page.
    if (e.request.mode === 'navigate') {
      e.respondWith(_appShellFetch(e.request));
    } else {
      e.respondWith(_staleWhileRevalidate(e.request));
    }
  }
});

async function _cacheFirst(req) {
  const cache  = await caches.open(TILE_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const fresh = await fetch(req);
    if (fresh.ok) cache.put(req, fresh.clone());
    return fresh;
  } catch (err) {
    return new Response('', { status: 503, statusText: 'Offline' });
  }
}

async function _staleWhileRevalidate(req) {
  const cache  = await caches.open(SHELL_CACHE);
  const cached = await cache.match(req) || await cache.match(req, { ignoreSearch: true });

  // Discard broken cached entries (e.g. partial downloads, opaque errors)
  // so they don't crash the page — fall through to network below.
  if (cached && !cached.ok) {
    cache.delete(req);
  } else if (cached) {
    // Serve stale immediately; revalidate silently in background
    fetch(req).then(fresh => { if (fresh.ok) cache.put(req, fresh.clone()); }).catch(() => null);
    return cached;
  }

  // No usable cache — fetch from network (first visit, or broken entry cleared above)
  try {
    const fresh = await fetch(req);
    if (fresh.ok) cache.put(req, fresh.clone());
    return fresh;
  } catch (_) {
    return new Response('', { status: 503, statusText: 'Offline' });
  }
}

// Navigation fetch: stale-while-revalidate with guaranteed app-shell fallback.
// Never returns a 503 for HTML documents — that would trigger the browser error page.
async function _appShellFetch(req) {
  const cache  = await caches.open(SHELL_CACHE);
  const cached =
    (await cache.match(req)) ||
    (await cache.match(req, { ignoreSearch: true })) ||
    (await cache.match('/index.html')) ||
    (await cache.match('/'));

  if (cached && cached.ok) {
    // Serve stale immediately, revalidate in background
    fetch(req).then(fresh => { if (fresh.ok) cache.put(req, fresh.clone()); }).catch(() => null);
    return cached;
  }

  // Nothing in cache yet — try network
  try {
    const fresh = await fetch(req);
    if (fresh.ok) cache.put(req, fresh.clone());
    return fresh;
  } catch (_) {
    // Return a user-friendly offline page instead of a 503 / browser error screen
    return new Response(
      `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hors ligne — Carnet de Voyages</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#065f55;color:#fff;padding:24px}div{text-align:center}p{opacity:.8;margin:8px 0 20px}button{padding:10px 22px;background:#fff;color:#065f55;border:none;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer}</style>
</head><body><div><div style="font-size:52px;margin-bottom:12px">✈️</div>
<h2 style="font-size:20px;margin-bottom:6px">Carnet de Voyages</h2>
<p>Vous êtes hors ligne.<br>Reconnectez-vous pour accéder à l'application.</p>
<button onclick="location.reload()">Réessayer</button></div></body></html>`,
      { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

// ── Pre-cache tiles for a bounding box (sent via postMessage) ─────────────────

self.addEventListener('message', async e => {
  if (e.data?.type !== 'PRECACHE_TILES') return;

  const { north, south, east, west, minZoom = 5, maxZoom = 13 } = e.data;
  const cache = await caches.open(TILE_CACHE);

  // Collect all tile coords across zoom levels
  const tiles = [];
  for (let z = minZoom; z <= maxZoom; z++) {
    const [x1, y1] = _toTile(west,  north, z);
    const [x2, y2] = _toTile(east,  south, z);
    const xLo = Math.min(x1, x2), xHi = Math.max(x1, x2);
    const yLo = Math.min(y1, y2), yHi = Math.max(y1, y2);
    for (let x = xLo; x <= xHi; x++)
      for (let y = yLo; y <= yHi; y++)
        tiles.push({ z, x, y });
  }

  let done = 0;
  const total = tiles.length;

  for (const { z, x, y } of tiles) {
    const s   = ['a', 'b', 'c'][(x + y + z) % 3];
    const url = `https://${s}.tile.openstreetmap.fr/hot/${z}/${x}/${y}.png`;
    try {
      if (!await cache.match(url)) {
        const r = await fetch(url, { mode: 'cors' });
        if (r.ok) await cache.put(url, r);
      }
    } catch (_) { /* tile may be unavailable — skip silently */ }
    done++;
    if (done % 20 === 0 || done === total) {
      e.source?.postMessage({ type: 'PRECACHE_PROGRESS', done, total });
    }
  }
  e.source?.postMessage({ type: 'PRECACHE_DONE', total });
});

function _toTile(lng, lat, z) {
  const n   = 2 ** z;
  const x   = Math.floor((lng + 180) / 360 * n);
  const rad = lat * Math.PI / 180;
  const y   = Math.floor((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * n);
  return [x, y];
}
