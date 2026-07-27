/**
 * The shared Google Drive folder.
 *
 * PhotoSync on each phone uploads into this folder; the app reads from it and
 * can also upload directly. Firestore only ever holds pointer records.
 *
 * WHY DRIVE ACCESS IS SEPARATE FROM SIGN-IN
 * -----------------------------------------
 * Firebase's Google sign-in can hand back a Drive access token, but it is valid
 * for an hour and Firebase will not refresh it - so the photo grid breaks an
 * hour into any session and the only fix is signing out and in again. Google
 * Identity Services can silently re-issue a token instead, so identity comes
 * from Firebase and Drive access comes from here. Two mechanisms, but the app
 * stops randomly failing.
 *
 * SCOPES
 * ------
 * Full `drive` access, granted DELIBERATELY - the family owner asked for it by
 * name after hearing the trade. The app started on the narrow pair
 * (`drive.readonly` + `drive.file`), which could read everything but move only
 * its own uploads; that left every video PhotoSync ever filed with the photos
 * permanently stuck there, and the owner chose the broader grant over dragging
 * files by hand forever.
 *
 * The scope is a capability, not a behaviour: the code still touches nothing
 * outside the configured shared folder, and this repository is the audit trail
 * for that claim. Anyone in the family can withdraw the grant at
 * myaccount.google.com/permissions at any time.
 */

import { cacheSet, cacheDelete } from './local-cache.js';

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const SCOPES = 'https://www.googleapis.com/auth/drive';

let gisLoaded = null;
let accessToken = null;
let tokenExpiry = 0;

// One client per scope set. Drive is the everyday one; the Gmail send scope
// is requested ONLY at the moment somebody sends an invitation, so granting
// the app photos never quietly grants it email as well.
const tokenClients = new Map();
const scopedTokens = new Map();

/**
 * Which Google account Drive tokens should come from.
 *
 * A family phone routinely holds several Google sessions - one real one had
 * four. A silent token request with no hint fails on such a phone every time,
 * because Google cannot guess which account is meant and 'none' forbids it
 * from asking; the app then fell back to the interactive chooser, which is
 * the "it asks me every time I open Photos" experience. Telling Google which
 * account - the one already signed in to the app - lets the silent path
 * actually be silent.
 */
let accountHint = null;

export function setAccountHint(email) {
  accountHint = email || null;
}

const GIS_LOAD_TIMEOUT_MS = 15_000;
const TOKEN_TIMEOUT_MS = 20_000;

function loadGis() {
  if (gisLoaded) return gisLoaded;
  gisLoaded = new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve();

    const script = document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;

    // A blocked or unreachable accounts.google.com leaves onload/onerror
    // silent, so without this the whole photo view waits forever.
    const timer = setTimeout(() => {
      gisLoaded = null;
      reject(new Error('token_timeout: Google sign-in did not load. It may be blocked by an ad blocker, VPN or network filter.'));
    }, GIS_LOAD_TIMEOUT_MS);

    script.onload = () => { clearTimeout(timer); resolve(); };
    script.onerror = () => {
      clearTimeout(timer);
      gisLoaded = null;
      reject(new Error('token_timeout: Could not load Google sign-in.'));
    };
    document.head.appendChild(script);
  });
  return gisLoaded;
}

/**
 * Where the token is kept between page loads.
 *
 * A Drive token lasts an hour. Holding it only in a variable meant every cold
 * start asked Google for a new one, and a home-screen app is nothing but cold
 * starts - iOS discards it the moment you switch away, so opening Photos twice
 * in an afternoon meant two trips through Google.
 *
 * sessionStorage rather than localStorage: it is a bearer token for the
 * family's Drive, and it should not outlive the tab that fetched it. An hour is
 * all it is good for anyway.
 */
const TOKEN_KEY = 'fd.drive.token';

function rememberToken(token, expiry) {
  accessToken = token;
  tokenExpiry = expiry;
  try {
    sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ token, expiry, scope: SCOPES }));
  } catch { /* private mode; it just re-requests next time */ }
  // Mirrored into IndexedDB for ONE reader: the service worker, which streams
  // video by attaching this token to range requests and cannot see session
  // storage. Expiry-checked on that side, and cleared with the rest on
  // forget - the mirror never outlives the token's hour of usefulness.
  void cacheSet('drive-token', { token, expiry });
}

function recallToken() {
  if (accessToken) return;
  try {
    const saved = JSON.parse(sessionStorage.getItem(TOKEN_KEY) ?? 'null');
    // A token minted under a different scope set is not this token: after the
    // scopes widened, a cached narrow token would still read fine and then
    // fail every move with a 403 for the rest of its hour.
    if (saved?.token && saved.expiry > Date.now() && saved.scope === SCOPES) {
      accessToken = saved.token;
      tokenExpiry = saved.expiry;
    }
  } catch { /* nothing worth recovering */ }
}

