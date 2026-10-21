// Netlify Function (v2 API) behind the member portal (src/pages/members/index.astro):
// what a signed-in member sees and may change about THEIR OWN membership.
//
//   GET  /api/members-me/home     their household(s) and their own details
//   POST /api/members-me/profile  change their mobile number / directory listing
//   POST /api/members-me/privacy  acknowledge the first-login privacy notice
//   GET  /api/members-me/land-documents  their uploaded patta / survey documents and what became of them
//   POST /api/members-me/land-documents  upload one (multipart: file, landType, householdId); read in the background
//   GET  /api/members-me/directory     the other members: name, farm plot, cluster and their approved story (opt-out; never contact details)
//   POST /api/members-me/unit-story / unit-story-submit / unit-story-photo(-remove), GET unit-story / unit-photo  the unit's shared story
//   POST /api/members-me/story-review  suggestions on spelling, grammar, tone and house style (a model, plus fixed privacy checks); edits nothing
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
import { backfillLandShapes } from './lib/land-shape-backfill';
import { deleteLandDocument, landShapeKey, loadLandShapes, putLandDocument, signedLandDocumentUrl } from './lib/land-doc-storage';
import { readLandPdf, readLandShape } from './lib/land-doc-read';
import { withShapeResult } from '../../scripts/lib/land-shape.mjs';
import { restHeaders } from '../../scripts/lib/supabase.mjs';
import { buildHouseholdReview } from '../../scripts/lib/member-review.mjs';
import { validateProfileEdit, profileAuditDetail } from '../../scripts/lib/member-profile.mjs';
import { PRIVACY_NOTICE_VERSION, privacyNoticeRequired, validateAcceptance } from '../../scripts/lib/member-privacy.mjs';
import { callAnthropic } from './lib/anthropic';
import { ACCOMMODATION_UNITS } from '../../scripts/lib/accommodation.mjs';
import { availabilityFor, canCancelStay, checkOut, validateStayDates, validateStayRequest } from '../../scripts/lib/member-stay.mjs';
import { createBooking, deleteBooking, getBookingById, getNotice } from '../../scripts/lib/accommodation-db.mjs';
import { sendStayCancellation } from './lib/stay-notify';
import { sendMemberStayBooked, sendMemberStayCancelled } from './lib/member-stay-notify';
import { checkDailyCap } from './lib/rate-limit';
import { buildUnitDirectory } from '../../scripts/lib/member-directory.mjs';
import { MAX_FULL_BYTES, MAX_SQUARE_BYTES, isUploadedPhoto, validatePhotoPair } from '../../scripts/lib/member-photo.mjs';
import { deleteMemberPhoto, getMemberPhoto, putMemberPhoto } from './lib/member-photo-storage';
import { assessUnitSubmission } from './lib/story-risk';
import { REVIEW_SYSTEM, localChecks, parseSuggestions, reviewPrompt, validateDraft } from '../../scripts/lib/member-story.mjs';
import { MAX_PHOTOS, addPhoto, draftColumns, draftState, mergeDraftEdit, unitPhotoAccess, unitStoryView, validateUnitSave, validateUnitSubmit } from '../../scripts/lib/member-unit-story.mjs';
import { ALLOWED_MIME, LAND_TYPES, MAX_HOUSEHOLD_BYTES, MAX_IMAGE_BYTES, MAX_PDF_BYTES, MAX_UPLOADS_PER_DAY, NOT_A_LAND_PDF, NOT_A_SKETCH, SKETCH_IS_A_PATTA, SKETCH_NOT_YOURS, WRONG_CARD, documentsReplacedBy, landDocumentLinks, landTypeMismatch, memberSummary, normalizeExtraction, normalizeSurveyNo, surveyKey, surveyOnRegister } from '../../scripts/lib/member-land-docs.mjs';

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
  let landDocs: any[] = [];
  try {
    const hh = inList(member.householdIds);
    const [households, memberships, plots, housePattas, notes, docRows] = await Promise.all([
      select('member_households', 'id,farm_unit,house_no,cluster,unit_type', `id=in.${hh}`),
      select('member_household_members', 'household_id,person_id,role,can_login', `household_id=in.${hh}`),
      select('member_plots', 'id,household_id,patta_no,reference_no,survey_no,area_hectares,area_acres,settlement,verification,source_document_id', `household_id=in.${hh}`),
      select('member_house_pattas', 'id,household_id,patta_no,reference_no,survey_no,area_sq_ft,settlement,verification,source_document_id', `household_id=in.${hh}`),
      select('member_household_notes', 'household_id,kind', `household_id=in.${hh}`),
      select('member_land_documents', 'id,household_id,land_type,status,extracted,created_at', `household_id=in.${hh}`),
    ]);
    const personIds = [...new Set(memberships.map((m: any) => m.person_id))];
    const people = personIds.length ? await select('member_people', 'id,full_name,email,phone,active,directory_visible', `id=in.${inList(personIds)}`) : [];
    data = { households, memberships, plots, housePattas, notes, people };
    landDocs = docRows;
  } catch (err) {
    console.error('[members-me] failed to load', err);
    return jsonResponse({ error: 'Server error' }, 500);
  }

  const own = data.people.find((p: any) => p.id === member.personId);
  const reviewed = buildHouseholdReview(data);
  // Each land record also says which uploaded file its patta number and its survey number open.
  for (const h of reviewed) {
    const docs = landDocs.filter((d: any) => d.household_id === h.id);
    for (const [landType, rows] of [['farm', h.plots], ['house', h.housePattas]] as const) {
      for (const row of rows as any[]) Object.assign(row, landDocumentLinks(docs, { landType, pattaNo: row.pattaNo, surveyNo: row.surveyNo }));
    }
  }
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
    // Whether the story editor writes the unit's shared story (the cutover switch) or the person's own; off until the move is done.
    // A failure to read the switch must not stop the portal opening, so it means off.
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
    summary: d.extracted?.kind === 'fmb_sketch' ? `FMB sketch for survey no. ${d.extracted.surveyNo}` : memberSummary(status, Array.isArray(d.items) ? d.items : [], error),
  };
}

