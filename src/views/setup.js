/**
 * Setup and sign-in.
 *
 * This screen exists because nothing account-specific is committed to the repo.
 * One person fills it in, then shares a setup link so nobody else has to.
 */

import { el, toast, spinner, children } from '../ui.js';
import {
  saveConfig, validateConfig, parseFirebaseSnippet, parseSetupCode,
  toSetupLink, loadConfig, clearConfig, normaliseConfig,
} from '../config.js';

/**
 * @param {object} options
 * @param {(config:object)=>void} options.onSaved
 */
export function setupView({ onSaved, existing = null } = {}) {
  const current = existing ?? loadConfig() ?? {};
  const errorBox = el('div', { class: 'form__errors', hidden: true });

  const familyName = field('Family name', 'text', current.familyName ?? '', 'The Smiths');
  const firebasePaste = el('textarea', {
    class: 'input input--code', rows: 7, spellcheck: 'false',
    placeholder: 'Paste the whole firebaseConfig block from the Firebase console here',
  });
  if (current.firebase?.apiKey) {
    firebasePaste.value = JSON.stringify(current.firebase, null, 2);
  }

  const clientId = field(
    'Google client ID', 'text', current.googleClientId ?? '',
    '1234-abc.apps.googleusercontent.com',
  );
  const folderId = field(
    'Shared Drive folder ID', 'text', current.driveFolderId ?? '',
    'The long code in the folder’s web address',
  );

  const save = el('button', { class: 'btn btn--primary btn--block' }, 'Save and continue');
  save.addEventListener('click', () => {
    const firebase = parseFirebaseSnippet(firebasePaste.value);
    if (!firebase) {
      return showErrors([
        'Could not find your Firebase settings in that text. Copy everything the '
        + 'Firebase console shows you — it needs to include apiKey and projectId.',
      ]);
    }

    const candidate = normaliseConfig({
      familyName: familyName.input.value,
      firebase,
      googleClientId: clientId.input.value,
      driveFolderId: folderId.input.value,
    });

    const errors = validateConfig(candidate);
    if (errors.length) return showErrors(errors);

    try {
      const saved = saveConfig(candidate);
      toast('Settings saved');
      onSaved?.(saved);
    } catch (error) {
      showErrors([error.message]);
    }
  });

  function showErrors(messages) {
    // children() filters the conditional out. Passing `false` straight to
    // replaceChildren stringifies it, printing "false" under the message.
    errorBox.replaceChildren(...children(
      el('p', {}, messages.length === 1 ? messages[0] : 'Please check the following:'),
      messages.length > 1 && el('ul', {}, messages.map((m) => el('li', {}, m))),
    ));
    errorBox.hidden = false;
    errorBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  return el('div', { class: 'view view--setup' },
    el('header', { class: 'setup__header' },
      el('div', { class: 'setup__logo' }, '🏡'),
      el('h1', {}, 'Set up your family dashboard'),
      el('p', { class: 'muted' },
        'This is a one-off. Once it is done you can send everyone else a link that sets up their phone in one tap.'),
    ),
    errorBox,
    pasteCodeCard(onSaved, showErrors),
    el('div', { class: 'card' },
      familyName.node,
      el('label', { class: 'field' },
        el('span', { class: 'field__label' }, 'Firebase settings'),
        el('span', { class: 'field__hint' },
          'Firebase console → Project settings → Your apps → Web app. Copy the whole firebaseConfig block and paste it here.'),
        firebasePaste,
      ),
      clientId.node,
      folderId.node,
      save,
    ),
    el('details', { class: 'card card--muted' },
      el('summary', {}, 'Where do I find these?'),
      el('ol', { class: 'help-list' },
        el('li', {}, el('strong', {}, 'Firebase settings: '),
          'console.firebase.google.com → create a project → add a Web app. Turn on Firestore and Google sign-in.'),
        el('li', {}, el('strong', {}, 'Google client ID: '),
          'the same Firebase project shows one under Authentication → Sign-in method → Google → Web SDK configuration.'),
        el('li', {}, el('strong', {}, 'Drive folder ID: '),
          'open the shared folder in Google Drive. The address ends with /folders/XXXX — the XXXX part is the ID.'),
      ),
      el('p', { class: 'muted small' },
        'None of these are secret. They identify your project rather than granting access to it, which is why they are safe to type into an app and share with family.'),
    ),
  );
}

/**
 * "Someone sent me a link" — the first thing on the Setup screen.
 *
 * A setup link is a few hundred characters, and messaging apps wrap or truncate
 * URLs that long. When that happens the recipient lands here and would
 * otherwise be asked for Firebase details they should never have to see. This
 * accepts the whole link, the #setup=... fragment, or just the code, so a
 * broken link costs one paste rather than a trip through the Google console.
 */
function pasteCodeCard(onSaved, showErrors) {
  const input = el('textarea', {
    class: 'input input--code', rows: 2, spellcheck: 'false',
    placeholder: 'Paste the link your family sent you',
  });

  const use = el('button', { class: 'btn btn--primary' }, 'Use this link');
  use.addEventListener('click', () => {
    const parsed = parseSetupCode(input.value);
    if (!parsed) {
      return showErrors([
        'That does not look like a setup link. Copy the whole link from the message — if it was cut short, ask for it again.',
      ]);
    }
    const errors = validateConfig(parsed);
    if (errors.length) {
      return showErrors(['That setup link is incomplete. Ask whoever sent it to copy the whole thing.', ...errors]);
    }
    try {
      const saved = saveConfig(parsed);
      toast('Set up from your family’s link');
      onSaved?.(saved);
    } catch (error) {
      showErrors([error.message]);
    }
  });

  return el('details', { class: 'card', open: true },
    el('summary', {}, 'Someone sent me a setup link'),
    el('p', { class: 'muted small' },
      'If a family member sent you a link, paste it here. You will not need any of the settings below.'),
    input,
    el('div', { class: 'row row--end' }, use),
  );
}

/** Shown after setup so the rest of the family can be onboarded in one tap. */
export function shareSetupCard(config) {
  const link = toSetupLink(config);
  const input = el('input', { class: 'input', readonly: true, value: link });

  const copy = el('button', { class: 'btn' }, 'Copy link');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast('Link copied — send it to the family');
    } catch {
      input.select();
      toast('Press and hold to copy the link');
    }
  });

  return el('div', { class: 'card' },
    el('h2', {}, 'Set up everyone else'),
    el('p', { class: 'muted' },
      'Send this link to each family member. Opening it on their phone fills in all of these settings for them.'),
    input,
    el('div', { class: 'row' }, copy),
    el('p', { class: 'muted small' },
      'Send it privately — in your family chat, not anywhere public.'),
  );
}

