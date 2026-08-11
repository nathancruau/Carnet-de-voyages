/* ============================================================
   CARNET DE VOYAGES — KML / CSV / Polarsteps Import
   ============================================================ */

import { addTrip, uid } from './store.js';
import { notify } from './utils.js';

// ── Polarsteps constants ──────────────────────────────────────────────────────

const _PS_WEATHER = {
  'clear-day':           '☀️',
  'clear-night':         '🌙',
  'partly-cloudy-day':   '⛅',
  'partly-cloudy-night': '☁️',
  'cloudy':              '☁️',
  'rain':                '🌧️',
  'sleet':               '🌨️',
  'snow':                '❄️',
  'wind':                '💨',
  'fog':                 '🌫️',
  'hail':                '🌨️',
  'thunderstorm':        '⛈️',
};

const _PS_CC_NAME = {
  IS:'Islande',FR:'France',ES:'Espagne',IT:'Italie',DE:'Allemagne',PT:'Portugal',
  GB:'Royaume-Uni',NL:'Pays-Bas',BE:'Belgique',CH:'Suisse',AT:'Autriche',
  GR:'Grèce',HR:'Croatie',PL:'Pologne',NO:'Norvège',SE:'Suède',DK:'Danemark',
  FI:'Finlande',IE:'Irlande',US:'États-Unis',CA:'Canada',MX:'Mexique',
  JP:'Japon',CN:'Chine',AU:'Australie',NZ:'Nouvelle-Zélande',BR:'Brésil',
  AR:'Argentine',CL:'Chili',CO:'Colombie',PE:'Pérou',MA:'Maroc',TN:'Tunisie',
  EG:'Égypte',ZA:'Afrique du Sud',KE:'Kenya',TH:'Thaïlande',VN:'Vietnam',
  ID:'Indonésie',MY:'Malaisie',SG:'Singapour',PH:'Philippines',IN:'Inde',
  NP:'Népal',LK:'Sri Lanka',TW:'Taïwan',KH:'Cambodge',TR:'Turquie',
  IL:'Israël',JO:'Jordanie',AE:'Émirats arabes unis',SA:'Arabie Saoudite',
  QA:'Qatar',GE:'Géorgie',AM:'Arménie',KZ:'Kazakhstan',
};

// ── Polarsteps private helpers ────────────────────────────────────────────────

function _psToIso(ts) {
  return ts == null ? null : new Date(ts * 1000).toISOString().slice(0, 10);
}

function _psToTime(ts) {
  return ts == null ? '' : new Date(ts * 1000).toTimeString().slice(0, 5);
}

function _psCcToFlag(cc) {
  if (!cc || cc.length !== 2) return null;
  const u = cc.toUpperCase();
  return String.fromCodePoint(u.charCodeAt(0) - 65 + 0x1F1E6, u.charCodeAt(1) - 65 + 0x1F1E6);
}