/**
 * Gets a usable Drive token.
 *
 * Two attempts, and the order is the whole point. The first asks Google for a
 * token with `prompt: 'none'` - genuinely silent, no window, no account
 * chooser, and it fails outright rather than asking anything. Only if that
 * fails does the interactive one run.
 *
 * The previous version passed `prompt: ''`, which is not "silent" but "Google
 * decides" - and Google frequently decides to show an account chooser, which is
 * why opening Photos meant clicking through Google every single time.
 */
export async function getAccessToken({ interactive = false, clientId } = {}) {
  recallToken();
  const now = Date.now();
  if (accessToken && now < tokenExpiry - 60_000) {
    // Renew ahead of expiry, while the old token still works - and silently
    // ONLY: `prompt: 'none'` either succeeds with no window or fails without
    // asking, so a background renewal can never put Google UI on screen at a
    // random moment. If it fails, the visible path below handles real expiry.
    if (now > tokenExpiry - TOKEN_RENEW_AHEAD_MS) {
      void singleFlight(SCOPES, () => requestToken({ clientId, prompt: 'none' }))
        .catch(() => { /* the current token still works */ });
    }
    return accessToken;
  }

  return singleFlight(SCOPES, async () => {
    // A caller that queued behind a renewal finds its token already here.
    if (accessToken && Date.now() < tokenExpiry - 60_000) return accessToken;

    if (!interactive) {
      try {
        return await requestToken({ clientId, prompt: 'none' });
      } catch {
        // Needs a human: no Google session, no prior grant, or Safari blocking
        // the cookie the silent path relies on. Fall through and ask properly.
      }
    }
    return requestToken({ clientId, prompt: interactive ? 'consent' : '' });
  });
}

/** How long before expiry the background renewal starts. */
const TOKEN_RENEW_AHEAD_MS = 5 * 60_000;

/**
 * One token acquisition per scope at a time.
 *
 * requestToken() reassigns the shared token client's callback, so two
 * overlapping acquisitions meant the second silently disconnected the first,
 * which could then only settle by its 20-second timeout - surfacing as
 * "Google never answered". The overlap is not hypothetical: doLoad() fires a
 * prewarm request while the scan's own driveFetch calls ask too. Concurrent
 * callers now share one in-flight promise per scope.
 */
const tokenRequests = new Map();

function singleFlight(scope, start) {
  let pending = tokenRequests.get(scope);
  if (!pending) {
    pending = start().finally(() => tokenRequests.delete(scope));
    tokenRequests.set(scope, pending);
  }
  return pending;
}

async function requestToken({ clientId, prompt, scope = SCOPES }) {
  await loadGis();
  let tokenClient = tokenClients.get(scope);
  if (!tokenClient) {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope,
      callback: () => {},
    });
    tokenClients.set(scope, tokenClient);
  }

  // THE HANG THIS FIXES.
  //
  // requestAccessToken() is fire-and-forget: it invokes a callback rather than
  // returning a promise. When Google declines outright - the origin is not in
  // the OAuth client's Authorised JavaScript origins, or the signed-in account
  // is not a test user on an unpublished app - NEITHER callback fires. The
  // promise never settles, so the Photos view sat on "Loading photos..."
  // indefinitely with no error anywhere.
  //
  // So: wire error_callback as well as callback, and put a hard timeout over
  // both. Whatever happens, this promise settles.
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      finish(reject, new Error(
        'no_token: Google never answered the request for Drive access. Usually the site’s origin is missing from the OAuth client, or this account is not on the test-user list.',
      ));
    }, TOKEN_TIMEOUT_MS);

    tokenClient.callback = (response) => {
      if (response?.error) {
        return finish(reject, new Error(`${response.error}: ${response.error_description ?? 'Google refused the request.'}`));
      }
      const expiry = Date.now() + Number(response.expires_in ?? 3600) * 1000;
      if (scope === SCOPES) {
        // Only the Drive token goes into the persistent caches - the mirror in
        // IndexedDB exists for the streaming worker, which has no business
        // holding a token that can send mail.
        rememberToken(response.access_token, expiry);
      } else {
        scopedTokens.set(scope, { token: response.access_token, expiry });
      }
      finish(resolve, response.access_token);
    };

    // Fires for popup_failed_to_open, popup_closed and similar. Without it
    // those cases just hang.
    tokenClient.error_callback = (error) => {
      finish(reject, new Error(`${error?.type ?? 'no_token'}: ${error?.message ?? 'Google declined the request for Drive access.'}`));
    };

    try {
      tokenClient.requestAccessToken({
        prompt,
        ...(accountHint ? { hint: accountHint } : {}),
      });
    } catch (error) {
      finish(reject, error);
    }
  });
}

