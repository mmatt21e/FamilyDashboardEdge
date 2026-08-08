/**
 * Building the shared folder's structure.
 *
 * Left to itself a shared Drive folder becomes a heap. People add files outside
 * the dashboard, upload from the app, and two years later
 * nobody can find anything - which quietly breaks the one promise this design
 * makes: that the photos live in plain Drive folders you can open and
 * understand without this app, forever.
 *
 * So the app builds and maintains the structure rather than hoping somebody
 * else does:
 *
 *     Family Dashboard/
 *     ├── Archive/                     the one-off import of the old library
 *     ├── Events/                      named occasions
 *     ├── Dashboard_Image_Storage/     photos, a folder per family member
 *     │   ├── Dad/  Mom/  Jocey/
 *     │   └── Shared/                  when we do not know whose it is
 *     ├── Dashboard_Video_Storage/     videos, mirroring the photo store
 *     └── Dashboard_Document_Storage/  everything that is not a photo
 *         └── 2026/
 *
 * The root holds five folders and only ever five, however many people join -
 * new members get a folder inside the image store, not another one at the top.
 * That is the difference between a folder that stays legible and one that grows
 * a new entry every time somebody signs in.
 *
 * Files added through the dashboard already use this layout. It can also move
 * and rename older or externally uploaded files inside the shared folder; the
 * family owner granted full Drive access for that purpose (see drive.js).
 * A person folder at the top level still works as well as
 * one inside the image store - see ownerFromPath in files.js. The structure
 * is a tidy default, not a requirement.
 */

import { ensureFolder, ensureFolderPath, listFolder } from './drive.js';
import { MANAGED, folderSafeName, personFolderPath } from './files.js';

/** The folders that always exist, whatever else does. */
export const ROOT_FOLDERS = [
  { name: MANAGED.ARCHIVE, purpose: 'Older photos imported in one go, filed by year.' },
  { name: MANAGED.EVENTS, purpose: 'Holidays, weddings and days out, one folder each.' },
  { name: MANAGED.IMAGES, purpose: 'Photos, in a folder per person.' },
  { name: MANAGED.VIDEOS, purpose: 'Videos, in a folder per person.' },
  { name: MANAGED.DOCUMENTS, purpose: 'Anything that is not a photo, filed by year.' },
];

/**
 * Creates whatever is missing and leaves whatever is not.
 *
 * Safe to call as often as you like: every step is find-or-create, and the
 * folder ids are cached, so a second run costs four lookups and no writes.
 *
 * @param {string} rootId the shared folder
 * @param {{clientId: string, members?: Array<{name?: string}>, onProgress?: Function}} options
 * @returns {Promise<{created: string[], existing: string[], failed: string[]}>}
 */
export async function provisionStructure(rootId, { clientId, members = [], onProgress = null } = {}) {
  const created = [];
  const existing = [];
  const failed = [];

  if (!rootId) return { created, existing, failed };

  const before = await topLevelNames(rootId, { clientId });

  const make = async (segments, label) => {
    try {
      onProgress?.(label);
      await ensureFolderPath(rootId, segments, { clientId });
      // "Created" means it was not there when we looked, which is what a person
      // wants reported - not whether this particular call did the writing.
      (before.has(segments[0].toLowerCase()) ? existing : created).push(label);
    } catch {
      failed.push(label);
    }
  };

  for (const folder of ROOT_FOLDERS) {
    await make([folder.name], folder.name);
  }

  // A folder each, so a new member has somewhere to be before they upload
  // anything. Done after the roots, because they live inside one of them.
  const names = memberFolderNames(members);
  for (const name of names) {
    try {
      onProgress?.(name);
      const parent = await ensureFolder(rootId, MANAGED.IMAGES, { clientId });
      await ensureFolder(parent, name, { clientId });
    } catch {
      failed.push(`${MANAGED.IMAGES}/${name}`);
    }
  }

  return { created, existing, failed, people: names };
}

/**
 * The folder names a member list needs.
 *
 * Deduplicated case-insensitively, because "Jocey" and "jocey" signing in from
 * two devices must not end up with a folder each.
 */
export function memberFolderNames(members = []) {
  const seen = new Map();
  for (const member of members) {
    const name = folderSafeName(member?.name ?? member?.email ?? '', '');
    if (!name) continue;
    const key = name.toLowerCase();
    if (!seen.has(key)) seen.set(key, name);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/** Makes sure one person has a folder. Called when somebody joins. */
export async function ensurePersonFolder(rootId, name, { clientId } = {}) {
  const safe = folderSafeName(name, '');
  if (!rootId || !safe) return null;
  return ensureFolderPath(rootId, personFolderPath(safe), { clientId });
}

/** What is actually in the shared folder's top level, lowercased. */
async function topLevelNames(rootId, { clientId }) {
  try {
    const page = await listFolder(rootId, { clientId, foldersOnly: true });
    return new Set((page.files ?? []).map((f) => String(f.name).toLowerCase()));
  } catch {
    // Unreadable root: report everything as newly created rather than failing.
    return new Set();
  }
}

/**
 * A description of the structure for the Settings screen.
 *
 * Reads the folder rather than assuming, so it shows what is really there -
 * including the person folders somebody put at the top level by hand, which are
 * perfectly valid and should not be reported as missing.
 */
export async function describeStructure(rootId, { clientId, members = [] } = {}) {
  const present = await topLevelNames(rootId, { clientId });

  const roots = ROOT_FOLDERS.map((folder) => ({
    ...folder,
    present: present.has(folder.name.toLowerCase()),
  }));

  const people = memberFolderNames(members).map((name) => ({
    name,
    // A person folder is fine in either place. Only the top-level one can be
    // seen without another request, so that is the one reported on.
    atTopLevel: present.has(name.toLowerCase()),
  }));

  return { roots, people, missing: roots.filter((r) => !r.present).length };
}
