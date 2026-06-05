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
