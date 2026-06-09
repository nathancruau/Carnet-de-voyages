/* ============================================================
   CARNET DE VOYAGES — Export (JSON, ZIP, PDF)
   ============================================================ */

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

// ── PDF export ────────────────────────────────────────────────────────────────

export function exportTripPdf(trip) {
  const w = window.open('', '_blank');
  if (!w) { alert('Veuillez autoriser les popups pour exporter en PDF.'); return; }
  w.document.write(_buildPdfHtml(trip));
  w.document.close();
  setTimeout(() => w.print(), 700);
}

function _buildPdfHtml(trip) {
  const days = (trip.days || []).slice().sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  const daysHtml = days.map(day => {
    const itemsHtml = (day.items || []).map(item => {
      const jd     = item.journalData;
      const notes  = jd?.notes || item.notes || '';
      const photos = (jd?.photos || []).filter(Boolean);
      return `<div class="item">
        <div class="item-hd">
          ${item.time ? `<span class="item-time">${_esc(item.time)}</span>` : '<span class="item-time"></span>'}
          <span class="item-text">${_esc(item.text || '')}</span>
          ${item.cost ? `<span class="item-cost">${Number(item.cost).toFixed(2)}&nbsp;€</span>` : ''}
          ${jd?.validated ? '<span class="item-ok">✓</span>' : ''}
        </div>
        ${notes ? `<p class="notes">${_esc(notes).replace(/\n/g, '<br>')}</p>` : ''}
        ${photos.length ? `<div class="photos">${photos.map(s =>
          `<img src="${s}" alt="" onerror="this.style.display='none'">`).join('')}</div>` : ''}
      </div>`;
    }).join('');
    return `<div class="day">
      <div class="day-hd">
        <b class="dn">Jour ${day.num}</b>
        ${day.date ? `<span class="dd">${_fmtDate(day.date)}</span>` : ''}
        ${day.title ? `<span class="dt">${_esc(day.title)}</span>` : ''}
        ${day.region ? `<span class="dr">${_esc(day.region)}</span>` : ''}
      </div>
      ${itemsHtml || '<p style="color:#ccc;font-size:11px;padding-left:8px">—</p>'}
    </div>`;
  }).join('');

  const catMap  = new Map((trip.budgetCats || []).map(c => [c.id, c]));
  const exps    = (trip.realExpenses || []).filter(e => e.type !== 'transfer');
  const expTotal = exps.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const expHtml = exps.length ? `<section class="sec">
    <h2>Dépenses — ${expTotal.toFixed(2)}&nbsp;€</h2>
    <table><thead><tr><th>Date</th><th>Catégorie</th><th>Description</th><th class="r">Montant</th></tr></thead><tbody>
      ${exps.map(e => { const c = catMap.get(e.catId);
        return `<tr><td>${_esc(e.date||'')}</td><td>${c?c.icon+' '+_esc(c.name):'—'}</td><td>${_esc(e.desc||e.note||'')}</td><td class="r">${Number(e.amount||0).toFixed(2)}&nbsp;€</td></tr>`;
      }).join('')}
    </tbody></table></section>` : '';

  const budTotal = (trip.budgetLines||[]).reduce((s,b)=>s+(Number(b.amount)||0),0);
  const budHtml  = trip.budgetLines?.length ? `<section class="sec">
    <h2>Budget prévisionnel — ${budTotal.toFixed(2)}&nbsp;€</h2>
    <table><thead><tr><th>Poste</th><th class="r">Montant</th></tr></thead><tbody>
      ${(trip.budgetLines||[]).map(b=>`<tr><td>${_esc(b.label||'')}</td><td class="r">${Number(b.amount||0).toFixed(2)}&nbsp;€</td></tr>`).join('')}
    </tbody></table></section>` : '';

  const packHtml = (trip.packingLists||[]).length ? `<section class="sec">
    <h2>Bagages</h2>
    ${(trip.packingLists||[]).map(l=>`<div class="pl"><h3>${_esc(l.name||'')}</h3><ul>
      ${(l.items||[]).map(it=>`<li class="${it.checked?'done':''}">${_esc(it.text||'')}</li>`).join('')}
    </ul></div>`).join('')}</section>` : '';

  const companions = (trip.companions||[]).map(c=>c.name).join(', ');
  const dateRange  = trip.startDate && trip.endDate
    ? `${_fmtDate(trip.startDate)} → ${_fmtDate(trip.endDate)}`
    : trip.startDate ? _fmtDate(trip.startDate) : '';

  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<title>${_esc(trip.name||'Voyage')}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Georgia,serif;font-size:13px;color:#1a1a1a;max-width:800px;margin:0 auto;padding:24px 32px;line-height:1.6}
h1{font-size:24px;font-weight:700;color:#0f766e;margin-bottom:4px}
h2{font-size:14px;font-weight:700;color:#0f766e;border-bottom:2px solid #0d9488;padding-bottom:3px;margin:0 0 10px}
h3{font-size:12px;font-weight:700;margin:8px 0 4px;color:#555}
.meta{font-size:12px;color:#666;margin-bottom:3px}
.trip-hd{margin-bottom:24px;padding-bottom:14px;border-bottom:3px solid #0d9488}
.sec{margin-bottom:28px}
.day{margin-bottom:16px;page-break-inside:avoid}
.day-hd{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;background:#f0fdfa;padding:6px 10px;border-radius:6px;margin-bottom:7px;border-left:4px solid #0d9488}
.dn{font-size:12px;color:#0d9488;flex-shrink:0}
.dd{font-size:10px;color:#888;flex-shrink:0}
.dt{font-weight:700;font-size:12px}
.dr{font-size:10px;color:#aaa;margin-left:auto}
.item{margin-bottom:8px;padding-left:10px;border-left:2px solid #eee}
.item-hd{display:flex;align-items:baseline;gap:5px;flex-wrap:wrap;margin-bottom:2px}
.item-time{font-size:10px;color:#aaa;width:34px;flex-shrink:0}
.item-text{font-weight:600;font-size:12px}
.item-cost{font-size:10px;color:#0d9488;margin-left:auto}
.item-ok{font-size:10px;color:#16a34a}
.notes{font-size:11px;color:#666;padding-left:39px;margin-top:1px}
.photos{display:flex;flex-wrap:wrap;gap:5px;padding-left:39px;margin-top:5px}
.photos img{width:140px;height:100px;object-fit:cover;border-radius:3px;border:1px solid #ddd}
table{width:100%;border-collapse:collapse;font-size:11px;margin-bottom:4px}
th{background:#f0fdfa;text-align:left;padding:5px 7px;font-weight:700;border-bottom:2px solid #0d9488}
td{padding:4px 7px;border-bottom:1px solid #eee;vertical-align:top}
.r{text-align:right;font-weight:600;white-space:nowrap}
.pl{margin-bottom:8px}
ul{list-style:none;padding-left:6px;columns:2;column-gap:16px}
li::before{content:"☐ ";font-size:10px}
li.done{color:#bbb;text-decoration:line-through}
li.done::before{content:"☑ "}
@media print{body{padding:0}.day,.sec{page-break-inside:avoid}}
</style></head><body>
<div class="trip-hd">
  <h1>${trip.flag||'🌍'} ${_esc(trip.name||'Voyage')}</h1>
  ${trip.destination?`<p class="meta">📍 ${_esc(trip.destination)}</p>`:''}
  ${dateRange?`<p class="meta">📅 ${_esc(dateRange)}</p>`:''}
  ${companions?`<p class="meta">👥 ${_esc(companions)}</p>`:''}
</div>
<section class="sec"><h2>Planning &amp; Carnet</h2>
${daysHtml||'<p style="color:#ccc;font-size:12px">Aucune journée planifiée</p>'}
</section>
${expHtml}${budHtml}${packHtml}
</body></html>`;
}
