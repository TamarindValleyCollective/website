// Netlify Function (v2 API) backing the internal member register
// (src/pages/internal/members.astro): the households, people and patta details
// imported from the workbook (step 1), and staff edits to them. See
// docs/plans/member-portal.md.
//
// Auth: Google Sign-In client-side; requireStaff (lib/staff-access.ts) checks
// the caller's role in the `members` module on every request. Roles and what
// they may do are in staff-registry.ts: `view` (everyone), `edit` (user, admin:
// a person's name, email, phone), `manage` (admin: household membership, house
// and cluster, patta records).
//
// Privacy: this is server-side masking, not UI. Email addresses and phone
// numbers are never returned for any role — only whether one is on file — so
// they are write-only: an editor can replace or clear one but never read it.
// Personal names go out in full to `admin`/`user` and masked for `read_only`
// (staff-masking.ts). Plots are land records and go to every role that can view.
//
// Stories: members write a story about themselves (member_stories) and submit it for review.
// GET stories lists what is waiting (`edit`); story.approve / story.reject (in /edit, `manage`)
// record the decision. Approving copies the submitted text to the approved copy, which is the
// only copy anything may publish; rejecting needs a note the member sees and leaves any
// earlier approved text live. The reviewer also sees which submission they looked at, so a
// member who resubmits meanwhile can't have newer wording approved unseen.
//
// Land documents: members upload a patta / survey extract and it is read in the background
// (members-land-extract-background.mts). New records and anything that disagrees with the
// register wait here: GET land-documents lists them for a household, POST land-document-link
// returns a one-minute signed link to the file (logged), and landdoc.approve / landdoc.reject
// (in /edit) record the core team's decision on each record.
//
// Edits: every change is validated (scripts/lib/member-edit.mjs), written to
// the audit log FIRST (and refused if the log write fails), then applied. The
// audit entry names the records and fields touched, never a name, email, phone
// or land number.
import { requireStaff, logStaffAction } from './lib/staff-access';
import { backfillLandShapes } from './lib/land-shape-backfill';
import { canSeeNames, maskName } from './lib/staff-masking';
import { roleHasCapability } from './lib/staff-registry';
import { restHeaders } from '../../scripts/lib/supabase.mjs';
import { buildHouseholdReview, reviewTotals } from '../../scripts/lib/member-review.mjs';
import { ACTION_CAPABILITY, auditDetail, validateEdit } from '../../scripts/lib/member-edit.mjs';
import { loadLandShapes, signedLandDocumentUrl } from './lib/land-doc-storage';
import { approvalColumns, documentStatus } from '../../scripts/lib/member-land-docs.mjs';
import { localChecks } from '../../scripts/lib/member-story.mjs';
import { isLegacyPhoto, isUploadedPhoto } from '../../scripts/lib/member-photo.mjs';
import { deleteMemberPhoto, getMemberPhoto } from './lib/member-photo-storage';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

function supabaseUrl(): string {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error('Missing SUPABASE_URL');
  return url;
}

// Plain per-table selects, no PostgREST embeds (ambiguous foreign keys have
// broken the admin pages before; see staff-access.ts).
async function select(table: string, columns: string, filter = ''): Promise<any[]> {
  const res = await fetch(`${supabaseUrl()}/rest/v1/${table}?select=${columns}${filter}&limit=2000`, { headers: restHeaders() });
  if (!res.ok) throw new Error(`${table} select failed: ${res.status}`);
  return res.json();
}

// ---- overview ---------------------------------------------------------------

