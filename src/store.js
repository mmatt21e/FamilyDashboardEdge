/**
 * Shared app state.
 *
 * One small mutable object plus a subscribe function - enough for an app this
 * size, and it keeps the Drive listing in memory so switching between Photos
 * and Memories does not re-download everything each time.
 */

import { resolveState } from './modules.js';
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
    update({ modules: resolveState(doc?.enabled ?? null) });
  } catch {
    update({ modules: resolveState(null) });
  }
}

export async function setModuleEnabled(key, enabled) {
  const next = { ...state.modules, [key]: enabled };
  update({ modules: resolveState(next) });
  await fb.setDoc('modules', 'settings', {
    enabled: state.modules,
    updatedAt: new Date().toISOString(),
    updatedBy: state.user?.uid ?? null,
  });
}

/** True when the cached Drive listing is old enough to be worth refetching. */
export function filesAreStale(maxAgeMs = 5 * 60_000) {
  return Date.now() - state.filesLoadedAt > maxAgeMs;
}
