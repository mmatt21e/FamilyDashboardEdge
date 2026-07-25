/**
 * Startup self-diagnosis.
 *
 * WHY THIS EXISTS
 * ---------------
 * The app once hung forever on "Starting..." because Cloud Firestore had never
 * been created in the Firebase project. The Firestore SDK does not fail when
 * its backend is missing - it opens a listen channel, gets a 503, and retries
 * indefinitely. Nothing throws, nothing logs, and the spinner stays up.
 *
 * Working that out took a full audit of two Google consoles. The app had the
 * information to say it in one line and said nothing, which is the actual bug:
 * an app that cannot start should explain why.
 *
 * So when startup overruns, we probe Firestore's REST API directly. Unlike the
 * SDK it answers immediately and distinguishes "backend not provisioned" from
 * "backend fine, you just are not allowed in" - which is exactly the difference
 * between a misconfiguration and normal operation.
 *
 * The interpretation is a pure function so it can be tested against the real
 * response bodies Google returns.
 */

/** How long startup may take before we assume something is wrong. */
export const STARTUP_TIMEOUT_MS = 15_000;

/**
 * Turns a Firestore REST probe into a diagnosis.
 *
 * @param {{status?: number, body?: string, networkError?: string}} probe
 * @returns {{code: string, title: string, detail: string, fix?: string, url?: string}}
 */
export function interpretFirestoreProbe(probe, projectId = '') {
  const { status, body = '', networkError } = probe ?? {};

  if (networkError) {
    return {
      code: 'offline',
      title: 'Cannot reach Google',
      detail: 'The app could not contact Google’s servers at all.',
      fix: 'Check this device is online. If you are on a work or school network, or using a VPN or ad blocker, it may be blocking googleapis.com.',
    };
  }

  // The database has never been created, or the API is switched off. Google
  // reports this as a 403 whose body says SERVICE_DISABLED - deliberately
  // distinguished from a permission 403, which means the opposite.
  if (/SERVICE_DISABLED/i.test(body) || /has not been used in project/i.test(body)) {
    return {
      code: 'firestore-not-created',
      title: 'The database has not been set up yet',
      detail: `Cloud Firestore has never been created in the Firebase project "${projectId}". Everything else is fine — there is simply nowhere to store your family’s messages and settings yet.`,
      fix: 'Open the Firebase console, choose Firestore Database, and click Create database. Pick Production mode, then publish the security rules from firestore.rules.',
      url: projectId ? `https://console.firebase.google.com/project/${projectId}/firestore` : null,
    };
  }

  if (status === 404 || /database .*does not exist/i.test(body)) {
    return {
      code: 'firestore-not-created',
      title: 'The database has not been set up yet',
      detail: `No Firestore database exists in the project "${projectId}".`,
      fix: 'Open the Firebase console, choose Firestore Database, and click Create database.',
      url: projectId ? `https://console.firebase.google.com/project/${projectId}/firestore` : null,
    };
  }

  // 401/403 without SERVICE_DISABLED is the *healthy* answer: the database is
  // there and the security rules are turning away an unauthenticated request,
  // which is precisely what they should do.
  if (status === 401 || status === 403) {
    return {
      code: 'firestore-reachable',
      title: 'Still starting',
      detail: 'The database is reachable and responding normally, so the hold-up is something else.',
      fix: 'Try reloading. If it keeps happening, open the browser console and look for errors.',
    };
  }

  if (status === 400 && /project/i.test(body)) {
    return {
      code: 'bad-project',
      title: 'That project does not look right',
      detail: `Google did not recognise the project "${projectId}".`,
      fix: 'Check the Firebase settings in Setup match your project exactly.',
    };
  }

  return {
    code: 'unknown',
    title: 'Startup is taking longer than expected',
    detail: status ? `The database replied with status ${status}.` : 'No clear cause found.',
    fix: 'Try reloading. If it persists, open the browser console and look for errors.',
  };
}

