/**
 * The photo catalog: who is in a photo, when it was taken, and what it was.
 *
 * Drive knows a photo's filename, size and camera date. It does not know that
 * the three people in it are Jocelyn, Mindy and Toni, and that is exactly what
 * you want to filter by. That knowledge comes from a face-recognition pass run
 * once, offline, over the whole archive - a job that needs a real machine and
 * has no business happening on a phone.
 *
 * So this file is the import side: it reads the CSVs that pass produced and
 * turns them into catalog entries the app can join onto Drive files by
 * filename. Everything here is pure - no network, no DOM - because the parsing
 * is where the sharp edges are and they are worth testing directly.
 *
 * The CSVs, as produced by the face tools:
 *
 *   image_person_tags.csv   source_path, people ("A; B; C"), tag_count
 *   people_index_v2.csv     person, organized_path, source_path, date_used, bucket
 *   clusters_to_name.csv    cluster, face_count, suggested_person_name, contact_sheet
 *
 * Two things about that data drive the design here:
 *
 *  1. Paths contain commas - "F:\Pictures,movies,etc\..." - so the CSV parser
 *     has to be a real one. Splitting on commas destroys every single row.
 *
 *  2. One person spans many clusters. Jocelyn alone is about thirty of them,
 *     because clustering separates by age, lighting and angle. So a cluster is
 *     never treated as an identity: people are merged by name, which is what
 *     both of the per-image CSVs already key on.
 */

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * Splits CSV text into rows of fields.
 *
 * A hand-rolled state machine rather than a split, because the source paths are
 * full of commas and quotes are what protects them. Handles quoted fields,
 * doubled quotes as an escape, CRLF, and a missing trailing newline.
 */
