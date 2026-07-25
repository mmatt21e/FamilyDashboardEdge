/**
 * Sending invitations, and what the recipient sees.
 *
 * Three things live here:
 *
 *   1. the card in Settings that creates and manages invitations
 *   2. the "add this to your home screen" step an invited person lands on
 *   3. the screen shown when somebody signs in without being on the allowlist
 *
 * On the install step, read the note at the top of src/install.js first: a link
 * cannot install a web app on either platform. Android can be given a real
 * one-tap install button; iOS cannot, and gets the two taps spelled out
 * instead. What this screen adds on top of that is catching the case that
 * actually goes wrong - an invitation arrives inside a messaging app, whose
 * browser has no "add to home screen" at all.
 */

import { el, toast, children, spinner, formatDate } from '../ui.js';
import { state } from '../store.js';
import * as fb from '../firebase.js';
import { toSetupLink } from '../config.js';
import {
  generateCode, buildInvitation, describeInvitation, toInviteLink,
  inviteMessage, looksLikeEmail, normaliseEmail, DEFAULT_EXPIRY_DAYS,
} from '../invites.js';
import {
  installGuidance, promptToInstall, canPromptToInstall,
  dismissInstall, installDismissed, shouldOfferInstall,
} from '../install.js';

// ---------------------------------------------------------------------------
// Carrying the invitation through sign-in
// ---------------------------------------------------------------------------
// Signing in with Google on a home-screen app is a full page redirect, so the
// URL - and the invitation code in it - is gone by the time we come back.
// sessionStorage survives that and is cleared when the tab closes, which is
// exactly the lifetime an invitation code should have on a device.

const CODE_KEY = 'fd.invite.code';
const ARRIVED_KEY = 'fd.invite.arrived';

export function rememberInvite(code) {
  try {
    if (code) sessionStorage.setItem(CODE_KEY, code);
    sessionStorage.setItem(ARRIVED_KEY, '1');
  } catch { /* private mode; the invitation just has to be used in one go */ }
}

export function recallInvite() {
  try { return sessionStorage.getItem(CODE_KEY); } catch { return null; }
}

/** True when this session began by following a link somebody sent. */
export function arrivedFromLink() {
  try { return sessionStorage.getItem(ARRIVED_KEY) === '1'; } catch { return false; }
}

export function forgetInvite() {
  try {
    sessionStorage.removeItem(CODE_KEY);
    sessionStorage.removeItem(ARRIVED_KEY);
  } catch { /* nothing to do */ }
}

// ---------------------------------------------------------------------------
// Settings: sending an invitation
// ---------------------------------------------------------------------------

export async function inviteCard() {
  const card = el('section', { class: 'card' });
  card.replaceChildren(spinner('Loading invitations…'));

  const draw = async () => {
    let pending = [];
    try {
      pending = await fb.queryDocs('invitations', { orderBy: ['createdAt', 'desc'], limit: 50 });
    } catch {
      // Rules not published yet. The form below still explains itself.
    }

    card.replaceChildren(...children(
      el('h2', {}, 'Invite someone'),
      el('p', { class: 'muted small' },
        'Creates a link that sets their phone up, walks them through adding it to their '
        + 'home screen, and lets them sign in with their own Google account.'),
      inviteForm(draw),
      pending.length > 0 && el('div', { class: 'invite-list' },
        el('h3', {}, 'Invitations you have sent'),
        pending.map((invitation) => inviteRow(invitation, draw)),
      ),
    ));
  };

  await draw();
  return card;
}

function inviteForm(onChanged) {
  const name = el('input', { class: 'input', type: 'text', placeholder: 'Their name (optional)' });
  const email = el('input', {
    class: 'input', type: 'email', placeholder: 'Their Google account email',
    autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false',
  });
  const send = el('button', { class: 'btn btn--primary' }, 'Create invitation');
  const note = el('p', { class: 'muted small' },
    'This creates the invitation and hands you the message. The dashboard has no '
    + 'server and no mail account, so it cannot post it for you — you send it from '
    + 'your own email or messages, which is also why it arrives from an address they '
    + 'recognise.');
  const output = el('div');

  send.addEventListener('click', async () => {
    const address = normaliseEmail(email.value);
    if (address && !looksLikeEmail(address)) {
      return toast('That does not look like an email address', { error: true });
    }

    send.disabled = true;
    try {
      const code = generateCode();
      const invitation = buildInvitation({
        code,
        name: name.value,
        email: address,
        invitedBy: state.user?.uid ?? null,
        invitedByName: state.member?.name ?? '',
      });

      await fb.setDoc('invitations', code, invitation, { merge: false });

      const link = toInviteLink(toSetupLink(state.config), code);
      output.replaceChildren(sharePanel(invitation, link));
      name.value = '';
      email.value = '';
      await onChanged?.();
    } catch (error) {
      toast(error?.message ?? 'Could not create the invitation', { error: true });
    } finally {
      send.disabled = false;
    }
  });

  return el('div', {},
    el('div', { class: 'field' }, name),
    el('div', { class: 'field' },
      email,
      el('span', { class: 'field__hint' },
        'With an email address the invitation only works for that Google account, so a '
        + 'forwarded link is useless to anyone else. Leave it blank and anyone with the '
        + 'link can join once.'),
    ),
    el('div', { class: 'row' }, send),
    note,
    output,
  );
}

