/* ============================================================
   CARNET DE VOYAGES — Carnet : fenêtres de publication
   ============================================================
   L'ancien onglet Carnet (carte + timeline) a été remplacé par la partie
   « Suivre » de l'écran voyage v2 (tripv2.js) ; il en reste les fenêtres
   qu'il réutilise : publier / modifier une étape (openValidateModal),
   commentaires (openCommentsModal), partage externe (shareJournalItem).
   ============================================================ */

import { getTrip, updateTrip, uid, getEventTypes, isTripShared } from '../store.js';
import { notify, showModal, closeModal, customDayTitle, compressPhotoDataUrl } from '../utils.js';
import { getCurrentUser } from '../auth.js';

function _esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let _shareMod = null;  // cached dynamic import of share.js

// ── Commentaires d'une publication ─────────────────────────────────────────────

function _openCommentsModal(tripId, itemId, itemText) {
  if (!_shareMod) return;
  const sharedDoc    = _shareMod.getSharedDocData?.(tripId);
  if (!sharedDoc) return;

  const currentUid   = getCurrentUser()?.uid;
  const allComments  = sharedDoc.observerComments || {};
  const itemComments = Object.entries(allComments)
    .filter(([, c]) => c.itemId === itemId)
    .sort(([, a], [, b]) => (a.ts || '').localeCompare(b.ts || ''));

  function _buildCommentsList() {
    if (itemComments.length === 0) {
      return `<div style="font-size:12px;color:var(--ink4);padding:8px 0;text-align:center">Aucun commentaire pour le moment</div>`;
    }
    return itemComments.map(([cid, c]) => {
      const dateLabel = new Date(c.ts).toLocaleString('fr-FR', {
        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
      });
      const myRole    = sharedDoc.members?.[currentUid]?.role;
      const canDelete = c.uid === currentUid || myRole === 'owner' || myRole === 'member';
      return `
        <div class="tl-comment-item">
          <div class="tl-comment-header">
            <span class="tl-comment-author">${_esc(c.name)}</span>
            <span class="tl-comment-date">${dateLabel}</span>
            ${canDelete ? `<button class="tl-comment-del" data-action="delete-comment" data-cid="${_esc(cid)}" title="Supprimer">🗑</button>` : ''}
          </div>
          <div class="tl-comment-text">${_esc(c.text)}</div>
        </div>`;
    }).join('');
  }

  showModal(`
    <button class="mc" onclick="closeModal()">✕</button>
    <h3 style="font-family:var(--sf);font-size:15px;font-weight:700;margin-bottom:4px">💬 Commentaires</h3>
    <div style="font-size:12px;color:var(--ink3);margin-bottom:12px;padding:6px 10px;background:var(--c2);border-radius:7px;border:1px solid var(--c3)">${_esc(itemText || '—')}</div>
    <div id="cmt-list" style="max-height:220px;overflow-y:auto;margin-bottom:4px">${_buildCommentsList()}</div>
    ${sharedDoc ? `
    <div style="display:flex;gap:8px;margin-top:10px">
      <input type="text" id="cmt-input" placeholder="Votre commentaire…"
             style="flex:1;padding:7px 10px;border:1.5px solid var(--c3);border-radius:7px;font-size:12px;background:var(--c);color:var(--ink)"
             maxlength="300">
      <button id="cmt-send" class="bs" style="padding:7px 14px;font-size:12px;flex-shrink:0">Envoyer</button>
    </div>` : ''}
    <div class="ma" style="margin-top:10px">
      <button class="bc" onclick="closeModal()">Fermer</button>
    </div>`);

  // Send comment
  const sendBtn = document.getElementById('cmt-send');
  const input   = document.getElementById('cmt-input');

  async function _doSend() {
    const text = input?.value?.trim();
    if (!text) return;
    input.disabled = true;
    sendBtn.disabled = true;
    await _shareMod.addObserverComment(tripId, itemId, text).catch(() => {});
    closeModal();
    // Re-open with latest data
    const latestDoc = _shareMod.getSharedDocData?.(tripId);
    if (latestDoc) _openCommentsModal(tripId, itemId, itemText);
  }

  sendBtn?.addEventListener('click', _doSend);
  // Guard: Enter key must not trigger a second send while the first is still in-flight
  input?.addEventListener('keydown', e => { if (e.key === 'Enter' && !sendBtn?.disabled) _doSend(); });

  // Delete comment
  document.getElementById('cmt-list')?.addEventListener('click', async e => {
    const delBtn = e.target.closest('[data-action="delete-comment"]');
    if (!delBtn) return;
    const cid = delBtn.dataset.cid;
    await _shareMod.deleteObserverComment(tripId, cid).catch(() => {});
    closeModal();
    const latestDoc = _shareMod.getSharedDocData?.(tripId);
    if (latestDoc) _openCommentsModal(tripId, itemId, itemText);
  });
}

