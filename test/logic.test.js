/**
 * Tests for the pure logic: config parsing, the module registry, "on this day"
 * date handling, and Drive metadata mapping.
 *
 * These are the parts where a quiet mistake would be invisible in the UI - a
 * memory feed showing nothing, or a toggle that does not stick - so they are
 * worth testing directly. Anything needing a browser or a network is covered by
 * the Playwright smoke test instead.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { validateConfig, normaliseConfig, parseFirebaseSnippet } from '../src/config.js';
import { defaultState, resolveState, isEnabled, navModules, MODULES, getModule } from '../src/modules.js';
import { dayKeyFor, dayKeysForToday, groupByYearsAgo, isLeapYear, describeYearsAgo } from '../src/memories.js';
import { parseExifDate, originalDateFor, toPointerRecord, kindForMime, sortByTakenDesc, formatSize, dateFromFilename } from '../src/files.js';
import {
  parseCsv, basenameOf, catalogKey, parseTimestamp, parseEventBucket, buildCatalog,
  buildLookup, matchEntry, applyCatalog, toChunks, fromChunks, packEntry, detectCsvRole,
} from '../src/catalog.js';
import {
  emptyFilters, hasActiveFilters, filterPhotos, buildFacets, describeFilters,
  clearFilter, describeCount, PEOPLE_MODE,
} from '../src/photo-filter.js';
import {
  applyEdits, buildEdit, isEmptyEdit, editedFields, normalisePersonName,
  addPerson, removePerson, toDateInput, toTimeInput, fromDateInput, parseEventInput,
} from '../src/photo-edits.js';
import {
  generateCode, looksLikeEmail, buildInvitation, checkInvitation, describeInvitation,
  toInviteLink, parseInviteCode, inviteMessage,
} from '../src/invites.js';
import { detectPlatform, installGuidance, shouldOfferInstall, OS } from '../src/install.js';
import { walkFolders } from '../src/drive.js';

const validConfig = {
  familyName: 'The Smiths',
  firebase: { apiKey: 'k', authDomain: 'x.firebaseapp.com', projectId: 'p', appId: 'a' },
  googleClientId: '123.apps.googleusercontent.com',
  driveFolderId: 'folder123',
};

describe('config', () => {
  test('accepts a complete config', () => {
    assert.deepEqual(validateConfig(validConfig), []);
  });

  test('reports every missing field, not just the first', () => {
    const errors = validateConfig({ firebase: {} });
    assert.ok(errors.length >= 4, `expected several errors, got ${errors.length}`);
  });

  test('rejects a Google client ID that is not one', () => {
    const errors = validateConfig({ ...validConfig, googleClientId: 'my-client-id' });
    assert.ok(errors.some((e) => e.includes('apps.googleusercontent.com')));
  });

  test('trims whitespace and drops unknown keys', () => {
    const result = normaliseConfig({ ...validConfig, driveFolderId: '  abc  ', evil: 'x' });
    assert.equal(result.driveFolderId, 'abc');
    assert.equal(result.evil, undefined);
  });

  test('falls back to a friendly default family name', () => {
    assert.equal(normaliseConfig({}).familyName, 'Our Family');
  });

  // The Firebase console hands you a JS snippet, not JSON. Rejecting the exact
  // thing a person is most likely to paste would be a bad first experience.
  describe('parsing the Firebase console snippet', () => {
    test('reads plain JSON', () => {
      assert.equal(parseFirebaseSnippet('{"apiKey":"abc"}').apiKey, 'abc');
    });

    test('reads the full const firebaseConfig = {...} snippet', () => {
      const pasted = `
        // Your web app's Firebase configuration
        const firebaseConfig = {
          apiKey: "AIzaSyExample",
          authDomain: "demo.firebaseapp.com",
          projectId: "demo",
          appId: "1:2:web:3",
        };
      `;
      const parsed = parseFirebaseSnippet(pasted);
      assert.equal(parsed.apiKey, 'AIzaSyExample');
      assert.equal(parsed.projectId, 'demo');
    });

    test('reads single-quoted values', () => {
      assert.equal(parseFirebaseSnippet("{ apiKey: 'xyz' }").apiKey, 'xyz');
    });

    test('returns null for something that is not a config', () => {
      assert.equal(parseFirebaseSnippet('hello there'), null);
      assert.equal(parseFirebaseSnippet(''), null);
    });

    // THE REGRESSION THAT MATTERED. The Firebase console no longer shows a bare
    // object - it hands you a whole file with import statements above the
    // config. The old "first { to last }" extraction started at the brace in
    // `import { initializeApp }` and produced garbage, so the very first screen
    // rejected the exact thing the console told you to copy.
    // Placeholder values here on purpose: real project identifiers belong in
    // the app's own settings, never in this repository.
    test('reads the full console file, imports and all', () => {
      const pasted = `// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyExampleKeyNotReal000000000000000",
  authDomain: "exampleproject.firebaseapp.com",
  projectId: "exampleproject",
  storageBucket: "exampleproject.firebasestorage.app",
  messagingSenderId: "000000000000",
  appId: "1:000000000000:web:abcdef0123456789abcdef",
  measurementId: "G-XXXXXXXXXX"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);`;

      const parsed = parseFirebaseSnippet(pasted);
      assert.ok(parsed, 'the console snippet must parse');
      assert.equal(parsed.apiKey, 'AIzaSyExampleKeyNotReal000000000000000');
      assert.equal(parsed.projectId, 'exampleproject');
      assert.equal(parsed.authDomain, 'exampleproject.firebaseapp.com');
      // appId is full of colons; the bare-key repair must not mangle it.
      assert.equal(parsed.appId, '1:000000000000:web:abcdef0123456789abcdef');
      // Nothing from the import lines should have leaked in.
      assert.equal(parsed.initializeApp, undefined);
    });

    test('is not fooled by braces in import statements alone', () => {
      assert.equal(parseFirebaseSnippet('import { initializeApp } from "firebase/app";'), null);
    });

    test('survives a URL in a comment (// is not always a comment)', () => {
      const parsed = parseFirebaseSnippet(`
        // see https://firebase.google.com/docs
        const firebaseConfig = { apiKey: "k", authDomain: "https://x.example.com" };
      `);
      assert.equal(parsed.apiKey, 'k');
      assert.equal(parsed.authDomain, 'https://x.example.com');
    });

    test('handles a block comment between the imports and the config', () => {
      const parsed = parseFirebaseSnippet(`
        import { initializeApp } from "firebase/app";
        /* multi
           line { brace } comment */
        const firebaseConfig = { apiKey: "abc" };
      `);
      assert.equal(parsed.apiKey, 'abc');
    });

    test('falls back to any object containing an apiKey', () => {
      const parsed = parseFirebaseSnippet('initializeApp({ apiKey: "zzz", projectId: "p" });');
      assert.equal(parsed.apiKey, 'zzz');
    });
  });
});

describe('module registry', () => {
  test('foundations and priority modules are on by default', () => {
    const state = defaultState();
    assert.equal(state.settings, true);
    assert.equal(state.photos, true);
    assert.equal(state.memories, true);
    assert.equal(state.calendar, true);
    assert.equal(state.feed, true);
  });

  test('unbuilt modules are off by default', () => {
    assert.equal(defaultState().recipes, false);
  });

  // If a bad write could switch Settings off, the family would have no way back
  // to the screen that turns it on again.
  test('foundations cannot be switched off, however the saved data looks', () => {
    const state = resolveState({ settings: false, members: false, files: false });
    assert.equal(state.settings, true);
    assert.equal(state.members, true);
    assert.equal(state.files, true);
  });

  test('a module that is only planned cannot be switched on', () => {
    const state = resolveState({ recipes: true });
    assert.equal(state.recipes, false);
    assert.equal(isEnabled(state, 'recipes'), false);
  });

  test('unknown keys in saved settings are ignored', () => {
    const state = resolveState({ nonsense: true });
    assert.equal(state.nonsense, undefined);
  });

  test('turning a module off removes it from navigation', () => {
    const on = navModules(resolveState({ photos: true }));
    const off = navModules(resolveState({ photos: false }));
    assert.ok(on.some((m) => m.key === 'photos'));
    assert.ok(!off.some((m) => m.key === 'photos'));
  });

  test('every module has the fields the UI depends on', () => {
    for (const module of MODULES) {
      assert.ok(module.key, 'key');
      assert.ok(module.title, `title for ${module.key}`);
      assert.ok(module.icon, `icon for ${module.key}`);
      assert.ok(module.desc, `description for ${module.key}`);
      assert.ok(['ready', 'planned'].includes(module.status), `status for ${module.key}`);
    }
  });

  test('module keys are unique', () => {
    const keys = MODULES.map((m) => m.key);
    assert.equal(new Set(keys).size, keys.length);
  });

  test('the four priority modules from the brief are built', () => {
    for (const key of ['photos', 'memories', 'calendar', 'feed']) {
      assert.equal(getModule(key).status, 'ready', `${key} should be ready`);
    }
  });
});

describe('on this day', () => {
  test('builds a zero-padded MM-DD key', () => {
    assert.equal(dayKeyFor(new Date(2021, 0, 5)), '01-05');
    assert.equal(dayKeyFor(new Date(2021, 11, 25)), '12-25');
  });

  test('normally asks for a single day', () => {
    assert.deepEqual(dayKeysForToday(new Date(2025, 5, 10)), ['06-10']);
  });

  // Leap-day photos are exactly the ones you most want resurfaced, and they
  // would otherwise be invisible for three years out of four.
  test('picks up 29 February on 1 March in a non-leap year', () => {
    assert.deepEqual(dayKeysForToday(new Date(2025, 2, 1)), ['03-01', '02-29']);
  });

  test('does not double up in a leap year', () => {
    assert.deepEqual(dayKeysForToday(new Date(2024, 2, 1)), ['03-01']);
  });

  test('knows which years are leap years', () => {
    assert.equal(isLeapYear(2024), true);
    assert.equal(isLeapYear(2025), false);
    assert.equal(isLeapYear(1900), false);   // century, not divisible by 400
    assert.equal(isLeapYear(2000), true);
  });

  test('groups by years ago, oldest label last', () => {
    const today = new Date(2025, 5, 10);
    const groups = groupByYearsAgo([
      { takenAt: new Date(2024, 5, 10).toISOString(), id: 'a' },
      { takenAt: new Date(2021, 5, 10).toISOString(), id: 'b' },
      { takenAt: new Date(2024, 5, 10, 12).toISOString(), id: 'c' },
    ], today);

    assert.equal(groups.length, 2);
    assert.equal(groups[0].yearsAgo, 1);
    assert.equal(groups[0].items.length, 2);
    assert.equal(groups[1].yearsAgo, 4);
  });

  // A photo from this morning is not a memory; including it makes the feature
  // look broken.
  test('ignores photos from the current year', () => {
    const today = new Date(2025, 5, 10);
    const groups = groupByYearsAgo([{ takenAt: new Date(2025, 5, 10).toISOString() }], today);
    assert.equal(groups.length, 0);
  });

  test('ignores records with a missing or unreadable date', () => {
    const groups = groupByYearsAgo(
      [{ takenAt: null }, { takenAt: 'not a date' }, {}],
      new Date(2025, 5, 10),
    );
    assert.equal(groups.length, 0);
  });

  test('reads naturally', () => {
    assert.equal(describeYearsAgo(1), 'Last year');
    assert.equal(describeYearsAgo(4), '4 years ago');
  });
});

describe('drive files', () => {
  test('parses EXIF dates, which are not ISO 8601', () => {
    const date = parseExifDate('2019:07:04 18:30:00');
    assert.equal(date.getFullYear(), 2019);
    assert.equal(date.getMonth(), 6);
    assert.equal(date.getDate(), 4);
  });

  test('rejects junk rather than returning an invalid date', () => {
    assert.equal(parseExifDate('yesterday'), null);
    assert.equal(parseExifDate(undefined), null);
  });

  // This is the one that matters most: PhotoSync uploads a backlog all at once,
  // so createdTime is when it synced, not when the photo was taken. Using it
  // would put a 2019 holiday into this week's memories.
  test('prefers the camera date over the upload date', () => {
    const date = originalDateFor({
      imageMediaMetadata: { time: '2019:07:04 18:30:00' },
      createdTime: '2025-01-01T00:00:00Z',
    });
    assert.equal(date.getFullYear(), 2019);
  });

  test('falls back to Drive timestamps when there is no camera data', () => {
    const date = originalDateFor({ createdTime: '2025-01-02T03:04:05Z' });
    assert.equal(date.getUTCFullYear(), 2025);
    assert.equal(date.getUTCDate(), 2);
  });

  test('returns null rather than inventing a date', () => {
    assert.equal(originalDateFor({}), null);
  });

  test('classifies files by type', () => {
    assert.equal(kindForMime('image/jpeg'), 'photo');
    assert.equal(kindForMime('video/mp4'), 'video');
    assert.equal(kindForMime('application/pdf'), 'document');
    assert.equal(kindForMime('application/zip'), 'other');
  });

  test('builds a pointer record with the date fields the memory feed needs', () => {
    const record = toPointerRecord({
      id: 'abc',
      name: 'beach.jpg',
      mimeType: 'image/jpeg',
      size: '2048',
      imageMediaMetadata: { time: '2019:07:04 18:30:00', width: 4032, height: 3024 },
    }, { folderName: 'Dad’s phone' });

    assert.equal(record.driveId, 'abc');
    assert.equal(record.kind, 'photo');
    assert.equal(record.size, 2048);
    assert.equal(record.dayKey, '07-04');
    assert.equal(new Date(record.takenAt).getFullYear(), 2019);
    // Drive reports the account that owns a shared file, which is usually
    // whoever set the folder up - the subfolder name is the better signal.
    assert.equal(record.owner, 'Dad’s phone');
  });

  test('leaves date fields null when Drive told us nothing', () => {
    const record = toPointerRecord({ id: 'x', name: 'a.bin', mimeType: 'application/octet-stream' });
    assert.equal(record.takenAt, null);
    assert.equal(record.dayKey, null);
  });

  test('ignores a file with no id', () => {
    assert.equal(toPointerRecord({ name: 'orphan' }), null);
  });

  test('sorts newest first, with undated files last', () => {
    const sorted = sortByTakenDesc([
      { id: 'old', takenAt: '2019-01-01T00:00:00.000Z' },
      { id: 'undated', takenAt: null },
      { id: 'new', takenAt: '2024-01-01T00:00:00.000Z' },
    ]);
    assert.deepEqual(sorted.map((r) => r.id), ['new', 'old', 'undated']);
  });

  test('formats sizes for humans', () => {
    assert.equal(formatSize(0), '');
    assert.equal(formatSize(512), '512 B');
    assert.equal(formatSize(2048), '2.0 KB');
    assert.equal(formatSize(5 * 1024 * 1024), '5.0 MB');
  });
});

describe('notification preferences', () => {
  // These import lazily because notifications.js reaches for browser globals
  // that do not exist under node; only the pure parts are exercised here.
  test('categories only cover features that are actually built', async () => {
    const { categories } = await import('../src/notifications.js');
    const { getModule } = await import('../src/modules.js');
    for (const category of categories()) {
      assert.equal(getModule(category.key)?.status, 'ready',
        `${category.key} is offered as a notification category but is not built`);
    }
  });

  test('everything is opted in by default', async () => {
    const { defaultPrefs, categories } = await import('../src/notifications.js');
    const prefs = defaultPrefs();
    assert.equal(Object.keys(prefs).length, categories().length);
    assert.ok(Object.values(prefs).every(Boolean));
  });
});

describe('config: optional push key', () => {
  test('vapidKey is optional and does not block setup', () => {
    assert.deepEqual(validateConfig(validConfig), []);
    assert.equal(normaliseConfig(validConfig).vapidKey, '');
  });

  test('vapidKey is kept when supplied', () => {
    const result = normaliseConfig({ ...validConfig, vapidKey: 'BJ-key' });
    assert.equal(result.vapidKey, 'BJ-key');
  });
});

describe('startup diagnosis', () => {
  // The real body Google returned when Firestore had never been created in the
  // project. This exact response left the app spinning forever with nothing in
  // the console, so it is pinned here verbatim.
  const SERVICE_DISABLED = JSON.stringify({
    error: {
      code: 403,
      message: 'Cloud Firestore API has not been used in project familydashboardedge before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/firestore.googleapis.com/overview?project=familydashboardedge then retry.',
      status: 'PERMISSION_DENIED',
      details: [{ reason: 'SERVICE_DISABLED', domain: 'googleapis.com',
                  metadata: { service: 'firestore.googleapis.com' } }],
    },
  });

  test('recognises a database that was never created', async () => {
    const { interpretFirestoreProbe } = await import('../src/diagnose.js');
    const d = interpretFirestoreProbe({ status: 403, body: SERVICE_DISABLED }, 'familydashboardedge');

    assert.equal(d.code, 'firestore-not-created');
    assert.match(d.detail, /familydashboardedge/);
    assert.match(d.fix, /Create database/i);
    // Deep-links straight to the page that fixes it.
    assert.equal(d.url, 'https://console.firebase.google.com/project/familydashboardedge/firestore');
  });

  // The crucial distinction: a permission 403 means the database is HEALTHY and
  // the rules are doing their job. Confusing the two would tell people to
  // recreate a database that already exists.
  test('does not mistake a rules rejection for a missing database', async () => {
    const { interpretFirestoreProbe } = await import('../src/diagnose.js');
    const d = interpretFirestoreProbe({
      status: 403,
      body: JSON.stringify({ error: { code: 403, message: 'Missing or insufficient permissions.', status: 'PERMISSION_DENIED' } }),
    }, 'p');
    assert.equal(d.code, 'firestore-reachable');
  });

  test('treats 401 as reachable too', async () => {
    const { interpretFirestoreProbe } = await import('../src/diagnose.js');
    assert.equal(interpretFirestoreProbe({ status: 401, body: '' }, 'p').code, 'firestore-reachable');
  });

  test('reports a network failure as offline, not misconfiguration', async () => {
    const { interpretFirestoreProbe } = await import('../src/diagnose.js');
    const d = interpretFirestoreProbe({ networkError: 'Failed to fetch' }, 'p');
    assert.equal(d.code, 'offline');
    assert.match(d.fix, /VPN|ad blocker|online/i);
  });

  test('handles a 404 as a missing database', async () => {
    const { interpretFirestoreProbe } = await import('../src/diagnose.js');
    assert.equal(interpretFirestoreProbe({ status: 404, body: '' }, 'p').code, 'firestore-not-created');
  });

  test('always yields something showable, even for an unexpected status', async () => {
    const { interpretFirestoreProbe } = await import('../src/diagnose.js');
    const d = interpretFirestoreProbe({ status: 500, body: 'boom' }, 'p');
    assert.ok(d.title && d.detail && d.fix);
  });

  test('probeFirestore reports the status without throwing', async () => {
    const { probeFirestore } = await import('../src/diagnose.js');
    const result = await probeFirestore('demo', {
      fetchImpl: async () => ({ status: 403, text: async () => SERVICE_DISABLED }),
    });
    assert.equal(result.status, 403);
    assert.match(result.body, /SERVICE_DISABLED/);
  });

  test('probeFirestore converts a thrown fetch into a network error', async () => {
    const { probeFirestore } = await import('../src/diagnose.js');
    const result = await probeFirestore('demo', {
      fetchImpl: async () => { throw new Error('Failed to fetch'); },
    });
    assert.equal(result.networkError, 'Failed to fetch');
  });

  test('diagnoseStartup end to end on the real failure', async () => {
    const { diagnoseStartup } = await import('../src/diagnose.js');
    const d = await diagnoseStartup(
      { firebase: { projectId: 'familydashboardedge' } },
      { fetchImpl: async () => ({ status: 403, text: async () => SERVICE_DISABLED }) },
    );
    assert.equal(d.code, 'firestore-not-created');
    assert.equal(d.projectId, 'familydashboardedge');
  });
});

describe('drive failure diagnosis', () => {
  const DRIVE_DISABLED = JSON.stringify({
    error: { code: 403, message: 'Google Drive API has not been used in project familydashboardedge before or it is disabled.',
             details: [{ reason: 'SERVICE_DISABLED' }] },
  });

  test('names the Drive API when it is not enabled', async () => {
    const { interpretDriveFailure } = await import('../src/diagnose.js');
    const d = interpretDriveFailure({ status: 403, body: DRIVE_DISABLED }, { projectId: 'familydashboardedge' });
    assert.equal(d.code, 'drive-api-disabled');
    assert.match(d.fix, /Enable/i);
    assert.match(d.url, /drive\.googleapis\.com.*familydashboardedge/);
  });

  // The real hang: Google never answered because the origin was not registered
  // and the account was not a test user. Both must produce actionable text.
  test('explains a refused token as the origin or test-user setting', async () => {
    const { interpretDriveFailure } = await import('../src/diagnose.js');
    const d = interpretDriveFailure(
      { message: 'no_token: Google never answered the request for Drive access.' },
      { projectId: 'p' },
    );
    assert.equal(d.code, 'drive-not-authorised');
    assert.match(d.fix, /Authorised JavaScript origins/i);
    assert.match(d.fix, /Test users/i);
  });

  test('treats a blocked GIS script the same way', async () => {
    const { interpretDriveFailure } = await import('../src/diagnose.js');
    assert.equal(
      interpretDriveFailure({ message: 'token_timeout: Google sign-in did not load.' }, {}).code,
      'drive-not-authorised',
    );
  });

  test('recognises a wrong folder id', async () => {
    const { interpretDriveFailure } = await import('../src/diagnose.js');
    const d = interpretDriveFailure({ status: 404, body: '{}' }, { folderId: 'abc123' });
    assert.equal(d.code, 'drive-folder-missing');
    assert.match(d.detail, /abc123/);
  });

  test('recognises an expired token', async () => {
    const { interpretDriveFailure } = await import('../src/diagnose.js');
    assert.equal(interpretDriveFailure({ status: 401, body: '' }, {}).code, 'drive-expired');
  });

  test('always returns something showable', async () => {
    const { interpretDriveFailure } = await import('../src/diagnose.js');
    for (const f of [{}, null, { status: 500, body: 'boom' }, { message: 'weird' }]) {
      const d = interpretDriveFailure(f, {});
      assert.ok(d.title && d.detail && d.fix, `no usable text for ${JSON.stringify(f)}`);
    }
  });
});

describe('setup links', () => {
  const cfg = {
    familyName: 'Edge',
    firebase: { apiKey: 'k', authDomain: 'a.firebaseapp.com', projectId: 'p', appId: '1:2:web:3' },
    googleClientId: '9.apps.googleusercontent.com',
    driveFolderId: 'folder',
  };

  test('a link round-trips without asking for anything again', async () => {
    const { toSetupLink, parseSetupCode, validateConfig } = await import('../src/config.js');
    const link = toSetupLink(cfg, 'https://example.com/app/');
    const back = parseSetupCode(link);

    assert.deepEqual(validateConfig(back), [], 'a shared link must be complete enough to skip Setup');
    assert.equal(back.firebase.projectId, 'p');
    assert.equal(back.driveFolderId, 'folder');
  });

  // Chat apps wrap and truncate long URLs, so accept whatever survives.
  test('accepts the whole link, the fragment, or just the code', async () => {
    const { toSetupLink, parseSetupCode } = await import('../src/config.js');
    const link = toSetupLink(cfg, 'https://example.com/app/');
    const code = link.split('setup=')[1];

    for (const input of [link, `#setup=${code}`, code, `  ${code}  `]) {
      assert.equal(parseSetupCode(input)?.firebase.projectId, 'p', `failed for: ${input.slice(0, 30)}`);
    }
  });

  test('rejects a truncated link rather than half-configuring a device', async () => {
    const { toSetupLink, parseSetupCode } = await import('../src/config.js');
    const code = toSetupLink(cfg, 'https://example.com/app/').split('setup=')[1];
    assert.equal(parseSetupCode(code.slice(0, 40)), null);
  });

  test('ignores text that is not a setup link', async () => {
    const { parseSetupCode } = await import('../src/config.js');
    for (const junk of ['', 'hello', 'https://example.com/', null, undefined, 'short']) {
      assert.equal(parseSetupCode(junk), null);
    }
  });

  // Length is what gets links mangled in transit, so keep the payload lean.
  test('omits empty fields to keep the link short', async () => {
    const { toSetupLink } = await import('../src/config.js');
    const link = toSetupLink(cfg, 'https://example.com/app/');
    assert.ok(link.length < 400, `link is ${link.length} chars`);

    const code = link.split('setup=')[1];
    const json = Buffer.from(code.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
    assert.ok(!json.includes('""'), `empty values were encoded: ${json}`);
  });
});

