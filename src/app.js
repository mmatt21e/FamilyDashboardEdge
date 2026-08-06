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
import { isEnabled, navModules, getModule, resolveState, GROUPS } from './modules.js';
import {
  loadToolbarKeys, saveToolbarKeys, setToolbarPinned, toolbarModules,
} from './toolbar.js';
import * as fb from './firebase.js';
import * as router from './router.js';
import { diagnoseStartup, STARTUP_TIMEOUT_MS } from './diagnose.js';
import { setAccountHint } from './drive.js';
import { autoUpdate } from './update.js';

import { setupView, signInView } from './views/setup.js';
import { settingsView } from './views/settings.js';
import { photosView, videosView, memoriesView } from './views/photos.js';
import { feedView, calendarView } from './views/feed.js';
import { financialRecordsView, expensesView, budgetView } from './views/money.js';
import { MORE_FEATURE_KEYS, moreFeatureView } from './views/more.js';
import {
  medicalInfoView, medicationsView, appointmentsView, careLogView, wellnessView,
} from './views/care.js';
import { onboardingView } from './views/onboarding.js';
import { importTagsView, primeCatalog } from './views/import-tags.js';
import {
  installView, notAMemberView, wantsInstallStep,
  rememberInvite, recallInvite, forgetInvite, arrivedFromLink,
} from './views/invite.js';
import { parseInviteCode, checkInvitation } from './invites.js';

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

  // An invitation code has to outlive the URL: signing in with Google is a full
  // page redirect on a home-screen app, and the hash does not come back with
  // us. It is read before the URL is cleaned and kept for the session.
  const code = parseInviteCode(location.hash);
  const fromLink = readSetupLink();
  if (code || fromLink) rememberInvite(code);

  // A setup link configures this device and then removes itself from the URL,
  // so the payload is not left sitting in history or shared on by accident.
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

  // The install step, for someone who arrived by following an invitation on a
  // phone. Desktops skip it - a computer should just open the dashboard and ask
  // them to sign in, which is what happens next. It is never a dead end: the
  // screen always offers to carry on in the browser.
  if (arrivedFromLink() && wantsInstallStep()) {
    return screen(installView({
      familyName: config.familyName,
      onContinue: () => { void continueBoot(config); },
    }));
  }

  return continueBoot(config);
}

async function continueBoot(config) {
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
    // Drive tokens must come from the account that just signed in. On a phone
    // with several Google accounts, silent renewal fails without this and the
    // family gets asked to pick an account over and over.
    setAccountHint(user.email);

    // The fast path: this device has booted as this person before. The member
    // stamp (a Firestore WRITE) and the module settings (a read) were two
    // serial round trips standing between a returning user and their own home
    // screen, and neither meaningfully changes between opens. Start from the
    // cached copies now; the network confirms behind the running app.
    const cached = recallBoot(user.uid);
    if (cached?.member) {
      update({ member: cached.member, modules: resolveState(cached.modules ?? null) });
      void primeCatalog();
      startApp();
      void autoUpdate({ onUpdating: () => toast('Updating to the newest version…') });
      void confirmBoot(user);
      return;
    }

    try {
      const member = await fb.upsertMember(user);
      update({ member });
      forgetInvite();
    } catch {
      // Not on the allowlist. That is the normal state for somebody opening an
      // invitation for the first time, so redeem it before giving up.
      const outcome = await redeemInvite(user);
      if (!outcome.ok) {
        disarmWatchdog();
        return screen(notAMemberView({
          user, message: outcome.message, onJoined: () => location.reload(),
        }));
      }
      update({ member: outcome.member });
      forgetInvite();
    }

    await loadModuleSettings();
    rememberBoot(user.uid, { member: state.member, modules: state.modules });
    // Photo tags, if any were imported. Not awaited - the dashboard should not
    // wait on a filter feature, and Photos loads them itself if this loses the
    // race.
    void primeCatalog();
    startApp();
    // Quietly, after the app is usable: if the server has moved on, reload
    // once into the new build. This is what makes updates land without anyone
    // hunting for a button - once per served build, so it can never loop.
    void autoUpdate({ onUpdating: () => toast('Updating to the newest version…') });
  });
}

/**
 * The cached boot: who this device last booted as, and the module settings it
 * saw. Together they let a returning user's home screen appear without
 * waiting on Firestore at all.
 */
const BOOT_CACHE_KEY = 'fd.boot.v1';

