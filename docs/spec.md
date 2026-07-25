# Family Dashboard — Product Build Specification

**Purpose of this document:** A complete, self-contained handoff spec for an LLM (or engineering team) to build a sellable, cross-platform family dashboard product. It defines the vision, architecture, modules, data model, tech stack, hard problems, and a phased build plan. Read it top to bottom before writing code.

---

## 1. Product Vision

A modular family dashboard sold as a cross-platform mobile app (iOS + Android) with an optional web interface. Each customer is a **family** — a private group of members who share coordination tools, photos, documents, and connection features. Families range from young households (chores, meal planning) to distributed/empty-nest families (photo sharing, aging-parent care, legacy documents).

**Core differentiator:** No existing product combines daily coordination + distance connection + aging-parent care + document/legacy vault + owned-your-data control in one modular app. Competitors each own one slice (Cozi = logistics, Famileo = grandparent connection, Everplans = legacy). This product integrates them and lets each family enable only the modules they want.

**Guiding principles:**
- **Modular:** Every feature is an optional module toggled per family. Build shared foundations first, hang modules off them.
- **Privacy-first:** The app holds medical, financial, and legal data. Security and compliance are first-class requirements, not afterthoughts.
- **Owned data / portability:** Prefer open, portable storage. Data should be exportable in plain, readable formats (photos as photos, records as PDFs) so a family never feels locked in — this also underpins the "inheritance" use case.
- **Ship small:** Launch with 2–3 core modules proven by real use, then grow.

---

## 2. Architecture Overview

Two cooperating storage systems, each doing what it is best at:

1. **Structured database (live/interactive data):** messages, chore states, calendar entries, lists, check-ins, module settings, user/roles. Must sync in real time across devices. **Recommended: Supabase** (Postgres-based, open-source, portable, strong row-level security, good for structured financial/medical queries, scales into multi-tenant). Firebase is a viable alternative but less portable and weaker for relational queries.

2. **Object/file storage (heavy files):** photos, videos, document PDFs, home-inventory images. Files stored as objects; the database holds a **record pointing to each file** (URL/key + metadata), keeping the database lean.

**Multi-tenancy (critical for product):** Unlike the personal version, the product must NOT use a shared consumer Google account as a backend. Each family gets an isolated, secure tenant provisioned automatically at signup. Enforce isolation at the database layer (e.g. Supabase Row-Level Security keyed on `family_id`) and in storage (per-family buckets/prefixes).

**Clients:**
- Cross-platform mobile app (see §6 for framework choice) — primary.
- Optional PWA/web dashboard for larger-screen use (read/write to the same backend).

**Photo sync:** The mobile app owns background photo capture and upload itself (do NOT depend on a third-party uploader in the shipped product). This is the hardest engineering component — see §7.

**Data flow example (photo post):** Native app captures/reads photo → uploads file to object storage (per-family bucket) → writes a DB record (author, timestamp, file key, optional caption) → other members' clients see the new record live and fetch the file.

---

## 3. Module Catalog

All modules are optional and toggleable per family. They depend on the **Core Foundation** (§4).

### Daily Life & Communication
- Shared photo library (with per-person source folders/albums)
- "On this day" memory resurfacing
- Family message board / update feed
- Video message & voice note sharing
- Daily check-in / status ("I'm good today")
- Gratitude / weekly highlight feed
- Comments/chat threads on photos and posts

### Calendar & Coordination
- Shared family calendar (visits, travel, events)
- Birthdays & anniversaries tracker with reminders
- Countdown to next gathering/trip
- Visit planner (who's hosting, who's traveling, when)
- Availability sharing (for planning calls/visits)
- Time-zone display for geographically spread families

### Care & Peace of Mind (aging parents)
- Emergency & medical info panel (medications, doctors, allergies, insurance, contacts)
- Medication reminder & tracking
- Appointment scheduler & reminders
- Care-coordination log for siblings sharing responsibilities
- Wellness check-in with optional alerts if someone doesn't check in

### Important Documents & Legacy
- Secure document vault (wills, policies, account info, property records)
- Digital estate / "in case of emergency" instructions
- Home inventory with photos (for insurance)
- Password/account directory for essential services (treat with highest security tier)

