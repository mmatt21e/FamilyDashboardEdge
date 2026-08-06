# Family Dashboard

A private dashboard for one family, as an installable web app (PWA) on GitHub
Pages. Photos, memories, a shared calendar and a message board — on iPhones and
Androids alike, with no app store and no monthly bill.

This is **for one family's own use**. It is not a product, there is no billing,
and it never handles anyone else's data.

---

## What it does today

| Feature | Status |
|---|---|
| Add to Home Screen on iPhone and Android | Working |
| Sign in with your own Google account | Working |
| **Photos** — everything in the shared Drive folder | Working |
| **Filter photos** by who is in them, year, month, event, folder or text | Working |
| **Videos** — their own library, year wall and in-app playback | Working |
| **Tag and correct photos by hand** — people, event, date | Working |
| One-tap tagging in the photo viewer | Working |
| **Invite people from inside the app** | Working |
| One-tap install on Android; guided Add to Home Screen on iPhone | Working (see below) |
| **Memories** — on this day, a year / four years / ten years ago | Working |
| **Calendar** — visits, trips, when everyone is together | Working |
| **Message board** — short updates and photos | Working |
| **Care** — medical info, medications and dose log, appointments, care log, wellness checks | Working |
| **Money** — safe financial references, bills and expenses, monthly shared budget | Working |
| **Features panel** — open every available module and choose personal toolbar shortcuts | Working |
| **All planned modules** — coordination, documents, history, household, and family-fun tools | Working |
| Searchable HTML walkthrough for every module | Working |
| Settings with on/off switches for every feature | Working |
| Per-person notification preferences | Preferences work; **sending needs a Cloud Function** |
| Dark mode | Working |
| Version number and one-tap update check in Settings | Working |
| Setup checklist with PhotoSync walkthrough | Working |
| Remaining features from the original plan | All implemented and unlocked in version 2.0 |

Photos and videos are moved off phones by **PhotoSync**, not by this app — a web
app cannot do that on iOS. The dashboard reads the folder PhotoSync uploads to.

---

## No keys are stored in this repository

There are no Firebase keys, no Google client ID and no folder ID in the source.
You type them into the app once, on the Setup screen, and they are saved on your
phone.

That works because a Firebase web config and an OAuth client ID are **public
values by design** — they ship inside every web app that uses them and are
visible in any browser's network tab. They identify your project; they do not
grant access to it. Access is controlled by the Firestore security rules in
[`firestore.rules`](firestore.rules) and by Google's consent screen.

So this repository can be public without leaking anything, and you never edit
code to set it up.

---

## Setting it up

Roughly 20 minutes, once. After that, everyone else is a single tap.

### 1. Turn on GitHub Pages

Settings → Pages → Source: **GitHub Actions**. Push to `main` and it deploys.

### 2. Create a Firebase project

1. [console.firebase.google.com](https://console.firebase.google.com) → add a project (disable Analytics, you do not need it).
2. Build → **Firestore Database** → create, in production mode.
3. Build → **Authentication** → Sign-in method → enable **Google**.
4. Project settings → Your apps → **Web app** (`</>`) → register it. Copy the `firebaseConfig` block it shows you.
5. Firestore → **Rules** → paste in [`firestore.rules`](firestore.rules) → Publish.

### 3. Allow your site to sign people in

Authentication → Settings → **Authorised domains** → add `yourname.github.io`.

Without this, sign-in fails with a confusing error.

### 4. Create the shared Drive folder

Make a folder in Google Drive, share it with everyone in the family (Editor),
and copy its ID from the address bar — the long code after `/folders/`.

### 5. Add yourself as the first family member

The security rules only let existing members in, so the first one has to be
added by hand. Sign in to the app once — it will say you are not on the family
list, which is expected. Then in Firebase console → Firestore → create:

```
Collection: members
Document ID: <your uid, shown in Authentication → Users>
Field:       email  (string)  your@email.com
```

Reload. That is the only time anyone touches the console — everyone after you
gets in on an invitation you send from Settings.

### 6. Fill in the Setup screen

Open the app, paste the `firebaseConfig` block, the Google client ID
(Authentication → Sign-in method → Google → Web SDK configuration) and the Drive
folder ID.

### 7. Invite everyone else

Settings → **Invite someone**. Give their name and, ideally, the email address
of the Google account they will sign in with, then **Send the invitation**.

**The app emails it for them.** There is still no server and no mail account:
the email goes out through the Gmail API as *you*, the signed-in inviter, so it
arrives from an address the recipient recognises rather than a no-reply nobody
trusts. Two one-time things make that work:

- **Enable the Gmail API** for the family's Google Cloud project (the same
  console the Drive API was enabled in). If it is off, the first send fails
  with a message that links straight to the right console page.
