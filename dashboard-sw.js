// Dashboard Service Worker — push notifications + PWA navigation handler

var CACHE_NAME = 'dashboard-shell-v1';
var DASHBOARD_HTML = '/dashboard/index.html';

self.addEventListener('install', function(event) {
  // Pre-cache the dashboard shell so PWA navigation works offline/standalone
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.add(DASHBOARD_HTML);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(clients.claim());
});

// Intercept navigation requests to /{slug}/dashboard — serve cached dashboard shell
// This prevents 404 when opening as installed PWA (Vercel rewrites don't run client-side)
self.addEventListener('fetch', function(event) {
  var request = event.request;

  // Only intercept navigation requests (HTML page loads)
  if (request.mode !== 'navigate') return;

  var url = new URL(request.url);

  // Match /{slug}/dashboard or /{slug}/dashboard/
  if (/^\/[^/]+\/dashboard\/?$/.test(url.pathname)) {
    event.respondWith(
      fetch(request).catch(function() {
        // Network failed — serve cached dashboard shell
        return caches.match(DASHBOARD_HTML);
      })
    );
  }
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
      // Fallback: open root (any dashboard tab will match above)
      return clients.openWindow(self.location.origin);
    })
  );
});
