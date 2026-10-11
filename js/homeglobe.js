/* ============================================================
   CARNET DE VOYAGES — Globe de l'accueil (refonte bêta)
   ============================================================
   Globe orthographique plein écran (canvas 2D) avec les PINs des
   voyages réalisés. Indépendant du globe de la page Statistiques
   (home.js) : son propre état de rotation/zoom, sa propre zone
   d'affichage (la partie de l'écran au-dessus de la feuille profil).

   Exports :
     collectGlobePins(trips)        → [{ lat, lng, tripId, title, tripName, date, color, photo }]
     mountHomeGlobe(canvas, opts)   → { setArea(rect), setData(data), redraw(), destroy() }
   ============================================================ */

const WORLD_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json';
const TOPO_URL  = 'https://cdn.jsdelivr.net/npm/topojson-client@3/+esm';
const D2R = Math.PI / 180;

// Fetché une seule fois par session — renderHome() remonte le globe à chaque re-render.
let _featuresPromise = null;
let _features        = null;

// Vue persistée entre les re-renders de l'accueil (sinon chaque modif de voyage
// ferait revenir le globe à sa position initiale).
const _view = { lambda: 10, phi: 30, zoom: 1, initialized: false };

function _loadFeatures() {
  if (!_featuresPromise) {
    _featuresPromise = Promise.all([
      import(TOPO_URL),
      fetch(WORLD_URL).then(r => r.json()),
    ]).then(([topo, world]) => {
      _features = topo.feature(world, world.objects.countries).features;
      return _features;
    }).catch(err => { _featuresPromise = null; throw err; });
  }
  return _featuresPromise;
}

/**
 * Mêmes règles que _buildAllPins (mymap.js, « Mes destinations ») : seulement
 * les voyages réalisés, PINs des jours + anciennes journalEntries + PIN unique
 * d'une sortie. Version allégée (pas de GPX/photos de carnet) : l'accueil n'a
 * besoin que de la position et de quoi afficher une vignette.
 */
export function collectGlobePins(trips) {
  const pins = [];
  for (const trip of trips) {
    if (trip.status !== 'done') continue;
    const base = { tripId: trip.id, tripName: trip.name || 'Voyage', color: trip.color || '#0d9488' };
    for (const day of (trip.days || [])) {
      for (const item of (day.items || [])) {
        const lat = parseFloat(item.lat), lng = parseFloat(item.lng);
        if (isNaN(lat) || isNaN(lng)) continue;
        const jd = item.journalData || {};
        pins.push({ ...base, lat, lng, title: item.text || '—', date: day.date || null,
                    photo: (jd.photos || [])[0] || item.photo || null });
      }
    }
    for (const e of (trip.journalEntries || [])) {
      const lat = parseFloat(e.lat), lng = parseFloat(e.lng);
      if (isNaN(lat) || isNaN(lng)) continue;
      pins.push({ ...base, lat, lng, title: e.title || '—', date: e.date || null, photo: null });
    }
    if (trip.type === 'sortie' && trip.pin) {
      const lat = parseFloat(trip.pin.lat), lng = parseFloat(trip.pin.lng);
      if (!isNaN(lat) && !isNaN(lng)) {
        pins.push({ ...base, lat, lng, title: trip.name || 'Sortie',
                    date: trip.pin.date || trip.startDate || null, photo: trip.photo || null });
      }
    }
  }
  return pins;
}

function _project(lon, lat) {
  const λ = (lon - _view.lambda) * D2R, φ = lat * D2R, φ1 = _view.phi * D2R;
  const cosφ = Math.cos(φ), sinφ = Math.sin(φ), cosφ1 = Math.cos(φ1), sinφ1 = Math.sin(φ1);
  const cosλ = Math.cos(λ);
  return {
    x: cosφ * Math.sin(λ),
    y: cosφ1 * sinφ - sinφ1 * cosφ * cosλ,
    z: sinφ1 * sinφ + cosφ1 * cosφ * cosλ, // > 0 : face visible
  };
}