function _psTripBase(data) {
  const countryCounts = {};
  for (const s of data.all_steps) {
    const cc = s.location?.country_code;
    if (cc) countryCounts[cc] = (countryCounts[cc] || 0) + 1;
  }
  const mainCC      = Object.entries(countryCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  const flag        = _psCcToFlag(mainCC) || '🌍';
  const destination = _PS_CC_NAME[mainCC.toUpperCase()] || mainCC || '';
  return {
    name:      data.name || 'Voyage Polarsteps',
    destination,
    flag,
    color:     '#0d9488',
    type:      'voyage',
    status:    'done',
    startDate: _psToIso(data.start_date),
    endDate:   _psToIso(data.end_date),
  };
}

// stepPhotos: { [stepId]: [base64, …] }
// validateAll: true for ZIP imports — sets journalData.validated on every step
function _psBuildDays(steps, stepPhotos = {}, validateAll = false) {
  const daysMap = {};

  for (const step of steps) {
    if (step.start_time == null) continue;
    const dateKey = _psToIso(step.start_time);
    if (!dateKey) continue;

    if (!daysMap[dateKey]) {
      const loc = step.location || {};
      daysMap[dateKey] = {
        id:     'd_' + uid(),
        num:    0,
        date:   dateKey,
        title:  loc.name || loc.detail || '',
        region: loc.full_detail || loc.detail || loc.name || '',
        lat:    loc.lat ?? null,
        lng:    loc.lon ?? null,
        color:  '#0d9488',
        photo:  '',
        items:  [],
      };
    }

    const loc    = step.location || {};
    const wx     = _PS_WEATHER[step.weather_condition] || '';
    const wxTemp = step.weather_temperature != null ? `${step.weather_temperature}°C` : '';
    const wxNote = [wx, wxTemp].filter(Boolean).join(' ');
    const desc   = (step.description || '').trim();
    const notes  = [desc, wxNote].filter(Boolean).join('\n\n').trim();
    const photos = stepPhotos[step.id] || [];

    const item = {
      id:    'i_' + uid(),
      type:  'visit',
      text:  step.name || step.display_name || 'Étape',
      time:  _psToTime(step.start_time),
      cost:  0,
      notes,
      lat:   loc.lat ?? null,
      lng:   loc.lon ?? null,
    };

    if (validateAll || photos.length > 0) {
      item.journalData = {
        validated:   true,
        validatedAt: step.start_time * 1000,
        notes:       desc,
        photos,
      };
    }

    daysMap[dateKey].items.push(item);
  }

  const days = Object.values(daysMap).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  days.forEach((d, i) => { d.num = i + 1; });
  return days;
}

// ── Public Polarsteps API ─────────────────────────────────────────────────────

/**
 * Return true if the parsed JSON object looks like a Polarsteps trip export.
 */
export function isPolarstepsExport(data) {
  return data != null && typeof data === 'object' && Array.isArray(data.all_steps);
}

/**
 * Import a Polarsteps JSON export and add it to the store.
 * Returns the created trip object, or null on failure.
 */
export function importPolarstepsTrip(data) {
  if (!isPolarstepsExport(data)) return null;
  return addTrip({ ..._psTripBase(data), days: _psBuildDays(data.all_steps) });
}

// ── ZIP helpers ───────────────────────────────────────────────────────────────

async function _loadJSZip() {
  if (window.JSZip) return window.JSZip;
  return new Promise((resolve, reject) => {
    const s  = document.createElement('script');
    s.src    = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
    s.onload  = () => resolve(window.JSZip);
    s.onerror = () => reject(new Error('Impossible de charger JSZip depuis le CDN'));
    document.head.appendChild(s);
  });
}

async function _compressPhotoBlob(blob, maxDim = 1200) {
  return new Promise(resolve => {
    const img    = new Image();
    const objUrl = URL.createObjectURL(blob);
    img.onload = () => {
      URL.revokeObjectURL(objUrl);
      let { width: w, height: h } = img;
      if (w > maxDim || h > maxDim) {
        if (w >= h) { h = Math.round(h * maxDim / w); w = maxDim; }
        else        { w = Math.round(w * maxDim / h); h = maxDim; }
      }
      const canvas = document.createElement('canvas');
      canvas.width  = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.78));
    };
    img.onerror = () => { URL.revokeObjectURL(objUrl); resolve(null); };
    img.src = objUrl;
  });
}

// ── KML / CSV public API ──────────────────────────────────────────────────────

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
        id:    'i_' + uid(),
        type:  'visit',
        text:  p.name || 'Point',
        time:  '',
        cost:  0,
        notes: p.description || '',
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
 * Handle a file input — reads the file and imports it.
 * Supports .json (full trip export), .kml, .csv
 * @param {File} file
 * @param {string} type — 'voyage' | 'weekend' | 'sortie' (for KML/CSV)
 * @param {Function} onDone — called when import is complete
 */
