// Firebase compat SDK for service workers
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

// ⚠️ REPLACE with your Firebase project config from Firebase Console
firebase.initializeApp({
  apiKey: "AIzaSyCk77dGtiwhAcPcdjY6Q3NDlmaT7kQ_9eQ",
  authDomain: "pincer-app-deda6.firebaseapp.com",
  projectId: "pincer-app-deda6",
  storageBucket: "pincer-app-deda6.appspot.com",
  messagingSenderId: "1025818715545",
  appId: "1:1025818715545:web:d149b23af22f151c85df08"
});

const messaging = firebase.messaging();

// Handle background messages (tab closed or browser in background)
messaging.onBackgroundMessage(function(payload) {
  console.log('[Pincer SW] Background message:', payload);

  const data = payload.data || {};
  const title = data.title || 'Nueva Orden en Pincer';
  const body = data.body || 'Tienes una nueva orden pendiente';
  const orderId = data.orderId || '';

  return self.registration.showNotification(title, {
    body: body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: 'pincer-order-' + orderId,
    renotify: true,
    requireInteraction: true,
    vibrate: [300, 100, 300, 100, 300],
    data: {
      url: '/restaurant.html',
      orderId: orderId
    }
  });
});

// Handle notification click — open or focus the dashboard
self.addEventListener('notificationclick', function(event) {
  event.notification.close();

  const urlToOpen = event.notification.data?.url || '/restaurant.html';

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
