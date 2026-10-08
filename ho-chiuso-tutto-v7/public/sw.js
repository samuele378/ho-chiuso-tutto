const CACHE_NAME = 'ho-chiuso-tutto-v7';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=Playfair+Display:wght@700;900&display=swap'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Network-first for HTML/navigation
  if (e.request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname === '/' || url.pathname.endsWith('/')) {
    e.respondWith(
      fetch(e.request)
        .then(resp => {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
          return resp;
        })
        .catch(() => caches.match(e.request).then(c => c || caches.match('./index.html')))
    );
    return;
  }
  // Stale-while-revalidate for other assets
  e.respondWith(
    caches.match(e.request).then(cached => {
      const fetchPromise = fetch(e.request).then(resp => {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        return resp;
      }).catch(() => {});
      return cached || fetchPromise;
    })
  );
});

// Handle push notifications from FCM server
self.addEventListener('push', e => {
  let data = { title: 'Ho Chiuso Tutto?', body: 'Hai un impegno!' };
  if (e.data) {
    try {
      const json = e.data.json();
      if (json.notification) {
        data.title = json.notification.title || data.title;
        data.body = json.notification.body || data.body;
      } else if (json.data) {
        data.title = json.data.title || data.title;
        data.body = json.data.body || data.body;
      }
    } catch (err) {
      try {
        data.body = e.data.text() || data.body;
      } catch (e2) {}
    }
  }
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: './icon-192.png',
      badge: './icon-192.png',
      vibrate: [300, 100, 300, 100, 300],
      tag: 'hct-push-' + Date.now(),
      requireInteraction: true,
      data: { url: './' }
    })
  );
});

// Handle local notification requests from the app
self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') {
    self.skipWaiting();
  }
  if (e.data && e.data.type === 'SHOW_NOTIFICATION') {
    self.registration.showNotification(e.data.title, {
      body: e.data.body,
      icon: './icon-192.png',
      badge: './icon-192.png',
      vibrate: [300, 100, 300, 100, 300],
      tag: e.data.tag || 'hct-cal',
      requireInteraction: true,
      data: { url: './' }
    });
  }
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cls => {
      if (cls.length > 0) {
        cls[0].focus();
        cls[0].postMessage({ type: 'OPEN_CALENDAR' });
      } else {
        clients.openWindow('./');
      }
    })
  );
});
