/* ============================================================
   ATLAS — Notifications push (v252)
   ============================================================
   Firebase Cloud Messaging : l'appareil s'abonne (jeton FCM lié au service
   worker de l'appli, sw.js) et enregistre son jeton dans users/{uid}.pushTokens.
   La Cloud Function functions/index.js surveille les voyages partagés et envoie
   les notifications (publication, commentaire, ❤, modification), affichées par
   sw.js même appli fermée.

   iPhone : uniquement depuis l'appli ajoutée à l'écran d'accueil (iOS ≥ 16.4) —
   Safari « onglet » n'a pas de Web Push.
   ============================================================ */

import { getFirebaseApp, getCurrentUser, savePushToken, removePushToken } from './auth.js';
import { firebaseConfig } from './firebase-config.js';

const FB = 'https://www.gstatic.com/firebasejs/11.1.0';
const LS_TOKEN = 'atlas_push_token';

const _isIos = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const _standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;

/** 'ok' | 'ios-install' (iPhone hors appli installée) | 'unsupported' */
export function pushAvailability() {
  if (_isIos() && !_standalone()) return 'ios-install';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  return 'ok';
}

/** Cet appareil reçoit les notifications push (jeton enregistré + autorisation). */
export function pushActive() {
  try { return !!localStorage.getItem(LS_TOKEN) && Notification.permission === 'granted'; } catch (_) { return false; }
}

async function _messaging() {
  const app = getFirebaseApp();
  if (!app) return null;
  const m = await import(`${FB}/firebase-messaging.js`);
  if (!(await m.isSupported().catch(() => false))) return null;
  return { m, messaging: m.getMessaging(app) };
}

/**
 * Active les notifications push sur cet appareil. À appeler depuis un geste de
 * l'utilisateur (la demande d'autorisation l'exige sur iPhone).
 * → { ok:true } | { ok:false, reason:'login'|'ios-install'|'unsupported'|'denied'|'error', error? }
 */
export async function enablePush({ silent = false } = {}) {
  const avail = pushAvailability();
  if (avail !== 'ok') return { ok: false, reason: avail };
  if (!getCurrentUser()) return { ok: false, reason: 'login' };
  try {
    if (Notification.permission !== 'granted') {
      if (silent) return { ok: false, reason: 'denied' };
      if ((await Notification.requestPermission()) !== 'granted') return { ok: false, reason: 'denied' };
    }
    const fm = await _messaging();
    if (!fm) return { ok: false, reason: 'unsupported' };
    const reg = await navigator.serviceWorker.ready;
    const token = await fm.m.getToken(fm.messaging, {
      serviceWorkerRegistration: reg,
      ...(firebaseConfig.vapidKey ? { vapidKey: firebaseConfig.vapidKey } : {}),
    });
    if (!token) return { ok: false, reason: 'error' };
    const prev = localStorage.getItem(LS_TOKEN);
    if (prev && prev !== token) removePushToken(prev);
    await savePushToken(token);
    localStorage.setItem(LS_TOKEN, token);
    return { ok: true };
  } catch (error) {
    console.warn('[push] activation impossible :', error);
    return { ok: false, reason: 'error', error };
  }
}

/** Coupe les notifications push sur cet appareil (jeton supprimé côté FCM et Firestore). */
export async function disablePush() {
  let token = null;
  try { token = localStorage.getItem(LS_TOKEN); localStorage.removeItem(LS_TOKEN); } catch (_) {}
  if (token) await removePushToken(token);
  try { const fm = await _messaging(); if (fm) await fm.m.deleteToken(fm.messaging); } catch (_) {}
}

/** Au démarrage (connecté) : ré-enregistre le jeton (il peut changer) sans rien demander. */
export function refreshPush(settings) {
  if (!settings?.notifications?.enabled) return;
  if (pushAvailability() !== 'ok' || Notification.permission !== 'granted') return;
  enablePush({ silent: true }).catch(() => {});
}

/** Message lisible pour un échec d'activation. */
export function pushErrorText(res) {
  switch (res?.reason) {
    case 'ios-install': return 'Sur iPhone, les notifications ne marchent que depuis l\'appli ajoutée à l\'écran d\'accueil';
    case 'unsupported': return 'Notifications non disponibles sur ce navigateur';
    case 'denied':      return 'Notifications refusées — autorisez-les dans les réglages du téléphone';
    case 'login':       return 'Connectez-vous pour recevoir les notifications';
    default:            return 'Activation des notifications impossible' + (res?.error?.code ? ` (${res.error.code})` : '');
  }
}
