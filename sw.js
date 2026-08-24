/* Lumen Sign v8.9.0 — Service Worker de notificaciones y seguimiento */

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
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    data: {
      url: payload.url || './?open=tasks',
      notificationId: payload.notificationId || null
    }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();

  const scopeUrl = new URL(self.registration.scope);
  const requestedUrl = new URL(event.notification.data?.url || './?open=tasks', scopeUrl);
  const targetUrl = requestedUrl.origin === scopeUrl.origin && requestedUrl.href.startsWith(scopeUrl.href)
    ? requestedUrl.href
    : new URL('./?open=tasks', scopeUrl).href;

  event.waitUntil((async () => {
    const controlledWindows = await self.clients.matchAll({ type: 'window', includeUncontrolled: false });
    for (const client of controlledWindows) {
      if (client.url.startsWith(self.registration.scope)) {
        await client.focus();
        try {
          client.postMessage({ type: 'LUMEN_SIGN_PUSH_CLICK', url: targetUrl });
        } catch {}
        return;
      }
    }

    // Si la pagina ya existia pero todavia no estaba controlada, navegarla deja
    // la intencion en la URL para que app.js la procese al terminar de cargar.
    const allWindows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allWindows) {
      if (client.url.startsWith(self.registration.scope)) {
        try { await client.navigate(targetUrl); } catch {}
        await client.focus();
        return;
      }
    }
    await self.clients.openWindow(targetUrl);
  })());
});

self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    windows.forEach(client => {
      try {
        client.postMessage({ type: 'LUMEN_SIGN_PUSH_SUBSCRIPTION_CHANGED' });
      } catch {}
    });
  })());
});
