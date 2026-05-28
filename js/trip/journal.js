/* ============================================================
   CARNET DE VOYAGES — Journal Module
   ============================================================ */

import { getTrip, updateTrip, uid } from '../store.js';
import { notify, showModal, closeModal, fmtDate, fmtDateShort, isoToDate, dateToIso } from '../utils.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function _esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _today() {
  return dateToIso(new Date());
}

function _starsHtml(rating) {
  let html = '<span class="rating-stars" style="display:inline-flex;gap:2px">';
  for (let i = 1; i <= 5; i++) {
    html += `<span class="star${rating >= i ? ' filled' : ''}" style="font-size:12px;cursor:default">★</span>`;
  }
  html += '</span>';
  return html;
}

function _dayLabel(trip, dayId) {
  if (!dayId) return null;
  const day = (trip.days || []).find(d => d.id === dayId);
  if (!day) return null;
  return `Jour ${day.num}${day.title ? ' · ' + day.title : ''}`;
}

// ── Handler registry (avoids double-binding) ─────────────────────────────────

const _handlers = new WeakMap();

// ── Render ────────────────────────────────────────────────────────────────────

export function renderJournal(tripId) {
  const panel = document.getElementById('panel-journal');
  if (!panel) return;

  const trip = getTrip(tripId);
  if (!trip) return;

  // Remove previous listener before re-rendering
  if (_handlers.has(panel)) {
    panel.removeEventListener('click', _handlers.get(panel));
    _handlers.delete(panel);
  }

  const entries = [...(trip.journalEntries || [])].sort((a, b) => {
    return (b.date || '').localeCompare(a.date || '');
  });

  let innerHtml = '';

  if (entries.length === 0) {
    innerHtml = `
      <div class="jn-empty">
        <div class="ei">📔</div>
        <p>Commencez à documenter votre voyage...</p>
        <p style="font-size:11px;margin-top:6px;color:var(--ink4)">Chaque journée mérite d'être racontée</p>
      </div>`;
  } else {
    // Group by dayId when available, else by date
    const groups = new Map();
    for (const e of entries) {
      let key, label;
      if (e.dayId) {
        key = 'day_' + e.dayId;
        const dl = _dayLabel(trip, e.dayId);
        label = dl || (e.date ? fmtDate(e.date) : 'Sans date');
      } else if (e.date) {
        key = 'date_' + e.date;
        label = fmtDate(e.date);
      } else {
        key = 'nodate';
        label = 'Sans date';
      }
      if (!groups.has(key)) groups.set(key, { label, entries: [] });
      groups.get(key).entries.push(e);
    }

    for (const [, group] of groups) {
      innerHtml += `<div class="jn-day-group">
        <div class="jn-day-label">${_esc(group.label)}</div>`;
      for (const e of group.entries) {
        innerHtml += _entryCard(trip, e);
      }
      innerHtml += `</div>`;
    }
  }

  panel.innerHTML = `
    <div class="journal-wrap">
      <div class="jn-hd">
        <h2>📔 Carnet de voyage</h2>
        <button class="btn-new" data-action="add-entry">＋ Nouvelle entrée</button>
      </div>
      ${innerHtml}
    </div>`;

  const handler = e => _handleClick(e, tripId);
  _handlers.set(panel, handler);
  panel.addEventListener('click', handler);
}

// ── Entry card ────────────────────────────────────────────────────────────────

function _entryCard(trip, e) {
  const dateLabel = e.date ? fmtDate(e.date) : '—';
  const dayLabel  = e.dayId ? _dayLabel(trip, e.dayId) : null;

  let metaPills = `<span class="jn-meta-pill">${_esc(dateLabel)}</span>`;
  if (e.weather) metaPills += `<span class="jn-meta-pill">${_esc(e.weather)}</span>`;
  if (e.mood)    metaPills += `<span class="jn-meta-pill">${_esc(e.mood)}</span>`;
  if (e.rating)  metaPills += `<span class="jn-meta-pill">${_starsHtml(e.rating)}</span>`;
  if (dayLabel)  metaPills += `<span class="jn-meta-pill" style="background:var(--tl);color:var(--td);border-color:var(--teal)">${_esc(dayLabel)}</span>`;

  const contentHtml = e.content
    ? `<div class="jn-content" style="display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden">${_esc(e.content)}</div>`
    : '';

  let photosHtml = '';
  if (e.photos && e.photos.length > 0) {
    photosHtml = `<div class="jn-photos">`;
    for (const ph of e.photos.slice(0, 5)) {
      photosHtml += `<img class="jn-photo" src="${_esc(ph.url)}" alt="${_esc(ph.caption || '')}" title="${_esc(ph.caption || '')}" onerror="this.style.display='none'">`;
    }
    if (e.photos.length > 5) {
      photosHtml += `<div class="jn-photo" style="display:flex;align-items:center;justify-content:center;background:var(--c2);font-size:10px;font-weight:700;color:var(--ink4)">+${e.photos.length - 5}</div>`;
    }
    photosHtml += `</div>`;
  }

  let tagsHtml = '';
  if (e.tags && e.tags.length > 0) {
    tagsHtml = `<div class="jn-tags">` +
      e.tags.map(t => `<span class="jn-tag">${_esc(t)}</span>`).join('') +
      `</div>`;
  }

  return `
    <div class="jn-entry" data-entry-id="${_esc(e.id)}">
      <div class="jn-entry-hd">
        <div class="jn-title" style="font-style:italic">${_esc(e.title || 'Sans titre')}</div>
        <div style="display:flex;gap:5px;flex-shrink:0">
          <button class="tc-edit-btn" data-action="edit-entry" data-entry-id="${_esc(e.id)}" title="Modifier">✏️</button>
          <button class="tc-edit-btn" data-action="delete-entry" data-entry-id="${_esc(e.id)}" title="Supprimer" style="color:var(--coral)">🗑</button>
        </div>
      </div>
      <div class="jn-meta">${metaPills}</div>
      ${contentHtml}
      ${photosHtml}
      ${tagsHtml}
    </div>`;
}

