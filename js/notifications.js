export function notificationsSupported() {
  return 'Notification' in window;
}

export async function requestNotificationPermission() {
  if (!notificationsSupported()) return false;
  return (await Notification.requestPermission()) === 'granted';
}

export function notificationPermissionGranted() {
  return notificationsSupported() && Notification.permission === 'granted';
}

export function showBrowserNotification(title, body) {
  if (!notificationPermissionGranted()) return;
  try {
    const n = new Notification(title, { body, icon: location.origin + '/favicon.ico' });
    setTimeout(() => n.close(), 6000);
  } catch (_) {}
}

export function checkDepartureNotifications(trips, settings) {
  if (!notificationPermissionGranted()) return;
  if (!settings?.notifications?.enabled || settings.notifications.departure === false) return;
  const today    = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  for (const trip of (trips || [])) {
    if (!trip.startDate) continue;
    if (trip.startDate === today)
      showBrowserNotification('✈️ Départ aujourd\'hui !', `Bon voyage pour « ${trip.name} » !`);
    else if (trip.startDate === tomorrow)
      showBrowserNotification('🗓 Départ demain', `Préparez-vous pour « ${trip.name} » !`);
  }
}

export function notifyCollaboratorChange(tripName, actorName, settings) {
  if (!notificationPermissionGranted()) return;
  if (!settings?.notifications?.enabled || settings.notifications.collaborative === false) return;
  showBrowserNotification(
    `✏️ ${actorName || 'Un collaborateur'} a modifié un voyage`,
    tripName || '',
  );
}
