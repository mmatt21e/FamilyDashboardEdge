/**
 * Browser smoke test.
 *
 * Proves the app actually boots in a real browser: the shell renders, the
 * Setup screen appears when nothing is configured, validation works, settings
 * persist, and a setup link configures a fresh device.
 *
 * Deliberately stops short of connecting to Firebase or Drive. Those need real
 * accounts and a network, so a test that touched them would be slow and flaky
 * and would fail for reasons that have nothing to do with the code. Everything
 * up to that boundary is checked here.
 *
 *   npm run test:browser
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png',
};

let server, browser, origin;

// GitHub Pages serves a project site under /<repo>/, not at the domain root.
// Every relative path, the manifest scope and the service worker registration
// have to survive that, so the suite exercises it rather than assuming.
const BASE = '/family-dashboard';

/**
 * Finds an already-installed Chromium, newest build first.
 * Returns undefined so Playwright falls back to its own copy if none is found.
 */
function findLocalChromium() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!base || !existsSync(base)) return undefined;

  const candidates = readdirSync(base)
    .filter((name) => name.startsWith('chromium'))
    .sort()
    .reverse()
    .flatMap((name) => [
      join(base, name, 'chrome-linux', 'chrome'),
      join(base, name, 'chrome-linux', 'headless_shell'),
    ]);

  return candidates.find((path) => existsSync(path));
}

before(async () => {
  server = createServer(async (req, res) => {
    try {
      let path = decodeURIComponent(req.url.split('?')[0]);
      // Accept both the root and the project-site prefix from one server.
      if (path.startsWith(BASE)) path = path.slice(BASE.length) || '/';
      const rel = normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, '');
      const file = join(ROOT, rel);
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;

  // Use whatever Chromium is already on the machine when its build number does
  // not match what this Playwright version expects. CI installs a matching one;
  // sandboxes and dev machines often have a different build already present,
  // and downloading another copy to run six assertions is not worth it.
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM || findLocalChromium(),
    args: ['--no-sandbox'],   // required when running as root in a container
  });
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
});

/** Fresh context each time, so localStorage never leaks between tests. */
async function openApp({ route = '', base = '' } = {}) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },   // iPhone-ish, since this is mobile-first
  });
  const page = await context.newPage();

  const errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (error) => errors.push(String(error)));

  await page.goto(`${origin}${base}/${route}`, { waitUntil: 'domcontentloaded' });
  return { page, context, errors };
}

const FIREBASE_SNIPPET = `const firebaseConfig = {
  apiKey: "AIzaSyFakeKeyForTesting",
  authDomain: "demo-family.firebaseapp.com",
  projectId: "demo-family",
  appId: "1:123:web:abc"
};`;

describe('app shell', () => {
  test('boots to the Setup screen with no configuration', async () => {
    const { page, context, errors } = await openApp();
    await page.waitForSelector('.view--setup', { timeout: 10_000 });

    assert.match(await page.textContent('h1'), /Set up your family dashboard/i);
    assert.deepEqual(errors, [], `unexpected console errors: ${errors.join(' | ')}`);
    await context.close();
  });

  test('applies a theme before paint, so there is no flash', async () => {
    const { page, context } = await openApp();
    await page.waitForSelector('.view--setup');
    const theme = await page.getAttribute('html', 'data-theme');
    assert.ok(['light', 'dark'].includes(theme), `unexpected theme: ${theme}`);
    await context.close();
  });

  test('serves a valid manifest with the icons it advertises', async () => {
    const response = await fetch(`${origin}/manifest.webmanifest`);
    assert.equal(response.status, 200);
    const manifest = await response.json();

    assert.equal(manifest.display, 'standalone');
    assert.ok(manifest.icons.length >= 2);
    assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'), 'needs a maskable icon');

    for (const icon of manifest.icons) {
      const iconResponse = await fetch(`${origin}/${icon.src}`);
      assert.equal(iconResponse.status, 200, `${icon.src} is missing`);
    }
  });

  test('declares the iOS home-screen tags Safari needs', async () => {
    const html = await (await fetch(`${origin}/index.html`)).text();
    assert.match(html, /apple-mobile-web-app-capable/);
    assert.match(html, /apple-touch-icon/);
    assert.match(html, /viewport-fit=cover/);
  });
});

