# Security model

This product stores medical, financial and legal records for private family
groups. Spec §9 treats compliance and security as first-class requirements
rather than a later hardening pass, so the isolation rules live in the database
and are covered by tests that run on every change.

## The invariant

> A request may only ever reach rows whose `family_id` names a family the caller
> is an active member of.

Enforced by Postgres row-level security, so it holds for the mobile app, the
web client, an edge function, and anyone with a connection string alike. No
application layer is trusted to remember it.

## Layers

Access is checked at four independent points. A defect in one does not open the
others.

1. **GRANTs.** `anon` has no table privileges and cannot execute the access
   helpers. Unauthenticated requests fail before RLS is consulted.
2. **RLS policies.** Every table in `public` has RLS enabled with no permissive
   fallback. Separate policies per command; `INSERT`/`UPDATE` carry a
   `WITH CHECK` that re-verifies `family_id`, so a caller cannot write a row
   into another tenant.
3. **Constraints and triggers.** `family_id` is immutable on every tenant table.
   File keys are constrained to their own family's prefix. A family must retain
   an active owner. Ownership can only be granted by an owner.
4. **Storage RLS.** `storage.objects` derives the family and module from the
   object path independently of `public.files`, so a leaked or guessed object
   key is not enough to download another family's documents.

## Why the access helpers are `SECURITY DEFINER`

The natural policy for `family_members` — "you can see rows for families you
belong to" — is itself a query against `family_members`. Under RLS that recurses
and Postgres raises `infinite recursion detected in policy`.

`app.family_role()` and its callers run as the function owner, which is also the
table owner, and a table owner is exempt from that table's policies. The
membership lookup therefore happens outside RLS and terminates the recursion.

**Consequence:** `public.family_members` must not have `FORCE ROW LEVEL
SECURITY`. Forcing RLS applies policies to the owner too, reintroducing the
recursion and breaking every policy in the schema.

Each helper is also `STABLE` (so the planner can hoist it out of per-row
evaluation) and carries `SET search_path = ''` with every reference fully
qualified, so a hostile `search_path` cannot redirect it to shadow objects.

## `NULL` is not `false`

`app.family_role()` returns `NULL` for a non-member. A rank comparison against
`NULL` yields `NULL`, not `false`.

Inside an RLS policy `NULL` is filtered as false, so a `NULL`-returning helper
*looks* correct everywhere RLS is involved. But a `SECURITY DEFINER` RPC guarded
by

```sql
if not app.is_family_admin(target) then raise ... end if;
```

does **not** fire on `NULL` — `not NULL` is `NULL`, the branch is skipped, and
the function proceeds. This shipped as a real bug during development: a
non-member could export any family's data, transfer its ownership, or toggle its
modules by naming its id.

Every boolean helper now `coalesce`s to `false`, and the test suite pins the
property with `is false` rather than `not ...`, so `NULL` fails the assertion.
**Any new helper must return a real boolean.**

## Roles

| Role | Rank | Can |
|------|-----:|-----|
| `owner` | 100 | everything; transfer ownership; delete the family |
| `admin` | 80 | manage members and modules; read restricted data |
| `adult` | 60 | full participation; read sensitive data |
| `child` | 40 | standard modules only — never sensitive or restricted |
| `viewer` | 20 | read-only; never writes; never restricted |

Ranking is explicit (`app.role_rank()`), not enum declaration order — enums
compare by ordinal, which would make `owner` the *lowest* value.

## Sensitivity tiers

| Tier | Floor | Examples |
|------|-------|----------|
| `standard` | viewer | photos, calendar, lists, messages |
| `sensitive` | viewer, never child | medical info, financial records, document vault |
| `restricted` | admin | password/account directory, digital estate |

The tier is a floor that a per-family override cannot go below. A family may
tighten a module's role gate; a laxer override is accepted into the table but
has no effect, because the effective gate is whichever of the two is stricter
and the tier floor applies regardless. This is covered by tests.

## Invitations

Invitations are the only route from outside a tenant to inside it.

- Only admins may issue them; `owner` can never be granted by invitation.
- Only the SHA-256 hash of the token is stored, so a database leak yields no
  working invitations. The plaintext is returned exactly once, at creation.
- Tokens are 256 bits, single-use, and expire (14 days by default).
- **The invited email must match the redeemer's own address**, or the join goes
  to a **pending** state that a family admin must approve. A forwarded link is
  never enough on its own to enter a family holding medical and legal records.

  The pending path exists because a hard rejection breaks a case that will be
  common: Sign in with Apple's "Hide My Email" gives the user an
  `@privaterelay.appleid.com` address, so a grandparent invited at
  `grandma@gmail.com` would be refused — exactly the member spec §9 says must
  be able to get in unaided. An admin still decides who joins; the invitee just
  gets a recovery path.

  A pending member holds **no access at all**. Every access helper filters on
  `status = 'active'`, so a pending row grants nothing by construction rather
  than by a rule someone has to remember.

- **A pending request does not consume the invitation.** If it did, anyone
  holding a forwarded link could burn the token by triggering a pending request
  and lock the genuine invitee out of their own invitation. The token stays live
  until an *active* membership results from it; the pending row records which
  invitation it came from, and approval consumes it at that point. Approval also
  re-checks that the invitation is still valid, so revoking one actually stops a
  join that was requested before the revocation.
- Every failure mode returns one generic message, so the endpoint cannot be used
  to probe which tokens exist.
- Invitees cannot read `family_invitations`; redemption matches on the token
  hash inside a `SECURITY DEFINER` function.

## Audit

`public.audit_log` is append-only, enforced twice: no `INSERT`/`UPDATE`/`DELETE`
grants for client roles, and a trigger that refuses mutation even for the table
owner. Only admins may read it — the log records who looked at what, which is
itself sensitive.

Column *values* are deliberately not copied into audit entries. For medical and
financial tables that would duplicate the sensitive payload into a second,
longer-lived table. Only changed column *names* are recorded.

## The checklist for a new module table

Every table added in Phase 2 or 3 must:

1. Carry `family_id uuid not null references public.families(id) on delete cascade`.
2. `alter table ... enable row level security` and grant to `authenticated`.
3. Gate its policies on `app.can_view_module(family_id, '<key>')` and
   `app.can_edit_module(family_id, '<key>')` — do not re-derive access rules.
4. Attach `app.guard_immutable_family_id()` as a `before update` trigger.
5. Register the module in `public.module_catalog` with its sensitivity tier.
6. Attach `app.audit_row_change('<tier>')` if the data is sensitive or
   restricted.
7. Add isolation assertions to `test/rls/`.

Step 3 is what makes "we turned that module off" a true statement rather than a
UI convention. The export picks the table up automatically by virtue of step 1.

## Known gaps

Phase 0 is the database foundation. Still outstanding before the product handles
real customer data:

- **Encryption at rest for the restricted tier.** Supabase encrypts the volume,
  but the password directory and digital estate warrant application-level
  envelope encryption so a database compromise does not expose them.
- **Legal review.** Spec §9 is explicit that medical/financial/legal data is
  real regulatory territory and depends on jurisdiction. Not a code task.
- **Rate limiting** on invitation redemption.
- **Session and device revocation** flows beyond `device_tokens.revoked_at`.
- **Backup restore drill.** The export is tested; restoring from it is not.