async function handleOverview(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'members', 'view');
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);

  let data;
  let waiting: any[] = [];
  try {
    const [households, people, memberships, plots, housePattas, notes, waitingDocs] = await Promise.all([
      select('member_households', 'id,farm_unit,house_no,cluster,unit_type'),
      select('member_people', 'id,full_name,email,phone'),
      select('member_household_members', 'household_id,person_id,role,can_login'),
      select('member_plots', 'id,household_id,patta_no,reference_no,survey_no,area_hectares,area_acres,settlement,verification,source_document_id'),
      select('member_house_pattas', 'id,household_id,patta_no,reference_no,survey_no,area_sq_ft,settlement,verification,source_document_id'),
      select('member_household_notes', 'household_id,kind'),
      select('member_land_documents', 'household_id', '&status=eq.needs_review'),
    ]);
    data = { households, people, memberships, plots, housePattas, notes };
    waiting = waitingDocs;
  } catch (err) {
    console.error('[members-admin] failed to load the register', err);
    return jsonResponse({ error: 'Server error' }, 500);
  }

  const reviewed = buildHouseholdReview(data);
  for (const h of reviewed) {
    const n = waiting.filter((d) => d.household_id === h.id).length;
    if (n > 0) h.flags.unshift({ kind: 'land_review', severity: 'warn', text: `${n} land document${n === 1 ? '' : 's'} waiting for review.` });
  }
  const role = auth.staff.role;
  const showNames = canSeeNames(role);
  const households = reviewed.map((h: any) => ({
    ...h,
    people: h.people.map((p: any) => ({ ...p, name: showNames ? p.name : maskName(p.name) })),
  }));
  return jsonResponse({
    totals: reviewTotals(reviewed),
    households,
    namesMasked: !showNames,
    // What this person may do, so the page only offers editing that will work.
    can: { edit: roleHasCapability('members', role, 'edit'), manage: roleHasCapability('members', role, 'manage') },
  });
}

// ---- edits ------------------------------------------------------------------

class EditError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

type Db = { ok: boolean; status: number; rows: any[]; code?: string };

