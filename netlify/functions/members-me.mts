// Netlify Function (v2 API) behind the member portal (src/pages/members/index.astro):
// what a signed-in member sees and may change about THEIR OWN membership.
//
//   GET  /api/members-me/home     their household(s) and their own details
//   POST /api/members-me/profile  change their mobile number / directory listing
//   POST /api/members-me/privacy  acknowledge the first-login privacy notice
//   GET  /api/members-me/land-documents  their uploaded patta / survey documents and what became of them
//   POST /api/members-me/land-documents  upload one (multipart: file, landType, householdId); read in the background
//
// The privacy boundary is requireMember (lib/member-access.ts): a member is only
// ever mapped to the households they are invited to, and every query below is
// filtered to exactly those household ids. Nothing in this file can return
// another household's data, and the whole register is never loaded.
//
// What goes back: the member's own email and mobile (it is their own data), but
// for everyone else in their household only whether an email / mobile is on file
// (buildHouseholdReview never returns the values). Land records are their own
// household's. Members can edit very little (member-profile.mjs); everything else
// goes through the core team. Until a member has acknowledged the current privacy
// notice (scripts/lib/member-privacy.mjs), /home returns only their name and the
// notice version: no household data is released, and /profile refuses. Every self-service change is written to
// member_audit_log BEFORE it is applied, and refused if that write fails.
import { requireMember } from './lib/member-access';
import { deleteLandDocument, putLandDocument } from './lib/land-doc-storage';
import { readLandPdf } from './lib/land-doc-read';
import { restHeaders } from '../../scripts/lib/supabase.mjs';
import { buildHouseholdReview } from '../../scripts/lib/member-review.mjs';
import { validateProfileEdit, profileAuditDetail } from '../../scripts/lib/member-profile.mjs';
import { PRIVACY_NOTICE_VERSION, privacyNoticeRequired, validateAcceptance } from '../../scripts/lib/member-privacy.mjs';
import { ALLOWED_MIME, LAND_TYPES, MAX_HOUSEHOLD_BYTES, MAX_IMAGE_BYTES, MAX_PDF_BYTES, MAX_UPLOADS_PER_DAY, NOT_A_LAND_PDF, memberSummary } from '../../scripts/lib/member-land-docs.mjs';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store, private' } });
}

function supabaseUrl(): string {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error('Missing SUPABASE_URL');
  return url;
}

async function select(table: string, columns: string, filter: string): Promise<any[]> {
  const res = await fetch(`${supabaseUrl()}/rest/v1/${table}?select=${columns}&${filter}&limit=2000`, { headers: restHeaders() });
  if (!res.ok) throw new Error(`${table} select failed: ${res.status}`);
  return res.json();
}

// PostgREST in-list for ids that came from our own database (uuids), never from the request.
const inList = (ids: string[]) => `(${ids.join(',')})`;

