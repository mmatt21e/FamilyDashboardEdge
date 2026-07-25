/**
 * Adding the dashboard to a phone's home screen.
 *
 * The honest position first, because it shapes everything below: **a link
 * cannot install a web app.** There is no URL, scheme or header on either iOS
 * or Android that makes tapping a message install a PWA. A link opens a
 * browser; that is all a link can do. Anything claiming otherwise is describing
 * a native app behind a deep link, which this is not.
 *
 * What is actually achievable, per platform, is quite different in each case:
 *
 *  - **Android, Chromium.** The browser fires `beforeinstallprompt` at the
 *    page. Stash that event and the app can show its own button that opens the
 *    real system install dialog. One tap, no menu-hunting. This is as close to
 *    "the link installed it" as the platform gets.
 *
 *  - **iOS.** No install API exists at all. Safari has never fired
 *    `beforeinstallprompt` and there is no substitute. The only route is Share
 *    → Add to Home Screen, by hand, so the best the app can do is say exactly
 *    that with the right icon in the right place.
 *
 *  - **Inside another app's browser** - the viewer Gmail, Messages, Facebook
 *    or Instagram opens links in - Add to Home Screen is often missing from the
 *    menu entirely. This is the failure that actually bites in practice,
 *    because an invitation arrives *in* one of those apps. Detecting it and
 *    saying "open this in Safari first" is the single most useful thing here.
 *
 *  - **Desktop.** Installing is possible in Chromium but beside the point, so
 *    the app goes straight to signing in.
 *
 * Detection takes the user agent as an argument so it can be tested against
 * real strings rather than only against whatever browser happens to be running.
 */

export const OS = { IOS: 'ios', ANDROID: 'android', DESKTOP: 'desktop' };

// ---------------------------------------------------------------------------
// The Android install prompt
// ---------------------------------------------------------------------------

/**
 * Chromium fires `beforeinstallprompt` once, early, and the event is only
 * usable if it was captured and its default prevented. Miss it and there is no
 * way to ask for it again, so the listener is registered as this module loads
 * rather than when a screen decides it wants one.
 */
let deferredPrompt = null;
let installed = false;

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event;
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    installed = true;
  });
}

export function canPromptToInstall() {
  return Boolean(deferredPrompt);
}

export function wasInstalledThisVisit() {
  return installed;
}

/**
 * Shows the browser's own install dialog.
 *
 * @returns {Promise<'accepted'|'dismissed'|'unavailable'>}
 */
export async function promptToInstall() {
  if (!deferredPrompt) return 'unavailable';

  const event = deferredPrompt;
  // Single use: Chromium will not let the same event be shown twice, and
  // keeping it around would give a button that silently does nothing.
  deferredPrompt = null;

  try {
    await event.prompt();
    const { outcome } = await event.userChoice;
    return outcome === 'accepted' ? 'accepted' : 'dismissed';
  } catch {
    return 'unavailable';
  }
}

// ---------------------------------------------------------------------------
// Where are we running
// ---------------------------------------------------------------------------

/** Apps whose built-in browser cannot add to the home screen. */
const IN_APP_MARKERS = /FBAN|FBAV|FB_IAB|Instagram|Line\/|Twitter|LinkedInApp|Snapchat|Pinterest|MicroMessenger|WhatsApp|Electron/i;

export function isStandalone({ nav = globalThis.navigator, win = globalThis.window } = {}) {
  return Boolean(
    win?.matchMedia?.('(display-mode: standalone)').matches ||
    win?.matchMedia?.('(display-mode: fullscreen)').matches ||
    nav?.standalone === true,
  );
}

/**
 * @param {{ua?: string, maxTouchPoints?: number, platform?: string}} probe
 * @returns {{os: string, inApp: boolean, isSafari: boolean, isChromium: boolean}}
 */
