/**
 * What version is actually running.
 *
 * More useful here than in most apps. A home-screen PWA serves itself from a
 * cache, so "I pushed a fix" and "the phone in your hand has the fix" are
 * different statements, and without a version on screen there is no way to tell
 * them apart - you end up debugging a bug that was fixed two deploys ago.
 *
 * `APP_VERSION` is set by hand and describes the app. The build stamp is
 * written in by the deploy workflow, so it names the exact commit the phone is
 * running rather than a number somebody remembered to change. Running from a
 * checkout, nothing replaces the placeholders and it reports itself as a
 * development build, which is the truth.
 */

export const APP_VERSION = '1.3.1';

// Replaced at deploy time - see .github/workflows/deploy.yml.
export const BUILD_SHA = '__BUILD_SHA__';
export const BUILD_DATE = '__BUILD_DATE__';

/**
 * True once the deploy has stamped this file. Detected by the shape of the
 * value rather than by comparing against the placeholder text, because that
 * text is exactly what gets substituted.
 */
export function isReleaseBuild() {
  return /^[0-9a-f]{7,40}$/.test(BUILD_SHA);
}

/** "1.1.0 (a1b2c3d)" or "1.1.0 (development build)". */
export function versionLabel() {
  return `${APP_VERSION} (${isReleaseBuild() ? BUILD_SHA : 'development build'})`;
}

/** The date this build was deployed, or null in a checkout. */
export function buildDate() {
  return /^\d{4}-\d{2}-\d{2}$/.test(BUILD_DATE) ? BUILD_DATE : null;
}
