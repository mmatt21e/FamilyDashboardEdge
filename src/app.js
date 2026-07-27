/**
 * App bootstrap.
 *
 * Boot order matters and is deliberate:
 *   1. theme, before anything paints, so there is no white flash on a dark phone
 *   2. a setup link in the URL, before checking whether we are configured
 *   3. config → Setup screen if missing
 *   4. Firebase → sign-in screen if signed out
 *   5. module settings → routes → first render
 */

import { el, applyTheme, watchSystemTheme, toast, spinner } from './ui.js';
import { loadConfig, isConfigured, saveConfig, readSetupLink } from './config.js';
import { state, update, loadModuleSettings } from './store.js';
import { isEnabled, navModules, getModule } from './modules.js';
import * as fb from './firebase.js';
import * as router from './router.js';
import { diagnoseStartup, STARTUP_TIMEOUT_MS } from './diagnose.js';

import { setupView, signInView } from './views/setup.js';
import { settingsView } from './views/settings.js';
import { photosView, memoriesView } from './views/photos.js';
import { feedView, calendarView } from './views/feed.js';
import { onboardingView } from './views/onboarding.js';

const root = document.getElementById('app');

function screen(node) {
  root.replaceChildren(node);
}

// Startup watchdog.
//
// The Firestore SDK retries a missing backend forever rather than failing, so a
// misconfigured project used to leave this app on its "Starting..." spinner
// indefinitely with nothing in the console. Anything that gets us to a usable
// screen disarms this; if nothing does, we stop guessing and go and find out
// what is wrong.
let watchdog = null;

function armWatchdog(config) {
  clearTimeout(watchdog);
  watchdog = setTimeout(async () => {
    const diagnosis = await diagnoseStartup(config);
    screen(startupProblemView(diagnosis));
  }, STARTUP_TIMEOUT_MS);
}

function disarmWatchdog() {
  clearTimeout(watchdog);
  watchdog = null;
}

/** What we show instead of spinning forever. */
function startupProblemView(diagnosis) {
  const retry = el('button', { class: 'btn btn--primary', onClick: () => location.reload() }, 'Try again');

  return el('div', { class: 'view' },
    el('div', { class: 'setup__logo' }, '🔧'),
    el('h1', {}, diagnosis.title),
    el('p', { class: 'muted' }, diagnosis.detail),
    diagnosis.fix && el('div', { class: 'card' },
      el('h2', {}, 'How to fix it'),
      el('p', {}, diagnosis.fix),
      diagnosis.url && el('a', { class: 'btn', href: diagnosis.url, target: '_blank', rel: 'noopener' },
        'Open the Firebase console'),
    ),
    el('div', { class: 'row' }, retry),
    el('p', { class: 'muted small' },
      diagnosis.projectId ? `Project: ${diagnosis.projectId}` : ''),
  );
}

async function boot() {
  applyTheme();
  watchSystemTheme();

  // A setup link configures this device and then removes itself from the URL,
  // so the payload is not left sitting in history or shared on by accident.
  const fromLink = readSetupLink();
  if (fromLink) {
    try {
      saveConfig(fromLink);
      history.replaceState(null, '', location.pathname + location.search);
      toast('Set up from your family’s link');
    } catch {
      toast('That setup link was not valid', { error: true });
    }
  }

  if (!isConfigured()) {
    return screen(setupView({ onSaved: () => location.reload() }));
  }

  const config = loadConfig();
  update({ config });

  screen(el('div', { class: 'view' }, spinner('Starting…')));
  armWatchdog(config);

  try {
    await fb.initFirebase(config);
  } catch (error) {
    disarmWatchdog();
    return screen(el('div', { class: 'view' },
      el('h1', {}, 'Could not connect'),
      el('p', { class: 'muted' },
        'The Firebase settings look wrong, or this device is offline.'),
      el('p', { class: 'error-text' }, error?.message ?? ''),
      el('button', { class: 'btn', onClick: () => location.reload() }, 'Try again'),
      setupView({ onSaved: () => location.reload(), existing: config }),
    ));
  }

  await fb.completeRedirectSignIn();

  fb.onAuthChange(async (user) => {
    if (!user) {
      disarmWatchdog();
      update({ user: null, member: null });
      return screen(signInView({
        config,
        onSignIn: async () => { await fb.signIn(); },
      }));
    }

    update({ user });
    try {
      const member = await fb.upsertMember(user);
      update({ member });
    } catch {
      // Firestore rules will reject anyone not on the family allowlist. Say so
      // plainly rather than showing a broken app behind a generic error.
      disarmWatchdog();
      return screen(el('div', { class: 'view' },
        el('h1', {}, 'Not on the family list'),
        el('p', { class: 'muted' },
          `You are signed in as ${user.email}, but that account has not been added to this family yet.`),
        el('p', { class: 'muted small' },
          'Whoever set the dashboard up can add you — see the README for how.'),
        el('button', { class: 'btn', onClick: async () => { await fb.signOutUser(); location.reload(); } },
          'Sign in with a different account'),
      ));
    }

    await loadModuleSettings();
    startApp();
  });
}