// ---------------------------------------------------------------------------
// The photo catalog: who is in a photo, and filtering on it
// ---------------------------------------------------------------------------

describe('csv parsing', () => {
  // The single most important test in this file. Every source path in the face
  // tool output looks like "F:\Pictures,movies,etc\..." - splitting on commas
  // destroys every row, and it destroys them into something that still parses,
  // which is how it would get shipped.
  test('keeps commas that live inside quoted fields', () => {
    const csv = 'source_path,people,tag_count\n'
      + '"F:\\Pictures,movies,etc\\100ANDRO\\DSC_0072.JPG",Jocelyn; Mindy; Toni,3\n';
    const rows = parseCsv(csv);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].source_path, 'F:\\Pictures,movies,etc\\100ANDRO\\DSC_0072.JPG');
    assert.equal(rows[0].tag_count, '3');
  });

  test('handles doubled quotes, CRLF and a missing final newline', () => {
    const csv = 'a,b\r\n"say ""hi""",2\r\nx,3';
    const rows = parseCsv(csv);
    assert.deepEqual(rows, [{ a: 'say "hi"', b: '2' }, { a: 'x', b: '3' }]);
  });

  test('strips a byte order mark from the first header', () => {
    const rows = parseCsv('\uFEFFperson,count\nMatt,1\n');
    assert.equal(rows[0].person, 'Matt');
  });

  test('ignores the blank line exporters leave at the end', () => {
    assert.equal(parseCsv('a,b\n1,2\n\n').length, 1);
  });

  test('returns nothing for empty input rather than throwing', () => {
    assert.deepEqual(parseCsv(''), []);
    assert.deepEqual(parseCsv(null), []);
  });
});

