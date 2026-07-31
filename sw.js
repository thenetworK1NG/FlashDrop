importScripts('https://www.gstatic.com/firebasejs/10.12.4/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.4/firebase-messaging-compat.js');

firebase.initializeApp({
    apiKey: 'AIzaSyAwwm1NYa-jaKNqmJCGzKD6Blyq5VUVWuc',
    authDomain: 'share-it-414ed.firebaseapp.com',
    databaseURL: 'https://share-it-414ed-default-rtdb.firebaseio.com',
    projectId: 'share-it-414ed',
    storageBucket: 'share-it-414ed.firebasestorage.app',
    messagingSenderId: '280437631286',
    appId: '1:280437631286:web:ed636e0fa0a4c7c5d56b97'
});
const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
    const d = payload.data || {};
    const title = d.title || 'QuickShare';
    const body = d.body || '';
    self.registration.showNotification(title, {
        body: body,
        icon: 'icon-192.png',
        badge: 'icon-192.png',
        tag: 'quickshare',
        data: { url: '/' }
    });
});

self.addEventListener('notificationclick', (e) => {
    e.notification.close();
    const url = (e.notification.data && e.notification.data.url) || '/';
    e.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cl) => {
            for (const c of cl) {
                if ('focus' in c) return c.focus();
            }
            return clients.openWindow(url);
        })
    );
});

const CACHE = 'quickshare-v7';
const URLS = ['.', 'index.html', 'app.js', 'manifest.json', 'icon.svg'];

self.addEventListener('install', (e) => {
    e.waitUntil(caches.open(CACHE).then((c) => c.addAll(URLS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
    e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
    e.respondWith(
        caches.match(e.request).then((r) => r || fetch(e.request).catch(() => new Response('Offline', { status: 503 })))
    );
});