/**
 * A token for a scope other than the everyday Drive one.
 *
 * Cached in memory for its hour and nowhere else: the only current caller is
 * sending an invitation email, which is rare enough that re-consenting after
 * a page reload is fine and persisting a mail-capable token is not.
 */
export async function getScopedToken({ clientId, scope }) {
  const cached = scopedTokens.get(scope);
  if (cached && Date.now() < cached.expiry - 60_000) return cached.token;

  return singleFlight(scope, async () => {
    try {
      return await requestToken({ clientId, prompt: 'none', scope });
    } catch {
      // First time: Google needs to show the consent for this scope.
      return requestToken({ clientId, prompt: '', scope });
    }
  });
}

export function hasDriveAccess() {
  recallToken();
  return Boolean(accessToken) && Date.now() < tokenExpiry;
}

export function forgetDriveAccess() {
  accessToken = null;
  tokenExpiry = 0;
  try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* nothing to do */ }
  void cacheDelete('drive-token');
}

/**
 * One Drive request, renewing the token once if it is refused.
 *
 * The retry matters more than it looks. Scanning a nested archive is hundreds
 * of requests rather than the handful it used to be, so the odds of one of them
 * coming back 401 - an expiry landing mid-scan, or a transient refusal - went
 * up by the same multiple. Without a retry, a single blip threw the token away
 * and the next thing anyone did asked Google for permission again. That is the
 * "it prompts me every time I open Photos" behaviour.
 */