function _initialCenter(pins) {
  if (!pins.length) return;
  // Centre sur le voyage réalisé le plus récent (le dernier PIN par date)
  const sorted = [...pins].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const recent = sorted.filter(p => p.tripId === sorted[0].tripId);
  _view.lambda = recent.reduce((s, p) => s + p.lng, 0) / recent.length;
  _view.phi    = Math.max(-60, Math.min(60, recent.reduce((s, p) => s + p.lat, 0) / recent.length));
}

/**
 * @param {HTMLCanvasElement} canvas  plein écran (position:absolute;inset:0)
 * @param {object} opts
 *   pins          tableau de collectGlobePins()
 *   visited       Set<ISO-2> des pays visités (colorés différemment)
 *   featureCode   (feature) => ISO-2
 *   onPinTap      (pins[]) => void — PINs proches du point touché ([] = tap dans le vide)
 */
export function mountHomeGlobe(canvas, opts) {
  let data   = { pins: opts.pins || [], visited: opts.visited || new Set() };
  let area   = { x: 0, y: 0, w: canvas.clientWidth, h: canvas.clientHeight };
  let rafId  = null;
  let inertia = null;
  let alive  = true;

  if (!_view.initialized) { _initialCenter(data.pins); _view.initialized = true; }

  const geom = () => {
    const R = Math.min(area.w, area.h) * 0.42 * _view.zoom;
    return { cx: area.x + area.w / 2, cy: area.y + area.h / 2, R };
  };

  function draw() {
    rafId = null;
    if (!alive || !canvas.isConnected) { destroy(); return; }
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    const pw = Math.round(W * dpr), ph = Math.round(H * dpr);
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const { cx, cy, R } = geom();
    if (R < 8) return;

    // Halo atmosphérique
    const halo = ctx.createRadialGradient(cx, cy, R * 0.96, cx, cy, R * 1.16);
    halo.addColorStop(0, 'rgba(70,150,255,.55)');
    halo.addColorStop(0.35, 'rgba(50,120,240,.22)');
    halo.addColorStop(1, 'rgba(30,80,200,0)');
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(cx, cy, R * 1.16, 0, Math.PI * 2); ctx.fill();

    // Océan
    const ocean = ctx.createRadialGradient(cx - R * .35, cy - R * .4, R * .1, cx, cy, R);
    ocean.addColorStop(0, '#2c6fb8');
    ocean.addColorStop(1, '#0d2f66');
    ctx.fillStyle = ocean;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();

    // Terres
    if (_features) {
      ctx.save();
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
      ctx.lineJoin = 'round';
      for (const f of _features) {
        const g = f.geometry;
        if (!g) continue;
        const code = opts.featureCode?.(f) || '';
        const visited = data.visited.has(code);
        ctx.fillStyle   = visited ? '#a5d86a' : '#4d8c3f';
        ctx.strokeStyle = visited ? '#c9eb94' : '#3f7834';
        ctx.lineWidth   = 0.6;
        const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
        for (const poly of polys) {
          ctx.beginPath();
          let any = false;
          for (const ring of poly) {
            let started = false;
            for (const [lon, lat] of ring) {
              const p = _project(lon, lat);
              if (p.z <= 0) { started = false; continue; }
              any = true;
              const x = cx + p.x * R, y = cy - p.y * R;
              if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
            }
          }
          if (!any) continue;
          ctx.fill(); ctx.stroke();
        }
      }
      ctx.restore();
    }

    // Ombrage (relief 3D : lumière en haut à gauche)
    const shade = ctx.createRadialGradient(cx - R * .4, cy - R * .45, R * .2, cx, cy, R * 1.05);
    shade.addColorStop(0, 'rgba(255,255,255,.10)');
    shade.addColorStop(.55, 'rgba(0,0,0,0)');
    shade.addColorStop(1, 'rgba(0,5,25,.45)');
    ctx.fillStyle = shade;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();

    // PINs
    const pr = Math.max(3.5, Math.min(6, R / 40));
    for (const pin of data.pins) {
      const p = _project(pin.lng, pin.lat);
      if (p.z <= 0.02) { pin._sx = null; continue; }
      const x = cx + p.x * R, y = cy - p.y * R;
      pin._sx = x; pin._sy = y;
      ctx.beginPath(); ctx.arc(x, y, pr + 3, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,.22)'; ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, pr, 0, Math.PI * 2);
      ctx.fillStyle = pin.color; ctx.fill();
      ctx.lineWidth = 1.6; ctx.strokeStyle = '#fff'; ctx.stroke();
    }

    if (inertia) {
      _view.lambda -= inertia.vx;
      _view.phi = Math.max(-85, Math.min(85, _view.phi + inertia.vy));
      inertia.vx *= 0.93; inertia.vy *= 0.93;
      if (Math.abs(inertia.vx) < 0.02 && Math.abs(inertia.vy) < 0.02) inertia = null;
      else redraw();
    }
  }

  function redraw() { if (!rafId && alive) rafId = requestAnimationFrame(draw); }

  // ── Interaction : rotation, inertie, pincement, molette, tap sur PIN ──────────
  canvas.style.touchAction = 'none';
  const pointers = new Map();
  let last = null, pinchDist = 0, downAt = null, moved = 0, samples = [], tapAt = null;

  const clampZoom = z => Math.max(0.7, Math.min(5, z));
  const dist2 = () => { const [a, b] = [...pointers.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };

  function onDown(e) {
    canvas.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    inertia = null;
    if (pointers.size === 1) {
      last = { x: e.clientX, y: e.clientY }; downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
      moved = 0; samples = []; tapAt = null;
    } else if (pointers.size === 2) { pinchDist = dist2(); last = null; }
  }
  function onMove(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size >= 2) {
      const d = dist2();
      if (pinchDist) _view.zoom = clampZoom(_view.zoom * d / pinchDist);
      pinchDist = d; moved = 99; redraw(); return;
    }
    if (!last) return;
    const dx = e.clientX - last.x, dy = e.clientY - last.y;
    last = { x: e.clientX, y: e.clientY };
    moved += Math.abs(dx) + Math.abs(dy);
    // 1:1 avec le doigt : ~57° par rayon parcouru
    const sens = 57.3 / Math.max(40, geom().R);
    _view.lambda -= dx * sens;
    _view.phi = Math.max(-85, Math.min(85, _view.phi + dy * sens));
    samples.push({ dx: dx * sens, dy: dy * sens, t: performance.now() });
    if (samples.length > 5) samples.shift();
    redraw();
  }
  function onUp(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (pointers.size === 1) { const [p] = pointers.values(); last = { ...p }; pinchDist = 0; return; }
    if (pointers.size > 0) return;
    if (downAt && moved < 8 && performance.now() - downAt.t < 400) {
      // Traité au 'click' qui suit : si la popup s'ouvrait dès pointerup, elle
      // apparaîtrait sous le doigt et recevrait ce click (ouvrant le voyage).
      tapAt = { x: downAt.x, y: downAt.y };
    } else if (samples.length >= 2 && performance.now() - samples[samples.length - 1].t < 80) {
      const n = samples.length;
      inertia = { vx: samples.reduce((s, v) => s + v.dx, 0) / n, vy: samples.reduce((s, v) => s + v.dy, 0) / n };
      redraw();
    }
    last = null; downAt = null;
  }
  function _tap(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    const x = clientX - r.left, y = clientY - r.top;
    const near = data.pins.filter(p => p._sx != null && Math.hypot(p._sx - x, p._sy - y) < 22);
    opts.onPinTap?.(near);
  }
  function onWheel(e) {
    e.preventDefault();
    _view.zoom = clampZoom(_view.zoom * (e.deltaY > 0 ? 0.9 : 1.1));
    redraw();
  }
  const onResize = () => redraw();

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('click', () => { if (tapAt) { _tap(tapAt.x, tapAt.y); tapAt = null; } });
  window.addEventListener('resize', onResize);

  function destroy() {
    alive = false;
    if (rafId) cancelAnimationFrame(rafId);
    window.removeEventListener('resize', onResize);
  }

  _loadFeatures().then(redraw).catch(err => console.warn('[homeglobe] world data failed:', err.message));
  redraw();

  return {
    setArea(rect) { area = rect; redraw(); },
    setData(d) { data = { ...data, ...d }; redraw(); },
    redraw,
    destroy,
  };
}
