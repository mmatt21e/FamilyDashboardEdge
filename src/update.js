/**
 * Getting the running app onto the newest build.
 *
 * The old update check asked the service-worker state machine - "is there a
 * worker waiting?" - and that question has a wrong answer built in: this
 * app's worker skip-waits during install, so by the time update() resolved
 * the new worker had usually already activated and NOTHING was waiting. The
 * check said "already up to date", never reloaded, and the page kept running
 * the old modules with the new worker sitting idle underneath it. From the
 * outside: the app simply never updates, however often you ask it to.
 *
 * So the question is now the only one that matters: is the build this page is
 * RUNNING the build the server is SERVING? The running one is baked into
 * version.js at deploy; the served one is one no-store fetch away. When they
 * differ, pull the new worker in and reload into it. No state machine.
 */

import { BUILD_SHA, isReleaseBuild } from './version.js';

const SHA_PATTERN = /BUILD_SHA = '([0-9a-f]{7,40})'/;

/**
 * The build the server is serving right now, or null when it cannot be known
 * (offline, or a development checkout with nothing stamped).
 */
export async function liveBuildSha() {
  try {
    // The query string keeps this out of the service worker's cache matching,
    // and the worker additionally ignores no-store requests outright - a
    // cached answer to "what is live right now" is no answer at all.
    const response = await fetch(`src/version.js?live=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) return null;
    return SHA_PATTERN.exec(await response.text())?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The newer build's sha, or null when this IS the newest (or nothing is known). */
export async function newerBuild() {
  if (!isReleaseBuild()) return null;
  const live = await liveBuildSha();
  return live && live !== BUILD_SHA ? live : null;
}

/**
 * Reloads into the newest build. Resolves only by navigating away.
 *
 * The controllerchange listener goes on BEFORE update() is called - the whole
 * lesson of the old bug is that the new worker can finish activating faster
 * than the code that is watching for it. The timeout covers the remaining
 * case: a worker that activated before we ever looked, where no further event
 * is coming and the caches are already fresh, so a plain reload lands on the
 * new build.
 */
export async function applyUpdate() {
  const registration = await navigator.serviceWorker?.getRegistration?.();
  if (!registration) return location.reload();

  navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
  try {
    await registration.update();
  } catch {
    // Offline mid-check; the reload below will land back on this build.
  }
  registration.waiting?.postMessage({ type: 'SKIP_WAITING' });
  setTimeout(() => location.reload(), 4000);
}

// One attempt per served build, per session. If reloading did not get us onto
// the newer build - a proxy pinning an old copy, say - trying again on the
// next launch would reload forever.
const TRIED_KEY = 'fd.update.tried';

/**
 * The launch-time check: if the server has moved on, reload once into it.
 * This is what makes updating automatic rather than a button somebody has to
 * know about - the worker refreshes in the background as it always did, and
 * the next open notices and completes the job.
 */
export async function autoUpdate({ onUpdating = null } = {}) {
  try {
    const live = await newerBuild();
    if (!live) return false;

    if (sessionStorage.getItem(TRIED_KEY) === live) return false;
    sessionStorage.setItem(TRIED_KEY, live);

    onUpdating?.(live);
    await applyUpdate();
    return true;
  } catch {
    return false;
  }
}
