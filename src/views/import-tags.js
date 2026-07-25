/**
 * Importing the face-tag CSVs.
 *
 * The face recognition itself runs offline on a real computer - it is a long
 * job over a hundred gigabytes of archive and has no business happening in a
 * browser. What it leaves behind is a few CSVs, and this screen is how they get
 * into the dashboard: pick the files, see what they contain, import.
 *
 * The files are read locally and parsed in the page. Nothing is uploaded
 * anywhere except the family's own Firestore, and the CSVs themselves are never
 * stored - only the photo-to-people mapping they describe.
 *
 * Which file is which is worked out from the column headers rather than the
 * filename, because the one thing guaranteed about a file called
 * "people_index_v2 (1).csv" is that it is still the people index.
 */

import { el, spinner, toast, children, formatDate } from '../ui.js';
import { state, update } from '../store.js';
import { buildCatalog, detectCsvRole } from '../catalog.js';
import { saveCatalog, loadCatalog, clearCatalog, catalogSummary } from '../catalog-store.js';

const ROLE_LABELS = {
  personTags: 'Who is in each photo',
  peopleIndex: 'Dates and events',
  clusterNames: 'Named faces',
};

const ROLE_FILES = {
  personTags: 'image_person_tags.csv',
  peopleIndex: 'people_index_v2.csv',
  clusterNames: 'clusters_to_name.csv',
};

export async function importTagsView() {
  const container = el('div', { class: 'view' });
  container.replaceChildren(spinner('Checking for existing tags…'));

  const existing = await catalogSummary();

  /** Raw CSV text, keyed by the role we detected. */
  const sources = {};
  let catalog = null;

  const preview = el('div');
  const status = el('div', { class: 'muted small' });
  const importButton = el('button', { class: 'btn btn--primary', disabled: true }, 'Import tags');

  const redrawPreview = () => {
    const roles = Object.keys(sources);
    if (!roles.length) {
      catalog = null;
      importButton.disabled = true;
      preview.replaceChildren();
      return;
    }

    catalog = buildCatalog(sources);
    importButton.disabled = catalog.entries.length === 0;
    preview.replaceChildren(previewCard(catalog, roles));
  };

  const acceptFiles = async (files) => {
    for (const file of files) {
      let text = '';
      try {
        text = await file.text();
      } catch {
        toast(`Could not read ${file.name}`, { error: true });
        continue;
      }

      const role = detectCsvRole(text);
      if (!role) {
        toast(`${file.name} is not one of the face-tool files`, { error: true });
        continue;
      }
      sources[role] = text;
    }
    redrawPreview();
  };

  const picker = filePicker(acceptFiles);

  importButton.addEventListener('click', async () => {
    if (!catalog?.entries.length) return;

    importButton.disabled = true;
    status.textContent = 'Importing…';

    try {
      const saved = await saveCatalog(catalog, {
        by: state.user?.uid ?? null,
        sources: Object.keys(sources).map((role) => ROLE_FILES[role]),
        onProgress: ({ phase, done, total }) => {
          status.textContent = phase === 'done'
            ? 'Finishing…'
            : `${phase === 'tidying' ? 'Tidying up' : 'Saving'} ${done} of ${total}…`;
        },
      });

      update({ catalog: saved });
      window.dispatchEvent(new CustomEvent('fd:catalog-changed'));
      status.textContent = '';
      toast(`Imported ${saved.count.toLocaleString()} tagged photos`);
      location.hash = '#/photos';
    } catch (error) {
      status.textContent = '';
      importButton.disabled = false;
      toast(error?.message ?? 'Could not save the tags', { error: true });
    }
  });

  container.replaceChildren(...children(
    el('header', { class: 'view__header' },
      el('h1', {}, 'Photo tags'),
      el('span', { class: 'muted small' }, 'Who is in each photo'),
    ),
    explainerCard(),
    existing && existingCard(existing),
    el('section', { class: 'card' },
      el('h2', {}, 'Import the files'),
      el('p', { class: 'muted small' },
        'Choose the CSVs the face tools produced. They are read on this phone - the files themselves are never uploaded.'),
      picker,
      preview,
      el('div', { class: 'row' }, importButton, status),
    ),
  ));

  return container;
}

/**
 * A drop zone that is also a file button, because this gets used on a laptop
 * (where dragging the files in is natural) and on a phone (where it is not).
 */
