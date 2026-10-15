/* ============================================================
   ATLAS — Cloud Functions (v252) : notifications push
   ============================================================
   À chaque modification d'un document shared_trips/{tripId}, on calcule
   les notifications à envoyer (notify.js) puis on les envoie par Firebase
   Cloud Messaging aux appareils des destinataires (users/{uid}.pushTokens,
   enregistrés par js/push.js), en respectant leurs réglages
   (users/{uid}.settings.notifications). Messages « data » seulement : c'est
   le service worker de l'appli (sw.js) qui les affiche.
   Les jetons refusés par FCM (appli désinstallée…) sont supprimés.
   ============================================================ */

const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { logger } = require('firebase-functions');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldPath, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { buildNotifications, wants } = require('./notify');

initializeApp();
const db = getFirestore();

const DEAD = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token', 'messaging/invalid-argument']);

async function _recipients(uids) {
  const out = new Map();
  for (let i = 0; i < uids.length; i += 30) {
    const snap = await db.collection('users')
      .where(FieldPath.documentId(), 'in', uids.slice(i, i + 30))
      .select('pushTokens', 'settings').get();
    snap.forEach(d => out.set(d.id, d.data() || {}));
  }
  return out;
}

exports.notifySharedTrip = onDocumentUpdated(
  { document: 'shared_trips/{tripId}', region: 'europe-west1' },
  async event => {
    const before = event.data.before.data() || {};
    const after  = event.data.after.data() || {};
    const notes  = buildNotifications(before, after, event.params.tripId);
    if (!notes.length) return;

    const users = await _recipients([...new Set(notes.flatMap(n => n.to))]);
    for (const n of notes) {
      const targets = [];   // [{ uid, token }]
      for (const uid of n.to) {
        const u = users.get(uid);
        if (!u || !wants(u.settings, n.kind)) continue;
        for (const token of Object.keys(u.pushTokens || {})) targets.push({ uid, token });
      }
      if (!targets.length) continue;
      const res = await getMessaging().sendEachForMulticast({
        tokens: targets.map(t => t.token),
        data: { title: n.title, body: n.body, url: n.url, tag: n.tag },
        webpush: { headers: { Urgency: 'high', TTL: '86400' } },
      });
      const cleanup = [];
      res.responses.forEach((r, i) => {
        if (!r.success && DEAD.has(r.error && r.error.code)) {
          const { uid, token } = targets[i];
          cleanup.push(db.collection('users').doc(uid).update(new FieldPath('pushTokens', token), FieldValue.delete()).catch(() => {}));
        }
      });
      await Promise.all(cleanup);
      logger.info(`[notify] ${n.kind} → ${res.successCount}/${targets.length}`);
    }
  },
);
