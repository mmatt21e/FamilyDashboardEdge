/**
 * Service worker.
 *
 * Caches the app shell so opening from the home screen is instant and works
 * with no signal. It deliberately does NOT cache app data - Firebase and Drive
 * responses are personal, change constantly, and a stale photo grid is worse
 * than a spinner - with one deliberate exception: photo thumbnails, below.
 *
 * Bump CACHE_VERSION whenever the shell changes.
 */

const CACHE_VERSION = 'v6';
const CACHE = `family-dashboard-${CACHE_VERSION}`;

/**
 * Drive photo thumbnails, cache-first and bounded.
 *
 * The grid re-requests the same tiles on every open, and Drive's thumbnail
 * links expire, so without this every visit re-downloaded every visible
 * thumbnail. The pixels behind a given path never change, so cache-first is
 * safe. Thumbnails are personal data; they live in this device's browser
 * profile, which already holds the signed-in session itself - a conscious
 * trade of a little local storage for a grid that paints instantly.
 *
 * Keys strip the query string but keep the path (including its "=s..." size
 * suffix), so a re-signed URL for the same image still hits. Responses to
 * no-cors <img> requests are opaque and cannot be inspected, which means an
 * error can slip into the cache - photos.js deletes entries it sees fail,
 * using this same key scheme.
 */
const THUMB_CACHE = 'family-dashboard-thumbs-v1';
const THUMB_LIMIT = 600;

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './styles/app.css',
  './src/app.js',
  './src/config.js',
  './src/diagnose.js',
  './src/drive.js',
  './src/files.js',
  './src/firebase.js',
  './src/memories.js',
  './src/modules.js',
  './src/notifications.js',
  './src/router.js',
  './src/store.js',
  './src/ui.js',
  './src/views/feed.js',
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
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE && k !== THUMB_CACHE).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

async function thumbnailFromCache(request, url) {
  const cache = await caches.open(THUMB_CACHE);
  const key = url.origin + url.pathname;

  const cached = await cache.match(key);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok || response.type === 'opaque') {
    await cache.put(key, response.clone());
    void trimThumbnails(cache);
  }
  return response;
}

/** Oldest entries first - Cache API keys keep insertion order. */
async function trimThumbnails(cache) {
  const keys = await cache.keys();
  const excess = keys.length - THUMB_LIMIT;
  for (const key of keys.slice(0, Math.max(0, excess))) await cache.delete(key);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Drive photo thumbnails - see THUMB_CACHE above.
  if (request.destination === 'image' && url.hostname.endsWith('.googleusercontent.com')) {
    event.respondWith(thumbnailFromCache(request, url));
    return;
  }

  // Never touch anything else cross-origin: Firebase, Drive, Google sign-in
  // and the Firebase SDK on gstatic must always go to the network, and caching
  // an authenticated response would be a genuine privacy problem.
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
