/**
 * Filtering the photo grid.
 *
 * Everything here runs in the browser over the listing already in memory, which
 * is a deliberate choice and worth writing down. Firestore can only answer one
 * `array-contains` per query, only range over one field, and needs a composite
 * index for every combination you want to ask for. "Photos of Jocelyn and Mindy
 * from 2010 at the beach" is not one query, it is a table of indexes nobody is
 * going to maintain.
 *
 * Filtering in memory instead means any combination of anything works, for free
 * and instantly. What it costs is that the whole list has to fit in memory -
 * fine for a family library of a few thousand tagged photos, not fine for the
 * two hundred thousand files sitting on the back-up drive. That is the reason
 * the archive gets curated before it is uploaded, rather than the reason to
 * build a query planner.
 *
 * Pure functions only, so the filter logic is testable without a browser.
 */

import { KIND } from './files.js';

export const PEOPLE_MODE = { ALL: 'all', ANY: 'any' };

export function emptyFilters() {
  return {
    people: [],
    peopleMode: PEOPLE_MODE.ALL,
    year: null,
    month: null,
    event: null,
    kind: null,
    folder: null,
    untaggedOnly: false,
    text: '',
  };
}

export function hasActiveFilters(filters = {}) {
  return Boolean(
    filters.people?.length ||
    filters.year ||
    filters.month ||
    filters.event ||
    filters.kind ||
    filters.folder ||
    filters.untaggedOnly ||
    filters.text?.trim(),
  );
}

