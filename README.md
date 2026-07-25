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
| **Memories** — on this day, a year / four years / ten years ago | Working |
| **Calendar** — visits, trips, when everyone is together | Working |
| **Message board** — short updates and photos | Working |
| Settings with on/off switches for every feature | Working |
| Per-person notification preferences | Preferences work; **sending needs a Cloud Function** |
| Dark mode | Working |
| Setup checklist with PhotoSync walkthrough | Working |
| The other ~35 features from the plan | Listed in Settings as "Coming soon" |

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

Reload. Everyone after you is added automatically when they first sign in.

### 6. Fill in the Setup screen

Open the app, paste the `firebaseConfig` block, the Google client ID
(Authentication → Sign-in method → Google → Web SDK configuration) and the Drive
folder ID.

### 7. Send everyone else the link

Settings → **Set up everyone else** → Copy link. Anyone who opens that link on
their phone gets the whole configuration filled in for them. Send it in the
family chat, not anywhere public.

---

## Getting photos flowing

Open **Setup checklist** in the app on each phone. It walks through installing
PhotoSync, granting full photo access, pointing it at the shared folder, and
turning on Autotransfer.

The last step checks the **shared folder**, not the phone, and reports "Waiting
for the first photo…" or "Connected". Checking at the destination is the only
way to know it really worked — PhotoSync can look correctly set up and still not
be uploading.

Give each phone its own subfolder named after the person. That is how the app
knows whose photos are whose.

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
  firebase.js         sign-in and data
  drive.js            the shared folder
  views/              one file per screen
test/                 logic tests + a browser smoke test
```

### Adding a feature

1. Add a row to `src/modules.js` with `status: 'ready'`.
2. Write a view in `src/views/`.
3. Register a route in `src/app.js`.

It then appears in Settings with a switch and in the navigation. List-type
features (shopping, bucket list, watchlist, wish lists) share one generic
list/item structure rather than each getting their own.

---

## Not built yet

Being explicit, so nothing here is a surprise:

- **Sending notifications.** Preferences, permission and device registration all
  work and are stored per person. Nothing can actually *send* a push, because a
  static site has no server — that needs a Cloud Function on your own Firebase
  project, triggered by new documents in `messages` or `calendar_events`. The
  Settings screen says so rather than showing a switch that does nothing.
- **The other ~35 features.** Listed in Settings as "Coming soon" and not
  switchable. The registry is ready for them.
- **The generic list structure.** `lists` / `list_items` are in the security
  rules and the design is settled, but nothing uses them until the first
  list-type feature (shopping list) is built.
- **No explicit export button.** Not needed for the inheritance goal: the shared
  Drive folder already *is* the plain readable archive — photos as photos, PDFs
  as PDFs, openable without this app ever existing.

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
