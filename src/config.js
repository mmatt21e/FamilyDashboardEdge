/**
 * App configuration.
 *
 * Nothing account-specific is committed to this repository. There are no
 * Firebase keys, no Google client id and no Drive folder id in the source. The
 * family enters them once in the in-app Setup screen and they live in this
 * browser's localStorage.
 *
 * Why that is safe: a Firebase web config and an OAuth client id are *public*
 * values by design - they ship inside every web app that uses them and are
 * visible in any browser's network tab. They identify a project; they do not
 * grant access to it. Access is controlled by Firestore security rules and by
 * the OAuth consent screen. So keeping them out of the repo costs nothing and
 * means this repo can be public, forked, or handed to someone else without
 * leaking anything.
 *
 * Setting up five family members by hand would be miserable, so config can be
 * shared as a link (see toSetupLink / readSetupLink). One person configures the
 * app, sends the link, everyone else taps it once.
 */

const STORAGE_KEY = 'fd.config.v1';

/** Fields the app cannot run without. */
const REQUIRED_FIREBASE_KEYS = ['apiKey', 'authDomain', 'projectId', 'appId'];

/** @typedef {{firebase:object, googleClientId:string, driveFolderId:string, familyName:string}} AppConfig */

let cached = null;

/** Reads the saved config, or null if the app has never been set up here. */
export function loadConfig() {
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    cached = parsed;
    return parsed;
  } catch {
    // Corrupt entry: treat as unconfigured rather than trapping the user on a
    // broken screen with no way forward.
    return null;
  }
}

export function saveConfig(config) {
  const errors = validateConfig(config);
  if (errors.length) throw new Error(errors.join('; '));
  cached = normaliseConfig(config);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cached));
  return cached;
}

export function clearConfig() {
  cached = null;
  localStorage.removeItem(STORAGE_KEY);
}

export function isConfigured() {
  return validateConfig(loadConfig()).length === 0;
}

/** Trims strings and drops unknown keys, so a pasted blob cannot smuggle junk in. */
export function normaliseConfig(input) {
  const fb = input?.firebase ?? {};
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  return {
    familyName: str(input?.familyName) || 'Our Family',
    firebase: {
      apiKey: str(fb.apiKey),
      authDomain: str(fb.authDomain),
      projectId: str(fb.projectId),
      storageBucket: str(fb.storageBucket),
      messagingSenderId: str(fb.messagingSenderId),
      appId: str(fb.appId),
    },
    googleClientId: str(input?.googleClientId),
    driveFolderId: str(input?.driveFolderId),
  };
}

/**
 * Returns a list of human-readable problems. Empty list means good to go.
 * Messages are written for a non-technical person reading them on a phone.
 */
export function validateConfig(input) {
  const errors = [];
  if (!input || typeof input !== 'object') return ['No settings have been entered yet.'];

  const c = normaliseConfig(input);
  for (const key of REQUIRED_FIREBASE_KEYS) {
    if (!c.firebase[key]) errors.push(`Firebase ${key} is missing.`);
  }
  if (c.firebase.authDomain && !/^[\w.-]+$/.test(c.firebase.authDomain)) {
    errors.push('Firebase authDomain does not look like a domain.');
  }
  if (!c.googleClientId) {
    errors.push('Google client ID is missing.');
  } else if (!c.googleClientId.endsWith('.apps.googleusercontent.com')) {
    errors.push('Google client ID should end in .apps.googleusercontent.com');
  }
  if (!c.driveFolderId) {
    errors.push('Shared Drive folder ID is missing.');
  }
  return errors;
}

/**
 * Pulls a Firebase config out of whatever the user pasted.
 *
 * People copy this from the Firebase console in several shapes: bare JSON, a
 * JS object literal with unquoted keys, or the whole
 * `const firebaseConfig = {...};` snippet. Accepting only strict JSON would
 * reject the exact thing the console gives you, so parse all three.
 */
export function parseFirebaseSnippet(text) {
  if (typeof text !== 'string' || !text.trim()) return null;

  // Narrow to the outermost {...} so surrounding code is ignored.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let body = text.slice(start, end + 1);

  try {
    return JSON.parse(body);
  } catch {
    // Not strict JSON. Convert the JS-object-literal form: quote bare keys,
    // convert single-quoted strings, and drop trailing commas.
    try {
      body = body
        .replace(/\/\/[^\n\r]*/g, '')                       // line comments
        .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":') // bare keys
        .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"')     // single quotes
        .replace(/,\s*([}\]])/g, '$1');                     // trailing commas
      return JSON.parse(body);
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Shareable setup links
// ---------------------------------------------------------------------------

/** URL-safe base64 that survives being pasted into a message. */
function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Builds a link that configures another family member's app in one tap.
 *
 * This carries no secrets - see the note at the top of this file - but it does
 * identify the family's project, so it should be sent the same way you would
 * send a house key photo: to the family, not to a public channel.
 */
export function toSetupLink(config, baseUrl = location.href.split('#')[0]) {
  const payload = b64urlEncode(JSON.stringify(normaliseConfig(config)));
  return `${baseUrl}#setup=${payload}`;
}

/** Reads a setup payload out of the URL hash, or null if there isn't one. */
export function readSetupLink(hash = location.hash) {
  const match = /[#&]setup=([A-Za-z0-9\-_]+)/.exec(hash || '');
  if (!match) return null;
  try {
    const parsed = JSON.parse(b64urlDecode(match[1]));
    return normaliseConfig(parsed);
  } catch {
    return null;
  }
}
