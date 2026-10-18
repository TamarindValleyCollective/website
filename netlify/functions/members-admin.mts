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
// Edits: every change is validated (scripts/lib/member-edit.mjs), written to
// the audit log FIRST (and refused if the log write fails), then applied. The
// audit entry names the records and fields touched, never a name, email, phone
// or land number.
import { requireStaff, logStaffAction } from './lib/staff-access';
import { canSeeNames, maskName } from './lib/staff-masking';
import { roleHasCapability } from './lib/staff-registry';
import { restHeaders } from '../../scripts/lib/supabase.mjs';
import { buildHouseholdReview, reviewTotals } from '../../scripts/lib/member-review.mjs';
import { ACTION_CAPABILITY, auditDetail, validateEdit } from '../../scripts/lib/member-edit.mjs';

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
  try {
    const [households, people, memberships, plots, housePattas, notes] = await Promise.all([
      select('member_households', 'id,farm_unit,house_no,cluster,unit_type'),
      select('member_people', 'id,full_name,email,phone'),
      select('member_household_members', 'household_id,person_id,role,can_login'),
      select('member_plots', 'id,household_id,patta_no,reference_no,survey_no,area_hectares,area_acres,settlement'),
      select('member_house_pattas', 'id,household_id,patta_no,reference_no,survey_no,area_sq_ft,settlement'),
      select('member_household_notes', 'household_id,kind'),
    ]);
    data = { households, people, memberships, plots, housePattas, notes };
  } catch (err) {
    console.error('[members-admin] failed to load the register', err);
    return jsonResponse({ error: 'Server error' }, 500);
  }

  const reviewed = buildHouseholdReview(data);
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

async function applyEdit(edit: any): Promise<void> {
  switch (edit.action) {
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
    await applyEdit(edit);
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
  return jsonResponse({ error: 'Not found' }, 404);
};

export const config = { path: ['/api/members-admin/overview', '/api/members-admin/edit'] };
