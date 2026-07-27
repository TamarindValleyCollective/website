// Netlify Function (v2 API) backing the internal photo-pool review
// dashboard (src/pages/internal/photo-pool.astro). Lists photos sitting in
// the shared Google Drive "Inbox" folder and lets a curator approve/reject
// them, which just moves the Drive file between folders — Drive's own
// folder location is the state machine, there's no separate database. See
// scripts/pull-approved-photos.mjs for the next step (Approved -> local
// folder -> the existing scripts/curate-photos.mjs pipeline, unchanged).
//
// Gated by Google Sign-In: a curator authenticates with their own Google
// account (client-side via Google Identity Services), and this Function
// verifies the resulting ID token itself (google-id-token.mjs) before
// checking the verified email against a live allow-list — a one-column
// Google Sheet (getAllowedEmails in google-drive.mjs), not a static env var,
// so adding a curator is just adding a row. A real Google Group isn't an
// option since curators are a mix of Workspace and personal Gmail accounts;
// group-membership APIs only work within a Workspace domain you administer.
import {
  listFiles,
  getFile,
  moveFile,
  updateDescription,
  fetchThumbnail,
  getAllowedEmails,
} from '../../scripts/lib/google-drive.mjs';
import { verifyGoogleIdToken } from '../../scripts/lib/google-id-token.mjs';

interface DriveImageMetadata {
  time?: string;
  cameraMake?: string;
  cameraModel?: string;
  aperture?: number;
  exposureTime?: number;
  isoSpeed?: number;
  focalLength?: number;
  location?: { latitude: number; longitude: number };
}

interface DriveFile {
  id: string;
  name: string;
  thumbnailLink?: string;
  createdTime: string;
  description?: string;
  owners?: { displayName?: string; emailAddress?: string }[];
  lastModifyingUser?: { displayName?: string; emailAddress?: string };
  imageMediaMetadata?: DriveImageMetadata;
}

