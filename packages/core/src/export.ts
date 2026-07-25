/**
 * Plain-format export worker (spec §4, §11).
 *
 * Turns an `export_jobs` row into a directory a human can read without this
 * product existing:
 *
 *   README.txt                    what this archive is, in plain English
 *   manifest.json                 inventory, row counts, checksums
 *   data/<table>.json             structured data, faithful types
 *   data/<table>.csv              the same rows, flat, for spreadsheets
 *   files/<module>/<yyyy>/<mm>/   original files under their original names
 *
 * Spec §11 calls the export "both a feature and the safety/inheritance
 * guarantee". That is why both JSON and CSV are written: JSON round-trips
 * exactly, CSV opens in the spreadsheet program a non-technical relative
 * already has.
 *
 * AUTHORISATION
 * -------------
 * The worker does NOT run with god rights. It re-enters the database as the
 * member who requested the export, by setting the same JWT claim PostgREST
 * would set, then switching to the `authenticated` role. Every RLS policy and
 * every admin check therefore applies exactly as it would to that person, and a
 * revoked admin cannot have a queued job complete on their behalf.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Minimal shape of a `pg` client, so tests can pass a stub. */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

/** Reads file bytes out of object storage. Supplied by the caller. */
export interface StorageReader {
  download(bucket: string, key: string): Promise<Uint8Array>;
}

export interface ExportJob {
  id: string;
  family_id: string;
  requested_by: string;
  include_files: boolean;
}

export interface ExportResult {
  outDir: string;
  tables: Record<string, number>;
  filesWritten: number;
  filesFailed: Array<{ key: string; error: string }>;
  manifestPath: string;
}

/**
 * Serialises rows to CSV.
 *
 * The union of every row's keys is used as the header, not just the first
 * row's: JSONB columns and nullable fields mean row shapes vary, and taking
 * the first row alone would silently drop columns from the export.
 */
export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';

  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }

  const cell = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const text =
      typeof value === 'object' ? JSON.stringify(value) : String(value);
    // Quote when the value could otherwise break the row apart. Embedded
    // quotes are doubled, per RFC 4180.
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };

  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => cell(row[c])).join(','));
  }
  // Trailing newline so the file ends cleanly in every editor.
  return lines.join('\n') + '\n';
}

/**
 * Runs `fn` with the connection acting as `userId`.
 *
 * Wrapped in a transaction because `SET LOCAL` is transaction-scoped: that is
 * what guarantees the impersonation cannot leak into later use of a pooled
 * connection. The role and claim are reset by COMMIT/ROLLBACK either way.
 */
async function asUser<T>(
  client: Queryable,
  userId: string,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query('begin');
  try {
    await client.query('select set_config($1, $2, true)', [
      'request.jwt.claim.sub',
      userId,
    ]);
    await client.query('set local role authenticated');
    const result = await fn();
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

/** Guards against a manifest path escaping the output directory. */
function safeJoin(outDir: string, relative: string): string {
  const target = join(outDir, relative);
  if (target !== outDir && !target.startsWith(outDir + '/')) {
    throw new Error(`archive path escapes the output directory: ${relative}`);
  }
  return target;
}

/**
 * Builds the archive directory for one export job.
 *
 * Returns a summary rather than throwing on individual file failures: one
 * unreadable object must not cost the family the other 40,000. Failures are
 * recorded in the manifest so the gap is visible rather than silent.
 */
export async function exportFamily(options: {
  client: Queryable;
  job: ExportJob;
  outDir: string;
  storage?: StorageReader;
}): Promise<ExportResult> {
  const { client, job, outDir, storage } = options;

  const { snapshot, manifest } = await asUser(client, job.requested_by, async () => {
    const snap = await client.query(
      'select app.export_family_snapshot($1) as snapshot',
      [job.family_id],
    );
    const files = await client.query(
      'select * from app.export_file_manifest($1)',
      [job.family_id],
    );
    return { snapshot: snap.rows[0].snapshot, manifest: files.rows };
  });

  await mkdir(join(outDir, 'data'), { recursive: true });

  // --- structured data ------------------------------------------------------
  const tables: Record<string, number> = {};
  for (const [table, rows] of Object.entries(snapshot.data as Record<string, any[]>)) {
    const list = Array.isArray(rows) ? rows : [];
    tables[table] = list.length;
    await writeFile(
      join(outDir, 'data', `${table}.json`),
      JSON.stringify(list, null, 2) + '\n',
      'utf8',
    );
    if (list.length > 0) {
      await writeFile(join(outDir, 'data', `${table}.csv`), toCsv(list), 'utf8');
    }
  }

  // --- files ----------------------------------------------------------------
  const filesFailed: Array<{ key: string; error: string }> = [];
  let filesWritten = 0;

  if (job.include_files && storage) {
    for (const entry of manifest) {
      try {
        const bytes = await storage.download(entry.bucket, entry.storage_key);
        const target = safeJoin(outDir, entry.archive_path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes);
        filesWritten += 1;
      } catch (error) {
        filesFailed.push({
          key: entry.storage_key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // --- manifest -------------------------------------------------------------
  const manifestBody = {
    schema_version: snapshot.schema_version,
    family_id: job.family_id,
    export_job_id: job.id,
    generated_at: snapshot.generated_at,
    row_counts: tables,
    files: {
      expected: job.include_files ? manifest.length : 0,
      written: filesWritten,
      failed: filesFailed,
      entries: manifest.map((entry: any) => ({
        path: entry.archive_path,
        bytes: Number(entry.size_bytes),
        sha256: entry.checksum_sha256,
        mime: entry.mime,
      })),
    },
  };

  const manifestPath = join(outDir, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifestBody, null, 2) + '\n', 'utf8');
  await writeFile(join(outDir, 'README.txt'), readmeText(job.family_id), 'utf8');

  return { outDir, tables, filesWritten, filesFailed, manifestPath };
}

/**
 * The archive is meant to be openable by a relative with no technical help and
 * no knowledge of this product, possibly years from now. That is the whole
 * point of the inheritance use case, so the archive explains itself.
 */
function readmeText(familyId: string): string {
  return `Family Dashboard export
=======================

This folder contains a complete copy of your family's data. It does not need
any special software to read, and it does not depend on Family Dashboard still
existing.

What is in here
---------------

  data/      Your records, one file per kind of information.
             The .csv files open directly in Excel, Numbers or Google Sheets.
             The .json files contain exactly the same information in a form
             software can read back without losing anything.

  files/     Your photos, documents and other files, organised by what they
             belonged to and when they were added. These are ordinary files:
             photos open as photos, documents open as documents.

  manifest.json
             A list of everything in this archive, including the size and
             checksum of each file, so you can verify nothing was lost or
             altered.

If some files could not be copied, they are listed under "failed" in
manifest.json. Everything else in the archive is still complete.

Family id: ${familyId}
`;
}