async function handleHome(req: Request): Promise<Response> {
  const auth = await requireMember(req);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
  const { member } = auth;

  // Nothing about the household until the current notice has been acknowledged.
  if (privacyNoticeRequired(member.privacyVersion)) {
    return jsonResponse({ privacyNoticeRequired: true, privacyNoticeVersion: PRIVACY_NOTICE_VERSION, me: { name: member.name } });
  }

  let data;
  try {
    const hh = inList(member.householdIds);
    const [households, memberships, plots, housePattas, notes] = await Promise.all([
      select('member_households', 'id,farm_unit,house_no,cluster,unit_type', `id=in.${hh}`),
      select('member_household_members', 'household_id,person_id,role,can_login', `household_id=in.${hh}`),
      select('member_plots', 'id,household_id,patta_no,reference_no,survey_no,area_hectares,area_acres,settlement,verification', `household_id=in.${hh}`),
      select('member_house_pattas', 'id,household_id,patta_no,reference_no,survey_no,area_sq_ft,settlement,verification', `household_id=in.${hh}`),
      select('member_household_notes', 'household_id,kind', `household_id=in.${hh}`),
    ]);
    const personIds = [...new Set(memberships.map((m: any) => m.person_id))];
    const people = personIds.length ? await select('member_people', 'id,full_name,email,phone,active,directory_visible', `id=in.${inList(personIds)}`) : [];
    data = { households, memberships, plots, housePattas, notes, people };
  } catch (err) {
    console.error('[members-me] failed to load', err);
    return jsonResponse({ error: 'Server error' }, 500);
  }

  const own = data.people.find((p: any) => p.id === member.personId);
  const reviewed = buildHouseholdReview(data);
  return jsonResponse({
    privacyNoticeVersion: PRIVACY_NOTICE_VERSION,
    me: {
      personId: member.personId,
      name: member.name,
      // Their own details, shown back to them. Nobody else's email or mobile is ever sent.
      email: own?.email ?? null,
      phone: own?.phone ?? null,
      directoryVisible: own?.directory_visible ?? true,
    },
    households: reviewed,
  });
}

async function handleProfile(req: Request): Promise<Response> {
  const auth = await requireMember(req);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
  const { member } = auth;
  if (privacyNoticeRequired(member.privacyVersion)) return jsonResponse({ error: 'Please read the privacy notice first.' }, 403);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Nothing to do.' }, 400);
  }
  const checked: { ok: boolean; edit?: Record<string, any>; error?: string } = validateProfileEdit(body);
  if (!checked.ok) return jsonResponse({ error: checked.error }, 400);
  const edit = checked.edit!;

  // Logged before the change, and refused if it can't be, so no change goes unrecorded.
  const log = await fetch(`${supabaseUrl()}/rest/v1/member_audit_log`, {
    method: 'POST',
    headers: restHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify({ actor_person_id: member.personId, action: 'member.profile.update', detail: profileAuditDetail(edit) }),
  }).catch(() => null);
  if (!log || !log.ok) {
    console.error('[members-me] audit log write failed; change refused', log?.status);
    return jsonResponse({ error: 'Could not record the change, so nothing was changed. Try again.' }, 500);
  }

  const columns: Record<string, unknown> = {};
  if ('phone' in edit) columns.phone = edit.phone;
  if ('directoryVisible' in edit) columns.directory_visible = edit.directoryVisible;
  const res = await fetch(`${supabaseUrl()}/rest/v1/member_people?id=eq.${member.personId}`, {
    method: 'PATCH',
    headers: restHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify(columns),
  });
  if (!res.ok) {
    console.error('[members-me] profile update failed', res.status);
    return jsonResponse({ error: 'Server error' }, 500);
  }
  return jsonResponse({ ok: true });
}

async function handlePrivacy(req: Request): Promise<Response> {
  const auth = await requireMember(req);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
  const { member } = auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Nothing to do.' }, 400);
  }
  const checked = validateAcceptance(body);
  if (!checked.ok) return jsonResponse({ error: checked.error }, 409);

  // Same rule as every self-service change: recorded first, refused if it can't be.
  const log = await fetch(`${supabaseUrl()}/rest/v1/member_audit_log`, {
    method: 'POST',
    headers: restHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify({ actor_person_id: member.personId, action: 'member.privacy.accept', detail: { version: checked.version } }),
  }).catch(() => null);
  if (!log || !log.ok) {
    console.error('[members-me] audit log write failed; acknowledgement refused', log?.status);
    return jsonResponse({ error: 'Could not record this. Try again.' }, 500);
  }

  const res = await fetch(`${supabaseUrl()}/rest/v1/member_people?id=eq.${member.personId}`, {
    method: 'PATCH',
    headers: restHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify({ privacy_notice_version: checked.version, privacy_notice_accepted_at: new Date().toISOString() }),
  });
  if (!res.ok) {
    console.error('[members-me] privacy acknowledgement failed', res.status);
    return jsonResponse({ error: 'Server error' }, 500);
  }
  return jsonResponse({ ok: true });
}

