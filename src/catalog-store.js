/**
 * Where the photo catalog lives.
 *
 * Firestore, in a handful of chunk documents rather than one document per
 * photo. Three thousand documents would be three thousand reads every time
 * someone opens Photos; ten chunks is ten reads. The whole catalog is a few
 * hundred kilobytes, so it is also cached in localStorage and only re-fetched
 * when the version stamp in the meta document changes - which is to say, when
 * someone runs an import.
 *
 * The meta document is written *last* on save and read *first* on load, so its
 * version can only ever name a catalog that finished writing. A half-written
 * import leaves the previous one intact.
 */

import * as fb from './firebase.js';
import { toChunks, fromChunks, summariseEntries, buildLookup } from './catalog.js';
import { isEmptyEdit } from './photo-edits.js';

const COLLECTION = 'photo_catalog';
const EDITS = 'photo_edits';
const META_ID = 'meta';
const CACHE_KEY = 'fd.catalog';

// A catalog bigger than this is not worth keeping in localStorage - the quota
// is around 5MB for the whole origin and losing the config would be far worse
// than re-reading ten documents.
const MAX_CACHE_BYTES = 2_000_000;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

let memory = null;

/**
 * Loads the catalog, preferring the local cache when it matches the stored
 * version. Returns null when no catalog has been imported yet - which is the
 * normal state for a family that has not run the face tools, and must not look
 * like an error.
 */
export async function loadCatalog({ force = false } = {}) {
  if (memory && !force) return memory;

  let meta = null;
  try {
    meta = await fb.getDoc(COLLECTION, META_ID);
  } catch {
    // Rules not published, or offline. Fall back to whatever we cached.
    const cached = readCache();
    memory = cached ? hydrate(cached) : null;
    return memory;
  }
  if (!meta?.version) return null;

  const cached = readCache();
  if (cached && cached.version === meta.version && !force) {
    memory = hydrate(cached);
    return memory;
  }

  const docs = await fb.queryDocs(COLLECTION, { limit: 500 });
  const chunks = docs
    .filter((doc) => doc.id !== META_ID && doc.entries)
    .sort((a, b) => a.id.localeCompare(b.id));

  const entries = fromChunks(chunks);
  writeCache({ version: meta.version, updatedAt: meta.updatedAt ?? null, entries });
  memory = hydrate({ version: meta.version, updatedAt: meta.updatedAt ?? null, entries });
  return memory;
}

/** The catalog already in memory, if any. Never triggers a read. */
export function cachedCatalog() {
  return memory;
}