describe('catalog paths and names', () => {
  test('takes the filename off a Windows or POSIX path', () => {
    assert.equal(basenameOf('F:\\Pictures,movies,etc\\100ANDRO\\DSC_0072.JPG'), 'DSC_0072.JPG');
    assert.equal(basenameOf('/home/pics/a.jpg'), 'a.jpg');
    assert.equal(basenameOf('a.jpg'), 'a.jpg');
    assert.equal(basenameOf(''), '');
  });

  test('matches filenames regardless of case', () => {
    assert.equal(catalogKey('F:\\x\\DSC_0072.JPG'), catalogKey('dsc_0072.jpg'));
  });

  test('never produces a key Firestore would reject as a field name', () => {
    assert.ok(!catalogKey('__proto__.jpg').startsWith('__'));
    assert.match(catalogKey('holiday photo (2).jpg'), /^[a-z0-9._-]+$/);
  });

  test('reads both the CSV and the EXIF date formats as local time', () => {
    const a = parseTimestamp('2015-09-11 16:10:42');
    const b = parseTimestamp('2015:09:11 16:10:42');
    assert.equal(a.getFullYear(), 2015);
    assert.equal(a.getMonth(), 8);
    assert.equal(a.getHours(), 16);
    assert.equal(a.getTime(), b.getTime());
    assert.equal(parseTimestamp('not a date'), null);
  });
});

describe('events', () => {
  test('reads a named occasion out of the events bucket', () => {
    assert.deepEqual(parseEventBucket('02_Events/Trips/2014 Cruise'),
      { id: 'trips-2014-cruise', category: 'Trips', name: '2014 Cruise' });
    assert.equal(parseEventBucket('02_Events\\Weddings\\Erica\'s Wedding').name, "Erica's Wedding");
  });

  // A month is not an event. Treating "2015-09" as one would put two hundred
  // meaningless entries in the event menu and bury the ten real ones.
  test('does not turn timeline folders into events', () => {
    assert.equal(parseEventBucket('01_Timeline/2015/2015-09'), null);
    assert.equal(parseEventBucket('01_Timeline'), null);
    assert.equal(parseEventBucket(''), null);
  });
});

