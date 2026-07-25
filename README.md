# Family Dashboard

A modular family dashboard: private per-family coordination, connection,
aging-parent care, and a document/legacy vault, with the family owning its data.

This repository implements **Phase 0 — Core Foundation** from
[the build specification](docs/spec.md). Per spec §11 ("Do not scaffold modules
before the Core Foundation and tenant isolation exist"), no feature modules are
built yet. What exists is the substrate every module will hang off, with its
security invariant proven by tests rather than asserted in prose.

## Status

| Phase | Scope | State |
|-------|-------|-------|
| **0** | Auth/tenancy, roles, module registry, storage, notifications, audit, export | **Built and tested** |
| 1 | Message board + calendar + document vault | Not started — client framework [decided: React Native](docs/phase-plan.md#client-framework--decided-react-native) |
| 2 | Owned iOS/Android background photo sync | Not started (spec §7 — its own hard project) |
| 3 | Care, financial, history, connection modules | Catalogued, not built |
| 4 | Store submission, billing, compliance review | Not started |

All 46 modules from spec §3 are registered in the catalog with their category,
sensitivity tier and build phase, so the registry is complete even though the
features are not. `status` distinguishes `available` from `planned`.

## The invariant

> A request may only ever reach rows whose `family_id` names a family the caller
> is an active member of.

This is enforced in the database, not in a client or an API layer, so it holds
regardless of what talks to it. It is covered by **149 assertions** that run
against a real Postgres cluster — see [docs/security-model.md](docs/security-model.md).

Writing the tests was worth it: they caught three real defects during
development, including one where the access helpers returned `NULL` instead of
`false` for non-members. `NULL` is filtered as false inside an RLS policy, so
every policy looked correct — but `if not app.is_family_admin(...)` does not
fire on `NULL`, which left every `SECURITY DEFINER` RPC admitting non-members.
That class of bug is invisible to inspection and to any test that only checks
the happy path.

## Quick start

Requires Postgres 16+ and Node 22+. No Supabase account needed — the migrations
run on a vanilla cluster via a [local shim](supabase/local/00_local_shim.sql)
that reproduces the `auth`/`storage` contract Supabase provides in production.

```bash
# start a throwaway cluster on port 55432
initdb -D /tmp/fd-pg -U postgres --auth=trust
pg_ctl -D /tmp/fd-pg -o "-p 55432" -l /tmp/fd-pg/server.log start

npm install
npm test          # migrations + 149 RLS assertions + export worker tests
```

Individually:

```bash
npm run db:reset    # drop, recreate, apply shim + all migrations
npm run test:rls    # tenant isolation, roles, module gating, invitations, audit
npm run test:core   # export worker
```

## Layout

```
supabase/
  migrations/       0001..0013, applied in order; the product schema
  local/            local-only shim; NEVER applied to a real Supabase project
packages/core/
  src/export.ts     export worker: snapshot + files -> plain readable archive
test/rls/           the isolation suite, with its own assertion harness
scripts/            db-reset.sh, test-rls.sh
docs/               architecture, security model, phase plan, the source spec
```

## What Phase 0 gives you

- **Tenancy** — `families`, `profiles`, `family_members`, invitations. A user may
  belong to several families (their own household *and* their parents').
- **Roles** — owner / admin / adult / child / viewer on an explicit privilege
  ladder, with ownership transferable only by an owner and a family guaranteed
  to always retain one.
- **Module registry** — every feature is toggleable per family. Module tables
  added later gate on `app.can_view_module()` / `app.can_edit_module()` rather
  than re-deriving access rules, so a family disabling a module makes its data
  genuinely unreachable, not merely hidden.
- **Sensitivity tiers** — `standard` / `sensitive` / `restricted`. Children are
  structurally excluded from sensitive and restricted data; the password
  directory and estate documents (spec §9's highest tier) are admin-only. A
  family can tighten a module's gate but never loosen it below its tier floor.
- **Storage** — pointer records in Postgres, bytes in object storage, with the
  `families/<family_id>/` prefix enforced by a CHECK constraint *and*
  independently by storage RLS.
- **Notifications** — per-person, per-channel, per-module preferences; fan-out
  respects module visibility so a member is never notified about data they
  cannot see.
- **Audit** — append-only, enforced by both GRANTs and a trigger.
- **Export** — a plain archive of CSV + JSON + original files under dated,
  readable paths, with a README that explains itself to a non-technical relative
  years from now. Table discovery is by `family_id` column, so modules built in
  later phases are included automatically.

## What Phase 0 does not give you

No UI, no feature modules, and no push delivery workers — the notification
tables and fan-out exist, but nothing talks to APNs/FCM yet. The export worker
builds the archive directory; zipping and uploading it is the remaining piece.

The mobile client is **React Native** (spec §6), but no app code exists yet.
Phase 0 is entirely client-agnostic, so nothing in the schema changes as a
result. See [docs/phase-plan.md](docs/phase-plan.md#client-framework--decided-react-native).
