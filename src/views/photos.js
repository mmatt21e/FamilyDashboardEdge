/**
 * Photos and Memories.
 *
 * Both read the same cached Drive listing, which is why they live together.
 * Photos is everything newest-first; Memories is the same records filtered to
 * today's date in previous years.
 */

import { el, spinner, emptyState, errorState, toast, formatDate } from '../ui.js';
import { state, update, filesAreStale } from '../store.js';
import { listSharedMedia, fetchFileBlobUrl, uploadFile, forgetDriveAccess } from '../drive.js';
import { toPointerRecord, sortByTakenDesc, KIND } from '../files.js';
import { dayKeysForToday, groupByYearsAgo, emptyMemoryPrompt } from '../memories.js';

/**
 * Loads the shared folder into the store.
 *
 * Drive is the source of truth for what exists, because PhotoSync adds files
 * without this app knowing. Firestore pointer records are a cache and a place
 * to hang captions, not the inventory.
 */
export async function loadFiles({ force = false } = {}) {
  if (state.loadingFiles) return;
  if (!force && !filesAreStale() && state.files.length) return;

  update({ loadingFiles: true, fileError: null });
  try {
    const raw = await listSharedMedia(state.config.driveFolderId, {
      clientId: state.config.googleClientId,
    });
    const records = raw
      .map(({ file, folderName }) => toPointerRecord(file, { folderName }))
      .filter(Boolean);

    update({
      files: sortByTakenDesc(records),
      filesLoadedAt: Date.now(),
      driveReady: true,
      loadingFiles: false,
    });
  } catch (error) {
    update({ loadingFiles: false, fileError: error?.message ?? 'Could not read the shared folder.' });
  }
}

/**
 * Thumbnails come from Drive's own thumbnailLink where possible - it is already
 * resized, so a phone is not downloading full-size photos to draw a grid. When
 * it is missing the full file is fetched as a blob instead, which is slower but
 * always works.
 */
function thumbnail(record) {
  const img = el('img', {
    class: 'tile__img', loading: 'lazy', decoding: 'async',
    alt: record.name ?? 'Photo',
  });

  if (record.thumbnailUrl) {
    img.src = record.thumbnailUrl;
    // Drive thumbnail links expire; fall back rather than showing a broken image.
    img.addEventListener('error', () => { void loadBlobInto(img, record); }, { once: true });
  } else {
    void loadBlobInto(img, record);
  }
  return img;
}

async function loadBlobInto(img, record) {
  try {
    img.src = await fetchFileBlobUrl(record.driveId, { clientId: state.config.googleClientId });
  } catch {
    img.replaceWith(el('div', { class: 'tile__missing' }, '🖼️'));
  }
}

function tile(record, onOpen) {
  const node = el('button', { class: 'tile', type: 'button', 'aria-label': record.name },
    thumbnail(record),
    record.kind === KIND.VIDEO && el('span', { class: 'tile__badge' }, '▶'),
  );
  node.addEventListener('click', () => onOpen(record));
  return node;
}

/** Full-screen viewer. Kept simple: tap anywhere or press Escape to close. */
function openViewer(record) {
  const img = el('img', { class: 'viewer__img', alt: record.name });
  const overlay = el('div', { class: 'viewer', role: 'dialog', 'aria-modal': 'true' },
    el('button', { class: 'viewer__close', 'aria-label': 'Close' }, '✕'),
    img,
    el('div', { class: 'viewer__meta' },
      el('div', {}, record.name),
      el('div', { class: 'muted small' },
        [record.takenAt ? formatDate(record.takenAt) : 'Date unknown', record.owner].filter(Boolean).join(' · ')),
    ),
  );

  void (async () => {
    try {
      img.src = record.thumbnailUrl?.replace(/=s\d+/, '=s1600')
        ?? await fetchFileBlobUrl(record.driveId, { clientId: state.config.googleClientId });
    } catch {
      img.replaceWith(el('p', { class: 'error-text' }, 'Could not open this file.'));
    }
  })();

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (event) => { if (event.key === 'Escape') close(); };

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
      return container.replaceChildren(errorState(state.fileError, async () => {
        forgetDriveAccess();
        await loadFiles({ force: true });
        draw();
      }));
    }

    const media = state.files.filter((f) => f.kind === KIND.PHOTO || f.kind === KIND.VIDEO);
    container.replaceChildren(
      el('header', { class: 'view__header' },
        el('h1', {}, 'Photos'),
        el('span', { class: 'muted small' }, `${media.length} in the shared folder`),
      ),
      uploadButton(),
      media.length === 0
        ? emptyState('📷', 'No photos yet',
            'Once PhotoSync is set up on a phone, photos appear here on their own. You can also add some directly.')
        : el('div', { class: 'grid' }, media.map((record) => tile(record, openViewer))),
    );
  };

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

  draw();
  await loadFiles();
  draw();
  return container;
}