let started = false;

function startApp() {
  disarmWatchdog();
  if (started) return router.render();
  started = true;

  registerRoutes();

  const outlet = el('main', { class: 'app__main', id: 'main' });
  const nav = el('nav', { class: 'app__nav', 'aria-label': 'Sections' });

  screen(el('div', { class: 'app' }, outlet, nav));
  router.mount(outlet);
  router.setNavigationListener(() => drawNav(nav));
  drawNav(nav);

  // Rebuild navigation when features are toggled, so a change in Settings shows
  // up immediately rather than after a reload.
  window.addEventListener('fd:modules-changed', () => drawNav(nav));

  if (!location.hash) router.navigate('/', { replace: true });
  else router.render();
}

/**
 * Routes are registered for every module, but each one re-checks that its
 * module is enabled at render time. That way a stale bookmark or a hash typed
 * by hand cannot open a screen the family has switched off.
 */
function registerRoutes() {
  const gated = (key, view) => async (params, outlet) => {
    if (!isEnabled(state.modules, key)) {
      const module = getModule(key);
      return el('div', { class: 'view' },
        el('h1', {}, module?.title ?? 'Not available'),
        el('p', { class: 'muted' }, 'This feature is switched off. You can turn it back on in Settings.'),
        el('a', { class: 'btn', href: '#/settings' }, 'Open Settings'),
      );
    }
    // Teardown of the previous view happens in router.render() for every route.
    return view(params, outlet);
  };

  router.route('/', homeView);
  router.route('/photos', gated('photos', photosView));
  router.route('/memories', gated('memories', memoriesView));
  router.route('/feed', gated('feed', feedView));
  router.route('/calendar', gated('calendar', calendarView));
  router.route('/settings', settingsView);
  router.route('/setup-checklist', onboardingView);
  router.setNotFound(async () => el('div', { class: 'view' },
    el('h1', {}, 'Not found'),
    el('a', { class: 'btn', href: '#/' }, 'Go home'),
  ));
}

async function homeView() {
  const modules = navModules(state.modules);

  return el('div', { class: 'view' },
    el('header', { class: 'view__header' },
      el('h1', {}, state.config?.familyName ?? 'Family'),
      el('p', { class: 'muted' }, `Hello ${(state.member?.name ?? '').split(' ')[0] || 'there'}`),
    ),
    el('div', { class: 'home-grid' },
      modules.map((module) =>
        el('a', { class: 'home-card', href: `#/${module.key}` },
          el('span', { class: 'home-card__icon' }, module.icon),
          el('span', { class: 'home-card__title' }, module.title),
          el('span', { class: 'muted small' }, module.desc),
        )),
      el('a', { class: 'home-card home-card--muted', href: '#/setup-checklist' },
        el('span', { class: 'home-card__icon' }, '✅'),
        el('span', { class: 'home-card__title' }, 'Setup checklist'),
        el('span', { class: 'muted small' }, 'Get a phone syncing photos'),
      ),
    ),
  );
}

function drawNav(nav) {
  const items = [
    { key: '/', icon: '🏡', title: 'Home' },
    ...navModules(state.modules).map((m) => ({ key: `/${m.key}`, icon: m.icon, title: m.title })),
    { key: '/settings', icon: '⚙️', title: 'Settings' },
  ];

  const active = router.activePath() ?? '/';
  nav.replaceChildren(...items.map((item) =>
    el('a', {
      class: `nav-item${item.key === active ? ' is-active' : ''}`,
      href: `#${item.key}`,
      'aria-current': item.key === active ? 'page' : null,
    },
      el('span', { class: 'nav-item__icon' }, item.icon),
      el('span', { class: 'nav-item__label' }, item.title),
    )));
}

// The service worker is a progressive enhancement: if registration fails the
// app still works, it just will not open offline.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(new URL('../sw.js', import.meta.url), { scope: './' })
      .catch(() => {});
  });
}

boot().catch((error) => {
  screen(el('div', { class: 'view' },
    el('h1', {}, 'Something went wrong'),
    el('p', { class: 'error-text' }, error?.message ?? String(error)),
    el('button', { class: 'btn', onClick: () => location.reload() }, 'Reload'),
  ));
});
