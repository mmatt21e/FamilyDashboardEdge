/**
 * Photos and Memories.
 *
 * Both read the same cached Drive listing, which is why they live together.
 * Photos is everything newest-first with a filter bar over it; Memories is the
 * same records filtered to today's date in previous years.
 */

import { el, spinner, emptyState, toast, formatDate, children } from '../ui.js';
import { interpretDriveFailure } from '../diagnose.js';
import { state, update, filesAreStale } from '../store.js';
import * as fb from '../firebase.js';
import { listSharedMedia, fetchFileBlobUrl, uploadFile, forgetDriveAccess } from '../drive.js';
import { toPointerRecord, sortByTakenDesc, KIND } from '../files.js';
import { dayKeysForToday, groupByYearsAgo, emptyMemoryPrompt } from '../memories.js';
import { applyCatalog } from '../catalog.js';
import { loadCatalog, loadEdits, cachedEdits, saveEdit, deleteEdit } from '../catalog-store.js';
import { applyEdits, buildEdit, editedFields } from '../photo-edits.js';
import { openTagSheet } from './photo-editor.js';
import {
  emptyFilters, filterPhotos, buildFacets, describeFilters,
  clearFilter, describeCount, toggleValue, PEOPLE_MODE,
} from '../photo-filter.js';

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

/**
 * The photo tags, if the family has imported any.
 *
 * Fetched alongside the file listing rather than on demand, because the tags
 * are what the filter bar is built from and a grid that grows filters a second
 * later feels broken. Missing tags are the normal state, not an error.
 */
async function ensureCatalog() {
  if (state.catalog) return state.catalog;
  try {
    const catalog = await loadCatalog();
    if (catalog) update({ catalog });
    return catalog;
  } catch {
    return null;
  }
}

/**
 * The listing with the catalog applied but *not* the hand corrections.
 *
 * Kept so a correction can be re-applied without re-listing Drive: corrections
 * change while you are looking at a photo, and a round trip to Drive to see
 * your own edit appear would be absurd.
 */
let baseRecords = [];

/** Drive → catalog → corrections, narrowest source last. */
function withEdits(records) {
  return sortByTakenDesc(applyEdits(records, cachedEdits()));
}

