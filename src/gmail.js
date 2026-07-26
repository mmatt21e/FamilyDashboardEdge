/**
 * Sending email, from the browser, as the signed-in person.
 *
 * "The app should send the invite as an email" went unbuilt for a while on
 * the grounds that a static site has no mail server - which is true and was
 * the wrong frame. This family runs entirely on Google accounts, and Gmail's
 * API will send mail on behalf of whoever grants it, straight from a browser.
 * No server, no mail provider, no billing: the inviter approves a one-time
 * "send email" permission and the invitation lands in the recipient's inbox
 * from the inviter's own address - which is also why it gets read, instead
 * of rotting in spam like a no-reply.
 *
 * The permission is asked for AT THE MOMENT OF SENDING, never bundled into
 * the everyday Drive consent, and the token that carries it lives in memory
 * for its hour and nowhere else.
 */

import { getScopedToken } from './drive.js';
import { buildRawEmail } from './invites.js';

export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

/**
 * Sends one email. Throws with a message a person can act on.
 */
export async function sendEmail({ to, subject, body, clientId, projectId = null }) {
  const token = await getScopedToken({ clientId, scope: GMAIL_SEND_SCOPE })
    .catch((error) => {
      throw new Error(
        /denied|closed|dismissed/i.test(error?.message ?? '')
          ? 'Google asked for permission to send the email and it was not granted. Nothing was sent.'
          : `Could not get permission to send email: ${error?.message ?? 'Google did not answer.'}`,
      );
    });

  const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: buildRawEmail({ to, subject, body }) }),
  });
  if (response.ok) return;

  const detail = await response.text().catch(() => '');
  throw translateGmailFailure(response.status, detail, projectId);
}

/**
 * The failures that actually happen, named. The big one is the Gmail API not
 * being switched on for the family's Google project - a one-time console
 * step nobody knows about until the first send fails.
 */
function translateGmailFailure(status, detail, projectId) {
  if (status === 403 && /SERVICE_DISABLED|accessNotConfigured|has not been used/i.test(detail)) {
    const error = new Error(
      'Email sending is not switched on for the family’s Google project yet. '
      + 'Enable the Gmail API once and try again.',
    );
    error.fixUrl = 'https://console.cloud.google.com/apis/library/gmail.googleapis.com'
      + (projectId ? `?project=${encodeURIComponent(projectId)}` : '');
    return error;
  }
  if (status === 401) {
    return new Error('Google no longer accepts this session for sending. Try again to re-approve.');
  }
  if (status === 400 && /invalid/i.test(detail)) {
    return new Error('Gmail refused the message. Check the email address and try again.');
  }
  return new Error(`Sending failed (${status}). Try again, or use one of the other options below.`);
}
