/**
 * Corrections made by hand.
 *
 * The imported catalog is a machine's opinion about who is in a photo, and
 * machines get it wrong: it misses a face in shadow, confuses two siblings, and
 * inherits whatever wrong date the camera had. So anyone in the family can fix
 * a photo while looking at it - add a person, remove one that is not there,
 * correct or clear the date, put it in an event.
 *
 * Those corrections live in their own place, separate from the catalog, for one
 * reason: **a re-import must never undo them**. Running the face tools again
 * replaces the whole catalog. It does not touch this. A person who looked at a
 * photo and said who is in it is a better source than a face model, and stays
 * that way.
 *
 * Shape of a stored correction:
 *
 *   { driveId, name, people?, event?, takenAt?, editedAt, editedBy }
 *
 * A field is an override *only when the key is present*. That is what lets
 * "this photo has no date" (takenAt: null) mean something different from "the
 * date was never corrected" (no takenAt key at all) - a distinction the app
 * needs, because clearing a wrong date is one of the things people ask for
 * most.
 *
 * Keyed by Drive id rather than filename. Filenames repeat - every camera makes
 * a DSC_0220.JPG eventually - and applying someone's correction to the wrong
 * photo is worse than losing it if the file is ever re-uploaded.
 *
 * Pure functions only.
 */

import { dayKeyFromIso } from './catalog.js';

/** The fields a person can override. Everything else about a photo is Drive's. */
export const EDITABLE = ['people', 'event', 'takenAt'];

/**
 * Merges corrections over the records.
 *
 * Order matters and runs Drive → catalog → corrections, narrowest source last.
 */
export function applyEdits(records, edits) {
  if (!edits || (edits.size ?? 0) === 0) return records ?? [];

  return (records ?? []).map((record) => {
    const edit = edits.get(record.driveId);
    if (!edit) return record;

    const next = { ...record, edited: true };

    if (Object.hasOwn(edit, 'people')) next.people = edit.people ?? [];
    if (Object.hasOwn(edit, 'event')) next.event = edit.event ?? null;
    if (Object.hasOwn(edit, 'takenAt')) {
      next.takenAt = edit.takenAt ?? null;
      // Kept in step, or a corrected date would never reach the memory feed.
      next.dayKey = dayKeyFromIso(next.takenAt);
    }
    return next;
  });
}

/**
 * Builds the correction to store.
 *
 * `existing` is the correction already saved for this photo, and `shown` is
 * what the editor displayed when it opened. A field becomes an override when
 * the person changed it; a field they left alone keeps whatever override it
 * already had. Without that second half, correcting the same photo twice would
 * quietly drop the first correction.
 */
export function buildEdit({ driveId, name = null, existing = null, shown = {}, values = {}, by = null }) {
  const edit = {};

  for (const field of EDITABLE) {
    if (existing && Object.hasOwn(existing, field)) edit[field] = existing[field];
    if (!Object.hasOwn(values, field)) continue;
    if (!sameValue(values[field], shown[field])) edit[field] = values[field];
  }

  if (!Object.keys(edit).length) return null;

  return {
    ...edit,
    driveId,
    name,
    editedAt: new Date().toISOString(),
    editedBy: by,
  };
}

/** True when a stored correction no longer overrides anything and can be deleted. */
export function isEmptyEdit(edit) {
  return !edit || !EDITABLE.some((field) => Object.hasOwn(edit, field));
}

/** Which fields a stored correction overrides, for the "corrected by hand" note. */
export function editedFields(edit) {
  return EDITABLE.filter((field) => Object.hasOwn(edit ?? {}, field));
}

function sameValue(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    const left = [...(a ?? [])].sort();
    const right = [...(b ?? [])].sort();
    return left.length === right.length && left.every((value, i) => value === right[i]);
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    return a.id === b.id && a.name === b.name && (a.category ?? null) === (b.category ?? null);
  }
  return (a ?? null) === (b ?? null);
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

/**
 * Tidies a typed-in name and refuses the ones that are not names.
 *
 * Matching against the people already known is case-insensitive and returns the
 * *known* spelling, so typing "jocelyn" does not create a second person next to
 * "Jocelyn" in every filter menu for the rest of time.
 */
export function normalisePersonName(input, known = []) {
  const name = String(input ?? '').trim().replace(/\s+/g, ' ');
  if (!name || name.length > 60) return null;

  const match = known.find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return match ?? name;
}

/** Adds a person, keeping the list sorted and free of duplicates. */
export function addPerson(people, name) {
  const list = people ?? [];
  if (!name || list.some((p) => p.toLowerCase() === name.toLowerCase())) return list;
  return [...list, name].sort((a, b) => a.localeCompare(b));
}

export function removePerson(people, name) {
  return (people ?? []).filter((p) => p.toLowerCase() !== String(name).toLowerCase());
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');

/**
 * "YYYY-MM-DD" for a date input, in *local* time.
 *
 * Deliberately not `toISOString().slice(0, 10)`: that converts to UTC first, so
 * a photo taken at eight in the evening shows the next day's date to anyone
 * east of Greenwich and the previous day's to anyone west of it. Editing the
 * date would then silently move the photo by a day.
 */
export function toDateInput(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function toTimeInput(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Reads the date and time fields back into an ISO string.
 *
 * With no time given the photo is placed at midday rather than midnight, so a
 * daylight-saving shift or a timezone change cannot roll it into the day
 * before - which for a feature built on "on this day" would be the whole bug.
 */
export function fromDateInput(dateValue, timeValue = '') {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateValue ?? '').trim());
  if (!dm) return null;

  const [, y, mo, d] = dm.map(Number);
  const tm = /^(\d{2}):(\d{2})$/.exec(String(timeValue ?? '').trim());
  const hours = tm ? Number(tm[1]) : 12;
  const minutes = tm ? Number(tm[2]) : 0;

  const date = new Date(y, mo - 1, d, hours, minutes, 0);
  if (Number.isNaN(date.getTime()) || date.getFullYear() !== y || date.getMonth() !== mo - 1) return null;
  return date.toISOString();
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export function slugifyEvent(category, name) {
  return [category, name].filter(Boolean).join('-')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Builds an event from what was typed. "Trips / Vegas" and "Vegas" are both
 * accepted, because asking a family to think about categories before they can
 * label a holiday is a good way to have nothing labelled.
 */
export function parseEventInput(input) {
  const text = String(input ?? '').trim().replace(/\s+/g, ' ');
  if (!text) return null;

  const parts = text.split('/').map((p) => p.trim()).filter(Boolean);
  const name = parts.length > 1 ? parts.slice(1).join(' ') : parts[0];
  const category = parts.length > 1 ? parts[0] : null;
  if (!name) return null;

  const id = slugifyEvent(category, name);
  return id ? { id, category, name } : null;
}