/** Adds or removes a value from a list, returning a new list. */
export function toggleValue(list, value) {
  const set = new Set(list ?? []);
  if (set.has(value)) set.delete(value);
  else set.add(value);
  return [...set];
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function monthName(month) {
  return MONTHS[Number(month) - 1] ?? '';
}

/** Year and month for a record, from whatever date we managed to establish. */
export function dateParts(record) {
  if (!record?.takenAt) return { year: null, month: null };
  const date = new Date(record.takenAt);
  if (Number.isNaN(date.getTime())) return { year: null, month: null };
  return { year: date.getFullYear(), month: date.getMonth() + 1 };
}

// ---------------------------------------------------------------------------
// Facets
// ---------------------------------------------------------------------------

/**
 * What is actually available to filter by, with counts.
 *
 * Built from the records themselves rather than from a fixed list, so the menus
 * only ever offer choices that will return something. An empty menu is a
 * clearer signal that tags have not been imported yet than a full one that
 * returns nothing.
 */
export function buildFacets(records = []) {
  const people = new Map();
  const years = new Map();
  const months = new Map();
  const events = new Map();
  const folders = new Map();
  const kinds = new Map();
  let tagged = 0;

  for (const record of records) {
    if (record.people?.length) tagged += 1;

    for (const person of record.people ?? []) {
      const key = person.toLowerCase();
      const seen = people.get(key) ?? { value: person, label: person, count: 0 };
      seen.count += 1;
      people.set(key, seen);
    }

    const { year, month } = dateParts(record);
    if (year) years.set(year, (years.get(year) ?? 0) + 1);
    if (month) months.set(month, (months.get(month) ?? 0) + 1);

    if (record.event?.id) {
      const seen = events.get(record.event.id) ?? {
        value: record.event.id,
        label: record.event.name ?? record.event.id,
        category: record.event.category ?? null,
        count: 0,
      };
      seen.count += 1;
      events.set(record.event.id, seen);
    }

    if (record.folder) folders.set(record.folder, (folders.get(record.folder) ?? 0) + 1);
    if (record.kind) kinds.set(record.kind, (kinds.get(record.kind) ?? 0) + 1);
  }

  const byCount = (a, b) => b.count - a.count || String(a.label).localeCompare(String(b.label));

  return {
    total: records.length,
    tagged,
    untagged: records.length - tagged,
    people: [...people.values()].sort(byCount),
    years: [...years.entries()]
      .map(([year, count]) => ({ value: year, label: String(year), count }))
      .sort((a, b) => b.value - a.value),
    months: [...months.entries()]
      .map(([month, count]) => ({ value: month, label: monthName(month), count }))
      .sort((a, b) => a.value - b.value),
    events: [...events.values()].sort(byCount),
    folders: [...folders.entries()]
      .map(([folder, count]) => ({ value: folder, label: folder, count }))
      .sort(byCount),
    kinds: [...kinds.entries()]
      .map(([kind, count]) => ({ value: kind, label: kind === KIND.VIDEO ? 'Videos' : 'Photos', count }))
      .sort(byCount),
  };
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/**
 * Matches a record against the free-text box.
 *
 * Searches the filename, the people in it, the event and the folder, because a
 * person typing "vegas" has no idea which of those it happens to live in.
 */
function matchesText(record, needle) {
  const haystack = [
    record.name,
    record.folder,
    record.owner,
    record.event?.name,
    record.event?.category,
    ...(record.people ?? []),
  ].filter(Boolean).join(' ').toLowerCase();

  return needle.split(/\s+/).filter(Boolean).every((word) => haystack.includes(word));
}

/**
 * Applies every filter. Dimensions are combined with AND - each one you add
 * narrows the result, which is how a person expects a filter bar to behave.
 *
 * People are the exception worth thinking about, so both readings are offered:
 * picking Jocelyn and Mindy usually means "photos of the two of them together"
 * (ALL), but sometimes means "photos of either of them" (ANY).
 */
export function filterPhotos(records = [], filters = emptyFilters()) {
  const wanted = (filters.people ?? []).map((p) => p.toLowerCase());
  const needle = (filters.text ?? '').trim().toLowerCase();

  return records.filter((record) => {
    if (filters.kind && record.kind !== filters.kind) return false;
    if (filters.folder && record.folder !== filters.folder) return false;

    if (filters.untaggedOnly && record.people?.length) return false;

    if (wanted.length) {
      const present = new Set((record.people ?? []).map((p) => p.toLowerCase()));
      const matches = filters.peopleMode === PEOPLE_MODE.ANY
        ? wanted.some((p) => present.has(p))
        : wanted.every((p) => present.has(p));
      if (!matches) return false;
    }

    if (filters.event && record.event?.id !== filters.event) return false;

    if (filters.year || filters.month) {
      const { year, month } = dateParts(record);
      if (filters.year && year !== Number(filters.year)) return false;
      if (filters.month && month !== Number(filters.month)) return false;
    }

    if (needle && !matchesText(record, needle)) return false;

    return true;
  });
}

/**
 * The active filters, as chips. Each one names the field it came from so the
 * view can offer to remove exactly that filter without knowing the shape of the
 * filter object.
 */
export function describeFilters(filters = {}, facets = null) {
  const chips = [];

  for (const person of filters.people ?? []) {
    chips.push({ field: 'people', value: person, label: person });
  }
  if (filters.people?.length > 1) {
    chips.push({
      field: 'peopleMode',
      value: filters.peopleMode,
      label: filters.peopleMode === PEOPLE_MODE.ANY ? 'any of them' : 'together',
      toggle: true,
    });
  }
  if (filters.year) chips.push({ field: 'year', value: filters.year, label: String(filters.year) });
  if (filters.month) chips.push({ field: 'month', value: filters.month, label: monthName(filters.month) });
  if (filters.event) {
    const known = facets?.events?.find((e) => e.value === filters.event);
    chips.push({ field: 'event', value: filters.event, label: known?.label ?? filters.event });
  }
  if (filters.kind) {
    chips.push({ field: 'kind', value: filters.kind, label: filters.kind === KIND.VIDEO ? 'Videos' : 'Photos' });
  }
  if (filters.folder) chips.push({ field: 'folder', value: filters.folder, label: filters.folder });
  if (filters.untaggedOnly) chips.push({ field: 'untaggedOnly', value: true, label: 'Not tagged yet' });
  if (filters.text?.trim()) chips.push({ field: 'text', value: filters.text, label: `“${filters.text.trim()}”` });

  return chips;
}

/** Removes one chip's worth of filtering, returning a new filter object. */
export function clearFilter(filters, field, value) {
  const next = { ...filters, people: [...(filters.people ?? [])] };
  switch (field) {
    case 'people': next.people = next.people.filter((p) => p !== value); break;
    case 'peopleMode':
      next.peopleMode = filters.peopleMode === PEOPLE_MODE.ANY ? PEOPLE_MODE.ALL : PEOPLE_MODE.ANY;
      break;
    case 'text': next.text = ''; break;
    case 'untaggedOnly': next.untaggedOnly = false; break;
    default: next[field] = null;
  }
  return next;
}

/** "3 of 2,907 photos" - the line under the heading. */
export function describeCount(shown, total) {
  const fmt = (n) => n.toLocaleString();
  if (shown === total) return `${fmt(total)} ${total === 1 ? 'item' : 'items'}`;
  return `${fmt(shown)} of ${fmt(total)}`;
}
