/**
 * "On this day" logic.
 *
 * Firestore cannot query "same month and day, any year" - there is no way to
 * express that against a timestamp field. So every file pointer record carries
 * a `dayKey` ("MM-DD") written at the time it is saved, and the feed matches on
 * that instead. This is the reason the field exists.
 *
 * The matching currently happens in the browser, over the listing already in
 * memory - for a family library that is faster than a round trip. The field is
 * shaped for a server-side equality query so that stays available if the
 * library ever outgrows loading in one go.
 *
 * Everything here is pure so it can be tested without a browser or a database.
 */

const pad = (n) => String(n).padStart(2, '0');

/** "MM-DD" for a date, in local time - a photo belongs to the day you took it. */
export function dayKeyFor(date) {
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Which dayKeys today's memory feed should ask for.
 *
 * Normally one. The exception is 29 February: in a non-leap year that date does
 * not exist, so photos taken on a leap day would silently never resurface -
 * once every four years is exactly when you most want to see them. On 1 March
 * in a non-leap year we therefore also pull 02-29.
 */
export function dayKeysForToday(today = new Date()) {
  const keys = [dayKeyFor(today)];
  const isMarchFirst = today.getMonth() === 2 && today.getDate() === 1;
  if (isMarchFirst && !isLeapYear(today.getFullYear())) {
    keys.push('02-29');
  }
  return keys;
}

/**
 * Groups items into "this time N years ago" buckets, newest first.
 *
 * Items from the current year are dropped: a photo from this morning is not a
 * memory, and showing it makes the feed feel broken.
 *
 * @param {Array<{takenAt: string}>} items pointer records with an ISO date
 * @param {Date} today
 */
export function groupByYearsAgo(items, today = new Date()) {
  const thisYear = today.getFullYear();
  const buckets = new Map();

  for (const item of items ?? []) {
    const when = item?.takenAt ? new Date(item.takenAt) : null;
    if (!when || Number.isNaN(when.getTime())) continue;

    const yearsAgo = thisYear - when.getFullYear();
    if (yearsAgo < 1) continue;

    if (!buckets.has(yearsAgo)) buckets.set(yearsAgo, []);
    buckets.get(yearsAgo).push(item);
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([yearsAgo, list]) => ({
      yearsAgo,
      year: thisYear - yearsAgo,
      label: describeYearsAgo(yearsAgo),
      items: list.sort((a, b) => String(a.takenAt).localeCompare(String(b.takenAt))),
    }));
}

export function describeYearsAgo(yearsAgo) {
  if (yearsAgo === 1) return 'Last year';
  return `${yearsAgo} years ago`;
}

/**
 * A gentle prompt when the feed is empty.
 *
 * A brand new family dashboard has nothing to resurface, which makes the best
 * feature look broken on day one. The brief calls for encouraging old photos to
 * be imported at setup; this is the copy that does it.
 */
export function emptyMemoryPrompt(hasAnyPhotos) {
  return hasAnyPhotos
    ? 'Nothing from this day in previous years yet. As the years go by, this fills up on its own.'
    : 'No memories yet. Drop some older photos into the shared folder and they will start showing up here on their anniversaries.';
}
