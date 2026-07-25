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
import { parseExifDate, originalDateFor, toPointerRecord, kindForMime, sortByTakenDesc, formatSize } from '../src/files.js';
import {
  parseCsv, basenameOf, catalogKey, parseTimestamp, parseEventBucket, buildCatalog,
  buildLookup, matchEntry, applyCatalog, toChunks, fromChunks, packEntry, detectCsvRole,
} from '../src/catalog.js';
import {
  emptyFilters, hasActiveFilters, filterPhotos, buildFacets, describeFilters,
  clearFilter, describeCount, PEOPLE_MODE,
} from '../src/photo-filter.js';

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