async function doLoad() {
  const [catalog] = await Promise.all([ensureCatalog(), loadEdits()]);
  const tag = (records) => applyCatalog(records, catalog?.lookup);

  // --- stage 1: the cached index -------------------------------------------
  if (!state.files.length) {
    try {
      const cached = await fb.queryDocs('files', { orderBy: ['takenAt', 'desc'], limit: 500 });
      if (cached.length) {
        baseRecords = tag(cached);
        update({ files: withEdits(baseRecords), driveReady: true });
        window.dispatchEvent(new CustomEvent('fd:files-changed'));
      }
    } catch {
      // No cache yet, or rules not published. Fall through to the Drive scan.
    }
  }

  // --- stage 2: reconcile against Drive ------------------------------------
  update({ loadingFiles: true, fileError: null });
  try {
    const raw = await listSharedMedia(state.config.driveFolderId, {
      clientId: state.config.googleClientId,
    });
    const records = raw
      .map(({ file, folderName }) => toPointerRecord(file, { folderName }))
      .filter(Boolean);

    baseRecords = tag(records);
    update({
      files: withEdits(baseRecords),
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
 * Tags are deliberately not written here. They live in the catalog, which is
 * the one place an import can replace them; copying them into every file
 * record would mean a re-import silently disagreeing with itself.
 */
const MAX_WRITES_PER_RUN = 200;

async function persistNewPointers(records) {
  try {
    const existing = await fb.queryDocs('files', { limit: 1000 });
    const known = new Set(existing.map((r) => r.driveId ?? r.id));

    const fresh = records.filter((r) => !known.has(r.driveId)).slice(0, MAX_WRITES_PER_RUN);
    for (const record of fresh) {
      // Keyed on the Drive id so a re-scan updates in place rather than
      // creating a second record for the same photo.
      await fb.setDoc('files', record.driveId, record);
    }
  } catch {
    // Never let a caching failure break the photo grid; it is only an index.
  }
}

// ---------------------------------------------------------------------------
// Correcting tags by hand
// ---------------------------------------------------------------------------

const FIELD_LABELS = { people: 'who is in it', event: 'the event', takenAt: 'the date' };
const fieldLabel = (field) => FIELD_LABELS[field] ?? field;

/** Names and events already in use, so the editor can suggest rather than ask. */
function knownTags() {
  const facets = buildFacets(state.files);
  return {
    knownPeople: facets.people.map((person) => person.label),
    knownEvents: facets.events,
  };
}

/** Re-applies corrections over the cached listing. No network. */
function refreshFromEdits() {
  update({ files: withEdits(baseRecords) });
  window.dispatchEvent(new CustomEvent('fd:files-changed'));
}

/**
 * Opens the tag editor for one photo and saves what comes back.
 *
 * The correction stores only the fields actually changed, so a photo whose date
 * was fixed still picks up better people from the next import - and a photo
 * whose people were fixed keeps them, whatever the next import decides.
 *
 * @returns {Promise<boolean>} whether anything was saved
 */
async function editPhotoTags(record) {
  const existing = cachedEdits().get(record.driveId) ?? null;
  const shown = { people: record.people ?? [], event: record.event ?? null, takenAt: record.takenAt ?? null };

  let didReset = false;
  const values = await openTagSheet({
    title: 'Edit tags',
    subtitle: record.name,
    initial: shown,
    ...knownTags(),
    onReset: existing ? () => { didReset = true; } : null,
  });

  if (didReset) {
    try {
      await deleteEdit(record.driveId);
      refreshFromEdits();
      toast('Corrections undone');
      return true;
    } catch (error) {
      toast(error?.message ?? 'Could not undo the corrections', { error: true });
      return false;
    }
  }
  if (!values) return false;

  const edit = buildEdit({
    driveId: record.driveId,
    name: record.name,
    existing,
    shown,
    values,
    by: state.user?.uid ?? null,
  });

  // Nothing changed and nothing was overridden before: saving an empty document
  // would be a write for no reason.
  if (!edit && !existing) return false;

  try {
    await saveEdit(record.driveId, edit);
    refreshFromEdits();
    toast(edit ? 'Tags saved' : 'Corrections undone');
    return true;
  } catch (error) {
    toast(error?.message ?? 'Could not save the tags', { error: true });
    return false;
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
    record.people?.length > 0 && el('span', { class: 'tile__people' }, record.people.join(', ')),
  );
  node.addEventListener('click', () => onOpen(record));
  return node;
}

/**
 * Full-screen viewer. Tap the backdrop or press Escape to close.
 *
 * Editing lives here because this is the moment someone actually recognises the
 * face they are looking at. Making them remember it, navigate somewhere else
 * and find the photo again is how tags never get corrected.
 */
function openViewer(record, { onFilterPerson = null, onEdit = null, onChanged = null } = {}) {
  let current = record;
  const img = el('img', { class: 'viewer__img', alt: record.name });
  const meta = el('div', { class: 'viewer__meta' });

  const drawMeta = () => {
    const corrected = editedFields(cachedEdits().get(current.driveId));

    meta.replaceChildren(...children(
      el('div', {}, current.name),
      el('div', { class: 'muted small' },
        [
          current.takenAt ? formatDate(current.takenAt) : 'Date unknown',
          current.event?.name,
          current.owner,
        ].filter(Boolean).join(' · ')),

      current.people?.length
        ? el('div', { class: 'chips chips--tight' }, current.people.map((person) => {
            const chip = el('button', { class: 'chip chip--action', type: 'button' }, person);
            chip.addEventListener('click', (event) => {
              event.stopPropagation();
              onFilterPerson?.(person);
            });
            return chip;
          }))
        : el('div', { class: 'muted small' }, 'Nobody tagged'),

      corrected.length > 0 && el('div', { class: 'muted small' },
        `Corrected by hand: ${corrected.map(fieldLabel).join(', ')}.`),

      onEdit && editButton(),
    ));
  };

  function editButton() {
    const button = el('button', { class: 'btn btn--onDark', type: 'button' }, 'Edit tags');
    button.addEventListener('click', async (event) => {
      // Without this the click reaches the backdrop handler and shuts the
      // viewer the instant the sheet opens.
      event.stopPropagation();
      const saved = await onEdit(current);
      if (!saved) return;

      current = state.files.find((f) => f.driveId === current.driveId) ?? current;
      drawMeta();
      onChanged?.();
    });
    return button;
  }

  drawMeta();
  // The caption is now full of things you can press, so it must not double as
  // "tap anywhere to close".
  meta.addEventListener('click', (event) => event.stopPropagation());

  const overlay = el('div', { class: 'viewer', role: 'dialog', 'aria-modal': 'true' },
    el('button', { class: 'viewer__close', 'aria-label': 'Close' }, '✕'),
    img,
    meta,
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
  return close;
}

/**
 * Adding photos, with their tags.
 *
 * The tag sheet comes up *before* the upload rather than after, because this is
 * the one moment when whoever is adding the photos definitely knows what they
 * are looking at. Answers apply to the whole batch, which is almost always
 * right - people add a handful from the same afternoon, not a random sample of
 * their life. Anything that does not fit can be corrected in the viewer.
 *
 * Leaving the sheet blank and pressing Upload is a perfectly good answer; no
 * correction is written for a field nobody filled in.
 */
function uploadButton() {
  const input = el('input', { type: 'file', accept: 'image/*,video/*', multiple: true, hidden: true });
  const button = el('button', { class: 'btn btn--primary' }, 'Add photos');
  const progress = el('div', { class: 'muted small' });

  button.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const files = [...input.files];
    input.value = '';
    if (!files.length) return;

    const values = await openTagSheet({
      title: `Add ${files.length} ${files.length === 1 ? 'photo' : 'photos'}`,
      subtitle: 'Tags are optional, and apply to everything in this batch.',
      // The camera date is read from the files themselves once they are in
      // Drive, so there is nothing to clear here yet - only something to set,
      // which is what scanned photos and old videos need.
      allowClearDate: false,
      ...knownTags(),
      saveLabel: files.length === 1 ? 'Upload' : `Upload ${files.length}`,
    });
    if (!values) return;

    button.disabled = true;
    let done = 0;
    const uploaded = [];

    for (const file of files) {
      try {
        progress.textContent = `Uploading ${done + 1} of ${files.length}…`;
        const created = await uploadFile(file, {
          folderId: state.config.driveFolderId,
          clientId: state.config.googleClientId,
          onProgress: (fraction) => {
            progress.textContent = `Uploading ${done + 1} of ${files.length} — ${Math.round(fraction * 100)}%`;
          },
        });
        done += 1;
        if (created?.id) uploaded.push({ id: created.id, name: created.name ?? file.name });
      } catch (error) {
        toast(error?.message ?? 'Upload failed', { error: true });
      }
    }

    progress.textContent = uploaded.length ? 'Saving tags…' : '';
    // Tags are written against the ids Drive just handed back, so they attach
    // to the right photos even before the next listing sees them.
    const tagged = await tagUploaded(uploaded, values);

    progress.textContent = '';
    button.disabled = false;
    if (done) {
      toast(`Added ${done} ${done === 1 ? 'item' : 'items'}${tagged ? ' with tags' : ''}`);
      await loadFiles({ force: true });
      window.dispatchEvent(new CustomEvent('fd:files-changed'));
    }
  });

  return el('div', { class: 'row' }, button, input, progress);
}

/**
 * Writes the batch's tags against the freshly uploaded files.
 *
 * `shown` is empty on purpose: nothing was displayed to compare against, so
 * anything filled in counts as a correction and anything left blank does not.
 *
 * @returns {Promise<boolean>} whether any tags were written
 */
async function tagUploaded(uploaded, values) {
  let wrote = false;

  for (const file of uploaded) {
    const edit = buildEdit({
      driveId: file.id,
      name: file.name,
      shown: {},
      values,
      by: state.user?.uid ?? null,
    });
    if (!edit) continue;

    try {
      await saveEdit(file.id, edit);
      wrote = true;
    } catch {
      // The photo is safely in Drive; losing a tag is not worth failing over,
      // and it can be added again from the viewer.
    }
  }
  return wrote;
}

// ---------------------------------------------------------------------------
// The filter bar
// ---------------------------------------------------------------------------

/**
 * Kept outside the view function so the filters survive a trip to Memories and
 * back. Losing your filters because you glanced at another screen is the
 * single most irritating thing a photo app can do.
 */
let filters = emptyFilters();

/** A dropdown of one choice, as a plain select. */
function selectFilter({ label, anyLabel, options, value, format = (o) => o.label, onChange }) {
  const select = el('select', { class: 'filter-select', 'aria-label': label },
    el('option', { value: '' }, anyLabel),
    options.map((option) => el('option', {
      value: String(option.value),
      selected: String(option.value) === String(value ?? '') || undefined,
    }, `${format(option)} (${option.count})`)),
  );
  select.addEventListener('change', () => onChange(select.value || null));
  return select;
}

/**
 * People are a multi-select, because "photos of Jocelyn and Mindy" is the whole
 * point of having tagged them. A `<details>` element rather than a custom
 * popover: it opens, closes and takes the keyboard correctly without a line of
 * positioning code.
 */
function peopleFilter(facets, onChange) {
  const summaryText = filters.people.length
    ? filters.people.join(' + ')
    : 'Anyone';

  const menu = el('div', { class: 'filter__menu' });
  const wrap = el('details', { class: 'filter' },
    el('summary', { class: 'filter__summary' }, `People: ${summaryText}`),
    menu,
  );

  if (filters.people.length > 1) {
    const mode = el('div', { class: 'segmented segmented--small' },
      [[PEOPLE_MODE.ALL, 'Together'], [PEOPLE_MODE.ANY, 'Either']].map(([value, text]) => {
        const button = el('button', {
          class: `segmented__option${filters.peopleMode === value ? ' is-active' : ''}`,
          type: 'button',
        }, text);
        button.addEventListener('click', () => onChange({ ...filters, peopleMode: value }));
        return button;
      }));
    menu.append(mode);
  }

  for (const person of facets.people) {
    const checked = filters.people.some((p) => p.toLowerCase() === person.value.toLowerCase());
    const row = el('label', { class: 'filter__option' },
      el('input', { type: 'checkbox', checked: checked || undefined }),
      el('span', {}, person.label),
      el('span', { class: 'muted small' }, String(person.count)),
    );
    row.querySelector('input').addEventListener('change', () => {
      onChange({ ...filters, people: toggleValue(filters.people, person.value) });
    });
    menu.append(row);
  }

  if (facets.untagged > 0) {
    const row = el('label', { class: 'filter__option filter__option--divider' },
      el('input', { type: 'checkbox', checked: filters.untaggedOnly || undefined }),
      el('span', {}, 'Nobody tagged'),
      el('span', { class: 'muted small' }, String(facets.untagged)),
    );
    row.querySelector('input').addEventListener('change', (event) => {
      onChange({ ...filters, untaggedOnly: event.target.checked });
    });
    menu.append(row);
  }

  if (!facets.people.length) {
    menu.append(el('p', { class: 'muted small' },
      'No photo tags yet. Import them from Settings to filter by who is in a photo.'));
  }

  return wrap;
}

function filterBar(facets, onChange) {
  const bar = el('div', { class: 'filterbar' });

  const search = el('input', {
    type: 'search', class: 'filter-search', placeholder: 'Search photos',
    value: filters.text ?? '', 'aria-label': 'Search photos',
  });
  let debounce = null;
  search.addEventListener('input', () => {
    clearTimeout(debounce);
    // Debounced so typing does not redraw a grid of thousands on every letter.
    debounce = setTimeout(() => onChange({ ...filters, text: search.value }, { keepBar: true }), 200);
  });

  bar.append(...children(
    peopleFilter(facets, onChange),

    facets.years.length > 1 && selectFilter({
      label: 'Year', anyLabel: 'Any year', options: facets.years, value: filters.year,
      onChange: (value) => onChange({ ...filters, year: value ? Number(value) : null }),
    }),

    facets.months.length > 1 && selectFilter({
      label: 'Month', anyLabel: 'Any month', options: facets.months, value: filters.month,
      onChange: (value) => onChange({ ...filters, month: value ? Number(value) : null }),
    }),

    facets.events.length > 0 && selectFilter({
      label: 'Event', anyLabel: 'All events', options: facets.events, value: filters.event,
      format: (option) => (option.category ? `${option.category}: ${option.label}` : option.label),
      onChange: (value) => onChange({ ...filters, event: value }),
    }),

    facets.kinds.length > 1 && selectFilter({
      label: 'Type', anyLabel: 'Photos & videos', options: facets.kinds, value: filters.kind,
      onChange: (value) => onChange({ ...filters, kind: value }),
    }),

    facets.folders.length > 1 && selectFilter({
      label: 'Folder', anyLabel: 'Every folder', options: facets.folders, value: filters.folder,
      onChange: (value) => onChange({ ...filters, folder: value }),
    }),

    search,
  ));

  return bar;
}

function activeChips(facets, onChange) {
  const chips = describeFilters(filters, facets);
  if (!chips.length) return null;

  const nodes = chips.map((chip) => {
    const button = el('button', {
      class: `chip chip--active${chip.toggle ? ' chip--toggle' : ''}`, type: 'button',
      'aria-label': chip.toggle ? `Switch to ${chip.label === 'together' ? 'either' : 'together'}` : `Remove ${chip.label}`,
    }, chip.label, el('span', { class: 'chip__x' }, chip.toggle ? '⇄' : '✕'));

    button.addEventListener('click', () => onChange(clearFilter(filters, chip.field, chip.value)));
    return button;
  });

  const clearAll = el('button', { class: 'chip chip--clear', type: 'button' }, 'Clear all');
  clearAll.addEventListener('click', () => onChange(emptyFilters()));

  return el('div', { class: 'chips' }, nodes, clearAll);
}

/**
 * A grid of thousands of tiles is thousands of image requests, so it is drawn a
 * page at a time. Filtering usually cuts the list down far enough that this
 * never shows, which is rather the point of the filter bar.
 */
const PAGE_SIZE = 200;

function photoGrid(records, onOpen) {
  const wrap = el('div', {});
  let shown = 0;

  const more = el('button', { class: 'btn' }, 'Show more');
  const grid = el('div', { class: 'grid' });
  wrap.append(grid);

  const showNext = () => {
    const next = records.slice(shown, shown + PAGE_SIZE);
    grid.append(...next.map((record) => tile(record, onOpen)));
    shown += next.length;

    if (shown >= records.length) {
      more.remove();
    } else {
      more.textContent = `Show more (${(records.length - shown).toLocaleString()} left)`;
      if (!more.isConnected) wrap.append(more);
    }
  };

  more.addEventListener('click', showNext);
  showNext();
  return wrap;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export async function photosView() {
  const container = el('div', { class: 'view' });

  const barSlot = el('div', { class: 'filterbar-slot' });
  const chipSlot = el('div', {});
  const countSlot = el('span', { class: 'muted small' });
  const gridSlot = el('div', {});

  const openPhoto = (record) => {
    const close = openViewer(record, {
      onFilterPerson: (person) => {
        close();
        onFilterChange({ ...emptyFilters(), people: [person] });
      },
      onEdit: editPhotoTags,
      // A corrected date or person can move a photo out of the current filter,
      // so the grid behind the viewer is redrawn rather than left lying.
      onChanged: () => drawResults({ keepBar: true }),
    });
  };

  /**
   * Only the parts that actually changed are redrawn. Replacing the whole view
   * would slam the people menu shut and drop the caret out of the search box on
   * every keystroke.
   */
  function onFilterChange(next, { keepBar = false } = {}) {
    filters = next;
    drawResults({ keepBar });
  }

  function media() {
    return state.files.filter((f) => f.kind === KIND.PHOTO || f.kind === KIND.VIDEO);
  }

  function drawResults({ keepBar = false } = {}) {
    const all = media();
    const facets = buildFacets(all);
    const shown = filterPhotos(all, filters);

    if (!keepBar) barSlot.replaceChildren(filterBar(facets, onFilterChange));
    chipSlot.replaceChildren(...children(activeChips(facets, onFilterChange)));
    countSlot.textContent = describeCount(shown.length, all.length);

    if (all.length === 0) {
      gridSlot.replaceChildren(emptyState('📷', 'No photos yet',
        'Once PhotoSync is set up on a phone, photos appear here on their own. You can also add some directly.'));
      return;
    }
    if (shown.length === 0) {
      gridSlot.replaceChildren(emptyState('🔍', 'Nothing matches',
        'No photos match every filter at once. Try removing one.',
        el('button', { class: 'btn', onClick: () => onFilterChange(emptyFilters()) }, 'Clear filters')));
      return;
    }
    gridSlot.replaceChildren(photoGrid(shown, openPhoto));
  }

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

    container.replaceChildren(
      el('header', { class: 'view__header' }, el('h1', {}, 'Photos'), countSlot),
      uploadButton(),
      barSlot,
      chipSlot,
      gridSlot,
    );
    drawResults();
  };

  draw();
  await loadFiles();
  draw();
  return container;
}

export async function memoriesView() {
  const container = el('div', { class: 'view' });

  // Memories is where a wrong date is most obvious - a photo turns up on the
  // wrong anniversary - so it can be corrected right there too.
  const openMemory = (record) => openViewer(record, {
    onEdit: editPhotoTags,
    onChanged: () => draw(),
  });

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
              el('div', { class: 'grid' }, group.items.map((record) => tile(record, openMemory))),
            ))),
    );
  };

  draw();
  await loadFiles();
  draw();
  return container;
}
