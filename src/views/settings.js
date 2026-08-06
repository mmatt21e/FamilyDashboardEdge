/**
 * Settings: module toggles, appearance, account, and the shareable setup link.
 */

import { el, toast, getTheme, applyTheme, children } from '../ui.js';
import { groupedModules } from '../modules.js';
import { state, setModuleEnabled, setFamilyName } from '../store.js';
import { shareSetupCard, resetConfigButton } from './setup.js';
import * as fb from '../firebase.js';
import { notificationsCard } from './notifications-card.js';
import { inviteCard } from './invite.js';
import { installCard } from './install-card.js';
import { foldersCard } from './folders-card.js';
import { versionLabel, buildDate } from '../version.js';
import { newerBuild, applyUpdate } from '../update.js';

export async function settingsView() {
  return el('div', { class: 'view' },
    el('header', { class: 'view__header' },
      el('h1', {}, 'Settings'),
      versionLine(),
    ),
    ...children(
      installCard(),
      nameCard(),
      appearanceCard(),
      await notificationsCard(),
      modulesCard(),
      walkthroughCard(),
      privacyCard(),
      photoTagsCard(),
      foldersCard(),
      await inviteCard(),
      shareSetupCard(state.config),
      accountCard(),
    ),
  );
}

function walkthroughCard() {
  return el('section', { class: 'card' },
    el('h2', {}, 'Feature walkthrough'),
    el('p', { class: 'muted small' }, 'A searchable guide to every available module and the quickest way to use it.'),
    el('a', { class: 'btn', href: './walkthrough.html' }, 'Open the walkthrough'));
}

function privacyCard() {
  return el('section', { class: 'card' },
    el('h2', {}, 'Privacy and access'),
    el('p', { class: 'muted small' },
      'Google keeps this device signed in. Family data stays behind the invitation and member list.'),
    el('div', { class: 'row' },
      el('a', { class: 'btn', href: './privacy.html' }, 'Privacy Policy'),
      el('a', { class: 'btn', href: './terms.html' }, 'Terms')),
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
 * "Is the build I am running the build being served?" - asked of the server,
 * not of the service worker's state machine. The worker skip-waits, so by the
 * time anyone looked for a waiting worker there usually was none, the old
 * check said "already up to date", and the page never reloaded off the old
 * code. See src/update.js for the full story.
 *
 * @returns {Promise<boolean>} whether an update was found and is being applied
 */
async function checkForUpdate() {
  const live = await newerBuild();
  if (!live) return false;
  await applyUpdate(live);
  return true;
}

/**
 * Renaming the dashboard.
 *
 * The name was set once during setup and there was no way to change it short
 * of resetting the whole configuration. The rename is written family-wide
 * (see setFamilyName in store.js), so one edit here renames it on everyone's
 * phone at their next launch - not just this one.
 */
function nameCard() {
  const input = el('input', {
    class: 'input', type: 'text',
    value: state.config?.familyName ?? '',
    placeholder: 'The Smiths',
    'aria-label': 'Dashboard name',
  });
  const save = el('button', { class: 'btn' }, 'Rename');

  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const name = await setFamilyName(input.value);
      input.value = name;
      toast(`Renamed to ${name}`);
    } catch (error) {
      toast(error?.message ?? 'Could not save the name', { error: true });
    } finally {
      save.disabled = false;
    }
  });

  return el('section', { class: 'card' },
    el('h2', {}, 'Dashboard name'),
    el('p', { class: 'muted small' },
      'Shown on the home screen and in invitation emails. Renaming it here renames it '
      + 'for the whole family — everyone else sees the new name the next time they open the app.'),
    el('div', { class: 'field' }, input),
    el('div', { class: 'row' }, save),
  );
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
 * Everything from the brief is listed. The status handling remains so a future
 * idea can be named honestly before it is built, but version 2.0 completes the
 * original module catalog and unlocks it for the family.
 */
function modulesCard() {
  return el('section', { class: 'card' },
    el('h2', {}, 'Features'),
    el('p', { class: 'muted small' },
      'Choose what is available to the whole family. Each person can choose their own toolbar shortcuts from the Features panel.'),
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
