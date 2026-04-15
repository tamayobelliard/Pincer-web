// Firebase compat SDK for service workers
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

// ── Version: bump this on every deploy to force SW update ──
var SW_VERSION = 'v6';

firebase.initializeApp({
  apiKey: "AIzaSyCk77dGtiwhAcPcdjY6Q3NDlmaT7kQ_9eQ",
  authDomain: "pincer-app-deda6.firebaseapp.com",
  projectId: "pincer-app-deda6",
  storageBucket: "pincer-app-deda6.appspot.com",
  messagingSenderId: "1025818715545",
  appId: "1:1025818715545:web:d149b23af22f151c85df08"
});

firebase.messaging();

// ═══════════════════════════════════════════════════════════
// INSTALL — cache dashboard shell, clean old caches, activate immediately
// ═══════════════════════════════════════════════════════════

var CACHE_NAME = 'dashboard-shell-' + SW_VERSION;
var DASHBOARD_HTML = '/dashboard/index.html';

self.addEventListener('install', function(event) {
  console.log('[Pincer SW] Installing ' + SW_VERSION);
  event.waitUntil(
    caches.keys().then(function(names) {
      return Promise.all(
        names.filter(function(n) { return n !== CACHE_NAME; })
          .map(function(n) { return caches.delete(n); })
      );
    }).then(function() {
      return caches.open(CACHE_NAME).then(function(cache) {
        return cache.add(DASHBOARD_HTML);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  console.log('[Pincer SW] Activated ' + SW_VERSION);
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
// FCM PUSH — notification when browser is in background / screen locked
// ═══════════════════════════════════════════════════════════

self.addEventListener('push', function(event) {
  console.log('[Pincer SW] Push received (' + SW_VERSION + ')');

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
    tag: 'pincer-order-' + orderId + '-' + Date.now(),
    renotify: true,
    requireInteraction: true,
    silent: false,
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
    Promise.all([
      self.registration.showNotification(title, options),
      self.clients.matchAll({ type: 'window' }).then(function(clients) {
        clients.forEach(function(client) {
          client.postMessage({ type: 'PLAY_ORDER_SOUND', orderId: orderId });
        });
      })
    ])
  );
});

// ═══════════════════════════════════════════════════════════
// MESSAGE — Dashboard sends NEW_ORDER for foreground notification
// ═══════════════════════════════════════════════════════════

self.addEventListener('message', function(event) {
  if (event.data && event.data.type === 'NEW_ORDER') {
    self.registration.showNotification(event.data.title || 'Nueva Orden', {
      body: event.data.body || 'Toca para ver la orden',
      icon: '/icon-192.png',
      vibrate: [500, 200, 500, 200, 500],
      requireInteraction: true,
      tag: 'new-order',
      renotify: true
    });
  }

  // Health check: respond with version
  if (event.data && event.data.type === 'HEALTH_CHECK') {
    event.ports[0].postMessage({ version: SW_VERSION });
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
