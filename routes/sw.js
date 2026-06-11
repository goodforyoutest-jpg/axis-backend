// FILE: sw.js — place in your frontend root (same level as index.html / dashboard.html)

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Handle incoming push messages from the server
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'AXIS', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'AXIS Notification';
  const options = {
    body: data.body || 'You have a new notification.',
    icon: data.icon || 'https://cdn-icons-png.flaticon.com/512/1827/1827392.png',
    badge: data.badge || 'https://cdn-icons-png.flaticon.com/512/1827/1827392.png',
    vibrate: data.vibrate || [100, 50, 100, 50, 200],
    tag: data.tag || `axis-${Date.now()}`,
    data: { url: data.url || '/dashboard.html' }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Handle clicks on the notification
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/dashboard.html';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(url) && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