describe('building the catalog', () => {
  const personTags = 'source_path,people,tag_count\n'
    + '"F:\\Pics,etc\\100ANDRO\\DSC_0072.JPG",Jocelyn; Mindy; Toni,3\n'
    + '"F:\\Pics,etc\\2014 Cruise\\IMG_0103.JPG",Bradley,1\n'
    + '"F:\\Pics,etc\\loose\\NOINDEX.JPG",Matt,1\n';

  const peopleIndex = 'person,organized_path,source_path,date_used,bucket\n'
    + 'Jocelyn,"F:\\Org\\01_Timeline\\2015\\2015-09\\2015-09-11_161042_Jocelyn_DSC_0072_ae57.jpg","F:\\Pics,etc\\100ANDRO\\DSC_0072.JPG",2015-09-11 16:10:42,01_Timeline/2015/2015-09\n'
    + 'Mindy,"F:\\Org\\01_Timeline\\2015\\2015-09\\2015-09-11_161042_Jocelyn_DSC_0072_ae57.jpg","F:\\Pics,etc\\100ANDRO\\DSC_0072.JPG",2015-09-11 16:10:43,01_Timeline/2015/2015-09\n'
    + 'Bradley,"F:\\Org\\02_Events\\Trips\\2014 Cruise\\2013\\2013-01-01_022957_Bradley_IMG_0103_631d.jpg","F:\\Pics,etc\\2014 Cruise\\IMG_0103.JPG",2013-01-01 02:29:57,02_Events/Trips/2014 Cruise\n';

  test('gives one entry per photo, not one per person', () => {
    const catalog = buildCatalog({ personTags, peopleIndex });
    assert.equal(catalog.count, 3);
  });

  test('unions the people named in either file', () => {
    const { entries } = buildCatalog({ personTags, peopleIndex });
    const photo = entries.find((e) => e.sourceName === 'DSC_0072.JPG');
    assert.deepEqual(photo.people, ['Jocelyn', 'Mindy', 'Toni']);
  });

  test('keeps a photo that only the tag file knows about', () => {
    const { entries } = buildCatalog({ personTags, peopleIndex });
    const loose = entries.find((e) => e.sourceName === 'NOINDEX.JPG');
    assert.deepEqual(loose.people, ['Matt']);
    assert.equal(loose.takenAt, null);
  });

  test('takes the date and the event from the index', () => {
    const { entries } = buildCatalog({ personTags, peopleIndex });
    const cruise = entries.find((e) => e.sourceName === 'IMG_0103.JPG');
    assert.equal(cruise.event.name, '2014 Cruise');
    assert.equal(cruise.event.category, 'Trips');
    assert.equal(new Date(cruise.takenAt).getFullYear(), 2013);
  });

  test('keys on the organised name where there is one', () => {
    const { entries } = buildCatalog({ personTags, peopleIndex });
    const photo = entries.find((e) => e.sourceName === 'DSC_0072.JPG');
    assert.equal(photo.key, '2015-09-11_161042_jocelyn_dsc_0072_ae57.jpg');
  });

  test('counts people and events for the import preview', () => {
    const catalog = buildCatalog({ personTags, peopleIndex });
    assert.equal(catalog.people.length, 5);
    assert.equal(catalog.people[0].count, 1);
    assert.equal(catalog.events.length, 1);
    assert.deepEqual(catalog.years.map((y) => y.year), [2015, 2013]);
  });

  test('warns about photos with no date instead of inventing one', () => {
    const catalog = buildCatalog({ personTags, peopleIndex });
    assert.ok(catalog.warnings.some((w) => w.includes('no date')));
  });

  // One person is spread across dozens of clusters - Jocelyn is about thirty -
  // so a cluster can never be treated as an identity. The file is read for
  // reporting only, and must not add tags of its own.
  test('reads cluster names for reporting without tagging anything', () => {
    const clusterNames = 'cluster,face_count,suggested_person_name,contact_sheet\n'
      + '2,782,Jocelyn,x.jpg\n26,44,Jocelyn,y.jpg\n7,300,,z.jpg\n';
    const catalog = buildCatalog({ personTags, peopleIndex, clusterNames });

    assert.equal(catalog.clusters.total, 3);
    assert.equal(catalog.clusters.named, 2);
    assert.deepEqual(catalog.clusters.people, ['Jocelyn']);
    assert.equal(catalog.count, 3, 'clusters must not create photos');
  });

  test('survives being handed nothing at all', () => {
    const catalog = buildCatalog({});
    assert.equal(catalog.count, 0);
    assert.deepEqual(catalog.people, []);
  });
});

describe('matching the catalog to Drive files', () => {
  const entries = [
    { key: '2015-09-11_161042_a_dsc_0072_ae57.jpg', name: '2015-09-11_161042_a_DSC_0072_ae57.jpg', sourceName: 'DSC_0072.JPG', people: ['Jocelyn'], takenAt: '2015-09-11T16:10:42.000Z', event: null },
    { key: '2016-02-08_172643_b_dsc_0220_54cc.jpg', name: '2016-02-08_172643_b_DSC_0220_54cc.jpg', sourceName: 'DSC_0220.JPG', people: ['Matt'], takenAt: null, event: null },
    { key: '2011-01-02_090000_c_dsc_0220_aaaa.jpg', name: '2011-01-02_090000_c_DSC_0220_aaaa.jpg', sourceName: 'DSC_0220.JPG', people: ['Erica'], takenAt: null, event: null },
  ];

  test('matches the organised filename', () => {
    const lookup = buildLookup(entries);
    assert.equal(matchEntry(lookup, '2015-09-11_161042_a_DSC_0072_ae57.jpg').people[0], 'Jocelyn');
  });

  test('also matches the original camera filename when it is unambiguous', () => {
    const lookup = buildLookup(entries);
    assert.equal(matchEntry(lookup, 'DSC_0072.JPG').people[0], 'Jocelyn');
  });

  // Cameras reuse DSC_0220.JPG every ten thousand shots. Tagging the wrong
  // person into a photo is worse than leaving it untagged, so a name that could
  // mean two photos means neither.
  test('refuses to guess when a camera filename is reused', () => {
    const lookup = buildLookup(entries);
    assert.equal(matchEntry(lookup, 'DSC_0220.JPG'), null);
  });

  test('applies tags to Drive records without overwriting a camera date', () => {
    const lookup = buildLookup(entries);
    const [tagged] = applyCatalog(
      [{ driveId: '1', name: 'DSC_0072.JPG', takenAt: '2001-01-01T00:00:00.000Z', dayKey: '01-01' }],
      lookup,
    );
    assert.deepEqual(tagged.people, ['Jocelyn']);
    assert.equal(tagged.takenAt, '2001-01-01T00:00:00.000Z', 'the camera date must win');
  });

  test('fills in a date only where Drive had none', () => {
    const lookup = buildLookup(entries);
    const [tagged] = applyCatalog([{ driveId: '1', name: 'DSC_0072.JPG', takenAt: null, dayKey: null }], lookup);
    assert.equal(new Date(tagged.takenAt).getFullYear(), 2015);
    assert.ok(tagged.dayKey, 'a filled-in date must also give the memory feed a dayKey');
  });

  test('leaves untagged files exactly as they were', () => {
    const lookup = buildLookup(entries);
    const record = { driveId: '9', name: 'unknown.jpg', takenAt: null };
    assert.equal(applyCatalog([record], lookup)[0], record);
  });

  test('is a no-op when no tags have been imported', () => {
    const records = [{ driveId: '1', name: 'a.jpg' }];
    assert.deepEqual(applyCatalog(records, null), records);
  });
});

describe('catalog storage', () => {
  const entries = Array.from({ length: 701 }, (_, i) => ({
    key: `photo_${i}.jpg`, name: `photo_${i}.jpg`, sourceName: `photo_${i}.jpg`,
    people: i % 2 ? ['Matt'] : [], takenAt: null,
    event: i === 0 ? { id: 'trips-vegas', name: 'Vegas', category: 'Trips' } : null,
  }));

  // A document per photo would be three thousand reads every time someone opens
  // Photos. Chunking makes it ten.
  test('splits into chunks and comes back unchanged', () => {
    const chunks = toChunks(entries);
    assert.equal(chunks.length, 3);
    assert.equal(chunks[0].id, 'chunk_000');

    const round = fromChunks(chunks);
    assert.equal(round.length, entries.length);

    const first = round.find((e) => e.key === 'photo_0.jpg');
    assert.deepEqual(first.event, { id: 'trips-vegas', name: 'Vegas', category: 'Trips' });
    assert.deepEqual(round.find((e) => e.key === 'photo_1.jpg').people, ['Matt']);
  });

  test('chunk ids sort in order, so a hundred chunks do not shuffle', () => {
    const ids = toChunks(Array.from({ length: 3001 }, (_, i) => ({ key: `p${i}`, name: `p${i}` })))
      .map((c) => c.id);
    assert.deepEqual([...ids].sort(), ids);
  });

  test('leaves out fields that are empty, since they repeat thousands of times', () => {
    const packed = packEntry({ key: 'a.jpg', name: 'a.jpg', sourceName: 'a.jpg', people: [], takenAt: null, event: null });
    assert.deepEqual(Object.keys(packed), ['n']);
  });
});

describe('photo filters', () => {
  const photos = [
    { driveId: '1', name: 'a.jpg', kind: 'photo', folder: 'Matt', people: ['Jocelyn', 'Mindy'], takenAt: '2010-07-04T12:00:00.000Z', event: { id: 'trips-vegas', name: 'Vegas', category: 'Trips' } },
    { driveId: '2', name: 'b.jpg', kind: 'photo', folder: 'Matt', people: ['Jocelyn'], takenAt: '2010-08-04T12:00:00.000Z', event: null },
    { driveId: '3', name: 'c.mp4', kind: 'video', folder: 'Erica', people: ['Mindy'], takenAt: '2016-07-04T12:00:00.000Z', event: null },
    { driveId: '4', name: 'd.jpg', kind: 'photo', folder: 'Erica', people: [], takenAt: null, event: null },
  ];

  test('no filters means everything', () => {
    assert.equal(filterPhotos(photos, emptyFilters()).length, 4);
  });

  test('two people means the two of them together', () => {
    const found = filterPhotos(photos, { ...emptyFilters(), people: ['Jocelyn', 'Mindy'] });
    assert.deepEqual(found.map((p) => p.driveId), ['1']);
  });

  test('the "either" mode widens it to any of them', () => {
    const found = filterPhotos(photos, { ...emptyFilters(), people: ['Jocelyn', 'Mindy'], peopleMode: PEOPLE_MODE.ANY });
    assert.deepEqual(found.map((p) => p.driveId), ['1', '2', '3']);
  });

  test('person names match whatever case they were typed in', () => {
    assert.equal(filterPhotos(photos, { ...emptyFilters(), people: ['jocelyn'] }).length, 2);
  });

  // The whole reason for filtering in the browser: Firestore cannot answer this
  // without a composite index per combination.
  test('combines person, year and month at once', () => {
    const found = filterPhotos(photos, { ...emptyFilters(), people: ['Jocelyn'], year: 2010, month: 7 });
    assert.deepEqual(found.map((p) => p.driveId), ['1']);
  });

  test('a month on its own means that month in any year', () => {
    const found = filterPhotos(photos, { ...emptyFilters(), month: 7 });
    assert.deepEqual(found.map((p) => p.driveId), ['1', '3']);
  });

  test('filters by event, type and folder', () => {
    assert.equal(filterPhotos(photos, { ...emptyFilters(), event: 'trips-vegas' }).length, 1);
    assert.equal(filterPhotos(photos, { ...emptyFilters(), kind: 'video' }).length, 1);
    assert.equal(filterPhotos(photos, { ...emptyFilters(), folder: 'Erica' }).length, 2);
  });

  test('finds untagged photos, which is how you know what still needs naming', () => {
    const found = filterPhotos(photos, { ...emptyFilters(), untaggedOnly: true });
    assert.deepEqual(found.map((p) => p.driveId), ['4']);
  });

  // Someone typing "vegas" has no idea whether that is an event, a folder or
  // part of the filename.
  test('search looks across people, events, folders and filenames', () => {
    assert.equal(filterPhotos(photos, { ...emptyFilters(), text: 'vegas' }).length, 1);
    assert.equal(filterPhotos(photos, { ...emptyFilters(), text: 'mindy' }).length, 2);
    assert.equal(filterPhotos(photos, { ...emptyFilters(), text: 'erica' }).length, 2);
    assert.equal(filterPhotos(photos, { ...emptyFilters(), text: 'jocelyn vegas' }).length, 1);
    assert.equal(filterPhotos(photos, { ...emptyFilters(), text: 'nobody' }).length, 0);
  });

  test('a photo with no date is excluded by a year filter, not crashed on', () => {
    assert.equal(filterPhotos(photos, { ...emptyFilters(), year: 2010 }).length, 2);
  });
});