function hydrate({ version, updatedAt, entries }) {
  return {
    version,
    updatedAt: updatedAt ?? null,
    entries,
    lookup: buildLookup(entries),
    ...summariseEntries(entries),
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Replaces the stored catalog.
 *
 * Chunks first, meta last. Any chunks left over from a larger previous import
 * are deleted afterwards, so a re-import that shrinks the catalog does not
 * leave orphaned photos behind.
 */
export async function saveCatalog(catalog, { onProgress = null, by = null, sources = null } = {}) {
  const entries = catalog?.entries ?? [];
  const chunks = toChunks(entries);
  const version = String(Date.now());

  const existing = await listChunkIds();

  await fb.writeBatched(
    chunks.map((chunk) => ({ path: COLLECTION, id: chunk.id, data: { entries: chunk.entries } })),
    (done, total) => onProgress?.({ phase: 'writing', done, total }),
  );

  const stale = existing.filter((id) => !chunks.some((chunk) => chunk.id === id));
  if (stale.length) {
    await fb.deleteBatched(COLLECTION, stale, (done, total) => onProgress?.({ phase: 'tidying', done, total }));
  }

  const summary = summariseEntries(entries);
  await fb.setDoc(COLLECTION, META_ID, {
    version,
    chunkCount: chunks.length,
    count: summary.count,
    // Kept on the meta document so the filter menus and the settings summary
    // can be drawn from a single read, before the chunks arrive.
    people: summary.people,
    events: summary.events,
    years: summary.years,
    sources: sources ?? null,
    updatedAt: new Date().toISOString(),
    updatedBy: by ?? null,
  }, { merge: false });

  writeCache({ version, updatedAt: new Date().toISOString(), entries });
  memory = hydrate({ version, updatedAt: new Date().toISOString(), entries });
  onProgress?.({ phase: 'done', done: entries.length, total: entries.length });
  return memory;
}

/** Removes the catalog entirely. Photos keep working; they just lose their tags. */
export async function clearCatalog() {
  const ids = await listChunkIds();
  if (ids.length) await fb.deleteBatched(COLLECTION, ids);
  await fb.deleteDoc(COLLECTION, META_ID).catch(() => {});
  clearCache();
  memory = null;
}

async function listChunkIds() {
  try {
    const docs = await fb.queryDocs(COLLECTION, { limit: 500 });
    return docs.filter((doc) => doc.id !== META_ID).map((doc) => doc.id);
  } catch {
    return [];
  }
}

/** Just the meta document - one read, for the settings summary. */
export async function catalogSummary() {
  try {
    return await fb.getDoc(COLLECTION, META_ID);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Corrections made by hand
// ---------------------------------------------------------------------------
// A document per corrected photo, keyed on its Drive id, in a collection of its
// own. Separate from the catalog on purpose: an import replaces the catalog
// wholesale and must never take somebody's correction with it.
//
// Not chunked, unlike the catalog, because these are written one at a time
// while looking at a photo and there will only ever be as many as the family
// bothered to fix - hundreds at the outside, against three thousand imported.

const MAX_EDITS = 2000;

let editCache = null;

/** Every correction, as a Map keyed by Drive id. */
export async function loadEdits({ force = false } = {}) {
  if (editCache && !force) return editCache;

  try {
    const docs = await fb.queryDocs(EDITS, { limit: MAX_EDITS });
    editCache = new Map(docs.map((doc) => [doc.driveId ?? doc.id, doc]));

    if (docs.length >= MAX_EDITS) {
      // Say so rather than silently showing a subset. Reaching this would mean
      // the corrections deserve their own chunked store, like the catalog.
      console.warn(`photo_edits hit the ${MAX_EDITS} document cap; some corrections are not loaded.`);
    }
  } catch {
    // Rules not published yet, or offline. No corrections is a valid state.
    editCache = editCache ?? new Map();
  }
  return editCache;
}

/** The corrections already loaded. Never triggers a read. */
export function cachedEdits() {
  return editCache ?? new Map();
}

/**
 * Saves one correction, or removes it when it no longer overrides anything -
 * which is what "reset this photo back to what was imported" does.
 */
export async function saveEdit(driveId, edit) {
  if (!driveId) return null;

  if (isEmptyEdit(edit)) {
    await deleteEdit(driveId);
    return null;
  }

  // merge: false, so unsetting a field actually unsets it. A merge write would
  // leave the old override behind and the correction would look ignored.
  await fb.setDoc(EDITS, driveId, edit, { merge: false });
  editCache = editCache ?? new Map();
  editCache.set(driveId, edit);
  return edit;
}

export async function deleteEdit(driveId) {
  try {
    await fb.deleteDoc(EDITS, driveId);
  } catch {
    // Already gone, which is the state we wanted.
  }
  editCache?.delete(driveId);
}

// ---------------------------------------------------------------------------
// Local cache
// ---------------------------------------------------------------------------

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.version && Array.isArray(parsed.entries) ? parsed : null;
  } catch {
    return null;
  }
}

function writeCache(payload) {
  try {
    const raw = JSON.stringify(payload);
    if (raw.length > MAX_CACHE_BYTES) return;
    localStorage.setItem(CACHE_KEY, raw);
  } catch {
    // Quota exceeded or private browsing. The catalog still works, it is just
    // re-read from Firestore next time.
  }
}

function clearCache() {
  try { localStorage.removeItem(CACHE_KEY); } catch { /* nothing to do */ }
}