function recallBoot(uid) {
  try {
    const saved = JSON.parse(localStorage.getItem(BOOT_CACHE_KEY) ?? 'null');
    return saved?.uid === uid ? saved : null;
  } catch { return null; }
}

function rememberBoot(uid, { member, modules }) {
  try {
    localStorage.setItem(BOOT_CACHE_KEY, JSON.stringify({ uid, member, modules }));
  } catch { /* private mode; the slow path still works */ }
}

/**
 * The background half of the fast path: refresh the member stamp and module
 * settings behind the running app. The only outcome that interrupts is
 * permission-denied - membership actually revoked, the one case where the
 * cached boot lied. A network failure changes nothing: the cached boot
 * stands, which is exactly how an offline-capable app should behave.
 */
async function confirmBoot(user) {
  try {
    const member = await fb.upsertMember(user);
    update({ member });
    await loadModuleSettings();
    rememberBoot(user.uid, { member, modules: state.modules });
    // The nav redraws itself off this event if the family's toggles changed.
    window.dispatchEvent(new CustomEvent('fd:modules-changed'));
  } catch (error) {
    if (error?.code === 'permission-denied') {
      try { localStorage.removeItem(BOOT_CACHE_KEY); } catch { /* already gone */ }
      screen(notAMemberView({ user, message: null, onJoined: () => location.reload() }));
    }
  }
}

/**
 * Turns an invitation into membership.
 *
 * The invitation is checked here before writing, so the reason it failed can be
 * said out loud - "that one was for a different email address" is a fixable
 * problem, and a bare permission error is not.
 *
 * @returns {Promise<{ok: boolean, member?: object, message?: string}>}
 */
async function redeemInvite(user) {
  const code = recallInvite();
  if (!code) return { ok: false, message: null };

  const invitation = await fb.getInvitation(code);
  const verdict = checkInvitation(invitation, { email: user.email });
  if (!verdict.ok) return { ok: false, message: verdict.message };

  try {
    return { ok: true, member: await fb.joinWithInvite(user, code) };
  } catch (error) {
    return {
      ok: false,
      message: error?.message ?? 'That invitation could not be used. Ask for a new one.',
    };
  }
}

let started = false;
let toolbarKeys = [];
let featurePanel = null;

function startApp() {
  disarmWatchdog();
  if (started) return router.render();
  started = true;

  registerRoutes();

  const outlet = el('main', { class: 'app__main', id: 'main' });
  const nav = el('nav', { class: 'app__nav', 'aria-label': 'Sections' });

  toolbarKeys = loadToolbarKeys(state.modules, state.user?.uid);

  screen(el('div', { class: 'app' }, outlet, nav));
  router.mount(outlet);
  router.setNavigationListener(() => drawNav(nav));
  drawNav(nav);

  // Rebuild navigation when features are toggled, so a change in Settings shows
  // up immediately rather than after a reload.
  window.addEventListener('fd:modules-changed', () => {
    toolbarKeys = saveToolbarKeys(toolbarKeys, state.modules, state.user?.uid);
    drawNav(nav);
    if (featurePanel) renderFeaturePanel(nav);
  });

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
    // Teardown of the previous view happens in router.render(), on every route.
    return view(params, outlet);
  };

  router.route('/', homeView);
  router.route('/photos', gated('photos', photosView));
  router.route('/videos', gated('videos', videosView));
  router.route('/memories', gated('memories', memoriesView));
  router.route('/feed', gated('feed', feedView));
  router.route('/calendar', gated('calendar', calendarView));
  router.route('/medical', gated('medical', medicalInfoView));
  router.route('/medications', gated('medications', medicationsView));
  router.route('/appointments', gated('appointments', appointmentsView));
  router.route('/carelog', gated('carelog', careLogView));
  router.route('/wellness', gated('wellness', wellnessView));
  router.route('/records', gated('records', financialRecordsView));
  router.route('/expenses', gated('expenses', expensesView));
  router.route('/budget', gated('budget', budgetView));
  for (const key of MORE_FEATURE_KEYS) {
    router.route(`/${key}`, gated(key, () => moreFeatureView(key)));
  }
  router.route('/settings', settingsView);
  router.route('/setup-checklist', onboardingView);
  router.route('/photo-tags', importTagsView);
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
    ...toolbarModules(state.modules, toolbarKeys)
      .map((m) => ({ key: `/${m.key}`, icon: m.icon, title: m.title })),
    { key: null, icon: '▦', title: 'Features', panel: true },
    { key: '/settings', icon: '⚙️', title: 'Settings' },
  ];

  const active = router.activePath() ?? '/';
  nav.replaceChildren(...items.map((item) =>
    item.panel
      ? el('button', {
          class: `nav-item nav-item--button${featurePanel ? ' is-active' : ''}`,
          type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': Boolean(featurePanel),
          onClick: () => openFeaturePanel(nav),
        },
        el('span', { class: 'nav-item__icon' }, item.icon),
        el('span', { class: 'nav-item__label' }, item.title))
      : el('a', {
          class: `nav-item${item.key === active ? ' is-active' : ''}`,
          href: `#${item.key}`,
          'aria-current': item.key === active ? 'page' : null,
        },
        el('span', { class: 'nav-item__icon' }, item.icon),
        el('span', { class: 'nav-item__label' }, item.title),
      )));
}

