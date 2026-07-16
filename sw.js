/* Lumen Sign v8.6.0 — Service Worker de notificaciones push */

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', event => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }

  const title = payload.title || 'Lumen Sign';
  const options = {
    body: payload.body || 'Tienes una nueva tarea en Lumen Sign.',
    tag: payload.notificationId ? `lumen-sign-${payload.notificationId}` : 'lumen-sign',
    renotify: true,
    requireInteraction: true,
    data: {
      url: payload.url || './?open=tasks',
      notificationId: payload.notificationId || null
    },
    badge: './favicon.ico'
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();

  const targetUrl = new URL(event.notification.data?.url || './?open=tasks', self.registration.scope).href;

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (client.url.includes('/lumen-sign/')) {
        await client.focus();
        try {
          client.postMessage({ type: 'LUMEN_SIGN_PUSH_CLICK', url: targetUrl });
        } catch {}
        return;
      }
    }
    await self.clients.openWindow(targetUrl);
  })());
});