export function detectPlatform({
  ua = globalThis.navigator?.userAgent ?? '',
  maxTouchPoints = globalThis.navigator?.maxTouchPoints ?? 0,
  platform = globalThis.navigator?.platform ?? '',
} = {}) {
  // iPadOS reports itself as a Mac and has done since iPadOS 13. The touch
  // points are the only reliable tell, and getting this wrong sends an iPad
  // user the desktop path where nothing about the instructions applies.
  const iPadOS = /Mac/i.test(platform + ua) && maxTouchPoints > 1;
  const ios = /iPad|iPhone|iPod/i.test(ua) || iPadOS;
  const android = /Android/i.test(ua);

  const isSafari = /Safari\//.test(ua) && !/Chrome|CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  const isChromium = /Chrome|CriOS|Edg/i.test(ua) && !/OPR|Opera/i.test(ua);

  const inApp = IN_APP_MARKERS.test(ua)
    // An iOS web view is a browser with no Safari in its user agent. Every real
    // iOS browser, whatever engine it claims, keeps "Safari/" in there.
    || (ios && !/Safari\//.test(ua))
    // Android's WebView marks itself, which is how an in-app browser is told
    // from Chrome proper.
    || (android && /;\s*wv\)/.test(ua));

  return {
    os: ios ? OS.IOS : android ? OS.ANDROID : OS.DESKTOP,
    inApp,
    isSafari,
    isChromium,
  };
}

/** Desktop goes straight to signing in; only phones and tablets are asked to install. */
export function shouldOfferInstall(probe = {}) {
  if (isStandalone(probe)) return false;
  return detectPlatform(probe).os !== OS.DESKTOP;
}

// ---------------------------------------------------------------------------
// What to tell the person
// ---------------------------------------------------------------------------

/**
 * Instructions for this exact situation.
 *
 * `mode` is what the screen should do:
 *   'prompt'  - a real install button is available
 *   'manual'  - the menu route, spelled out
 *   'escape'  - they are stuck in another app's browser and must get out first
 *   'none'    - already installed, or a desktop
 */
export function installGuidance({ probe = {}, canPrompt = canPromptToInstall() } = {}) {
  if (isStandalone(probe)) {
    return { mode: 'none', title: 'Already added', steps: [] };
  }

  const { os, inApp, isChromium } = detectPlatform(probe);

  if (os === OS.DESKTOP) {
    return { mode: 'none', title: 'Open on your computer', steps: [] };
  }

  // The one that actually catches people out: the invitation arrives inside a
  // messaging app, whose browser has no way to add anything to a home screen.
  if (inApp) {
    return {
      mode: 'escape',
      title: 'Open this in your browser first',
      detail: os === OS.IOS
        ? 'This page opened inside another app, and apps like this one cannot add anything to your home screen.'
        : 'This page opened inside another app, which cannot install the dashboard.',
      steps: os === OS.IOS
        ? ['Tap the ••• or compass button at the corner of the screen.', 'Choose “Open in Safari”.', 'Come back to this page and follow the two steps it shows.']
        : ['Tap the ⋮ button at the corner of the screen.', 'Choose “Open in Chrome”.', 'Come back to this page and tap Install.'],
      copyLink: true,
    };
  }

  if (os === OS.IOS) {
    return {
      mode: 'manual',
      title: 'Add to your home screen',
      detail: 'iPhones and iPads have no one-tap install for web apps, so this takes two taps in Safari.',
      steps: [
        'Tap the Share button — the square with an arrow pointing up, at the bottom of Safari.',
        'Scroll down and tap “Add to Home Screen”, then tap Add.',
      ],
    };
  }

  // Android.
  if (canPrompt) {
    return {
      mode: 'prompt',
      title: 'Add to your home screen',
      detail: 'One tap. It opens like any other app afterwards, full screen and off the browser.',
      steps: [],
    };
  }

  return {
    mode: 'manual',
    title: 'Add to your home screen',
    detail: isChromium
      ? 'Chrome has not offered the shortcut yet. The menu does the same thing.'
      : 'This browser does not offer a one-tap install, but the menu does the same thing.',
    steps: [
      'Tap the ⋮ button at the top right.',
      'Choose “Install app”, or “Add to Home screen”.',
    ],
  };
}

// ---------------------------------------------------------------------------
// Remembering that they said no
// ---------------------------------------------------------------------------

const DISMISS_KEY = 'fd.install.dismissed';

export function dismissInstall() {
  try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* private mode */ }
}

export function installDismissed() {
  try { return Boolean(localStorage.getItem(DISMISS_KEY)); } catch { return false; }
}
