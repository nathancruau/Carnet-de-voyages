/* ============================================================
   CARNET DE VOYAGES — KML / CSV Import
   ============================================================ */

import { addTrip, uid } from './store.js';
import { notify } from './utils.js';

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Parse a KML string and return an array of raw placemark objects.
 * Each: { name, description, lat, lng, date, region }
 */
export function parseKML(kmlText) {
  const parser = new DOMParser();
  const doc    = parser.parseFromString(kmlText, 'application/xml');

  if (doc.querySelector('parsererror')) {
    throw new Error('KML invalide');
  }

  const placemarks = [...doc.querySelectorAll('Placemark')];
  const results    = [];

  placemarks.forEach(pm => {
    const name = pm.querySelector('name')?.textContent?.trim() || '';
    const desc = pm.querySelector('description')?.textContent?.trim() || '';

    // Extract coordinates (lng,lat[,alt])
    const coordsEl = pm.querySelector('Point coordinates') || pm.querySelector('coordinates');
    if (!coordsEl) return;

    const [lngStr, latStr] = coordsEl.textContent.trim().split(',');
    const lat = parseFloat(latStr);
    const lng = parseFloat(lngStr);
    if (isNaN(lat) || isNaN(lng)) return;

    // Try to extract date from description or extended data
    let date = null;
    const dateMatch = desc.match(/(\d{4}-\d{2}-\d{2})/);
    if (dateMatch) date = dateMatch[1];

    // Try extended data fields
    const extData = pm.querySelectorAll('SimpleData');
    let region = '';
    extData.forEach(sd => {
      const n = sd.getAttribute('name')?.toLowerCase() || '';
      if (n.includes('date') && !date) date = sd.textContent.trim();
      if (n.includes('region') || n.includes('location') || n.includes('city')) region = sd.textContent.trim();
    });

    results.push({ name, description: desc, lat, lng, date, region });
  });

  return results;
}

/**
 * Parse a CSV string. Expects headers in first row.
 * Recognized columns (case-insensitive): name/titre, date, lat/latitude, lng/longitude/lon, region/city/ville
 */
export function parseCSV(csvText) {
  const lines  = csvText.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/"/g, ''));
  const col     = name => {
    const aliases = {
      name:   ['name','titre','title','nom','point'],
      date:   ['date','jour','day'],
      lat:    ['lat','latitude'],
      lng:    ['lng','lon','longitude'],
      region: ['region','city','ville','lieu','location'],
    };
    for (const [key, list] of Object.entries(aliases)) {
      if (key === name) {
        const idx = headers.findIndex(h => list.includes(h));
        return idx;
      }
    }
    return -1;
  };

  const nameIdx   = col('name');
  const dateIdx   = col('date');
  const latIdx    = col('lat');
  const lngIdx    = col('lng');
  const regionIdx = col('region');

  const results = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = _parseCSVLine(lines[i]);
    const lat   = parseFloat(cells[latIdx]);
    const lng   = parseFloat(cells[lngIdx]);
    if (isNaN(lat) || isNaN(lng)) continue;

    results.push({
      name:        cells[nameIdx]   || `Point ${i}`,
      date:        cells[dateIdx]   || null,
      lat,
      lng,
      region:      cells[regionIdx] || '',
      description: '',
    });
  }
  return results;
}

function _parseCSVLine(line) {
  const cells  = [];
  let cur      = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/**
 * Group raw placemarks into trips by (date, region) clusters and import.
 * Returns the number of trips created.
 */
export function importPlacemarks(placemarks, defaultType = 'voyage') {
  if (!placemarks.length) return 0;

  // Group by date key (YYYY-MM) + region key
  const groups = {};
  placemarks.forEach(p => {
    const dateKey   = p.date ? p.date.slice(0, 7) : 'unknown';
    const regionKey = (p.region || p.name || '').slice(0, 20).trim().replace(/\s+/g, '_') || 'voyage';
    const key       = `${dateKey}__${regionKey}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(p);
  });

  let count = 0;
  Object.entries(groups).forEach(([key, pts]) => {
    const dates  = pts.map(p => p.date).filter(Boolean).sort();
    const start  = dates[0]  || null;
    const end    = dates[dates.length - 1] || null;
    const region = pts[0]?.region || pts[0]?.name || 'Importé';

    // Build days from grouped points
    const daysMap = {};
    pts.forEach(p => {
      const dayKey = p.date || 'unknown';
      if (!daysMap[dayKey]) {
        daysMap[dayKey] = {
          id:     'd_' + uid(),
          num:    0,
          date:   p.date || null,
          title:  p.region || p.name || 'Étape',
          region: p.region || region,
          lat:    p.lat,
          lng:    p.lng,
          color:  '#0d9488',
          photo:  '',
          items:  [],
        };
      }
      daysMap[dayKey].items.push({
        id:        'i_' + uid(),
        type:      'visit',
        text:      p.name || 'Point',
        time:      '',
        cost:      0,
        notes:     p.description || '',
      });
    });

    const days = Object.values(daysMap).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    days.forEach((d, i) => { d.num = i + 1; });

    const tripName = region || (start ? start.slice(0, 7) : 'Voyage importé');
    addTrip({
      name:        tripName,
      destination: region,
      flag:        '🌍',
      color:       '#0d9488',
      type:        defaultType,
      startDate:   start,
      endDate:     end,
      days,
    });
    count++;
  });

  return count;
}

/**
 * Handle a file input change event — reads the file and imports it.
 * Supports .json (full trip export), .kml, .csv
 * @param {File} file
 * @param {string} type — 'voyage' | 'weekend' | 'sortie' (for KML/CSV)
 * @param {Function} onDone — called when import is complete
 */
export async function importFile(file, type, onDone) {
  if (!file) return;

  // JSON full-trip import
  if (file.name.toLowerCase().endsWith('.json')) {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const trips = Array.isArray(data) ? data : [data];
      let count = 0;
      for (const tripData of trips) {
        if (tripData && typeof tripData === 'object' && tripData.name) {
          addTrip(tripData); // createTrip() inside will assign fresh id/createdAt
          count++;
        }
      }
      notify(`${count} voyage(s) importé(s)`, '✅');
      if (onDone) onDone(count);
    } catch (err) {
      notify(`Erreur JSON : ${err.message}`, '⚠');
    }
    return;
  }

  const text = await file.text();
  let placemarks = [];

  try {
    if (file.name.toLowerCase().endsWith('.kml')) {
      placemarks = parseKML(text);
    } else if (file.name.toLowerCase().endsWith('.csv')) {
      placemarks = parseCSV(text);
    } else {
      notify('Format non supporté. Utilisez .json, .kml ou .csv', '⚠');
      return;
    }
  } catch (err) {
    notify(`Erreur de lecture: ${err.message}`, '⚠');
    return;
  }

  if (!placemarks.length) {
    notify('Aucun point trouvé dans le fichier', '⚠');
    return;
  }

  const count = importPlacemarks(placemarks, type);
  notify(`${count} voyage(s) importé(s) depuis ${placemarks.length} points`);
  if (onDone) onDone(count);
}
