/**
 * Firebase: sign-in and data.
 *
 * The SDK is loaded from Google's CDN as ES modules and only *after* the family
 * has entered their config, so an unconfigured app downloads nothing and there
 * is no build step to keep alive. Everything is dynamically imported on first
 * use.
 */

const SDK = 'https://www.gstatic.com/firebasejs/11.0.2';

let app = null;
let authMod = null;
let dbMod = null;
let auth = null;
let db = null;

/** Boots Firebase from the saved config. Safe to call repeatedly. */
export async function initFirebase(config) {
  if (app) return { app, auth, db };

  const [{ initializeApp }, authModule, dbModule] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`),
  ]);

  authMod = authModule;
  dbMod = dbModule;
  app = initializeApp(config.firebase);
  auth = authModule.getAuth(app);
  db = dbModule.getFirestore(app);

  // Survive the app being closed and reopened, which for a home-screen PWA is
  // constant. Without this everyone signs in again every time they open it.
  await authModule.setPersistence(auth, authModule.browserLocalPersistence);

  return { app, auth, db };
}

export function firebaseReady() {
  return Boolean(app);
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * Signs in with Google.
 *
 * Popups are blocked or silently broken in an iOS home-screen PWA, so the
 * redirect flow is used whenever the app is running standalone. On a normal
 * browser tab the popup is nicer, because it does not lose the page.
 */
export async function signIn() {
  const provider = new authMod.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });

  if (isStandalone()) {
    await authMod.signInWithRedirect(auth, provider);
    return null; // the page navigates away; result is picked up on return
  }
  const result = await authMod.signInWithPopup(auth, provider);
  return result.user;
}

/** Completes a redirect sign-in, if we came back from one. */
export async function completeRedirectSignIn() {
  if (!authMod) return null;
  try {
    const result = await authMod.getRedirectResult(auth);
    return result?.user ?? null;
  } catch {
    return null;
  }
}

export function signOutUser() {
  return authMod.signOut(auth);
}

export function onAuthChange(callback) {
  return authMod.onAuthStateChanged(auth, callback);
}

export function currentUser() {
  return auth?.currentUser ?? null;
}

export function isStandalone() {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  );
}

// ---------------------------------------------------------------------------
// Firestore
// ---------------------------------------------------------------------------
// One family, so paths are flat: /members, /modules, /files, /messages,
// /calendar_events, /lists, /list_items, /photo_catalog. No tenant id anywhere -
// this app is deliberately single-family and adding one would be dead weight.

export async function getDoc(path, id) {
  const ref = dbMod.doc(db, path, id);
  const snap = await dbMod.getDoc(ref);
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function setDoc(path, id, data, { merge = true } = {}) {
  await dbMod.setDoc(dbMod.doc(db, path, id), data, { merge });
}

export async function addDoc(path, data) {
  const ref = await dbMod.addDoc(dbMod.collection(db, path), data);
  return ref.id;
}

export async function deleteDoc(path, id) {
  await dbMod.deleteDoc(dbMod.doc(db, path, id));
}

/**
 * Writes many documents in batches.
 *
 * One round trip per document is fine for the handful of writes the rest of the
 * app does, but the photo catalog import writes a whole archive's worth at
 * once and doing that serially over a phone connection takes minutes. Firestore
 * allows 500 operations per batch; 400 leaves room and keeps each request small.
 *
 * @param {Array<{path: string, id: string, data: object}>} writes
 * @param {(done: number, total: number) => void} [onProgress]
 */
export async function writeBatched(writes, onProgress = null) {
  const BATCH_LIMIT = 400;
  let done = 0;

  for (let i = 0; i < writes.length; i += BATCH_LIMIT) {
    const slice = writes.slice(i, i + BATCH_LIMIT);
    const batch = dbMod.writeBatch(db);
    for (const { path, id, data } of slice) {
      batch.set(dbMod.doc(db, path, id), data);
    }
    await batch.commit();
    done += slice.length;
    onProgress?.(done, writes.length);
  }
  return done;
}

/** Deletes many documents in batches. Used to replace a catalog cleanly. */
export async function deleteBatched(path, ids, onProgress = null) {
  const BATCH_LIMIT = 400;
  let done = 0;

  for (let i = 0; i < ids.length; i += BATCH_LIMIT) {
    const slice = ids.slice(i, i + BATCH_LIMIT);
    const batch = dbMod.writeBatch(db);
    for (const id of slice) batch.delete(dbMod.doc(db, path, id));
    await batch.commit();
    done += slice.length;
    onProgress?.(done, ids.length);
  }
  return done;
}

/**
 * Queries a collection.
 * @param {string} path
 * @param {{where?: Array<[string,string,any]>, orderBy?: [string,string], limit?: number}} options
 */
export async function queryDocs(path, options = {}) {
  const parts = [];
  for (const [field, op, value] of options.where ?? []) {
    parts.push(dbMod.where(field, op, value));
  }
  if (options.orderBy) {
    parts.push(dbMod.orderBy(options.orderBy[0], options.orderBy[1] ?? 'asc'));
  }
  if (options.limit) parts.push(dbMod.limit(options.limit));

  const snap = await dbMod.getDocs(dbMod.query(dbMod.collection(db, path), ...parts));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/**
 * Reads a whole collection, a page at a time.
 *
 * `queryDocs` takes a limit and stops there, which is right for a message board
 * and wrong for the photo index: a curated family library is ten thousand
 * pointer records, and a limit of five hundred silently shows five hundred
 * photos as though that were all of them. Paging on the ordered field with
 * `startAfter` is the only way to walk past that without holding a cursor open.
 *
 * @param {string} path
 * @param {{orderBy?: [string,string], pageSize?: number, max?: number}} options
 */
export async function readAll(path, { orderBy = null, pageSize = 1000, max = 50_000 } = {}) {
  const field = orderBy?.[0] ? orderBy[0] : dbMod.documentId();
  const direction = orderBy?.[1] ?? 'asc';

  const out = [];
  let cursor = null;

  while (out.length < max) {
    const parts = [dbMod.orderBy(field, direction), dbMod.limit(pageSize)];
    if (cursor) parts.push(dbMod.startAfter(cursor));

    const snap = await dbMod.getDocs(dbMod.query(dbMod.collection(db, path), ...parts));
    if (snap.empty) break;

    for (const doc of snap.docs) out.push({ id: doc.id, ...doc.data() });
    if (snap.docs.length < pageSize) break;
    cursor = snap.docs[snap.docs.length - 1];
  }
  return out;
}

/**
 * Live subscription. Used sparingly - the message board and calendar benefit
 * from updating while you watch, but the photo grid does not and each listener
 * is an open connection on a battery-powered phone.
 */
export function watchDocs(path, options = {}, callback) {
  const parts = [];
  for (const [field, op, value] of options.where ?? []) {
    parts.push(dbMod.where(field, op, value));
  }
  if (options.orderBy) {
    parts.push(dbMod.orderBy(options.orderBy[0], options.orderBy[1] ?? 'asc'));
  }
  if (options.limit) parts.push(dbMod.limit(options.limit));

  return dbMod.onSnapshot(
    dbMod.query(dbMod.collection(db, path), ...parts),
    (snap) => callback(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    () => callback([]),
  );
}

export function serverTimestamp() {
  return dbMod.serverTimestamp();
}

/**
 * Records the signed-in person in /members.
 *
 * Doubles as the allowlist: the security rules check for a matching member
 * document, so the first person in has to be added to Firestore by hand (see
 * README). After that everyone else is added here on first sign-in.
 */
export async function upsertMember(user, { inviteCode = null } = {}) {
  if (!user) return null;
  const member = {
    uid: user.uid,
    name: user.displayName ?? user.email ?? 'Someone',
    email: user.email ?? null,
    photoURL: user.photoURL ?? null,
    lastSeenAt: new Date().toISOString(),
  };
  // The rules require this on a first write by someone not already in the
  // family - it is the code they are being let in on.
  if (inviteCode) member.inviteCode = inviteCode;

  await setDoc('members', user.uid, member);
  return member;
}

/**
 * Joins the family using an invitation.
 *
 * The order is the whole point. The member document is written **first**, and
 * the invitation is only stamped as used once that has actually succeeded. An
 * earlier design marked the invitation the moment somebody opened the link,
 * which meant anyone who saw a forwarded copy could spend it and lock out the
 * person it was meant for.
 *
 * Failing to stamp it is deliberately not an error: membership is what matters,
 * and a live invitation that has already been used is a far smaller problem
 * than a member who cannot get in.
 */
export async function joinWithInvite(user, code) {
  const member = await upsertMember(user, { inviteCode: code });

  try {
    await setDoc('invitations', code, {
      usedBy: user.uid,
      usedAt: new Date().toISOString(),
    });
  } catch {
    // Already spent, or the rules refused the stamp. They are in either way.
  }
  return member;
}

/** Reads one invitation. Signed-in non-members may do this; listing is family only. */
export async function getInvitation(code) {
  if (!code) return null;
  try {
    return await getDoc('invitations', code);
  } catch {
    return null;
  }
}
