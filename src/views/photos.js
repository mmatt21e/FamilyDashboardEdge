/**
 * Photos and Memories.
 *
 * Both read the same cached Drive listing, which is why they live together.
 * Photos is everything newest-first; Memories is the same records filtered to
 * today's date in previous years.
 */

import { el, spinner, emptyState, toast, formatDate } from '../ui.js';
import { interpretDriveFailure } from '../diagnose.js';
import { state, update, subscribe, filesAreStale } from '../store.js';
import * as fb from '../firebase.js';
import { listSharedMedia, fetchFileBlobUrl, refreshThumbnailLink, uploadFile, forgetDriveAccess } from '../drive.js';
import { toPointerRecord, sortByTakenDesc, formatSize, KIND } from '../files.js';
import { dayKeysForToday, groupByYearsAgo, emptyMemoryPrompt } from '../memories.js';

/**
 * Loads the shared folder into the store.
 *
 * Two stages, because the brief asks for the open-moment to feel instant and
 * listing Drive takes seconds on a phone:
 *
 *   1. paint immediately from the pointer records in Firestore
 *   2. then scan Drive and reconcile
 *
 * Drive stays the source of truth for what exists - PhotoSync adds files
 * without this app knowing - but Firestore is what makes opening the app fast,
 * and it is where captions and comments will hang off a photo later.
 */
let inFlight = null;

export async function loadFiles({ force = false } = {}) {
  // Photos and Memories both call this. Returning early while another call was
  // running left the second view watching a spinner nothing would ever clear,
  // so concurrent callers now await the SAME load instead.
  if (inFlight) return inFlight;
  if (!force && !filesAreStale() && state.files.length) return;

  inFlight = doLoad();
  try { await inFlight; } finally { inFlight = null; }
}

async function doLoad() {
  // Set synchronously, before any await: the view draws the moment it opens,
  // and this flag is the difference between a spinner and a first-time visitor
  // staring at "No photos yet" while the folder is still being read.
  update({ loadingFiles: true, fileError: null });

  // --- stage 1: the cached index -------------------------------------------
  if (!state.files.length) {
    try {
      const cached = await fb.queryDocs('files', { orderBy: ['takenAt', 'desc'], limit: 500 });
      if (cached.length) {
        // These records came from Firestore, so their ids are by definition
        // already persisted - seed the known-id set with them.
        rememberPersistedIds(cached.map((r) => r.driveId ?? r.id));
        update({ files: sortByTakenDesc(cached), driveReady: true });
        window.dispatchEvent(new CustomEvent('fd:files-changed'));
      }
    } catch {
      // No cache yet, or rules not published. Fall through to the Drive scan.
    }
  }

  // --- stage 2: reconcile against Drive ------------------------------------
  try {
    const { items, truncated } = await listSharedMedia(state.config.driveFolderId, {
      clientId: state.config.googleClientId,
    });
    const records = items
      .map(({ file, folderName }) => toPointerRecord(file, { folderName }))
      .filter(Boolean);

    update({
      files: sortByTakenDesc(records),
      filesTruncated: truncated,
      filesLoadedAt: Date.now(),
      driveReady: true,
      loadingFiles: false,
    });

    void persistNewPointers(records);
  } catch (error) {
    // Translate into something the family can act on, rather than a raw status.
    const diagnosis = interpretDriveFailure(
      { status: error?.status, body: error?.body, message: error?.message },
      { projectId: state.config?.firebase?.projectId, folderId: state.config?.driveFolderId },
    );
    update({ loadingFiles: false, fileError: diagnosis });
  }
}

/**
 * Writes pointer records for files Firestore has not seen before.
 *
 * Only *new* ones, and capped per run. A first sync can drop tens of thousands
 * of photos into the folder, and writing all of them would burn through the
 * Firestore free tier in one go for no benefit - the grid is already rendered
 * from the Drive scan by this point. The backlog fills in over subsequent
 * opens, and nothing breaks while it does.
 *
 * "Already in Firestore" is tracked in a device-local id set rather than
 * re-queried: reading a thousand documents on every open just to learn their
 * ids was the app's single biggest Firestore cost, and once the collection
 * outgrew that query the same records were re-written on every open, forever.
 * The set is seeded from the stage-1 cache (records that came *from*
 * Firestore) and extended with every id this device writes. Ids another
 * device wrote that this one has not seen just mean one redundant merge
 * write here - harmless, and the set converges.
 */
