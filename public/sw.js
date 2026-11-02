// Jishnu Infotech Support - Service Worker for Background System Notifications

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const ticketId = event.notification.data?.ticketId;
  const view = event.notification.data?.view;
  const targetUrl = ticketId ? `/?ticket=${ticketId}` : (view ? `/?view=${view}` : '/');

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          if (ticketId) {
            client.postMessage({ type: 'OPEN_TICKET', ticketId: Number(ticketId) });
          } else if (view) {
            client.postMessage({ type: 'OPEN_VIEW', view });
          }
          return;
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