function filePicker(onFiles) {
  const input = el('input', {
    type: 'file', accept: '.csv,text/csv', multiple: true, hidden: true,
    id: 'tag-csv-input',
  });

  const zone = el('div', { class: 'dropzone' },
    el('div', { class: 'dropzone__icon' }, '📄'),
    el('div', {}, 'Drop the CSV files here'),
    el('button', { class: 'btn', type: 'button', onClick: () => input.click() }, 'Choose files'),
    input,
  );

  input.addEventListener('change', async () => {
    const files = [...input.files];
    input.value = '';
    if (files.length) await onFiles(files);
  });

  for (const type of ['dragenter', 'dragover']) {
    zone.addEventListener(type, (event) => {
      event.preventDefault();
      zone.classList.add('is-over');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    zone.addEventListener(type, () => zone.classList.remove('is-over'));
  }
  zone.addEventListener('drop', async (event) => {
    event.preventDefault();
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length) await onFiles(files);
  });

  return zone;
}

/** What the import is about to do, in numbers the family can sanity-check. */
function previewCard(catalog, roles) {
  const years = catalog.years.length
    ? `${catalog.years[catalog.years.length - 1].year}–${catalog.years[0].year}`
    : 'unknown';

  const topPeople = catalog.people.slice(0, 12);

  return el('div', { class: 'card card--inset' },
    el('h3', {}, 'What is in these files'),
    el('div', { class: 'stat-row' },
      stat(catalog.count.toLocaleString(), catalog.count === 1 ? 'photo' : 'photos'),
      stat(String(catalog.people.length), catalog.people.length === 1 ? 'person' : 'people'),
      stat(String(catalog.events.length), catalog.events.length === 1 ? 'event' : 'events'),
      stat(years, 'years'),
    ),

    el('div', { class: 'chips' }, topPeople.map((person) =>
      el('span', { class: 'chip chip--static' }, person.name,
        el('span', { class: 'chip__count' }, String(person.count))))),
    catalog.people.length > topPeople.length &&
      el('p', { class: 'muted small' }, `and ${catalog.people.length - topPeople.length} more`),

    catalog.events.length > 0 && el('div', { class: 'chips' }, catalog.events.map((event) =>
      el('span', { class: 'chip chip--static' }, event.name,
        el('span', { class: 'chip__count' }, String(event.count))))),

    el('p', { class: 'muted small' },
      `Read from ${roles.map((role) => ROLE_FILES[role]).join(', ')}.`),

    catalog.clusters && el('p', { class: 'muted small' },
      `${catalog.clusters.named} of ${catalog.clusters.total} face groups have been given a name. `
      + `The remaining ${catalog.clusters.unnamed} cover ${(catalog.clusters.facesTotal - catalog.clusters.facesNamed).toLocaleString()} faces `
      + 'and will stay untagged until they are named in the face tools.'),

    catalog.warnings.length > 0 && el('ul', { class: 'notes' },
      catalog.warnings.map((warning) => el('li', {}, warning))),
  );
}

function stat(value, label) {
  return el('div', { class: 'stat' },
    el('div', { class: 'stat__value' }, value),
    el('div', { class: 'stat__label' }, label),
  );
}

function existingCard(meta) {
  const clear = el('button', { class: 'btn btn--danger' }, 'Remove all tags');

  clear.addEventListener('click', async () => {
    if (!confirm('Remove every photo tag? The photos themselves are not touched.')) return;
    clear.disabled = true;
    try {
      await clearCatalog();
      update({ catalog: null });
      window.dispatchEvent(new CustomEvent('fd:catalog-changed'));
      toast('Photo tags removed');
      location.reload();
    } catch (error) {
      clear.disabled = false;
      toast(error?.message ?? 'Could not remove the tags', { error: true });
    }
  });

  return el('section', { class: 'card' },
    el('h2', {}, 'Already imported'),
    el('div', { class: 'stat-row' },
      stat((meta.count ?? 0).toLocaleString(), 'photos'),
      stat(String(meta.people?.length ?? 0), 'people'),
      stat(String(meta.events?.length ?? 0), 'events'),
    ),
    meta.updatedAt && el('p', { class: 'muted small' }, `Last imported ${formatDate(meta.updatedAt)}.`),
    el('p', { class: 'muted small' },
      'Importing again replaces everything above. Nothing in Google Drive changes either way.'),
    clear,
  );
}

function explainerCard() {
  return el('section', { class: 'card' },
    el('h2', {}, 'How this works'),
    el('p', {},
      'Google Drive knows a photo’s filename and the date the camera recorded. '
      + 'It does not know who is in it. That comes from a one-off face recognition pass '
      + 'run on a computer with the whole archive attached, which leaves behind a few CSV files.'),
    el('p', { class: 'muted small' },
      'Import those files here and the photo grid gains filters for people, years and events. '
      + 'Photos are matched by filename, so it works whether you upload the organised copies '
      + 'or the originals straight off the camera.'),
    el('ul', { class: 'notes' },
      Object.entries(ROLE_FILES).map(([role, file]) =>
        el('li', {}, el('code', {}, file), ` — ${ROLE_LABELS[role].toLowerCase()}`))),
  );
}

/**
 * Pulls the catalog into the store at start-up, so the photo grid can filter
 * without waiting for a second round trip. Silent on failure: a family with no
 * tags imported is the normal case, not an error.
 */
export async function primeCatalog() {
  try {
    const catalog = await loadCatalog();
    if (catalog) update({ catalog });
  } catch {
    // Leave it null; Photos simply shows no people filter.
  }
}
