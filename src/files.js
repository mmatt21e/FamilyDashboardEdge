/**
 * Turning Google Drive files into pointer records.
 *
 * Firestore holds a small record pointing at each file; the bytes stay in the
 * shared Drive folder. That keeps Firestore cheap and, more importantly, keeps
 * the Drive folder a plain readable archive: photos are photos and documents
 * are PDFs, openable by anyone with access to the folder, with or without this
 * app. That is the whole "someone can get at this later" idea.
 *
 * Pure functions only - no network, so this is all testable.
 */

import { dayKeyFor } from './memories.js';

export const KIND = {
  PHOTO: 'photo',
  VIDEO: 'video',
  DOCUMENT: 'document',
  OTHER: 'other',
};

// ---------------------------------------------------------------------------
// Where things live in the shared folder
// ---------------------------------------------------------------------------

/**
 * The folders the app puts things in.
 *
 * The shared folder must not fill up with loose files. Anything dropped in the
 * root is a file nobody can find again in two years, which defeats the point of
 * keeping the archive in plain Drive folders in the first place - the whole
 * promise is that someone can open this folder without the app and understand
 * what they are looking at.
 *
 * These names match the folders already created by hand rather than inventing
 * new ones. They are the *defaults*: the walk reads whatever is actually there.
 */
export const MANAGED = {
  IMAGES: 'Dashboard_Image_Storage',
  VIDEOS: 'Dashboard_Video_Storage',
  DOCUMENTS: 'Dashboard_Document_Storage',
  ARCHIVE: 'Archive',
  EVENTS: 'Events',
};

const MANAGED_NAMES = new Set(
  Object.values(MANAGED).map((name) => name.toLowerCase()),
);

/** "2015", "2015-09", "2015-09-11" - a folder that files by date, not by person. */
export function isDateFolder(name) {
  return /^(19|20)\d{2}(-\d{2}){0,2}$/.test(String(name ?? '').trim());
}

export function isManagedFolder(name) {
  return MANAGED_NAMES.has(String(name ?? '').trim().toLowerCase());
}

/**
 * Who a photo belongs to, from the folders above it.
 *
 * The top-level person folder is normally the answer, so `Dad/IMG_0042.jpg` is
 * Dad's. But the app's own folders organise
 * rather than identify, so it looks one level past them:
 *
 *   Dad/2026/…                          -> Dad
 *   Dashboard_Image_Storage/Jocey/…     -> Jocey
 *   Archive/2015/2015-09/…              -> nobody, and that is correct
 *
 * The archive genuinely has no owner. Everyone is in it, which is what the
 * people tags are for; claiming it belongs to "2015" or to "Archive" would put
 * a meaningless entry in the filter menu and a wrong one in the caption.
 */
export function ownerFromPath(path = []) {
  for (const segment of path) {
    if (!segment) continue;
    if (isManagedFolder(segment) || isDateFolder(segment)) continue;
    return segment;
  }
  return null;
}

const pad = (n) => String(n).padStart(2, '0');

/**
 * A person's name, made safe to use as a folder.
 *
 * A slash would silently create a folder level in Drive, so "Mom/Dad" must not
 * become a folder called Dad inside one called Mom.
 */
