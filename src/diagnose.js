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
