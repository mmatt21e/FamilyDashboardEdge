# Architecture

Implements spec §2. Two cooperating storage systems, each doing what it is best
at, with a database-enforced tenant boundary between families.

## Storage split

**Structured data → Postgres (Supabase).** Messages, chore states, calendar
entries, lists, check-ins, module settings, membership. Relational, queryable,
real-time, and covered by row-level security.

**Files → object storage.** Photos, videos, PDFs, home-inventory images. The
database holds a *pointer record* (`public.files`) with the storage key and
metadata; the bytes never enter a relational table (spec §11).

The pointer table carries the metadata that drives features — `captured_at` for
"on this day", `checksum_sha256` for export verification, `module_key` for
visibility — so the common queries never touch object storage at all.

## Tenancy

Every family is an isolated tenant. Isolation is keyed on `family_id` and
enforced at the database layer; see [security-model.md](security-model.md).

A user may belong to **several** families. This is not an edge case — it is the
adult child who has their own household and also helps run their aging parents'
family, which spec §1 names as a core use case. It also makes tenant isolation
harder to get right, because membership checks answer "yes" on both sides and
only per-row `family_id` handling separates them. The test suite has a fixture
member in two families for exactly this reason.

## Schema namespaces

| Schema | Contents | Exposed to clients |
|--------|----------|--------------------|
| `public` | domain tables, RPCs | yes, via PostgREST |
| `app` | enums, access helpers, triggers | execute-only on specific functions |
| `auth`, `storage` | provided by Supabase | via its own APIs |
| `test` | assertion harness | local/CI only |

## Module registry

Every feature is optional per family (spec §4). Two tables:

- `module_catalog` — global product metadata: category, sensitivity tier,
  default role gates, build phase, `status` (`available`/`beta`/`planned`), and
  prerequisite modules. Seeded by migration, readable by anyone.
- `family_modules` — per-family state: enabled, config, optional gate overrides.

Module tables added later do not implement their own access rules. Their
policies call `app.can_view_module(family_id, key)` and
`app.can_edit_module(family_id, key)`, which resolve enablement, role gate and
sensitivity floor in one place. Toggling a module therefore changes
reachability, not just UI visibility.

Prerequisites are declared in the catalog (`meal_planning` requires
`grocery_list`) and enforced both ways by `public.set_module_enabled()`: a
module cannot be enabled while a prerequisite is off, and a prerequisite cannot
be disabled while something depends on it. Core (`system`) modules cannot be
disabled at all.

## Object key layout

```
families/<family_id>/<module_key>/<yyyy>/<mm>/<uuid>-<safe-filename>
```

Every segment earns its place:

- `families/<family_id>/` — the tenant boundary, enforced by a CHECK constraint
  on `public.files` and independently by storage RLS.
- `<module_key>/` — lets storage policies apply module gating without consulting
  the database, and gives the export its folder structure for free.
- `<yyyy>/<mm>/` — keeps prefixes small enough to list efficiently at the scale
  spec §7 anticipates (tens of thousands of photos), and makes the export come
  out as dated folders as spec §4 requires.
- `<uuid>-` — collision-free without consulting the database.

Keys are built by `app.build_storage_key()`, never hand-assembled. It strips
path components and reduces the filename to a conservative safe subset, so a
client-supplied name like `../../etc/passwd` cannot escape the prefix.

## Real-time

Supabase Realtime broadcasts changes on `public` tables. Because RLS applies to
the replication stream, a subscriber only receives changes for families they
belong to — the same invariant, no extra enforcement path.

## Export

`app.export_family_snapshot()` discovers tables by looking for a `family_id`
column rather than naming them, so a module built in Phase 3 appears in the
export the day its table is created. This is the only way the portability
guarantee survives a growing product.

The worker (`packages/core/src/export.ts`) re-enters the database **as the
member who requested the export**, by setting the same JWT claim PostgREST would
set and switching to the `authenticated` role. Authorisation therefore comes
from the requester, not from the worker's connection — a revoked admin cannot
have a queued job complete on their behalf. The impersonation is wrapped in a
transaction so it cannot leak into later use of a pooled connection.

## Deferred decisions

**Mobile framework.** Phase 0 is entirely client-agnostic. Spec §6 recommends
Flutter unless existing web/JS skill argues for React Native — a fact about the
team, not the code. See [phase-plan.md](phase-plan.md).

**Push delivery.** The preference tables and fan-out exist; the APNs/FCM workers
do not. `app.notify()` writes in-app rows and is the single place delivery
workers should read from, so adding them does not change the schema.

**Encryption for the restricted tier.** Envelope encryption for the password
directory and digital estate, keyed per family. The `sensitivity` column already
marks what needs it.
