# Phase plan

Tracks spec §8. Phase 0 is complete; this records what was built, what was
deliberately left out, and the decision that gates Phase 1.

## Phase 0 — Core Foundation ✅

Everything spec §4 lists, plus the audit trail spec §9 requires.

| Item | Where |
|------|-------|
| Auth & identity | `0002_tenancy.sql` — `profiles` mirrors `auth.users` |
| Family/tenant model | `0002`, `0004` — strict isolation, proven in `test/rls/` |
| Roles & permissions | `0001` (ladder), `0003` (helpers), `0004` (escalation guards) |
| Module registry & settings | `0005`, `0006` — all 46 modules from spec §3 catalogued |
| Notifications | `0010` — preferences, device tokens, visibility-aware fan-out |
| File storage service | `0008`, `0009` — pointers + per-family prefix, enforced twice |
| Real-time sync | Supabase Realtime; RLS applies to the replication stream |
| Export / backup | `0012` + `packages/core/src/export.ts` |

**149 assertions** across isolation, roles, module gating, invitations, audit
and export. They found three real bugs during development — see the
[security model](security-model.md#null-is-not-false) for the most instructive.

Not built, and deliberately so: any feature module, any UI, and the APNs/FCM
delivery workers.

## Client framework — DECIDED: React Native

Spec §6: *"Pick Flutter unless existing web/JS skill argues for React Native."*
That turns on a fact about who is building this, which the spec does not record.
Phase 0 was therefore built client-agnostic, and the call has now been made:
**React Native**.

Consequences that follow from it:

- `packages/core` (TypeScript) is shared with the app rather than rewritten.
- A web/PWA client (spec §6's optional secondary) becomes cheap *if* chosen
  early, via react-native-web — retrofitting it later is not cheap.
- `supabase-js` in React Native needs an AsyncStorage auth adapter and a URL
  polyfill; without them session persistence silently fails on device.
- Spec §7 is unaffected: background photo sync needs native iOS work whichever
  framework wraps it.

The comparison that led here is kept below as the record.

## Other decisions taken

| Decision | Choice | Consequence |
|----------|--------|-------------|
| RN tooling | **Expo, dev builds** (not Expo Go) | EAS Build covers signing and store submission (spec §9's recurring cost); OTA updates ship JS fixes without a review cycle; native modules still available via the Expo Modules API for Phase 2 |
| v1 module set | **Message board + calendar + chores/lists** | Spec §8's stated alternative. Keeps the document vault — and the envelope-encryption work it needs — out of the v1 critical path |
| Mismatched invitation email | **Pending join, admin approves** | Implemented in `0014_join_requests.sql`. Handles Apple's Hide My Email without weakening who decides membership |
| Web/PWA client | **Eventually, planned for now** | Pick react-native-web-compatible component libraries from the first commit; retrofitting is the expensive path |

### Still open

**Supabase region / data residency.** Set at project creation; moving later
means a migration with downtime. Depends on where customers are — EU customers
plus medical data means an EU region and GDPR obligations from day one. Spec §9
wants legal review here; the region is the irreversible part.

### Why the vault is not in v1

The document vault is `sensitive` tier and is the module that most needs the
application-level encryption listed under
[known gaps](security-model.md#known-gaps). That work is not just key
management — it collides with the export guarantee. If the vault is encrypted at
rest, the export worker must decrypt on the way out, or "a relative can open
this years from now" stops being true. Worth designing deliberately rather than
under v1 pressure.

Chores and lists also earn their place on merit: they get *daily* use, which is
what spec §8's "genuinely working and loved at home" actually requires. A vault
gets opened twice a year.

|  | Flutter | React Native |
|--|---------|--------------|
| Spec's default | ✅ recommended | conditional |
| Single-codebase polish | strongest | good |
| Reuses `packages/core` (TypeScript) | ✗ Dart rewrite | ✅ directly |
| Web/PWA client (spec §6) | Flutter Web is heavy | ✅ same language |
| Phase 2 background photo sync | platform channels either way | platform channels either way |

Neither choice was affected by anything in Phase 0 — the database, RLS, RPCs and
export are all client-agnostic, and both frameworks talk to Supabase over the
same API.

## Phase 1 — Core v1

Spec §8 recommends message board + shared calendar + document vault. All three
are already catalogued (`phase = 1`, `status = 'planned'`); shipping one means
building its table against the
[new-module checklist](security-model.md#the-checklist-for-a-new-module-table)
and flipping `status` to `available`.

Design lists generically (spec §11): one `lists` + `list_items` structure serves
grocery, bucket list, watchlist, reading list and gift lists. The catalog
already treats them as separate module keys over what should be shared tables.

Also needed before dogfooding: push delivery workers, and zip+upload for the
export archive.

## Phase 2 — Photo system

Spec §7 is explicit that this is the hardest component and should not block
Phases 0–1. Nothing in Phase 0 depends on it. `public.files` already carries
`captured_at`, `checksum_sha256`, dimensions and `thumbnail_key`, so the schema
does not need to change to support it.

Track it as its own project with its own milestones: resumable chunked uploads,
iCloud fetch, HEIC conversion, Live Photos as paired files, change observers,
and first-sync of tens of thousands of items over flaky connections. During
early testing a stopgap uploader pointed at storage is acceptable; the shipped
product must own it (spec §10).

## Phase 3 — Expand modules

Care, financial, history and connection modules, each battle-tested before the
next. The registry and sensitivity tiers already model them; the care and
financial modules are `sensitive` and the password directory and digital estate
are `restricted`, so children are excluded structurally from the day their
tables exist.

## Phase 4 — Product readiness

The non-code half (spec §9). App Store and Play submission, per-family billing,
compliance and legal review for medical/financial/legal data, support flows for
non-technical members, and backend cost scaling.

Two items belong to engineering and are listed as
[known gaps](security-model.md#known-gaps): application-level encryption for the
restricted tier, and a backup *restore* drill — the export is tested, restoring
from it is not.
