/* ============================================================
   CARNET DE VOYAGES — GPX Utilities
   GPX 1.1 (http://www.topografix.com/GPX/1/1)

   Exports:
     parseGpx(xmlStr)               → { tracks, waypoints }
     computeGpxStats(points)        → distance / elevation / speed stats
     generateGpx(name, wpts, trk)   → GPX XML string
     downloadFile(name, content)     → trigger browser download
     getLocalGpxTracks(tripId)      → read from localStorage
     saveLocalGpxTrack(tripId, trk) → append to localStorage
     removeLocalGpxTrack(tripId, id)→ delete from localStorage
     estimateTileCount(bounds, …)   → tile count estimate for offline cache
   ============================================================ */

/**
 * Parse a GPX 1.1 XML string.
 * Handles <trk> (tracks), <rte> (routes) and top-level <wpt> (waypoints).
 * Throws if the XML cannot be parsed.
 *
 * @param {string} xmlStr
 * @returns {{ tracks: Array<{name:string, points:Array}>, waypoints: Array }}
 */
export function parseGpx(xmlStr) {
  const doc = new DOMParser().parseFromString(xmlStr, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Fichier GPX invalide');

  const tracks = [];

  // <trk> elements contain one or more <trkseg> with <trkpt> children
  for (const trk of doc.querySelectorAll('trk')) {
    const name   = trk.querySelector('name')?.textContent?.trim() || 'Trace';
    const points = [];
    for (const pt of trk.querySelectorAll('trkpt')) {
      const lat = parseFloat(pt.getAttribute('lat'));
      const lng = parseFloat(pt.getAttribute('lon'));
      if (!isNaN(lat) && !isNaN(lng)) {
        const ele  = parseFloat(pt.querySelector('ele')?.textContent);
        const time = pt.querySelector('time')?.textContent?.trim() || '';
        points.push({ lat, lng, ...(isNaN(ele) ? {} : { ele }), ...(time ? { time } : {}) });
      }
    }
    if (points.length) tracks.push({ name, points });
  }

  // <rte> elements contain <rtept> — treated as tracks without elevation/time
  for (const rte of doc.querySelectorAll('rte')) {
    const name   = rte.querySelector('name')?.textContent?.trim() || 'Itinéraire';
    const points = [];
    for (const pt of rte.querySelectorAll('rtept')) {
      const lat = parseFloat(pt.getAttribute('lat'));
      const lng = parseFloat(pt.getAttribute('lon'));
      if (!isNaN(lat) && !isNaN(lng)) points.push({ lat, lng });
    }
    if (points.length) tracks.push({ name, points });
  }

  // Top-level <wpt> elements (named points of interest)
  const waypoints = [];
  for (const wpt of doc.querySelectorAll('gpx > wpt')) {
    const lat = parseFloat(wpt.getAttribute('lat'));
    const lng = parseFloat(wpt.getAttribute('lon'));
    if (!isNaN(lat) && !isNaN(lng)) {
      waypoints.push({
        lat, lng,
        name: wpt.querySelector('name')?.textContent?.trim() || '',
        desc: wpt.querySelector('desc')?.textContent?.trim() || '',
      });
    }
  }

  return { tracks, waypoints };
}

/**
 * Compute statistics from an array of track points.
 *
 * @param {Array<{lat, lng, ele?, time?}>} points
 * @returns {{
 *   distanceM: number,
 *   elevGain: number,
 *   elevLoss: number,
 *   durationSecs: number|null,
 *   pointCount: number,
 *   altMin: number|null,
 *   altMax: number|null,
 *   speedAvgKph: number|null,
 *   speedMaxKph: number|null,
 * }}
 */
export function computeGpxStats(points) {
  let distanceM    = 0;
  let elevGain     = 0;
  let elevLoss     = 0;
  let durationSecs = null;
  let speedMaxKph  = null;

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const seg = _haversineM(a, b);
    distanceM += seg;

    // Accumulate elevation gain/loss when both points have altitude data
    if (a.ele != null && b.ele != null) {
      const diff = b.ele - a.ele;
      if (diff > 0) elevGain += diff;
      else          elevLoss += -diff;
    }

    // Per-segment max speed (only when timestamps are present)
    if (a.time && b.time) {
      const dt = (new Date(b.time).getTime() - new Date(a.time).getTime()) / 1000;
      if (dt > 0) {
        const kph = (seg / dt) * 3.6;
        if (speedMaxKph === null || kph > speedMaxKph) speedMaxKph = kph;
      }
    }
  }

  // Altitude extremes from all points that carry elevation
  const eles   = points.map(p => p.ele).filter(e => e != null);
  const altMin = eles.length ? Math.round(Math.min(...eles)) : null;
  const altMax = eles.length ? Math.round(Math.max(...eles)) : null;

  // Average speed derived from total distance ÷ total elapsed time
  let speedAvgKph = null;
  if (points.length > 1 && points[0].time && points[points.length - 1].time) {
    const t0 = new Date(points[0].time).getTime();
    const t1 = new Date(points[points.length - 1].time).getTime();
    if (!isNaN(t0) && !isNaN(t1) && t1 > t0) {
      durationSecs = Math.round((t1 - t0) / 1000);
      speedAvgKph  = (distanceM / durationSecs) * 3.6;
    }
  }

  return {
    distanceM:   Math.round(distanceM),
    elevGain:    Math.round(elevGain),
    elevLoss:    Math.round(elevLoss),
    durationSecs,
    pointCount:  points.length,
    altMin,
    altMax,
    speedAvgKph: speedAvgKph !== null ? Math.round(speedAvgKph * 10) / 10 : null,
    speedMaxKph: speedMaxKph !== null ? Math.round(speedMaxKph * 10) / 10 : null,
  };
}