describe('filter facets', () => {
  const photos = [
    { name: 'a.jpg', kind: 'photo', folder: 'Matt', people: ['Jocelyn', 'Mindy'], takenAt: '2010-07-04T12:00:00.000Z', event: { id: 'trips-vegas', name: 'Vegas', category: 'Trips' } },
    { name: 'b.jpg', kind: 'photo', folder: 'Matt', people: ['Jocelyn'], takenAt: '2010-08-04T12:00:00.000Z', event: null },
    { name: 'd.jpg', kind: 'photo', folder: 'Erica', people: [], takenAt: null, event: null },
  ];

  test('offers only choices that will return something, with counts', () => {
    const facets = buildFacets(photos);
    assert.deepEqual(facets.people.map((p) => [p.label, p.count]), [['Jocelyn', 2], ['Mindy', 1]]);
    assert.deepEqual(facets.years.map((y) => y.value), [2010]);
    assert.deepEqual(facets.events.map((e) => e.label), ['Vegas']);
    assert.equal(facets.untagged, 1);
    assert.equal(facets.tagged, 2);
  });

  test('an empty library produces empty menus rather than throwing', () => {
    const facets = buildFacets([]);
    assert.deepEqual(facets.people, []);
    assert.equal(facets.total, 0);
  });
});

describe('describing the active filters', () => {
  test('one chip per active filter, and removing one leaves the rest', () => {
    const filters = { ...emptyFilters(), people: ['Jocelyn', 'Mindy'], year: 2010, text: 'beach' };
    const chips = describeFilters(filters);
    assert.deepEqual(chips.filter((c) => c.field === 'people').map((c) => c.label), ['Jocelyn', 'Mindy']);

    const next = clearFilter(filters, 'people', 'Mindy');
    assert.deepEqual(next.people, ['Jocelyn']);
    assert.equal(next.year, 2010, 'removing a person must not clear the year');
  });

  test('the together/either chip flips rather than clearing', () => {
    const filters = { ...emptyFilters(), people: ['A', 'B'] };
    assert.equal(clearFilter(filters, 'peopleMode').peopleMode, PEOPLE_MODE.ANY);
  });

  test('knows when nothing is filtered', () => {
    assert.equal(hasActiveFilters(emptyFilters()), false);
    assert.equal(hasActiveFilters({ ...emptyFilters(), text: '  ' }), false);
    assert.equal(hasActiveFilters({ ...emptyFilters(), year: 2010 }), true);
  });

  test('counts read the way a person would say them', () => {
    assert.equal(describeCount(3, 3), '3 items');
    assert.equal(describeCount(1, 1), '1 item');
    assert.match(describeCount(3, 2907), /^3 of 2,907$/);
  });
});

describe('recognising the face-tool files', () => {
  // By columns, not by filename: "people_index_v2 (1).csv" is still the people
  // index, and asking the family to rename their downloads is not a design.
  test('identifies each file from its header row', () => {
    assert.equal(detectCsvRole('source_path,people,tag_count\n"a,b",Matt,1\n'), 'personTags');
    assert.equal(detectCsvRole('person,organized_path,source_path,date_used,bucket\nMatt,a,b,,\n'), 'peopleIndex');
    assert.equal(detectCsvRole('cluster,face_count,suggested_person_name,contact_sheet\n0,1,Matt,x\n'), 'clusterNames');
  });

  test('refuses anything else rather than importing nonsense', () => {
    assert.equal(detectCsvRole('name,email\nMatt,a@b.c\n'), null);
    assert.equal(detectCsvRole(''), null);
  });
});

describe('offline shell', () => {
  // A module missing from the service worker's list is invisible until someone
  // opens the app with no signal, which is the worst possible moment to find out.
  test('every source file is in the service worker cache list', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');

    const dir = new URL('../src/', import.meta.url);
    const files = [];
    for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (entry.isFile() && entry.name.endsWith('.js')) {
        const sub = entry.parentPath ?? entry.path ?? '';
        const folder = sub.includes('views') ? 'views/' : '';
        files.push(`./src/${folder}${entry.name}`);
      }
    }

    assert.ok(files.length > 15, `expected to find the source files, got ${files.length}`);
    for (const file of files) {
      assert.ok(sw.includes(`'${file}'`), `${file} is missing from the sw.js shell list`);
    }
  });
});

// ---------------------------------------------------------------------------
// Corrections made by hand
// ---------------------------------------------------------------------------

describe('applying corrections', () => {
  const records = [
    { driveId: '1', name: 'a.jpg', people: ['Jocelyn'], event: null, takenAt: '2010-07-04T12:00:00.000Z', dayKey: '07-04' },
    { driveId: '2', name: 'b.jpg', people: [], event: null, takenAt: null, dayKey: null },
  ];

  test('an override replaces what the catalog said', () => {
    const edits = new Map([['1', { driveId: '1', people: ['Jocelyn', 'Mindy'] }]]);
    const [first] = applyEdits(records, edits);
    assert.deepEqual(first.people, ['Jocelyn', 'Mindy']);
    assert.equal(first.takenAt, '2010-07-04T12:00:00.000Z', 'an untouched field must be left alone');
    assert.equal(first.edited, true);
  });

  // The distinction the whole file exists for: a date explicitly cleared is not
  // the same as a date nobody has touched.
  test('a cleared date is an override, not a missing key', () => {
    const [first] = applyEdits(records, new Map([['1', { driveId: '1', takenAt: null }]]));
    assert.equal(first.takenAt, null);
    assert.equal(first.dayKey, null, 'clearing a date must take it out of Memories too');
  });

  test('a corrected date reaches the memory feed', () => {
    const [, second] = applyEdits(records, new Map([['2', { driveId: '2', takenAt: '1999-03-17T12:00:00.000Z' }]]));
    assert.equal(second.dayKey, '03-17');
  });

  test('removing everyone is a real answer, not an empty edit', () => {
    const [first] = applyEdits(records, new Map([['1', { driveId: '1', people: [] }]]));
    assert.deepEqual(first.people, []);
  });

  test('photos with no correction are returned untouched', () => {
    const out = applyEdits(records, new Map([['1', { driveId: '1', people: ['X'] }]]));
    assert.equal(out[1], records[1]);
  });

  test('no corrections at all is a no-op', () => {
    assert.equal(applyEdits(records, new Map()), records);
    assert.equal(applyEdits(records, null), records);
  });
});

describe('building a correction', () => {
  const shown = { people: ['Jocelyn'], event: null, takenAt: '2010-07-04T12:00:00.000Z' };

  test('stores only the fields that were actually changed', () => {
    const edit = buildEdit({
      driveId: '1', shown,
      values: { ...shown, people: ['Jocelyn', 'Mindy'] },
    });
    assert.deepEqual(edit.people, ['Jocelyn', 'Mindy']);
    assert.equal(Object.hasOwn(edit, 'takenAt'), false, 'an unchanged date must not become an override');
    assert.equal(Object.hasOwn(edit, 'event'), false);
  });

  test('changing nothing produces no correction at all', () => {
    assert.equal(buildEdit({ driveId: '1', shown, values: { ...shown } }), null);
  });

  // Without this, correcting the same photo twice would silently drop the first
  // correction: the second edit compares against the already-corrected values,
  // sees no change, and writes nothing for that field.
  test('keeps an existing override when this pass did not touch that field', () => {
    const existing = { driveId: '1', people: ['Jocelyn', 'Mindy'] };
    const edit = buildEdit({
      driveId: '1', existing,
      shown: { ...shown, people: ['Jocelyn', 'Mindy'] },
      values: { people: ['Jocelyn', 'Mindy'], event: null, takenAt: '1999-01-01T12:00:00.000Z' },
    });
    assert.deepEqual(edit.people, ['Jocelyn', 'Mindy'], 'the earlier correction must survive');
    assert.equal(edit.takenAt, '1999-01-01T12:00:00.000Z');
  });

  test('an order-only difference in the people list is not a change', () => {
    const edit = buildEdit({
      driveId: '1',
      shown: { people: ['Mindy', 'Jocelyn'] },
      values: { people: ['Jocelyn', 'Mindy'] },
    });
    assert.equal(edit, null);
  });

  test('clearing a date that had one is a change', () => {
    const edit = buildEdit({ driveId: '1', shown, values: { ...shown, takenAt: null } });
    assert.equal(Object.hasOwn(edit, 'takenAt'), true);
    assert.equal(edit.takenAt, null);
  });

  test('records who made the correction and when', () => {
    const edit = buildEdit({ driveId: '1', name: 'a.jpg', shown, values: { ...shown, people: [] }, by: 'uid-1' });
    assert.equal(edit.editedBy, 'uid-1');
    assert.equal(edit.name, 'a.jpg');
    assert.ok(!Number.isNaN(new Date(edit.editedAt).getTime()));
  });

  // Uploads compare against nothing, so a blank form must not write a document.
  test('an untouched form on upload writes nothing', () => {
    assert.equal(buildEdit({ driveId: 'new', shown: {}, values: { people: [], event: null, takenAt: null } }), null);
  });

  test('a filled-in form on upload writes what was filled in', () => {
    const edit = buildEdit({ driveId: 'new', shown: {}, values: { people: ['Matt'], event: null, takenAt: null } });
    assert.deepEqual(edit.people, ['Matt']);
    assert.equal(Object.hasOwn(edit, 'takenAt'), false);
  });

  test('knows an emptied correction can be deleted', () => {
    assert.equal(isEmptyEdit(null), true);
    assert.equal(isEmptyEdit({ driveId: '1', editedAt: 'x' }), true);
    assert.equal(isEmptyEdit({ driveId: '1', people: [] }), false);
  });

  test('names the corrected fields for the viewer', () => {
    assert.deepEqual(editedFields({ people: [], takenAt: null }), ['people', 'takenAt']);
  });
});