async function handleLandDocuments(req: Request): Promise<Response> {
  const auth = await requireMember(req);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
  const { member } = auth;
  if (privacyNoticeRequired(member.privacyVersion)) return jsonResponse({ error: 'Please read the privacy notice first.' }, 403);

  if (req.method === 'GET') {
    try {
      const docs = await select('member_land_documents', 'id,household_id,land_type,original_filename,status,error,items,extracted,created_at', `household_id=in.${inList(member.householdIds)}&order=created_at.desc`);
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
  // An FMB sketch on its own: the member says which survey number it is for.
  const sketchFor = String(form.get('sketchFor') ?? '').trim();
  if (sketchFor) {
    if (mime !== 'application/pdf') return jsonResponse({ error: NOT_A_SKETCH }, 415);
    return handleSketchUpload({ member, file, bytes, landType, householdId, sketchFor });
  }
  if (mime === 'application/pdf' && file.size > MAX_PDF_BYTES) return jsonResponse({ error: NOT_A_LAND_PDF }, 413);
  // A PDF must match one of the two e-Services layouts. The reader is local and takes milliseconds,
  // so anything else is refused here and never stored. Photos and scans can't be read; they are kept
  // for the core team.
  const read = mime === 'application/pdf' ? await readLandPdf(bytes) : null;
  if (mime === 'application/pdf' && !read) return jsonResponse({ error: NOT_A_LAND_PDF }, 422);
  // The survey numbers it covers, to recognise an earlier upload of the same document.
  const checked: { ok: boolean; extraction?: any } = normalizeExtraction(read);
  const key = checked.ok ? surveyKey(checked.extraction) : null;
  const sha256 = hex(await crypto.subtle.digest('SHA-256', bytes));

  try {
    // A farm patta and a house patta are the same kind of file, so the card it was uploaded from is
    // checked against what this household's registers already hold, before anything is stored.
    if (checked.ok) {
      const [farmRows, houseRows] = await Promise.all([
        select('member_plots', 'survey_no', `household_id=eq.${householdId}`),
        select('member_house_pattas', 'survey_no', `household_id=eq.${householdId}`),
      ]);
      const wrong = landTypeMismatch({ landType, extraction: checked.extraction, farmRows, houseRows });
      if (wrong) return jsonResponse({ error: WRONG_CARD[wrong.actual as 'farm' | 'house'] }, 422);
    }
    const all = await select('member_land_documents', 'id,sha256,status,created_at,size_bytes,land_type,storage_path,extracted', `household_id=eq.${householdId}`);
    // An upload is always a new upload. Earlier documents it duplicates are replaced once it is in.
    const replaced = documentsReplacedBy({ sha256, landType, key, existing: all, staleMs: STALE_PROCESSING_MS });
    const replacedIds = new Set(replaced.map((d: any) => d.id));
    const recent = all.filter((d: any) => Date.parse(d.created_at) > Date.now() - 24 * 3600 * 1000 && !replacedIds.has(d.id));
    const storedBytes = all.filter((d: any) => d.status !== 'failed' && !replacedIds.has(d.id)).reduce((n: number, d: any) => n + (d.size_bytes ?? 0), 0);
    if (storedBytes + file.size > MAX_HOUSEHOLD_BYTES) return jsonResponse({ error: 'Your unit has reached its document storage limit. Please ask the core team.' }, 413);
    if (recent.length >= MAX_UPLOADS_PER_DAY) return jsonResponse({ error: 'You have uploaded a lot of documents today. Please try again tomorrow, or ask the core team.' }, 429);

    const documentId = crypto.randomUUID();
    const storagePath = `${householdId}/${documentId}.${mime === 'application/pdf' ? 'pdf' : mime === 'image/png' ? 'png' : 'jpg'}`;

    // Recorded first, refused if it can't be (same rule as every self-service change).
    const log = await fetch(`${supabaseUrl()}/rest/v1/member_audit_log`, {
      method: 'POST',
      headers: restHeaders({ Prefer: 'return=minimal' }),
      body: JSON.stringify({ actor_person_id: member.personId, action: 'member.land.upload', detail: { documentId, landType, mime, replaced: replaced.length } }),
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

    // Now that the new upload is in and being read, remove what it replaces: the files (and
    // outline) and the rows. Records that pointed at an old row are repointed by the reader.
    if (replaced.length) {
      await Promise.all(replaced.flatMap((d: any) => [deleteLandDocument(d.storage_path), deleteLandDocument(landShapeKey(d.storage_path))]).map((p: Promise<unknown>) => p.catch(() => null)));
      await fetch(`${supabaseUrl()}/rest/v1/member_land_documents?id=in.${inList(replaced.map((d: any) => d.id))}`, { method: 'DELETE', headers: restHeaders({ Prefer: 'return=minimal' }) }).catch((err) => console.error('[members-me] could not remove replaced documents', err));
    }

    return jsonResponse({ ok: true, documentId, replaced: replaced.length });
  } catch (err) {
    console.error('[members-me] land document upload failed', err);
    return jsonResponse({ error: 'Server error' }, 500);
  }
}

// An FMB sketch on its own (e-Services' "Survey Number" download, sketch page only). Its labels are
// drawn as shapes, not text, so nothing in it can be read: the member says which of their survey
// numbers it is for, and it is kept only if an outline of the land can be drawn from it. It creates
// and verifies no record. See "stand-alone FMB sketches" in scripts/lib/member-land-docs.mjs.
async function handleSketchUpload({ member, file, bytes, landType, householdId, sketchFor }: { member: any; file: File; bytes: Uint8Array<ArrayBuffer>; landType: string; householdId: string; sketchFor: string }): Promise<Response> {
  if (file.size > MAX_PDF_BYTES) return jsonResponse({ error: NOT_A_SKETCH }, 413);
  try {
    const rows = await select(landType === 'house' ? 'member_house_pattas' : 'member_plots', 'survey_no', `household_id=eq.${householdId}`);
    if (!surveyOnRegister(sketchFor, rows)) return jsonResponse({ error: SKETCH_NOT_YOURS }, 422);
    // A patta has its own path: it is read, checked against the register, and its sketch is picked up there.
    if (await readLandPdf(bytes)) return jsonResponse({ error: SKETCH_IS_A_PATTA }, 422);
    const shape = await readLandShape(bytes, { standalone: true });
    if (!shape) return jsonResponse({ error: NOT_A_SKETCH }, 422);

    const surveyNo = normalizeSurveyNo(sketchFor);
    const sha256 = hex(await crypto.subtle.digest('SHA-256', bytes));
    const all = await select('member_land_documents', 'id,sha256,status,created_at,size_bytes,storage_path,extracted', `household_id=eq.${householdId}`);
    // A new sketch for a survey number replaces the earlier one (a fresh download is a different file).
    const replaced = all.filter((d: any) => d.sha256 === sha256 || (d.extracted?.kind === 'fmb_sketch' && normalizeSurveyNo(d.extracted.surveyNo) === surveyNo));
    const replacedIds = new Set(replaced.map((d: any) => d.id));
    const recent = all.filter((d: any) => Date.parse(d.created_at) > Date.now() - 24 * 3600 * 1000 && !replacedIds.has(d.id));
    const storedBytes = all.filter((d: any) => d.status !== 'failed' && !replacedIds.has(d.id)).reduce((n: number, d: any) => n + (d.size_bytes ?? 0), 0);
    if (storedBytes + file.size > MAX_HOUSEHOLD_BYTES) return jsonResponse({ error: 'Your unit has reached its document storage limit. Please ask the core team.' }, 413);
    if (recent.length >= MAX_UPLOADS_PER_DAY) return jsonResponse({ error: 'You have uploaded a lot of documents today. Please try again tomorrow, or ask the core team.' }, 429);

    const documentId = crypto.randomUUID();
    const storagePath = `${householdId}/${documentId}.pdf`;
    // Recorded first, refused if it can't be (same rule as every self-service change).
    const log = await fetch(`${supabaseUrl()}/rest/v1/member_audit_log`, {
      method: 'POST',
      headers: restHeaders({ Prefer: 'return=minimal' }),
      body: JSON.stringify({ actor_person_id: member.personId, action: 'member.land.sketch', detail: { documentId, landType, replaced: replaced.length } }),
    }).catch(() => null);
    if (!log || !log.ok) {
      console.error('[members-me] audit log write failed; sketch upload refused', log?.status);
      return jsonResponse({ error: 'Could not record the upload, so nothing was saved. Try again.' }, 500);
    }

    const dropFiles = () => Promise.all([deleteLandDocument(storagePath), deleteLandDocument(landShapeKey(storagePath))].map((p) => p.catch(() => null)));
    try {
      await putLandDocument(storagePath, bytes, 'application/pdf');
      await putLandDocument(landShapeKey(storagePath), shape, 'image/png');
    } catch (err) {
      console.error('[members-me] sketch storage upload failed', err);
      await dropFiles();
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
        mime_type: 'application/pdf',
        size_bytes: file.size,
        sha256,
        status: 'applied',
        extracted: withShapeResult({ kind: 'fmb_sketch', surveyNo }, true),
        items: [],
        processed_at: new Date().toISOString(),
      }),
    });
    if (!inserted.ok) {
      console.error('[members-me] sketch insert failed', inserted.status);
      await dropFiles(); // don't leave a file with no record
      return jsonResponse({ error: 'Server error' }, 500);
    }
    // The new sketch is in: remove the one it replaces (files, then rows).
    if (replaced.length) {
      await Promise.all(replaced.flatMap((d: any) => [deleteLandDocument(d.storage_path), deleteLandDocument(landShapeKey(d.storage_path))]).map((p: Promise<unknown>) => p.catch(() => null)));
      await fetch(`${supabaseUrl()}/rest/v1/member_land_documents?id=in.${inList(replaced.map((d: any) => d.id))}`, { method: 'DELETE', headers: restHeaders({ Prefer: 'return=minimal' }) }).catch((err) => console.error('[members-me] could not remove replaced sketches', err));
    }
    return jsonResponse({ ok: true, documentId, replaced: replaced.length, sketch: true });
  } catch (err) {
    console.error('[members-me] sketch upload failed', err);
    return jsonResponse({ error: 'Server error' }, 500);
  }
}

// A one-minute signed link to a file the member's own household uploaded. Recorded first, and
// refused if it can't be, like every other self-service action.
async function handleLandDocumentLink(req: Request): Promise<Response> {
  const auth = await requireMember(req);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
  const { member } = auth;
  if (privacyNoticeRequired(member.privacyVersion)) return jsonResponse({ error: 'Please read the privacy notice first.' }, 403);
  let documentId = '';
  try {
    documentId = String((await req.json())?.documentId ?? '');
  } catch {
    // fall through
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(documentId)) return jsonResponse({ error: 'Choose a document.' }, 400);
  try {
    const [doc] = await select('member_land_documents', 'storage_path,household_id', `id=eq.${documentId}`);
    // Only their own households' files; a missing one and someone else's look the same.
    if (!doc || !member.householdIds.includes(doc.household_id)) return jsonResponse({ error: "That document doesn't exist any more." }, 404);
    const log = await fetch(`${supabaseUrl()}/rest/v1/member_audit_log`, {
      method: 'POST',
      headers: restHeaders({ Prefer: 'return=minimal' }),
      body: JSON.stringify({ actor_person_id: member.personId, action: 'member.land.view', detail: { documentId } }),
    }).catch(() => null);
    if (!log || !log.ok) return jsonResponse({ error: 'Could not record that, so the file was not opened. Try again.' }, 500);
    return jsonResponse({ url: await signedLandDocumentUrl(doc.storage_path, 60) });
  } catch (err) {
    console.error('[members-me] land document link failed', err);
    return jsonResponse({ error: 'Server error' }, 500);
  }
}

// The parcel outlines for this member's households' documents, as { documentId: data URL }.
async function handleLandShapes(req: Request): Promise<Response> {
  const auth = await requireMember(req);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
  const { member } = auth;
  if (privacyNoticeRequired(member.privacyVersion)) return jsonResponse({ error: 'Please read the privacy notice first.' }, 403);
  try {
    const docs = await select('member_land_documents', 'id,storage_path,mime_type,extracted', `household_id=in.${inList(member.householdIds)}`);
    await backfillLandShapes(docs);
    return jsonResponse({ shapes: await loadLandShapes(docs) });
  } catch (err) {
    console.error('[members-me] land shapes load failed', err);
    return jsonResponse({ error: 'Server error' }, 500);
  }
}

// ---- stories ----------------------------------------------------------------

const STORY_REVIEW_STORE = 'member-story-review';
// Per member per day, and for the whole portal: each check is one paid model call.
const STORY_REVIEW_PER_MEMBER_DAILY = 10;
const STORY_REVIEW_GLOBAL_DAILY = 300;
const STORY_REVIEW_TIMEOUT_MS = 20_000;
// Same model as search-ai.mts's fallback, so the usage page's single Anthropic price entry stays right.
const STORY_REVIEW_MODEL = process.env.STORY_REVIEW_MODEL || 'claude-sonnet-5';

// Signed-in, invited and past the privacy notice: the same gate as /profile (also used by stories and the directory).
async function requireAcknowledgedMember(req: Request) {
  const auth = await requireMember(req);
  if (!auth.ok) return { error: jsonResponse({ error: auth.error }, auth.status) } as const;
  if (privacyNoticeRequired(auth.member.privacyVersion)) return { error: jsonResponse({ error: 'Please read the privacy notice first.' }, 403) } as const;
  return { member: auth.member } as const;
}

async function readJson(req: Request): Promise<unknown | undefined> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

async function handleStoryReview(req: Request): Promise<Response> {
  const who = await requireAcknowledgedMember(req);
  if ('error' in who) return who.error;
  const body = await readJson(req);
  if (body === undefined) return jsonResponse({ error: 'Nothing to do.' }, 400);
  const checked = validateDraft(body);
  if (!checked.ok) return jsonResponse({ error: checked.error }, 400);
  const { draft, showOnPublicSite } = checked;

  // The fixed checks (children, length) need no outside service and always run.
  const suggestions: any[] = localChecks(draft, showOnPublicSite);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const hasText = draft.bio || draft.family || draft.why;
  let modelChecked = false;

  if (apiKey && hasText) {
    try {
      const memberOk = await checkDailyCap(STORY_REVIEW_STORE, `member-${who.member.personId}`, STORY_REVIEW_PER_MEMBER_DAILY);
      const globalOk = memberOk && (await checkDailyCap(STORY_REVIEW_STORE, 'all', STORY_REVIEW_GLOBAL_DAILY));
      if (!memberOk) return jsonResponse({ suggestions, modelChecked: false, notice: `You have used today's ${STORY_REVIEW_PER_MEMBER_DAILY} writing checks. You can still submit; the core team reads every story.` });
      if (globalOk) {
        const firstName = who.member.name.trim().split(/\s+/).find((w) => w.length > 1) ?? '';
        const reply = await Promise.race([
          callAnthropic({
            apiKey,
            model: STORY_REVIEW_MODEL,
            maxTokens: 1200,
            system: [{ type: 'text', text: REVIEW_SYSTEM }],
            messages: [{ role: 'user', content: reviewPrompt(draft, firstName) }],
          }),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), STORY_REVIEW_TIMEOUT_MS)),
        ]);
        if (reply && reply.ok) {
          suggestions.unshift(...parseSuggestions(reply.text, draft));
          modelChecked = true;
        }
      }
    } catch (err) {
      console.error('[members-me] story review model call failed', err);
    }
  }
  return jsonResponse({
    suggestions,
    modelChecked,
    notice: modelChecked || !hasText ? null : 'The spelling and grammar check is not available right now. The fixed checks ran; you can still submit and the core team will read it.',
  });
}