- **Approve the send permission** the first time you send an invitation. Google
  shows a consent screen for "send email on your behalf"; it is asked for only
  at the moment of sending, never bundled into the everyday Drive permission,
  and the token it produces is kept in memory only.

If sending fails — or you leave the email blank — the screen falls back to the
old ways: Gmail's compose window pre-filled, the phone's share sheet, or plain
copying. A link-only invitation is never emailed at all.

The link does three things when they open it: fills in all the settings, walks
them through adding the app to their home screen, and lets them sign in with
their own Google account. Nobody has to touch the Firebase console.

**Bind the invitation to an email address whenever you can.** With one set, only
that Google account can use the invitation, so a forwarded link is worthless to
anyone else. Leave it blank and anyone holding the link can join, once.

Invitations last 14 days, are single-use, and can be cancelled from the same
screen. Settings → **Set up everyone else** still copies a plain settings link
with no invitation attached, for a second device belonging to someone already in
the family.

---

## About installing to the home screen

Worth being straight about, because it is the one thing that cannot work the way
it sounds like it should: **a link cannot install a web app.** There is no URL
or scheme on iOS or Android that installs a PWA. Tapping a link opens a browser.
That is all a link is able to do on either platform.

What the invitation link actually does is land on a screen that gets as close as
each platform allows:

| Where it opens | What happens |
|---|---|
| **Android, Chrome** | A real one-tap **Add to home screen** button. Chrome hands the page an install event and the app fires the genuine system dialog. |
| **iPhone / iPad, Safari** | Two named taps: Share → Add to Home Screen. iOS has never had an install API and there is no substitute for doing it by hand. |
| **Inside another app's browser** (Gmail, Messages, Facebook, Instagram) | "Open this in Safari/Chrome first", plus a copy-link button. Those built-in browsers usually have no Add to Home Screen at all — this is the failure that actually happens, because an invitation arrives *inside* one of those apps. |
| **Desktop** | Skipped entirely. It goes straight to the dashboard and asks them to sign in. |

Every version of the screen offers **Carry on in the browser**, and the choice
sticks. The dashboard works perfectly well in a tab, and trapping someone behind
an install step they cannot complete would be worse than not asking. Settings
keeps the same offer for whenever they change their mind.

---

## Getting photos flowing

Open **Setup checklist** in the app on each phone. It walks through installing
PhotoSync, granting full photo access, pointing it at the shared folder, and
turning on Autotransfer.

The last step checks the **shared folder**, not the phone, and reports "Waiting
for the first photo…" or "Connected". Checking at the destination is the only
way to know it really worked — PhotoSync can look correctly set up and still not
be uploading.

Point PhotoSync at `Dashboard_Image_Storage/<your name>` — the app creates that
folder for each family member. That is how it knows whose photos are whose. A
folder at the top level named after the person works just as well, so an
existing setup does not need changing.

### Filtering by who is in a photo

Photos can be filtered by **person, year, month, event, folder and free text**,
in any combination — "Jocelyn and Mindy, 2010" is one tap plus a dropdown.

Knowing *who* is in a photo is the one thing Drive cannot tell you, so it comes
from a face-recognition pass run once, offline, on a computer with the archive
attached. That pass produces three CSVs, which are imported through
**Settings → Photo tags → Import photo tags**:

| File | What it provides |
|---|---|
| `image_person_tags.csv` | who is in each photo |
| `people_index_v2.csv` | the date each photo was taken, and its event |
| `clusters_to_name.csv` | how much of the run has been named (reporting only) |

The files are read on the device and never uploaded — only the photo-to-people
mapping they describe is saved, into your own Firestore. Photos are matched **by
filename**, so it works whether you upload the organised copies or the originals
straight off the camera. Where a camera filename is ambiguous (`DSC_0220.JPG`
exists in four folders), the photo is left untagged rather than guessed at.

Two things worth knowing about the data:

- **A face cluster is not a person.** One person is typically spread across
  dozens of clusters — different ages, lighting and angles. The importer merges
  people by *name*, which is what both per-image CSVs already use. Clusters left
  unnamed contribute nothing, and the import preview tells you how many there are.
- **Filtering happens in the browser**, over the listing already in memory. That
  is what makes any combination of filters possible: Firestore allows one
  `array-contains` per query and needs a composite index per combination, so
  "these two people, this year, this event" is not a query it can answer. The
  trade is that the tagged library has to fit in memory — fine for the few
  thousand photos a family actually curates, which is a good reason to curate.

### Correcting tags by hand

The import is a machine's opinion, and machines get it wrong — a face in shadow
missed, two siblings confused, whatever wrong date the camera had. So any photo
can be corrected by anyone in the family:

