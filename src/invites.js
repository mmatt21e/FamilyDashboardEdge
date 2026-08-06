/**
 * Invitations.
 *
 * Until now, adding someone to the family meant opening the Firebase console
 * and creating a document by hand. That is fine for the person who set the app
 * up and hopeless for everyone else, so anyone already in the family can now
 * send an invitation from inside the app.
 *
 * What an invitation actually does is narrow: it lets one person write their
 * own document into /members, which is the allowlist every security rule keys
 * off. Nothing else. The setup link that goes with it carries the project
 * settings so the recipient never sees a Firebase field.
 *
 * Two decisions worth stating, both of them about what happens when a link
 * escapes:
 *
 *  - **Every invitation is bound to an email address.** Only that Google
 *    account can use it, so a forwarded link is worthless to anybody else.
 *    Link-only invitations used to be supported, but made possession of a
 *    forwarded URL equivalent to permission to join the family.
 *
 *  - **An invitation is spent only once a membership actually exists.** An
 *    earlier design marked the token used as soon as someone opened the link,
 *    which meant anyone who saw a forwarded copy could burn it and lock out the
 *    person it was meant for. The join therefore writes the member document
 *    first and marks the invitation afterwards; if the first step fails the
 *    invitation is still live.
 *
 * Pure functions only - no network, no DOM.
 */

/** How long an invitation stays usable. Long enough to be seen, short enough to expire. */
export const DEFAULT_EXPIRY_DAYS = 14;

/** Codes are compared, sent and typed, so the alphabet avoids look-alikes. */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const CODE_LENGTH = 20;

/**
 * A random invitation code.
 *
 * From the platform's cryptographic source, not Math.random: this string is the
 * only thing standing between a stranger and the family's photos, and a
 * predictable one would be guessable in bulk. Rejection sampling keeps the
 * alphabet evenly distributed rather than biasing the first few letters.
 */
export function generateCode(randomBytes = defaultRandomBytes) {
  let code = '';
  while (code.length < CODE_LENGTH) {
    for (const byte of randomBytes(CODE_LENGTH)) {
      if (byte >= 256 - (256 % ALPHABET.length)) continue;
      code += ALPHABET[byte % ALPHABET.length];
      if (code.length === CODE_LENGTH) break;
    }
  }
  return code;
}

function defaultRandomBytes(count) {
  return crypto.getRandomValues(new Uint8Array(count));
}

/** True for something that could plausibly be an email address. */
export function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value ?? '').trim());
}

export function normaliseEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * Builds the record stored in /invitations.
 *
 * `expiresAt` is epoch milliseconds rather than an ISO string so the security
 * rules can compare it against request.time directly. Everywhere else in this
 * app dates are ISO strings; this one is a number because a rule cannot parse a
 * string into a timestamp.
 */
export function buildInvitation({
  code, name = '', email = '', invitedBy = null, invitedByName = '',
  days = DEFAULT_EXPIRY_DAYS, now = Date.now(),
} = {}) {
  const address = normaliseEmail(email);
  if (!address) throw new Error('Enter the Google account email for this invitation.');
  if (!looksLikeEmail(address)) throw new Error('That does not look like an email address.');

  const lifetimeDays = Number(days);
  if (!Number.isFinite(lifetimeDays) || lifetimeDays <= 0 || lifetimeDays > DEFAULT_EXPIRY_DAYS) {
    throw new Error(`Invitations must expire within ${DEFAULT_EXPIRY_DAYS} days.`);
  }

  return {
    code,
    name: String(name ?? '').trim(),
    email: address,
    invitedBy,
    invitedByName: String(invitedByName ?? '').trim(),
    createdAt: new Date(now).toISOString(),
    expiresAt: now + lifetimeDays * 24 * 60 * 60 * 1000,
    usedBy: null,
    usedAt: null,
    revoked: false,
  };
}

/**
 * Whether an invitation can be used, and by whom.
 *
 * Returns a reason rather than a bare false, because every one of these ends up
 * on a screen in front of somebody who needs to know what to do next.
 */