describe('typing a person in', () => {
  test('matches a known name whatever case it was typed in', () => {
    assert.equal(normalisePersonName('  jocelyn ', ['Jocelyn', 'Matt']), 'Jocelyn');
  });

  test('allows a name nobody has used before', () => {
    assert.equal(normalisePersonName('Aunt Nell', ['Jocelyn']), 'Aunt Nell');
  });

  test('collapses runs of whitespace', () => {
    assert.equal(normalisePersonName('Bobbi   Jean', []), 'Bobbi Jean');
  });

  test('refuses blanks and absurd lengths', () => {
    assert.equal(normalisePersonName('   ', []), null);
    assert.equal(normalisePersonName('x'.repeat(61), []), null);
    assert.equal(normalisePersonName(null, []), null);
  });

  test('adding is sorted and never duplicates', () => {
    assert.deepEqual(addPerson(['Mindy'], 'Jocelyn'), ['Jocelyn', 'Mindy']);
    assert.deepEqual(addPerson(['Jocelyn'], 'jocelyn'), ['Jocelyn'], 'case must not create a second person');
  });

  test('removing is case-insensitive too', () => {
    assert.deepEqual(removePerson(['Jocelyn', 'Mindy'], 'JOCELYN'), ['Mindy']);
  });
});

describe('editing a date', () => {
  // toISOString() converts to UTC first, so an evening photo would show the
  // next day's date east of Greenwich - and editing it would move the photo.
  test('the date field shows the local day, not the UTC one', () => {
    const evening = new Date(2015, 8, 11, 22, 30, 0);
    assert.equal(toDateInput(evening.toISOString()), '2015-09-11');
    assert.equal(toTimeInput(evening.toISOString()), '22:30');
  });

  test('an empty or unparseable date gives empty fields', () => {
    assert.equal(toDateInput(null), '');
    assert.equal(toDateInput('not a date'), '');
    assert.equal(toTimeInput(null), '');
  });

  test('reads the fields back to the same local day', () => {
    const iso = fromDateInput('2015-09-11', '22:30');
    const back = new Date(iso);
    assert.equal(back.getFullYear(), 2015);
    assert.equal(back.getMonth(), 8);
    assert.equal(back.getDate(), 11);
    assert.equal(back.getHours(), 22);
  });

  // Midday, not midnight: a timezone or daylight-saving shift at midnight rolls
  // the photo into the day before, which for "on this day" is the whole bug.
  test('a date with no time lands at midday so it cannot roll backwards', () => {
    assert.equal(new Date(fromDateInput('2015-09-11')).getHours(), 12);
    assert.equal(new Date(fromDateInput('2015-09-11')).getDate(), 11);
  });

  test('a round trip through both helpers is stable', () => {
    const iso = fromDateInput('2004-02-29', '08:05');
    assert.equal(toDateInput(iso), '2004-02-29');
    assert.equal(toTimeInput(iso), '08:05');
  });

  test('refuses a date that does not exist rather than rolling it over', () => {
    assert.equal(fromDateInput('2015-02-30'), null);
    assert.equal(fromDateInput('2015-13-01'), null);
    assert.equal(fromDateInput(''), null);
    assert.equal(fromDateInput('11/09/2015'), null);
  });
});

describe('typing an event in', () => {
  test('a bare name is enough', () => {
    assert.deepEqual(parseEventInput('Isle of Skye'), { id: 'isle-of-skye', category: null, name: 'Isle of Skye' });
  });

  test('a slash files it under a category', () => {
    assert.deepEqual(parseEventInput(' Trips / Vegas '), { id: 'trips-vegas', category: 'Trips', name: 'Vegas' });
  });

  test('an id built here matches one built from an imported bucket', () => {
    assert.equal(parseEventInput('Trips / 2014 Cruise').id, parseEventBucket('02_Events/Trips/2014 Cruise').id);
  });

  test('refuses input with no name in it', () => {
    assert.equal(parseEventInput(''), null);
    assert.equal(parseEventInput('  /  '), null);
    assert.equal(parseEventInput('!!!'), null);
  });
});

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

describe('invitation codes', () => {
  // This string is the only thing between a stranger and the family's photos.
  test('comes from the cryptographic source, not Math.random', () => {
    const bytes = [];
    generateCode((n) => {
      const out = crypto.getRandomValues(new Uint8Array(n));
      bytes.push(n);
      return out;
    });
    assert.ok(bytes.length > 0, 'the injected source must actually be used');
  });

  test('is long, and avoids characters people misread', () => {
    const code = generateCode();
    assert.equal(code.length, 20);
    assert.match(code, /^[a-hj-km-np-z2-9]+$/, 'no 0/O/1/l/i to mistype');
  });

  test('does not repeat', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateCode()));
    assert.equal(seen.size, 500);
  });

  // A byte modulo a 31-letter alphabet would make the first few letters more
  // likely than the rest; the sampler rejects the tail instead.
  test('spreads evenly across the alphabet', () => {
    const counts = new Map();
    for (let i = 0; i < 400; i += 1) {
      for (const ch of generateCode()) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
    const values = [...counts.values()];
    assert.equal(counts.size, 31, 'every letter should turn up');
    assert.ok(Math.max(...values) / Math.min(...values) < 2, 'distribution is lopsided');
  });
});

describe('building an invitation', () => {
  const now = Date.UTC(2026, 0, 1);

  test('an address binds the invitation to that account', () => {
    const invitation = buildInvitation({ code: 'abc', email: '  Someone@Example.COM ', now });
    assert.equal(invitation.email, 'someone@example.com');
  });

  // The rules check `email == null` to decide whether an invitation is bound,
  // and an empty string is not null.
  test('no address is stored as null, never as an empty string', () => {
    assert.equal(buildInvitation({ code: 'abc', email: '', now }).email, null);
    assert.equal(buildInvitation({ code: 'abc', now }).email, null);
  });

  // Epoch millis rather than an ISO string, because a security rule cannot
  // parse a string into a timestamp to compare against request.time.
  test('the expiry is a number the security rules can compare', () => {
    const invitation = buildInvitation({ code: 'abc', now });
    assert.equal(typeof invitation.expiresAt, 'number');
    assert.equal(invitation.expiresAt, now + 14 * 86_400_000);
  });

  test('refuses something that is not an address', () => {
    assert.throws(() => buildInvitation({ code: 'abc', email: 'not an email' }));
  });

  test('starts unused and uncancelled', () => {
    const invitation = buildInvitation({ code: 'abc', now });
    assert.equal(invitation.usedBy, null);
    assert.equal(invitation.revoked, false);
  });
});

describe('checking an invitation', () => {
  const now = Date.UTC(2026, 0, 1);
  const live = buildInvitation({ code: 'abc', email: 'her@example.com', now });

  test('accepts the account it was sent to', () => {
    assert.equal(checkInvitation(live, { email: 'her@example.com', now: now + 1000 }).ok, true);
  });

  test('matches the address whatever case it was typed in', () => {
    assert.equal(checkInvitation(live, { email: 'HER@Example.com', now: now + 1000 }).ok, true);
  });

  // The reason a bound invitation exists: a forwarded link is worthless.
  test('refuses a different account, and says which one it wants', () => {
    const verdict = checkInvitation(live, { email: 'him@example.com', now: now + 1000 });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'wrong-account');
    assert.match(verdict.message, /her@example\.com/);
  });

  test('an unbound invitation takes anyone', () => {
    const open = buildInvitation({ code: 'abc', now });
    assert.equal(checkInvitation(open, { email: 'anyone@example.com', now: now + 1000 }).ok, true);
  });

  test('refuses expired, used, cancelled and missing ones', () => {
    assert.equal(checkInvitation(live, { email: 'her@example.com', now: now + 15 * 86_400_000 }).reason, 'expired');
    assert.equal(checkInvitation({ ...live, usedBy: 'someone' }, { email: 'her@example.com', now }).reason, 'used');
    assert.equal(checkInvitation({ ...live, revoked: true }, { email: 'her@example.com', now }).reason, 'revoked');
    assert.equal(checkInvitation(null, { now }).reason, 'unknown');
  });

  test('every refusal says something a person can act on', () => {
    for (const invitation of [null, { ...live, revoked: true }, { ...live, usedBy: 'x' }]) {
      const verdict = checkInvitation(invitation, { email: 'her@example.com', now });
      assert.ok(verdict.message.length > 20, `unhelpful message: ${verdict.message}`);
    }
  });
});

