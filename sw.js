// Bump VERSION on every release so installed copies pick up the new files.
const VERSION = 'holdem-v2';
const FILES = [
  './',
  'index.html',
  'style.css',
  'manifest.webmanifest',
  'js/ui.js',
  'js/session.js',
  'js/engine.js',
  'js/evaluator.js',
  'js/bot.js',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true })
      .then((cached) => cached || fetch(event.request)),
  );
});
