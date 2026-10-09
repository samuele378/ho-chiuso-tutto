// Non più usato: dalla v7.1 le push arrivano direttamente a sw.js (un solo service worker,
// necessario per iPhone). Il file resta solo per compatibilità con installazioni vecchie:
// l'app lo disinstalla da sola al primo avvio.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.registration.unregister()));