// ---- story photos -----------------------------------------------------------

const PHOTO_UPLOADS_PER_DAY = 10;
const PHOTO_STORE = 'member-story-photo';

// ---- unit stories ------------------------------------------------------------
// One story per UNIT (member_unit_stories, migration 0049): bio, family, photos and the public switch are
// shared by the unit's owners; each person keeps their own quote. The rules are in
// scripts/lib/member-unit-story.mjs.

const UNIT_STORY_COLUMNS = 'household_id,draft,draft_public,draft_version,draft_changed,status,submitted,submitted_public,submitted_at,submitted_by,approved,approved_public,approved_at,reviewer_note';
const firstNameOf = (full: string) => full.trim().split(/\s+/).find((w) => w.length > 1) ?? full;

async function loadUnitStory(householdId: string): Promise<any | null> {
  const rows = await select('member_unit_stories', UNIT_STORY_COLUMNS, `household_id=eq.${householdId}`);
  return rows[0] ?? null;
}

// The unit this member writes for, and who else is in it (first names only).
async function unitOf(member: { personId: string; householdIds: string[] }) {
  const householdId = member.householdIds[0];
  if (!householdId) return null;
  const links = await select('member_household_members', 'person_id,role', `household_id=eq.${householdId}`);
  const ids = links.map((l: any) => l.person_id);
  // The card names the unit's owners (everyone, if there is none), as the directory does.
  const anyOwner = links.some((l: any) => (l.role ?? 'owner') === 'owner');
  const isPrimary = (id: string) => !anyOwner || (links.find((l: any) => l.person_id === id)?.role ?? 'owner') === 'owner';
  const people = ids.length ? await select('member_people', 'id,full_name', `id=in.(${ids.join(',')})`) : [];
  const [household] = await select('member_households', 'farm_unit', `id=eq.${householdId}`);
  return { householdId, farmUnit: (household?.farm_unit as string | undefined) ?? '', people: people.map((p: any) => ({ id: p.id, firstName: firstNameOf(p.full_name), primary: isPrimary(p.id) })) };
}

