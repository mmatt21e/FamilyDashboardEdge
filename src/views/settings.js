/**
 * Settings: module toggles, appearance, account, and the shareable setup link.
 */

import { el, toast, getTheme, applyTheme } from '../ui.js';
import { groupedModules, getModule } from '../modules.js';
import { state, setModuleEnabled } from '../store.js';
import { shareSetupCard, resetConfigButton } from './setup.js';
import * as fb from '../firebase.js';

export async function settingsView() {
  return el('div', { class: 'view' },
    el('header', { class: 'view__header' }, el('h1', {}, 'Settings')),
    appearanceCard(),
    modulesCard(),
    shareSetupCard(state.config),
    accountCard(),
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
