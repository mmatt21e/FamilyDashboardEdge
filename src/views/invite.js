/**
 * Sending invitations, and what the recipient sees.
 *
 * Three things live here:
 *
 *   1. the card in Settings that creates, emails and manages invitations
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
  inviteMessage, inviteSubject, looksLikeEmail, normaliseEmail, DEFAULT_EXPIRY_DAYS,
} from '../invites.js';
import { sendEmail } from '../gmail.js';
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

  // The list redraws on its own; the form is built once and left alone.
  // Redrawing the whole card was how the "✓ Emailed" panel used to vanish
  // the instant it appeared: creating an invitation refreshed the list, the
  // refresh rebuilt the form, and the fresh form arrived empty.
  const listSlot = el('div');
  const drawList = async () => {
    let pending = [];
    try {
      pending = await fb.queryDocs('invitations', { orderBy: ['createdAt', 'desc'], limit: 50 });
    } catch {
      // Rules not published yet. The form above still explains itself.
    }

    listSlot.replaceChildren(...children(
      pending.length > 0 && el('div', { class: 'invite-list' },
        el('h3', {}, 'Invitations you have sent'),
        pending.map((invitation) => inviteRow(invitation, drawList)),
      ),
    ));
  };

  card.replaceChildren(
    el('h2', {}, 'Invite someone'),
    el('p', { class: 'muted small' },
      'Enter their email and the dashboard emails them the invitation itself, from '
      + 'your own address. The link sets their phone up, walks them through adding '
      + 'it to their home screen, and lets them sign in with their own Google account.'),
    inviteForm(drawList),
    listSlot,
  );

  await drawList();
  return card;
}

function inviteForm(onChanged) {
  const name = el('input', { class: 'input', type: 'text', placeholder: 'Their name (optional)' });
  const email = el('input', {
    class: 'input', type: 'email', placeholder: 'Their Google account email',
    autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false',
  });
  const send = el('button', { class: 'btn btn--primary' }, 'Send the invitation');
  const note = el('p', { class: 'muted small' },
    'The email is sent from your own Gmail address, so it arrives from someone they '
    + 'recognise instead of a no-reply. The first time, Google asks you once for '
    + 'permission to send email on your behalf.');
  const output = el('div');

  // The button promises only what will actually happen: with an address the
  // app sends the email itself; without one all it can do is hand over a link.
  const relabel = () => {
    send.textContent = email.value.trim() ? 'Send the invitation' : 'Create an invitation link';
  };
  email.addEventListener('input', relabel);
  relabel();

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
      name.value = '';
      email.value = '';
      relabel();
      await onChanged?.();

      if (address) {
        await emailFlow({ invitation, link, output, onChanged });
      } else {
        output.replaceChildren(sharePanel(invitation, link));
      }
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
 * Sending the email, and owning the result.
 *
 * An earlier version of this screen handed over a mailto link and called it
 * sending. On a computer with no mail app a mailto click does nothing at all -
 * no error, no window - which from the outside is indistinguishable from the
 * invitation being lost, and that is exactly what happened. Now the app sends
 * the email itself through Gmail as the signed-in inviter (src/gmail.js), and
 * this flow shows one of three honest states: sending, sent, or failed with
 * the reason and a retry.
 */
async function emailFlow({ invitation, link, output, onChanged }) {
  const familyName = state.config?.familyName ?? 'our family';
  const message = inviteMessage({
    familyName,
    fromName: state.member?.name?.split(' ')[0] ?? '',
    link,
  });

  const attempt = async () => {
    output.replaceChildren(el('div', { class: 'card card--inset' },
      spinner(`Emailing ${invitation.email}…`)));

    try {
      await sendEmail({
        to: invitation.email,
        subject: inviteSubject(familyName),
        body: message,
        clientId: state.config?.googleClientId,
        projectId: state.config?.firebase?.projectId ?? null,
      });

      // The stamp is what makes "did it actually go?" answerable later from
      // the list below. If the write fails the email is out regardless, so a
      // missing stamp must not be reported as a failed send.
      await fb.setDoc('invitations', invitation.code, {
        sentAt: new Date().toISOString(),
        sentBy: state.user?.uid ?? null,
      }).catch(() => {});

      output.replaceChildren(sentPanel(invitation, link, message));
      await onChanged?.();
    } catch (error) {
      output.replaceChildren(failedPanel({ invitation, link, message, error, retry: attempt }));
    }
  };

  await attempt();
}

