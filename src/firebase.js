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
// /calendar_events, /lists, /list_items. No tenant id anywhere - this app is
// deliberately single-family and adding one would be dead weight.

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
export async function upsertMember(user) {
  if (!user) return null;
  const member = {
    uid: user.uid,
    name: user.displayName ?? user.email ?? 'Someone',
    email: user.email ?? null,
    photoURL: user.photoURL ?? null,
    lastSeenAt: new Date().toISOString(),
  };
  await setDoc('members', user.uid, member);
  return member;
}
