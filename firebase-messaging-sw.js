// Firebase compat SDK for service workers
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyCk77dGtiwhAcPcdjY6Q3NDlmaT7kQ_9eQ",
  authDomain: "pincer-app-deda6.firebaseapp.com",
  projectId: "pincer-app-deda6",
  storageBucket: "pincer-app-deda6.appspot.com",
  messagingSenderId: "1025818715545",
  appId: "1:1025818715545:web:d149b23af22f151c85df08"
});

// Initialize messaging (needed for token management)
firebase.messaging();

// ═══════════════════════════════════════════════════════════
// PWA — Cache dashboard shell + immediate activation
// ═══════════════════════════════════════════════════════════

var CACHE_NAME = 'dashboard-shell-v2';
var DASHBOARD_HTML = '/dashboard/index.html';

self.addEventListener('install', function(event) {
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

// ═══════════════════════════════════════════════════════════
// PWA NAVIGATION — serve cached dashboard for /{slug}/dashboard/
// ═══════════════════════════════════════════════════════════

self.addEventListener('fetch', function(event) {
  var request = event.request;
  if (request.mode !== 'navigate') return;

  var url = new URL(request.url);
  if (/^\/[^/]+\/dashboard\/?$/.test(url.pathname)) {
    event.respondWith(
      fetch(request).catch(function() {
        return caches.match(DASHBOARD_HTML);
      })
    );
  }
});

// ═══════════════════════════════════════════════════════════
// FCM PUSH — show notification when browser is in background
// or screen is locked (most reliable method)
// ═══════════════════════════════════════════════════════════

self.addEventListener('push', function(event) {
  console.log('[Pincer SW] Push received:', event);

  var data = {};
  try {
    if (event.data) {
      var json = event.data.json();
      data = json.data || json;
    }
  } catch (e) {
    console.error('[Pincer SW] Error parsing push data:', e);
  }

  var title = data.title || 'Nueva Orden en Pincer';
  var body = data.body || 'Tienes una nueva orden pendiente';
  var orderId = data.orderId || '';
  var dashboardUrl = data.url || '/' + (data.restaurantSlug || 'mrsandwich') + '/dashboard/';

  var options = {
    body: body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: 'pincer-order-' + orderId,
    renotify: true,
    requireInteraction: true,
    vibrate: [300, 100, 300, 100, 300, 100, 300],
    actions: [
      { action: 'open', title: 'Ver orden' }
    ],
    data: {
      url: dashboardUrl,
      orderId: orderId
    }
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// ═══════════════════════════════════════════════════════════
// MESSAGE — Dashboard sends NEW_ORDER to show notification
// (foreground fallback when tab is active)
// ═══════════════════════════════════════════════════════════

self.addEventListener('message', function(event) {
  if (event.data && event.data.type === 'NEW_ORDER') {
    self.registration.showNotification(event.data.title || '¡Nueva Orden! 🔔', {
      body: event.data.body || 'Toca para ver la orden',
      icon: '/icon-192.png',
      vibrate: [500, 200, 500, 200, 500],
      requireInteraction: true,
      tag: 'new-order',
      renotify: true
    });
  }
});

// ═══════════════════════════════════════════════════════════
// NOTIFICATION CLICK — open or focus the dashboard
// ═══════════════════════════════════════════════════════════

self.addEventListener('notificationclick', function(event) {
  event.notification.close();

  var urlToOpen = event.notification.data?.url || '/dashboard/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(windowClients) {
      for (var i = 0; i < windowClients.length; i++) {
        var client = windowClients[i];
        if (client.url.includes('dashboard') && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow(urlToOpen);
    })
  );
});