// ---- land documents ---------------------------------------------------------

// A document still 'processing' after this long is shown as failed and no longer blocks a re-upload.
const STALE_PROCESSING_MS = 20 * 60 * 1000;

// What the file really is, from its first bytes, never from the name or the browser's claim.
function sniffMime(b: Uint8Array): string | null {
  if (b.length > 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) return 'application/pdf';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  return null;
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');

function documentView(d: any) {
  const stale = d.status === 'processing' && Date.now() - Date.parse(d.created_at) > STALE_PROCESSING_MS;
  const status = stale ? 'failed' : d.status;
  const error = stale ? 'This is taking longer than expected. Please upload it again, or ask the core team.' : d.error;
  return {
    id: d.id,
    householdId: d.household_id,
    landType: d.land_type,
    fileName: d.original_filename,
    uploadedAt: d.created_at,
    status,
    summary: memberSummary(status, Array.isArray(d.items) ? d.items : [], error),
  };
}

async function handleLandDocuments(req: Request): Promise<Response> {
  const auth = await requireMember(req);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
  const { member } = auth;
  if (privacyNoticeRequired(member.privacyVersion)) return jsonResponse({ error: 'Please read the privacy notice first.' }, 403);

  if (req.method === 'GET') {
    try {
      const docs = await select('member_land_documents', 'id,household_id,land_type,original_filename,status,error,items,created_at', `household_id=in.${inList(member.householdIds)}&order=created_at.desc`);
      return jsonResponse({ documents: docs.slice(0, 50).map(documentView) });
    } catch (err) {
      console.error('[members-me] land documents load failed', err);
      return jsonResponse({ error: 'Server error' }, 500);
    }
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonResponse({ error: 'Nothing to do.' }, 400);
  }
  const file = form.get('file');
  const landType = String(form.get('landType') ?? '');
  const householdId = String(form.get('householdId') ?? '') || (member.householdIds.length === 1 ? member.householdIds[0] : '');
  if (!(file instanceof File) || file.size === 0) return jsonResponse({ error: 'Choose a file to upload.' }, 400);
  if (!LAND_TYPES.includes(landType)) return jsonResponse({ error: 'Say whether this is for your farm land or your house plot.' }, 400);
  // Only their own households: the id came from the request, so it is checked against the session.
  if (!member.householdIds.includes(householdId)) return jsonResponse({ error: 'Choose which unit this is for.' }, 400);
  // Refuse the biggest files before reading them. Anything over the larger limit can't be a land document.
  if (file.size > MAX_IMAGE_BYTES) return jsonResponse({ error: 'That file is too large. A patta PDF is under 1 MB and a photo under 3 MB.' }, 413);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = sniffMime(bytes);
  if (!mime || !ALLOWED_MIME.includes(mime)) return jsonResponse({ error: 'Upload a PDF (best), or a JPEG or PNG photo.' }, 415);
  if (mime === 'application/pdf' && file.size > MAX_PDF_BYTES) return jsonResponse({ error: NOT_A_LAND_PDF }, 413);
  // A PDF must match one of the two e-Services layouts. The reader is local and takes milliseconds,
  // so anything else is refused here and never stored. Photos and scans can't be read; they are kept
  // for the core team.
  if (mime === 'application/pdf' && !(await readLandPdf(bytes))) return jsonResponse({ error: NOT_A_LAND_PDF }, 422);
  const sha256 = hex(await crypto.subtle.digest('SHA-256', bytes));

  try {
    const all = await select('member_land_documents', 'id,sha256,status,created_at,size_bytes', `household_id=eq.${householdId}`);
    const recent = all.filter((d: any) => Date.parse(d.created_at) > Date.now() - 24 * 3600 * 1000);
    const storedBytes = all.filter((d: any) => d.status !== 'failed').reduce((n: number, d: any) => n + (d.size_bytes ?? 0), 0);
    if (storedBytes + file.size > MAX_HOUSEHOLD_BYTES) return jsonResponse({ error: 'Your unit has reached its document storage limit. Please ask the core team.' }, 413);
    if (recent.length >= MAX_UPLOADS_PER_DAY) return jsonResponse({ error: 'You have uploaded a lot of documents today. Please try again tomorrow, or ask the core team.' }, 429);
    const same = recent.find((d: any) => d.sha256 === sha256 && d.status !== 'failed' && !(d.status === 'processing' && Date.now() - Date.parse(d.created_at) > STALE_PROCESSING_MS));
    if (same) return jsonResponse({ ok: true, duplicate: true, documentId: same.id });

    const documentId = crypto.randomUUID();
    const storagePath = `${householdId}/${documentId}.${mime === 'application/pdf' ? 'pdf' : mime === 'image/png' ? 'png' : 'jpg'}`;

    // Recorded first, refused if it can't be (same rule as every self-service change).
    const log = await fetch(`${supabaseUrl()}/rest/v1/member_audit_log`, {
      method: 'POST',
      headers: restHeaders({ Prefer: 'return=minimal' }),
      body: JSON.stringify({ actor_person_id: member.personId, action: 'member.land.upload', detail: { documentId, landType, mime } }),
    }).catch(() => null);
    if (!log || !log.ok) {
      console.error('[members-me] audit log write failed; upload refused', log?.status);
      return jsonResponse({ error: 'Could not record the upload, so nothing was saved. Try again.' }, 500);
    }

    try {
      await putLandDocument(storagePath, bytes, mime);
    } catch (err) {
      console.error('[members-me] storage upload failed', err);
      return jsonResponse({ error: 'Server error' }, 500);
    }
    const inserted = await fetch(`${supabaseUrl()}/rest/v1/member_land_documents`, {
      method: 'POST',
      headers: restHeaders({ Prefer: 'return=minimal' }),
      body: JSON.stringify({
        id: documentId,
        household_id: householdId,
        uploaded_by_person_id: member.personId,
        land_type: landType,
        storage_path: storagePath,
        original_filename: file.name.slice(0, 200) || null,
        mime_type: mime,
        size_bytes: file.size,
        sha256,
      }),
    });
    if (!inserted.ok) {
      console.error('[members-me] land document insert failed', inserted.status);
      await deleteLandDocument(storagePath).catch(() => null); // don't leave a file with no record
      return jsonResponse({ error: 'Server error' }, 500);
    }

    // Hand over to the background reader. It answers 202 straight away. If this call is lost the
    // row just stays 'processing' and shows as failed after STALE_PROCESSING_MS.
    const base = process.env.URL ?? new URL(req.url).origin;
    await fetch(`${base}/.netlify/functions/members-land-extract-background`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ documentId }),
    }).catch((err) => console.error('[members-me] could not start the land document reader', err));

    return jsonResponse({ ok: true, documentId });
  } catch (err) {
    console.error('[members-me] land document upload failed', err);
    return jsonResponse({ error: 'Server error' }, 500);
  }
}

export default async (req: Request): Promise<Response> => {
  const { pathname } = new URL(req.url);
  if (pathname === '/api/members-me/home' && req.method === 'GET') return handleHome(req);
  if (pathname === '/api/members-me/profile' && req.method === 'POST') return handleProfile(req);
  if (pathname === '/api/members-me/privacy' && req.method === 'POST') return handlePrivacy(req);
  if (pathname === '/api/members-me/land-documents' && (req.method === 'GET' || req.method === 'POST')) return handleLandDocuments(req);
  return jsonResponse({ error: 'Not found' }, 404);
};

export const config = { path: ['/api/members-me/home', '/api/members-me/profile', '/api/members-me/privacy', '/api/members-me/land-documents'] };
