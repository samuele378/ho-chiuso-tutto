// Firebase Cloud Messaging Service Worker
// This handles background push messages when the app is closed

importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyC4NhFhecAHV_f6dysOjwPifqj27OJLkRw",
  authDomain: "calendario-e26e8.firebaseapp.com",
  databaseURL: "https://calendario-e26e8-default-rtdb.firebaseio.com",
  projectId: "calendario-e26e8",
  storageBucket: "calendario-e26e8.firebasestorage.app",
  messagingSenderId: "366489891138",
  appId: "1:366489891138:web:3dd4b6339500ffba3bd8db"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(payload => {
  const title = (payload.data && payload.data.title) || (payload.notification && payload.notification.title) || 'Ho Chiuso Tutto?';
  const body = (payload.data && payload.data.body) || (payload.notification && payload.notification.body) || 'Hai un impegno!';

  return self.registration.showNotification(title, {
    body: body,
    icon: './icon-192.png',
    badge: './icon-192.png',
    vibrate: [300, 100, 300, 100, 300],
    tag: 'hct-fcm-' + Date.now(),
    requireInteraction: true,
    data: { url: './' }
  });
});