- **In the viewer, one tap.** Open a photo and the names already used across
  the library appear as chips underneath it, commonest first, minus anyone
  already tagged — which for a family album is nearly always the person you were
  about to type. Tap to add. Tap a tagged name's ✕ to remove. Both save
  immediately; there is nothing to confirm, because a tag added by mistake comes
  off with the ✕ beside it. **Someone else** opens a box for a name nobody has
  used yet.
- **Date & event** in the viewer opens the fuller editor, for correcting or
  clearing a date and filing the photo under an event.
- **When adding photos.** Choosing files brings up the same form before the
  upload starts, and the answers apply to the whole batch. This is the one
  moment when whoever is adding them definitely knows what they are.
- **In Memories**, too — where a wrong date is most obvious, because the photo
  turns up on the wrong anniversary.

Clearing a date is a real answer, not a blank: the photo drops out of the year
and month filters and stops appearing in Memories. That is usually what you want
for a scan whose file date is the day it was scanned.

Corrections live in their own `photo_edits` collection, **separate from the
imported catalog**, and a re-import never touches them. A person who looked at a
photo and said who is in it is a better source than a face model, and stays that
way. Each correction stores only the fields actually changed, so a photo whose
date you fixed still picks up better *people* from the next import.

Manual tagging works whether or not you have ever run the face tools — a family
that just wants to tag as they go can ignore the import entirely.

### Seed the memories

Memories has nothing to show on day one. Drop a few hundred older photos into
the shared folder at setup and it has material immediately — the original dates
are read from the photos themselves, so a 2015 holiday resurfaces on its own
anniversary rather than on the day you uploaded it.

---

## Running it locally

```bash
npm install
npm run serve        # http://localhost:8080

npm test             # logic tests (no browser needed)
npm run test:browser # boots the app in Chromium
npm run test:all
```

There is **no build step**. The repository root is the site. That is deliberate:
this needs to still work in five years, maintained by one person in evenings, and
a toolchain is the thing most likely to rot first.

---

## How it fits together

```
Phones ──PhotoSync──▶ Shared Google Drive folder ◀──reads/uploads── This app
                                                                        │
                                              messages, calendar,       │
                                              module settings ──────────┘
                                                    Firestore
```

- **Drive** holds the files. Photos stay photos and documents stay PDFs, so the
  folder is readable by anyone with access, with or without this app. That is
  the "someone can still get at this later" guarantee.
- **Firestore** holds small records: messages, calendar entries, which features
  are on, and pointers to files. No large binaries.
- **The app** is static files on GitHub Pages.

### Layout

```
index.html            the shell
sw.js                 service worker (caches the shell, never your data)
manifest.webmanifest  home-screen install
firestore.rules       paste into the Firebase console
src/
  config.js           in-app settings + shareable setup links
  modules.js          the feature registry — add a feature here
  memories.js         "on this day" date logic
  files.js            Drive metadata → pointer records
  catalog.js          face-tag CSVs → who is in each photo
  invites.js          invitation codes, links, expiry and the email itself
  gmail.js            sends the invitation email through the Gmail API
  install.js          which device this is, and how it can install
  catalog-store.js    where those tags live in Firestore
  photo-edits.js      corrections made by hand, which an import never undoes
  photo-filter.js     the photo filter bar's logic
  records.js          shared care/money data, audit fields and budget calculations
  version.js          which build this is — stamped at deploy
  firebase.js         sign-in and data
  drive.js            the shared folder
  views/              one file per screen
test/                 logic tests + a browser smoke test
```

### Adding a feature

1. Add a row to `src/modules.js` with `status: 'ready'`.
2. Write a view in `src/views/`.
3. Register a route in `src/app.js`.

It then appears in Settings with a switch and in the Features panel. Each person
can independently add it to their own toolbar. Record-style modules share the
audited `list_items` structure rather than duplicating a new data layer.

---

## Not built yet

Being explicit, so nothing here is a surprise:

- **Sending notifications.** Preferences, permission and device registration all
  work and are stored per person. Nothing can actually *send* a push, because a
  static site has no server — that needs a Cloud Function on your own Firebase
  project, triggered by new documents in `messages` or `calendar_events`. The
  Settings screen says so rather than showing a switch that does nothing.
- **No explicit export button.** Not needed for the inheritance goal: the shared
  Drive folder already *is* the plain readable archive — photos as photos, PDFs
  as PDFs, openable without this app ever existing.

## Care and money modules

Version 2.0 unlocks the full catalog, including all care and money modules, for
existing and new families. Settings can still make any optional feature
unavailable to the family, and each person chooses their own toolbar shortcuts
from the Features panel. Existing installations must publish the current
[`firestore.rules`](firestore.rules) before care and money screens can save data.

- Medical info is a family reference, not a clinical or emergency system. It
  stores allergies, conditions, care-team contacts, insurance references and
  care preferences. Verify instructions with a clinician and call emergency
  services for urgent help.