async function db(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<Db> {
  const res = await fetch(`${supabaseUrl()}/rest/v1/${path}`, {
    method,
    headers: restHeaders({ Prefer: 'return=representation' }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // leave null
  }
  if (res.ok) return { ok: true, status: res.status, rows: Array.isArray(parsed) ? parsed : [] };
  return { ok: false, status: res.status, rows: [], code: parsed?.code };
}

// Turns a failed write into a message that is safe to show. It never says who
// else holds an email or a house, only that it is taken.
function failure(result: Db, taken: string): EditError {
  if (result.code === '23505') return new EditError(taken, 409);
  if (result.code === '23503') return new EditError("That record or household doesn't exist any more. Reload the page.", 409);
  if (result.code === '23514') return new EditError("One of those values isn't allowed.", 400);
  // The database refuses a third person who can sign in (trigger on member_household_members).
  if (result.code === 'P0001') return new EditError('A household can have at most two people who can sign in. Remove sign-in from someone else first.', 409);
  console.error('[members-admin] write failed', result.status, result.code);
  return new EditError('Server error', 500);
}

const must = (result: Db, taken = 'That conflicts with an existing record.'): Db => {
  if (!result.ok) throw failure(result, taken);
  return result;
};

const eq = (column: string, value: string) => `${column}=eq.${encodeURIComponent(value)}`;

const EMAIL_TAKEN = 'That email address is already used by someone else in the register.';
const HOUSE_TAKEN = 'That house number already belongs to another household.';

// Maps the validated camelCase fields to table columns, for the fields present.
function columns(edit: Record<string, any>, map: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, column] of Object.entries(map)) if (field in edit) out[column] = edit[field];
  return out;
}

const PERSON_COLUMNS = { fullName: 'full_name', email: 'email', phone: 'phone' };
const PLOT_COLUMNS = { pattaNo: 'patta_no', referenceNo: 'reference_no', surveyNo: 'survey_no', settlement: 'settlement', areaHectares: 'area_hectares', areaAcres: 'area_acres', householdId: 'household_id' };
const HOUSE_PATTA_COLUMNS = { pattaNo: 'patta_no', referenceNo: 'reference_no', surveyNo: 'survey_no', settlement: 'settlement', areaSqFt: 'area_sq_ft', householdId: 'household_id' };
const HOUSEHOLD_COLUMNS = { houseNo: 'house_no', cluster: 'cluster', unitType: 'unit_type' };

async function applyEdit(edit: any, staffId: string): Promise<void> {
  switch (edit.action) {
    case 'story.approve':
    case 'story.reject':
      return decideStory(edit, staffId);

    case 'landdoc.approve':
    case 'landdoc.reject':
      return decideLandItem(edit);

    case 'person.update': {
      const r = must(await db('PATCH', `member_people?${eq('id', edit.personId)}`, columns(edit, PERSON_COLUMNS)), EMAIL_TAKEN);
      if (r.rows.length === 0) throw new EditError("That person doesn't exist any more. Reload the page.", 404);
      return;
    }

    case 'person.add': {
      const created = must(await db('POST', 'member_people', { full_name: edit.fullName, ...columns(edit, { email: 'email', phone: 'phone' }) }), EMAIL_TAKEN);
      const personId = created.rows[0]?.id;
      if (!personId) throw new EditError('Server error', 500);
      const link = await db('POST', 'member_household_members', { household_id: edit.householdId, person_id: personId, role: edit.role });
      if (!link.ok) {
        await db('DELETE', `member_people?${eq('id', personId)}`); // don't leave a person with no household
        throw failure(link, 'That person is already in that household.');
      }
      return;
    }

    case 'membership.update': {
      const r = must(await db('PATCH', `member_household_members?${eq('household_id', edit.householdId)}&${eq('person_id', edit.personId)}`, { role: edit.role }));
      if (r.rows.length === 0) throw new EditError("That person isn't in that household any more. Reload the page.", 404);
      return;
    }

    case 'membership.move': {
      // Add to the new household first, then remove from the old, so a failure
      // part-way can only leave the person in both, never in neither.
      const current = await select('member_household_members', 'role', `&${eq('household_id', edit.fromHouseholdId)}&${eq('person_id', edit.personId)}`);
      if (current.length === 0) throw new EditError("That person isn't in that household any more. Reload the page.", 404);
      const added = await db('POST', 'member_household_members', { household_id: edit.toHouseholdId, person_id: edit.personId, role: current[0].role });
      if (!added.ok) throw failure(added, 'That person is already in that household.');
      must(await db('DELETE', `member_household_members?${eq('household_id', edit.fromHouseholdId)}&${eq('person_id', edit.personId)}`));
      return;
    }

    case 'membership.invite': {
      if (edit.canLogin) {
        // Sign-in is by email, so a person with none on file can't be invited.
        const rows = await select('member_people', 'email,active', `&${eq('id', edit.personId)}`);
        if (rows.length === 0) throw new EditError("That person doesn't exist any more. Reload the page.", 404);
        if (!rows[0].email) throw new EditError('Add an email address for this person first: it is how they sign in.', 400);
        if (rows[0].active === false) throw new EditError('This person is inactive. Add them to a household again first.', 400);
      }
      const r = must(await db('PATCH', `member_household_members?${eq('household_id', edit.householdId)}&${eq('person_id', edit.personId)}`, { can_login: edit.canLogin }));
      if (r.rows.length === 0) throw new EditError("That person isn't in that household any more. Reload the page.", 404);
      return;
    }

    case 'membership.remove': {
      const r = must(await db('DELETE', `member_household_members?${eq('household_id', edit.householdId)}&${eq('person_id', edit.personId)}`));
      if (r.rows.length === 0) throw new EditError("That person isn't in that household any more. Reload the page.", 404);
      await deactivateIfOrphaned(edit.personId);
      return;
    }

    case 'household.update': {
      const r = must(await db('PATCH', `member_households?${eq('id', edit.householdId)}`, columns(edit, HOUSEHOLD_COLUMNS)), HOUSE_TAKEN);
      if (r.rows.length === 0) throw new EditError("That household doesn't exist any more. Reload the page.", 404);
      return;
    }

    case 'plot.create':
      must(await db('POST', 'member_plots', { household_id: edit.householdId, ...columns(edit, PLOT_COLUMNS) }));
      return;
    case 'plot.update': {
      const r = must(await db('PATCH', `member_plots?${eq('id', edit.plotId)}`, columns(edit, PLOT_COLUMNS)));
      if (r.rows.length === 0) throw new EditError("That record doesn't exist any more. Reload the page.", 404);
      return;
    }
    case 'plot.delete': {
      const r = must(await db('DELETE', `member_plots?${eq('id', edit.plotId)}`));
      if (r.rows.length === 0) throw new EditError("That record doesn't exist any more. Reload the page.", 404);
      return;
    }

    case 'housepatta.create':
      must(await db('POST', 'member_house_pattas', { household_id: edit.householdId, ...columns(edit, HOUSE_PATTA_COLUMNS) }));
      return;
    case 'housepatta.update': {
      const r = must(await db('PATCH', `member_house_pattas?${eq('id', edit.housePattaId)}`, columns(edit, HOUSE_PATTA_COLUMNS)));
      if (r.rows.length === 0) throw new EditError("That record doesn't exist any more. Reload the page.", 404);
      return;
    }
    case 'housepatta.delete': {
      const r = must(await db('DELETE', `member_house_pattas?${eq('id', edit.housePattaId)}`));
      if (r.rows.length === 0) throw new EditError("That record doesn't exist any more. Reload the page.", 404);
      return;
    }
  }
}

// A person with no household left is made inactive rather than deleted, so
// their details are kept and the change can be undone by adding them back.
async function deactivateIfOrphaned(personId: string): Promise<void> {
  const left = await select('member_household_members', 'household_id', `&${eq('person_id', personId)}`);
  if (left.length === 0) await db('PATCH', `member_people?${eq('id', personId)}`, { active: false });
}

// ---- land documents ---------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LAND_TABLES = { farm: { table: 'member_plots' }, house: { table: 'member_house_pattas' } } as const;

async function handleLandDocuments(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'members', 'view');
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
  const householdId = new URL(req.url).searchParams.get('householdId') ?? '';
  if (!UUID.test(householdId)) return jsonResponse({ error: 'householdId is missing or not valid.' }, 400);
  try {
    const docs = await select('member_land_documents', 'id,land_type,original_filename,mime_type,status,error,items,created_at,processed_at', `&household_id=eq.${householdId}&order=created_at.desc`);
    return jsonResponse({
      documents: docs.slice(0, 50).map((d) => ({
        id: d.id,
        landType: d.land_type,
        fileName: d.original_filename,
        mimeType: d.mime_type,
        status: d.status,
        error: d.error,
        uploadedAt: d.created_at,
        items: Array.isArray(d.items) ? d.items : [],
      })),
    });
  } catch (err) {
    console.error('[members-admin] land documents load failed', err);
    return jsonResponse({ error: 'Server error' }, 500);
  }
}