async function driveFetch(path, { clientId, retried = false, ...options } = {}) {
  const token = await getAccessToken({ clientId });
  const response = await fetch(`https://www.googleapis.com/drive/v3/${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers ?? {}) },
  });

  if (response.status === 401) {
    forgetDriveAccess();
    // Once only, and silently. If the second attempt is refused too, this is a
    // real expiry rather than a blip and the caller should hear about it.
    if (!retried) return driveFetch(path, { clientId, retried: true, ...options });
    throw new Error('Drive access expired. Pull down to refresh.');
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    // Carry the status and raw body so interpretDriveFailure() can tell
    // "Drive API not enabled" apart from "folder not found".
    const error = new Error(`Drive error ${response.status}: ${detail.slice(0, 300)}`);
    error.status = response.status;
    error.body = detail;
    throw error;
  }
  return response.json();
}

/** The metadata the app needs. Requested explicitly - Drive returns very little by default. */
const FILE_FIELDS = [
  'id', 'name', 'mimeType', 'size', 'createdTime', 'modifiedTime',
  'thumbnailLink', 'parents',
  'imageMediaMetadata(width,height,time)',
  'videoMediaMetadata(width,height,durationMillis)',
].join(',');

/** Immediate children of a folder. 1000 is the largest page Drive will return. */
export async function listFolder(folderId, { clientId, pageSize = 1000, pageToken = null, foldersOnly = false } = {}) {
  const clauses = [`'${folderId}' in parents`, 'trashed = false'];
  if (foldersOnly) clauses.push("mimeType = 'application/vnd.google-apps.folder'");

  const params = new URLSearchParams({
    q: clauses.join(' and '),
    fields: `nextPageToken, files(${FILE_FIELDS})`,
    pageSize: String(pageSize),
    orderBy: 'createdTime desc',
  });
  if (pageToken) params.set('pageToken', pageToken);

  const data = await driveFetch(`files?${params}`, { clientId });
  return { files: data.files ?? [], nextPageToken: data.nextPageToken ?? null };
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';

/**
 * Walks the whole shared folder.
 *
 * This used to stop after one level of subfolders and take the first 200 files
 * from each, which was fine for the case it was written for - PhotoSync
 * dropping photos into a folder per phone - and silently wrong for the case
 * that actually turned up. An organised archive is nested by year and month:
 *
 *     Family photos/01_Timeline/2015/2015-09/…
 *
 * The photos are three levels down. A one-level walk sees `01_Timeline`, lists
 * the *year folders* inside it, finds no images, and reports an empty library.
 * Not an error - an empty grid, which is far worse, because nothing tells you
 * the scan gave up.
 *
 * So it now walks breadth-first with real pagination, and the limits are on
 * total work rather than on depth: depth is a property of how somebody chose to
 * organise their photos, and guessing it wrong loses the lot. Breadth-first
 * matters because if a limit is hit, what has been collected is the shallow,
 * most-organised part of the tree rather than an arbitrary slice.
 *
 * Each file comes back with the full `path` of folder names above it, relative
 * to the shared root - `['Dashboard_Image_Storage', 'Jocey', '2026-07']`. Just
 * the immediate folder is not enough: in a nested archive that is "2015-09",
 * which is a good thing to filter by and a useless answer to whose photo it is.
 * files.js decides what the path means.
 *
 * @returns {Promise<{items: Array, folders: number, truncated: boolean}>}
 */
export async function listSharedMedia(folderId, { clientId, ...options } = {}) {
  return walkFolders(
    folderId,
    (id, pageToken) => listFolder(id, { clientId, pageToken }),
    options,
  );
}

/**
 * The walk itself, with fetching passed in.
 *
 * Separated from `listSharedMedia` so it can be tested against a made-up folder
 * tree rather than only against a real Drive. This is code whose bugs are
 * silent - a walk that quietly stops early returns an empty grid, not an error
 * - so being able to point it at a tree with known contents and check the count
 * is worth the extra function.
 *
 * @param {(id: string, pageToken: string|null) => Promise<{files: Array, nextPageToken: string|null}>} listPage
 */
export async function walkFolders(folderId, listPage, {
  maxFiles = 20_000,
  maxFolders = 600,
  concurrency = 6,
  onProgress = null,
} = {}) {
  const items = [];
  const queue = [{ id: folderId, path: [], isRoot: true }];
  const seen = new Set([folderId]);
  let folders = 0;
  let active = 0;
  let truncated = false;
  let rootError = null;

  // Several folders are read at once. This is where the scan's time actually
  // goes: an archive is hundreds of folders, each one a round trip, and doing
  // them strictly in sequence took eighteen seconds at fast-connection latency
  // and over a minute on a phone. The requests are independent - the only
  // shared state is the queue and the counters, and JavaScript runs the bits
  // between awaits atomically - so six in flight cuts the wall clock by nearly
  // six with no change to what is collected. Six, not sixty, because Drive
  // rate-limits around ten requests a second per user and a throttled scan
  // with retries is slower than a polite one.
  await new Promise((done) => {
    const pump = () => {
      while (!truncated && queue.length && active < concurrency) {
        if (folders >= maxFolders) { truncated = true; break; }
        const folder = queue.shift();
        folders += 1;
        active += 1;
        void readFolder(folder).finally(() => { active -= 1; pump(); });
      }
      if (active === 0) done();
    };

    const readFolder = async (folder) => {
      let pageToken = null;
      try {
        do {
          const page = await listPage(folder.id, pageToken);

          for (const file of page.files ?? []) {
            if (file.mimeType === FOLDER_MIME) {
              // A Drive file can have more than one parent, so a plain walk
              // can visit the same folder twice and duplicate everything
              // under it.
              if (seen.has(file.id)) continue;
              seen.add(file.id);
              // The whole path is carried down, so a photo knows every folder
              // above it and not merely the one it sits in.
              queue.push({ id: file.id, path: [...folder.path, file.name] });
              continue;
            }

            // Checked here, at the point of adding, rather than between
            // folders. Testing it only between folders missed the case where
            // a single folder overran the limit and then emptied the queue -
            // the scan stopped short and reported a complete library.
            if (items.length >= maxFiles) { truncated = true; break; }
            items.push({ file, path: folder.path });
          }

          pageToken = page.nextPageToken;
          onProgress?.({ files: items.length, folders, scanning: folder.path.at(-1) ?? null });
          // Newly discovered subfolders can start on idle workers now, rather
          // than waiting for this folder's remaining pages.
          pump();
        } while (pageToken && !truncated);
      } catch (error) {
        // One unreadable SUBFOLDER must not blank the whole photo grid. The
        // ROOT is different: if the shared folder itself cannot be read -
        // expired token, revoked access, wrong id - then nothing could be
        // read, and reporting it as an empty library is a lie with teeth.
        // The caller believes it, shows "No photos yet", and overwrites the
        // device's snapshot with the emptiness, wiping a working screen over
        // an auth blip. An unreadable root is a failure and is thrown as one.
        if (folder.isRoot) rootError = error;
      }
    };

    pump();
  });

  if (rootError) {
    // Some items may still have arrived if the root failed mid-pagination;
    // keep them and mark the scan short rather than discarding real work.
    if (!items.length) throw rootError;
    truncated = true;
  }

  // Anything still queued when we stopped is a folder never opened.
  if (queue.length) truncated = true;

  return { items, folders, truncated };
}

/** A URL the app can show an image from. Needs the token, so images are fetched as blobs. */
export async function fetchFileBlobUrl(fileId, { clientId } = {}) {
  const token = await getAccessToken({ clientId });
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok) throw new Error(`Could not load file (${response.status})`);
  return URL.createObjectURL(await response.blob());
}

/** Uploads a file from the app into the shared folder. */
/**
 * Finds a folder by name inside another, or makes it.
 *
 * Drive has no "create if missing" and no path lookup - a folder is just a file
 * whose name is not unique, so this is a search followed by a create. The
 * search comes first every time, because two people adding photos on the same
 * afternoon must land in the same folder rather than each making their own copy
 * of "2026-07".
 */
const folderCache = new Map();

export async function ensureFolder(parentId, name, { clientId } = {}) {
  const key = `${parentId}/${name.toLowerCase()}`;
  if (folderCache.has(key)) return folderCache.get(key);

  // Drive's query language is single-quoted, so a folder called "Erica's" would
  // otherwise close the string and break the query.
  const safe = String(name).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const params = new URLSearchParams({
    q: [
      `'${parentId}' in parents`,
      `name = '${safe}'`,
      `mimeType = '${FOLDER_MIME}'`,
      'trashed = false',
    ].join(' and '),
    fields: 'files(id,name)',
    pageSize: '1',
  });

  const found = await driveFetch(`files?${params}`, { clientId });
  if (found.files?.length) {
    folderCache.set(key, found.files[0].id);
    return found.files[0].id;
  }

  const created = await driveFetch('files?fields=id', {
    clientId,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  });
  folderCache.set(key, created.id);
  return created.id;
}

/** Walks a list of folder names from the root, creating any that are missing. */
export async function ensureFolderPath(rootId, segments, { clientId } = {}) {
  let parent = rootId;
  for (const segment of segments ?? []) {
    if (!segment) continue;
    parent = await ensureFolder(parent, segment, { clientId });
  }
  return parent;
}

/** Forgets the folder ids, for when the shared folder is changed or reset. */
export function forgetFolderCache() {
  folderCache.clear();
}

/**
 * Uploads a file into the shared folder.
 *
 * `path` is a list of folder names under the shared root, created on demand.
 * Without it everything piles into the root, and a shared folder full of loose
 * files is one nobody can make sense of later - which defeats the point of
 * keeping the archive as plain Drive folders at all.
 */
export async function uploadFile(file, { folderId, clientId, onProgress, path = null } = {}) {
  const token = await getAccessToken({ clientId });

  const parent = path?.length
    ? await ensureFolderPath(folderId, path, { clientId })
    : folderId;

  const metadata = { name: file.name, parents: [parent] };

  const body = new FormData();
  body.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  body.append('file', file);

  // XHR rather than fetch: fetch cannot report upload progress, and uploading a
  // video over a phone connection with no feedback feels broken.
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(
      'POST',
      `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=${encodeURIComponent(FILE_FIELDS)}`,
    );
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); }
        catch { reject(new Error('Upload succeeded but the reply was unreadable.')); }
      } else {
        reject(new Error(`Upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error('Upload failed. Check your connection.'));
    xhr.send(body);
  });
}