function sentPanel(invitation, link, message) {
  return el('div', { class: 'card card--inset' },
    el('h3', {}, `✓ Emailed to ${invitation.email}`),
    el('p', { class: 'muted small' },
      `It was sent from your own Gmail address, so tell ${invitation.name || 'them'} to `
      + 'look for a message from you — and to check spam if it is not there. '
      + `The invitation works for ${DEFAULT_EXPIRY_DAYS} days and only for ${invitation.email}.`),
    el('details', {},
      el('summary', { class: 'muted small' }, 'Send it another way too'),
      el('div', { class: 'row' }, ...shareActions(invitation, link, message)),
    ),
  );
}

function failedPanel({ invitation, link, message, error, retry }) {
  const retryButton = el('button', { class: 'btn btn--primary' }, 'Try sending again');
  retryButton.addEventListener('click', retry);

  return el('div', { class: 'card card--inset' },
    el('h3', {}, 'The email did not go out'),
    el('p', { class: 'error-text' }, error?.message ?? 'Sending failed.'),

    // translateGmailFailure attaches the console page for the one failure
    // with a real fix behind it: the Gmail API not yet enabled for the
    // family's project.
    error?.fixUrl && el('p', { class: 'small' },
      el('a', { href: error.fixUrl, target: '_blank', rel: 'noopener' },
        'Open the Google page where it is switched on')),

    el('p', { class: 'muted small' },
      'The invitation itself is saved and still valid — only the email failed. '
      + 'Retry, or send the message yourself:'),
    el('textarea', { class: 'input input--code', rows: 5, readonly: true }, message),
    el('div', { class: 'row' }, retryButton, ...shareActions(invitation, link, message)),
  );
}

/** A link-only invitation: nothing to email, so hand over the message. */
function sharePanel(invitation, link) {
  const message = inviteMessage({
    familyName: state.config?.familyName ?? 'our family',
    fromName: state.member?.name?.split(' ')[0] ?? '',
    link,
  });

  return el('div', { class: 'card card--inset' },
    el('h3', {}, invitation.name ? `Invitation for ${invitation.name}` : 'Invitation link ready'),
    el('p', { class: 'muted small' },
      'No email address was given, so nothing was emailed — share this message with '
      + 'whoever it is for:'),
    el('textarea', { class: 'input input--code', rows: 5, readonly: true }, message),
    el('div', { class: 'row' }, ...shareActions(invitation, link, message)),
    el('p', { class: 'muted small' },
      `Works for ${DEFAULT_EXPIRY_DAYS} days, once, for whoever opens it. `
      + 'It stays valid until it is used, so you can send it again if it goes astray.'),
  );
}

/**
 * The manual routes, kept as understudies: Gmail's compose screen filled in
 * (works in any browser signed in to Google, which is the whole family by
 * construction), the share sheet, and plain copying.
 */
function shareActions(invitation, link, message) {
  const gmail = invitation.email && el('a', {
    class: 'btn', target: '_blank', rel: 'noopener',
    href: 'https://mail.google.com/mail/?view=cm&fs=1'
      + `&to=${encodeURIComponent(invitation.email)}`
      + `&su=${encodeURIComponent(inviteSubject(state.config?.familyName ?? 'our family'))}`
      + `&body=${encodeURIComponent(message)}`,
  }, 'Write it in Gmail yourself');

  const share = el('button', { class: 'btn' }, navigator.share ? 'Share…' : 'Copy the message');
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

  return children(gmail, share, copyLink);
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
          // "created" and "emailed" are different claims, and the difference
          // is the whole reason the sentAt stamp exists.
          invitation.sentAt
            ? `emailed ${formatDate(invitation.sentAt)}`
            : `created ${formatDate(invitation.createdAt)}`].filter(Boolean).join(' · ')),
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