// Writes the new draft only if nobody saved since it was read (the version is the guard), so two owners
// saving at once can't overwrite each other. Returns the row, or null when someone got there first.
async function writeUnitDraft(householdId: string, existing: any | null, columns: Record<string, unknown>): Promise<any | null> {
  const stamp = { updated_at: new Date().toISOString() };
  const res = existing
    ? await fetch(`${supabaseUrl()}/rest/v1/member_unit_stories?household_id=eq.${householdId}&draft_version=eq.${existing.draft_version}&select=${UNIT_STORY_COLUMNS}`, {
        method: 'PATCH',
        headers: restHeaders({ Prefer: 'return=representation' }),
        body: JSON.stringify({ ...columns, ...stamp }),
      })
    : await fetch(`${supabaseUrl()}/rest/v1/member_unit_stories?select=${UNIT_STORY_COLUMNS}`, {
        method: 'POST',
        headers: restHeaders({ Prefer: 'return=representation' }),
        body: JSON.stringify({ household_id: householdId, ...columns, ...stamp }),
      });
  if (res.status === 409) return null; // the first save of the unit raced another owner's
  if (!res.ok) throw new Error(`unit story write failed: ${res.status}`);
  return (await res.json())[0] ?? null;
}

const conflictResponse = (fields: string[]) => jsonResponse({ error: 'Someone else in your unit changed this while you were editing. Reload to see their version.', fields }, 409);

// Delete an uploaded photo's files once no copy of the unit's story refers to it any more.
async function dropUnitPhotoIfUnreferenced(entry: { ref: string; personId: string } | undefined, row: any): Promise<void> {
  if (!entry || !isUploadedPhoto(entry.ref)) return;
  const stillUsed = [row?.draft, row?.submitted, row?.approved].some((copy) => (copy?.photos ?? []).some((p: any) => p.ref === entry.ref));
  if (!stillUsed) await deleteMemberPhoto(entry.personId, entry.ref).catch((err) => console.error('[members-me] unit photo cleanup failed', err));
}

