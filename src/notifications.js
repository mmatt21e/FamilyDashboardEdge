/**
 * Per-person notification preferences and delivery.
 *
 * The dashboard is hosted as a static GitHub Pages PWA, so there are two
 * honest delivery levels:
 *
 *   1. Firestore activity events can reach every signed-in device while the
 *      PWA is open (including a background tab) and display a system
 *      notification through the service worker. This works today.
 *   2. Waking a fully closed PWA requires a trusted push sender. The data model
 *      and service worker are ready for that sender, but Firebase Cloud
 *      Functions cannot be deployed until the project has billing enabled.
 *
 * Preferences belong to a person rather than a device. Someone can turn all
 * notifications off, or choose categories, and the choice follows their
 * Google account between phone and tablet. Activity created by the same UID is
 * always ignored, so a person's second device does not announce their own post.
 */

import * as fb from './firebase.js';
import { state } from './store.js';

const PATH = 'notification_prefs';
const ACTIVITY_PATH = 'activity_events';

const CATEGORY_LIST = Object.freeze([
  { key: 'feed', title: 'Posts and replies' },
  { key: 'photos', title: 'Photos and videos' },
  { key: 'calendar', title: 'Calendar changes' },
  { key: 'care', title: 'Care and wellness activity' },
  { key: 'money', title: 'Money activity' },
  { key: 'family', title: 'Other family activity' },
]);

const CATEGORY_KEYS = new Set(CATEGORY_LIST.map((category) => category.key));

export function categories() {
  return CATEGORY_LIST.map((category) => ({ ...category }));
}

/** What this browser/device can actually do. */
export function capability() {
  const permission = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';

  if (typeof Notification === 'undefined' || !('serviceWorker' in navigator)) {
    const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    return {
      supported: false,
      permission,
      reason: iOS
        ? 'On iPhone, notifications work after this app is added to your home screen.'
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

/** Optional seam used when a trusted closed-app sender is configured later. */
export function closedAppDeliveryConfigured() {
  return Boolean(state.config?.vapidKey);
}

export async function registerDevice() {
  if (!closedAppDeliveryConfigured()) return null;
  const { supported, permission } = capability();
  if (!supported || permission !== 'granted') return null;

  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: state.config.vapidKey,
    });
    const json = subscription.toJSON();
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
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

/** New users choose whether to opt in; categories are ready when they do. */
export function defaultPrefs() {
  return {
    enabled: false,
    categories: Object.fromEntries(CATEGORY_LIST.map(({ key }) => [key, true])),
  };
}

export function normalisePrefs(value, { existing = false } = {}) {
  const defaults = defaultPrefs();
  const supplied = value?.categories && typeof value.categories === 'object'
    ? value.categories
    : value;
  const merged = { ...defaults.categories };
  for (const key of CATEGORY_KEYS) {
    if (typeof supplied?.[key] === 'boolean') merged[key] = supplied[key];
  }

  // Old preference documents predate the master switch. If one exists, the
  // member had already pressed "Turn on notifications", so preserve that opt-in.
  const enabled = typeof value?.enabled === 'boolean' ? value.enabled : existing;
  return { enabled, categories: merged };
}

export async function loadPrefs(uid = state.user?.uid) {
  if (!uid) return defaultPrefs();
  try {
    const doc = await fb.getDoc(PATH, uid);
    return normalisePrefs(doc, { existing: Boolean(doc) });
  } catch {
    return defaultPrefs();
  }
}

export async function savePrefs(prefs, uid = state.user?.uid) {
  if (!uid) return;
  const clean = normalisePrefs(prefs);
  await fb.setDoc(PATH, uid, {
    uid,
    enabled: clean.enabled,
    categories: clean.categories,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Writes a privacy-safe activity envelope after a successful user action.
 * Failures never roll back the post/photo/record that the person just saved.
 */
export async function recordActivity({
  category = 'family', title = 'New family activity', body = '', url = '#/', sourceId = null, count = null,
} = {}) {
  const actorUid = state.user?.uid;
  if (!actorUid || !CATEGORY_KEYS.has(category)) return null;

  const cleanUrl = /^#\/[a-z0-9/_-]*$/i.test(String(url)) ? String(url) : '#/';
  const activity = {
    category,
    actorUid,
    actorName: String(state.member?.name ?? state.user?.displayName ?? 'Someone').slice(0, 120),
    title: String(title || 'New family activity').slice(0, 80),
    body: String(body || '').slice(0, 160),
    url: cleanUrl,
    createdAt: new Date().toISOString(),
  };
  if (sourceId) activity.sourceId = String(sourceId).slice(0, 160);
  if (Number.isInteger(count) && count > 0) activity.count = Math.min(count, 10_000);

  try {
    return await fb.addDoc(ACTIVITY_PATH, activity);
  } catch {
    return null;
  }
}

export async function showActivityNotification(activity) {
  const { supported, permission } = capability();
  if (!supported || permission !== 'granted') return false;

  try {
    const registration = await navigator.serviceWorker.ready;
    await registration.showNotification(activity.title || 'New family activity', {
      body: activity.body || 'Something new was added to Family Dashboard.',
      icon: './assets/icon-192.png',
      badge: './assets/icon-192.png',
      tag: activity.id ? `family-activity-${activity.id}` : `family-${activity.category ?? 'activity'}`,
      data: { url: activity.url || '#/' },
    });
    return true;
  } catch {
    return false;
  }
}

export function activitiesToNotify(events, seenIds, uid, prefs) {
  if (!prefs?.enabled) return [];
  const seen = seenIds instanceof Set ? seenIds : new Set(seenIds ?? []);
  return (events ?? [])
    .filter((activity) => !seen.has(activity.id))
    .filter((activity) => activity.actorUid !== uid)
    .filter((activity) => Boolean(prefs.categories?.[activity.category]))
    .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
}

let stopActivityWatch = null;

/**
 * Begins the one app-wide listener. The first Firestore snapshot is a baseline,
 * never a reason to replay old alerts when someone opens the app.
 */
export function startActivityNotifications() {
  if (stopActivityWatch || !state.user?.uid) return stopActivityWatch ?? (() => {});

  // Safe no-op until a public VAPID key is present. Once closed-app delivery
  // is configured, upgraded clients begin registering without another release.
  void loadPrefs().then((prefs) => prefs.enabled && registerDevice());

  let firstSnapshot = true;
  let seen = new Set();

  const unsubscribe = fb.watchDocs(
    ACTIVITY_PATH,
    { orderBy: ['createdAt', 'desc'], limit: 50 },
    async (events) => {
      const currentIds = new Set(events.map((event) => event.id));
      if (firstSnapshot) {
        firstSnapshot = false;
        seen = currentIds;
        return;
      }

      const previousSeen = seen;
      seen = currentIds;
      const prefs = await loadPrefs();
      const fresh = activitiesToNotify(events, previousSeen, state.user?.uid, prefs);
      if (!fresh.length) return;

      for (const activity of fresh) {
        await showActivityNotification(activity);
      }
    },
  );

  stopActivityWatch = () => {
    unsubscribe?.();
    stopActivityWatch = null;
  };
  return stopActivityWatch;
}

export function stopActivityNotifications() {
  stopActivityWatch?.();
}
