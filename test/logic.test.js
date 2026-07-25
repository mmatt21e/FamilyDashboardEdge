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