// A one-minute signed link to the stored file. Members' land documents are private, so
// this needs `manage` and every link handed out is logged.
async function handleLandDocumentLink(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'members', 'manage');
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
  let documentId = '';
  try {
    documentId = String((await req.json())?.documentId ?? '');
  } catch {
    // fall through
  }
  if (!UUID.test(documentId)) return jsonResponse({ error: 'documentId is missing or not valid.' }, 400);
  try {
    const [doc] = await select('member_land_documents', 'storage_path', `&${eq('id', documentId)}`);
    if (!doc) return jsonResponse({ error: "That document doesn't exist any more." }, 404);
    await logStaffAction({ actorId: auth.staff.id, action: 'members.landdoc.view', module: 'members', detail: { ids: { documentId } } });
    return jsonResponse({ url: await signedLandDocumentUrl(doc.storage_path, 60) });
  } catch (err) {
    console.error('[members-admin] land document link failed', err);
    return jsonResponse({ error: 'Server error' }, 500);
  }
}

// The parcel outlines of one household's documents, as { documentId: data URL }.
async function handleLandShapes(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'members', 'view');
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
  const householdId = new URL(req.url).searchParams.get('householdId') ?? '';
  if (!UUID.test(householdId)) return jsonResponse({ error: 'householdId is missing or not valid.' }, 400);
  try {
    const docs = await select('member_land_documents', 'id,storage_path,mime_type,extracted', `&household_id=eq.${householdId}`);
    await backfillLandShapes(docs);
    return jsonResponse({ shapes: await loadLandShapes(docs) });
  } catch (err) {
    console.error('[members-admin] land shapes load failed', err);
    return jsonResponse({ error: 'Server error' }, 500);
  }
}