describe('invitation status', () => {
  const now = Date.UTC(2026, 0, 1);

  test('reads the way a person would say it', () => {
    const invitation = buildInvitation({ code: 'abc', now });
    assert.equal(describeInvitation(invitation, now).label, '14 days left');
    assert.equal(describeInvitation(invitation, now + 13.5 * 86_400_000).label, 'Expires today');
    assert.equal(describeInvitation({ ...invitation, usedBy: 'x' }, now).label, 'Joined');
    assert.equal(describeInvitation({ ...invitation, revoked: true }, now).label, 'Cancelled');
    assert.equal(describeInvitation(invitation, now + 20 * 86_400_000).label, 'Expired');
  });
});

describe('invitation links', () => {
  const cfg = {
    familyName: 'The Smiths',
    firebase: { apiKey: 'k', authDomain: 'x.firebaseapp.com', projectId: 'p', appId: 'a' },
    googleClientId: '123.apps.googleusercontent.com',
    driveFolderId: 'folder123',
  };

  test('carries both the settings and the code', async () => {
    const { toSetupLink, parseSetupCode } = await import('../src/config.js');
    const link = toInviteLink(toSetupLink(cfg, 'https://example.com/app/'), 'abcd1234');

    assert.equal(parseInviteCode(link), 'abcd1234');
    assert.equal(parseSetupCode(link)?.firebase.projectId, 'p', 'the settings must still parse');
  });

  // An expired invitation should still configure the device, so the recipient
  // can ask for a new code instead of being sent to the Firebase console.
  test('the settings survive even if the invitation part is junk', async () => {
    const { toSetupLink, parseSetupCode } = await import('../src/config.js');
    const link = `${toSetupLink(cfg, 'https://example.com/app/')}&invite=`;
    assert.equal(parseSetupCode(link)?.firebase.projectId, 'p');
  });

  test('reads a code from a bare fragment as well as a whole link', () => {
    assert.equal(parseInviteCode('#setup=xyz&invite=abcd1234'), 'abcd1234');
    assert.equal(parseInviteCode('?invite=abcd1234'), 'abcd1234');
  });

  test('finds no code where there is none', () => {
    for (const junk of ['', 'https://example.com/', '#setup=xyz', null, undefined]) {
      assert.equal(parseInviteCode(junk), null);
    }
  });

  test('a link with no code is left alone', () => {
    assert.equal(toInviteLink('https://example.com/#setup=x', null), 'https://example.com/#setup=x');
  });

  test('the message puts the link on its own line so apps make it tappable', () => {
    const message = inviteMessage({ familyName: 'the Smiths', fromName: 'Matt', link: 'https://x.example/#setup=a&invite=b' });
    assert.ok(message.includes('\nhttps://x.example/#setup=a&invite=b\n'));
    assert.match(message, /Matt/);
  });
});

// ---------------------------------------------------------------------------
// Which device is this, and can it install
// ---------------------------------------------------------------------------

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  ipad: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  iosChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1',
  facebook: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/468.0.0.35.107]',
  instagram: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 328.0.3.28.90',
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  androidWebView: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
};

describe('working out which device this is', () => {
  test('an iPhone is an iPhone', () => {
    assert.equal(detectPlatform({ ua: UA.iphone, maxTouchPoints: 5, platform: 'iPhone' }).os, OS.IOS);
  });

  // iPadOS has reported itself as a Mac since iPadOS 13. Getting this wrong
  // sends an iPad down the desktop path, where none of the advice applies.
  test('an iPad calling itself a Mac is still iOS', () => {
    const ipad = detectPlatform({ ua: UA.ipad, maxTouchPoints: 5, platform: 'MacIntel' });
    assert.equal(ipad.os, OS.IOS);
  });

  test('a real Mac with the same user agent is not', () => {
    const mac = detectPlatform({ ua: UA.macSafari, maxTouchPoints: 0, platform: 'MacIntel' });
    assert.equal(mac.os, OS.DESKTOP);
  });

  test('Android and desktop are told apart', () => {
    assert.equal(detectPlatform({ ua: UA.androidChrome, maxTouchPoints: 5, platform: 'Linux armv8l' }).os, OS.ANDROID);
    assert.equal(detectPlatform({ ua: UA.windows, maxTouchPoints: 0, platform: 'Win32' }).os, OS.DESKTOP);
  });

  // The failure that actually bites: an invitation arrives in a messaging app,
  // whose browser has no "add to home screen" at all.
  test('spots the browsers built into other apps', () => {
    assert.equal(detectPlatform({ ua: UA.facebook, maxTouchPoints: 5, platform: 'iPhone' }).inApp, true);
    assert.equal(detectPlatform({ ua: UA.instagram, maxTouchPoints: 5, platform: 'iPhone' }).inApp, true);
    assert.equal(detectPlatform({ ua: UA.androidWebView, maxTouchPoints: 5, platform: 'Linux armv8l' }).inApp, true);
  });

  test('and does not mistake a real browser for one', () => {
    assert.equal(detectPlatform({ ua: UA.iphone, maxTouchPoints: 5, platform: 'iPhone' }).inApp, false);
    assert.equal(detectPlatform({ ua: UA.iosChrome, maxTouchPoints: 5, platform: 'iPhone' }).inApp, false);
    assert.equal(detectPlatform({ ua: UA.androidChrome, maxTouchPoints: 5, platform: 'Linux armv8l' }).inApp, false);
  });

  test('Android Chrome is not Safari, and iOS Safari is not Chromium', () => {
    assert.equal(detectPlatform({ ua: UA.androidChrome, platform: 'Linux armv8l' }).isSafari, false);
    assert.equal(detectPlatform({ ua: UA.iphone, maxTouchPoints: 5, platform: 'iPhone' }).isChromium, false);
  });
});

describe('what to tell someone about installing', () => {
  const probeFor = (ua, extra = {}) => ({ ua, maxTouchPoints: 5, platform: 'iPhone', ...extra });

  // No API for this has ever existed on iOS, so the only honest answer is the
  // two taps, named exactly.
  test('iPhone gets the Share sheet steps, never a fake install button', () => {
    const guidance = installGuidance({ probe: probeFor(UA.iphone), canPrompt: false });
    assert.equal(guidance.mode, 'manual');
    assert.equal(guidance.steps.length, 2);
    assert.match(guidance.steps.join(' '), /Share/);
    assert.match(guidance.steps.join(' '), /Add to Home Screen/);
  });

  test('Android with a captured prompt gets the real one-tap button', () => {
    const guidance = installGuidance({
      probe: probeFor(UA.androidChrome, { platform: 'Linux armv8l' }), canPrompt: true,
    });
    assert.equal(guidance.mode, 'prompt');
    assert.equal(guidance.steps.length, 0);
  });

  test('Android without one falls back to the menu rather than a dead button', () => {
    const guidance = installGuidance({
      probe: probeFor(UA.androidChrome, { platform: 'Linux armv8l' }), canPrompt: false,
    });
    assert.equal(guidance.mode, 'manual');
    assert.ok(guidance.steps.length > 0);
  });

  test('inside another app it says get out of here first, and offers the link', () => {
    const guidance = installGuidance({ probe: probeFor(UA.facebook), canPrompt: false });
    assert.equal(guidance.mode, 'escape');
    assert.equal(guidance.copyLink, true);
    assert.match(guidance.steps.join(' '), /Safari/);
  });

  test('the Android version of that says Chrome, not Safari', () => {
    const guidance = installGuidance({
      probe: probeFor(UA.androidWebView, { platform: 'Linux armv8l' }), canPrompt: false,
    });
    assert.equal(guidance.mode, 'escape');
    assert.match(guidance.steps.join(' '), /Chrome/);
  });

  // A computer should just open the dashboard and ask them to sign in.
  test('a desktop is never asked to install anything', () => {
    assert.equal(installGuidance({ probe: probeFor(UA.windows, { platform: 'Win32', maxTouchPoints: 0 }), canPrompt: true }).mode, 'none');
    assert.equal(shouldOfferInstall({ ua: UA.windows, platform: 'Win32', maxTouchPoints: 0 }), false);
  });

  test('but a phone is', () => {
    assert.equal(shouldOfferInstall({ ua: UA.iphone, platform: 'iPhone', maxTouchPoints: 5 }), true);
    assert.equal(shouldOfferInstall({ ua: UA.androidChrome, platform: 'Linux armv8l', maxTouchPoints: 5 }), true);
  });
});

// ---------------------------------------------------------------------------
// Dating a photo whose camera metadata was stripped
// ---------------------------------------------------------------------------