const MAX_WRITES_PER_RUN = 200;
const PERSISTED_IDS_KEY = 'fd.files.persisted.v1';
const PERSISTED_IDS_MAX = 20_000;

function readPersistedIds() {
  try { return new Set(JSON.parse(localStorage.getItem(PERSISTED_IDS_KEY) ?? '[]')); }
  catch { return new Set(); }
}

function rememberPersistedIds(ids) {
  try {
    const set = readPersistedIds();
    for (const id of ids) if (id) set.add(id);
    // Insertion order makes slice(-max) keep the newest-remembered ids.
    localStorage.setItem(PERSISTED_IDS_KEY, JSON.stringify([...set].slice(-PERSISTED_IDS_MAX)));
  } catch { /* storage full or unavailable; worst case is a redundant write later */ }
}

async function persistNewPointers(records) {
  try {
    const known = readPersistedIds();
    const fresh = records.filter((r) => !known.has(r.driveId)).slice(0, MAX_WRITES_PER_RUN);
    if (!fresh.length) return;

    // Keyed on the Drive id so a re-scan updates in place rather than
    // creating a second record for the same photo.
    await fb.setDocsBatch('files', fresh.map((r) => ({ id: r.driveId, data: r })));
    rememberPersistedIds(fresh.map((r) => r.driveId));
  } catch {
    // Never let a caching failure break the photo grid; it is only an index.
  }
}

/**
 * Shown when Drive cannot be read. Names the missing setting and links to the
 * page that fixes it, rather than reporting a status code.
 */
function driveProblem(diagnosis, onRetry) {
  const retry = el('button', { class: 'btn btn--primary', onClick: onRetry }, 'Try again');

  return el('div', { class: 'empty' },
    el('div', { class: 'empty__icon' }, '🔧'),
    el('h2', {}, diagnosis.title ?? 'Could not read the shared folder'),
    el('p', {}, diagnosis.detail ?? ''),
    diagnosis.fix && el('div', { class: 'card' },
      el('h2', {}, 'How to fix it'),
      el('p', {}, diagnosis.fix),
      diagnosis.url && el('a', { class: 'btn', href: diagnosis.url, target: '_blank', rel: 'noopener' },
        'Open the Google console'),
    ),
    el('div', { class: 'row' }, retry),
  );
}

/**
 * Thumbnails come from Drive's own thumbnailLink - it is already resized, so a
 * phone is not downloading full-size photos to draw a grid.
 *
 * When the link is missing or expired, the first resort is asking Drive for a
 * fresh link: a tiny metadata call. Only a photo that still has no link falls
 * back to downloading the original as a blob. A video never does - "the
 * original" is the entire video, downloaded into an <img> that cannot show it.
 */
function thumbnail(record) {
  const img = el('img', {
    class: 'tile__img', loading: 'lazy', decoding: 'async',
    alt: record.name ?? 'Photo',
  });

  const lastResort = () => {
    if (record.kind === KIND.VIDEO) {
      img.replaceWith(el('div', { class: 'tile__missing' }, '🎬'));
    } else {
      void loadBlobInto(img, record);
    }
  };

  const refresh = async () => {
    try {
      const fresh = await refreshThumbnailLink(record.driveId, { clientId: state.config.googleClientId });
      if (fresh && fresh !== record.thumbnailUrl) {
        record.thumbnailUrl = fresh; // so the viewer benefits from the refresh too
        img.addEventListener('error', lastResort, { once: true });
        img.src = fresh;
        return;
      }
    } catch { /* fall through to the last resort */ }
    lastResort();
  };

  if (record.thumbnailUrl) {
    img.addEventListener('error', () => { void refresh(); }, { once: true });
    img.src = record.thumbnailUrl;
  } else {
    void refresh();
  }
  return img;
}

