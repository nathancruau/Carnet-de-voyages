/* ============================================================
   CARNET DE VOYAGES — Trip statistics modal
   Read-only summary opened from the home screen's "⋯" trip menu.
   Reuses the .stat-card / .stat-kpi-* classes already styled for the
   global "Mes statistiques" page (home.js) so this needs no new CSS.
   ============================================================ */

import { getTrip, getEventTypes } from '../store.js';
import { showModal, esc as _esc } from '../utils.js';
import { getParticipants } from './tricount.js';

function _fmtEur(v) {
  const n = Number(v) || 0;
  return n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

function _fmtDist(meters) {
  if (meters >= 1000) return (meters / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' km';
  return Math.round(meters) + ' m';
}

/** Great-circle distance in meters between two {lat,lng} points. */
function _haversineMeters(a, b) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function _kpi(icon, val, lbl) {
  return `
    <div class="stat-kpi-tile">
      <div class="stat-kpi-icon">${icon}</div>
      <div class="stat-kpi-val">${val}</div>
      <div class="stat-kpi-lbl">${lbl}</div>
    </div>`;
}

function _kv(label, value, valueColor) {
  return `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--c3);font-size:13px">
      <span style="color:var(--ink2)">${label}</span>
      <span style="font-weight:700;color:${valueColor || 'var(--ink)'}">${value}</span>
    </div>`;
}

function _personBar(p, amount, maxAmount) {
  const pct   = maxAmount > 0 ? Math.round((amount / maxAmount) * 100) : 0;
  const color = p.color || '#0d9488';
  return `
    <div style="margin-bottom:9px">
      <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;margin-bottom:4px">
        <span style="display:flex;align-items:center;gap:6px;min-width:0">
          <span class="comp-avatar" style="background:${_esc(color)};width:20px;height:20px;font-size:9px;flex-shrink:0">
            ${_esc((p.name || '?').slice(0, 2).toUpperCase())}
          </span>
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(p.name)}</span>
        </span>
        <b style="flex-shrink:0;margin-left:8px">${_fmtEur(amount)}</b>
      </div>
      <div style="height:6px;background:var(--c3);border-radius:3px;overflow:hidden">
        <div style="height:100%;width:${pct}%;background:${_esc(color)}"></div>
      </div>
    </div>`;
}

function _typeRow(icon, label, count) {
  return `
    <div style="display:flex;align-items:center;gap:9px;margin-bottom:8px;font-size:12px">
      <span style="font-size:16px;width:20px;text-align:center;flex-shrink:0">${icon}</span>
      <span style="flex:1;color:var(--ink2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(label)}</span>
      <b>${count}</b>
    </div>`;
}

export function openTripStatsModal(tripId) {
  const trip = getTrip(tripId);
  if (!trip) return;

  if (trip.type === 'sortie') {
    showModal(`
      <button class="mc" onclick="closeModal()">✕</button>
      <h3>📊 Statistiques</h3>
      <p style="font-size:13px;color:var(--ink3);line-height:1.5">
        Les statistiques détaillées ne s'appliquent pas à une sortie —
        retrouvez sa trace GPX et ses informations directement dans son écran détail.
      </p>`);
    return;
  }

  const days     = trip.days || [];
  const allItems = days.flatMap(d => (d.items || []).map(it => ({ ...it, _day: d })));

  // ── Overview ──────────────────────────────────────────────────────────────
  const nDays   = days.length;
  const nNights = Math.max(0, nDays - 1);
  const participants = getParticipants(trip);
  const realExpenses  = (trip.realExpenses || []).filter(e => e.type !== 'transfer');
  const nEvents = allItems.filter(it => it.type !== 'sleep').length;

  const placeKeys = new Set();
  for (const it of allItems) {
    if (it.lat != null && it.lng != null) placeKeys.add(it.lat.toFixed(3) + ',' + it.lng.toFixed(3));
  }

  // Straight-line distance between consecutive geolocated points, in
  // chronological order — an estimate (not routed roads), same base
  // measure the app already uses elsewhere (_haversineMeters in mapcal.js).
  const geoPoints = allItems
    .filter(it => it.lat != null && it.lng != null)
    .sort((a, b) =>
      (a._day.date || '').localeCompare(b._day.date || '') ||
      (a.time || '').localeCompare(b.time || ''));
  let totalMeters = 0;
  for (let i = 1; i < geoPoints.length; i++) totalMeters += _haversineMeters(geoPoints[i - 1], geoPoints[i]);

  // ── Expenses ──────────────────────────────────────────────────────────────
  const totalSpent   = realExpenses.reduce((s, e) => s + (Number(e.amountEur ?? e.amount) || 0), 0);
  const totalPlanned = (trip.budgetLines || []).reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const avgPerDay     = nDays > 0 ? totalSpent / nDays : 0;
  const plannedPct    = totalPlanned > 0 ? Math.round((totalSpent / totalPlanned) * 100) : null;

  const catTotals = {};
  for (const e of realExpenses) {
    if (!e.catId) continue;
    catTotals[e.catId] = (catTotals[e.catId] || 0) + (Number(e.amountEur ?? e.amount) || 0);
  }
  let topCat = null;
  for (const cat of (trip.budgetCats || [])) {
    const v = catTotals[cat.id] || 0;
    if (v > 0 && (!topCat || v > topCat.value)) topCat = { cat, value: v };
  }

  const paidByPerson = {};
  for (const e of realExpenses) {
    if (!e.paidById) continue;
    paidByPerson[e.paidById] = (paidByPerson[e.paidById] || 0) + (Number(e.amountEur ?? e.amount) || 0);
  }
  const personRows = participants
    .map(p => ({ p, amount: paidByPerson[p.id] || 0 }))
    .filter(r => r.amount > 0)
    .sort((a, b) => b.amount - a.amount);
  const maxPersonAmount = personRows.length ? personRows[0].amount : 0;

  // ── Activity type breakdown ──────────────────────────────────────────────
  const typeCounts = {};
  for (const it of allItems) {
    if (it.type === 'sleep') continue;
    typeCounts[it.type] = (typeCounts[it.type] || 0) + 1;
  }
  const eventTypes = getEventTypes();
  const typeRows = Object.entries(typeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([key, count]) => {
      const meta = eventTypes.find(t => t.key === key);
      return { icon: meta?.emoji || '•', label: meta?.label || key, count };
    });

  // ── Photos & journal (same field walk as auth.js's _collectStorageUrls,
  //    but counting instead of collecting URLs) ────────────────────────────
  let nPhotos = trip.photo ? 1 : 0;
  nPhotos += (trip.photos || []).length;
  let nDocumentedDays = 0;
  for (const day of days) {
    let has = false;
    for (const it of (day.items || [])) {
      if (it.photo) nPhotos++;
      nPhotos += (it.photos || []).length;
      nPhotos += (it.journalData?.photos || []).length;
      if (it.journalData?.validated) has = true;
    }
    if (has) nDocumentedDays++;
  }
  for (const je of (trip.journalEntries || [])) nPhotos += (je.photos || []).length;

  // ── Packing ───────────────────────────────────────────────────────────────
  const packingCats    = trip.packingCats || [];
  const packingChecked = trip.packingChecked || {};
  const packingTotal   = packingCats.reduce((s, c) => s + (c.items || []).length, 0);
  const packingDone    = Object.values(packingChecked).filter(Boolean).length;

  // ── Build HTML ────────────────────────────────────────────────────────────
  const overviewHtml = `
    <div class="stat-kpi-grid">
      ${_kpi('🗓️', nDays, nDays > 1 ? 'Jours' : 'Jour')}
      ${_kpi('🌙', nNights, nNights > 1 ? 'Nuits' : 'Nuit')}
      ${_kpi('🧑‍🤝‍🧑', participants.length, participants.length > 1 ? 'Voyageurs' : 'Voyageur')}
      ${_kpi('🎯', nEvents, nEvents > 1 ? 'Activités' : 'Activité')}
      ${_kpi('📍', placeKeys.size, placeKeys.size > 1 ? 'Lieux' : 'Lieu')}
      ${_kpi('🗺️', totalMeters > 0 ? _fmtDist(totalMeters) : '—', 'Distance')}
    </div>`;

  let expenseHtml = `<div class="stat-card" style="margin-bottom:14px">
    <div class="stat-card-title">💶 Dépenses</div>`;
  if (realExpenses.length === 0) {
    expenseHtml += `<p style="font-size:12px;color:var(--ink4)">Aucune dépense enregistrée dans les Dépenses partagées.</p>`;
  } else {
    expenseHtml += _kv('Total dépensé', _fmtEur(totalSpent), 'var(--teal)');
    expenseHtml += _kv('Moyenne par jour', nDays > 0 ? _fmtEur(avgPerDay) : '—');
    if (plannedPct !== null) {
      expenseHtml += _kv('Budget prévu', `${_fmtEur(totalPlanned)} <span style="font-weight:400;color:var(--ink4)">(${plannedPct}%)</span>`,
        plannedPct > 100 ? 'var(--coral)' : 'var(--ink)');
    }
    if (topCat) {
      expenseHtml += _kv('Catégorie la plus chère', `${_esc(topCat.cat.icon || '📦')} ${_esc(topCat.cat.name)} — ${_fmtEur(topCat.value)}`);
    }
    if (personRows.length > 1) {
      expenseHtml += `<div style="margin-top:12px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--ink4);margin-bottom:8px">Payé par personne</div>`;
      expenseHtml += personRows.map(r => _personBar(r.p, r.amount, maxPersonAmount)).join('');
    }
  }
  expenseHtml += `</div>`;

  let activityHtml = '';
  if (typeRows.length) {
    activityHtml = `<div class="stat-card" style="margin-bottom:14px">
      <div class="stat-card-title">🎯 Activités par type</div>
      ${typeRows.map(r => _typeRow(r.icon, r.label, r.count)).join('')}
    </div>`;
  }

  const journalHtml = `<div class="stat-card" style="margin-bottom:14px">
    <div class="stat-card-title">📸 Carnet &amp; photos</div>
    ${_kv('Photos ajoutées', nPhotos)}
    ${_kv('Jours documentés', nDays > 0 ? `${nDocumentedDays} / ${nDays}` : '—')}
  </div>`;

  let packingHtml = '';
  if (packingTotal > 0) {
    const pct = Math.round((packingDone / packingTotal) * 100);
    packingHtml = `<div class="stat-card">
      <div class="stat-card-title">🎒 Bagages</div>
      ${_kv('Articles emballés', `${packingDone} / ${packingTotal} <span style="font-weight:400;color:var(--ink4)">(${pct}%)</span>`)}
    </div>`;
  }

  showModal(`
    <button class="mc" onclick="closeModal()">✕</button>
    <h3>📊 Statistiques${trip.name ? ' — ' + _esc(trip.name) : ''}</h3>
    <div class="stats-wrap">
      ${overviewHtml}
      ${expenseHtml}
      ${activityHtml}
      ${journalHtml}
      ${packingHtml}
    </div>`);
}