// ── Retirer une publication ───────────────────────────────────────────────────

function _devalidateItem(tripId, dayId, itemIdx) {
  const freshTrip = getTrip(tripId);
  if (!freshTrip) return;
  const days   = [...(freshTrip.days || [])];
  const dayIdx = days.findIndex(d => d.id === dayId);
  if (dayIdx === -1) return;
  const items = [...(days[dayIdx].items || [])];
  if (!items[itemIdx]) return;

  const itemId = items[itemIdx].id;
  const prevJd = items[itemIdx].journalData || {};

  // Strip validated state, preserve notes/photos/weather for reference
  items[itemIdx] = {
    ...items[itemIdx],
    journalData: { ...prevJd, validated: false, validatedAt: null },
  };
  days[dayIdx] = { ...days[dayIdx], items };
  updateTrip(tripId, { days });

  // Remove the auto-created real expense that was linked to this item
  const freshTrip2 = getTrip(tripId);
  const expenses   = (freshTrip2.realExpenses || []).filter(ex => ex.journalItemId !== itemId);
  if (expenses.length !== (freshTrip2.realExpenses || []).length) {
    updateTrip(tripId, { realExpenses: expenses });
  }

  notify('Activité dévalidée', '↩');
}

// ── Icône d'un type d'événement ───────────────────────────────────────────────

function _eventTypeIcon(type) {
  const et = getEventTypes().find(e => e.key === type);
  if (et) return et.emoji;
  // Fallback built-in map
  const m = { visit: '🏛️', activity: '🎯', sleep: '🏨', drive: '🚗', food: '🍽️', shop: '🛍️' };
  return m[type] || '📍';
}

// ── External share (Web Share API) ────────────────────────────────────────────

/**
 * Convert a base64 data: URL photo into a File, synchronously, via atob() —
 * confirmed necessary (not just a timing optimization): fetch(dataUrl) on
 * this same data throws "Load failed" on iOS Safari — a real WebKit
 * limitation fetching data: URLs, not the async-delay theory an earlier fix
 * attempt (v188) guessed at. A first atob()-based attempt (also v188) threw
 * for an undiagnosed reason and got reverted (v190) back to the now-confirmed-
 * broken fetch() approach; this version's caller no longer swallows the
 * exception silently, so if this ever fails again the real error surfaces.
 */
const _MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic' };

function _b64ToFile(dataUrl, basename) {
  const commaIdx = dataUrl.indexOf(',');
  const mime     = dataUrl.slice(5, commaIdx).split(';')[0] || 'image/jpeg';
  const binary   = atob(dataUrl.slice(commaIdx + 1));
  const bytes    = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  // The file's extension must match its actual MIME type — some share
  // targets validate the two against each other and silently refuse a
  // mismatched attachment (e.g. a .jpg filename on an image/png blob).
  return new File([bytes], `${basename}.${_MIME_EXT[mime] || 'jpg'}`, { type: mime });
}

/** fetch()-based fallback for a non-base64 (e.g. already-uploaded Storage) photo URL — a real network URL, unlike a data: URL, so not affected by the fetch(data:) issue above. */
async function _dataUrlToFile(dataUrl, basename) {
  const res  = await fetch(dataUrl);
  const blob = await res.blob();
  const mime = blob.type || 'image/jpeg';
  return new File([blob], `${basename}.${_MIME_EXT[mime] || 'jpg'}`, { type: mime });
}