export function folderSafeName(name, fallback = 'Shared') {
  const clean = String(name ?? '')
    .replace(/[\\/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return clean || fallback;
}

/** Where a family member's photos live. One folder each, under the image store. */
export function personFolderPath(name) {
  return [MANAGED.IMAGES, folderSafeName(name)];
}

/**
 * Where a newly added file should be put.
 *
 * Photos go under the person who added them and then by month, so the folder
 * stays browsable as it grows and a phone's worth of holiday snaps does not
 * land in one directory of nine thousand. Anything that is not a photo or video
 * goes to the document folder by year - documents are far fewer and nobody
 * looks for a school letter by month.
 */
export function uploadPathFor({ kind = KIND.PHOTO, person = null, date = new Date() } = {}) {
  const when = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = String(when.getFullYear());
  const month = `${year}-${pad(when.getMonth() + 1)}`;

  // Videos get a store of their own, mirroring the photo one - person, then
  // month. Mixed in with photos they made both libraries worse: a video is
  // found by "that trip", not by scrolling a photo grid hoping for a ▶ badge.
  if (kind === KIND.VIDEO) {
    return [MANAGED.VIDEOS, folderSafeName(person), month];
  }
  if (kind === KIND.PHOTO) {
    return [...personFolderPath(person), month];
  }
  return [MANAGED.DOCUMENTS, year];
}

export function kindForMime(mime = '') {
  if (mime.startsWith('image/')) return KIND.PHOTO;
  if (mime.startsWith('video/')) return KIND.VIDEO;
  if (mime === 'application/pdf' || mime.startsWith('text/')) return KIND.DOCUMENT;
  return KIND.OTHER;
}

/**
 * Parses Drive's EXIF date format, "YYYY:MM:DD HH:MM:SS".
 *
 * Note the colons in the date part - this is not ISO 8601 and `new Date()`
 * will not parse it on every browser, so it is converted by hand. The value is
 * local time as recorded by the camera, with no timezone, which is what we
 * want: a photo belongs to the day it looked like where it was taken.
 */
export function parseExifDate(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  const date = new Date(y, mo - 1, d, h, mi, s);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Reads a date out of a filename.
 *
 * Worth doing because of a real number: on this family's archive only about
 * half the photos carry a "Date taken" at all. Scans, screenshots, anything
 * that has been through a messaging app or a Google Takeout export has had its
 * camera metadata stripped somewhere along the way. Without this those photos
 * fall through to Drive's timestamps, which for a bulk upload is the day it was
 * uploaded - so a 2008 birthday lands in this week's Memories.
 *
 * The names that carry a date are the ones an organiser produced:
 *
 *     2015-09-11_161042_Jocelyn_DSC_0088_ae577ab9.jpg
 *     IMG_20150911_161042.jpg          phone cameras
 *     VID-20150911-WA0002.mp4          WhatsApp
 *     Screenshot_2015-09-11-16-10-42.png
 *
 * Deliberately conservative. It anchors on a four-digit year between 1990 and
 * next year, and demands a real calendar date, because a filename is a guess
 * and a wrong guess is worse here than no guess at all: "1234-56-78" must not
 * become a memory.
 */
export function dateFromFilename(name, { now = new Date() } = {}) {
  const text = String(name ?? '');
  // YYYY-MM-DD or YYYYMMDD, optionally followed by a time, with any of the
  // usual separators in between.
  const m = /(19[9]\d|20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})(?:[-_.T ]?(\d{2})[-_.:]?(\d{2})[-_.:]?(\d{2})?)?/.exec(text);
  if (!m) return null;

  const [, y, mo, d, h, mi, s] = m.map((v) => (v == null ? null : Number(v)));
  if (y < 1990 || y > now.getFullYear() + 1) return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  if (h != null && (h > 23 || mi > 59 || (s != null && s > 59))) return null;

  const date = new Date(y, mo - 1, d, h ?? 12, mi ?? 0, s ?? 0);
  // Rejects the 31st of a 30-day month and the 29th of February in most years,
  // which JavaScript would otherwise roll silently into the following month.
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  // A date in the future is a version number or a serial, not a photograph.
  if (date.getTime() > now.getTime()) return null;

  return date;
}

/**
 * The date a photo was actually taken, which is not the date it reached Drive.
 *
 * A backlog can be uploaded all at once, so `createdTime` is when it arrived,
 * often years after the photo was taken. Using it would put a 2015 holiday in
 * this week's memories and break the feature completely.
 *
 * The order is most trustworthy first: what the camera recorded, then what the
 * filename says, and only then Drive's own timestamps - which are a last resort
 * rather than an answer.
 */
export function originalDateFor(driveFile) {
  const exif = parseExifDate(driveFile?.imageMediaMetadata?.time);
  if (exif) return exif;

  const videoTime = driveFile?.videoMediaMetadata?.time;
  const videoExif = parseExifDate(videoTime);
  if (videoExif) return videoExif;

  const named = dateFromFilename(driveFile?.name);
  if (named) return named;

  for (const field of ['createdTime', 'modifiedTime']) {
    const raw = driveFile?.[field];
    if (raw) {
      const date = new Date(raw);
      if (!Number.isNaN(date.getTime())) return date;
    }
  }
  return null;
}

/**
 * Maps a Drive API file resource to the record stored in Firestore.
 *
 * `ownerHint` is the member this file is attributed to. Uploads use a
 * per-person subfolder, so the folder name is usually the best signal for
 * whose photo it is - Drive reports the *account* that owns the file, which for
 * a shared folder is often whoever set it up rather than who took the picture.
 */
export function toPointerRecord(driveFile, { ownerHint = null, path = [] } = {}) {
  if (!driveFile?.id) return null;

  const folders = (path ?? []).filter(Boolean);
  const folderName = folders.length ? folders[folders.length - 1] : null;

  const mime = driveFile.mimeType ?? '';
  const taken = originalDateFor(driveFile);

  return {
    driveId: driveFile.id,
    name: driveFile.name ?? 'Untitled',
    mime,
    kind: kindForMime(mime),
    size: Number(driveFile.size ?? 0) || 0,
    // Preserved so the memory feed works. Null when Drive told us nothing,
    // rather than quietly substituting "now" and poisoning the feed.
    takenAt: taken ? taken.toISOString() : null,
    dayKey: taken ? dayKeyFor(taken) : null,
    width: driveFile.imageMediaMetadata?.width ?? null,
    height: driveFile.imageMediaMetadata?.height ?? null,
    thumbnailUrl: driveFile.thumbnailLink ?? null,
    // Derived from the whole path, not just the folder it sits in: in a nested
    // archive that folder is "2015-09", which is a good thing to filter by and
    // a useless answer to whose photo this is.
    owner: ownerHint ?? ownerFromPath(folders),
    folder: folderName,
    // Kept so the app can tell an archive photo from somebody's phone upload
    // without re-deriving it from the folder names every time.
    path: folders,
    addedAt: new Date().toISOString(),
  };
}

/** Human-readable file size for the UI. */
export function formatSize(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Newest first, tolerating records whose date is unknown (they sort last). */
export function sortByTakenDesc(records) {
  return [...(records ?? [])].sort((a, b) => {
    if (!a.takenAt && !b.takenAt) return 0;
    if (!a.takenAt) return 1;
    if (!b.takenAt) return -1;
    return b.takenAt.localeCompare(a.takenAt);
  });
}