/**
 * The invitation, ready to send.
 *
 * **The app does not send anything.** It is a static site with no server and no
 * mail account, so there is nothing here that could put a message in somebody's
 * inbox. What it does is hand you the message and open whichever app actually
 * sends it - your mail client, or the phone's share sheet.
 *
 * That distinction was not clear enough before: the button said "Send it",
 * which reads as a promise the app cannot keep, and an invitation that was
 * never sent looks exactly like one that was lost.
 */
function sharePanel(invitation, link) {
  const message = inviteMessage({
    familyName: state.config?.familyName ?? 'our family',
    fromName: state.member?.name?.split(' ')[0] ?? '',
    link,
  });
  const subject = `Join ${state.config?.familyName ?? 'our family'}’s photo dashboard`;

  // mailto opens the person's own mail app with everything filled in. It is the
  // only way a site with no server can reach an inbox, and it has the pleasant
  // side effect that the invitation comes from a real address the recipient
  // recognises rather than a no-reply nobody trusts.
  const email = invitation.email && el('a', {
    class: 'btn btn--primary',
    href: `mailto:${encodeURIComponent(invitation.email)}`
      + `?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}`,
  }, `Email ${invitation.email}`);

  const share = el('button', { class: invitation.email ? 'btn' : 'btn btn--primary' },
    navigator.share ? 'Share…' : 'Copy the message');
  share.addEventListener('click', async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Family dashboard', text: message });
        return;
      } catch {
        // Cancelled, or refused. Fall through to copying.
      }
    }
    await copy(message, 'Invitation copied — paste it into a message');
  });

  const copyLink = el('button', { class: 'btn' }, 'Copy just the link');
  copyLink.addEventListener('click', () => copy(link, 'Link copied'));

  return el('div', { class: 'card card--inset' },
    el('h3', {}, invitation.name ? `Invitation for ${invitation.name}` : 'Invitation ready'),

    el('p', { class: 'muted small' },
      'The invitation is saved. Nothing has been sent yet — pick how to send it:'),

    el('textarea', { class: 'input input--code', rows: 5, readonly: true }, message),
    el('div', { class: 'row' }, ...children(email, share, copyLink)),

    el('p', { class: 'muted small' },
      `Works for ${DEFAULT_EXPIRY_DAYS} days`
      + (invitation.email ? `, and only for ${invitation.email}.` : ', once, for whoever opens it.')
      + ' It stays valid until it is used, so you can send it again if it goes astray.'),
  );
}

async function copy(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    toast('Could not copy — select the text and copy it by hand', { error: true });
  }
}

function inviteRow(invitation, onChanged) {
  const status = describeInvitation(invitation);

  const cancel = el('button', { class: 'btn btn--danger btn--small' }, 'Cancel');
  cancel.addEventListener('click', async () => {
    cancel.disabled = true;
    try {
      await fb.setDoc('invitations', invitation.code ?? invitation.id, { revoked: true });
      toast('Invitation cancelled');
      await onChanged?.();
    } catch (error) {
      cancel.disabled = false;
      toast(error?.message ?? 'Could not cancel that invitation', { error: true });
    }
  });

  return el('div', { class: 'invite-row' },
    el('div', { class: 'invite-row__text' },
      el('div', {}, invitation.name || invitation.email || 'Anyone with the link'),
      el('div', { class: 'muted small' },
        [invitation.email && invitation.name ? invitation.email : null,
          `sent ${formatDate(invitation.createdAt)}`].filter(Boolean).join(' · ')),
    ),
    el('span', { class: `pill pill--${status.state}` }, status.label),
    status.state === 'pending' && cancel,
  );
}

// ---------------------------------------------------------------------------
// The install step
// ---------------------------------------------------------------------------

/**
 * Shown to an invited person before they sign in.
 *
 * Never a dead end: "Carry on in the browser" is always there, because the
 * dashboard works perfectly well in a tab and trapping someone behind an
 * install step they cannot complete would be worse than not asking.
 */
