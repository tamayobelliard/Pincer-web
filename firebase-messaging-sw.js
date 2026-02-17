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
// RAW PUSH EVENT — most reliable way to show notifications
// on Android even with screen off / Chrome closed
// ═══════════════════════════════════════════════════════════
self.addEventListener('push', function(event) {
  console.log('[Pincer SW] Push received:', event);

  let data = {};
  try {
    if (event.data) {
      const json = event.data.json();
      // FCM wraps data-only messages inside json.data
      data = json.data || json;
    }
  } catch (e) {
    console.error('[Pincer SW] Error parsing push data:', e);
  }

  const title = data.title || 'Nueva Orden en Pincer';
  const body = data.body || 'Tienes una nueva orden pendiente';
  const orderId = data.orderId || '';

  const options = {
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
      url: '/mrsandwich/dashboard/',
      orderId: orderId
    }
  };

  // waitUntil keeps the SW alive until showNotification resolves
  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// ═══════════════════════════════════════════════════════════
// NOTIFICATION CLICK — open or focus the dashboard
// ═══════════════════════════════════════════════════════════
self.addEventListener('notificationclick', function(event) {
  event.notification.close();

  const urlToOpen = event.notification.data?.url || '/mrsandwich/dashboard/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(windowClients) {
      for (var i = 0; i < windowClients.length; i++) {
        var client = windowClients[i];
        if (client.url.includes('restaurant') && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow(urlToOpen);
    })
  );
});
