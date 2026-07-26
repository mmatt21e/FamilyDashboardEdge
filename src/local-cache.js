/**
 * A small on-device cache, in IndexedDB.
 *
 * Exists for one reason: the photo listing lived only in memory, and a
 * home-screen app's memory is discarded the moment it is closed. Every fresh
 * open therefore started from nothing - catalog read, index read, Drive scan -
 * which is seconds of network before the first photo appeared, paid again
 * every time. "Slow unless it has been loaded once since the app opened" is
 * that, described from the outside.
 *
 * IndexedDB rather than localStorage because the listing is megabytes at
 * archive scale: localStorage tops out around five for the whole origin and
 * the catalog already uses part of it. Not the service worker cache, because
 * that deliberately never holds personal data; this is data, but it stays on
 * the device and never leaves.
 *
 * Plain key-value, nothing clever. Every operation swallows failure - private
 * browsing, quota, a torn database - because a cache that can break the app
 * is worse than no cache.
 */

const DB_NAME = 'family-dashboard';
const STORE = 'kv';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { dbPromise = null; reject(request.error); };
  });
  return dbPromise;
}

export async function cacheGet(key) {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function cacheSet(key, value) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Best effort. The next open just pays the network cost again.
  }
}

export async function cacheDelete(key) {
  try {
    const db = await openDb();
    await new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  } catch {
    // Already effectively deleted as far as anyone can observe.
  }
}
