/**
 * Thumbnails, cached on the device.
 *
 * The listing snapshot made the GRID paint instantly, and that turned out not
 * to be the complaint. The tiles are only frames: every image inside them was
 * still a network fetch against Drive's thumbnail servers, and on a first
 * open after the links had expired, the fallback ladder made every tile wait
 * for the whole folder scan before showing anything. The structure appeared
 * in milliseconds; the photos took as long as the scan. "Photos still lag on
 * first load" is exactly right.
 *
 * So the bytes are cached too. A thumbnail is a few tens of kilobytes and a
 * photo's thumbnail never changes, which makes it the perfect thing to keep:
 * once a tile has been seen once, every later open paints it straight from
 * IndexedDB with no network at all.
 *
 * Getting the bytes requires fetch() rather than an <img>, because an image
 * element's pixels are not readable cross-origin. Drive's thumbnail host
 * serves CORS headers, so this works; when it does not - a proxy, an odd
 * response - the caller falls back to a plain <img>, which still displays
 * but cannot be cached. Showing beats caching.
 */

import { cacheGet, cacheSet, cacheDelete } from './local-cache.js';

/** Session-lifetime object URLs. Bounded by the prune cap below. */
const inMemory = new Map();

const KEY_PREFIX = 'thumb:';
const INDEX_KEY = 'thumb-index';

// ~2000 thumbnails at a few tens of KB is well within what a phone grants an
// installed app, and covers several screens of every year of an archive.
const MAX_CACHED = 2000;
const PRUNE_BATCH = 200;
// Anything bigger is not a thumbnail; do not let one bad response eat quota.
const MAX_BYTES_EACH = 300_000;

/** Instantly known, no awaiting: the tile can paint synchronously. */
export function knownThumb(driveId) {
  return inMemory.get(driveId) ?? null;
}

/**
 * Replaces an in-memory entry, revoking the object URL it displaces. Without
 * the revoke, every replaced or pruned entry kept its decoded bytes alive in
 * the browser for the life of the page - the map was bounded, the memory
 * behind it was not.
 */
function remember(driveId, url) {
  const previous = inMemory.get(driveId);
  if (previous && previous !== url) URL.revokeObjectURL(previous);
  inMemory.set(driveId, url);
}

/** The device's copy, if a previous session stored one. */
export async function thumbFromDisk(driveId) {
  const known = inMemory.get(driveId);
  if (known) return known;

  const blob = await cacheGet(KEY_PREFIX + driveId);
  if (!(blob instanceof Blob) || !blob.size) return null;

  const url = URL.createObjectURL(blob);
  remember(driveId, url);
  return url;
}

// A small pool, so a screenful of uncached tiles does not open a hundred
// connections at once. Thumbnails are small; eight keeps a phone busy without
// starving the scan running alongside.
const FETCH_LIMIT = 8;
const queue = [];
let active = 0;

function limited(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    pump();
  });
}

function pump() {
  while (active < FETCH_LIMIT && queue.length) {
    const { task, resolve, reject } = queue.shift();
    active += 1;
    task().then(resolve, reject).finally(() => { active -= 1; pump(); });
  }
}

/**
 * Fetches a thumbnail's bytes, caches them, returns an object URL.
 * Returns null when the bytes cannot be had - dead link, no CORS - and the
 * caller should fall back to a plain <img>.
 */
export async function fetchAndCacheThumb(driveId, thumbnailUrl) {
  if (!thumbnailUrl) return null;
  try {
    const blob = await limited(async () => {
      const response = await fetch(thumbnailUrl, { mode: 'cors' });
      if (!response.ok) throw new Error(String(response.status));
      return response.blob();
    });

    const url = URL.createObjectURL(blob);
    remember(driveId, url);
    if (blob.size <= MAX_BYTES_EACH) void persist(driveId, blob);
    return url;
  } catch {
    return null;
  }
}

/**
 * Writes are chained, not parallel: the prune index is read-modify-write, and
 * fifty concurrent writers would each read the same index and lose each
 * other's entries - the cache would then grow without ever pruning.
 */
let persistChain = Promise.resolve();

function persist(driveId, blob) {
  persistChain = persistChain.then(async () => {
    await cacheSet(KEY_PREFIX + driveId, blob);

    let index = (await cacheGet(INDEX_KEY)) ?? [];
    // Deduplicate on re-persist, or the index inflates with repeats and the
    // prune below evicts live thumbnails while the duplicates survive.
    if (index.includes(driveId)) index = index.filter((id) => id !== driveId);
    index.push(driveId);
    if (index.length > MAX_CACHED) {
      for (const stale of index.splice(0, PRUNE_BATCH)) {
        await cacheDelete(KEY_PREFIX + stale);
        const url = inMemory.get(stale);
        if (url) URL.revokeObjectURL(url);
        inMemory.delete(stale);
      }
    }
    await cacheSet(INDEX_KEY, index);
  }).catch(() => { /* a failed write costs a refetch, nothing more */ });
  return persistChain;
}