/**
 * Share a journal step outside the app (SMS, WhatsApp, Mail…) via the native
 * share sheet, with trip name, day, description, notes and photos.
 * Falls back to copying the text when Web Share isn't available (desktop
 * browsers mostly) or when the user's device can't share files.
 */
async function _shareJournalItem({ tripName, dayLabel, itemLabel, notes, weather, photos = [] }) {
  // Deliberately excludes the expense amount — private spending info shouldn't
  // leak through an external share (message, social app, etc.).
  // No separate `title` passed to navigator.share(): some targets (WhatsApp,
  // SMS…) show only `text` and drop `title` entirely, so a header living
  // solely in `title` could vanish completely; others show both back to
  // back, which duplicated the same header ("Jour X … Jour X"). Putting it
  // once in `text` alone is the one placement every target actually shows.
  const lines = [`✈️ ${tripName} — ${dayLabel}`, itemLabel];
  if (weather) lines.push(weather);
  if (notes)   lines.push(notes);
  const text  = lines.join('\n');

  let files = [];
  if (photos.length && navigator.canShare) {
    // Base64 photos (the common case — anything added on this device) go
    // through the synchronous atob() path; only a genuinely remote URL
    // needs the fetch() fallback. Promise.allSettled, not Promise.all: one
    // photo failing to convert can't reject the whole batch and silently
    // drop every other photo with it.
    const slice      = photos.slice(0, 10);
    const syncFiles  = [];
    const asyncPairs = [];
    let firstError   = null;
    slice.forEach((src, i) => {
      if (typeof src === 'string' && src.startsWith('data:')) {
        try { syncFiles.push(_b64ToFile(src, `photo-${i + 1}`)); }
        catch (err) { if (!firstError) firstError = err; }
      } else {
        asyncPairs.push([src, i]);
      }
    });
    const asyncResults = asyncPairs.length
      ? await Promise.allSettled(asyncPairs.map(([src, i]) => _dataUrlToFile(src, `photo-${i + 1}`)))
      : [];
    for (const r of asyncResults) { if (r.status === 'rejected' && !firstError) firstError = r.reason; }
    files = [...syncFiles, ...asyncResults.filter(r => r.status === 'fulfilled').map(r => r.value)];
    // Diagnostic notifications: this whole step used to fail completely
    // silently (text-only share, indistinguishable from "there were no
    // photos to begin with"), which is what let earlier fix attempts
    // (v188-v190) ship without actually confirming which step was failing.
    if (files.length) {
      try {
        if (!navigator.canShare({ files })) { files = []; notify('Photos non partageables sur cet appareil — texte envoyé seul', '⚠️'); }
      } catch (_) { files = []; notify('Photos non partageables sur cet appareil — texte envoyé seul', '⚠️'); }
    } else if (slice.length) {
      const detail = firstError?.message || firstError?.name || String(firstError || '');
      notify(`Échec préparation photos${detail ? ' : ' + detail.slice(0, 60) : ''}`, '⚠️');
    }
  }

  if (navigator.share) {
    try {
      await navigator.share(files.length ? { text, files } : { text });
      return;
    } catch (err) {
      if (err?.name === 'AbortError') return; // user cancelled the share sheet
      // Otherwise fall through to the clipboard fallback below
    }
  }

  try {
    await navigator.clipboard.writeText(text);
    notify(photos.length
      ? 'Message copié (ajoutez les photos manuellement, non supportées ici)'
      : 'Message copié dans le presse-papiers', '📋');
  } catch (_) {
    notify('Partage non disponible sur ce navigateur', '⚠️');
  }
}

// ── Validate activity modal ────────────────────────────────────────────────────

