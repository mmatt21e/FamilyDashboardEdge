/**
 * Service worker.
 *
 * Caches the app shell so opening from the home screen is instant and works
 * with no signal. It deliberately does NOT cache data: Firebase and Drive
 * responses are personal, change constantly, and a stale photo grid is worse
 * than a spinner. The brief asks for the open-moment to feel instant, which is
 * about the shell, not the data.
 *
 * Bump CACHE_VERSION whenever the shell changes.
 */

const CACHE_VERSION = 'v6';
const CACHE = `family-dashboard-${CACHE_VERSION}`;

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './styles/app.css',
  './src/app.js',
  './src/catalog.js',
  './src/catalog-store.js',
  './src/config.js',
  './src/diagnose.js',
  './src/drive.js',
  './src/files.js',
  './src/firebase.js',
  './src/memories.js',
  './src/modules.js',
  './src/notifications.js',
  './src/photo-filter.js',
  './src/router.js',
  './src/store.js',
  './src/ui.js',
  './src/views/feed.js',
  './src/views/import-tags.js',
  './src/views/notifications-card.js',
  './src/views/onboarding.js',
  './src/views/photos.js',
  './src/views/settings.js',
  './src/views/setup.js',
  './assets/icon.svg',
  './assets/icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // Individually, so one 404 during development does not fail the whole
      // install and leave the app with no cache at all.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never touch anything cross-origin: Firebase, Drive, Google sign-in and the
  // Firebase SDK on gstatic must always go to the network, and caching an
  // authenticated response would be a genuine privacy problem.
  if (url.origin !== self.location.origin) return;

  // Navigations: network first so a deployed update is picked up, falling back
  // to the cached shell when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put('./index.html', copy));
          return response;
        })
        .catch(() => caches.match('./index.html').then((r) => r ?? Response.error())),
    );
    return;
  }

  // Everything else in the shell: cache first, refreshing in the background so
  // the next open has the newer copy.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached ?? Response.error());
      return cached ?? network;
    }),
  );
});
