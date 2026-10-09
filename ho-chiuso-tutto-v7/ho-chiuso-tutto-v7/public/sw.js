const CACHE_NAME = 'ho-chiuso-tutto-v8';
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

function showNotif(title, body, tag) {
  return self.registration.showNotification(title, {
    body: body,
    icon: './icon-192.png',
    badge: './icon-192.png',
    vibrate: [300, 100, 300, 100, 300],
    tag: tag || ('hct-' + Date.now()),
    requireInteraction: true,
    data: { url: './' }
  });
}

// ── Push dal server (FCM) — funziona anche con l'app chiusa ──
self.addEventListener('push', e => {
  let title = 'Ho Chiuso Tutto?', body = 'Hai un impegno!', tag = '';
  if (e.data) {
    try {
      const json = e.data.json();
      const src = json.data || json.notification || {};
      title = src.title || (json.notification && json.notification.title) || title;
      body = src.body || (json.notification && json.notification.body) || body;
      tag = src.tag || '';
    } catch (err) {
      try { body = e.data.text() || body; } catch (e2) {}
    }
  }
  e.waitUntil(showNotif(title, body, tag));
});

// ── Notifica locale richiesta dall'app aperta ──
self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') {
    self.skipWaiting();
  }
  if (e.data && e.data.type === 'SHOW_NOTIFICATION') {
    showNotif(e.data.title, e.data.body, e.data.tag || 'hct-cal');
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
