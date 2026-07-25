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
    // Optional. Only needed if the family sets up a sender for push
    // notifications; everything else works without it.
    vapidKey: str(input?.vapidKey),
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
 * Removes // and block comments without touching the inside of strings.
 * String-aware because a URL like "https://x" contains "//" and must survive.
 */
function stripComments(src) {
  let out = '';
  let quote = null;

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    const next = src[i + 1];

    if (quote) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i += 1; }
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; continue; }
    if (ch === '/' && next === '/') { while (i < src.length && src[i] !== '\n') i += 1; out += '\n'; continue; }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Returns the balanced {...} block beginning at `start`, or null if it never
 * closes. Braces inside string literals are ignored.
 */
function braceBlock(src, start) {
  let depth = 0;
  let quote = null;

  for (let i = start; i < src.length; i += 1) {
    const ch = src[i];

    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

/** Strict JSON first, then the JS-object-literal form the console emits. */
function parseObjectLiteral(block) {
  try {
    return JSON.parse(block);
  } catch { /* not strict JSON; repair below */ }

  try {
    return JSON.parse(
      block
        .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')  // bare keys
        .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"')          // single quotes
        .replace(/,\s*([}\]])/g, '$1'),                          // trailing commas
    );
  } catch {
    return null;
  }
}

/**
 * Pulls a Firebase config out of whatever the user pasted.
 *
 * The console no longer shows a bare object. It gives you a whole file:
 *
 *     import { initializeApp } from "firebase/app";
 *     import { getAnalytics } from "firebase/analytics";
 *     const firebaseConfig = { apiKey: "...", ... };
 *     const app = initializeApp(firebaseConfig);
 *
 * Taking "the first { to the last }" - which this used to do - starts at the
 * brace in `import { initializeApp }` and produces garbage. That is a real
 * failure people hit on their very first screen, so the config object is now
 * located properly:
 *
 *   1. strip comments (string-aware, so URLs survive)
 *   2. prefer the object assigned to `firebaseConfig`
 *   3. otherwise try each balanced {...} block and take the first containing
 *      an apiKey
 *
 * Returns null only when there is genuinely no Firebase config in the text.
 */
export function parseFirebaseSnippet(text) {
  if (typeof text !== 'string' || !text.trim()) return null;

  const src = stripComments(text);
  const starts = [];

  const assigned = /(?:const|let|var)?\s*firebaseConfig\s*=\s*/.exec(src);
  if (assigned) {
    const at = src.indexOf('{', assigned.index + assigned[0].length - 1);
    if (at !== -1) starts.push(at);
  }

  // Fall back to every other opening brace, in order. Bounded so a huge paste
  // cannot turn this into a pathological scan.
  for (let i = 0; i < src.length && starts.length < 32; i += 1) {
    if (src[i] === '{' && !starts.includes(i)) starts.push(i);
  }

  for (const start of starts) {
    const block = braceBlock(src, start);
    // An import's braces contain no apiKey, so they are skipped here.
    if (!block || !/["']?apiKey["']?\s*:/.test(block)) continue;

    const parsed = parseObjectLiteral(block);
    if (parsed && typeof parsed.apiKey === 'string' && parsed.apiKey) return parsed;
  }
  return null;
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
  const full = normaliseConfig(config);

  // Drop empty values before encoding. normaliseConfig fills every key in, and
  // carrying `"storageBucket":""` style padding makes an already-long link
  // longer for no benefit - and length is what gets links broken in transit.
  const compact = {
    ...full,
    firebase: Object.fromEntries(Object.entries(full.firebase).filter(([, v]) => v)),
  };
  for (const [key, value] of Object.entries(compact)) {
    if (value === '' || value == null) delete compact[key];
  }

  return `${baseUrl}#setup=${b64urlEncode(JSON.stringify(compact))}`;
}

/**
 * Reads a setup payload from a full link, a bare hash, or just the code.
 *
 * The link is ~400 characters of base64, and messaging apps routinely wrap or
 * truncate URLs that long. When that happens the recipient lands on the Setup
 * screen and is asked for Firebase details they should never have to see - so
 * the Setup screen offers a paste box, and this accepts whatever they paste:
 * the whole URL, the "#setup=..." fragment, or the code on its own.
 */
export function parseSetupCode(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (!text) return null;

  const match = /[#&?]setup=([A-Za-z0-9\-_]+)/.exec(text);
  const payload = match ? match[1]
    : /^[A-Za-z0-9\-_]{20,}$/.test(text) ? text
    : null;
  if (!payload) return null;

  try {
    return normaliseConfig(JSON.parse(b64urlDecode(payload)));
  } catch {
    return null;
  }
}

/** Reads a setup payload out of the URL hash, or null if there isn't one. */
export function readSetupLink(hash = location.hash) {
  return parseSetupCode(hash);
}
