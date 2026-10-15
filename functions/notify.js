/* ============================================================
   ATLAS — Quelles notifications envoyer pour une modification
   d'un voyage partagé (logique pure, testée sans Firebase)
   ============================================================
   buildNotifications(before, after, tripId, now) → [{ to:[uid], kind, title, body, url, tag }]
   kind = clé de settings.notifications qui doit être active chez le destinataire :
     observerPublish (publication), social (commentaire, ❤ sur ses publications),
     collaborative (modification du voyage).
   ============================================================ */

const EDIT_QUIET_MS = 30 * 60 * 1000;   // une notif « modifié » au plus par 30 min et par auteur

function buildNotifications(before = {}, after = {}, tripId, now = Date.now()) {
  const members   = after.members || {};
  const tripName  = (after.trip && after.trip.name) || 'un voyage';
  const url       = `/?trip=${encodeURIComponent(tripId)}`;
  const uids      = Object.keys(members);
  const travelers = uids.filter(u => ['owner', 'member'].includes(members[u] && members[u].role));
  const nameOf    = u => (members[u] && members[u].companionName) || 'Quelqu’un';
  const out = [];
  const push = (to, kind, title, body, tag) => {
    const dest = [...new Set(to)].filter(Boolean);
    if (dest.length) out.push({ to: dest, kind, title, body, url, tag: tag || tripId });
  };

  // 1. Publication d'une étape → tout le monde sauf l'auteur
  const pub = after.lastPublished, prevPub = before.lastPublished;
  if (pub && pub.ts && (!prevPub || prevPub.ts !== pub.ts)) {
    const what = pub.itemText ? ` · ${pub.itemText}` : '';
    push(uids.filter(u => u !== pub.uid), 'observerPublish',
      `📸 ${pub.actorName || 'Nouvelle publication'}`,
      `${pub.dayLabel || 'Nouveau jour'}${what} — ${tripName}`, `${tripId}-pub`);
  }

  // 2. Commentaires sur une publication (observerComments) → voyageurs sauf l'auteur
  const prevOC = before.observerComments || {};
  for (const [id, c] of Object.entries(after.observerComments || {})) {
    if (prevOC[id] || !c) continue;
    push(travelers.filter(u => u !== c.uid), 'social',
      `💬 ${c.name || 'Commentaire'}`, `${String(c.text || '').slice(0, 140)} — ${tripName}`, `${tripId}-c`);
  }

  // 3. Commentaires par jour (comments.{dayId} = [...]) → tous sauf l'auteur
  const prevC = before.comments || {};
  for (const [dayId, list] of Object.entries(after.comments || {})) {
    const known = new Set((prevC[dayId] || []).map(c => c && c.id));
    for (const c of list || []) {
      if (!c || known.has(c.id)) continue;
      push(uids.filter(u => u !== c.uid), 'social',
        `💬 ${c.author || 'Commentaire'}`, `${String(c.text || '').slice(0, 140)} — ${tripName}`, `${tripId}-c`);
    }
  }

  // 4. ❤ sur une publication → voyageurs sauf la personne qui aime
  const prevR = before.reactions || {};
  const likers = new Set();
  for (const [itemId, byUid] of Object.entries(after.reactions || {})) {
    for (const u of Object.keys(byUid || {})) {
      if (!(prevR[itemId] && prevR[itemId][u])) likers.add(u);
    }
  }
  for (const u of likers) {
    push(travelers.filter(t => t !== u), 'social', `❤️ ${nameOf(u)} aime votre publication`, tripName, `${tripId}-r`);
  }

  // 5. Modification du voyage (journal d'activité) → autres voyageurs, pas en rafale
  const prevActs = before.activity || [], acts = after.activity || [];
  if (acts.length > prevActs.length) {
    const last = acts[acts.length - 1];
    if (last && last.uid) {
      const prevSame = [...prevActs].reverse().find(a => a && a.uid === last.uid);
      const recent = prevSame && (now - Date.parse(prevSame.ts || 0)) < EDIT_QUIET_MS;
      if (!recent) {
        push(travelers.filter(t => t !== last.uid), 'collaborative',
          `✏️ ${last.actor || nameOf(last.uid)} a modifié le voyage`, tripName, `${tripId}-e`);
      }
    }
  }

  return out;
}

/** Le destinataire veut-il ce type de notification ? (settings.notifications) */
function wants(settings, kind) {
  const n = (settings && settings.notifications) || {};
  return !!n.enabled && n[kind] !== false;
}

module.exports = { buildNotifications, wants };
