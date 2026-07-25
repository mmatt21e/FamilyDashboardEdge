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
 * `drive.readonly` to read what PhotoSync uploaded (files this app did not
 * create, so the narrower drive.file scope cannot see them), plus `drive.file`
 * for the app's own uploads. Asking for full `drive` access would let this app
 * touch every unrelated document in the account, which it has no business
 * doing.
 */

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
].join(' ');

let gisLoaded = null;
let tokenClient = null;
let accessToken = null;
let tokenExpiry = 0;

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
 * Gets a usable Drive token.
 *
 * `interactive: false` tries silently first, which is what happens on every
 * app open after the first. Only when that fails do we show Google's consent
 * prompt, so the family is not asked to approve something every time.
 */
export async function getAccessToken({ interactive = false, clientId } = {}) {
  if (accessToken && Date.now() < tokenExpiry - 60_000) return accessToken;

  await loadGis();
  if (!tokenClient) {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      callback: () => {},
    });
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
      accessToken = response.access_token;
      tokenExpiry = Date.now() + Number(response.expires_in ?? 3600) * 1000;
      finish(resolve, accessToken);
    };

    // Fires for popup_failed_to_open, popup_closed and similar. Without it
    // those cases just hang.
    tokenClient.error_callback = (error) => {
      finish(reject, new Error(`${error?.type ?? 'no_token'}: ${error?.message ?? 'Google declined the request for Drive access.'}`));
    };

    try {
      tokenClient.requestAccessToken({ prompt: interactive ? 'consent' : '' });
    } catch (error) {
      finish(reject, error);
    }
  });
}

export function hasDriveAccess() {
  return Boolean(accessToken) && Date.now() < tokenExpiry;
}

export function forgetDriveAccess() {
  accessToken = null;
  tokenExpiry = 0;
}

async function driveFetch(path, { clientId, ...options } = {}) {
  const token = await getAccessToken({ clientId });
  const response = await fetch(`https://www.googleapis.com/drive/v3/${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers ?? {}) },
  });
  if (response.status === 401) {
    // Token rejected: drop it so the next call re-requests rather than looping.
    forgetDriveAccess();
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

/** Immediate children of a folder. */
export async function listFolder(folderId, { clientId, pageSize = 200, pageToken = null, foldersOnly = false } = {}) {
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

/**
 * Walks the shared folder including one level of per-person subfolders.
 *
 * PhotoSync is normally pointed at a subfolder per phone, so the folder name is
 * how we attribute a photo to a person - see toPointerRecord in files.js.
 * Depth is capped at one level deliberately: a runaway recursion over a Drive
 * with thousands of folders would be slow and expensive on a phone.
 */
export async function listSharedMedia(folderId, { clientId, maxPerFolder = 200 } = {}) {
  const results = [];

  const root = await listFolder(folderId, { clientId, pageSize: maxPerFolder });
  for (const file of root.files) {
    if (file.mimeType !== 'application/vnd.google-apps.folder') {
      results.push({ file, folderName: null });
    }
  }

  const subfolders = root.files.filter(
    (f) => f.mimeType === 'application/vnd.google-apps.folder',
  );

  for (const folder of subfolders) {
    try {
      const page = await listFolder(folder.id, { clientId, pageSize: maxPerFolder });
      for (const file of page.files) {
        if (file.mimeType !== 'application/vnd.google-apps.folder') {
          results.push({ file, folderName: folder.name });
        }
      }
    } catch {
      // One unreadable subfolder must not blank the whole photo grid.
    }
  }

  return results;
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
export async function uploadFile(file, { folderId, clientId, onProgress } = {}) {
  const token = await getAccessToken({ clientId });
  const metadata = { name: file.name, parents: [folderId] };

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

/** Confirms the configured folder exists and is readable, for the Setup screen. */
export async function checkFolder(folderId, { clientId } = {}) {
  const data = await driveFetch(`files/${folderId}?fields=id,name,mimeType`, { clientId });
  if (data.mimeType !== 'application/vnd.google-apps.folder') {
    throw new Error('That ID is a file, not a folder.');
  }
  return data;
}