/**
 * A fresh thumbnailLink for one file.
 *
 * Drive's thumbnail links expire after a few hours. Re-asking for the link is
 * a single metadata read - the right response to a tile whose link has died
 * after the scan finished, where the only other option is downloading the
 * original.
 */
export async function refreshThumbnailLink(fileId, { clientId } = {}) {
  const data = await driveFetch(`files/${fileId}?fields=thumbnailLink`, { clientId });
  return data.thumbnailLink ?? null;
}

/**
 * Moves a file between folders.
 *
 * Under the full drive scope this works on anything in the shared folder,
 * whoever uploaded it. A 403 can still happen - a file owned by an account
 * that has since left the folder, say - so callers should treat one as "skip
 * and report", never as something to retry into.
 */
export async function moveFile(fileId, { fromId, toId, clientId } = {}) {
  const params = new URLSearchParams({
    addParents: toId, removeParents: fromId, fields: 'id,parents',
  });
  return driveFetch(`files/${fileId}?${params}`, {
    clientId,
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
}

/** Confirms the configured folder exists and is readable, for the Setup screen. */
export async function checkFolder(folderId, { clientId } = {}) {
  const data = await driveFetch(`files/${folderId}?fields=id,name,mimeType`, { clientId });
  if (data.mimeType !== 'application/vnd.google-apps.folder') {
    throw new Error('That ID is a file, not a folder.');
  }
  return data;
}
