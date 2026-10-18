// Netlify Function (v2 API) behind the member portal (src/pages/members/index.astro):
// what a signed-in member sees and may change about THEIR OWN membership.
//
//   GET  /api/members-me/home     their household(s) and their own details
//   POST /api/members-me/profile  change their mobile number / directory listing
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
// goes through the core team. Every self-service change is written to
// member_audit_log BEFORE it is applied, and refused if that write fails.
import { requireMember } from './lib/member-access';
import { restHeaders } from '../../scripts/lib/supabase.mjs';
import { buildHouseholdReview } from '../../scripts/lib/member-review.mjs';
import { validateProfileEdit, profileAuditDetail } from '../../scripts/lib/member-profile.mjs';

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

  let data;
  try {
    const hh = inList(member.householdIds);
    const [households, memberships, plots, housePattas, notes] = await Promise.all([
      select('member_households', 'id,farm_unit,house_no,cluster,unit_type', `id=in.${hh}`),
      select('member_household_members', 'household_id,person_id,role,can_login', `household_id=in.${hh}`),
      select('member_plots', 'id,household_id,patta_no,reference_no,survey_no,area_hectares,area_acres,settlement', `household_id=in.${hh}`),
      select('member_house_pattas', 'id,household_id,patta_no,reference_no,survey_no,area_sq_ft,settlement', `household_id=in.${hh}`),
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

export default async (req: Request): Promise<Response> => {
  const { pathname } = new URL(req.url);
  if (pathname === '/api/members-me/home' && req.method === 'GET') return handleHome(req);
  if (pathname === '/api/members-me/profile' && req.method === 'POST') return handleProfile(req);
  return jsonResponse({ error: 'Not found' }, 404);
};

export const config = { path: ['/api/members-me/home', '/api/members-me/profile'] };