async function loadBlobInto(img, record) {
  try {
    const url = await fetchFileBlobUrl(record.driveId, { clientId: state.config.googleClientId });
    // Once the image has loaded (or failed), the object URL has done its job.
    // Left alive, every blob-backed tile pins its full-size bytes in memory
    // for the life of the page - a browse through a big grid used to
    // accumulate until the tab fell over.
    const done = () => URL.revokeObjectURL(url);
    img.addEventListener('load', done, { once: true });
    img.addEventListener('error', done, { once: true });
    img.src = url;
  } catch {
    img.replaceWith(el('div', { class: 'tile__missing' }, '🖼️'));
  }
}

/**
 * The grid, rendered in chunks as the user scrolls.
 *
 * Building a tile per record up front meant an archive of thousands became
 * thousands of DOM nodes on first paint - loading="lazy" spares the network,
 * but not layout or memory on a phone. A sentinel below the grid appends the
 * next chunk well before it scrolls into view, so the DOM stays proportional
 * to what has been looked at.
 */
const GRID_CHUNK = 60;

function mediaGrid(records, onOpen) {
  const grid = el('div', { class: 'grid' });
  const sentinel = el('div');
  let rendered = 0;

  const appendChunk = () => {
    const next = records.slice(rendered, rendered + GRID_CHUNK);
    rendered += next.length;
    grid.append(...next.map((record) => tile(record, onOpen)));
    if (rendered >= records.length) {
      observer.disconnect();
      sentinel.remove();
    }
  };

  const observer = new IntersectionObserver(
    (entries) => { if (entries.some((entry) => entry.isIntersecting)) appendChunk(); },
    { rootMargin: '1200px' }, // start building roughly two screens ahead
  );

  appendChunk();
  observer.observe(sentinel);
  return el('div', {}, grid, sentinel);
}

function tile(record, onOpen) {
  const node = el('button', { class: 'tile', type: 'button', 'aria-label': record.name },
    thumbnail(record),
    record.kind === KIND.VIDEO && el('span', { class: 'tile__badge' }, '▶'),
  );
  node.addEventListener('click', () => onOpen(record));
  return node;
}

/**
 * Full-screen viewer. Tap anywhere or press Escape to close.
 *
 * A video gets a real <video> element - it used to get an <img> showing its
 * thumbnail still, so videos could be browsed but never watched. Drive will
 * only hand the bytes to a fetch carrying the token, so the whole file
 * downloads before playback; fine for phone clips, and the thumbnail serves
 * as the poster while it does.
 */
function openViewer(record) {
  const isVideo = record.kind === KIND.VIDEO;
  const media = isVideo
    ? el('video', {
        class: 'viewer__img', controls: true, playsinline: true,
        poster: record.thumbnailUrl ?? null, 'aria-label': record.name,
      })
    : el('img', { class: 'viewer__img', alt: record.name });

  const note = el('div', { class: 'muted small' });
  const overlay = el('div', { class: 'viewer', role: 'dialog', 'aria-modal': 'true' },
    el('button', { class: 'viewer__close', 'aria-label': 'Close' }, '✕'),
    media,
    el('div', { class: 'viewer__meta' },
      el('div', {}, record.name),
      note,
      el('div', { class: 'muted small' },
        [record.takenAt ? formatDate(record.takenAt) : 'Date unknown', record.owner].filter(Boolean).join(' · ')),
    ),
  );

  // Whatever came through fetch is held as an object URL, revoked on close so
  // a browse does not accumulate every photo and video it opened in memory.
  let objectUrl = null;

  const showBlob = async () => {
    objectUrl = await fetchFileBlobUrl(record.driveId, { clientId: state.config.googleClientId });
    media.src = objectUrl;
  };
  const failed = () => media.replaceWith(el('p', { class: 'error-text' }, 'Could not open this file.'));

  void (async () => {
    try {
      if (isVideo) {
        note.textContent = `Loading video${record.size ? ` (${formatSize(record.size)})` : ''}…`;
        await showBlob();
        note.textContent = '';
      } else {
        const scaled = record.thumbnailUrl?.replace(/=s\d+/, '=s1600');
        if (scaled) {
          // An expired link falls back to the original, not to a broken image.
          media.addEventListener('error', () => { showBlob().catch(failed); }, { once: true });
          media.src = scaled;
        } else {
          await showBlob();
        }
      }
    } catch {
      failed();
    }
  })();

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  };
  const onKey = (event) => { if (event.key === 'Escape') close(); };

  // Tap anywhere closes an image; a video's controls have to stay tappable.
  if (isVideo) media.addEventListener('click', (event) => event.stopPropagation());
  overlay.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
}

