/**
 * Settings: module toggles, appearance, account, and the shareable setup link.
 */

import { el, toast, getTheme, applyTheme, children } from '../ui.js';
import { groupedModules } from '../modules.js';
import { state, setModuleEnabled } from '../store.js';
import { shareSetupCard, resetConfigButton } from './setup.js';
import * as fb from '../firebase.js';
import { notificationsCard } from './notifications-card.js';
import { inviteCard } from './invite.js';
import { installCard } from './install-card.js';
import { foldersCard } from './folders-card.js';
import { versionLabel, buildDate } from '../version.js';

export async function settingsView() {
  return el('div', { class: 'view' },
    el('header', { class: 'view__header' },
      el('h1', {}, 'Settings'),
      versionLine(),
    ),
    ...children(
      installCard(),
      appearanceCard(),
      await notificationsCard(),
      modulesCard(),
      photoTagsCard(),
      foldersCard(),
      await inviteCard(),
      shareSetupCard(state.config),
      accountCard(),
    ),
  );
}

/**
 * The version, under the heading, with a way to act on it.
 *
 * A version number on its own would be half a feature here. The reason anyone
 * looks is that a home-screen PWA runs from a cache, so the phone can be a
 * release or two behind with nothing on screen to say so - and the useful next
 * move is "get the newest one", not "read a number".
 */
function versionLine() {
  const label = el('span', {}, `Version ${versionLabel()}`);
  const status = el('span', {});

  const check = el('button', { class: 'link-btn', type: 'button' }, 'Check for updates');
  check.addEventListener('click', async () => {
    check.disabled = true;
    status.textContent = ' · checking…';
    const found = await checkForUpdate();
    status.textContent = found ? ' · updating…' : ' · already up to date';
    check.disabled = false;
  });

  return el('div', { class: 'muted small row' },
    label,
    buildDate() && el('span', {}, `· ${buildDate()}`),
    status,
    'serviceWorker' in navigator && check,
  );
}

/**
 * Asks the service worker to look for a newer release.
 *
 * When one is found it is told to take over immediately and the page reloads -
 * otherwise a waiting worker sits there until every tab is closed, which for an
 * app people leave open on the home screen can be days.
 *
 * @returns {Promise<boolean>} whether an update was found
 */
async function checkForUpdate() {
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return false;

    await registration.update();
    const waiting = registration.waiting ?? registration.installing;
    if (!waiting) return false;

    navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
    waiting.postMessage({ type: 'SKIP_WAITING' });
    // Installing workers need a moment before they can be activated; the
    // controllerchange listener above catches it either way.
    setTimeout(() => location.reload(), 2500);
    return true;
  } catch {
    return false;
  }
}

function appearanceCard() {
  const options = [
    ['system', 'Match my phone'],
    ['light', 'Light'],
    ['dark', 'Dark'],
  ];
  const current = getTheme();

  return el('section', { class: 'card' },
    el('h2', {}, 'Appearance'),
    el('div', { class: 'segmented' }, options.map(([value, label]) => {
      const button = el('button', {
        class: `segmented__option${value === current ? ' is-active' : ''}`,
        type: 'button',
      }, label);
      button.addEventListener('click', () => {
        applyTheme(value);
        for (const sibling of button.parentElement.children) {
          sibling.classList.toggle('is-active', sibling === button);
        }
      });
      return button;
    })),
  );
}

/**
 * The module list.
 *
 * Everything from the brief is listed, including features that are not built
 * yet - they show as "Coming soon" and cannot be switched on. Showing the full
 * map is more useful than hiding it, as long as it never pretends something
 * works when it does not.
 */
function modulesCard() {
  return el('section', { class: 'card' },
    el('h2', {}, 'Features'),
    el('p', { class: 'muted small' },
      'Turn things on and off for the whole family. Changes apply on everyone’s phone.'),
    groupedModules().map((group) =>
      el('div', { class: 'module-group' },
        el('h3', { class: 'module-group__title' }, group.title),
        group.modules.map(moduleRow),
      )),
  );
}

function moduleRow(module) {
  const planned = module.status !== 'ready';
  const checked = planned ? false : Boolean(state.modules[module.key]);

  const input = el('input', {
    type: 'checkbox', class: 'switch__input',
    checked: checked || undefined,
    disabled: (planned || module.always) || undefined,
    'aria-label': module.title,
  });

  input.addEventListener('change', async () => {
    try {
      await setModuleEnabled(module.key, input.checked);
      window.dispatchEvent(new CustomEvent('fd:modules-changed'));
      toast(`${module.title} ${input.checked ? 'on' : 'off'}`);
    } catch {
      input.checked = !input.checked; // put the switch back if the save failed
      toast('Could not save that change', { error: true });
    }
  });

  return el('label', { class: `module-row${planned ? ' is-planned' : ''}` },
    el('span', { class: 'module-row__icon' }, module.icon),
    el('span', { class: 'module-row__text' },
      el('span', { class: 'module-row__title' }, module.title,
        module.always && el('span', { class: 'pill' }, 'Always on'),
        planned && el('span', { class: 'pill pill--muted' }, 'Coming soon'),
      ),
      el('span', { class: 'muted small' }, module.desc),
    ),
    el('span', { class: 'switch' }, input, el('span', { class: 'switch__track' })),
  );
}

/**
 * The way in to the photo tag import.
 *
 * It lives in Settings rather than in Photos because it is a once-in-a-while
 * job done at a keyboard with the CSVs to hand, not something anyone does while
 * browsing the grid on a phone.
 */
function photoTagsCard() {
  const catalog = state.catalog;

  return el('section', { class: 'card' },
    el('h2', {}, 'Photo tags'),
    catalog
      ? el('p', { class: 'muted small' },
          `${catalog.count.toLocaleString()} photos tagged with ${catalog.people.length} people`
          + `${catalog.events.length ? ` across ${catalog.events.length} events` : ''}. `
          + 'Photos can be filtered by any of them.')
      : el('p', { class: 'muted small' },
          'Import the files from a face-recognition run to filter photos by who is in them, '
          + 'as well as by year and event.'),
    el('a', { class: 'btn', href: '#/photo-tags' }, catalog ? 'Manage photo tags' : 'Import photo tags'),
  );
}

function accountCard() {
  const signOut = el('button', { class: 'btn' }, 'Sign out');
  signOut.addEventListener('click', async () => {
    await fb.signOutUser();
    location.reload();
  });

  return el('section', { class: 'card' },
    el('h2', {}, 'Account'),
    el('div', { class: 'row row--between' },
      el('div', {},
        el('div', {}, state.member?.name ?? 'Signed in'),
        el('div', { class: 'muted small' }, state.member?.email ?? ''),
      ),
      signOut,
    ),
    el('hr', { class: 'rule' }),
    el('p', { class: 'muted small' },
      'Resetting only clears the settings stored on this phone. Your family’s photos stay in Google Drive and your data stays in Firebase.'),
    resetConfigButton(() => location.reload()),
  );
}