### Preserving Family History
- Family recipe box
- Family story & history archive (recorded memories, oral histories)
- Scanned old-photo archive
- Family tree

### Household & Practical
- Shared grocery & shopping list
- Meal planning (can auto-generate grocery list)
- Chore & task tracking
- Allowance / points system (ties to chores)
- Home maintenance log & reminders
- Shared notes / reference (wifi passwords, house info)

### Connection & Fun
- Family bucket list
- Shared watchlist (movies & shows)
- Shared reading / book club
- Collaborative playlists
- Group polls & decision-making
- Gift idea lists / wishlists per person

### Financial
- Shared financial records storage
- Bill / expense tracking
- Shared budget for group expenses (trips, gifts, parents' care)

### System & Utility (part of Core, listed for completeness)
- Per-user accounts with roles & permissions
- Granular privacy controls (who sees what)
- Per-person notification preferences
- Dark mode
- Multi-language support

---

## 4. Core Foundation (build first — modules depend on it)

- **Auth & identity:** Each member signs in with their own identity (email, or "Sign in with Google/Apple"). No shared passwords. Support inviting members to a family and granting access.
- **Family/tenant model:** `family` entity; members belong to one or more families; strict data isolation per family.
- **Roles & permissions:** e.g. owner/admin, adult, child, view-only (for extended family or granting an adult child access to a parent's info). Module visibility and edit rights derive from roles + per-module privacy settings.
- **Module registry & settings:** each family enables/disables modules; per-module config lives here.
- **Notifications:** push (mobile) + optional email; per-person preferences.
- **File storage service:** upload/download, per-family isolation, thumbnails, plain-format export.
- **Real-time sync layer:** live updates for interactive data.
- **Export / backup:** produce a plain, human-readable export (photos as image files in dated folders, documents as PDFs, structured data as CSV/JSON) — supports portability and the inheritance use case.

---

## 5. Data Model (starting sketch)

Relational (Postgres/Supabase). All tables carry `family_id` for isolation; enforce with row-level security.

- `families` (id, name, created_at, plan/settings)
- `users` (id, name, auth_provider, ...)
- `family_members` (family_id, user_id, role, joined_at)
- `modules` (family_id, module_key, enabled, config_json)
- `messages` (id, family_id, author_id, body, created_at, attachment_file_id?)
- `files` (id, family_id, owner_id, storage_key, kind, mime, size, created_at, metadata_json) — pointer records for object storage
- `calendar_events` (id, family_id, title, start, end, type, created_by, recurrence)
- `tasks` / `chores` (id, family_id, title, assignee_id, status, due, points?)
- `lists` + `list_items` (grocery, bucket list, watchlist, etc. — generalize)
- `checkins` (id, family_id, user_id, status, created_at)
- `documents` (extends `files` with vault-specific fields: category, sensitivity)
- `medical_info`, `medications`, `appointments` (care module; high sensitivity)
- `contacts` (shared directory)
- `recipes`, `family_tree_nodes`, etc. (history modules)

Design lists/items generically so multiple list-type modules reuse one structure.

---

## 6. Tech Stack Recommendation

- **Mobile (primary):** cross-platform, single codebase for iOS + Android. Options:
  - **Flutter (Dart):** best single-codebase polish/performance; recommended default.
  - **React Native (JS/TS):** strong if the team has web/JS skills; large ecosystem.
  - **Kotlin Multiplatform:** shared logic + native UI; more engineering-heavy.
  Pick Flutter unless existing web/JS skill argues for React Native.
- **Backend:** Supabase (Postgres, Auth, Storage, Realtime, Row-Level Security). Serves multi-tenant isolation, structured queries, and portability.
- **Web/PWA (optional secondary client):** any modern web framework hitting the same Supabase backend; deployable to static hosting (e.g. GitHub Pages / Vercel / Netlify).
- **Notifications:** platform push (APNs/FCM) via the mobile framework + backend triggers.

---

## 7. Hardest Problem: iOS Background Photo Sync

**This is the single hardest component and will likely consume more effort than several other modules combined. Plan for it explicitly; do not treat it as a small feature.**

Why it's hard on iOS specifically:
- iOS suspends apps quickly when backgrounded/locked to save battery; you do not get free background time. Only constrained mechanisms exist (background tasks, background URL sessions) with tight, unpredictable limits.
- **Resumable, chunked uploads are mandatory:** large videos must survive suspension and dropped connections without restarting. Build robust resumable transfers.
- **Photo library complexity:** items may live only in iCloud (must be fetched first), HEIC may need conversion, Live Photos are two files, libraries can hold tens of thousands of items — track state to avoid duplicates and missed items.
- **New-photo detection in background is limited:** rely on photo-library change observers but expect to sync opportunistically (on wake/charge/foreground), not the instant a photo is taken.
- **Scale/real-world:** first-time sync of tens of thousands of photos over flaky connections, without draining battery or overheating, and eventually completing reliably.

**Sequencing recommendation:** Do NOT block v1 on this. Ship the modules that don't need it first (§8). During early testing, the family can lean on an existing uploader (e.g. PhotoSync pointed at storage) as a stopgap. Build the fully-owned background sync as its own dedicated hard-project once the rest of the product is proven. The shipped product must eventually own this — customers can't be asked to configure a third-party uploader.

---

## 8. Phased Build Plan

**Phase 0 — Core Foundation (§4).** Auth, family/tenant model with strict isolation, roles/permissions, module registry, notifications, file storage service, real-time sync, plain-format export. Nothing user-facing ships without this.

**Phase 1 — Core v1 (ship + dogfood with own family).** Pick 2–3 heart modules that DON'T require owned photo sync. Recommended: **message board/feed + shared calendar + document vault** (or lists/chores). Get it genuinely working and loved at home. Use a stopgap uploader for photos if needed.

**Phase 2 — Photo system.** Build the owned background photo sync (§7) plus the shared photo library, "on this day," and albums. This is the major engineering push.

**Phase 3 — Expand modules.** Add care/medical, financial, history, and connection modules incrementally, each battle-tested before the next.

**Phase 4 — Product-readiness (the non-code half).** App Store + Play Store submission/review, per-family billing/signup, privacy & security compliance for medical/financial/legal data (real legal territory — get proper review), customer support flows for non-technical users, and scaling backend costs.

---

## 9. Non-Code Requirements (do not underestimate)

- **App stores:** Apple developer program (annual fee) + Google Play; review processes on every update.
- **Compliance & security:** handling medical, financial, and legal documents demands serious security (encryption at rest/in transit, access controls, audit) and likely legal/regulatory review depending on jurisdiction. Treat the password/account directory and medical vault at the highest sensitivity tier.
- **Billing:** signup + subscription. Note: the "split cost per family member" idea is fair in spirit but painful in practice (processor fees on small amounts, chasing multiple payers) — simplest is one payer per family who settles privately.
- **Support & onboarding:** non-technical family members (including grandparents) must be able to install, sign in, and use it. Invest in a guided first-run onboarding checklist.
- **Maintenance:** iOS/Android change yearly; ongoing upkeep is part of the product.

---

## 10. Explicit Non-Goals / Decisions Already Made

- **No shared consumer Google account as the product backend.** (Fine for a single family's personal build; unacceptable for a multi-tenant product — fragile, against Google's terms, unsupportable.)
- **No dependence on a third-party photo uploader in the shipped product.** (Acceptable only as an early-testing stopgap.)
- **No storing each user's shared data in their own separate Google account.** (Breaks the "shared" experience and the single-point inheritance plan; use one isolated per-family backend instead.)
- **Modules are optional, not all-on.** Build shared foundations, then optional modules.

---

## 11. Handoff Notes for the Building LLM

- Start at Phase 0. Do not scaffold modules before the Core Foundation and tenant isolation exist.
- Enforce `family_id` isolation everywhere (DB row-level security + storage prefixes). This is a security-critical invariant.
- Keep files in object storage and pointers in the DB; never store large binaries in the relational tables.
- Design list-type features on one generic list/item structure.
- Make every module gate on the module registry so families can toggle features.
- Ensure a plain-format export exists early — it's both a feature and the safety/inheritance guarantee.
- Treat §7 (iOS background sync) as a standalone hard-project with its own milestones; don't let it block Phases 0–1.