/**
 * Asks Firestore's REST API whether the database exists.
 *
 * Unauthenticated on purpose: we only care whether the backend is provisioned,
 * and an anonymous request answers that in one round trip. A short timeout
 * keeps a diagnostic from becoming a second thing that hangs.
 */
export async function probeFirestore(projectId, { timeoutMs = 8000, fetchImpl = fetch } = {}) {
  if (!projectId) return { networkError: 'no project id configured' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(
      `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/members`,
      { signal: controller.signal },
    );
    const body = await response.text().catch(() => '');
    return { status: response.status, body };
  } catch (error) {
    return { networkError: error?.message ?? String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe, then interpret. */
export async function diagnoseStartup(config, options = {}) {
  const projectId = config?.firebase?.projectId ?? '';
  const probe = await probeFirestore(projectId, options);
  return { ...interpretFirestoreProbe(probe, projectId), projectId };
}


// ---------------------------------------------------------------------------
// Google Drive
// ---------------------------------------------------------------------------

/**
 * Turns a Drive or sign-in failure into something a person can act on.
 *
 * Drive needs three separate things switched on, in three different consoles,
 * and getting any one wrong produces an unhelpful error. Rather than surface
 * "Drive error 403" we name the missing setting and link to the page.
 *
 * @param {{status?: number, body?: string, message?: string}} failure
 */
export function interpretDriveFailure(failure, { projectId = '', folderId = '' } = {}) {
  const { status, body = '', message = '' } = failure ?? {};
  const text = `${body} ${message}`;

  // The Drive API itself has never been enabled in the Cloud project.
  if (/SERVICE_DISABLED/i.test(text) || /Google Drive API has not been used in project/i.test(text)) {
    return {
      code: 'drive-api-disabled',
      title: 'Google Drive is not switched on yet',
      detail: 'The Drive API has not been enabled for this project, so the app cannot read the shared folder.',
      fix: 'In Google Cloud Console, open APIs & Services → Library, search for Google Drive API, and click Enable.',
      url: projectId
        ? `https://console.cloud.google.com/apis/library/drive.googleapis.com?project=${projectId}`
        : 'https://console.cloud.google.com/apis/library/drive.googleapis.com',
    };
  }

  // GIS refuses to issue a token to an origin it does not recognise, and to
  // anyone who is not a test user while the app is unpublished. Both surface
  // as a failure to obtain a token rather than an HTTP status.
  if (/no_token|token_timeout|popup|idpiframe|origin|access_denied|unregistered|invalid_client|401/i.test(text)) {
    return {
      code: 'drive-not-authorised',
      title: 'Google would not grant access to Drive',
      detail: 'Google refused to issue permission for this site — usually shown as “Error 401: invalid_client” or “no registered origin”. That is almost always one of two settings.',
      fix: 'In Google Cloud Console: (1) APIs & Services → Credentials → your Web client → add https://mmatt21e.github.io to Authorised JavaScript origins, with no path or trailing slash. (2) OAuth consent screen → Test users → add every family member’s email.',
      url: projectId
        ? `https://console.cloud.google.com/apis/credentials?project=${projectId}`
        : 'https://console.cloud.google.com/apis/credentials',
    };
  }

  if (status === 404) {
    return {
      code: 'drive-folder-missing',
      title: 'That shared folder could not be found',
      detail: folderId
        ? `No Drive folder with the ID "${folderId}" is visible to your account.`
        : 'No shared folder ID has been set.',
      fix: 'Check the folder ID in Settings matches the code after /folders/ in the folder’s web address, and that the folder is shared with you.',
    };
  }

  if (status === 401) {
    return {
      code: 'drive-expired',
      title: 'Drive access expired',
      detail: 'The permission Google issued has run out.',
      fix: 'Reload the page to ask for it again.',
    };
  }

  return {
    code: 'drive-unknown',
    title: 'Could not read the shared folder',
    detail: message || (status ? `Google Drive replied with status ${status}.` : 'No further detail.'),
    fix: 'Try again. If it keeps happening, check the Drive settings in Google Cloud Console.',
  };
}