async function handleUnitStoryGet(req: Request): Promise<Response> {
  const who = await requireAcknowledgedMember(req);
  if ('error' in who) return who.error;
  try {
    const unit = await unitOf(who.member);
    if (!unit) return jsonResponse({ error: 'You are not part of a unit yet. Ask the core team.' }, 409);
    return jsonResponse({ story: unitStoryView(await loadUnitStory(unit.householdId), { personId: who.member.personId, people: unit.people }), firstName: firstNameOf(who.member.name) });
  } catch (err) {
    console.error('[members-me] unit story load failed', err);
    return jsonResponse({ error: 'Server error' }, 500);
  }
}

async function handleUnitStorySave(req: Request): Promise<Response> {
  const who = await requireAcknowledgedMember(req);
  if ('error' in who) return who.error;
  const body = await readJson(req);
  if (body === undefined) return jsonResponse({ error: 'Nothing to do.' }, 400);
  const checked = validateUnitSave(body);
  if (!checked.ok) return jsonResponse({ error: checked.error }, 400);
  try {
    const unit = await unitOf(who.member);
    if (!unit) return jsonResponse({ error: 'You are not part of a unit yet. Ask the core team.' }, 409);
    const existing = await loadUnitStory(unit.householdId);
    const merged = mergeDraftEdit({ current: draftState(existing), changes: checked.changes, baseVersion: checked.baseVersion, personId: who.member.personId });
    if (!merged.ok) return merged.error === 'conflict' ? conflictResponse(merged.fields) : jsonResponse({ error: 'Could not save that.' }, 400);
    // Nothing changed (the same text saved again): no write, and no new version.
    if (merged.version === (existing?.draft_version ?? 0) && existing) return jsonResponse({ story: unitStoryView(existing, { personId: who.member.personId, people: unit.people }) });
    const row = await writeUnitDraft(unit.householdId, existing, draftColumns(merged));
    if (!row) return conflictResponse([]);
    return jsonResponse({ story: unitStoryView(row, { personId: who.member.personId, people: unit.people }) });
  } catch (err) {
    console.error('[members-me] unit story save failed', err);
    return jsonResponse({ error: 'Could not save your draft. Try again.' }, 500);
  }
}

async function handleUnitStorySubmit(req: Request): Promise<Response> {
  const who = await requireAcknowledgedMember(req);
  if ('error' in who) return who.error;
  const { member } = who;
  try {
    const unit = await unitOf(member);
    if (!unit) return jsonResponse({ error: 'You are not part of a unit yet. Ask the core team.' }, 409);
    const row = await loadUnitStory(unit.householdId);
    if (!row) return jsonResponse({ error: 'Save your story first.' }, 409);
    const ok = validateUnitSubmit({ fields: draftState(row).fields });
    if (!ok.ok) return jsonResponse({ error: ok.error }, 400);
    const view = unitStoryView(row, { personId: member.personId, people: unit.people });
    if (!view.hasUnsubmittedChanges) return jsonResponse({ error: 'There is nothing new to submit.' }, 409);

    // Logged before the change, and refused if it can't be, as for every self-service change. Which parts the
    // story has, never its text.
    const log = await fetch(`${supabaseUrl()}/rest/v1/member_audit_log`, {
      method: 'POST',
      headers: restHeaders({ Prefer: 'return=minimal' }),
      body: JSON.stringify({ actor_person_id: member.personId, action: 'member.unit_story.submit', detail: { unit: true, showOnPublicSite: !!row.draft_public, photos: (row.draft?.photos ?? []).length } }),
    }).catch(() => null);
    if (!log || !log.ok) {
      console.error('[members-me] audit log write failed; unit story submit refused', log?.status);
      return jsonResponse({ error: 'Could not record this, so nothing was submitted. Try again.' }, 500);
    }
    // A second owner submitting while one is in review replaces that submission.
    const now = new Date().toISOString();
    const res = await fetch(`${supabaseUrl()}/rest/v1/member_unit_stories?household_id=eq.${unit.householdId}&select=${UNIT_STORY_COLUMNS}`, {
      method: 'PATCH',
      headers: restHeaders({ Prefer: 'return=representation' }),
      body: JSON.stringify({ status: 'in_review', submitted: row.draft, submitted_public: !!row.draft_public, submitted_at: now, submitted_by: member.personId, reviewer_note: null, updated_at: now }),
    });
    if (!res.ok) {
      console.error('[members-me] unit story submit failed', res.status);
      return jsonResponse({ error: 'Server error' }, 500);
    }
    let updated = (await res.json())[0];
    for (const old of row.submitted?.photos ?? []) await dropUnitPhotoIfUnreferenced(old, updated);
    // Assessed for risk (lib/story-risk.ts), like a person's story: in shadow mode that only records what it would have
    // done; once switched to live a low-risk story is approved here, so the member is shown where it ended up.
    const label = `${unit.farmUnit}: ${unit.people.map((p) => p.firstName).join(' and ')}`;
    const { approved } = await assessUnitSubmission(updated, label);
    if (approved) updated = (await loadUnitStory(unit.householdId)) ?? updated;
    return jsonResponse({ story: unitStoryView(updated, { personId: member.personId, people: unit.people }) });
  } catch (err) {
    console.error('[members-me] unit story submit failed', err);
    return jsonResponse({ error: 'Server error' }, 500);
  }
}