function _openValidateModal(tripId, dayId, itemIdx) {
  const trip = getTrip(tripId);
  if (!trip) return;

  const day = (trip.days || []).find(d => d.id === dayId);
  if (!day) return;

  const item = (day.items || [])[itemIdx];
  if (!item) return;

  const jd = item.journalData || {};

  const state = {
    weather: jd.weather || '',
    notes:   jd.notes   || '',
    amount:  jd.amount  || 0,
    photos:  jd.photos  ? [...jd.photos] : [],
    videos:  jd.videos  ? [...jd.videos] : [],   // v242 : URLs Storage uniquement
    pending: 0,                                  // envois en cours (photos HD / vidéos)
  };

  const weatherEmojis = ['☀️', '⛅', '🌧️', '⛈️', '🌨️', '🌫️', '🌊', '🏔️'];

  // v242 : photo lue en 2000 px (au lieu de 800 — qualité visiblement dégradée), puis
  // envoyée vers Storage si possible (seule l'URL est gardée : rien de lourd en local) ;
  // sinon repli sur une copie 1280 px en base64. L'orientation EXIF est appliquée par
  // le navigateur au décodage (image-orientation:from-image), le paysage reste paysage.
  async function _photoForJournal(file) {
    const big = await _compressImg(file, 2000, 0.88);
    const user = getCurrentUser();
    if (user?.uid) {
      try {
        const { isPhotoStoreReady, uploadPhoto } = await import('../photostore.js');
        if (isPhotoStoreReady()) {
          const url = await uploadPhoto(user.uid, big);
          if (url) return url;
        }
      } catch (_) {}
    }
    return (await compressPhotoDataUrl(big, 1280, 0.82)) || big;
  }

  async function _compressImg(file, maxSize = 1280, quality = 0.82) {
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = ev => {
        const img = new Image();
        img.onload = () => {
          const canvas  = document.createElement('canvas');
          let { width, height } = img;
          if (width > maxSize || height > maxSize) {
            const r = Math.min(maxSize / width, maxSize / height);
            width = Math.round(width * r); height = Math.round(height * r);
          }
          canvas.width = width; canvas.height = height;
          canvas.getContext('2d').drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.src = ev.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function buildWeatherRow() {
    return weatherEmojis.map(em => {
      const sel = state.weather === em;
      return `<button type="button" data-weather="${_esc(em)}"
        style="background:${sel ? 'var(--tl)' : 'var(--c2)'};border:1.5px solid ${sel ? 'var(--teal)' : 'var(--c3)'};
        border-radius:8px;padding:4px 6px;font-size:18px;cursor:pointer">${em}</button>`;
    }).join('');
  }

  function buildPhotosHtml() {
    const pend = state.pending ? `<div class="vld-pending">⏳ Envoi de ${state.pending} fichier${state.pending > 1 ? 's' : ''}…</div>` : '';
    if (state.photos.length === 0 && state.videos.length === 0) return (pend || '<div style="font-size:11px;color:var(--ink4)">Aucune photo ni vidéo ajoutée</div>');
    return pend + `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px">` +
      state.videos.map((src, i) =>
        `<div style="position:relative;display:inline-block">
          <video src="${_esc(src)}#t=0.1" muted playsinline preload="metadata" style="width:56px;height:56px;object-fit:cover;border-radius:6px;border:1px solid var(--c3);background:#000"></video>
          <span style="position:absolute;left:4px;bottom:3px;font-size:11px;color:#fff;text-shadow:0 1px 2px #000">▶</span>
          <button type="button" data-rm-video="${i}"
            style="position:absolute;top:-4px;right:-4px;background:var(--coral);color:#fff;border:none;border-radius:50%;width:16px;height:16px;font-size:9px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;line-height:1">✕</button>
        </div>`
      ).join('') +
      state.photos.map((src, i) =>
        `<div style="position:relative;display:inline-block">
          <img src="${_esc(src)}" style="width:56px;height:56px;object-fit:cover;border-radius:6px;border:1px solid var(--c3);cursor:pointer" onclick="window._pho && window._pho(this.src)">
          <button type="button" data-rm-photo="${i}"
            style="position:absolute;top:-4px;right:-4px;background:var(--coral);color:#fff;border:none;border-radius:50%;width:16px;height:16px;font-size:9px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;line-height:1">✕</button>
        </div>`
      ).join('') + `</div>`;
  }

  showModal(`
    <button class="mc" onclick="closeModal()">✕</button>
    <h3>✓ Valider l'activité</h3>
    <div style="font-size:13px;font-weight:600;color:var(--ink);margin-bottom:14px;padding:8px 10px;background:var(--c2);border-radius:8px;border:1px solid var(--c3)">
      ${_eventTypeIcon(item.type)} ${_esc(item.text || '—')}
    </div>

    <div class="fg">
      <label>Météo</label>
      <div style="display:flex;gap:5px;flex-wrap:wrap" id="vld-weather-row">${buildWeatherRow()}</div>
    </div>

    <div class="fg">
      <label>Notes</label>
      <textarea id="vld-notes" rows="3" placeholder="Comment s'est passée cette activité…">${_esc(state.notes)}</textarea>
    </div>

    <div class="fg">
      <label>Montant réel (€) <span style="font-size:10px;color:var(--ink4);font-weight:400">— crée une dépense réelle</span></label>
      <input type="number" id="vld-amount" min="0" step="0.01" placeholder="0" value="${state.amount || ''}">
    </div>

    <div class="fg">
      <label>Photos et vidéos</label>
      <div id="vld-photos-list">${buildPhotosHtml()}</div>
      <input type="file" id="vld-photo-file" accept="image/*,video/*" multiple style="font-size:12px;color:var(--ink3);margin-top:6px">
    </div>

    <div class="fg">
      <button type="button" id="vld-share" style="width:100%;background:var(--c2);border:1.5px solid var(--c3);border-radius:8px;padding:9px;font-size:13px;font-weight:700;cursor:pointer;color:var(--ink2);display:flex;align-items:center;justify-content:center;gap:6px;font-family:var(--fn)">
        📤 Partager cette étape
      </button>
    </div>

    <div class="ma">
      ${jd.validated ? `<button class="bc" id="vld-devalidate" style="color:var(--coral);border-color:var(--coral)">✕ Dévalider</button>` : ''}
      <button class="bc" onclick="closeModal()">Annuler</button>
      <button class="bs" id="vld-save">Enregistrer</button>
    </div>`);

  // Dévalider
  document.getElementById('vld-devalidate')?.addEventListener('click', () => {
    closeModal();
    _devalidateItem(tripId, dayId, itemIdx);
  });

  // Partager — uses whatever is currently filled in the form (no need to save first)
  document.getElementById('vld-share')?.addEventListener('click', () => {
    const notes = document.getElementById('vld-notes')?.value?.trim() || '';
    _shareJournalItem({
      tripName:  trip.name || 'Mon voyage',
      dayLabel:  `Jour ${day.num}${customDayTitle(day) ? ' · ' + customDayTitle(day) : ''}`,
      itemLabel: `${_eventTypeIcon(item.type)} ${item.text || 'Activité'}`,
      notes,
      weather: state.weather,
      photos:  state.photos,
    });
  });

  // Weather picker
  document.getElementById('vld-weather-row')?.addEventListener('click', ev => {
    const btn = ev.target.closest('[data-weather]');
    if (!btn) return;
    const em = btn.dataset.weather;
    state.weather = state.weather === em ? '' : em;
    const row = document.getElementById('vld-weather-row');
    if (row) row.innerHTML = buildWeatherRow();
  });

  // Photo remove (delegation — survives innerHTML updates)
  document.getElementById('vld-photos-list')?.addEventListener('click', ev => {
    const vbtn = ev.target.closest('[data-rm-video]');
    if (vbtn) {
      state.videos.splice(parseInt(vbtn.dataset.rmVideo, 10), 1);
      const list = document.getElementById('vld-photos-list');
      if (list) list.innerHTML = buildPhotosHtml();
      return;
    }
    const btn = ev.target.closest('[data-rm-photo]');
    if (!btn) return;
    state.photos.splice(parseInt(btn.dataset.rmPhoto, 10), 1);
    const list = document.getElementById('vld-photos-list');
    if (list) list.innerHTML = buildPhotosHtml();
  });

  // Photo upload — multiple files supported
  document.getElementById('vld-photo-file')?.addEventListener('change', async ev => {
    const files = [...(ev.target.files || [])];
    if (!files.length) return;
    ev.target.value = '';
    const refresh = () => {
      const list = document.getElementById('vld-photos-list');
      if (list) list.innerHTML = buildPhotosHtml();
      const save = document.getElementById('vld-save');
      if (save) { save.disabled = state.pending > 0; save.textContent = state.pending > 0 ? 'Envoi en cours…' : 'Enregistrer'; }
    };
    state.pending += files.length;
    refresh();
    await Promise.all(files.map(async file => {
      try {
        if (file.type.startsWith('video/')) {
          const user = getCurrentUser();
          if (!user?.uid) { notify('Connectez-vous pour ajouter des vidéos (envoyées dans le cloud)', '⚠️'); return; }
          if (file.size > 200 * 1024 * 1024) { notify('Vidéo trop lourde (200 Mo maximum)', '⚠️'); return; }
          const { uploadVideo } = await import('../photostore.js');
          const url = await uploadVideo(user.uid, file);
          if (url) state.videos.push(url);
          else notify("Échec de l'envoi de la vidéo (connexion ?)", '⚠️');
        } else {
          state.photos.push(await _photoForJournal(file));
        }
      } finally {
        state.pending--;
        refresh();
      }
    }));
  });

  // Save
  document.getElementById('vld-save')?.addEventListener('click', () => {
    if (state.pending > 0) { notify('Patientez, envoi en cours…', '⏳'); return; }
    state.notes  = document.getElementById('vld-notes')?.value?.trim()  || '';
    state.amount = parseFloat(document.getElementById('vld-amount')?.value || '0') || 0;

    const freshTrip = getTrip(tripId);
    // Guard: trip may have been deleted while the modal was open
    if (!freshTrip) { closeModal(); return; }
    const days      = [...(freshTrip.days || [])];
    const dayIdx    = days.findIndex(d => d.id === dayId);
    if (dayIdx === -1) { closeModal(); return; }

    const items = [...(days[dayIdx].items || [])];
    if (!items[itemIdx]) { closeModal(); return; }

    const itemId = items[itemIdx].id;
    const prevJd = items[itemIdx].journalData || {};
    items[itemIdx] = {
      ...items[itemIdx],
      journalData: {
        validated:   true,
        validatedAt: prevJd.validatedAt || new Date().toISOString(),
        weather:     state.weather,
        notes:       state.notes,
        amount:      state.amount,
        photos:      state.photos,
        ...(state.videos.length ? { videos: state.videos } : {}),
      },
    };
    days[dayIdx] = { ...days[dayIdx], items };
    updateTrip(tripId, { days });

    if (state.amount > 0) {
      const freshTrip2 = getTrip(tripId);
      const expenses   = [...(freshTrip2.realExpenses || [])];
      const cats       = freshTrip2.budgetCats || [];
      const actCat     = cats.find(c => c.name === 'Activités');
      const existIdx   = expenses.findIndex(ex => ex.journalItemId === itemId);

      const newExp = {
        id:            existIdx >= 0 ? expenses[existIdx].id : 'ex_' + uid(),
        desc:          items[itemIdx].text || 'Activité validée',
        amount:        state.amount,
        catId:         actCat?.id || null,
        paidById:      'moi',
        sharedWith:    ['moi'],
        date:          days[dayIdx].date || new Date().toISOString().slice(0, 10),
        dayId,
        note:          state.notes ? 'Via Journal · ' + state.notes : 'Via Journal',
        journalItemId: itemId,
      };

      if (existIdx >= 0) expenses[existIdx] = newExp;
      else expenses.push(newExp);

      updateTrip(tripId, { realExpenses: expenses });
      notify('Activité validée · dépense créée', '✓');
    } else {
      notify('Activité validée', '✓');
    }

    // Notify observers if this is a shared trip
    if (isTripShared(tripId)) {
      const day      = days[dayIdx];
      const itemText = items[itemIdx]?.text || '';
      import('../share.js').then(({ publishDay }) => {
        publishDay(tripId, day.num, day.title || '', itemText);
      }).catch(() => {});
    }

    closeModal();
  });
}

// ─── Écran voyage v2 (tripv2.js) ──────────────────────────────────────────────
// Fenêtres et actions du carnet réutilisées par le nouvel écran voyage.
export const openValidateModal = (tripId, dayId, itemIdx) => _openValidateModal(tripId, dayId, itemIdx);
export const shareJournalItem  = opts => _shareJournalItem(opts);
export async function openCommentsModal(tripId, itemId, itemText) {
  if (!_shareMod) { try { _shareMod = await import('../share.js'); } catch (_) { return; } }
  _openCommentsModal(tripId, itemId, itemText);
}
export const eventTypeIcon = type => _eventTypeIcon(type);
