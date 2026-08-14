/* ============================================================
   CARNET DE VOYAGES — Export (JSON, ZIP, PDF)
   ============================================================ */

import { customDayTitle } from './utils.js';

// ── Private helpers ───────────────────────────────────────────────────────────

async function _loadJSZip() {
  if (window.JSZip) return window.JSZip;
  return new Promise((resolve, reject) => {
    const s  = document.createElement('script');
    s.src    = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
    s.onload  = () => resolve(window.JSZip);
    s.onerror = () => reject(new Error('Impossible de charger JSZip'));
    document.head.appendChild(s);
  });
}

function _dl(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function _safeName(str) {
  return (str || 'voyage')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').toLowerCase()
    .slice(0, 40).replace(/-+$/, '') || 'voyage';
}

function _fmtDate(iso) {
  if (!iso) return '';
  try { return new Date(iso + 'T12:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }); }
  catch { return iso; }
}

function _esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Planning export (JSON, no photos) ────────────────────────────────────────

export function tripToPlanning(trip) {
  return {
    _format:     'carnet-planning-v1',
    id:          trip.id,
    name:        trip.name,
    destination: trip.destination,
    flag:        trip.flag,
    color:       trip.color,
    type:        trip.type,
    status:      trip.status,
    startDate:   trip.startDate,
    endDate:     trip.endDate,
    companions:  trip.companions  || [],
    days: (trip.days || []).map(day => ({
      id: day.id, num: day.num, date: day.date,
      title: day.title, region: day.region,
      lat: day.lat, lng: day.lng, color: day.color, photo: day.photo,
      items: (day.items || []).map(({ journalData, ...rest }) => rest),
    })),
    budgetLines: trip.budgetLines || [],
    budgetCats:  trip.budgetCats  || [],
    pin:         trip.pin,
  };
}

export function downloadTripPlanning(trip) {
  const blob = new Blob([JSON.stringify(tripToPlanning(trip), null, 2)], { type: 'application/json;charset=utf-8' });
  _dl(blob, `${_safeName(trip.name)}_planning.json`);
}

// ── All export (ZIP with JSON + photos) ───────────────────────────────────────

async function _addTripToZip(zip, trip) {
  const folder = zip.folder(_safeName(trip.name));

  const days = (trip.days || []).map(day => ({
    ...day,
    items: (day.items || []).map(item => {
      const photos = item.journalData?.photos;
      if (!photos?.length) return item;
      const refs = photos.map((b64, i) => {
        if (!b64?.startsWith('data:')) return b64;
        const ext  = b64.startsWith('data:image/png') ? 'png' : 'jpg';
        const ref  = `photos/${item.id}_${i}.${ext}`;
        folder.file(ref, b64.replace(/^data:image\/\w+;base64,/, ''), { base64: true });
        return ref;
      });
      return { ...item, journalData: { ...item.journalData, photos: refs } };
    }),
  }));

  let coverPhoto = trip.photo;
  if (trip.photo?.startsWith('data:image')) {
    const ext = trip.photo.startsWith('data:image/png') ? 'png' : 'jpg';
    folder.file(`photos/_cover.${ext}`, trip.photo.replace(/^data:image\/\w+;base64,/, ''), { base64: true });
    coverPhoto = `photos/_cover.${ext}`;
  }

  folder.file('trip.json', JSON.stringify({ _format: 'carnet-all-v1', ...trip, photo: coverPhoto, days }, null, 2));
}

export async function downloadTripAll(trip) {
  const JSZip = await _loadJSZip();
  const zip   = new JSZip();
  await _addTripToZip(zip, trip);
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  _dl(blob, `${_safeName(trip.name)}_all.zip`);
}

// ── Multi-trip ZIP export ─────────────────────────────────────────────────────

export async function downloadTripsZip(trips, mode, onProgress) {
  const JSZip = await _loadJSZip();
  const zip   = new JSZip();
  const date  = new Date().toISOString().slice(0, 10);
  let done = 0;
  for (const trip of trips) {
    if (mode === 'planning') {
      zip.file(`${_safeName(trip.name)}_planning.json`, JSON.stringify(tripToPlanning(trip), null, 2));
    } else {
      await _addTripToZip(zip, trip);
    }
    done++;
    if (onProgress) onProgress(done, trips.length);
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  _dl(blob, `carnet-voyages_${mode}_${date}.zip`);
}

// ── Custom export (PDF / Word) ────────────────────────────────────────────────

export function exportTripCustom(trip, opts = {}) {
  const {
    format     = 'pdf',
    sections   = ['planning','expenses','budget','packing','companions'],
    theme      = 'classic',
    cover      = true,
    toc        = false,
    decorBg    = false,
    fullPhotos = false,
    anecdote   = '',
  } = opts;

  const html = _buildCustomHtml(trip, {
    sections: new Set(sections), theme, cover, toc, decorBg, fullPhotos, anecdote,
  });

  if (format === 'word') {
    const blob = new Blob(['﻿' + html], { type: 'application/msword;charset=utf-8' });
    _dl(blob, `${_safeName(trip.name)}.doc`);
  } else {
    const w = window.open('', '_blank');
    if (!w) { alert('Veuillez autoriser les popups pour exporter en PDF.'); return; }
    w.document.write(html);
    w.document.close();
    setTimeout(() => w.print(), 800);
  }
}

// ── Theme palettes ────────────────────────────────────────────────────────────

const _THEMES = {
  classic: { primary:'#0d9488', dark:'#0f766e', light:'#f0fdfa', accent:'#99f6e4', grad:'linear-gradient(135deg,#0d9488,#0f766e)' },
  nature:  { primary:'#16a34a', dark:'#14532d', light:'#f0fdf4', accent:'#86efac', grad:'linear-gradient(135deg,#16a34a,#15803d)' },
  warm:    { primary:'#d97706', dark:'#92400e', light:'#fffbeb', accent:'#fde68a', grad:'linear-gradient(135deg,#d97706,#b45309)' },
  marine:  { primary:'#0284c7', dark:'#1e40af', light:'#eff6ff', accent:'#bae6fd', grad:'linear-gradient(135deg,#0284c7,#1d4ed8)' },
};

// ── Custom HTML builder ───────────────────────────────────────────────────────

function _buildCustomHtml(trip, opts) {
  const { sections, theme: themeKey, cover, toc, decorBg, fullPhotos, anecdote } = opts;
  const th = _THEMES[themeKey] || _THEMES.classic;

  const days = (trip.days || []).slice().sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const companions = (trip.companions || []).map(c => c.name).join(', ');
  const dateRange  = trip.startDate && trip.endDate
    ? `${_fmtDate(trip.startDate)} → ${_fmtDate(trip.endDate)}`
    : trip.startDate ? _fmtDate(trip.startDate) : '';

  // ── Cover page ─────────────────────────────────────────────────────────────
  let coverHtml = '';
  if (cover) {
    const coverPhoto = trip.photo ? `<div class="cv-photo"><img src="${_esc(trip.photo)}" alt="" onerror="this.parentNode.style.display='none'"></div>` : '';
    const decorClass = decorBg ? ' cv-decor' : '';
    coverHtml = `<div class="cover${decorClass}">
      ${coverPhoto}
      <div class="cv-inner">
        <div class="cv-flag">${trip.flag || '🌍'}</div>
        <h1 class="cv-title">${_esc(trip.name || 'Voyage')}</h1>
        ${trip.destination ? `<p class="cv-dest">📍 ${_esc(trip.destination)}</p>` : ''}
        ${dateRange ? `<p class="cv-date">📅 ${_esc(dateRange)}</p>` : ''}
        ${companions ? `<p class="cv-comps">👥 ${_esc(companions)}</p>` : ''}
        ${anecdote ? `<blockquote class="cv-anecdote">${_esc(anecdote).replace(/\n/g,'<br>')}</blockquote>` : ''}
      </div>
    </div>`;
  }

  // ── TOC ────────────────────────────────────────────────────────────────────
  let tocHtml = '';
  if (toc) {
    const tocItems = [];
    if (sections.has('planning')) tocItems.push(`<li>📅 Planning &amp; Carnet</li>`);
    if (sections.has('expenses')) tocItems.push(`<li>💳 Dépenses</li>`);
    if (sections.has('budget'))   tocItems.push(`<li>💶 Budget prévisionnel</li>`);
    if (sections.has('packing'))  tocItems.push(`<li>🧳 Bagages</li>`);
    if (sections.has('companions') && companions) tocItems.push(`<li>👥 Compagnons</li>`);
    if (tocItems.length) {
      tocHtml = `<div class="toc${cover ? ' page-break' : ''}">
        <h2 class="sec-title">Sommaire</h2>
        <ul class="toc-list">${tocItems.join('')}</ul>
      </div>`;
    }
  }

  // ── Planning & Carnet ──────────────────────────────────────────────────────
  let planningHtml = '';
  if (sections.has('planning')) {
    const daysHtml = days.map(day => {
      const itemsHtml = (day.items || []).map(item => {
        const jd     = item.journalData;
        const notes  = jd?.notes || item.notes || '';
        const photos = (jd?.photos || []).filter(Boolean);
        const photoClass = fullPhotos ? 'photos-full' : 'photos-grid';
        return `<div class="item">
          <div class="item-hd">
            ${item.time ? `<span class="item-time">${_esc(item.time)}</span>` : '<span class="item-time"></span>'}
            <span class="item-text">${_esc(item.text || '')}</span>
            ${item.cost ? `<span class="item-cost">${Number(item.cost).toFixed(2)}&nbsp;€</span>` : ''}
            ${jd?.validated ? '<span class="item-ok">✓</span>' : ''}
          </div>
          ${notes ? `<p class="notes">${_esc(notes).replace(/\n/g,'<br>')}</p>` : ''}
          ${photos.length ? `<div class="${photoClass}">${photos.map(s =>
            `<img src="${s}" alt="" loading="lazy" decoding="async" onerror="this.style.display='none'">`).join('')}</div>` : ''}
        </div>`;
      }).join('');
      return `<div class="day">
        <div class="day-hd">
          <b class="dn">Jour ${day.num}</b>
          ${day.date ? `<span class="dd">${_fmtDate(day.date)}</span>` : ''}
          ${customDayTitle(day) ? `<span class="dt">${_esc(customDayTitle(day))}</span>` : ''}
          ${day.region ? `<span class="dr">${_esc(day.region)}</span>` : ''}
        </div>
        ${itemsHtml || '<p class="empty-day">—</p>'}
      </div>`;
    }).join('');
    planningHtml = `<section class="sec${cover || toc ? ' page-break' : ''}">
      <h2 class="sec-title">📅 Planning &amp; Carnet</h2>
      ${daysHtml || '<p class="empty-day">Aucune journée planifiée</p>'}
    </section>`;
  }

  // ── Expenses ───────────────────────────────────────────────────────────────
  let expHtml = '';
  if (sections.has('expenses')) {
    const catMap   = new Map((trip.budgetCats || []).map(c => [c.id, c]));
    const exps     = (trip.realExpenses || []).filter(e => e.type !== 'transfer');
    const expTotal = exps.reduce((s, e) => s + (Number(e.amount) || 0), 0);
    if (exps.length) {
      expHtml = `<section class="sec">
        <h2 class="sec-title">💳 Dépenses — ${expTotal.toFixed(2)}&nbsp;€</h2>
        <table><thead><tr><th>Date</th><th>Catégorie</th><th>Description</th><th class="r">Montant</th></tr></thead><tbody>
          ${exps.map(e => { const c = catMap.get(e.catId);
            return `<tr><td>${_esc(e.date||'')}</td><td>${c ? c.icon+' '+_esc(c.name) : '—'}</td><td>${_esc(e.desc||e.note||'')}</td><td class="r">${Number(e.amount||0).toFixed(2)}&nbsp;€</td></tr>`;
          }).join('')}
        </tbody></table>
      </section>`;
    }
  }

  // ── Budget ─────────────────────────────────────────────────────────────────
  let budHtml = '';
  if (sections.has('budget')) {
    const budTotal = (trip.budgetLines||[]).reduce((s,b)=>s+(Number(b.amount)||0),0);
    if (trip.budgetLines?.length) {
      budHtml = `<section class="sec">
        <h2 class="sec-title">💶 Budget prévisionnel — ${budTotal.toFixed(2)}&nbsp;€</h2>
        <table><thead><tr><th>Poste</th><th class="r">Montant</th></tr></thead><tbody>
          ${(trip.budgetLines||[]).map(b=>`<tr><td>${_esc(b.label||'')}</td><td class="r">${Number(b.amount||0).toFixed(2)}&nbsp;€</td></tr>`).join('')}
        </tbody></table>
      </section>`;
    }
  }

  // ── Packing ────────────────────────────────────────────────────────────────
  let packHtml = '';
  if (sections.has('packing') && (trip.packingLists||[]).length) {
    packHtml = `<section class="sec">
      <h2 class="sec-title">🧳 Bagages</h2>
      ${(trip.packingLists||[]).map(l=>`<div class="pl">
        <h3>${_esc(l.name||'')}</h3>
        <ul class="pack-list">${(l.items||[]).map(it=>`<li class="pack-item${it.checked?' done':''}">${_esc(it.text||'')}</li>`).join('')}</ul>
      </div>`).join('')}
    </section>`;
  }

  // ── Companions ─────────────────────────────────────────────────────────────
  let compsHtml = '';
  if (sections.has('companions') && (trip.companions||[]).length) {
    compsHtml = `<section class="sec">
      <h2 class="sec-title">👥 Compagnons de voyage</h2>
      <ul class="comps-list">
        ${(trip.companions||[]).map(c=>`<li>
          <span class="comp-dot" style="background:${_esc(c.color||'#0d9488')}"></span>
          ${_esc(c.name||'')}
        </li>`).join('')}
      </ul>
    </section>`;
  }

  // ── CSS ────────────────────────────────────────────────────────────────────
  const css = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:Georgia,'Times New Roman',serif;font-size:13px;color:#1a1a1a;line-height:1.65;background:#fff}

/* Cover */
.cover{width:100%;min-height:100vh;display:flex;align-items:flex-end;justify-content:flex-start;
  background:${th.grad};position:relative;overflow:hidden;page-break-after:always}
.cv-photo{position:absolute;inset:0;z-index:0}
.cv-photo img{width:100%;height:100%;object-fit:cover;opacity:.35}
.cv-decor::after{content:'';position:absolute;inset:0;background:
  repeating-linear-gradient(45deg,rgba(255,255,255,.04) 0,rgba(255,255,255,.04) 1px,transparent 1px,transparent 20px),
  repeating-linear-gradient(-45deg,rgba(255,255,255,.04) 0,rgba(255,255,255,.04) 1px,transparent 1px,transparent 20px);
  z-index:0;pointer-events:none}
.cv-inner{position:relative;z-index:1;padding:60px 56px;color:#fff}
.cv-flag{font-size:64px;margin-bottom:16px;line-height:1}
.cv-title{font-size:48px;font-weight:700;line-height:1.1;margin-bottom:14px;letter-spacing:-.5px;text-shadow:0 2px 8px rgba(0,0,0,.3)}
.cv-dest,.cv-date,.cv-comps{font-size:16px;opacity:.9;margin-top:8px}
.cv-anecdote{margin-top:32px;padding:20px 24px;border-left:4px solid rgba(255,255,255,.5);
  font-style:italic;font-size:15px;opacity:.9;max-width:600px;background:rgba(0,0,0,.15);border-radius:4px}

/* TOC */
.toc{max-width:680px;margin:0 auto;padding:60px 48px}
.toc-list{list-style:none;padding:0}
.toc-list li{padding:8px 0;border-bottom:1px dotted #ddd;font-size:14px;display:flex;align-items:center;gap:10px}
.toc-list li:last-child{border-bottom:none}

/* Page structure */
.sec{max-width:720px;margin:0 auto;padding:40px 48px 0}
.page-break{page-break-before:always}

/* Section title */
.sec-title{font-size:15px;font-weight:700;color:${th.primary};border-bottom:2px solid ${th.primary};
  padding-bottom:5px;margin-bottom:18px;text-transform:uppercase;letter-spacing:.5px}

/* Day */
.day{margin-bottom:20px;page-break-inside:avoid}
.day-hd{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;
  background:${th.light};padding:8px 12px;border-radius:6px;
  margin-bottom:8px;border-left:4px solid ${th.primary}}
.dn{font-size:12px;font-weight:700;color:${th.primary};flex-shrink:0}
.dd{font-size:10px;color:#999;flex-shrink:0}
.dt{font-weight:700;font-size:13px}
.dr{font-size:10px;color:#bbb;margin-left:auto}
.empty-day{color:#ccc;font-size:11px;padding-left:8px;font-style:italic}

/* Item */
.item{margin-bottom:10px;padding-left:14px;border-left:2px solid #eee}
.item-hd{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;margin-bottom:3px}
.item-time{font-size:10px;color:#bbb;width:36px;flex-shrink:0}
.item-text{font-weight:600;font-size:13px}
.item-cost{font-size:10px;color:${th.primary};margin-left:auto;font-weight:600}
.item-ok{font-size:10px;color:#16a34a;font-weight:700}
.notes{font-size:11px;color:#666;padding-left:42px;margin-top:2px;line-height:1.6}

/* Photos */
.photos-grid{display:flex;flex-wrap:wrap;gap:6px;padding-left:42px;margin-top:8px}
.photos-grid img{width:160px;height:120px;object-fit:cover;border-radius:5px;border:1px solid #eee}
.photos-full{padding-left:42px;margin-top:10px}
.photos-full img{width:100%;max-height:480px;object-fit:cover;border-radius:8px;
  margin-bottom:10px;border:1px solid #eee;display:block}

/* Tables */
table{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:8px}
th{background:${th.light};text-align:left;padding:7px 10px;font-weight:700;
  border-bottom:2px solid ${th.primary};color:${th.dark};font-size:11px;text-transform:uppercase}
td{padding:6px 10px;border-bottom:1px solid #f0f0f0;vertical-align:top;font-size:12px}
.r{text-align:right;font-weight:600;white-space:nowrap}

/* Packing */
.pl{margin-bottom:16px}
.pl h3{font-size:12px;font-weight:700;color:${th.dark};margin:0 0 8px;text-transform:uppercase;letter-spacing:.3px}
.pack-list{list-style:none;padding:0;columns:2;column-gap:20px}
.pack-item{break-inside:avoid;padding:3px 0 3px 20px;position:relative;font-size:12px}
.pack-item::before{content:'☐ ';position:absolute;left:0;color:#999}
.pack-item.done{color:#bbb;text-decoration:line-through}
.pack-item.done::before{content:'☑ ';color:#16a34a}

/* Companions */
.comps-list{list-style:none;padding:0;display:flex;flex-wrap:wrap;gap:10px}
.comps-list li{display:flex;align-items:center;gap:8px;padding:8px 14px;
  background:${th.light};border-radius:999px;font-size:13px;font-weight:600}
.comp-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0;display:inline-block}

@media print{
  body{font-size:11px}
  .cover{min-height:100vh}
  .page-break{page-break-before:always}
  .day,.item{page-break-inside:avoid}
  .sec{padding:20px 32px 0}
}`;

  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<title>${_esc(trip.name||'Voyage')}</title>
<style>${css}</style></head><body>
${coverHtml}
${tocHtml}
${planningHtml}
${expHtml}
${budHtml}
${packHtml}
${compsHtml}
</body></html>`;
}
