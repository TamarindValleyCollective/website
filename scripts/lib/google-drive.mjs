// Shared Google Drive API client for the photo-pool feature (see
// netlify/functions/photo-pool.mts and scripts/pull-approved-photos.mjs).
// Hand-rolled service-account JWT auth via Node's built-in `crypto` rather
// than adding `googleapis`/`google-auth-library` as a dependency — matches
// this repo's preference for small hand-rolled implementations over heavy
// libraries for well-defined tasks (see src/utils/calendar.ts's hand-rolled
// ICS generation). Plain ESM (not TypeScript) so both a Netlify Function
// (bundled by esbuild) and a locally-run script (`node scripts/...`) can
// import it directly.
//
// Requires GDRIVE_SERVICE_ACCOUNT_EMAIL and GDRIVE_SERVICE_ACCOUNT_PRIVATE_KEY
// in the environment (Netlify env vars for the Function, a local .env for
// scripts — see .env.example).

import { createSign } from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
// Sheets access needs its own scope even for a spreadsheet this same service
// account can already see via Drive — used by getAllowedEmails() below (the
// photo-pool curator allow-list), which reuses this file's existing
// JWT-signing/token-cache flow rather than a second, near-identical one.
const SCOPE = 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets.readonly';

let cachedToken = null; // { accessToken, expiresAt }

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function getCredentials() {
  const email = process.env.GDRIVE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GDRIVE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!email || !privateKey) {
    throw new Error('Missing GDRIVE_SERVICE_ACCOUNT_EMAIL or GDRIVE_SERVICE_ACCOUNT_PRIVATE_KEY');
  }
  return { email, privateKey };
}

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.accessToken;
  }

  const { email, privateKey } = getCredentials();
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(
    JSON.stringify({ iss: email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 })
  )}`;

  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer
    .sign(privateKey)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }),
  });

  if (!res.ok) {
    throw new Error(`Google token exchange failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  cachedToken = { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.accessToken;
}

async function driveFetch(path, options = {}) {
  const token = await getAccessToken();
  return fetch(`${DRIVE_API}${path}`, {
    ...options,
    headers: { ...options.headers, Authorization: `Bearer ${token}` },
  });
}

// Fields the review dashboard needs to show per photo without extra
// round-trips: who uploaded it (lastModifyingUser is more reliable across
// external/non-Workspace accounts than owners, which can silently fall back
// to the folder owner when cross-domain ownership transfer is restricted),
// the EXIF/GPS data Drive already extracts server-side on upload, and the
// curator-editable description field.
const LIST_FIELDS =
  'files(id,name,thumbnailLink,createdTime,description,' +
  'owners(displayName,emailAddress),lastModifyingUser(displayName,emailAddress),' +
  'imageMediaMetadata)';

export async function listFiles(folderId, { pageSize = 100 } = {}) {
  const q = encodeURIComponent(`'${folderId}' in parents and mimeType contains 'image/' and trashed = false`);
  const res = await driveFetch(`/files?q=${q}&fields=${encodeURIComponent(LIST_FIELDS)}&pageSize=${pageSize}&orderBy=createdTime`);
  if (!res.ok) throw new Error(`Drive files.list failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.files ?? [];
}

export async function getFile(fileId, fields = 'id,name,thumbnailLink') {
  const res = await driveFetch(`/files/${fileId}?fields=${encodeURIComponent(fields)}`);
  if (!res.ok) throw new Error(`Drive files.get failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function moveFile(fileId, fromFolderId, toFolderId) {
  const res = await driveFetch(
    `/files/${fileId}?addParents=${toFolderId}&removeParents=${fromFolderId}&fields=id,parents`,
    { method: 'PATCH' }
  );
  if (!res.ok) throw new Error(`Drive files.update (move) failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function updateDescription(fileId, description) {
  const res = await driveFetch(`/files/${fileId}?fields=id,description`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ description }),
  });
  if (!res.ok) throw new Error(`Drive files.update (description) failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// thumbnailLink URLs are pre-authorized by Google for anonymous fetch once
// retrieved via an authenticated metadata call — but fall back to attaching
// our own bearer token if that ever turns out not to hold.
export async function fetchThumbnail(thumbnailLink) {
  let res = await fetch(thumbnailLink);
  if (res.status === 401 || res.status === 403) {
    const token = await getAccessToken();
    res = await fetch(thumbnailLink, { headers: { Authorization: `Bearer ${token}` } });
  }
  if (!res.ok) throw new Error(`Thumbnail fetch failed: ${res.status}`);
  return res;
}

export async function downloadFile(fileId) {
  const res = await driveFetch(`/files/${fileId}?alt=media`);
  if (!res.ok) throw new Error(`Drive files.get (download) failed: ${res.status} ${await res.text()}`);
  return res;
}

// Curator allow-list for the photo-pool dashboard: a one-column Sheet
// (email per row, row 1 a header) instead of a static env var, so adding a
// curator is just adding a row — no redeploy. A real Google Group isn't an
// option here since curators are a mix of Workspace and personal Gmail
// accounts, and group-membership APIs only work for accounts under a
// Workspace domain you administer. Share the Sheet with this same service
// account (view access is enough) rather than creating a second one.
export async function getAllowedEmails(spreadsheetId, range = 'Sheet1!A:A') {
  const token = await getAccessToken();
  const res = await fetch(`${SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(range)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Sheets values.get failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const rows = (data.values ?? []).flat();
  return rows
    .slice(1) // header row
    .map((email) => String(email).trim().toLowerCase())
    .filter(Boolean);
}