export function parseCsvRows(text) {
  const input = String(text ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let started = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];

    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') { quoted = true; started = true; continue; }
    if (ch === ',') { row.push(field); field = ''; started = true; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = []; field = ''; started = false;
      continue;
    }
    field += ch;
    started = true;
  }

  if (started || field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Parses CSV text into objects keyed by the header row. */
export function parseCsv(text) {
  const rows = parseCsvRows(text);
  if (!rows.length) return [];

  const header = rows[0].map((h) => h.trim());
  const out = [];

  for (const row of rows.slice(1)) {
    // Skip the blank line a lot of exporters leave at the end.
    if (row.length === 1 && row[0].trim() === '') continue;
    const record = {};
    header.forEach((name, i) => { record[name] = (row[i] ?? '').trim(); });
    out.push(record);
  }
  return out;
}

/** True when the header row contains every named column. */
export function hasColumns(rows, ...names) {
  if (!rows?.length) return false;
  const keys = new Set(Object.keys(rows[0]));
  return names.every((name) => keys.has(name));
}

/**
 * Works out which of the face-tool files this is, from its columns.
 *
 * By columns rather than by filename, because the one thing guaranteed about a
 * file called "people_index_v2 (1).csv" is that it is still the people index.
 */
export function detectCsvRole(text) {
  const rows = parseCsv(text);
  if (!rows.length) return null;
  if (hasColumns(rows, 'source_path', 'people')) return 'personTags';
  if (hasColumns(rows, 'person', 'organized_path')) return 'peopleIndex';
  if (hasColumns(rows, 'cluster', 'suggested_person_name')) return 'clusterNames';
  return null;
}

// ---------------------------------------------------------------------------
// Paths and keys
// ---------------------------------------------------------------------------

/** The filename from a Windows or POSIX path. */
export function basenameOf(path) {
  const text = String(path ?? '').trim();
  if (!text) return '';
  const cut = Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/'));
  return cut === -1 ? text : text.slice(cut + 1);
}

/**
 * The key a catalog entry is stored and looked up under.
 *
 * A filename, lowercased and reduced to characters that are safe as a Firestore
 * map key. Case is dropped because Drive, Windows and the CSVs disagree about
 * it constantly - "DSC_0063.JPG" and "dsc_0063.jpg" are the same photo.
 */
export function catalogKey(nameOrPath) {
  const base = basenameOf(nameOrPath).toLowerCase();
  if (!base) return '';
  const safe = base.replace(/[^a-z0-9._-]+/g, '_');
  // Firestore reserves field names starting with a double underscore.
  return safe.startsWith('__') ? `f${safe}` : safe;
}

/**
 * Parses "YYYY-MM-DD HH:MM:SS" (people_index_v2) and "YYYY:MM:DD HH:MM:SS"
 * (EXIF). Read as local time with no timezone applied, deliberately: a photo
 * belongs to the day it looked like where it was taken.
 */
export function parseTimestamp(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})[-:](\d{2})[-:](\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h = 0, mi = 0, s = 0] = m.map((v) => (v == null ? undefined : Number(v)));
  const date = new Date(y, mo - 1, d, h || 0, mi || 0, s || 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Splits "A; B; C" into names, dropping blanks. */
export function splitPeople(value) {
  return String(value ?? '')
    .split(/[;|]/)
    .map((name) => name.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export function slugify(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Reads an event out of the organiser's bucket path.
 *
 * The offline organiser files every photo under one of two roots:
 *
 *   01_Timeline/2015/2015-09        - just a date, no event
 *   02_Events/Trips/2014 Cruise     - a named occasion
 *
 * Only the second is an event. The first is already covered by the year and
 * month filters, and turning "2015-09" into an event called "2015-09" would
 * fill the event menu with two hundred meaningless entries.
 */
export function parseEventBucket(bucket) {
  const parts = String(bucket ?? '').split(/[\\/]/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  // "02_Events" as the organiser writes it, or a plain "Events". Nothing else -
  // "01_Timeline" must not become an event.
  if (!/^(\d+_)?events$/i.test(parts[0])) return null;

  const category = parts.length >= 3 ? parts[1] : null;
  const name = parts[parts.length >= 3 ? 2 : 1];
  if (!name) return null;

  return {
    id: slugify([category, name].filter(Boolean).join('-')),
    category: category || null,
    name,
  };
}

// ---------------------------------------------------------------------------
// Building the catalog
// ---------------------------------------------------------------------------

/**
 * Merges the CSVs into one entry per photo.
 *
 * `people_index_v2.csv` carries one row per person per photo and is the only
 * file with a date and a bucket. `image_person_tags.csv` carries one row per
 * photo with everyone in it. They very nearly agree; the union is taken so a
 * photo tagged in either file is catalogued, and a person named in either is
 * kept.
 *
 * Entries are keyed on the *organised* filename where there is one. That name
 * carries a content hash, so it is unique across the whole archive - unlike
 * "DSC_0063.JPG", which a camera reuses every ten thousand shots.
 *
 * @param {{personTags?: string, peopleIndex?: string, clusterNames?: string}} sources raw CSV text
 */
export function buildCatalog({ personTags = '', peopleIndex = '', clusterNames = '' } = {}) {
  const warnings = [];
  const bySource = new Map();

  const entryFor = (sourcePath) => {
    const source = String(sourcePath ?? '').trim();
    const id = source.toLowerCase();
    if (!bySource.has(id)) {
      bySource.set(id, {
        sourcePath: source,
        sourceName: basenameOf(source),
        organizedName: null,
        people: new Map(),   // lowercased name -> display name
        takenAt: null,
        event: null,
      });
    }
    return bySource.get(id);
  };

  // --- people_index_v2.csv: dates, buckets, organised names ------------------
  const indexRows = peopleIndex ? parseCsv(peopleIndex) : [];
  if (indexRows.length && !hasColumns(indexRows, 'person', 'source_path')) {
    warnings.push('people_index_v2.csv does not have the expected columns; it was ignored.');
  } else {
    for (const row of indexRows) {
      if (!row.source_path) continue;
      const entry = entryFor(row.source_path);

      const person = row.person?.trim();
      if (person) entry.people.set(person.toLowerCase(), person);

      const organized = basenameOf(row.organized_path);
      if (organized && !entry.organizedName) entry.organizedName = organized;

      const when = parseTimestamp(row.date_used);
      // Earliest wins: rows for the same photo can disagree by a second or two.
      if (when && (!entry.takenAt || when < entry.takenAt)) entry.takenAt = when;

      const event = parseEventBucket(row.bucket);
      if (event && !entry.event) entry.event = event;
    }
  }

  // --- image_person_tags.csv: the authoritative per-photo people list --------
  const tagRows = personTags ? parseCsv(personTags) : [];
  if (tagRows.length && !hasColumns(tagRows, 'source_path', 'people')) {
    warnings.push('image_person_tags.csv does not have the expected columns; it was ignored.');
  } else {
    for (const row of tagRows) {
      if (!row.source_path) continue;
      const entry = entryFor(row.source_path);
      for (const person of splitPeople(row.people)) {
        entry.people.set(person.toLowerCase(), person);
      }
    }
  }

  // --- clusters_to_name.csv: reporting only ---------------------------------
  // A cluster is not an identity - Jocelyn is about thirty of them - so this is
  // never used to tag a photo. It is read purely to tell the family how much of
  // the run is still unnamed, which is the number that decides whether another
  // naming pass is worth doing.
  let clusters = null;
  if (clusterNames) {
    const rows = parseCsv(clusterNames);
    if (hasColumns(rows, 'cluster', 'suggested_person_name')) {
      const named = rows.filter((r) => r.suggested_person_name?.trim());
      const faces = (list) => list.reduce((sum, r) => sum + (Number(r.face_count) || 0), 0);
      clusters = {
        total: rows.length,
        named: named.length,
        unnamed: rows.length - named.length,
        facesNamed: faces(named),
        facesTotal: faces(rows),
        people: [...new Set(named.map((r) => r.suggested_person_name.trim()))].sort(),
      };
    } else {
      warnings.push('clusters_to_name.csv does not have the expected columns; it was ignored.');
    }
  }

  // --- flatten ---------------------------------------------------------------
  const entries = [];
  for (const entry of bySource.values()) {
    const name = entry.organizedName || entry.sourceName;
    if (!name) continue;

    entries.push({
      key: catalogKey(name),
      name,
      sourceName: entry.sourceName,
      sourcePath: entry.sourcePath,
      people: [...entry.people.values()].sort((a, b) => a.localeCompare(b)),
      takenAt: entry.takenAt ? entry.takenAt.toISOString() : null,
      event: entry.event,
    });
  }
  entries.sort((a, b) => (b.takenAt ?? '').localeCompare(a.takenAt ?? '') || a.name.localeCompare(b.name));

  const undated = entries.filter((e) => !e.takenAt).length;
  if (undated) {
    warnings.push(`${undated} ${undated === 1 ? 'photo has' : 'photos have'} no date in the CSVs; they will use the date Drive reports.`);
  }

  return { entries, ...summariseEntries(entries), clusters, warnings };
}

/** Counts for the import preview and for the filter menus. */
export function summariseEntries(entries) {
  const people = new Map();
  const events = new Map();
  const years = new Map();

  for (const entry of entries ?? []) {
    for (const person of entry.people ?? []) {
      const key = person.toLowerCase();
      const seen = people.get(key) ?? { name: person, count: 0 };
      seen.count += 1;
      people.set(key, seen);
    }
    if (entry.event?.id) {
      const seen = events.get(entry.event.id) ?? { ...entry.event, count: 0 };
      seen.count += 1;
      events.set(entry.event.id, seen);
    }
    const year = entry.takenAt ? Number(entry.takenAt.slice(0, 4)) : null;
    if (year) years.set(year, (years.get(year) ?? 0) + 1);
  }

  return {
    count: (entries ?? []).length,
    people: [...people.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    events: [...events.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    years: [...years.entries()].map(([year, count]) => ({ year, count })).sort((a, b) => b.year - a.year),
  };
}

// ---------------------------------------------------------------------------
// Joining onto Drive files
// ---------------------------------------------------------------------------

/**
 * Builds the lookup used to match a Drive file to a catalog entry.
 *
 * Two names are indexed per entry: the organised filename (unique, because it
 * carries a hash) and the original camera filename (not unique - every camera
 * on earth produces a DSC_0063.JPG eventually). The second index only keeps
 * names that resolve to exactly one photo; anything ambiguous is dropped rather
 * than guessed, because tagging the wrong person into a photo is worse than
 * leaving it untagged.
 *
 * This means the family can upload either the organised folder or the original
 * one and the tags still land.
 */
export function buildLookup(entries) {
  const byName = new Map();
  const bySourceName = new Map();
  const ambiguous = new Set();

  for (const entry of entries ?? []) {
    if (entry.key) byName.set(entry.key, entry);

    const sourceKey = catalogKey(entry.sourceName ?? '');
    if (!sourceKey || sourceKey === entry.key) continue;

    if (bySourceName.has(sourceKey) && bySourceName.get(sourceKey) !== entry) {
      ambiguous.add(sourceKey);
    } else {
      bySourceName.set(sourceKey, entry);
    }
  }
  for (const key of ambiguous) bySourceName.delete(key);

  return { byName, bySourceName, ambiguous };
}

/** Finds the catalog entry for a Drive filename, or null. */
export function matchEntry(lookup, driveName) {
  const key = catalogKey(driveName);
  if (!key || !lookup) return null;
  return lookup.byName.get(key) ?? lookup.bySourceName.get(key) ?? null;
}

/**
 * Merges catalog knowledge into the Drive pointer records.
 *
 * Non-destructive: a date recorded by the camera always wins, and the catalog
 * only fills in a date where Drive had none. The tags are what we are really
 * after.
 */
export function applyCatalog(records, lookup) {
  if (!lookup) return records ?? [];

  return (records ?? []).map((record) => {
    const entry = matchEntry(lookup, record.name);
    if (!entry) return record;

    return {
      ...record,
      people: entry.people ?? [],
      event: entry.event ?? null,
      takenAt: record.takenAt ?? entry.takenAt ?? null,
      dayKey: record.dayKey ?? dayKeyFromIso(entry.takenAt),
    };
  });
}

/** "MM-DD" from an ISO string, for the memory feed. Null when there is no date. */
export function dayKeyFromIso(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// ---------------------------------------------------------------------------
// Storage shape
// ---------------------------------------------------------------------------

/**
 * How many entries go in one Firestore document.
 *
 * The catalog is stored in chunks rather than a document per photo. Three
 * thousand documents would be three thousand reads every time someone opens
 * Photos - enough to matter on the free tier and very noticeable on a phone.
 * Ten chunks is ten reads. Each entry is roughly 150 bytes, so 300 of them sits
 * comfortably inside Firestore's one-megabyte document limit.
 */
export const CHUNK_SIZE = 300;

/** Compacts an entry for storage. Short keys, because they repeat 3,000 times. */
export function packEntry(entry) {
  const packed = { n: entry.name };
  if (entry.people?.length) packed.p = entry.people;
  if (entry.takenAt) packed.t = entry.takenAt;
  if (entry.sourceName && entry.sourceName !== entry.name) packed.s = entry.sourceName;
  if (entry.event?.id) {
    packed.e = entry.event.id;
    packed.en = entry.event.name;
    if (entry.event.category) packed.ec = entry.event.category;
  }
  return packed;
}

export function unpackEntry(key, packed) {
  return {
    key,
    name: packed?.n ?? key,
    sourceName: packed?.s ?? packed?.n ?? key,
    people: packed?.p ?? [],
    takenAt: packed?.t ?? null,
    event: packed?.e ? { id: packed.e, name: packed.en ?? packed.e, category: packed.ec ?? null } : null,
  };
}

/** Splits a catalog into the documents that get written to Firestore. */
export function toChunks(entries, size = CHUNK_SIZE) {
  const chunks = [];
  for (let i = 0; i < (entries ?? []).length; i += size) {
    const slice = entries.slice(i, i + size);
    const packed = {};
    for (const entry of slice) {
      if (entry.key) packed[entry.key] = packEntry(entry);
    }
    chunks.push({ id: `chunk_${String(chunks.length).padStart(3, '0')}`, entries: packed });
  }
  return chunks;
}

/** Rebuilds the entry list from stored chunks. */
export function fromChunks(chunks) {
  const entries = [];
  for (const chunk of chunks ?? []) {
    for (const [key, packed] of Object.entries(chunk?.entries ?? {})) {
      entries.push(unpackEntry(key, packed));
    }
  }
  return entries;
}