- Medications keeps the current list and a simple dose log. Appointments covers
  preparation, location, transport and completion. Care log is a chronological
  handoff between family members. Wellness check shows who has and has not
  checked in today; sending an alert for a missed check still requires the same
  Cloud Function as other push notifications.
- Financial records is intentionally a safe index rather than a password vault:
  use nicknames and last-four references only. Bills & expenses tracks dates,
  status and recurring costs. Shared budget compares monthly category plans with
  the expenses recorded for that month.

## If it hangs on "Starting…"

The app now diagnoses this itself: after 15 seconds it stops waiting, asks
Google directly what is wrong, and shows you the answer with a link to the page
that fixes it.

The usual cause is that **Cloud Firestore was never created** in the Firebase
project. Its SDK does not fail when the backend is missing — it opens a
connection, gets a 503, and retries forever. Nothing throws and nothing appears
in the browser console, which is why this used to be so hard to spot.

Fix: Firebase console → Firestore Database → **Create database** → Production
mode → then publish [`firestore.rules`](firestore.rules).

## What to actually put in the shared folder

Curate before you upload. This is the single decision that determines whether
the dashboard feels good or unusable, and the numbers from one real archive make
the case better than any argument:

| Photos | Tree |
|---:|---|
| 95,919 | `_Unified_File_Library` — an unsorted re-copy of the same drive |
| 82,459 | `Organized_Photos_v2/05_Untagged_Review` — backups of backups |
| 11,927 | `Organized_Photos_v2` — other |
| **8,605** | **`01_Timeline`** — the organised library |
| **1,057** | **`02_Events`** — named occasions |

89% of that drive is backups and unsorted duplicates. The organised library is
**9,662 photos** — and every face-tagged photo lives inside it, so importing the
tags after uploading those two trees means all of them land.

Upload the organised trees. Leave the backup trees on the drive where they are
already safe. A curated library is what makes filtering by "these two people,
this year, this event" instant, because the whole index fits in memory; two
hundred thousand photos would mean a composite Firestore index per combination
and nobody maintaining them.

## The shared folder's structure

**The app builds this itself.** The first time anyone opens Photos it creates
whatever is missing, and adds a folder for each family member. Settings →
**Shared folder structure** shows what is there and creates anything absent on
demand.

```
Family Dashboard/                  ← the shared folder (your driveFolderId)
├── Archive/                       the old library, imported once, by year
│   └── 2015/2015-09/…
├── Events/                        named occasions, one folder each
│   └── 2014 Cruise/…
├── Dashboard_Image_Storage/       photos
│   ├── Dad/  Mom/  Jocey/  Matt/  a folder per person, made as people join
│   │   └── 2026-07/…              app uploads land here, by month
│   └── Shared/                    when we don't know whose it is
├── Dashboard_Video_Storage/       videos, mirroring the photo store
└── Dashboard_Document_Storage/    anything that isn't a photo
    └── 2026/
```

**Five folders at the top, forever** — however many people join. That is the
whole point: a new member gets a folder inside the photo store, not another
entry at the root. Uploads from the app go under whoever added them and then by
month, so nothing is ever dropped loose in the shared folder.

Point PhotoSync at `Dashboard_Image_Storage/<your name>` on each phone. A person
folder at the *top* level works exactly as well — the app reads whichever it
finds — so an existing setup does not need changing.

The app holds **full Google Drive access**, granted deliberately by the family
owner: the earlier narrow scopes could read everything but move only the app's
own uploads, which left every misfiled PhotoSync video permanently stuck. The
scope is a capability, not a behaviour — the code touches nothing outside the
shared folder, this repository is the audit trail for that claim, and the grant
can be withdrawn any time at myaccount.google.com/permissions. Each person
approves it once, on their next visit to Photos.

One thing the app still cannot do: **repoint PhotoSync.** That is a setting on
each phone.

Nesting is fine at any depth — the scan walks the whole tree with pagination.
The photo's *owner* is worked out from the whole path, skipping folders the app
manages and folders that are just dates, so `Archive/2015/2015-09/` belongs to
nobody in particular. That is the honest answer: everyone is in the archive, and
the people tags are what say who.

---

## Known limits

- **iOS will not let a web app work in the background.** Data refreshes when you
  open the app. This is why PhotoSync does the photo syncing.
- **Drive access needs a token that expires.** The app renews it silently on
  open; occasionally you may need to reload.
- **Everyone in the family can see everything.** There are no per-person
  permissions — deliberately, for a family app. Do not add anyone you would not
  show the whole dashboard to.
- **Firebase's free tier is generous but finite.** A single family will not get
  near it; a runaway loop could. Worth setting a budget alert.

---

## The previous project

This repository previously held a multi-tenant Supabase backend for a commercial
version of the same idea. It is preserved on the **`archive/pre-family-dashboard`**
branch and nothing was lost.