describe('setup', () => {
  test('refuses an empty form and says what is missing', async () => {
    const { page, context } = await openApp();
    await page.waitForSelector('.view--setup');
    await page.click('button:has-text("Save and continue")');

    await page.waitForSelector('.form__errors:not([hidden])');
    assert.match(await page.textContent('.form__errors'), /Firebase/i);
    await context.close();
  });

  // The error box used to print a literal "false" under the message: the
  // conditional-child idiom `replaceChildren(a, cond && b)` stringifies `false`
  // when the condition fails. Visible on the very first screen a user sees.
  test('shows no stray "false" under the error message', async () => {
    const { page, context } = await openApp();
    await page.waitForSelector('.view--setup');
    await page.click('button:has-text("Save and continue")');
    await page.waitForSelector('.form__errors:not([hidden])');

    const text = await page.textContent('.form__errors');
    assert.ok(!/\bfalse\b/i.test(text), `error box leaked a boolean: ${JSON.stringify(text)}`);
    await context.close();
  });

  // End to end through the real UI with what the Firebase console actually
  // gives you today - imports, comments, trailing init calls and all.
  test('accepts the full Firebase console file pasted verbatim', async () => {
    const { page, context } = await openApp();
    await page.waitForSelector('.view--setup');

    const consoleFile = [
      '// Import the functions you need from the SDKs you need',
      'import { initializeApp } from "firebase/app";',
      'import { getAnalytics } from "firebase/analytics";',
      '',
      '// Your web app\'s Firebase configuration',
      'const firebaseConfig = {',
      '  apiKey: "AIzaSyExampleKeyNotReal000000000000000",',
      '  authDomain: "exampleproject.firebaseapp.com",',
      '  projectId: "exampleproject",',
      '  storageBucket: "exampleproject.firebasestorage.app",',
      '  messagingSenderId: "000000000000",',
      '  appId: "1:000000000000:web:abcdef0123456789abcdef",',
      '  measurementId: "G-XXXXXXXXXX"',
      '};',
      '',
      '// Initialize Firebase',
      'const app = initializeApp(firebaseConfig);',
      'const analytics = getAnalytics(app);',
    ].join('\n');

    await page.fill('input[placeholder="The Smiths"]', 'The Testers');
    await page.fill('textarea[placeholder*="firebaseConfig"]', consoleFile);
    await page.fill('input[placeholder*="googleusercontent"]', '123.apps.googleusercontent.com');
    await page.fill('input[placeholder*="web address"]', 'folder-abc');
    await page.click('button:has-text("Save and continue")');

    await page.waitForFunction(() => localStorage.getItem('fd.config.v1') !== null, { timeout: 5000 });
    const saved = JSON.parse(await page.evaluate(() => localStorage.getItem('fd.config.v1')));

    assert.equal(saved.firebase.projectId, 'exampleproject');
    assert.equal(saved.firebase.appId, '1:000000000000:web:abcdef0123456789abcdef');
    assert.equal(saved.firebase.apiKey, 'AIzaSyExampleKeyNotReal000000000000000');
    await context.close();
  });

  test('rejects a Google client ID that is not one', async () => {
    const { page, context } = await openApp();
    await page.waitForSelector('.view--setup');

    await page.fill('textarea[placeholder*="firebaseConfig"]', FIREBASE_SNIPPET);
    await page.fill('input[placeholder*="googleusercontent"]', 'not-a-client-id');
    await page.fill('input[placeholder*="web address"]', 'folder-abc');
    await page.click('button:has-text("Save and continue")');

    await page.waitForSelector('.form__errors:not([hidden])');
    assert.match(await page.textContent('.form__errors'), /googleusercontent/i);
    await context.close();
  });

  test('saves a valid configuration, parsing the pasted Firebase snippet', async () => {
    const { page, context } = await openApp();
    await page.waitForSelector('.view--setup');

    await page.fill('input[placeholder="The Smiths"]', 'The Testers');
    await page.fill('textarea[placeholder*="firebaseConfig"]', FIREBASE_SNIPPET);
    await page.fill('input[placeholder*="googleusercontent"]', '123.apps.googleusercontent.com');
    await page.fill('input[placeholder*="web address"]', 'folder-abc');
    await page.click('button:has-text("Save and continue")');

    await page.waitForFunction(() => localStorage.getItem('fd.config.v1') !== null, { timeout: 5000 });
    const saved = JSON.parse(await page.evaluate(() => localStorage.getItem('fd.config.v1')));

    assert.equal(saved.familyName, 'The Testers');
    assert.equal(saved.firebase.projectId, 'demo-family');
    assert.equal(saved.firebase.apiKey, 'AIzaSyFakeKeyForTesting');
    assert.equal(saved.driveFolderId, 'folder-abc');
    await context.close();
  });

  test('a setup link configures a fresh device and then clears itself from the URL', async () => {
    // The whole point of the link: nobody else in the family retypes any of this.
    const config = {
      familyName: 'Linked Family',
      firebase: { apiKey: 'k', authDomain: 'x.firebaseapp.com', projectId: 'linked', appId: 'a' },
      googleClientId: '999.apps.googleusercontent.com',
      driveFolderId: 'shared-folder',
    };
    const payload = Buffer.from(JSON.stringify(config))
      .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const { page, context } = await openApp({ route: `#setup=${payload}` });

    await page.waitForFunction(() => localStorage.getItem('fd.config.v1') !== null, { timeout: 10_000 });
    const saved = JSON.parse(await page.evaluate(() => localStorage.getItem('fd.config.v1')));
    assert.equal(saved.firebase.projectId, 'linked');
    assert.equal(saved.driveFolderId, 'shared-folder');

    // The payload must not linger in the address bar to be shared on by mistake.
    assert.ok(!page.url().includes('setup='), `setup payload left in URL: ${page.url()}`);
    await context.close();
  });

  test('ignores a corrupt setup link rather than breaking', async () => {
    const { page, context } = await openApp({ route: '#setup=not-valid-base64!!' });
    await page.waitForSelector('.view--setup', { timeout: 10_000 });
    await context.close();
  });
});