export async function importFile(file, type, onDone) {
  if (!file) return;

  // JSON full-trip import (standard export OR Polarsteps)
  if (file.name.toLowerCase().endsWith('.json')) {
    try {
      const text = await file.text();
      const data = JSON.parse(text);

      // Polarsteps export detection: has an `all_steps` array at top level
      if (isPolarstepsExport(data)) {
        const trip = importPolarstepsTrip(data);
        if (trip) {
          const stepCount = trip.days?.reduce((n, d) => n + (d.items?.length || 0), 0) || 0;
          notify(`Polarsteps importé : ${trip.name} — ${trip.days?.length || 0} jours, ${stepCount} étapes`, '✅');
          if (onDone) onDone(1);
        } else {
          notify('Erreur lors de l\'import Polarsteps', '⚠');
        }
        return;
      }

      // Standard app JSON export (single trip object or array of trips)
      const trips = Array.isArray(data) ? data : [data];
      let count = 0;
      for (const tripData of trips) {
        if (tripData && typeof tripData === 'object' && tripData.name) {
          addTrip(tripData);
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
      notify('Format non supporté. Utilisez .json, .kml, .csv ou .zip', '⚠');
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

// ── App ZIP re-import ─────────────────────────────────────────────────────────

async function _blobToBase64(blob) {
  return new Promise(resolve => {
    const r = new FileReader();
    r.onload  = () => resolve(r.result);
    r.onerror = () => resolve(null);
    r.readAsDataURL(blob);
  });
}

async function _restorePhotos(days, zip, folder) {
  const result = [];
  for (const day of days) {
    const items = [];
    for (const item of (day.items || [])) {
      const photos = item.journalData?.photos;
      if (!photos?.length) { items.push(item); continue; }
      const restored = [];
      for (const ref of photos) {
        if (!ref || ref.startsWith('data:')) { restored.push(ref); continue; }
        const entry = zip.file(`${folder}/${ref}`);
        if (!entry) { restored.push(null); continue; }
        try { restored.push(await _blobToBase64(await entry.async('blob'))); }
        catch { restored.push(null); }
      }
      items.push({ ...item, journalData: { ...item.journalData, photos: restored.filter(Boolean) } });
    }
    result.push({ ...day, items });
  }
  return result;
}

export async function importAnyZip(zipFile, onProgress) {
  const JSZip = await _loadJSZip();
  const zip   = await JSZip.loadAsync(zipFile);

  // ── Polarsteps: trip.json with all_steps (root or inside a parent folder) ────
  // Use regex fallback so we find trip.json even when it's inside export_name/trip.json
  const rootTrip = zip.file('trip.json') ?? zip.file(/(?:^|\/)trip\.json$/)?.[0];
  if (rootTrip) {
    let tripData = null;
    try { tripData = JSON.parse(await rootTrip.async('text')); } catch (_) {}
    if (tripData && isPolarstepsExport(tripData)) {
      // Extract photos inline (avoids re-reading the ZIP a second time)
      const photoEntries = [];
      zip.forEach((path, entry) => {
        if (!entry.dir
          && /\/photos\/[^/]+$/i.test(path)
          && /\.(jpe?g|png|webp|gif)$/i.test(path)) {
          const m = path.match(/_(\d+)\/photos\/[^/]+$/i);
          if (m) photoEntries.push({ path, entry, stepId: parseInt(m[1], 10) });
        }
      });
      const total = photoEntries.length;
      let done = 0;
      if (onProgress) onProgress(0, total);
      const stepPhotos = {};
      for (const { path, entry, stepId } of photoEntries) {
        try {
          const blob   = await entry.async('blob');
          const base64 = await _compressPhotoBlob(blob);
          if (base64) (stepPhotos[stepId] ??= []).push(base64);
        } catch (e) { console.warn('[zip] photo error', path, e.message); }
        done++;
        if (onProgress) onProgress(done, total);
      }
      const days = _psBuildDays(tripData.all_steps, stepPhotos, true);
      const trip = addTrip({ ..._psTripBase(tripData), days });
      return { trips: trip ? [trip] : [], format: 'polarsteps' };
    }
  }

  // App "All": subfolders with {…/}folder/trip.json
  // Accept both flat (folder/trip.json) and nested (parent/folder/trip.json)
  const folders = [];
  zip.forEach((path, entry) => {
    if (!entry.dir && path.endsWith('/trip.json')) {
      const folder = path.slice(0, -'/trip.json'.length);
      if (folder) folders.push(folder);
    }
  });

  if (folders.length > 0) {
    const trips = [];
    let done = 0;
    if (onProgress) onProgress(0, folders.length);
    for (const folder of folders) {
      const te = zip.file(`${folder}/trip.json`);
      if (te) {
        try {
          const data = JSON.parse(await te.async('text'));
          if (data.name && Array.isArray(data.days)) {
            const days = await _restorePhotos(data.days, zip, folder);
            trips.push(addTrip({ ...data, id: undefined, days }));
          }
        } catch (e) { console.warn('[zip] folder', folder, e); }
      }
      done++;
      if (onProgress) onProgress(done, folders.length);
    }
    return { trips, format: 'carnet-all' };
  }

  // App "Planning": *.json files with no sub-path depth (root or single parent folder)
  const planFiles = [];
  zip.forEach((path, entry) => {
    if (!entry.dir && path.endsWith('.json')) {
      const depth = path.split('/').length;
      // Accept root-level (depth=1) or directly inside one parent folder (depth=2)
      if (depth <= 2) planFiles.push({ path, entry });
    }
  });

  if (planFiles.length > 0) {
    const trips = [];
    let done = 0;
    if (onProgress) onProgress(0, planFiles.length);
    for (const { path, entry } of planFiles) {
      try {
        const data = JSON.parse(await entry.async('text'));
        if (data.name && Array.isArray(data.days)) trips.push(addTrip({ ...data, id: undefined }));
      } catch (e) { console.warn('[zip] planning file', path, e); }
      done++;
      if (onProgress) onProgress(done, planFiles.length);
    }
    return { trips, format: 'carnet-planning' };
  }

  throw new Error('Format ZIP non reconnu. Attendu : export Polarsteps ou export Carnet de Voyages.');
}