function uploadButton() {
  const input = el('input', { type: 'file', accept: 'image/*,video/*', multiple: true, hidden: true });
  const button = el('button', { class: 'btn btn--primary' }, 'Add photos');
  const progress = el('div', { class: 'muted small' });

  button.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const files = [...input.files];
    input.value = '';
    if (!files.length) return;

    button.disabled = true;
    let done = 0;
    for (const file of files) {
      try {
        progress.textContent = `Uploading ${done + 1} of ${files.length}…`;
        await uploadFile(file, {
          folderId: state.config.driveFolderId,
          clientId: state.config.googleClientId,
          onProgress: (fraction) => {
            progress.textContent = `Uploading ${done + 1} of ${files.length} — ${Math.round(fraction * 100)}%`;
          },
        });
        done += 1;
      } catch (error) {
        toast(error?.message ?? 'Upload failed', { error: true });
      }
    }
    progress.textContent = '';
    button.disabled = false;
    if (done) {
      toast(`Added ${done} ${done === 1 ? 'item' : 'items'}`);
      await loadFiles({ force: true });
      window.dispatchEvent(new CustomEvent('fd:files-changed'));
    }
  });

  return el('div', { class: 'row' }, button, input, progress);
}

export async function photosView() {
  const container = el('div', { class: 'view' });

  const draw = () => {
    if (state.loadingFiles && !state.files.length) {
      return container.replaceChildren(spinner('Loading photos…'));
    }
    if (state.fileError) {
      return container.replaceChildren(driveProblem(state.fileError, async () => {
        forgetDriveAccess();
        await loadFiles({ force: true });
        draw();
      }));
    }

    const media = state.files.filter((f) => f.kind === KIND.PHOTO || f.kind === KIND.VIDEO);
    container.replaceChildren(
      el('header', { class: 'view__header' },
        el('h1', {}, 'Photos'),
        el('span', { class: 'muted small' },
          state.filesTruncated
            ? `Newest ${media.length} — the folder holds more`
            : `${media.length} in the shared folder`),
      ),
      uploadButton(),
      media.length === 0
        ? emptyState('📷', 'No photos yet',
            'Once PhotoSync is set up on a phone, photos appear here on their own. You can also add some directly.')
        : mediaGrid(media, openViewer),
    );
  };

  // Repaint on every store change. Stage 1 of loadFiles puts the cached index
  // into the store within a beat; without this the view sat unchanged until
  // the whole Drive scan finished, so the fast path existed but never drew.
  const unsubscribe = subscribe(draw);
  container.addEventListener('fd:teardown', () => unsubscribe(), { once: true });

  draw();
  await loadFiles();
  draw();
  return container;
}

export async function memoriesView() {
  const container = el('div', { class: 'view' });

  const draw = () => {
    if (state.loadingFiles && !state.files.length) {
      return container.replaceChildren(spinner('Looking for memories…'));
    }

    const today = new Date();
    const keys = new Set(dayKeysForToday(today));
    const onThisDay = state.files.filter((f) => f.dayKey && keys.has(f.dayKey));
    const groups = groupByYearsAgo(onThisDay, today);

    container.replaceChildren(
      el('header', { class: 'view__header' },
        el('h1', {}, 'Memories'),
        el('span', { class: 'muted small' },
          today.toLocaleDateString(undefined, { day: 'numeric', month: 'long' })),
      ),
      groups.length === 0
        ? emptyState('🕰️', 'Nothing from today yet', emptyMemoryPrompt(state.files.length > 0))
        : el('div', {}, groups.map((group) =>
            el('section', { class: 'memory-group' },
              el('h2', { class: 'memory-group__title' },
                group.label,
                el('span', { class: 'muted small' }, ` · ${group.year}`)),
              el('div', { class: 'grid' }, group.items.map((record) => tile(record, openViewer))),
            ))),
    );
  };

  // Same immediate repaint from the cached index as the Photos view.
  const unsubscribe = subscribe(draw);
  container.addEventListener('fd:teardown', () => unsubscribe(), { once: true });

  draw();
  await loadFiles();
  draw();
  return container;
}