export function installView({ familyName = 'the family', onContinue }) {
  const container = el('div', { class: 'view view--install' });

  const draw = () => {
    const guidance = installGuidance();

    const skip = el('button', { class: 'btn btn--link' }, 'Carry on in the browser');
    skip.addEventListener('click', () => {
      dismissInstall();
      onContinue?.();
    });

    container.replaceChildren(...children(
      el('div', { class: 'setup__logo' }, '🏡'),
      el('h1', {}, guidance.title),
      el('p', { class: 'muted' },
        guidance.detail
        ?? `You have been invited to ${familyName}'s dashboard. Adding it to your home screen makes it open like a normal app.`),

      guidance.mode === 'prompt' && installButton(onContinue),
      guidance.steps.length > 0 && el('ol', { class: 'install-steps' },
        guidance.steps.map((step) => el('li', {}, step))),
      guidance.copyLink && copyCurrentLink(),

      guidance.mode === 'manual' && el('p', { class: 'muted small' },
        'Once it is on your home screen, open it from there and sign in.'),

      el('div', { class: 'row row--center' }, skip),
    ));
  };

  function installButton(done) {
    const button = el('button', { class: 'btn btn--primary btn--block' }, 'Add to home screen');
    button.addEventListener('click', async () => {
      button.disabled = true;
      const outcome = await promptToInstall();

      if (outcome === 'accepted') {
        toast('Added — you can open it from your home screen now');
        done?.();
        return;
      }
      // Dismissed, or the browser withdrew the offer. Redraw so the manual
      // instructions take over rather than leaving a button that does nothing.
      button.disabled = false;
      draw();
    });
    return button;
  }

  draw();
  return container;
}

function copyCurrentLink() {
  const button = el('button', { class: 'btn' }, 'Copy this link');
  button.addEventListener('click', () => copy(location.href, 'Link copied — paste it into your browser'));
  return el('div', { class: 'row row--center' }, button);
}

/**
 * Whether the invited person should be stopped at the install step.
 *
 * Once somebody has said "carry on in the browser" it stays said - being asked
 * again on every reload is how a helpful prompt turns into a nuisance. Settings
 * still carries the same offer for whenever they change their mind.
 */
export function wantsInstallStep() {
  return shouldOfferInstall() && !installDismissed() && installGuidance().mode !== 'none';
}

export { canPromptToInstall };

// ---------------------------------------------------------------------------
// Signed in, but not on the list
// ---------------------------------------------------------------------------

/**
 * What somebody sees when their Google account is not in the family.
 *
 * This used to be a dead end telling them to read the README. Now it is the
 * place an invitation gets redeemed, including one pasted in by hand - which is
 * what happens when a messaging app mangles a long link, and it happens often
 * enough to design for.
 */
export function notAMemberView({ user, message = null, onJoined }) {
  const container = el('div', { class: 'view' });

  const paste = el('input', {
    class: 'input', type: 'text', placeholder: 'Paste your invitation link',
    autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false',
  });
  const join = el('button', { class: 'btn btn--primary' }, 'Join the family');
  const status = el('div', {});

  join.addEventListener('click', async () => {
    const { parseInviteCode, checkInvitation } = await import('../invites.js');
    const code = parseInviteCode(paste.value) ?? paste.value.trim();
    if (!code) {
      return status.replaceChildren(el('p', { class: 'error-text' },
        'Paste the whole invitation link from the message.'));
    }

    join.disabled = true;
    status.replaceChildren(spinner('Checking your invitation…'));

    const invitation = await fb.getInvitation(code);
    const verdict = checkInvitation(invitation, { email: user?.email });
    if (!verdict.ok) {
      join.disabled = false;
      return status.replaceChildren(el('p', { class: 'error-text' }, verdict.message));
    }

    try {
      await fb.joinWithInvite(user, code);
      forgetInvite();
      onJoined?.();
    } catch (error) {
      join.disabled = false;
      status.replaceChildren(el('p', { class: 'error-text' },
        error?.message ?? 'Could not join with that invitation.'));
    }
  });

  container.replaceChildren(...children(
    el('div', { class: 'setup__logo' }, '✉️'),
    el('h1', {}, 'You need an invitation'),
    el('p', { class: 'muted' },
      `You are signed in as ${user?.email ?? 'this account'}, which has not been added to the family yet.`),
    message && el('p', { class: 'error-text' }, message),

    el('div', { class: 'card' },
      el('h2', {}, 'Have an invitation link?'),
      el('p', { class: 'muted small' },
        'Paste it here. Long links often get cut short by messaging apps, so if this '
        + 'does not work, ask for it again.'),
      paste,
      el('div', { class: 'row' }, join),
      status,
    ),

    el('p', { class: 'muted small' },
      'Otherwise, ask someone already in the family to send you one from their Settings screen.'),
    el('button', {
      class: 'btn',
      onClick: async () => { forgetInvite(); await fb.signOutUser(); location.reload(); },
    }, 'Sign in with a different account'),
  ));

  return container;
}
