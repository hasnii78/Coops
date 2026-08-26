/* eslint-env serviceworker */
/* global importScripts, firebase */

/**
 * Background message handler for Firebase Cloud Messaging.
 *
 * This file must live at the web root and cannot use module imports or
 * Vite environment variables — the browser loads it directly, outside the
 * bundle. The config values below are public client identifiers (the same
 * ones shipped in any Firebase web app); they are not secrets.
 *
 * REPLACE these placeholders with your project's values before deploying.
 */
importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'REPLACE_ME',
  authDomain: 'REPLACE_ME.firebaseapp.com',
  projectId: 'REPLACE_ME',
  storageBucket: 'REPLACE_ME.appspot.com',
  messagingSenderId: 'REPLACE_ME',
  appId: 'REPLACE_ME',
});

firebase.messaging().onBackgroundMessage((payload) => {
  const { title, body } = payload.notification || {};
  self.registration.showNotification(title || 'Pink Wardrobe', {
    body: body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: payload.data,
  });
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow('/inbox'));
});
