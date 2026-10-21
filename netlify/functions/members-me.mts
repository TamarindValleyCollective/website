// Netlify Function (v2 API) behind the member portal (src/pages/members/index.astro):
// what a signed-in member sees and may change about THEIR OWN membership.
//
//   GET  /api/members-me/home     their household(s) and their own details
//   POST /api/members-me/profile  change their mobile number / directory listing
//   POST /api/members-me/privacy  acknowledge the first-login privacy notice
//   GET  /api/members-me/land-documents  their uploaded patta / survey documents and what became of them
//   POST /api/members-me/land-documents  upload one (multipart: file, landType, householdId); read in the background
//   GET  /api/members-me/directory     the other members: name, farm plot, cluster and their approved story (opt-out; never contact details)
//   GET  /api/members-me/story         their own story: the draft, and where it stands (draft / in review / approved)
//   POST /api/members-me/story         save their draft (autosave; not audited, it is unpublished writing only they and the core team can see)
//   POST /api/members-me/story-review  suggestions on spelling, grammar, tone and house style (a model, plus fixed privacy checks); edits nothing
//   POST /api/members-me/story-submit  hand the saved draft to the core team (audited first)
//   POST /api/members-me/story-photo   upload a photo for the draft (multipart: square + full JPEGs, made in the browser)
//   POST /api/members-me/story-photo-remove  take the photo off the draft
//   GET  /api/members-me/photo?id=&size=  one uploaded photo, if the asker may see it (their own, or an approved one of a listed member)
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
import { readLandPdf } from './lib/land-doc-read';
import { restHeaders } from '../../scripts/lib/supabase.mjs';
import { buildHouseholdReview } from '../../scripts/lib/member-review.mjs';
import { validateProfileEdit, profileAuditDetail } from '../../scripts/lib/member-profile.mjs';
import { PRIVACY_NOTICE_VERSION, privacyNoticeRequired, validateAcceptance } from '../../scripts/lib/member-privacy.mjs';
import { callAnthropic } from './lib/anthropic';
import { checkDailyCap } from './lib/rate-limit';
import { buildDirectory, buildUnitDirectory } from '../../scripts/lib/member-directory.mjs';
import { MAX_FULL_BYTES, MAX_SQUARE_BYTES, isUploadedPhoto, photoAccess, validatePhotoPair } from '../../scripts/lib/member-photo.mjs';
import { deleteMemberPhoto, getMemberPhoto, putMemberPhoto } from './lib/member-photo-storage';
import { assessSubmission, assessUnitSubmission, unitStoriesLive } from './lib/story-risk';
import { REVIEW_SYSTEM, localChecks, parseSuggestions, reviewPrompt, storyAuditDetail, storyView, validateDraft, validateForSubmit, withStoredPhoto } from '../../scripts/lib/member-story.mjs';
import { MAX_PHOTOS, addPhoto, draftColumns, draftState, mergeDraftEdit, unitPhotoAccess, unitStoryView, validateUnitSave, validateUnitSubmit } from '../../scripts/lib/member-unit-story.mjs';
import { ALLOWED_MIME, LAND_TYPES, MAX_HOUSEHOLD_BYTES, MAX_IMAGE_BYTES, MAX_PDF_BYTES, MAX_UPLOADS_PER_DAY, NOT_A_LAND_PDF, WRONG_CARD, documentsReplacedBy, landTypeMismatch, memberSummary, normalizeExtraction, surveyKey } from '../../scripts/lib/member-land-docs.mjs';

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
      select('member_plots', 'id,household_id,patta_no,reference_no,survey_no,area_hectares,area_acres,settlement,verification,source_document_id', `household_id=in.${hh}`),
      select('member_house_pattas', 'id,household_id,patta_no,reference_no,survey_no,area_sq_ft,settlement,verification,source_document_id', `household_id=in.${hh}`),
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
    // Whether the story editor writes the unit's shared story (the cutover switch) or the person's own; off until the move is done.
    // A failure to read the switch must not stop the portal opening, so it means off.
    unitStories: await unitStoriesLive().catch(() => false),
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

const STORY_COLUMNS = 'person_id,draft,draft_public,status,submitted,submitted_public,submitted_at,approved,approved_public,approved_at,reviewer_note';
const STORY_REVIEW_STORE = 'member-story-review';
// Per member per day, and for the whole portal: each check is one paid model call.
const STORY_REVIEW_PER_MEMBER_DAILY = 10;
const STORY_REVIEW_GLOBAL_DAILY = 300;
const STORY_REVIEW_TIMEOUT_MS = 20_000;
// Same model as search-ai.mts's fallback, so the usage page's single Anthropic price entry stays right.
const STORY_REVIEW_MODEL = process.env.STORY_REVIEW_MODEL || 'claude-sonnet-5';