// ── Event delegation ──────────────────────────────────────────────────────────

function _handleClick(e, tripId) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;

  const action = btn.dataset.action;

  if (action === 'add-entry') {
    _openEntryModal(tripId, null);
  } else if (action === 'edit-entry') {
    _openEntryModal(tripId, btn.dataset.entryId);
  } else if (action === 'delete-entry') {
    const entryId = btn.dataset.entryId;
    if (confirm('Supprimer cette entrée de journal ?')) {
      const trip = getTrip(tripId);
      updateTrip(tripId, {
        journalEntries: (trip.journalEntries || []).filter(en => en.id !== entryId)
      });
      notify('Entrée supprimée', '🗑');
      renderJournal(tripId);
    }
  }
}

// ── Add / Edit Modal ──────────────────────────────────────────────────────────

function _openEntryModal(tripId, entryId) {
  const trip = getTrip(tripId);
  if (!trip) return;

  const isEdit = !!entryId;
  const entry  = isEdit ? (trip.journalEntries || []).find(e => e.id === entryId) : null;

  const state = {
    dayId:   entry?.dayId   || '',
    date:    entry?.date    || _today(),
    title:   entry?.title   || '',
    content: entry?.content || '',
    weather: entry?.weather || '',
    mood:    entry?.mood    || '',
    rating:  entry?.rating  || 0,
    photos:  entry ? [...(entry.photos || [])] : [],
    tags:    entry ? [...(entry.tags   || [])] : [],
  };

  const days = trip.days || [];

  const weatherEmojis = ['☀️', '⛅', '🌧️', '⛈️', '🌨️', '🌫️', '🌊', '🏔️'];
  const moodEmojis    = ['😊', '😎', '😍', '🥹', '😴', '🤔', '😤', '🙏'];

  function daysOptsHtml(selId) {
    return `<option value="">Aucun jour spécifique</option>` +
      days.map(d =>
        `<option value="${_esc(d.id)}"${selId === d.id ? ' selected' : ''}>Jour ${d.num}${d.title ? ' · ' + _esc(d.title) : ''}${d.date ? ' (' + fmtDateShort(d.date) + ')' : ''}</option>`
      ).join('');
  }

  function emojiBtn(emoji, selectedVal, groupName) {
    const sel = selectedVal === emoji;
    return `<button type="button" class="emoji-pick-btn${sel ? ' selected' : ''}" data-group="${groupName}" data-val="${_esc(emoji)}"
      style="background:${sel ? 'var(--tl)' : 'var(--c2)'};border:1.5px solid ${sel ? 'var(--teal)' : 'var(--c3)'};
      border-radius:8px;padding:4px 6px;font-size:18px;cursor:pointer;transition:all .1s">${emoji}</button>`;
  }

  function photosListHtml() {
    if (state.photos.length === 0) {
      return '<div style="font-size:11px;color:var(--ink4);padding:4px 0">Aucune photo ajoutée</div>';
    }
    return state.photos.map((ph, i) => `
      <div style="display:flex;align-items:center;gap:7px;margin-bottom:6px">
        <input type="text" placeholder="URL de la photo" value="${_esc(ph.url)}" data-photo-url="${i}"
          style="flex:1;background:var(--c);border:1.5px solid var(--c3);border-radius:7px;padding:6px 9px;font-size:12px;font-family:var(--fn);outline:none">
        <input type="text" placeholder="Légende" value="${_esc(ph.caption)}" data-photo-cap="${i}"
          style="flex:1;background:var(--c);border:1.5px solid var(--c3);border-radius:7px;padding:6px 9px;font-size:12px;font-family:var(--fn);outline:none">
        <button type="button" data-remove-photo="${i}" style="background:var(--crl);color:var(--coral);border:none;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:12px">✕</button>
      </div>`).join('');
  }

  function tagsHtml() {
    return state.tags.map((t, i) => `
      <span style="display:inline-flex;align-items:center;gap:4px;background:var(--tl);color:var(--td);border-radius:999px;padding:2px 8px;font-size:11px;font-weight:700">
        ${_esc(t)}
        <button type="button" data-remove-tag="${i}" style="background:none;border:none;color:var(--td);cursor:pointer;font-size:11px;padding:0;line-height:1">✕</button>
      </span>`).join('');
  }

  function starsHtml() {
    return [1, 2, 3, 4, 5].map(i =>
      `<span data-action="set-star" data-val="${i}"
        style="font-size:22px;cursor:pointer;opacity:${state.rating >= i ? '1' : '0.3'};transition:opacity .1s">★</span>`
    ).join('');
  }

  function buildHtml() {
    return `
      <button class="mc" onclick="closeModal()">✕</button>
      <h3>${isEdit ? '✏️ Modifier l\'entrée' : '📝 Nouvelle entrée de journal'}</h3>

      <div class="fg">
        <label>Jour du voyage</label>
        <select id="je-day">${daysOptsHtml(state.dayId)}</select>
      </div>

      <div class="fg">
        <label>Date</label>
        <input type="date" id="je-date" value="${_esc(state.date)}">
      </div>

      <div class="fg">
        <label>Titre</label>
        <input type="text" id="je-title" placeholder="Titre de l'entrée" value="${_esc(state.title)}">
      </div>

      <div class="fg">
        <label>Récit</label>
        <textarea id="je-content" rows="6" placeholder="Racontez votre journée...">${_esc(state.content)}</textarea>
      </div>

      <div class="fg">
        <label>Météo</label>
        <div style="display:flex;gap:5px;flex-wrap:wrap" id="weather-row">
          ${weatherEmojis.map(em => emojiBtn(em, state.weather, 'weather')).join('')}
        </div>
      </div>

      <div class="fg">
        <label>Humeur</label>
        <div style="display:flex;gap:5px;flex-wrap:wrap" id="mood-row">
          ${moodEmojis.map(em => emojiBtn(em, state.mood, 'mood')).join('')}
        </div>
      </div>

      <div class="fg">
        <label>Note</label>
        <div id="modal-star-row" style="display:flex;gap:6px">${starsHtml()}</div>
      </div>

      <div class="fg">
        <label>Photos</label>
        <div id="photos-list">${photosListHtml()}</div>
        <button type="button" id="add-photo-btn"
          style="margin-top:6px;background:var(--c2);border:1px solid var(--c3);border-radius:7px;padding:5px 12px;font-size:12px;font-weight:700;cursor:pointer;color:var(--ink3)">
          ＋ Ajouter une photo
        </button>
      </div>

      <div class="fg">
        <label>Tags</label>
        <div id="tags-list" style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:6px">${tagsHtml()}</div>
        <div style="display:flex;gap:6px">
          <input type="text" id="tag-input" placeholder="Nouveau tag, puis Entrée"
            style="flex:1;background:var(--c);border:1.5px solid var(--c3);border-radius:7px;padding:6px 9px;font-size:12px;font-family:var(--fn);outline:none">
          <button type="button" id="add-tag-btn"
            style="background:var(--teal);color:#fff;border:none;border-radius:7px;padding:6px 12px;font-size:12px;font-weight:700;cursor:pointer">＋</button>
        </div>
      </div>

      <div class="ma">
        <button class="bc" onclick="closeModal()">Annuler</button>
        <button class="bs" id="je-save">Enregistrer</button>
      </div>`;
  }

  function reRenderModal() {
    const mbox = document.querySelector('.mbox');
    if (mbox) {
      mbox.innerHTML = buildHtml();
      attachModalEvents();
    }
  }

  function reRenderTagsList() {
    const tl = document.getElementById('tags-list');
    if (tl) {
      tl.innerHTML = tagsHtml();
      tl.addEventListener('click', tagRemoveHandler);
    }
  }

  function tagRemoveHandler(ev) {
    const btn = ev.target.closest('[data-remove-tag]');
    if (!btn) return;
    state.tags.splice(parseInt(btn.dataset.removeTag, 10), 1);
    reRenderTagsList();
  }

  function attachModalEvents() {
    // Day selector
    document.getElementById('je-day')?.addEventListener('change', ev => {
      state.dayId = ev.target.value;
      if (state.dayId) {
        const d = days.find(d => d.id === state.dayId);
        if (d?.date) {
          state.date = d.date;
          const dateEl = document.getElementById('je-date');
          if (dateEl) dateEl.value = d.date;
        }
      }
    });

    // Date input
    document.getElementById('je-date')?.addEventListener('change', ev => {
      state.date = ev.target.value;
    });

    // Weather picker
    document.getElementById('weather-row')?.addEventListener('click', ev => {
      const btn = ev.target.closest('.emoji-pick-btn[data-group="weather"]');
      if (!btn) return;
      state.weather = state.weather === btn.dataset.val ? '' : btn.dataset.val;
      reRenderModal();
    });

    // Mood picker
    document.getElementById('mood-row')?.addEventListener('click', ev => {
      const btn = ev.target.closest('.emoji-pick-btn[data-group="mood"]');
      if (!btn) return;
      state.mood = state.mood === btn.dataset.val ? '' : btn.dataset.val;
      reRenderModal();
    });

    // Rating stars
    document.getElementById('modal-star-row')?.addEventListener('click', ev => {
      const star = ev.target.closest('[data-action="set-star"]');
      if (!star) return;
      const val = parseInt(star.dataset.val, 10);
      state.rating = state.rating === val ? 0 : val;
      reRenderModal();
    });

    // Add photo button
    document.getElementById('add-photo-btn')?.addEventListener('click', () => {
      state.photos.push({ url: '', caption: '' });
      reRenderModal();
    });

    // Photo list — URL/caption changes and removals
    document.getElementById('photos-list')?.addEventListener('input', ev => {
      const urlIdx = ev.target.dataset.photoUrl;
      const capIdx = ev.target.dataset.photoCap;
      if (urlIdx !== undefined) state.photos[parseInt(urlIdx, 10)].url     = ev.target.value;
      if (capIdx !== undefined) state.photos[parseInt(capIdx, 10)].caption = ev.target.value;
    });
    document.getElementById('photos-list')?.addEventListener('click', ev => {
      const btn = ev.target.closest('[data-remove-photo]');
      if (!btn) return;
      state.photos.splice(parseInt(btn.dataset.removePhoto, 10), 1);
      reRenderModal();
    });

    // Add tag
    const doAddTag = () => {
      const inp = document.getElementById('tag-input');
      if (!inp) return;
      const raw = inp.value.trim();
      if (!raw) return;
      raw.split(',').map(t => t.trim()).filter(Boolean).forEach(t => {
        if (!state.tags.includes(t)) state.tags.push(t);
      });
      inp.value = '';
      reRenderTagsList();
    };
    document.getElementById('add-tag-btn')?.addEventListener('click', doAddTag);
    document.getElementById('tag-input')?.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') { ev.preventDefault(); doAddTag(); }
    });

    // Tag remove
    document.getElementById('tags-list')?.addEventListener('click', tagRemoveHandler);

    // Save
    document.getElementById('je-save')?.addEventListener('click', () => {
      // Collect latest input values
      state.title   = document.getElementById('je-title')?.value?.trim()  || '';
      state.content = document.getElementById('je-content')?.value         || '';
      state.date    = document.getElementById('je-date')?.value            || _today();
      state.dayId   = document.getElementById('je-day')?.value             || '';

      // Collect photo inputs (they may have changed since last rerender)
      state.photos = state.photos.map((ph, i) => ({
        url:     (document.querySelector(`[data-photo-url="${i}"]`)?.value ?? ph.url).trim(),
        caption: (document.querySelector(`[data-photo-cap="${i}"]`)?.value ?? ph.caption).trim(),
      })).filter(ph => ph.url !== '');

      const freshTrip = getTrip(tripId);
      const entries   = [...(freshTrip.journalEntries || [])];

      if (isEdit) {
        const idx = entries.findIndex(en => en.id === entryId);
        if (idx !== -1) {
          entries[idx] = {
            ...entries[idx],
            dayId:   state.dayId   || null,
            date:    state.date,
            title:   state.title,
            content: state.content,
            weather: state.weather,
            mood:    state.mood,
            rating:  state.rating  || null,
            photos:  state.photos,
            tags:    state.tags,
          };
        }
        notify('Entrée mise à jour', '✓');
      } else {
        entries.push({
          id:      'je_' + uid(),
          dayId:   state.dayId   || null,
          date:    state.date,
          title:   state.title,
          content: state.content,
          weather: state.weather,
          mood:    state.mood,
          rating:  state.rating  || null,
          photos:  state.photos,
          tags:    state.tags,
        });
        notify('Entrée ajoutée', '📔');
      }

      updateTrip(tripId, { journalEntries: entries });
      closeModal();
      renderJournal(tripId);
    });
  }

  showModal(buildHtml());
  attachModalEvents();
}