describe('reading a date out of a filename', () => {
  const now = new Date(2026, 6, 25);

  // Only about half this family's archive carries a "Date taken" - anything
  // through a messaging app or a Takeout export has lost it. Without this those
  // photos fall back to the upload date and a 2008 birthday lands in this
  // week's Memories.
  test('reads the organiser format', () => {
    const date = dateFromFilename('2015-09-11_161042_Jocelyn_DSC_0088_ae577ab9.jpg', { now });
    assert.equal(date.getFullYear(), 2015);
    assert.equal(date.getMonth(), 8);
    assert.equal(date.getDate(), 11);
    assert.equal(date.getHours(), 16);
    assert.equal(date.getMinutes(), 10);
  });

  test('reads the formats phones and messaging apps produce', () => {
    for (const [name, iso] of [
      ['IMG_20150911_161042.jpg', '2015-09-11'],
      ['VID-20150911-WA0002.mp4', '2015-09-11'],
      ['Screenshot_2015-09-11-16-10-42.png', '2015-09-11'],
      ['2015.09.11 birthday.jpg', '2015-09-11'],
    ]) {
      const date = dateFromFilename(name, { now });
      assert.ok(date, `no date found in ${name}`);
      assert.equal(
        `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
        iso, `wrong date for ${name}`,
      );
    }
  });

  test('a date with no time lands at midday, not midnight', () => {
    assert.equal(dateFromFilename('2015.09.11 birthday.jpg', { now }).getHours(), 12);
  });

  // A filename is a guess, and a wrong guess is worse than none: it would put a
  // photo on a specific day in Memories with nothing to say it was invented.
  test('refuses dates that are not dates', () => {
    for (const name of [
      'IMG_1234.jpg',            // a counter, not a date
      '1234-56-78.jpg',          // month 56
      '2015-02-30_x.jpg',        // a day February never has
      '2015-11-31_x.jpg',        // a day November never has
      '1985-06-01_x.jpg',        // before the range digital photos exist in
      'DSC_0088.JPG',
      '',
    ]) {
      assert.equal(dateFromFilename(name, { now }), null, `should not have parsed ${name}`);
    }
  });

  test('refuses a date in the future, which is a version number', () => {
    assert.equal(dateFromFilename('report-2030-01-01.jpg', { now }), null);
  });

  test('accepts a leap day in a leap year and refuses it otherwise', () => {
    assert.ok(dateFromFilename('2016-02-29_x.jpg', { now }));
    assert.equal(dateFromFilename('2015-02-29_x.jpg', { now }), null);
  });
});

describe('which date wins', () => {
  const exif = { id: '1', name: '2015-09-11_161042_x.jpg', mimeType: 'image/jpeg',
    imageMediaMetadata: { time: '2001:01:01 08:00:00' }, createdTime: '2024-05-05T00:00:00Z' };

  test('the camera beats the filename', () => {
    assert.equal(originalDateFor(exif).getFullYear(), 2001);
  });

  // The whole point: createdTime on a bulk upload is the day it was uploaded.
  test('the filename beats the upload date', () => {
    const { imageMediaMetadata, ...noExif } = exif;
    assert.equal(originalDateFor(noExif).getFullYear(), 2015);
  });

  test('the upload date is still there as a last resort', () => {
    const bare = { id: '1', name: 'DSC_0088.JPG', mimeType: 'image/jpeg', createdTime: '2024-05-05T00:00:00Z' };
    assert.equal(originalDateFor(bare).getFullYear(), 2024);
  });

  test('a pointer record picks up the filename date and its dayKey', () => {
    const { imageMediaMetadata, ...noExif } = exif;
    const record = toPointerRecord(noExif, {});
    assert.equal(record.takenAt.slice(0, 4), '2015');
    assert.equal(record.dayKey, '09-11');
  });
});

describe('attributing a photo to a person', () => {
  const file = { id: '1', name: 'a.jpg', mimeType: 'image/jpeg' };

  // An organised archive nests by year and month, so the folder a photo sits in
  // is "2015-09" - a fine thing to filter by and a useless owner.
  test('the owner is the top-level folder, not the month it sits in', () => {
    const record = toPointerRecord(file, { folderName: '2015-09', ownerFolder: 'Matt' });
    assert.equal(record.owner, 'Matt');
    assert.equal(record.folder, '2015-09');
  });

  test('falls back to the immediate folder when there is no top-level one', () => {
    assert.equal(toPointerRecord(file, { folderName: 'Erica' }).owner, 'Erica');
  });
});

// ---------------------------------------------------------------------------
// Walking the shared Drive folder
// ---------------------------------------------------------------------------

/** A fake Drive: folder id -> children, served a page at a time. */
function fakeDrive(tree, { pageSize = 1000 } = {}) {
  const calls = [];
  const listPage = async (id, pageToken) => {
    calls.push({ id, pageToken });
    const all = tree[id] ?? [];
    const start = pageToken ? Number(pageToken) : 0;
    const slice = all.slice(start, start + pageSize);
    const next = start + pageSize < all.length ? String(start + pageSize) : null;
    return { files: slice, nextPageToken: next };
  };
  return { listPage, calls };
}

const folder = (id, name) => ({ id, name, mimeType: 'application/vnd.google-apps.folder' });
const photo = (id, name) => ({ id, name, mimeType: 'image/jpeg' });

describe('walking the shared folder', () => {
  // THE BUG THIS REPLACED. An organised archive nests by year and month:
  // 01_Timeline/2015/2015-09/photo.jpg. The old walk stopped one level down, so
  // it listed the year folders, found no images, and reported an empty library.
  // Not an error - an empty grid, with nothing to say the scan had given up.
  test('finds photos however deeply they are filed', async () => {
    const { listPage } = fakeDrive({
      root: [folder('timeline', '01_Timeline')],
      timeline: [folder('y2015', '2015'), folder('y2016', '2016')],
      y2015: [folder('m09', '2015-09')],
      y2016: [folder('m02', '2016-02')],
      m09: [photo('a', 'a.jpg'), photo('b', 'b.jpg')],
      m02: [photo('c', 'c.jpg')],
    });

    const scan = await walkFolders('root', listPage);
    assert.deepEqual(scan.items.map((i) => i.file.id).sort(), ['a', 'b', 'c']);
    assert.equal(scan.truncated, false);
  });

  test('pages through a folder with more files than one request returns', async () => {
    const many = Array.from({ length: 2500 }, (_, i) => photo(`p${i}`, `p${i}.jpg`));
    const { listPage, calls } = fakeDrive({ root: many }, { pageSize: 1000 });

    const scan = await walkFolders('root', listPage);
    assert.equal(scan.items.length, 2500);
    assert.equal(calls.length, 3, 'should have asked for three pages');
  });

  test('the photo keeps its own folder and its top-level owner', async () => {
    const { listPage } = fakeDrive({
      root: [folder('matt', 'Matt')],
      matt: [folder('m09', '2015-09')],
      m09: [photo('a', 'a.jpg')],
    });

    const [item] = (await walkFolders('root', listPage)).items;
    assert.equal(item.ownerFolder, 'Matt', 'the person is the top-level folder');
    assert.equal(item.folderName, '2015-09', 'the month is what it sits in');
  });

  test('a photo loose in the root has no folder at all', async () => {
    const { listPage } = fakeDrive({ root: [photo('a', 'a.jpg')] });
    const [item] = (await walkFolders('root', listPage)).items;
    assert.equal(item.ownerFolder, null);
    assert.equal(item.folderName, null);
  });

  // A Drive file can sit in more than one folder, so a naive walk revisits and
  // duplicates everything beneath the shared one - or never finishes.
  test('does not go round in circles when folders share a child', async () => {
    const { listPage } = fakeDrive({
      root: [folder('a', 'A'), folder('b', 'B')],
      a: [folder('shared', 'Shared')],
      b: [folder('shared', 'Shared')],
      shared: [photo('p', 'p.jpg')],
    });

    const scan = await walkFolders('root', listPage);
    assert.equal(scan.items.length, 1, 'the shared folder must be read once');
  });

  test('stops at the file limit and says so rather than pretending that is all', async () => {
    const { listPage } = fakeDrive({
      root: Array.from({ length: 50 }, (_, i) => photo(`p${i}`, `p${i}.jpg`)),
    });
    const scan = await walkFolders('root', listPage, { maxFiles: 20 });
    assert.equal(scan.truncated, true);
    assert.equal(scan.items.length, 20, 'the limit must actually be a limit');
  });

  // The bug the limit check moved for: one folder overran the cap and then
  // emptied the queue, so nothing was left to trip the check between folders
  // and a short scan reported itself complete.
  test('a single oversized folder is still reported as truncated', async () => {
    const { listPage } = fakeDrive({
      root: Array.from({ length: 30 }, (_, i) => photo(`p${i}`, `p${i}.jpg`)),
    });
    assert.equal((await walkFolders('root', listPage, { maxFiles: 10 })).truncated, true);
  });

  test('a library that exactly fills the limit is not truncated', async () => {
    const { listPage } = fakeDrive({
      root: Array.from({ length: 10 }, (_, i) => photo(`p${i}`, `p${i}.jpg`)),
    });
    const scan = await walkFolders('root', listPage, { maxFiles: 10 });
    assert.equal(scan.items.length, 10);
    assert.equal(scan.truncated, false, 'nothing was dropped, so nothing should be claimed');
  });

  test('stops at the folder limit too', async () => {
    const tree = { root: Array.from({ length: 30 }, (_, i) => folder(`f${i}`, `f${i}`)) };
    for (let i = 0; i < 30; i += 1) tree[`f${i}`] = [photo(`p${i}`, `p${i}.jpg`)];

    const scan = await walkFolders('root', fakeDrive(tree).listPage, { maxFolders: 5 });
    assert.equal(scan.truncated, true);
    assert.ok(scan.items.length < 30);
  });

  // Breadth-first, so hitting a limit keeps the shallow, organised part of the
  // tree rather than an arbitrary slice of one deep branch.
  test('reads shallow folders before deep ones', async () => {
    const { listPage } = fakeDrive({
      root: [folder('deep', 'Deep'), photo('shallow', 'shallow.jpg')],
      deep: [folder('deeper', 'Deeper')],
      deeper: [photo('buried', 'buried.jpg')],
    });
    const scan = await walkFolders('root', listPage, { maxFiles: 1 });
    assert.equal(scan.items[0].file.id, 'shallow');
  });

  test('one unreadable folder does not blank the whole grid', async () => {
    const listPage = async (id) => {
      if (id === 'broken') throw new Error('403');
      if (id === 'root') return { files: [folder('broken', 'Broken'), folder('ok', 'OK')], nextPageToken: null };
      if (id === 'ok') return { files: [photo('a', 'a.jpg')], nextPageToken: null };
      return { files: [], nextPageToken: null };
    };
    const scan = await walkFolders('root', listPage);
    assert.deepEqual(scan.items.map((i) => i.file.id), ['a']);
  });

  test('reports progress as it goes, so a long scan does not look stuck', async () => {
    const { listPage } = fakeDrive({
      root: [folder('a', 'A')],
      a: [photo('p1', 'p1.jpg'), photo('p2', 'p2.jpg')],
    });
    const seen = [];
    await walkFolders('root', listPage, { onProgress: (p) => seen.push(p.files) });
    assert.ok(seen.length >= 2);
    assert.equal(seen[seen.length - 1], 2);
  });

  test('an empty folder is an empty result, not a crash', async () => {
    const scan = await walkFolders('root', fakeDrive({ root: [] }).listPage);
    assert.deepEqual(scan.items, []);
    assert.equal(scan.truncated, false);
  });
});