async function loadStory(personId: string): Promise<any | null> {
  const rows = await select('member_stories', STORY_COLUMNS, `person_id=eq.${personId}`);
  return rows[0] ?? null;
}

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

async function handleStoryGet(req: Request): Promise<Response> {
  const who = await requireAcknowledgedMember(req);
  if ('error' in who) return who.error;
  try {
    return jsonResponse({ story: storyView(await loadStory(who.member.personId)), firstName: who.member.name.trim().split(/\s+/).find((w) => w.length > 1) ?? who.member.name });
  } catch (err) {
    console.error('[members-me] story load failed', err);
    return jsonResponse({ error: 'Server error' }, 500);
  }
}

async function handleStorySave(req: Request): Promise<Response> {
  const who = await requireAcknowledgedMember(req);
  if ('error' in who) return who.error;
  const body = await readJson(req);
  if (body === undefined) return jsonResponse({ error: 'Nothing to do.' }, 400);
  const checked = validateDraft(body);
  if (!checked.ok) return jsonResponse({ error: checked.error }, 400);

  // Upsert on the person: only the draft side is written, so text in review or live is untouched.
  // The draft's photo is changed only by the photo endpoints, so it is carried over, not overwritten.
  let existing: any = null;
  try {
    existing = await loadStory(who.member.personId);
  } catch (err) {
    console.error('[members-me] story load failed', err);
    return jsonResponse({ error: 'Could not save your draft. Try again.' }, 500);
  }
  const res = await fetch(`${supabaseUrl()}/rest/v1/member_stories?on_conflict=person_id&select=${STORY_COLUMNS}`, {
    method: 'POST',
    headers: restHeaders({ Prefer: 'resolution=merge-duplicates,return=representation' }),
    body: JSON.stringify({ person_id: who.member.personId, draft: withStoredPhoto(checked.draft, existing?.draft), draft_public: checked.showOnPublicSite, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) {
    console.error('[members-me] story save failed', res.status);
    return jsonResponse({ error: 'Could not save your draft. Try again.' }, 500);
  }
  const rows = await res.json();
  return jsonResponse({ story: storyView(rows[0]) });
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

async function handleStorySubmit(req: Request): Promise<Response> {
  const who = await requireAcknowledgedMember(req);
  if ('error' in who) return who.error;
  const { member } = who;

  let row: any;
  try {
    row = await loadStory(member.personId);
  } catch (err) {
    console.error('[members-me] story load failed', err);
    return jsonResponse({ error: 'Server error' }, 500);
  }
  if (!row) return jsonResponse({ error: 'Save your story first.' }, 409);
  const ok = validateForSubmit(row.draft);
  if (!ok.ok) return jsonResponse({ error: ok.error }, 400);
  if (!storyView(row).hasUnsubmittedChanges) return jsonResponse({ error: 'There is nothing new to submit.' }, 409);

  // Logged before the change, and refused if it can't be, as for every self-service change.
  const log = await fetch(`${supabaseUrl()}/rest/v1/member_audit_log`, {
    method: 'POST',
    headers: restHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify({ actor_person_id: member.personId, action: 'member.story.submit', detail: storyAuditDetail(row.draft, row.draft_public) }),
  }).catch(() => null);
  if (!log || !log.ok) {
    console.error('[members-me] audit log write failed; story submit refused', log?.status);
    return jsonResponse({ error: 'Could not record this, so nothing was submitted. Try again.' }, 500);
  }

  const res = await fetch(`${supabaseUrl()}/rest/v1/member_stories?person_id=eq.${member.personId}&select=${STORY_COLUMNS}`, {
    method: 'PATCH',
    headers: restHeaders({ Prefer: 'return=representation' }),
    body: JSON.stringify({
      status: 'in_review',
      submitted: row.draft,
      submitted_public: !!row.draft_public,
      submitted_at: new Date().toISOString(),
      reviewer_note: null,
      updated_at: new Date().toISOString(),
    }),
  });
  if (!res.ok) {
    console.error('[members-me] story submit failed', res.status);
    return jsonResponse({ error: 'Server error' }, 500);
  }
  const rows = await res.json();
  await dropIfUnreferenced(member.personId, row.submitted?.photo, rows[0]); // the earlier submission's photo, if nothing else uses it
  // Assessed for risk (lib/story-risk.ts). In shadow mode that only records what it would have done; once switched
  // to live a low-risk story is approved here, so the member is shown where it ended up.
  let current = rows[0];
  const { approved } = await assessSubmission(rows[0], member.name);
  if (approved) current = (await loadStory(member.personId)) ?? current;
  return jsonResponse({ story: storyView(current) });
}

// ---- story photos -----------------------------------------------------------

const PHOTO_UPLOADS_PER_DAY = 10;
const PHOTO_STORE = 'member-story-photo';

// Delete an uploaded photo's files once no copy of the story refers to it any more.
async function dropIfUnreferenced(personId: string, photoId: unknown, row: any): Promise<void> {
  if (!isUploadedPhoto(photoId)) return;
  const stillUsed = [row?.draft, row?.submitted, row?.approved].some((copy) => copy?.photo === photoId);
  if (!stillUsed) await deleteMemberPhoto(personId, photoId as string).catch((err) => console.error('[members-me] photo cleanup failed', err));
}

async function writeDraftPhoto(personId: string, photo: string): Promise<{ before: any; after: any }> {
  const before = await loadStory(personId);
  const draft = { ...(before?.draft ?? {}), photo };
  if (!photo) delete (draft as any).photo;
  const res = await fetch(`${supabaseUrl()}/rest/v1/member_stories?on_conflict=person_id&select=${STORY_COLUMNS}`, {
    method: 'POST',
    headers: restHeaders({ Prefer: 'resolution=merge-duplicates,return=representation' }),
    body: JSON.stringify({ person_id: personId, draft, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`photo draft write failed: ${res.status}`);
  return { before, after: (await res.json())[0] };
}

async function handleStoryPhoto(req: Request): Promise<Response> {
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
  // Refuse the oversized before reading them.
  if (square.size > MAX_SQUARE_BYTES || full.size > MAX_FULL_BYTES) return jsonResponse({ error: 'That photo is too large. Try a smaller one.' }, 413);
  const squareBytes = new Uint8Array(await square.arrayBuffer());
  const fullBytes = new Uint8Array(await full.arrayBuffer());
  // What is stored is what comes back from the check, with every metadata block removed (not the bytes that were uploaded).
  const checked: { ok: boolean; error?: string; square?: Uint8Array; full?: Uint8Array } = validatePhotoPair(squareBytes, fullBytes);
  if (!checked.ok) return jsonResponse({ error: checked.error }, 415);

  try {
    if (!(await checkDailyCap(PHOTO_STORE, `member-${member.personId}`, PHOTO_UPLOADS_PER_DAY))) {
      return jsonResponse({ error: 'You have uploaded a lot of photos today. Please try again tomorrow.' }, 429);
    }
    const photoId = crypto.randomUUID();
    await putMemberPhoto(member.personId, photoId, checked.square!, checked.full!); // the files first, so the draft never points at nothing
    const { before, after } = await writeDraftPhoto(member.personId, photoId);
    await dropIfUnreferenced(member.personId, before?.draft?.photo, after); // the draft's earlier photo, if nothing else uses it
    return jsonResponse({ story: storyView(after) });
  } catch (err) {
    console.error('[members-me] story photo upload failed', err);
    return jsonResponse({ error: 'Could not save your photo. Try again.' }, 500);
  }
}

async function handleStoryPhotoRemove(req: Request): Promise<Response> {
  const who = await requireAcknowledgedMember(req);
  if ('error' in who) return who.error;
  try {
    const { before, after } = await writeDraftPhoto(who.member.personId, '');
    await dropIfUnreferenced(who.member.personId, before?.draft?.photo, after);
    return jsonResponse({ story: storyView(after) });
  } catch (err) {
    console.error('[members-me] story photo remove failed', err);
    return jsonResponse({ error: 'Could not remove your photo. Try again.' }, 500);
  }
}

// One uploaded photo. 404 for everything not allowed, so the response never says whether a photo exists.
async function handlePhoto(req: Request): Promise<Response> {
  const who = await requireAcknowledgedMember(req);
  if ('error' in who) return who.error;
  const url = new URL(req.url);
  const id = url.searchParams.get('id') ?? '';
  const size = url.searchParams.get('size') === 'full' ? 'full' : 'square';
  const notFound = () => new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  if (!isUploadedPhoto(id)) return notFound();
  try {
    const rows = await select('member_stories', 'person_id,draft,submitted,approved', `or=(draft->>photo.eq.${id},submitted->>photo.eq.${id},approved->>photo.eq.${id})`);
    const row = rows[0];
    if (!row) return notFound();
    const [person] = await select('member_people', 'id,active,directory_visible', `id=eq.${row.person_id}`);
    const listed = !!person && person.active !== false && person.directory_visible !== false;
    if (!photoAccess({ viewerPersonId: who.member.personId, row, photoId: id, listed })) return notFound();
    const bytes = await getMemberPhoto(row.person_id, id, size);
    if (!bytes) return notFound();
    return new Response(bytes, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' } });
  } catch (err) {
    console.error('[members-me] photo load failed', err);
    return jsonResponse({ error: 'Server error' }, 500);
  }
}

// ---- unit stories ------------------------------------------------------------
// One story per UNIT (member_unit_stories, migration 0049): bio, family, photos and the public switch are
// shared by the unit's owners; each person keeps their own quote and profile link. The rules are in
// scripts/lib/member-unit-story.mjs. Nothing in the portal calls these yet: the admin queue, risk
// assessment, public export and directory still read member_stories until they move over.

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
    // Per person (member_stories) or per unit (member_unit_stories): the cutover switch, off until the move is done.
    const live = await unitStoriesLive();
    const [people, memberships, households, stories] = await Promise.all([
      select('member_people', 'id,full_name,active,directory_visible', 'active=eq.true&directory_visible=eq.true'),
      select('member_household_members', 'household_id,person_id,role', 'person_id=not.is.null'),
      select('member_households', 'id,farm_unit,house_no,cluster', 'id=not.is.null'),
      live ? select('member_unit_stories', 'household_id,approved,approved_public', 'approved=not.is.null') : select('member_stories', 'person_id,approved,approved_public', 'approved=not.is.null'),
    ]);
    // `unitPhotos` tells the page which endpoint serves the photos: a unit's, or a person's.
    return jsonResponse(live
      ? { unitPhotos: true, households: buildUnitDirectory({ people, memberships, households, unitStories: stories }, who.member.personId) }
      : { households: buildDirectory({ people, memberships, households, stories }, who.member.personId) });
  } catch (err) {
    console.error('[members-me] directory load failed', err);
    return jsonResponse({ error: 'Server error' }, 500);
  }
}

export default async (req: Request): Promise<Response> => {
  const { pathname } = new URL(req.url);
  if (pathname === '/api/members-me/home' && req.method === 'GET') return handleHome(req);
  if (pathname === '/api/members-me/profile' && req.method === 'POST') return handleProfile(req);
  if (pathname === '/api/members-me/privacy' && req.method === 'POST') return handlePrivacy(req);
  if (pathname === '/api/members-me/land-shapes' && req.method === 'GET') return handleLandShapes(req);
  if (pathname === '/api/members-me/land-document-link' && req.method === 'POST') return handleLandDocumentLink(req);
  if (pathname === '/api/members-me/land-documents' && (req.method === 'GET' || req.method === 'POST')) return handleLandDocuments(req);
  if (pathname === '/api/members-me/directory' && req.method === 'GET') return handleDirectory(req);
  if (pathname === '/api/members-me/photo' && req.method === 'GET') return handlePhoto(req);
  if (pathname === '/api/members-me/story-photo' && req.method === 'POST') return handleStoryPhoto(req);
  if (pathname === '/api/members-me/story-photo-remove' && req.method === 'POST') return handleStoryPhotoRemove(req);
  if (pathname === '/api/members-me/story' && req.method === 'GET') return handleStoryGet(req);
  if (pathname === '/api/members-me/story' && req.method === 'POST') return handleStorySave(req);
  if (pathname === '/api/members-me/story-review' && req.method === 'POST') return handleStoryReview(req);
  if (pathname === '/api/members-me/story-submit' && req.method === 'POST') return handleStorySubmit(req);
  if (pathname === '/api/members-me/unit-story' && req.method === 'GET') return handleUnitStoryGet(req);
  if (pathname === '/api/members-me/unit-story' && req.method === 'POST') return handleUnitStorySave(req);
  if (pathname === '/api/members-me/unit-story-submit' && req.method === 'POST') return handleUnitStorySubmit(req);
  if (pathname === '/api/members-me/unit-story-photo' && req.method === 'POST') return handleUnitStoryPhoto(req);
  if (pathname === '/api/members-me/unit-story-photo-remove' && req.method === 'POST') return handleUnitStoryPhotoRemove(req);
  if (pathname === '/api/members-me/unit-photo' && req.method === 'GET') return handleUnitPhoto(req);
  return jsonResponse({ error: 'Not found' }, 404);
};

export const config = { path: ['/api/members-me/home', '/api/members-me/profile', '/api/members-me/privacy', '/api/members-me/land-documents', '/api/members-me/land-document-link', '/api/members-me/land-shapes', '/api/members-me/story', '/api/members-me/story-review', '/api/members-me/story-submit', '/api/members-me/directory', '/api/members-me/photo', '/api/members-me/story-photo', '/api/members-me/story-photo-remove', '/api/members-me/unit-story', '/api/members-me/unit-story-submit', '/api/members-me/unit-story-photo', '/api/members-me/unit-story-photo-remove', '/api/members-me/unit-photo'] };