/**
 * Haversine formula — great-circle distance between two lat/lng points in metres.
 * Accuracy is ~0.3 % (spherical Earth assumption); sufficient for GPX stats display.
 */
function _haversineM(a, b) {
  const R     = 6371000; // Earth mean radius in metres
  const toRad = x => x * Math.PI / 180;
  const dLat  = toRad(b.lat - a.lat);
  const dLng  = toRad(b.lng - a.lng);
  const x     = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

/**
 * Subsample a track down to at most `max` points, evenly spaced, keeping each
 * point's full shape (lat/lng/ele/time) — the elevation/speed chart needs
 * ele/time to have anything to draw, so a downsample that strips them down to
 * {lat,lng} silently disables the chart everywhere that track is shown.
 */
export function downsampleGpxPoints(points, max = 300) {
  if (!points?.length) return [];
  if (points.length <= max) return points;
  return Array.from({ length: max }, (_, i) => points[Math.round(i * (points.length - 1) / (max - 1))]);
}

// ── Shared GPX stats block + interactive chart ──────────────────────────────────
// Used everywhere a saved GPX track's stats need to be shown with an elevation/
// speed chart: MyMap's pin info panel, the sortie detail screen, sortie info
// from "Mes destinations". `prefix` keeps element ids unique when more than one
// instance could theoretically exist (e.g. "mm", "si").

/** Per-point cumulative-distance series for elevation/speed/time charting. */
export function buildGpxChartSeries(points) {
  const elevSeries = [], speedSeries = [], timeSeries = [];
  if (!points?.length) return { elevSeries, speedSeries, timeSeries };
  let cumDist = 0;
  const t0 = points[0].time ? new Date(points[0].time).getTime() : null;
  for (let i = 0; i < points.length; i++) {
    if (i > 0) {
      const seg = _haversineM(points[i - 1], points[i]);
      cumDist += seg;
      if (points[i - 1].time && points[i].time) {
        const dt = (new Date(points[i].time).getTime() - new Date(points[i - 1].time).getTime()) / 1000;
        if (dt > 0) speedSeries.push({ d: cumDist - seg / 2, v: (seg / dt) * 3.6 });
      }
    }
    if (points[i].ele != null) elevSeries.push({ d: cumDist, v: points[i].ele });
    if (t0 && points[i].time) timeSeries.push({ d: cumDist, t: (new Date(points[i].time).getTime() - t0) / 1000 });
  }
  return { elevSeries, speedSeries, timeSeries };
}

/**
 * HTML for the "🛤 Trace GPX" block: stat badges, plus an interactive
 * elevation/speed chart when the track has enough points for one (falls back
 * to plain pills otherwise). Call initGpxChart(prefix, gpxPoints) after
 * inserting this into the DOM to wire up the chart.
 */
export function gpxStatsBlockHtml(prefix, gs, gpxPoints) {
  if (!gs) return '';
  const dist = gs.distanceM >= 1000 ? `${(gs.distanceM / 1000).toFixed(1)} km` : `${gs.distanceM} m`;
  let durLabel = '';
  if (gs.durationSecs) {
    const h = Math.floor(gs.durationSecs / 3600), m = Math.round((gs.durationSecs % 3600) / 60);
    durLabel = h > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${m} min`;
  }
  const statCell = (v, l, c = 'var(--ink)') =>
    `<div style="text-align:center"><div style="font-size:12px;font-weight:700;color:${c}">${v}</div><div style="font-size:10px;color:var(--ink4)">${l}</div></div>`;

  const hasPoints = gpxPoints?.length >= 2;
  if (!hasPoints) {
    const gpxPills = [
      `<span class="mm-pill mm-pill-gpx">📏 ${dist}</span>`,
      gs.elevGain   ? `<span class="mm-pill mm-pill-gpx">↑ ${gs.elevGain} m</span>` : '',
      gs.elevLoss   ? `<span class="mm-pill mm-pill-gpx">↓ ${gs.elevLoss} m</span>` : '',
      durLabel      ? `<span class="mm-pill mm-pill-gpx">⏱ ${durLabel}</span>`       : '',
      gs.speedAvgKph != null ? `<span class="mm-pill mm-pill-gpx">⚡ ${gs.speedAvgKph.toFixed(1)} km/h</span>` : '',
    ].filter(Boolean).join('');
    return `
      <div style="border-top:1px solid var(--c3);padding-top:10px;margin-top:4px">
        <div style="font-size:10px;font-weight:700;color:var(--ink4);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">🛤 Trace GPX</div>
        <div style="display:flex;flex-wrap:wrap;gap:5px">${gpxPills}</div>
      </div>`;
  }

  const { elevSeries, speedSeries } = buildGpxChartSeries(gpxPoints);
  const hasChart = elevSeries.length >= 2 || speedSeries.length >= 2;

  return `
    <div style="border-top:1px solid var(--c3);padding-top:10px;margin-top:4px">
      <div style="font-size:10px;font-weight:700;color:var(--ink4);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">🛤 Trace GPX</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:5px 4px;margin-bottom:${hasChart ? '8' : '0'}px">
        ${statCell(dist, 'Distance')}
        ${gs.elevGain ? statCell('+' + gs.elevGain + ' m', 'D+', '#16a34a') : ''}
        ${gs.elevLoss ? statCell('−' + gs.elevLoss + ' m', 'D−', '#e85d3e') : ''}
        ${durLabel    ? statCell(durLabel, 'Durée') : ''}
        ${gs.altMin   != null ? statCell(gs.altMin + '–' + gs.altMax + ' m', 'Altitude') : ''}
        ${gs.speedAvgKph != null ? statCell(gs.speedAvgKph + ' km/h', 'Vit. moy.') : ''}
      </div>
      ${hasChart ? `
      <div style="display:flex;gap:4px;margin-bottom:6px">
        <button id="${prefix}-chart-elev"  style="flex:1;font-size:10px;font-weight:700;padding:3px 0;border-radius:5px;cursor:pointer;border:1.5px solid var(--teal);background:var(--tl);color:var(--td)">⛰ Altitude</button>
        <button id="${prefix}-chart-speed" style="flex:1;font-size:10px;font-weight:700;padding:3px 0;border-radius:5px;cursor:pointer;border:1.5px solid var(--c3);background:var(--c2);color:var(--ink3)">⚡ Vitesse</button>
      </div>
      <div id="${prefix}-chart-wrap" style="position:relative;width:100%;touch-action:none;cursor:crosshair">
        <canvas id="${prefix}-gpx-canvas" style="width:100%;height:110px;display:block;border-radius:6px"></canvas>
        <div id="${prefix}-chart-cursor" style="display:none;position:absolute;top:0;bottom:18px;width:1px;background:rgba(0,0,0,.45);pointer-events:none">
          <div id="${prefix}-chart-tip" style="position:absolute;top:4px;left:5px;background:rgba(15,15,15,.82);color:#fff;padding:3px 7px;border-radius:5px;font-size:10px;line-height:1.5;white-space:pre;pointer-events:none"></div>
        </div>
      </div>` : ''}
    </div>`;
}

/** Wire up the interactive chart for a block rendered by gpxStatsBlockHtml(). No-op if there's no canvas (no chart to show). */
export function initGpxChart(prefix, gpxPoints) {
  const canvas = document.getElementById(`${prefix}-gpx-canvas`);
  if (!canvas) return;
  const { elevSeries, speedSeries, timeSeries } = buildGpxChartSeries(gpxPoints);
  const elevBtn  = document.getElementById(`${prefix}-chart-elev`);
  const speedBtn = document.getElementById(`${prefix}-chart-speed`);
  const wrap     = document.getElementById(`${prefix}-chart-wrap`);
  const cursor   = document.getElementById(`${prefix}-chart-cursor`);
  const tip      = document.getElementById(`${prefix}-chart-tip`);

  const hasElev  = elevSeries.length  >= 2;
  const hasSpeed = speedSeries.length >= 2;
  let chartMode  = hasElev ? 'elevation' : 'speed';

  const _drawChart = (mode) => {
    const series = mode === 'elevation' ? elevSeries : speedSeries;
    const W = canvas.offsetWidth || 240, H = 110;
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    if (series.length < 2) return;
    const xs = series.map(p => p.d), ys = series.map(p => p.v);
    const xMin = xs[0], xMax = xs[xs.length - 1];
    const yMin = Math.min(...ys), yMax = Math.max(...ys), yRange = yMax - yMin || 1;
    const pad = { t: 6, b: 18, l: 4, r: 4 };
    const toX = d => pad.l + (d - xMin) / (xMax - xMin) * (W - pad.l - pad.r);
    const toY = v => H - pad.b - (v - yMin) / yRange * (H - pad.t - pad.b);
    const color = mode === 'elevation' ? '#0891b2' : '#d97706';
    ctx.beginPath(); ctx.moveTo(toX(xs[0]), toY(ys[0]));
    for (let i = 1; i < series.length; i++) ctx.lineTo(toX(xs[i]), toY(ys[i]));
    ctx.lineTo(toX(xs[xs.length - 1]), H - pad.b); ctx.lineTo(toX(xs[0]), H - pad.b);
    ctx.closePath();
    ctx.fillStyle = mode === 'elevation' ? 'rgba(8,145,178,.15)' : 'rgba(217,119,6,.15)'; ctx.fill();
    ctx.beginPath(); ctx.moveTo(toX(xs[0]), toY(ys[0]));
    for (let i = 1; i < series.length; i++) ctx.lineTo(toX(xs[i]), toY(ys[i]));
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = 'rgba(100,100,100,.85)'; ctx.font = '9px sans-serif';
    const unit = mode === 'elevation' ? 'm' : 'km/h';
    ctx.textAlign = 'left';
    ctx.fillText(Math.round(yMax) + unit, pad.l + 2, pad.t + 9);
    ctx.fillText(Math.round(yMin) + unit, pad.l + 2, H - pad.b - 2);
    ctx.textAlign = 'center';
    ctx.fillText('0', toX(xMin), H - 4);
    ctx.fillText(xMax >= 1000 ? (xMax / 1000).toFixed(1) + ' km' : Math.round(xMax) + ' m', toX(xMax), H - 4);
  };

  const _setMode = (mode) => {
    chartMode = mode;
    _drawChart(mode);
    if (elevBtn)  { elevBtn.style.background  = mode === 'elevation' ? 'var(--tl)' : 'var(--c2)'; elevBtn.style.borderColor  = mode === 'elevation' ? 'var(--teal)' : 'var(--c3)'; elevBtn.style.color  = mode === 'elevation' ? 'var(--td)' : 'var(--ink3)'; }
    if (speedBtn) { speedBtn.style.background = mode === 'speed'     ? 'var(--tl)' : 'var(--c2)'; speedBtn.style.borderColor = mode === 'speed'     ? 'var(--teal)' : 'var(--c3)'; speedBtn.style.color = mode === 'speed'     ? 'var(--td)' : 'var(--ink3)'; }
  };

  if (!hasElev  && elevBtn)  elevBtn.setAttribute('disabled', '');
  if (!hasSpeed && speedBtn) speedBtn.setAttribute('disabled', '');
  elevBtn?.addEventListener('click',  () => _setMode('elevation'));
  speedBtn?.addEventListener('click', () => _setMode('speed'));
  requestAnimationFrame(() => _drawChart(chartMode));

  if (wrap && cursor && tip) {
    const _nearest = (s, d) => {
      let lo = 0, hi = s.length - 1;
      while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (s[mid].d < d) lo = mid; else hi = mid; }
      return Math.abs(s[lo].d - d) <= Math.abs(s[hi].d - d) ? s[lo] : s[hi];
    };
    const _showAt = (clientX) => {
      const rect = canvas.getBoundingClientRect();
      const xPct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const series = chartMode === 'elevation' ? elevSeries : speedSeries;
      if (series.length < 2) return;
      const xMin = series[0].d, xMax = series[series.length - 1].d;
      const pt = _nearest(series, xMin + xPct * (xMax - xMin));
      cursor.style.display = 'block'; cursor.style.left = (xPct * 100) + '%';
      const distStr = pt.d >= 1000 ? (pt.d / 1000).toFixed(2) + ' km' : Math.round(pt.d) + ' m';
      const valStr  = chartMode === 'elevation' ? Math.round(pt.v) + ' m alt.' : pt.v.toFixed(1) + ' km/h';
      let lines = [distStr, valStr];
      if (timeSeries.length >= 2) {
        const tPt = _nearest(timeSeries, pt.d);
        const h = Math.floor(tPt.t / 3600), m = Math.floor((tPt.t % 3600) / 60), s = Math.floor(tPt.t % 60);
        lines.push(h > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${m}m${String(s).padStart(2, '0')}s`);
      }
      tip.textContent = lines.join('\n');
      if (xPct > 0.65) { tip.style.left = 'auto'; tip.style.right = '5px'; }
      else              { tip.style.left = '5px';  tip.style.right = 'auto'; }
    };
    wrap.addEventListener('mousemove',  e => _showAt(e.clientX));
    wrap.addEventListener('mouseleave', () => { cursor.style.display = 'none'; });
    wrap.addEventListener('touchmove',  e => { e.preventDefault(); _showAt(e.touches[0].clientX); }, { passive: false });
    wrap.addEventListener('touchend',   () => { cursor.style.display = 'none'; });
  }
}