describe('deployed under a GitHub Pages subpath', () => {
  // The app is served from https://user.github.io/<repo>/ in reality. A path
  // that only works at the domain root would fail on the very first deploy,
  // which is an expensive way to find out.
  test('boots from /<repo>/ just as it does from the root', async () => {
    const { page, context, errors } = await openApp({ route: '', base: BASE });
    await page.waitForSelector('.view--setup', { timeout: 10_000 });
    assert.match(await page.textContent('h1'), /Set up your family dashboard/i);
    assert.deepEqual(errors, [], `console errors under subpath: ${errors.join(' | ')}`);
    await context.close();
  });

  test('loads its stylesheet and modules from the subpath', async () => {
    const { page, context } = await openApp({ route: '', base: BASE });
    await page.waitForSelector('.view--setup');

    // If the CSS 404'd the card would be unstyled; check a value that only
    // comes from the stylesheet.
    const radius = await page.evaluate(() =>
      getComputedStyle(document.querySelector('.card')).borderRadius);
    assert.ok(radius && radius !== '0px', `stylesheet did not load (radius: ${radius})`);
    await context.close();
  });

  test('registers the service worker at the subpath scope', async () => {
    const { page, context } = await openApp({ route: '', base: BASE });
    await page.waitForSelector('.view--setup');

    const scope = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return reg?.scope ?? null;
    });
    assert.ok(scope, 'no service worker registered');
    assert.ok(scope.endsWith(`${BASE}/`), `scope should cover the project path, got ${scope}`);
    await context.close();
  });

  test('manifest start_url and scope are relative, not root-anchored', async () => {
    const manifest = await (await fetch(`${origin}${BASE}/manifest.webmanifest`)).json();
    // A leading "/" here would send the installed app to the wrong place.
    assert.ok(!manifest.start_url.startsWith('/'), `start_url must be relative: ${manifest.start_url}`);
    assert.ok(!manifest.scope.startsWith('/'), `scope must be relative: ${manifest.scope}`);
  });
});


describe('setup link recipients', () => {
  // The whole point of the share link: nobody but the first person should ever
  // see the Firebase fields. If a link arrives mangled they land on Setup, and
  // this paste box has to rescue them without a trip to the Google console.
  const CONFIG = {
    familyName: 'Linked Family',
    firebase: { apiKey: 'k', authDomain: 'x.firebaseapp.com', projectId: 'linked', appId: '1:2:web:3' },
    googleClientId: '999.apps.googleusercontent.com',
    driveFolderId: 'shared-folder',
  };
  const CODE = Buffer.from(JSON.stringify(CONFIG))
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  test('pasting a setup link configures the device without touching Firebase fields', async () => {
    const { page, context } = await openApp();
    await page.waitForSelector('.view--setup');

    await page.fill('textarea[placeholder*="family sent you"]', `https://example.com/app/#setup=${CODE}`);
    await page.click('button:has-text("Use this link")');

    await page.waitForFunction(() => localStorage.getItem('fd.config.v1') !== null, { timeout: 5000 });
    const saved = JSON.parse(await page.evaluate(() => localStorage.getItem('fd.config.v1')));
    assert.equal(saved.firebase.projectId, 'linked');
    assert.equal(saved.driveFolderId, 'shared-folder');
    await context.close();
  });

  test('pasting just the code works too', async () => {
    const { page, context } = await openApp();
    await page.waitForSelector('.view--setup');
    await page.fill('textarea[placeholder*="family sent you"]', CODE);
    await page.click('button:has-text("Use this link")');

    await page.waitForFunction(() => localStorage.getItem('fd.config.v1') !== null, { timeout: 5000 });
    assert.equal(
      JSON.parse(await page.evaluate(() => localStorage.getItem('fd.config.v1'))).firebase.projectId,
      'linked',
    );
    await context.close();
  });

  test('a truncated link says so instead of half-configuring the device', async () => {
    const { page, context } = await openApp();
    await page.waitForSelector('.view--setup');
    await page.fill('textarea[placeholder*="family sent you"]', CODE.slice(0, 30));
    await page.click('button:has-text("Use this link")');

    await page.waitForSelector('.form__errors:not([hidden])');
    assert.match(await page.textContent('.form__errors'), /cut short|does not look like/i);
    assert.equal(await page.evaluate(() => localStorage.getItem('fd.config.v1')), null);
    await context.close();
  });
});
