/**
 * The shared folder's structure, in Settings.
 *
 * Mostly this looks after itself - the folders are built the first time anyone
 * opens Photos. This screen exists for the two moments when that is not enough:
 * checking what is actually there before uploading a hundred gigabytes, and
 * making a new member's folder appear now rather than whenever somebody next
 * opens the app.
 */

import { el, toast, spinner, children } from '../ui.js';
import { state } from '../store.js';
import * as fb from '../firebase.js';
import { provisionStructure, describeStructure, ROOT_FOLDERS } from '../folders.js';
import { MANAGED } from '../files.js';

export function foldersCard() {
  const card = el('section', { class: 'card' });
  const body = el('div');

  const check = el('button', { class: 'btn' }, 'Check the folders');
  const build = el('button', { class: 'btn btn--primary' }, 'Create anything missing');

  const withMembers = async () => {
    try {
      return await fb.queryDocs('members', { limit: 100 });
    } catch {
      return state.member ? [state.member] : [];
    }
  };

  check.addEventListener('click', async () => {
    check.disabled = true;
    body.replaceChildren(spinner('Reading the shared folder…'));
    try {
      const structure = await describeStructure(state.config.driveFolderId, {
        clientId: state.config.googleClientId,
        members: await withMembers(),
      });
      body.replaceChildren(structureList(structure));
    } catch (error) {
      body.replaceChildren(el('p', { class: 'error-text' },
        error?.message ?? 'Could not read the shared folder.'));
    }
    check.disabled = false;
  });

  build.addEventListener('click', async () => {
    build.disabled = true;
    const status = el('div', { class: 'muted small' }, 'Starting…');
    body.replaceChildren(status);

    try {
      const result = await provisionStructure(state.config.driveFolderId, {
        clientId: state.config.googleClientId,
        members: await withMembers(),
        onProgress: (label) => { status.textContent = `Checking ${label}…`; },
      });

      body.replaceChildren(...children(
        el('p', {},
          result.created.length
            ? `Created ${result.created.length} ${result.created.length === 1 ? 'folder' : 'folders'}.`
            : 'Everything was already there.'),
        result.people?.length > 0 && el('p', { class: 'muted small' },
          `A folder each for ${result.people.join(', ')}.`),
        result.failed.length > 0 && el('p', { class: 'error-text' },
          `Could not create: ${result.failed.join(', ')}.`),
      ));
      toast('Shared folder is set up');
    } catch (error) {
      body.replaceChildren(el('p', { class: 'error-text' },
        error?.message ?? 'Could not create the folders.'));
    }
    build.disabled = false;
  });

  card.replaceChildren(
    el('h2', {}, 'Shared folder structure'),
    el('p', { class: 'muted small' },
      'The app keeps the shared Drive folder tidy: five folders at the top, and one '
      + 'inside the photo folder for each person. It builds them on its own the first '
      + 'time anyone opens Photos — this is for checking, or for adding a new '
      + 'person’s folder straight away.'),

    el('pre', { class: 'tree' }, ROOT_FOLDERS.map((f) => `${f.name}/\n`).join('')
      + `${MANAGED.IMAGES}/<name>/  — a folder each, made as people join\n`),

    el('div', { class: 'row' }, check, build),
    body,

    el('p', { class: 'muted small' },
      'Folders you or PhotoSync made are read but never moved or renamed — the app '
      + 'only has permission to touch what it created itself. Tidying those is a '
      + 'drag-and-drop job in Drive.'),
  );

  return card;
}

function structureList(structure) {
  return el('div', {},
    el('ul', { class: 'notes' }, structure.roots.map((folder) =>
      el('li', {},
        el('strong', {}, folder.name), folder.present ? ' — there' : ' — missing',
        el('div', { class: 'muted small' }, folder.purpose),
      ))),

    structure.people.length > 0 && el('p', { class: 'muted small' },
      `People: ${structure.people.map((p) => p.name).join(', ')}.`),

    structure.missing > 0
      ? el('p', {}, `${structure.missing} missing. Press “Create anything missing”.`)
      : el('p', { class: 'muted small' }, 'Everything is where it should be.'),
  );
}