export function signInView({ config, onSignIn }) {
  const button = el('button', { class: 'btn btn--primary btn--block' }, 'Sign in with Google');
  const status = el('div', {});

  button.addEventListener('click', async () => {
    button.disabled = true;
    status.replaceChildren(spinner('Signing in…'));
    try {
      await onSignIn();
    } catch (error) {
      status.replaceChildren(el('p', { class: 'error-text' }, error?.message ?? 'Sign-in failed.'));
      button.disabled = false;
    }
  });

  return el('div', { class: 'view view--signin' },
    el('div', { class: 'setup__logo' }, '🏡'),
    el('h1', {}, config?.familyName ?? 'Family Dashboard'),
    el('p', { class: 'muted' }, 'Sign in with your own Google account. There are no shared passwords.'),
    el('p', { class: 'muted small' },
      'You will stay signed in on this device until you sign out or clear this browser’s data.'),
    button,
    status,
    el('p', { class: 'muted small' },
      'Signing in confirms you agree to the ',
      el('a', { href: './terms.html', target: '_blank', rel: 'noopener' }, 'Terms'),
      ' and have read the ',
      el('a', { href: './privacy.html', target: '_blank', rel: 'noopener' }, 'Privacy Policy'),
      '.'),
  );
}

/** Confirmation before wiping local settings, since it signs the device out. */
export function resetConfigButton(onDone) {
  const button = el('button', { class: 'btn btn--danger' }, 'Reset this device');
  button.addEventListener('click', () => {
    if (!confirm('This clears the settings on this phone only. Your family’s photos and data are not affected. Continue?')) return;
    clearConfig();
    onDone?.();
  });
  return button;
}

function field(label, type, value, placeholder) {
  const input = el('input', { class: 'input', type, value: value ?? '', placeholder: placeholder ?? '' });
  const node = el('label', { class: 'field' },
    el('span', { class: 'field__label' }, label),
    input,
  );
  return { node, input };
}
