// Dashboard Service Worker — push notifications for new orders

self.addEventListener('install', function(event) {
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(clients.claim());
});

// Listen for messages from the dashboard to show notifications
self.addEventListener('message', function(event) {
  if (event.data && event.data.type === 'NEW_ORDER') {
    self.registration.showNotification('¡Nueva Orden! 🔔', {
      body: event.data.body || 'Toca para ver la orden',
      icon: '/favicon.ico',
      vibrate: [500, 200, 500, 200, 500],
      requireInteraction: true,
      tag: 'new-order',
      renotify: true
    });
  }
});

// On notification click — open/focus the dashboard tab
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if (client.url.includes('/dashboard') && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow(self.location.origin + '/mrsandwich/dashboard');
    })
  );
});