/** Opens every family-enabled feature without requiring a toolbar shortcut. */
function openFeaturePanel(nav) {
  if (featurePanel) return closeFeaturePanel(nav);

  featurePanel = el('div', {
    class: 'feature-panel-backdrop',
    onClick: (event) => { if (event.target === featurePanel) closeFeaturePanel(nav); },
  });
  document.body.append(featurePanel);
  document.body.classList.add('has-feature-panel');
  renderFeaturePanel(nav);
  drawNav(nav);
  featurePanel.querySelector('.feature-panel__close')?.focus();
}

function closeFeaturePanel(nav) {
  featurePanel?.remove();
  featurePanel = null;
  document.body.classList.remove('has-feature-panel');
  drawNav(nav);
  nav.querySelector('[aria-haspopup="dialog"]')?.focus();
}

function renderFeaturePanel(nav) {
  if (!featurePanel) return;
  const available = navModules(state.modules);
  const pinned = new Set(toolbarKeys);

  const groups = GROUPS.map((group) => ({
    ...group,
    modules: available.filter((module) => module.group === group.key),
  })).filter((group) => group.modules.length);

  featurePanel.replaceChildren(el('section', {
    class: 'feature-panel', role: 'dialog', 'aria-modal': 'true',
    'aria-labelledby': 'feature-panel-title',
  },
  el('header', { class: 'feature-panel__header' },
    el('div', {},
      el('h2', { id: 'feature-panel-title' }, 'All features'),
      el('p', { class: 'muted small' }, 'Open any available feature or choose its toolbar shortcut.')),
    el('button', {
      class: 'feature-panel__close', type: 'button', 'aria-label': 'Close features',
      onClick: () => closeFeaturePanel(nav),
    }, '×')),
  el('div', { class: 'feature-panel__content' },
    groups.map((group) => el('section', { class: 'feature-panel__group' },
      el('h3', { class: 'module-group__title' }, group.title),
      group.modules.map((module) => {
        const isPinned = pinned.has(module.key);
        return el('div', { class: 'feature-panel__row' },
          el('a', {
            class: 'feature-panel__open', href: `#/${module.key}`,
            onClick: () => closeFeaturePanel(nav),
          },
          el('span', { class: 'feature-panel__icon', 'aria-hidden': 'true' }, module.icon),
          el('span', { class: 'feature-panel__text' },
            el('span', { class: 'feature-panel__title' }, module.title),
            el('span', { class: 'muted small' }, module.desc))),
          el('button', {
            class: `feature-panel__pin${isPinned ? ' is-pinned' : ''}`,
            type: 'button', 'aria-pressed': isPinned,
            'aria-label': `${isPinned ? 'Remove' : 'Add'} ${module.title} ${isPinned ? 'from' : 'to'} toolbar`,
            onClick: () => {
              toolbarKeys = setToolbarPinned(toolbarKeys, module.key, !isPinned, state.modules);
              toolbarKeys = saveToolbarKeys(toolbarKeys, state.modules, state.user?.uid);
              drawNav(nav);
              renderFeaturePanel(nav);
              toast(`${module.title} ${isPinned ? 'removed from' : 'added to'} toolbar`);
            },
          }, isPinned ? 'On toolbar' : 'Add'),
        );
      }),
    )),
    el('a', { class: 'btn btn--block', href: './walkthrough.html' }, 'How to use every feature'),
    el('a', {
      class: 'btn btn--block', href: '#/settings', onClick: () => closeFeaturePanel(nav),
    }, 'Manage available features'),
  )));
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && featurePanel) {
    const nav = document.querySelector('.app__nav');
    if (nav) closeFeaturePanel(nav);
  }
});

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