/**
 * Generate a GPX 1.1 XML string.
 * Attribute values and text content are XML-escaped to handle special characters.
 *
 * @param {string} name
 * @param {Array<{lat,lng,name?,desc?}>} waypoints
 * @param {Array<{lat,lng,ele?,time?}>}  trackPoints
 * @returns {string}
 */
export function generateGpx(name, waypoints = [], trackPoints = []) {
  // Minimal XML escaping for attribute values and text content
  const x = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

  const wptXml = waypoints.map(w =>
    `  <wpt lat="${w.lat}" lon="${w.lng}">\n    <name>${x(w.name)}</name>${w.desc ? `\n    <desc>${x(w.desc)}</desc>` : ''}\n  </wpt>`
  ).join('\n');

  const trkXml = trackPoints.length ? `
  <trk>
    <name>${x(name)}</name>
    <trkseg>
      ${trackPoints.map(p =>
        `<trkpt lat="${p.lat}" lon="${p.lng}">${p.ele != null ? `<ele>${p.ele}</ele>` : ''}${p.time ? `<time>${p.time}</time>` : ''}</trkpt>`
      ).join('\n      ')}
    </trkseg>
  </trk>` : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Carnet de Voyages"
     xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${x(name)}</name></metadata>
${wptXml}${trkXml}
</gpx>`;
}

/**
 * Trigger a browser file download.
 * The object URL is revoked after 10 s — long enough for any browser to start
 * the download, but still freeing memory promptly.
 *
 * @param {string} filename
 * @param {string} content
 * @param {string} [mimeType]
 */
export function downloadFile(filename, content, mimeType = 'application/gpx+xml') {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const a   = Object.assign(document.createElement('a'), { href: url, download: filename });
  // Must be in the DOM for Firefox to fire the download
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoking immediately would abort the download on some browsers; 10 s is safe
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ── Local GPX track storage ────────────────────────────────────────────────────
// Stored per-device under localStorage key `cvgpx_<tripId>` as a JSON array.
// Not synced to Firestore — tracks are often large and device-specific.
// Each track: { id, name, color, points:[{lat,lng,ele?,time?}], importedAt }

const _gpxKey = id => `cvgpx_${id}`;

/** Return all locally-stored GPX tracks for a trip, or [] on parse error. */
export function getLocalGpxTracks(tripId) {
  try { return JSON.parse(localStorage.getItem(_gpxKey(tripId)) || '[]'); }
  catch (_) { return []; }
}

/**
 * Older GPX imports downsampled to lat/lng only, silently disabling the
 * elevation/speed chart everywhere that track's stats are shown (fixed going
 * forward, but already-imported items still have the stripped points). If the
 * full-resolution track is still on this device (GPX tracks aren't synced),
 * rebuild gpxPoints from it so the chart self-heals without requiring the
 * user to re-import. Shared by mymap.js (day-item pins and sortie pins alike)
 * and sortie.js's own detail screen — the sortie path used to read
 * trip.pin.gpxPoints directly and never got this repair, so its chart could
 * stay silently broken even after the day-item path was fixed for it.
 */
export function resolveGpxPoints(tripId, item) {
  if (!item?.gpxPoints?.length || !item.gpxTrackId) return item?.gpxPoints || null;
  const hasRichData = item.gpxPoints.some(p => p.ele != null || p.time != null);
  if (hasRichData) return item.gpxPoints;
  const track = getLocalGpxTracks(tripId).find(t => t.id === item.gpxTrackId);
  return track ? downsampleGpxPoints(track.points) : item.gpxPoints;
}

/** Append a track to the stored list and return the updated array. */
export function saveLocalGpxTrack(tripId, track) {
  const tracks = getLocalGpxTracks(tripId);
  tracks.push(track);
  localStorage.setItem(_gpxKey(tripId), JSON.stringify(tracks));
  return tracks;
}

/** Remove a track by id and return the updated array. */
export function removeLocalGpxTrack(tripId, trackId) {
  const tracks = getLocalGpxTracks(tripId).filter(t => t.id !== trackId);
  localStorage.setItem(_gpxKey(tripId), JSON.stringify(tracks));
  return tracks;
}

/**
 * Estimate the number of OSM tiles needed to cover a bounding box across zoom levels.
 * Uses the Web Mercator (EPSG:3857) tile formula — the same projection as Leaflet/OSM.
 *
 * @param {{ north, south, east, west }} bounds - latitude/longitude extent
 * @param {number} minZoom
 * @param {number} maxZoom
 * @returns {number}
 */
export function estimateTileCount(bounds, minZoom, maxZoom) {
  let total = 0;
  for (let z = minZoom; z <= maxZoom; z++) {
    const n  = 2 ** z;
    const x1 = Math.floor((bounds.west  + 180) / 360 * n);
    const x2 = Math.floor((bounds.east  + 180) / 360 * n);
    // Web Mercator y-tile index from latitude
    const rad1 = bounds.north * Math.PI / 180;
    const rad2 = bounds.south * Math.PI / 180;
    const y1   = Math.floor((1 - Math.log(Math.tan(rad1) + 1 / Math.cos(rad1)) / Math.PI) / 2 * n);
    const y2   = Math.floor((1 - Math.log(Math.tan(rad2) + 1 / Math.cos(rad2)) / Math.PI) / 2 * n);
    total += (Math.abs(x2 - x1) + 1) * (Math.abs(y2 - y1) + 1);
  }
  return total;
}
