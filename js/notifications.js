/* ============================================================
   CARNET DE VOYAGES — Browser Notifications
   Wraps the Web Notifications API.
   Departure reminders are checked on every app load, but
   deduplicated in-memory so the same trip never triggers two
   notifications in the same session.
   ============================================================ */

/** Whether the browser supports the Notifications API at all. */
export function notificationsSupported() {
  return 'Notification' in window;
}

/** Ask the user for notification permission; returns true if granted. */
export async function requestNotificationPermission() {
  if (!notificationsSupported()) return false;
  return (await Notification.requestPermission()) === 'granted';
}

/** True when permission is already granted (no prompt needed). */
export function notificationPermissionGranted() {
  return notificationsSupported() && Notification.permission === 'granted';
}

/**
 * Fire a browser notification that auto-closes after 6 seconds.
 * Safe to call without a prior permission check — the guard is inside.
 */
export function showBrowserNotification(title, body) {
  if (!notificationPermissionGranted()) return;
  try {
    const n = new Notification(title, { body, icon: location.origin + '/favicon.ico' });
    setTimeout(() => n.close(), 6000);
  } catch (_) {
    // Notification constructor can throw in private-browsing on some browsers
  }
}

// ── Deduplication ──────────────────────────────────────────────────────────────
// Tracks which trip/day combos already fired this session so rapid re-renders
// don't spam the user with duplicate notifications.
const _sentThisSession = new Set();

// ── Local-date helpers ─────────────────────────────────────────────────────────

/**
 * Return today's date as a local YYYY-MM-DD string.
 * Using getFullYear/getMonth/getDate (local time) instead of toISOString()
 * avoids a UTC-vs-local mismatch that could give the wrong date near midnight,
 * and also avoids DST issues caused by adding a fixed 86400000 ms offset.
 */
function _localIso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Check all trips and fire a departure notification for any that start today or
 * tomorrow.  Safe to call on every page load — each trip fires at most once per
 * session thanks to `_sentThisSession`.
 *
 * @param {Array}  trips    - array of trip objects from the store
 * @param {object} settings - app settings (must have notifications.enabled)
 */
export function checkDepartureNotifications(trips, settings) {
  if (!notificationPermissionGranted()) return;
  if (!settings?.notifications?.enabled || settings.notifications.departure === false) return;

  const todayDate    = new Date();
  const tomorrowDate = new Date(todayDate);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1); // safe across DST transitions

  const today    = _localIso(todayDate);
  const tomorrow = _localIso(tomorrowDate);

  for (const trip of (trips || [])) {
    if (!trip.startDate) continue;

    if (trip.startDate === today) {
      const key = `dep:${trip.id}:today`;
      if (!_sentThisSession.has(key)) {
        _sentThisSession.add(key);
        showBrowserNotification('✈️ Départ aujourd\'hui !', `Bon voyage pour « ${trip.name} » !`);
      }
    } else if (trip.startDate === tomorrow) {
      const key = `dep:${trip.id}:tomorrow`;
      if (!_sentThisSession.has(key)) {
        _sentThisSession.add(key);
        showBrowserNotification('🗓 Départ demain', `Préparez-vous pour « ${trip.name} » !`);
      }
    }
  }
}

/**
 * Notify that a collaborator has modified a shared trip.
 * Only fires when the collaborative-notifications setting is on.
 */
export function notifyCollaboratorChange(tripName, actorName, settings) {
  if (!notificationPermissionGranted()) return;
  if (!settings?.notifications?.enabled || settings.notifications.collaborative === false) return;
  showBrowserNotification(
    `✏️ ${actorName || 'Un collaborateur'} a modifié un voyage`,
    tripName || '',
  );
}
