/* ============================================================
   CARNET DE VOYAGES — GPX Utilities
   GPX 1.1 (http://www.topografix.com/GPX/1/1)
   ============================================================ */

/** Parse a GPX XML string. Returns { tracks:[{name,points}], waypoints:[{lat,lng,name,desc}] }. */
export function parseGpx(xmlStr) {
  const doc = new DOMParser().parseFromString(xmlStr, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Fichier GPX invalide');

  const tracks = [];

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

/** Generate a GPX 1.1 XML string from waypoints and optional track points. */
export function generateGpx(name, waypoints = [], trackPoints = []) {
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

/** Trigger a browser file download. */
export function downloadFile(filename, content, mimeType = 'application/gpx+xml') {
  const a   = Object.assign(document.createElement('a'), {
    href:     URL.createObjectURL(new Blob([content], { type: mimeType })),
    download: filename,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ── Local GPX track storage (per-device, not synced to cloud) ─────────────────
// Stored under localStorage key `cvgpx_<tripId>` as a JSON array of tracks.
// Each track: { id, name, color, points: [{lat,lng,ele?,time?}], importedAt }

const _key = id => `cvgpx_${id}`;

export function getLocalGpxTracks(tripId) {
  try { return JSON.parse(localStorage.getItem(_key(tripId)) || '[]'); }
  catch (_) { return []; }
}

export function saveLocalGpxTrack(tripId, track) {
  const tracks = getLocalGpxTracks(tripId);
  tracks.push(track);
  localStorage.setItem(_key(tripId), JSON.stringify(tracks));
  return tracks;
}

export function removeLocalGpxTrack(tripId, trackId) {
  const tracks = getLocalGpxTracks(tripId).filter(t => t.id !== trackId);
  localStorage.setItem(_key(tripId), JSON.stringify(tracks));
  return tracks;
}

/** Estimate the number of OSM tiles needed to cover a bounding box across zoom levels. */
export function estimateTileCount(bounds, minZoom, maxZoom) {
  let total = 0;
  for (let z = minZoom; z <= maxZoom; z++) {
    const n     = 2 ** z;
    const x1    = Math.floor((bounds.west  + 180) / 360 * n);
    const x2    = Math.floor((bounds.east  + 180) / 360 * n);
    const rad1  = bounds.north * Math.PI / 180;
    const rad2  = bounds.south * Math.PI / 180;
    const y1    = Math.floor((1 - Math.log(Math.tan(rad1) + 1/Math.cos(rad1)) / Math.PI) / 2 * n);
    const y2    = Math.floor((1 - Math.log(Math.tan(rad2) + 1/Math.cos(rad2)) / Math.PI) / 2 * n);
    total += (Math.abs(x2 - x1) + 1) * (Math.abs(y2 - y1) + 1);
  }
  return total;
}