// The core team's decision on one record read from a land document.
//   approve: the record behind the item takes the document's values and is marked verified
//   reject:  the register is left as it is; a record the member added from the document is removed
async function decideLandItem(edit: any): Promise<void> {
  const [doc] = await select('member_land_documents', 'id,land_type,items', `&${eq('id', edit.documentId)}`);
  if (!doc) throw new EditError("That document doesn't exist any more. Reload the page.", 404);
  const items: any[] = Array.isArray(doc.items) ? doc.items : [];
  const item = items[edit.itemIndex];
  if (!item || item.decision || !['pending', 'mismatch', 'check', 'conflict'].includes(item.outcome)) {
    throw new EditError('That record has already been dealt with. Reload the page.', 409);
  }
  const table = LAND_TABLES[doc.land_type as 'farm' | 'house'].table;
  const now = new Date().toISOString();

  if (edit.action === 'landdoc.approve') {
    if (item.outcome === 'conflict' || !item.recordId) {
      throw new EditError('Another household already holds this survey number, so it cannot be approved here. Sort that out in the register first, then reject this one.', 409);
    }
    const r = must(await db('PATCH', `${table}?${eq('id', item.recordId)}`, approvalColumns(item, doc.land_type, doc.id, now)));
    if (r.rows.length === 0) throw new EditError("The record behind this no longer exists. Reload the page.", 404);
  } else if (item.outcome === 'pending' && item.recordId) {
    // Only a record still waiting is removed; one staff already edited and verified is left alone.
    must(await db('DELETE', `${table}?${eq('id', item.recordId)}&verification=eq.pending_review`));
  }

  items[edit.itemIndex] = { ...item, decision: edit.action === 'landdoc.approve' ? 'approved' : 'rejected', decidedAt: now };
  must(await db('PATCH', `member_land_documents?${eq('id', doc.id)}`, { items, status: documentStatus(items) }));
}

// ---- stories ----------------------------------------------------------------

type StoryText = { bio: string; family: string; why: string; social: string; photo: string };
const storyText = (t: any): StoryText => {
  const text = { bio: '', family: '', why: '', social: '', photo: '', ...(t ?? {}) };
  // Only a uuid (an upload) or a path on the public site is ever passed on as a photo.
  if (!isUploadedPhoto(text.photo) && !isLegacyPhoto(text.photo)) text.photo = '';
  return text;
};

// What is waiting for review, oldest first. Plain selects (no embeds), then joined here.
async function handleStories(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'members', 'edit');
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
  try {
    const rows = await select('member_stories', 'person_id,submitted,submitted_public,submitted_at,approved,approved_public', '&status=eq.in_review&order=submitted_at.asc');
    if (rows.length === 0) return jsonResponse({ stories: [] });
    const ids = `(${rows.map((r) => r.person_id).join(',')})`;
    const [people, links] = await Promise.all([
      select('member_people', 'id,full_name', `&id=in.${ids}`),
      select('member_household_members', 'person_id,household_id', `&person_id=in.${ids}`),
    ]);
    const hhIds = [...new Set(links.map((l) => l.household_id))];
    const households = hhIds.length ? await select('member_households', 'id,farm_unit,house_no', `&id=in.(${hhIds.join(',')})`) : [];
    return jsonResponse({
      stories: rows.map((r) => {
        const submitted = storyText(r.submitted);
        const units = links
          .filter((l) => l.person_id === r.person_id)
          .map((l) => households.find((h) => h.id === l.household_id)?.farm_unit)
          .filter(Boolean);
        return {
          personId: r.person_id,
          name: people.find((p) => p.id === r.person_id)?.full_name ?? 'Unknown',
          farmUnits: units,
          submittedAt: r.submitted_at,
          submitted,
          submittedPublic: !!r.submitted_public,
          approved: r.approved ? storyText(r.approved) : null,
          approvedPublic: r.approved ? !!r.approved_public : null,
          // The same fixed checks the member saw (children named...), so the reviewer sees them too.
          flags: localChecks(submitted, !!r.submitted_public).map((f: any) => ({ field: f.field, kind: f.kind, note: f.note })),
        };
      }),
    });
  } catch (err) {
    console.error('[members-admin] stories load failed', err);
    return jsonResponse({ error: 'Server error' }, 500);
  }
}

// A photo in review (or an approved one), for the reviewer. Needs `edit`, like the queue. 404 for
// anything that is not a photo of a submitted or approved story.
async function handleStoryPhoto(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'members', 'edit');
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
  const url = new URL(req.url);
  const id = url.searchParams.get('id') ?? '';
  const size = url.searchParams.get('size') === 'full' ? 'full' : 'square';
  const notFound = () => new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  if (!isUploadedPhoto(id)) return notFound();
  try {
    const [row] = await select('member_stories', 'person_id', `&or=(submitted->>photo.eq.${id},approved->>photo.eq.${id})`);
    if (!row) return notFound();
    const bytes = await getMemberPhoto(row.person_id, id, size);
    if (!bytes) return notFound();
    return new Response(bytes, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=600', 'x-content-type-options': 'nosniff' } });
  } catch (err) {
    console.error('[members-admin] story photo load failed', err);
    return jsonResponse({ error: 'Server error' }, 500);
  }
}

