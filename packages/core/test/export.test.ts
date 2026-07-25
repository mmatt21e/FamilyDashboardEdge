/**
 * Export worker tests.
 *
 * These run against the real local database created by scripts/db-reset.sh and
 * seeded by the RLS fixtures, so the authorisation path is exercised for real
 * rather than against a mock that always says yes.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

import { exportFamily, toCsv, type StorageReader } from '../src/export.ts';

const SMITH = 'f0000000-0000-4000-8000-00000000000f';
const ALICE = 'a0000000-0000-4000-8000-000000000001';  // owner
const CAROL = 'a0000000-0000-4000-8000-000000000003';  // child
const GRACE = 'a0000000-0000-4000-8000-000000000007';  // no family

let client: pg.Client;
let outDir: string;

before(async () => {
  client = new pg.Client({
    host: process.env.PGHOST ?? 'localhost',
    port: Number(process.env.PGPORT ?? 55432),
    user: process.env.PGUSER ?? 'postgres',
    password: process.env.PGPASSWORD ?? 'postgres',
    database: process.env.PGDATABASE ?? 'family_dashboard',
  });
  await client.connect();
  outDir = await mkdtemp(join(tmpdir(), 'fd-export-'));
});

after(async () => {
  await client?.end();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

// A storage stub. Returns deterministic bytes and fails for one known key, so
// the partial-failure path is covered.
const storage: StorageReader = {
  async download(_bucket, key) {
    if (key.includes('will.pdf')) throw new Error('object not found');
    return new TextEncoder().encode(`contents of ${key}`);
  },
};

describe('toCsv', () => {
  test('uses the union of all row keys, not just the first row', () => {
    // A first-row-only header would silently drop `c` from the export.
    const csv = toCsv([{ a: 1 }, { a: 2, c: 3 }]);
    assert.equal(csv.split('\n')[0], 'a,c');
  });

  test('quotes values containing commas, quotes or newlines', () => {
    const csv = toCsv([{ note: 'Hello, "world"\nsecond line' }]);
    assert.ok(csv.includes('"Hello, ""world""\nsecond line"'));
  });

  test('serialises objects as JSON rather than [object Object]', () => {
    const csv = toCsv([{ meta: { a: 1 } }]);
    assert.ok(csv.includes('"{""a"":1}"'));
  });

  test('renders null and undefined as empty cells', () => {
    assert.equal(toCsv([{ a: null, b: undefined }]), 'a,b\n,\n');
  });

  test('returns an empty string for no rows', () => {
    assert.equal(toCsv([]), '');
  });
});

describe('exportFamily', () => {
  test('writes structured data, files, manifest and README', async () => {
    const dir = join(outDir, 'run1');
    const result = await exportFamily({
      client,
      job: { id: 'job-1', family_id: SMITH, requested_by: ALICE, include_files: true },
      outDir: dir,
      storage,
    });

    // --- structured data ---
    assert.ok(result.tables.family_members > 0, 'members exported');
    assert.ok(result.tables.files > 0, 'file pointers exported');
    assert.equal(result.tables.profiles, 5, 'member profiles exported');

    const members = JSON.parse(
      await readFile(join(dir, 'data', 'family_members.json'), 'utf8'),
    );
    assert.ok(Array.isArray(members));
    assert.ok(
      members.every((m: any) => m.family_id === SMITH),
      'export contains only this family',
    );

    // CSV is written alongside JSON so a non-technical relative can open it.
    // Column order comes from jsonb, which sorts keys by length then
    // alphabetically, so assert on the set of columns rather than their order.
    const csv = await readFile(join(dir, 'data', 'family_members.csv'), 'utf8');
    const header = csv.split('\n')[0].split(',');
    for (const column of ['id', 'family_id', 'user_id', 'role', 'status']) {
      assert.ok(header.includes(column), `csv header includes ${column}`);
    }
    assert.equal(csv.trimEnd().split('\n').length, members.length + 1,
      'one csv line per member, plus the header');

    // --- files ---
    // Four files in the fixture; the vault PDF is rigged to fail.
    assert.equal(result.filesWritten, 3);
    assert.equal(result.filesFailed.length, 1);
    assert.match(result.filesFailed[0].error, /object not found/);

    // --- manifest ---
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));

    // Dated, readable layout (spec §4: "photos as image files in dated folders").
    // The date comes from the photo's capture time, falling back to when it was
    // added - not from the opaque storage key - so take the path from the
    // manifest rather than reconstructing it here.
    const beach = manifest.files.entries.find((e: any) => e.path.endsWith('beach.jpg'));
    assert.ok(beach, 'the photo appears in the manifest');
    assert.match(beach.path, /^files\/message_board\/\d{4}\/\d{2}\/[0-9a-f]{8}-beach\.jpg$/);
    assert.ok((await stat(join(dir, beach.path))).size > 0,
      'photo written under its readable archive path');
    assert.equal(manifest.family_id, SMITH);
    assert.equal(manifest.schema_version, 1);
    assert.equal(manifest.files.expected, 4);
    assert.equal(manifest.files.written, 3);
    // A gap must be recorded, never silently dropped.
    assert.equal(manifest.files.failed.length, 1);

    const readme = await readFile(join(dir, 'README.txt'), 'utf8');
    assert.ok(readme.includes('does not depend on Family Dashboard still'));
  });

  test('omits files when the job asks for data only', async () => {
    const dir = join(outDir, 'run2');
    const result = await exportFamily({
      client,
      job: { id: 'job-2', family_id: SMITH, requested_by: ALICE, include_files: false },
      outDir: dir,
      storage,
    });

    assert.equal(result.filesWritten, 0);
    // The pointer records are still exported; only the bytes are skipped.
    assert.ok(result.tables.files > 0);
  });

  test('refuses to export on behalf of a non-admin member', async () => {
    // The worker holds a superuser connection, so this proves authorisation
    // comes from impersonating the requester rather than from the connection.
    await assert.rejects(
      exportFamily({
        client,
        job: { id: 'job-3', family_id: SMITH, requested_by: CAROL, include_files: false },
        outDir: join(outDir, 'run3'),
        storage,
      }),
      /only a family admin may export/,
    );
  });

  test('refuses to export on behalf of a non-member', async () => {
    await assert.rejects(
      exportFamily({
        client,
        job: { id: 'job-4', family_id: SMITH, requested_by: GRACE, include_files: false },
        outDir: join(outDir, 'run4'),
        storage,
      }),
      /only a family admin may export/,
    );
  });

  test('leaves the connection usable after a rejected export', async () => {
    // asUser() rolls back on failure; if it did not, the impersonated role
    // would leak into the next query on this pooled connection.
    const { rows } = await client.query('select current_user as who');
    assert.equal(rows[0].who, process.env.PGUSER ?? 'postgres');
  });
});
