/**
 * Per-person toolbar shortcuts.
 *
 * A family feature being available and one person wanting it in their compact
 * bottom toolbar are different decisions. Availability stays in the shared
 * module settings; shortcuts stay on this device, scoped to the signed-in
 * account so two family members sharing a tablet do not rearrange each other.
 */

import { navModules } from './modules.js';

const STORAGE_PREFIX = 'fd.toolbar.v1';

function storageKey(uid) {
  return `${STORAGE_PREFIX}.${uid || 'guest'}`;
}

/** Available features are the only valid toolbar shortcuts. */
export function resolveToolbarKeys(saved, moduleState) {
  const availableModules = navModules(moduleState);
  const available = availableModules.map((module) => module.key);
  // Keep the first run compact: the original core modules are shortcuts, and
  // everything else is one tap away in Features until this person pins it.
  if (!Array.isArray(saved)) {
    return availableModules.filter((module) => module.toolbarDefault).map((module) => module.key);
  }

  const allowed = new Set(available);
  return [...new Set(saved.filter((key) => typeof key === 'string' && allowed.has(key)))];
}

/** Modules currently pinned, in the registry's stable display order. */
export function toolbarModules(moduleState, keys) {
  const selected = new Set(resolveToolbarKeys(keys, moduleState));
  return navModules(moduleState).filter((module) => selected.has(module.key));
}

export function setToolbarPinned(keys, key, pinned, moduleState) {
  const current = new Set(resolveToolbarKeys(keys, moduleState));
  if (pinned) current.add(key);
  else current.delete(key);
  return resolveToolbarKeys([...current], moduleState);
}

export function loadToolbarKeys(moduleState, uid, storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(storageKey(uid));
    return resolveToolbarKeys(raw == null ? null : JSON.parse(raw), moduleState);
  } catch {
    return resolveToolbarKeys(null, moduleState);
  }
}

export function saveToolbarKeys(keys, moduleState, uid, storage = globalThis.localStorage) {
  const resolved = resolveToolbarKeys(keys, moduleState);
  try { storage?.setItem(storageKey(uid), JSON.stringify(resolved)); } catch { /* private mode */ }
  return resolved;
}
