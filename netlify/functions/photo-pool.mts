// Netlify Function (v2 API) backing the internal photo-pool review
// dashboard (src/pages/internal/photo-pool.astro). Lists photos sitting in
// the shared Google Drive "Inbox" folder and lets a curator approve/reject
// them, which just moves the Drive file between folders — Drive's own
// folder location is the state machine, there's no separate database. See
// scripts/pull-approved-photos.mjs for the next step (Approved -> local
// folder -> the existing scripts/curate-photos.mjs pipeline, unchanged).
//
// Gated by Google Sign-In plus the shared staff access model (issue #89): a
// curator authenticates with their own Google account (client-side via
// Google Identity Services), and requireStaff (lib/staff-access.ts) verifies
// the ID token and checks their role in the "photo-pool" module — `view` for
// listing/thumbnails, `review` for approve/reject/description. This replaced
// a one-column "Photo Pool Curators" Google Sheet allow-list (2026-10).
//
// Privacy: the uploader's email never leaves this Function, and their name
// is masked for read-only roles (lib/staff-masking.ts).
import {
  listFiles,
  getFile,
  moveFile,
  updateDescription,
  fetchThumbnail,
} from '../../scripts/lib/google-drive.mjs';
import { requireStaff, logStaffAction, type StaffGrant } from './lib/staff-access';
import { roleHasCapability, type Capability } from './lib/staff-registry';
import { canSeeNames, maskName } from './lib/staff-masking';

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

// A signed-in curator is otherwise trusted to supply any Drive file id they
// want for the thumb/description/decision operations below — without this
// check, that id could point anywhere the service account can read, not
// just an inbox photo. Every operation on a client-supplied id must confirm
// the file is actually a child of the inbox folder first.
function requireInboxMembership(file: { parents?: string[] }, inboxId: string): Response | null {
  if (!file.parents?.includes(inboxId)) {
    return jsonResponse({ error: 'File is not in the review inbox' }, 403);
  }
  return null;
}

// Routine moderation actions are logged after they succeed; a failed audit
// write is reported but doesn't undo a Drive move that already happened.
async function auditBestEffort(staff: StaffGrant, action: string, fileId: string): Promise<void> {
  try {
    await logStaffAction({ actorId: staff.id, action, module: 'photo-pool', detail: { fileId } });
  } catch (err) {
    console.error('Failed to write staff audit log', err);
  }
}

async function handleList(staff: StaffGrant): Promise<Response> {
  const inboxId = process.env.GDRIVE_INBOX_FOLDER_ID;
  if (!inboxId) {
    console.error('Missing GDRIVE_INBOX_FOLDER_ID');
    return jsonResponse({ error: 'Server misconfigured' }, 500);
  }

  try {
    const files = (await listFiles(inboxId)) as DriveFile[];
    return jsonResponse({
      canReview: roleHasCapability('photo-pool', staff.role, 'review'),
      photos: files.map((f) => {
        const uploader = f.lastModifyingUser ?? f.owners?.[0];
        return {
          id: f.id,
          name: f.name,
          takenAt: normalizeExifTime(f.imageMediaMetadata?.time) ?? f.createdTime,
          thumbUrl: `/api/photo-pool/thumb?id=${encodeURIComponent(f.id)}`,
          description: f.description ?? '',
          // Name only, never the email; masked for read-only roles.
          uploader: uploader?.displayName
            ? { name: canSeeNames(staff.role) ? uploader.displayName : maskName(uploader.displayName) }
            : undefined,
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

  const inboxId = process.env.GDRIVE_INBOX_FOLDER_ID;
  if (!inboxId) {
    console.error('Missing GDRIVE_INBOX_FOLDER_ID');
    return jsonResponse({ error: 'Server misconfigured' }, 500);
  }

  try {
    const file = (await getFile(id, 'thumbnailLink,parents')) as DriveFile & { parents?: string[] };
    const authError = requireInboxMembership(file, inboxId);
    if (authError) return authError;
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

async function handleDecision(req: Request, staff: StaffGrant): Promise<Response> {
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
    const file = (await getFile(id, 'parents')) as { parents?: string[] };
    const authError = requireInboxMembership(file, inboxId);
    if (authError) return authError;

    await moveFile(id, inboxId, targetId);
    await auditBestEffort(staff, `photo-pool.${decision}`, id);
    return jsonResponse({ ok: true });
  } catch (err) {
    console.error('Failed to move Drive file', err);
    return jsonResponse({ error: 'Failed to reach Google Drive' }, 502);
  }
}

async function handleDescription(req: Request, staff: StaffGrant): Promise<Response> {
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

  const inboxId = process.env.GDRIVE_INBOX_FOLDER_ID;
  if (!inboxId) {
    console.error('Missing GDRIVE_INBOX_FOLDER_ID');
    return jsonResponse({ error: 'Server misconfigured' }, 500);
  }

  try {
    const file = (await getFile(id, 'parents')) as { parents?: string[] };
    const authError = requireInboxMembership(file, inboxId);
    if (authError) return authError;

    await updateDescription(id, description);
    await auditBestEffort(staff, 'photo-pool.describe', id);
    return jsonResponse({ ok: true });
  } catch (err) {
    console.error('Failed to update Drive file description', err);
    return jsonResponse({ error: 'Failed to reach Google Drive' }, 502);
  }
}

export default async (req: Request): Promise<Response> => {
  const url = new URL(req.url);

  // Pick the route first so each one is gated by the capability it needs:
  // reading is `view`, anything that changes Drive is `review`.
  type Route = { capability: Capability<'photo-pool'>; run: (staff: StaffGrant) => Promise<Response> };
  const route: Route | null =
    url.pathname === '/api/photo-pool/thumb' && req.method === 'GET'
      ? { capability: 'view', run: () => handleThumb(url) }
      : url.pathname === '/api/photo-pool/description' && req.method === 'POST'
        ? { capability: 'review', run: (staff) => handleDescription(req, staff) }
        : url.pathname === '/api/photo-pool' && req.method === 'GET'
          ? { capability: 'view', run: (staff) => handleList(staff) }
          : url.pathname === '/api/photo-pool' && req.method === 'POST'
            ? { capability: 'review', run: (staff) => handleDecision(req, staff) }
            : null;
  if (!route) return jsonResponse({ error: 'Not found' }, 404);

  const auth = await requireStaff(req, 'photo-pool', route.capability);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
  return route.run(auth.staff);
};

export const config = {
  path: ['/api/photo-pool', '/api/photo-pool/thumb', '/api/photo-pool/description'],
};