async function handleUnitStoryPhoto(req: Request): Promise<Response> {
  const who = await requireAcknowledgedMember(req);
  if ('error' in who) return who.error;
  const { member } = who;
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonResponse({ error: 'Nothing to do.' }, 400);
  }
  const square = form.get('square');
  const full = form.get('full');
  if (!(square instanceof File) || !(full instanceof File) || square.size === 0 || full.size === 0) return jsonResponse({ error: 'Choose a photo.' }, 400);
  if (square.size > MAX_SQUARE_BYTES || full.size > MAX_FULL_BYTES) return jsonResponse({ error: 'That photo is too large. Try a smaller one.' }, 413);
  const squareBytes = new Uint8Array(await square.arrayBuffer());
  const fullBytes = new Uint8Array(await full.arrayBuffer());
  // What is stored is what comes back from the check, with every metadata block removed (not the bytes that were uploaded).
  const checked: { ok: boolean; error?: string; square?: Uint8Array; full?: Uint8Array } = validatePhotoPair(squareBytes, fullBytes);
  if (!checked.ok) return jsonResponse({ error: checked.error }, 415);

  try {
    const unit = await unitOf(member);
    if (!unit) return jsonResponse({ error: 'You are not part of a unit yet. Ask the core team.' }, 409);
    const existing = await loadUnitStory(unit.householdId);
    const state = draftState(existing);
    // Checked before anything is stored: a unit holds at most MAX_PHOTOS, so a full unit never uploads a file.
    if (state.fields.photos.length >= MAX_PHOTOS) return jsonResponse({ error: `Your unit can have up to ${MAX_PHOTOS} photos. Remove one first.` }, 409);
    if (!(await checkDailyCap(PHOTO_STORE, `member-${member.personId}`, PHOTO_UPLOADS_PER_DAY))) {
      return jsonResponse({ error: 'You have uploaded a lot of photos today. Please try again tomorrow.' }, 429);
    }
    const photoId = crypto.randomUUID();
    await putMemberPhoto(member.personId, photoId, checked.square!, checked.full!); // the files first, so the draft never points at nothing
    const added = addPhoto(state.fields.photos, { ref: photoId, personId: member.personId });
    if (!added.ok) return jsonResponse({ error: `Your unit can have up to ${MAX_PHOTOS} photos. Remove one first.` }, 409);
    const merged = mergeDraftEdit({ current: state, changes: { photos: added.photos }, baseVersion: state.version, personId: member.personId });
    if (!merged.ok) return conflictResponse(merged.fields ?? []);
    const row = await writeUnitDraft(unit.householdId, existing, draftColumns(merged));
    if (!row) {
      await deleteMemberPhoto(member.personId, photoId).catch(() => null); // lost the race: don't leave a file nothing points at
      return conflictResponse([]);
    }
    return jsonResponse({ story: unitStoryView(row, { personId: member.personId, people: unit.people }) });
  } catch (err) {
    console.error('[members-me] unit story photo upload failed', err);
    return jsonResponse({ error: 'Could not save your photo. Try again.' }, 500);
  }
}

async function handleUnitStoryPhotoRemove(req: Request): Promise<Response> {
  const who = await requireAcknowledgedMember(req);
  if ('error' in who) return who.error;
  const body = (await readJson(req)) as { ref?: unknown } | undefined;
  const ref = typeof body?.ref === 'string' ? body.ref : '';
  try {
    const unit = await unitOf(who.member);
    if (!unit) return jsonResponse({ error: 'You are not part of a unit yet. Ask the core team.' }, 409);
    const existing = await loadUnitStory(unit.householdId);
    const state = draftState(existing);
    const gone = state.fields.photos.find((p: any) => p.ref === ref);
    if (!gone) return jsonResponse({ error: 'That photo is not in your story.' }, 404);
    const merged = mergeDraftEdit({ current: state, changes: { photos: state.fields.photos.filter((p: any) => p.ref !== ref) }, baseVersion: state.version, personId: who.member.personId });
    if (!merged.ok) return conflictResponse(merged.fields ?? []);
    const row = await writeUnitDraft(unit.householdId, existing, draftColumns(merged));
    if (!row) return conflictResponse([]);
    await dropUnitPhotoIfUnreferenced(gone, row);
    return jsonResponse({ story: unitStoryView(row, { personId: who.member.personId, people: unit.people }) });
  } catch (err) {
    console.error('[members-me] unit story photo remove failed', err);
    return jsonResponse({ error: 'Could not remove your photo. Try again.' }, 500);
  }
}

