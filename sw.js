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

const CACHE_VERSION = 'v16';

// Replaced at deploy time (see .github/workflows/deploy.yml), so every deploy
// gets a cache of its own automatically. Relying on a hand-bumped version
// meant that forgetting to bump it left phones serving the previous release
// from cache with nothing on screen to say so.
const BUILD_SHA = '__BUILD_SHA__';

const CACHE = `family-dashboard-${CACHE_VERSION}-${BUILD_SHA}`;

// The Firebase SDK from gstatic: public, immutable code under a versioned URL,
// so unlike every other cross-origin request it is safe to cache - and it is
// the boot path's single biggest download. Kept in its own cache because the
// URLs are version-stamped and never go stale, so it must survive the
// per-deploy shell cache turnover.
const SDK_CACHE = 'family-dashboard-sdk-v1';

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
  './src/folders.js',
  './src/gmail.js',
  './src/install.js',
  './src/invites.js',
  './src/local-cache.js',
  './src/memories.js',
  './src/modules.js',
  './src/notifications.js',
  './src/photo-edits.js',
  './src/photo-filter.js',
  './src/router.js',
  './src/store.js',
  './src/thumbs.js',
  './src/ui.js',
  './src/update.js',
  './src/version.js',
  './src/views/feed.js',
  './src/views/import-tags.js',
  './src/views/folders-card.js',
  './src/views/install-card.js',
  './src/views/invite.js',
  './src/views/photo-editor.js',
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
        keys.filter((k) => k !== CACHE && k !== SDK_CACHE).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

// Settings' "Check for updates" sends this. Without it a newly installed
// worker waits for every tab to close, which for an app that lives on a home
// screen can be days.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

// ---------------------------------------------------------------------------
// Streaming video from Drive
// ---------------------------------------------------------------------------
// A <video> element cannot attach an Authorization header, which is why videos
// used to be downloaded whole as blobs before playing - unusable past a size
// cap, and a 2003 camcorder tape is half a gigabyte. So the video element asks
// for a same-origin URL, ./drive-media/<id>, and this worker plays proxy: it
// forwards each byte-range request to Drive with the token attached and
// streams the answer straight back. The browser then does what it does with
// any ordinary video file - progressive playback, seeking, no full download.
//
// The token reaches the worker through IndexedDB, written by the page whenever
// it obtains one (drive.js). Not memory: a worker is killed and restarted
// constantly, and a variable would be gone by the second range request.

const DB_NAME = 'family-dashboard';
const KV_STORE = 'kv';

function readDriveToken() {
  return new Promise((resolve) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(KV_STORE);
    open.onerror = () => resolve(null);
    open.onsuccess = () => {
      try {
        const get = open.result.transaction(KV_STORE, 'readonly').objectStore(KV_STORE).get('drive-token');
        get.onsuccess = () => {
          const saved = get.result;
          resolve(saved?.token && saved.expiry > Date.now() ? saved.token : null);
        };
        get.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    };
  });
}

async function streamDriveMedia(request, fileId) {
  const token = await readDriveToken();
  if (!fileId || !token) {
    // 401 tells the page precisely what went wrong: refresh the token and ask
    // again. Anything vaguer turns into "the video just doesn't work".
    return new Response('', { status: 401, headers: { 'x-fd-media': 'no-token' } });
  }

  const headers = { Authorization: `Bearer ${token}` };
  const range = request.headers.get('range');
  if (range) headers.Range = range;

  try {
    const upstream = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
      { headers },
    );
    // Pass the streaming body straight through with the headers seeking needs.
    const passed = new Headers({ 'x-fd-media': 'stream' });
    for (const name of ['content-type', 'content-length', 'content-range']) {
      const value = upstream.headers.get(name);
      if (value) passed.set(name, value);
    }
    passed.set('accept-ranges', 'bytes');
    return new Response(upstream.body, { status: upstream.status, headers: passed });
  } catch {
    return new Response('', { status: 502, headers: { 'x-fd-media': 'upstream-failed' } });
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const mediaMatch = /\/drive-media\/([^/?]+)/.exec(new URL(request.url).pathname);
  if (mediaMatch) {
    event.respondWith(streamDriveMedia(request, decodeURIComponent(mediaMatch[1])));
    return;
  }

  // "What is live right now?" probes must reach the server. Answering them
  // from a cache would make the update check agree with itself forever.
  if (request.cache === 'no-store') return;

  const url = new URL(request.url);

  // The versioned Firebase SDK - see SDK_CACHE above. Cache-first: the URL is
  // immutable, so a hit can never be stale, and the boot's biggest download
  // becomes local from the second open.
  if (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) {
    event.respondWith(
      caches.open(SDK_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) void cache.put(request, response.clone());
        return response;
      }),
    );
    return;
  }

  // Never touch anything else cross-origin: Firebase's backends, Drive and
  // Google sign-in must always go to the network, and caching an
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