// imageMediaMetadata.time is EXIF-formatted ("2015:04:11 15:20:33", colons
// in the date part) rather than RFC 3339 like every other Drive timestamp —
// the Date constructor can't parse it as-is (silently produces "Invalid
// Date"), so convert the date portion's colons to dashes and add a T first.
function normalizeExifTime(time?: string): string | undefined {
  const m = time?.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}:\d{2}:\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}` : undefined;
}

// Mirrors the formatting scripts/curate-photos.mjs applies to its own
// locally-parsed EXIF, so the review dashboard and the published photo
// pages read the same way — Drive's imageMediaMetadata field names differ
// slightly (aperture is already an f-number, not FNumber) but represent the
// same values.
function formatExif(m?: DriveImageMetadata) {
  if (!m) return undefined;
  return {
    camera: m.cameraMake || m.cameraModel ? [m.cameraMake, m.cameraModel].filter(Boolean).join(' ') : undefined,
    aperture: typeof m.aperture === 'number' ? `f/${m.aperture}` : undefined,
    shutterSpeed:
      typeof m.exposureTime === 'number' && m.exposureTime > 0
        ? m.exposureTime >= 1
          ? `${m.exposureTime}s`
          : `1/${Math.round(1 / m.exposureTime)}s`
        : undefined,
    iso: typeof m.isoSpeed === 'number' ? `ISO ${m.isoSpeed}` : undefined,
    focalLength: typeof m.focalLength === 'number' ? `${Math.round(m.focalLength)}mm` : undefined,
    gps: m.location ? { lat: m.location.latitude, lng: m.location.longitude } : undefined,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type AuthResult = { ok: true; email: string } | { ok: false; status: 401 | 403 | 500; error: string };

// Short cache so an admin adding a row to the allow-list Sheet takes effect
// almost immediately, without hitting the Sheets API on every card load in
// an active review session.
const ALLOWED_EMAILS_TTL_MS = 2 * 60 * 1000;
let cachedAllowedEmails: { emails: string[]; expiresAt: number } | null = null;

async function getCachedAllowedEmails(): Promise<string[]> {
  if (cachedAllowedEmails && cachedAllowedEmails.expiresAt > Date.now()) {
    return cachedAllowedEmails.emails;
  }
  const sheetId = process.env.PHOTO_POOL_ALLOWED_EMAILS_SHEET_ID;
  if (!sheetId) throw new Error('Missing PHOTO_POOL_ALLOWED_EMAILS_SHEET_ID');
  const emails = await getAllowedEmails(sheetId);
  cachedAllowedEmails = { emails, expiresAt: Date.now() + ALLOWED_EMAILS_TTL_MS };
  return emails;
}

async function authenticate(req: Request): Promise<AuthResult> {
  const authHeader = req.headers.get('authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return { ok: false, status: 401, error: 'Sign-in required' };

  const clientId = process.env.PUBLIC_GOOGLE_CLIENT_ID;
  if (!clientId) {
    console.error('Missing PUBLIC_GOOGLE_CLIENT_ID');
    return { ok: false, status: 500, error: 'Server misconfigured' };
  }

  let email: string;
  try {
    const payload = await verifyGoogleIdToken(token, { audience: clientId });
    email = String(payload.email).toLowerCase();
  } catch (err) {
    console.error('ID token verification failed', err);
    return { ok: false, status: 401, error: 'Invalid or expired session' };
  }

  try {
    const allowed = await getCachedAllowedEmails();
    if (!allowed.includes(email)) {
      return { ok: false, status: 403, error: 'This Google account is not authorized to review photos' };
    }
  } catch (err) {
    console.error('Failed to check the curator allow-list', err);
    return { ok: false, status: 500, error: 'Server misconfigured' };
  }

  return { ok: true, email };
}

async function handleList(): Promise<Response> {
  const inboxId = process.env.GDRIVE_INBOX_FOLDER_ID;
  if (!inboxId) {
    console.error('Missing GDRIVE_INBOX_FOLDER_ID');
    return jsonResponse({ error: 'Server misconfigured' }, 500);
  }

  try {
    const files = (await listFiles(inboxId)) as DriveFile[];
    return jsonResponse({
      photos: files.map((f) => {
        const uploader = f.lastModifyingUser ?? f.owners?.[0];
        return {
          id: f.id,
          name: f.name,
          takenAt: normalizeExifTime(f.imageMediaMetadata?.time) ?? f.createdTime,
          thumbUrl: `/api/photo-pool/thumb?id=${encodeURIComponent(f.id)}`,
          description: f.description ?? '',
          uploader: uploader ? { name: uploader.displayName, email: uploader.emailAddress } : undefined,
          exif: formatExif(f.imageMediaMetadata),
        };
      }),
    });
  } catch (err) {
    console.error('Failed to list Drive inbox', err);
    return jsonResponse({ error: 'Failed to reach Google Drive' }, 502);
  }
}

async function handleThumb(url: URL): Promise<Response> {
  const id = url.searchParams.get('id');
  if (!id) return jsonResponse({ error: 'id is required' }, 400);

  try {
    const file = (await getFile(id, 'thumbnailLink')) as DriveFile;
    if (!file.thumbnailLink) return jsonResponse({ error: 'No thumbnail available yet' }, 404);

    const thumbRes = await fetchThumbnail(file.thumbnailLink);
    return new Response(thumbRes.body, {
      status: 200,
      headers: { 'content-type': thumbRes.headers.get('content-type') ?? 'image/jpeg' },
    });
  } catch (err) {
    console.error('Failed to fetch thumbnail', err);
    return jsonResponse({ error: 'Failed to reach Google Drive' }, 502);
  }
}

async function handleDecision(req: Request): Promise<Response> {
  let payload: { id?: string; decision?: string };
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }

  const { id, decision } = payload;
  if (!id || (decision !== 'approve' && decision !== 'reject')) {
    return jsonResponse({ error: 'id and decision ("approve" | "reject") are required' }, 400);
  }

  const inboxId = process.env.GDRIVE_INBOX_FOLDER_ID;
  const approvedId = process.env.GDRIVE_APPROVED_FOLDER_ID;
  const rejectedId = process.env.GDRIVE_REJECTED_FOLDER_ID;
  if (!inboxId || !approvedId || !rejectedId) {
    console.error('Missing one of GDRIVE_INBOX_FOLDER_ID / GDRIVE_APPROVED_FOLDER_ID / GDRIVE_REJECTED_FOLDER_ID');
    return jsonResponse({ error: 'Server misconfigured' }, 500);
  }

  const targetId = decision === 'approve' ? approvedId : rejectedId;

  try {
    await moveFile(id, inboxId, targetId);
    return jsonResponse({ ok: true });
  } catch (err) {
    console.error('Failed to move Drive file', err);
    return jsonResponse({ error: 'Failed to reach Google Drive' }, 502);
  }
}

async function handleDescription(req: Request): Promise<Response> {
  let payload: { id?: string; description?: string };
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }

  const { id, description } = payload;
  if (!id || typeof description !== 'string') {
    return jsonResponse({ error: 'id and description (string) are required' }, 400);
  }

  try {
    await updateDescription(id, description);
    return jsonResponse({ ok: true });
  } catch (err) {
    console.error('Failed to update Drive file description', err);
    return jsonResponse({ error: 'Failed to reach Google Drive' }, 502);
  }
}

export default async (req: Request): Promise<Response> => {
  const auth = await authenticate(req);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);

  const url = new URL(req.url);

  if (url.pathname === '/api/photo-pool/thumb' && req.method === 'GET') return handleThumb(url);
  if (url.pathname === '/api/photo-pool/description' && req.method === 'POST') return handleDescription(req);
  if (url.pathname === '/api/photo-pool' && req.method === 'GET') return handleList();
  if (url.pathname === '/api/photo-pool' && req.method === 'POST') return handleDecision(req);

  return jsonResponse({ error: 'Not found' }, 404);
};

export const config = {
  path: ['/api/photo-pool', '/api/photo-pool/thumb', '/api/photo-pool/description'],
};