export function checkInvitation(invitation, { email = null, now = Date.now() } = {}) {
  if (!invitation) {
    return { ok: false, reason: 'unknown', message: 'That invitation could not be found. Ask for a new one.' };
  }
  if (invitation.revoked) {
    return { ok: false, reason: 'revoked', message: 'That invitation was cancelled. Ask for a new one.' };
  }
  if (invitation.usedBy) {
    return { ok: false, reason: 'used', message: 'That invitation has already been used.' };
  }
  if (Number(invitation.expiresAt) <= now) {
    return { ok: false, reason: 'expired', message: 'That invitation has expired. Ask for a new one.' };
  }
  if (!looksLikeEmail(invitation.email)) {
    return {
      ok: false,
      reason: 'unsafe',
      message: 'That invitation is not tied to a Google account and can no longer be used. Ask for a new one.',
    };
  }
  if (normaliseEmail(email) !== invitation.email) {
    return {
      ok: false,
      reason: 'wrong-account',
      message: `This invitation is for ${invitation.email}. Sign in with that Google account, or ask for an invitation for the one you are using.`,
    };
  }
  return { ok: true, reason: 'ok', message: '' };
}

/** Status for the list of invitations someone has sent. */
export function describeInvitation(invitation, now = Date.now()) {
  if (!invitation) return { label: 'Unknown', state: 'gone' };
  if (invitation.revoked) return { label: 'Cancelled', state: 'gone' };
  if (invitation.usedBy) return { label: 'Joined', state: 'used' };
  if (Number(invitation.expiresAt) <= now) return { label: 'Expired', state: 'gone' };

  const days = Math.ceil((Number(invitation.expiresAt) - now) / (24 * 60 * 60 * 1000));
  return { label: days <= 1 ? 'Expires today' : `${days} days left`, state: 'pending' };
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/**
 * An invitation link is a setup link with the code appended.
 *
 * Deliberately a separate fragment parameter rather than another field inside
 * the encoded payload: the setup link already works and is already tested, and
 * a plain readable `&invite=` on the end keeps the two concerns separable. It
 * also means an invitation link can be pasted into the existing "someone sent
 * me a link" box and still configure the device, even if the invitation part
 * has expired.
 *
 * @param {string} setupLink the result of toSetupLink()
 */
export function toInviteLink(setupLink, code) {
  if (!code) return setupLink;
  return `${setupLink}&invite=${encodeURIComponent(code)}`;
}

/** Reads an invitation code out of a link, a hash, or a pasted fragment. */
export function parseInviteCode(input) {
  if (typeof input !== 'string') return null;
  const match = /[#&?]invite=([A-Za-z0-9\-_]+)/.exec(input.trim());
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// The email itself
// ---------------------------------------------------------------------------

/** The subject line. Kept plain: this lands in a relative's inbox. */
export function inviteSubject(familyName = 'our family') {
  return `Join ${familyName}'s photo dashboard`;
}

const CRLF = '\r\n';

/** Base64url over UTF-8 bytes, the encoding the Gmail API wants. */
function base64urlUtf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** RFC 2047 for a subject with anything past ASCII in it - a curly quote, say. */
function encodeHeaderText(text) {
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `=?UTF-8?B?${btoa(binary)}?=`;
}

/**
 * The raw RFC 822 message the Gmail API sends verbatim.
 *
 * Built by hand because it is five headers and a body, and a MIME library
 * would be the largest dependency in the app. From: is left to Gmail, which
 * stamps the authenticated sender - the one header nobody should be able to
 * write for themselves.
 */
export function buildRawEmail({ to, subject, body }) {
  const message = [
    `To: ${to}`,
    `Subject: ${encodeHeaderText(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
  ].join(CRLF) + CRLF + CRLF + body;

  return base64urlUtf8(message);
}

/**
 * The message that gets sent.
 *
 * Written to be readable in a text message, with the link on its own line so
 * every messaging app on earth turns it into something tappable.
 */
export function inviteMessage({ familyName = 'our family', fromName = '', link = '' } = {}) {
  const from = fromName ? `${fromName} has ` : 'You have been ';
  return `${from}invited you to ${familyName}'s photo dashboard.\n\n`
    + `Open this on your phone and it will walk you through adding it to your home screen:\n${link}\n\n`
    + 'Sign in with your own Google account — there are no shared passwords.';
}
