/**
 * Shared app state.
 *
 * One small mutable object plus a subscribe function - enough for an app this
 * size, and it keeps the Drive listing in memory so switching between Photos
 * and Memories does not re-download everything each time.
 */

import { MODULE_CATALOG_VERSION, resolveState, unlockReadyModules } from './modules.js';
import { saveConfig } from './config.js';
import * as fb from './firebase.js';

const listeners = new Set();

export const state = {
  config: null,
  user: null,
  member: null,
  modules: resolveState(null),
  files: [],          // pointer records, newest first
  catalog: null,      // imported photo tags: who is in each photo, events
  filesLoadedAt: 0,
  driveReady: false,
  loadingFiles: false,
  fileError: null,
  scanProgress: null,   // {files, folders} while the Drive walk is running
  scanTruncated: false, // the library is bigger than one scan will collect
  misfiledVideos: 0,    // videos in the photo folders the app cannot move
};

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function update(patch) {
  Object.assign(state, patch);
  for (const listener of listeners) listener(state);
}

/**
 * Module toggles live in Firestore so switching a feature off on one phone
 * switches it off for the whole family - which is what "the family enables a
 * module" means. Falls back to defaults if the document is missing.
 */
export async function loadModuleSettings() {
  try {
    const doc = await fb.getDoc('modules', 'settings');
    const unlock = Number(doc?.catalogVersion ?? 0) < MODULE_CATALOG_VERSION;
    const modules = unlock
      ? unlockReadyModules(doc?.enabled ?? null)
      : resolveState(doc?.enabled ?? null);
    update({ modules });
    adoptFamilyName(doc?.familyName);
    if (unlock) {
      await fb.setDoc('modules', 'settings', {
        enabled: modules,
        catalogVersion: MODULE_CATALOG_VERSION,
        unlockedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        updatedBy: state.user?.uid ?? null,
      });
    }
  } catch {
    update({ modules: unlockReadyModules(null) });
  }
}

/**
 * The family's name, renameable from Settings.
 *
 * The name every device shows comes from its local config, which was stamped
 * by whatever setup link that device used - so a rename done on one phone
 * would normally leave every other phone wearing the old name forever. The
 * fix rides the document this module already reads at every launch: the
 * rename is written to modules/settings, and each device adopts it from
 * there the next time it starts.
 */
function adoptFamilyName(name) {
  const incoming = typeof name === 'string' ? name.trim() : '';
  if (!incoming || !state.config || state.config.familyName === incoming) return;
  try {
    update({ config: saveConfig({ ...state.config, familyName: incoming }) });
  } catch {
    // Config invalid mid-setup; the name catches up on a later launch.
  }
}

export async function setFamilyName(name) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) throw new Error('The name cannot be empty.');

  // Firestore first: if the family-wide write fails, this phone must not
  // quietly diverge from everyone else's.
  await fb.setDoc('modules', 'settings', {
    familyName: trimmed,
    updatedAt: new Date().toISOString(),
    updatedBy: state.user?.uid ?? null,
  });

  update({ config: saveConfig({ ...state.config, familyName: trimmed }) });
  return trimmed;
}

export async function setModuleEnabled(key, enabled) {
  const next = { ...state.modules, [key]: enabled };
  update({ modules: resolveState(next) });
  await fb.setDoc('modules', 'settings', {
    enabled: state.modules,
    catalogVersion: MODULE_CATALOG_VERSION,
    updatedAt: new Date().toISOString(),
    updatedBy: state.user?.uid ?? null,
  });
}

/** True when the cached Drive listing is old enough to be worth refetching. */
export function filesAreStale(maxAgeMs = 5 * 60_000) {
  return Date.now() - state.filesLoadedAt > maxAgeMs;
}
