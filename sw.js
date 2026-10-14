/* ============================================================
   CARNET DE VOYAGES — Service Worker
   Strategies:
   - App shell  : stale-while-revalidate
   - OSM tiles  : cache-first (tiles are stable, large cache)
   - Firebase   : network-only (handles its own offline via IndexedDB)
   ============================================================ */

const SHELL_CACHE = 'cv-shell-248';
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
  '/js/homemap.js',
  '/js/routing.js',
  '/js/sheet.js',
  '/js/notifications.js',
  '/js/photostore.js',
  '/js/share.js',
  '/js/store.js',
  '/js/utils.js',
  '/js/logos.js',
  '/js/trip/budget.js',
  '/js/trip/journal.js',
  '/js/trip/mapcal.js',
  '/js/trip/packing.js',
  '/js/trip/sortie.js',
  '/js/trip/tricount.js',
  '/js/trip/trip.js',
  '/js/trip/tripv2.js',
  '/js/trip/tripstats.js',
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

  // Firebase Hosting reserved URLs (/__/auth/handler, /__/firebase/init.json…):
  // network-only. Sinon le retour OAuth (authDomain = même origine, cf. auth.js)
  // reçoit index.html depuis le cache au lieu de la page de Firebase.
  if (url.origin === self.location.origin && url.pathname.startsWith('/__/')) {
    return;
  }

  // Same-origin app files
  if (url.origin === self.location.origin) {
    // Navigation requests (HTML document) get a guaranteed app-shell fallback.
    // Without this, a 503 would show the browser "Aw Snap / Aie aie aie" error page.
    e.respondWith(_networkFirst(e.request, e.request.mode === 'navigate'));
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

// Fichiers de l'app : réseau d'abord, cache seulement hors-ligne / réseau trop lent.
// (Avant : stale-while-revalidate — après une mise à jour, la 1re ouverture pouvait
// servir un mélange de vieux modules JS et de nouvelle feuille de style, chaque
// fichier étant revalidé indépendamment : écrans à moitié cassés jusqu'au rechargement.)
async function _networkFirst(req, isNavigate) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const fresh = await Promise.race([
      fetch(req),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 6000)),
    ]);
    if (fresh.ok) cache.put(req, fresh.clone());
    if (fresh.ok || !isNavigate) return fresh;
  } catch (_) { /* hors-ligne ou trop lent : cache ci-dessous */ }

  const cached =
    (await cache.match(req)) ||
    (await cache.match(req, { ignoreSearch: true })) ||
    (isNavigate ? (await cache.match('/index.html')) || (await cache.match('/')) : null);
  if (cached) return cached;

  if (!isNavigate) return new Response('', { status: 503, statusText: 'Offline' });
  // Page hors-ligne lisible plutôt que l'écran d'erreur du navigateur
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