// One unit photo. 404 for everything not allowed, so the response never says whether a photo exists.
async function handleUnitPhoto(req: Request): Promise<Response> {
  const who = await requireAcknowledgedMember(req);
  if ('error' in who) return who.error;
  const url = new URL(req.url);
  const id = url.searchParams.get('id') ?? '';
  const size = url.searchParams.get('size') === 'full' ? 'full' : 'square';
  const notFound = () => new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  if (!isUploadedPhoto(id)) return notFound();
  try {
    const rows = await select('member_unit_stories', 'household_id,draft,submitted,approved', `or=(draft->photos.cs.[{"ref":"${id}"}],submitted->photos.cs.[{"ref":"${id}"}],approved->photos.cs.[{"ref":"${id}"}])`);
    const row = rows[0];
    if (!row) return notFound();
    const holder = [row.draft, row.submitted, row.approved].flatMap((c) => c?.photos ?? []).find((p: any) => p.ref === id);
    const [person] = holder ? await select('member_people', 'id,active,directory_visible', `id=eq.${holder.personId}`) : [];
    const listed = !!person && person.active !== false && person.directory_visible !== false;
    if (!unitPhotoAccess({ viewerHouseholdIds: who.member.householdIds, row, photoId: id, listed })) return notFound();
    const bytes = await getMemberPhoto(holder.personId, id, size);
    if (!bytes) return notFound();
    return new Response(bytes, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' } });
  } catch (err) {
    console.error('[members-me] unit photo load failed', err);
    return jsonResponse({ error: 'Server error' }, 500);
  }
}

// ---- directory --------------------------------------------------------------

// The one place a member reads about OTHER members, so it is deliberately narrow: only
// columns the directory shows are selected (no email, mobile, land or documents), only people
// who are active and listed, and only the core team's approved story (scripts/lib/member-directory.mjs).
async function handleDirectory(req: Request): Promise<Response> {
  const who = await requireAcknowledgedMember(req);
  if ('error' in who) return who.error;
  try {
    const [people, memberships, households, unitStories] = await Promise.all([
      select('member_people', 'id,full_name,active,directory_visible', 'active=eq.true&directory_visible=eq.true'),
      select('member_household_members', 'household_id,person_id,role', 'person_id=not.is.null'),
      select('member_households', 'id,farm_unit,house_no,cluster,unit_type', 'id=not.is.null'),
      select('member_unit_stories', 'household_id,approved,approved_public', 'approved=not.is.null'),
    ]);
    return jsonResponse({ unitPhotos: true, households: buildUnitDirectory({ people, memberships, households, unitStories }, who.member.personId) });
  } catch (err) {
    console.error('[members-me] directory load failed', err);
    return jsonResponse({ error: 'Server error' }, 500);
  }
}

// ---- Stays: a member books their own family's nights at the farm ----
// The booking is an ordinary `member-stay` in the accommodation calendar (accommodation_create_booking, so the
// database still refuses a tent that is taken). member_stays remembers which household booked it. A member
// only ever sees, books for and cancels their own households' stays.

const todayIst = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const UNIT_LABEL = new Map<string, string>(ACCOMMODATION_UNITS.map((u: { id: string; label: string }) => [u.id, u.label]));

// The household a request is for: the one they named if they may sign in for it, otherwise their first.
function stayHousehold(member: { householdIds: string[] }, asked: unknown): string | null {
  if (typeof asked === 'string' && member.householdIds.includes(asked)) return asked;
  return member.householdIds[0] ?? null;
}

// Tents with a booking on any of these nights, and whether the whole farm is closed or taken. The database
// records a farm closure or an exclusive private event as a booking with no tents, so it is looked up apart.
async function occupancy(startDate: string, nights: number) {
  const range = encodeURIComponent(`[${startDate},${checkOut(startDate, nights)})`);
  const [assigned, blockers] = await Promise.all([
    select('accommodation_tent_assignments', 'tent_id', `stay_range=ov.${range}`),
    select('accommodation_bookings', 'id', `stay_range=ov.${range}&or=(type.eq.farm-closure,and(type.eq.private-event,exclusive.eq.true))`),
  ]);
  return { occupiedTentIds: assigned.map((a: any) => a.tent_id as string), wholeFarmBlocked: blockers.length > 0 };
}

async function guestDiscountPercent(): Promise<number> {
  try {
    const [row] = await select('portal_settings', 'value', 'key=eq.guest_discount_percent');
    const v = Number(row?.value);
    return Number.isFinite(v) && v >= 0 && v <= 100 ? v : 20;
  } catch {
    return 20;
  }
}

async function auditStay(personId: string, action: string, detail: Record<string, unknown>): Promise<boolean> {
  const log = await fetch(`${supabaseUrl()}/rest/v1/member_audit_log`, {
    method: 'POST',
    headers: restHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify({ actor_person_id: personId, action, detail }),
  }).catch(() => null);
  return Boolean(log && log.ok);
}

// A stay as the member sees it: names and tents only, never anyone's contact details.
function stayView(booking: any, guestCount: number, householdId: string) {
  return {
    id: booking.id as string,
    householdId,
    startDate: booking.startDate as string,
    nights: booking.nights as number,
    checkOut: checkOut(booking.startDate, booking.nights),
    guestCount,
    canCancel: canCancelStay(booking.startDate, todayIst()),
    tents: booking.tents.map((t: any) => ({ tentId: t.tentId, label: UNIT_LABEL.get(t.tentId) ?? t.tentId, guests: t.guests.map((g: any) => g.name as string) })),
  };
}

async function handleStaysList(req: Request): Promise<Response> {
  const who = await requireAcknowledgedMember(req);
  if ('error' in who) return who.error;
  try {
    const rows = await select('member_stays', 'booking_id,household_id,guest_count', `household_id=in.${inList(who.member.householdIds)}`);
    const stays = [];
    for (const r of rows) {
      const booking = await getBookingById(r.booking_id);
      if (booking) stays.push(stayView(booking, r.guest_count, r.household_id));
    }
    stays.sort((a, b) => b.startDate.localeCompare(a.startDate));
    return jsonResponse({ stays, guestDiscountPercent: await guestDiscountPercent() });
  } catch (err) {
    console.error('[members-me] stays list failed', err);
    return jsonResponse({ error: 'Server error' }, 500);
  }
}

async function handleStaysAvailability(req: Request): Promise<Response> {
  const who = await requireAcknowledgedMember(req);
  if ('error' in who) return who.error;
  const url = new URL(req.url);
  const startDate = url.searchParams.get('start') ?? '';
  const nights = Number(url.searchParams.get('nights'));
  const bad = validateStayDates({ startDate, nights }, todayIst());
  if (bad) return jsonResponse({ error: bad }, 400);
  try {
    return jsonResponse({ startDate, nights, checkOut: checkOut(startDate, nights), ...availabilityFor(await occupancy(startDate, nights)) });
  } catch (err) {
    console.error('[members-me] availability failed', err);
    return jsonResponse({ error: 'Could not check availability. Try again.' }, 500);
  }
}

async function handleStaysBook(req: Request): Promise<Response> {
  const who = await requireAcknowledgedMember(req);
  if ('error' in who) return who.error;
  const { member } = who;
  const body = (await readJson(req)) as Record<string, unknown> | undefined;
  if (!body) return jsonResponse({ error: 'Nothing to do.' }, 400);
  const householdId = stayHousehold(member, body.householdId);
  if (!householdId) return jsonResponse({ error: 'You are not part of a unit yet. Ask the core team.' }, 409);

  try {
    // The unit's registered people, read here so the member never types a name, number or email we already hold.
    const links = await select('member_household_members', 'person_id', `household_id=eq.${householdId}`);
    const people = links.length ? await select('member_people', 'id,full_name,phone,email', `id=in.${inList(links.map((l: any) => l.person_id))}&active=eq.true`) : [];
    const family = new Map<string, { name: string; phone: string | null; email: string | null }>(people.map((p: any) => [p.id, { name: p.full_name, phone: p.phone ?? null, email: p.email ?? null }]));
    const checked: any = validateStayRequest(body, todayIst(), family);
    if (checked.error) return jsonResponse({ error: checked.error }, 400);

    // Refuse early, in plain words, if a tent was taken (or the farm closed) while the member was filling this in.
    // The database is the final word on a tent; it cannot see a farm closure, so that is checked here.
    const now = await occupancy(checked.startDate, checked.nights);
    const taken = checked.tents.filter((t: any) => now.occupiedTentIds.includes(t.tentId));
    if (now.wholeFarmBlocked || taken.length) {
      return jsonResponse({ error: now.wholeFarmBlocked ? 'The farm is not available on those dates.' : `${taken.map((t: any) => UNIT_LABEL.get(t.tentId)).join(' and ')} ${taken.length > 1 ? 'were' : 'was'} just booked. Pick again.` }, 409);
    }
    const [household] = await select('member_households', 'farm_unit', `id=eq.${householdId}`);
    const farmUnit = (household?.farm_unit as string | undefined) ?? '';

    // Logged before the booking, and refused if it can't be, so no booking goes unrecorded.
    const logged = await auditStay(member.personId, 'member.stay.create', { householdId, startDate: checked.startDate, nights: checked.nights, tents: checked.tents.map((t: any) => t.tentId), guestCount: checked.guestCount });
    if (!logged) return jsonResponse({ error: 'Could not record the booking, so nothing was booked. Try again.' }, 500);

    let booking: any;
    try {
      booking = await createBooking({ type: 'member-stay', label: `${farmUnit} · ${member.name}`, startDate: checked.startDate, nights: checked.nights, tents: checked.tents, createdBy: `member:${member.personId}` } as any);
    } catch (err) {
      if ((err as { status?: number }).status === 409) return jsonResponse({ error: 'One of those tents was just booked. Pick again.' }, 409);
      throw err;
    }
    const link = await fetch(`${supabaseUrl()}/rest/v1/member_stays`, {
      method: 'POST',
      headers: restHeaders({ Prefer: 'return=minimal' }),
      body: JSON.stringify({ booking_id: booking.id, household_id: householdId, requested_by: member.personId, guest_count: checked.guestCount }),
    }).catch(() => null);
    if (!link || !link.ok) {
      // A booking no household owns would sit on the calendar unseen by the member: take it back.
      await deleteBooking(booking.id, { deletedBy: `member:${member.personId}`, reason: 'Could not be linked to the household' }).catch(() => {});
      console.error('[members-me] stay link failed; booking removed', link?.status);
      return jsonResponse({ error: 'Could not save the booking. Nothing was booked. Try again.' }, 500);
    }

    const [me] = await select('member_people', 'email', `id=eq.${member.personId}`);
    await sendMemberStayBooked({ farmUnit, memberName: member.name, memberEmail: me?.email ?? null, startDate: booking.startDate, nights: booking.nights, guestCount: checked.guestCount, tents: booking.tents });
    return jsonResponse({ stay: stayView(booking, checked.guestCount, householdId) });
  } catch (err) {
    console.error('[members-me] stay booking failed', err);
    return jsonResponse({ error: 'Could not book. Try again.' }, 500);
  }
}

async function handleStaysCancel(req: Request): Promise<Response> {
  const who = await requireAcknowledgedMember(req);
  if ('error' in who) return who.error;
  const { member } = who;
  const body = (await readJson(req)) as { bookingId?: unknown } | undefined;
  const bookingId = typeof body?.bookingId === 'string' && /^[0-9a-f-]{36}$/i.test(body.bookingId) ? body.bookingId : '';
  if (!bookingId) return jsonResponse({ error: 'Nothing to do.' }, 400);
  try {
    // 404 whether it is missing or someone else's, so the response never says which bookings exist.
    const [row] = await select('member_stays', 'household_id,guest_count', `booking_id=eq.${bookingId}&household_id=in.${inList(member.householdIds)}`);
    const booking: any = row ? await getBookingById(bookingId) : null;
    if (!row || !booking) return jsonResponse({ error: 'That booking was not found.' }, 404);
    if (!canCancelStay(booking.startDate, todayIst())) return jsonResponse({ error: 'A stay that has started cannot be cancelled here. Contact the core team.' }, 409);

    if (!(await auditStay(member.personId, 'member.stay.cancel', { householdId: row.household_id, bookingId, startDate: booking.startDate, nights: booking.nights }))) {
      return jsonResponse({ error: 'Could not record the cancellation, so nothing was cancelled. Try again.' }, 500);
    }
    // The last notice cascades away with the booking, so read it first: if the guests were told, they hear of this too.
    const notice = await getNotice(bookingId);
    await deleteBooking(bookingId, { deletedBy: `member:${member.personId}`, reason: 'Cancelled by the member in the portal' });
    if (notice) await sendStayCancellation(booking, notice.snapshot).catch((err: unknown) => console.error('[members-me] guest cancellation failed', err));

    const [household] = await select('member_households', 'farm_unit', `id=eq.${row.household_id}`);
    const [me] = await select('member_people', 'email', `id=eq.${member.personId}`);
    await sendMemberStayCancelled({ farmUnit: household?.farm_unit ?? '', memberName: member.name, memberEmail: me?.email ?? null, startDate: booking.startDate, nights: booking.nights, guestCount: row.guest_count, tents: booking.tents });
    return jsonResponse({ ok: true });
  } catch (err) {
    console.error('[members-me] stay cancel failed', err);
    return jsonResponse({ error: 'Could not cancel. Try again.' }, 500);
  }
}

export default async (req: Request): Promise<Response> => {
  const { pathname } = new URL(req.url);
  if (pathname === '/api/members-me/stays' && req.method === 'GET') return handleStaysList(req);
  if (pathname === '/api/members-me/stays' && req.method === 'POST') return handleStaysBook(req);
  if (pathname === '/api/members-me/stays-availability' && req.method === 'GET') return handleStaysAvailability(req);
  if (pathname === '/api/members-me/stays-cancel' && req.method === 'POST') return handleStaysCancel(req);
  if (pathname === '/api/members-me/home' && req.method === 'GET') return handleHome(req);
  if (pathname === '/api/members-me/profile' && req.method === 'POST') return handleProfile(req);
  if (pathname === '/api/members-me/privacy' && req.method === 'POST') return handlePrivacy(req);
  if (pathname === '/api/members-me/land-shapes' && req.method === 'GET') return handleLandShapes(req);
  if (pathname === '/api/members-me/land-document-link' && req.method === 'POST') return handleLandDocumentLink(req);
  if (pathname === '/api/members-me/land-documents' && (req.method === 'GET' || req.method === 'POST')) return handleLandDocuments(req);
  if (pathname === '/api/members-me/directory' && req.method === 'GET') return handleDirectory(req);
  if (pathname === '/api/members-me/story-review' && req.method === 'POST') return handleStoryReview(req);
  if (pathname === '/api/members-me/unit-story' && req.method === 'GET') return handleUnitStoryGet(req);
  if (pathname === '/api/members-me/unit-story' && req.method === 'POST') return handleUnitStorySave(req);
  if (pathname === '/api/members-me/unit-story-submit' && req.method === 'POST') return handleUnitStorySubmit(req);
  if (pathname === '/api/members-me/unit-story-photo' && req.method === 'POST') return handleUnitStoryPhoto(req);
  if (pathname === '/api/members-me/unit-story-photo-remove' && req.method === 'POST') return handleUnitStoryPhotoRemove(req);
  if (pathname === '/api/members-me/unit-photo' && req.method === 'GET') return handleUnitPhoto(req);
  return jsonResponse({ error: 'Not found' }, 404);
};

export const config = { path: ['/api/members-me/home', '/api/members-me/profile', '/api/members-me/privacy', '/api/members-me/land-documents', '/api/members-me/land-document-link', '/api/members-me/land-shapes', '/api/members-me/story-review', '/api/members-me/directory', '/api/members-me/unit-story', '/api/members-me/unit-story-submit', '/api/members-me/unit-story-photo', '/api/members-me/unit-story-photo-remove', '/api/members-me/unit-photo', '/api/members-me/stays', '/api/members-me/stays-availability', '/api/members-me/stays-cancel'] };
