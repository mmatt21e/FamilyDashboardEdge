/**
 * Setup checklist.
 *
 * A PWA cannot install another app, cannot grant itself photo permissions and
 * cannot configure PhotoSync. All it can do is explain each step clearly, link
 * straight to the right place, and then *check whether it worked* - which is
 * the important part.
 *
 * Verification happens at the destination, not on the phone: the app watches
 * the shared Drive folder for that person's first photo. If it appears, it
 * worked; nothing else needs to be trusted or self-reported.
 */

import { el, spinner, toast, pageHeader } from '../ui.js';
import { goBack } from '../router.js';
import { state } from '../store.js';
import { listFolder } from '../drive.js';
import { isStandalone } from '../firebase.js';

const PHOTOSYNC_IOS = 'https://apps.apple.com/app/photosync-transfer-backup/id415850124';
const PHOTOSYNC_ANDROID = 'https://play.google.com/store/apps/details?id=com.touchbyte.photosync';
const PROGRESS_KEY = 'fd.onboarding.v1';

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
    photoSyncInstallStep(),
    photoAccessStep(),
    destinationStep(),
    autotransferStep(),
  ];

  const rendered = steps.map((step, index) => stepCard(step, index + 1, progress, redraw));

  function redraw() {
    saveProgress(progress);
    container.replaceChildren(
      pageHeader('Getting set up', {
        subtitle: 'Five short steps, once per phone. Photos then arrive on their own.',
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

function photoSyncInstallStep() {
  return {
    key: 'photosync',
    title: 'Install PhotoSync',
    body: () => el('div', {},
      el('p', { class: 'muted' },
        'PhotoSync is what actually moves photos off the phone. This app cannot do that itself — phones do not allow it.'),
      el('a', {
        class: 'btn btn--primary', target: '_blank', rel: 'noopener',
        href: isIOS() ? PHOTOSYNC_IOS : PHOTOSYNC_ANDROID,
      }, isIOS() ? 'Open in the App Store' : 'Open in Google Play'),
    ),
  };
}

function photoAccessStep() {
  return {
    key: 'access',
    title: 'Give PhotoSync access to all photos',
    body: () => el('div', {},
      el('p', { class: 'muted' },
        'When PhotoSync asks for photos, choose ', el('strong', {}, 'All Photos'),
        ' — not "Selected Photos". If it only gets a few, only a few will ever sync.'),
      isIOS() && el('p', { class: 'muted small' },
        'If you tapped the wrong option: Settings → PhotoSync → Photos → All Photos.'),
    ),
  };
}

/**
 * The folder ID is shown with a copy button rather than asking anyone to
 * transcribe a 33-character string on a phone keyboard.
 */
function destinationStep() {
  return {
    key: 'destination',
    title: 'Point PhotoSync at the family folder',
    body: () => {
      const folderId = state.config?.driveFolderId ?? '';
      const copy = el('button', { class: 'btn' }, 'Copy folder ID');
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(folderId); toast('Folder ID copied'); }
        catch { toast('Press and hold the ID to copy it'); }
      });

      return el('div', {},
        el('ol', { class: 'help-list' },
          el('li', {}, 'In PhotoSync, open ', el('strong', {}, 'Settings → Configure → Google Drive'), '.'),
          el('li', {}, 'Sign in with your own Google account.'),
          el('li', {}, 'Set the target folder to the family folder below.'),
          el('li', {}, 'Give this phone its own subfolder named after you — that is how the app knows whose photos are whose.'),
        ),
        el('div', { class: 'code-row' }, el('code', {}, folderId || '—'), copy),
        el('a', {
          class: 'link', target: '_blank', rel: 'noopener',
          href: `https://drive.google.com/drive/folders/${folderId}`,
        }, 'Open the folder in Google Drive'),
      );
    },
  };
}

function autotransferStep() {
  return {
    key: 'autotransfer',
    title: 'Turn on Autotransfer',
    body: () => el('div', {},
      el('p', { class: 'muted' },
        'In PhotoSync: ', el('strong', {}, 'Settings → Autotransfer'),
        ' → turn it on and choose the Google Drive target you just set up.'),
      el('p', { class: 'muted small' },
        'Worth also enabling "when charging" so a big first upload does not flatten the battery.'),
    ),
  };
}

// --- verification ----------------------------------------------------------

/**
 * Watches the shared folder for evidence that this phone's photos are arriving.
 *
 * Deliberately checks the destination rather than the device: PhotoSync can
 * look correctly configured and still not be uploading, and only the folder
 * knows the truth.
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
                'Nothing has arrived yet. Open PhotoSync, make sure Autotransfer is on, and try a manual sync once — the first upload usually needs a nudge.'))
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
    el('h2', {}, 'Is it working?'),
    el('p', { class: 'muted small' },
      'This looks in the shared folder rather than at your phone, so it tells you what actually arrived.'),
    check,
    status,
  );
}