async function decideStory(edit: any, staffId: string): Promise<void> {
  const [row] = await select('member_stories', 'person_id,status,draft,submitted,submitted_public,submitted_at,approved', `&${eq('person_id', edit.personId)}`);
  const stale = "This story has changed, or has already been dealt with. Reload the page.";
  if (!row || row.status !== 'in_review' || Date.parse(row.submitted_at) !== Date.parse(edit.submittedAt)) throw new EditError(stale, 409);
  const now = new Date().toISOString();
  const patch =
    edit.action === 'story.approve'
      ? { status: 'approved', approved: row.submitted, approved_public: row.submitted_public, approved_at: now, reviewed_by: staffId, reviewer_note: null, updated_at: now }
      : { status: 'rejected', reviewed_by: staffId, reviewer_note: edit.note, updated_at: now };
  // Filtered on the exact submission seen, so two reviewers, or a resubmission, can't both win.
  const r = must(await db('PATCH', `member_stories?${eq('person_id', edit.personId)}&status=eq.in_review&${eq('submitted_at', row.submitted_at)}`, patch));
  if (r.rows.length === 0) throw new EditError(stale, 409);
  // Approving replaces the live photo: the one it replaced goes once no copy refers to it.
  const replaced = row.approved?.photo;
  if (edit.action === 'story.approve' && isUploadedPhoto(replaced) && replaced !== row.submitted?.photo && replaced !== row.draft?.photo) {
    await deleteMemberPhoto(row.person_id, replaced).catch((err) => console.error('[members-admin] photo cleanup failed', err));
  }
}

async function handleEdit(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'members', 'view');
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Nothing to do.' }, 400);
  }
  // validateEdit is plain JS, so its { ok, edit | error } result isn't narrowed by TypeScript.
  const checked: { ok: boolean; edit?: any; error?: string } = validateEdit(body);
  if (!checked.ok) return jsonResponse({ error: checked.error }, 400);
  const edit = checked.edit;

  const capability = (ACTION_CAPABILITY as Record<string, 'edit' | 'manage'>)[edit.action];
  if (!roleHasCapability('members', auth.staff.role, capability)) return jsonResponse({ error: 'Not authorized' }, 403);

  // Logged before the change, and refused if it can't be, so no edit goes unrecorded.
  try {
    await logStaffAction({ actorId: auth.staff.id, action: `members.${edit.action}`, module: 'members', detail: auditDetail(edit) });
  } catch (err) {
    console.error('[members-admin] audit log write failed; edit refused', err);
    return jsonResponse({ error: 'Could not record the change, so nothing was changed. Try again.' }, 500);
  }

  try {
    await applyEdit(edit, auth.staff.id);
  } catch (err) {
    if (err instanceof EditError) return jsonResponse({ error: err.message }, err.status);
    console.error('[members-admin] edit failed', err);
    return jsonResponse({ error: 'Server error' }, 500);
  }
  return jsonResponse({ ok: true });
}

export default async (req: Request): Promise<Response> => {
  const { pathname } = new URL(req.url);
  if (pathname === '/api/members-admin/overview' && req.method === 'GET') return handleOverview(req);
  if (pathname === '/api/members-admin/edit' && req.method === 'POST') return handleEdit(req);
  if (pathname === '/api/members-admin/land-documents' && req.method === 'GET') return handleLandDocuments(req);
  if (pathname === '/api/members-admin/land-shapes' && req.method === 'GET') return handleLandShapes(req);
  if (pathname === '/api/members-admin/stories' && req.method === 'GET') return handleStories(req);
  if (pathname === '/api/members-admin/story-photo' && req.method === 'GET') return handleStoryPhoto(req);
  if (pathname === '/api/members-admin/land-document-link' && req.method === 'POST') return handleLandDocumentLink(req);
  return jsonResponse({ error: 'Not found' }, 404);
};

export const config = { path: ['/api/members-admin/overview', '/api/members-admin/edit', '/api/members-admin/land-documents', '/api/members-admin/land-document-link', '/api/members-admin/land-shapes', '/api/members-admin/stories', '/api/members-admin/story-photo'] };
