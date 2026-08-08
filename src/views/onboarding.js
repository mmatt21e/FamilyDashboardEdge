/**
 * Setup checklist.
 *
 * The dashboard deliberately uses manual photo and video uploads for now.
 * This keeps each person in control of exactly what they share with the family.
 * The final check looks at the shared Drive destination so it confirms that an
 * upload actually arrived, rather than merely trusting a completed checklist.
 */

import { el, spinner, pageHeader } from '../ui.js';
import { goBack } from '../router.js';
import { state } from '../store.js';
import { listFolder } from '../drive.js';
import { isStandalone } from '../firebase.js';

const PROGRESS_KEY = 'fd.onboarding.v2';

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function loadProgress() {
  try { return JSON.parse(localStorage.getItem(PROGRESS_KEY)) ?? {}; }
  catch { return {}; }
}

function saveProgress(progress) {
  localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
}

export async function onboardingView() {
  const progress = loadProgress();
  const container = el('div', { class: 'view' });

  const steps = [
    installStep(),
    addPhotosStep(),
    addVideosStep(),
  ];

  function redraw() {
    saveProgress(progress);
    container.replaceChildren(
      pageHeader('Getting set up', {
        subtitle: 'Add only the photos and videos you choose to share.',
        onBack: () => goBack('/'),
      }),
      ...steps.map((step, index) => stepCard(step, index + 1, progress, redraw)),
      verificationCard(),
    );
  }

  redraw();
  return container;
}

function stepCard(step, number, progress, redraw) {
  const done = step.autoDone ? step.autoDone() : Boolean(progress[step.key]);

  const tick = el('input', {
    type: 'checkbox', class: 'switch__input',
    checked: done || undefined,
    disabled: Boolean(step.autoDone) || undefined,
  });
  tick.addEventListener('change', () => {
    progress[step.key] = tick.checked;
    redraw();
  });

  return el('section', { class: `card step${done ? ' step--done' : ''}` },
    el('div', { class: 'step__head' },
      el('span', { class: 'step__number' }, done ? '✓' : String(number)),
      el('h2', {}, step.title),
    ),
    el('div', { class: 'step__body' }, step.body()),
    !step.autoDone && el('label', { class: 'step__check' },
      el('span', { class: 'switch' }, tick, el('span', { class: 'switch__track' })),
      el('span', {}, 'Done'),
    ),
  );
}

// --- steps -----------------------------------------------------------------

function installStep() {
  return {
    key: 'install',
    title: 'Add this app to your home screen',
    // Detected rather than self-reported: if the app is running standalone,
    // it was installed, and there is nothing to tick.
    autoDone: () => isStandalone(),
    body: () => isStandalone()
      ? el('p', { class: 'muted' }, 'Already installed on this phone.')
      : isIOS()
        ? el('ol', { class: 'help-list' },
            el('li', {}, 'Tap the Share button at the bottom of Safari.'),
            el('li', {}, 'Scroll down and tap ', el('strong', {}, 'Add to Home Screen'), '.'),
            el('li', {}, 'Tap Add. The app then opens like any other app.'))
        : el('ol', { class: 'help-list' },
            el('li', {}, 'Tap the ⋮ menu in Chrome.'),
            el('li', {}, 'Tap ', el('strong', {}, 'Add to Home screen'), '.'),
            el('li', {}, 'Confirm. The app then opens like any other app.')),
  };
}

function addPhotosStep() {
  return {
    key: 'add-photos',
    title: 'Add the photos you want to share',
    body: () => el('div', {},
      el('p', { class: 'muted' },
        'Open Photos, tap Add photos, and select one or more pictures from your phone. Nothing is uploaded unless you choose it.'),
      el('a', {
        class: 'btn btn--primary', href: '#/photos',
      }, 'Open Photos'),
    ),
  };
}

function addVideosStep() {
  return {
    key: 'add-videos',
    title: 'Add the videos you want to share',
    body: () => el('div', {},
      el('p', { class: 'muted' },
        'Open Videos, tap Add videos, and select the clips you want in the family library.'),
      el('a', {
        class: 'btn btn--primary', href: '#/videos',
      }, 'Open Videos'),
    ),
  };
}

// --- verification ----------------------------------------------------------

/**
 * Watches the shared folder for evidence that a manual upload arrived.
 */
function verificationCard() {
  const status = el('div', {}, el('p', { class: 'muted' }, 'Not checked yet.'));
  const check = el('button', { class: 'btn btn--primary' }, 'Check for my photos');

  check.addEventListener('click', async () => {
    check.disabled = true;
    status.replaceChildren(spinner('Looking in the shared folder…'));
    try {
      const { files } = await listFolder(state.config.driveFolderId, {
        clientId: state.config.googleClientId,
        pageSize: 100,
      });

      const folders = files.filter((f) => f.mimeType === 'application/vnd.google-apps.folder');
      const loose = files.filter((f) => f.mimeType !== 'application/vnd.google-apps.folder');

      const perFolder = [];
      for (const folder of folders) {
        try {
          const page = await listFolder(folder.id, {
            clientId: state.config.googleClientId, pageSize: 10,
          });
          const count = page.files.filter((f) => f.mimeType !== 'application/vnd.google-apps.folder').length;
          if (count > 0) perFolder.push({ name: folder.name, count });
        } catch { /* skip folders we cannot read */ }
      }

      const total = loose.length + perFolder.reduce((sum, f) => sum + f.count, 0);

      status.replaceChildren(
        total === 0
          ? el('div', {},
              el('p', { class: 'status status--waiting' }, '⏳ Waiting for the first photo…'),
              el('p', { class: 'muted small' },
                'Nothing has arrived yet. Open Photos or Videos and use the Add button to choose something to share.'))
          : el('div', {},
              el('p', { class: 'status status--ok' }, '✓ Connected'),
              el('p', { class: 'muted small' },
                `${total} ${total === 1 ? 'item is' : 'items are'} in the shared folder.`),
              perFolder.length > 0 && el('ul', { class: 'help-list' },
                perFolder.map((f) => el('li', {}, `${f.name}: ${f.count}`))),
              loose.length > 0 && el('p', { class: 'muted small' },
                `${loose.length} loose in the main folder (no subfolder).`)),
      );
    } catch (error) {
      status.replaceChildren(
        el('p', { class: 'error-text' }, error?.message ?? 'Could not read the shared folder.'));
    } finally {
      check.disabled = false;
    }
  });

  return el('section', { class: 'card' },
    el('h2', {}, 'Did the upload arrive?'),
    el('p', { class: 'muted small' },
      'This checks the shared family folder and tells you what actually arrived.'),
    check,
    status,
  );
}
