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
 * The date a photo was actually taken, which is not the date it reached Drive.
 *
 * PhotoSync uploads a backlog all at once, so `createdTime` is when it synced,
 * often years after the photo was taken. Using it would put a 2015 holiday in
 * this week's memories and break the feature completely. Camera metadata first,
 * then Drive's own timestamps only as a fallback.
 */
export function originalDateFor(driveFile) {
  const exif = parseExifDate(driveFile?.imageMediaMetadata?.time);
  if (exif) return exif;

  const videoTime = driveFile?.videoMediaMetadata?.time;
  const videoExif = parseExifDate(videoTime);
  if (videoExif) return videoExif;

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
 * `ownerHint` is the member this file is attributed to. PhotoSync uploads into
 * a per-person subfolder, so the folder name is usually the best signal for
 * whose photo it is - Drive reports the *account* that owns the file, which for
 * a shared folder is often whoever set it up rather than who took the picture.
 */
export function toPointerRecord(driveFile, { ownerHint = null, folderName = null } = {}) {
  if (!driveFile?.id) return null;

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
    owner: ownerHint ?? folderName ?? null,
    folder: folderName ?? null,
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
