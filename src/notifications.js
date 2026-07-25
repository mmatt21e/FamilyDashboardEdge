/**
 * Per-person notification preferences.
 *
 * WHAT IS HONEST ABOUT THIS
 * -------------------------
 * A static site on GitHub Pages has no server, and nothing can *send* a push
 * without one. So this module owns the half that genuinely works offline of a
 * backend: capability detection, the permission prompt, and each person's
 * per-feature preferences stored in Firestore so they follow them between
 * devices.
 *
 * Actual delivery needs a sender - a Cloud Function on the family's own Firebase
 * project, triggered by new Firestore documents. `deliveryConfigured()` reports
 * whether that has been set up, and the UI says so plainly rather than letting
 * anyone switch on a toggle that quietly does nothing.
 *
 * PLATFORM REALITY
 * ----------------
 * iOS only allows web push from a PWA that has been added to the home screen,
 * and only on iOS 16.4+. In Safari as a normal tab there is no Notification API
 * at all. That is why `capability()` distinguishes "cannot" from "not yet" -
 * telling an iPhone user to enable notifications that cannot exist is worse
 * than saying nothing.
 */

import * as fb from './firebase.js';
import { state } from './store.js';
import { readyModules } from './modules.js';

/** Categories a person can opt in or out of, derived from the built modules. */
export function categories() {
  return [
    { key: 'feed', title: 'New posts on the message board' },
    { key: 'photos', title: 'New photos added' },
    { key: 'calendar', title: 'Calendar changes and reminders' },
    { key: 'memories', title: 'A daily nudge when there are memories' },
  ].filter((category) => readyModules().some((m) => m.key === category.key));
}

/**
 * What this device can actually do.
 * @returns {{supported:boolean, reason:string|null, permission:string}}
 */
export function capability() {
  const permission = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';

  if (typeof Notification === 'undefined' || !('serviceWorker' in navigator)) {
    // Most commonly an iPhone in a normal Safari tab.
    const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    return {
      supported: false,
      permission,
      reason: iOS
        ? 'On iPhone, notifications only work once this app has been added to your home screen.'
        : 'This browser does not support notifications.',
    };
  }
  return { supported: true, permission, reason: null };
}

export async function requestPermission() {
  const { supported } = capability();
  if (!supported) return 'denied';
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

/**
 * Whether the family has set up something capable of sending.
 *
 * The VAPID key is entered in Setup alongside the other account details. Until
 * it is present, preferences are still saved - they just have no effect yet,
 * and the UI says so.
 */
export function deliveryConfigured() {
  return Boolean(state.config?.vapidKey);
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------
// Stored per member so they follow the person between their phone and tablet,
// rather than being stuck in one device's localStorage.

const PATH = 'notification_prefs';

export function defaultPrefs() {
  const prefs = {};
  for (const category of categories()) prefs[category.key] = true;
  return prefs;
}

export async function loadPrefs(uid = state.user?.uid) {
  if (!uid) return defaultPrefs();
  try {
    const doc = await fb.getDoc(PATH, uid);
    return { ...defaultPrefs(), ...(doc?.categories ?? {}) };
  } catch {
    return defaultPrefs();
  }
}

export async function savePrefs(prefs, uid = state.user?.uid) {
  if (!uid) return;
  await fb.setDoc(PATH, uid, {
    uid,
    categories: prefs,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Registers this device so a future sender can reach it.
 *
 * Stored per device rather than per person: one member may have a phone and a
 * tablet, and a stale token from a replaced phone must not silently take the
 * place of the new one.
 */
export async function registerDevice() {
  if (!deliveryConfigured()) return null;
  const { supported, permission } = capability();
  if (!supported || permission !== 'granted') return null;

  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: state.config.vapidKey,
    });

    const json = subscription.toJSON();
    // Keyed on the endpoint so re-registering the same device updates in place
    // instead of piling up duplicates every time the app opens.
    const id = await hash(json.endpoint);
    await fb.setDoc('devices', id, {
      uid: state.user?.uid ?? null,
      endpoint: json.endpoint,
      keys: json.keys ?? null,
      userAgent: navigator.userAgent,
      updatedAt: new Date().toISOString(),
    });
    return id;
  } catch {
    return null;
  }
}

async function hash(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
