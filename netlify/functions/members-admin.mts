// Netlify Function (v2 API) backing the internal member register review
// (src/pages/internal/members.astro): step 1 of the member portal, a read-only
// look at the households, people and patta details imported from the workbook,
// with the data gaps an admin should fix. See docs/plans/member-portal.md.
//
// Auth: Google Sign-In client-side; requireStaff (lib/staff-access.ts) checks
// the caller's role in the `members` module on every request.
//
// Privacy: this is server-side masking, not UI. Email addresses and phone
// numbers are never returned for any role — only whether one is on file.
// Personal names go out in full to `admin`/`user` and masked for `read_only`
// (staff-masking.ts). Plots are land records and go to every role that can view.
import { requireStaff } from './lib/staff-access';
import { canSeeNames, maskName } from './lib/staff-masking';
import { restHeaders } from '../../scripts/lib/supabase.mjs';
import { buildHouseholdReview, reviewTotals } from '../../scripts/lib/member-review.mjs';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

// Plain per-table selects, no PostgREST embeds (ambiguous foreign keys have
// broken the admin pages before; see staff-access.ts).
async function select(table: string, columns: string): Promise<any[]> {
  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl) throw new Error('Missing SUPABASE_URL');
  const res = await fetch(`${supabaseUrl}/rest/v1/${table}?select=${columns}&limit=2000`, { headers: restHeaders() });
  if (!res.ok) throw new Error(`${table} select failed: ${res.status}`);
  return res.json();
}

async function handleOverview(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'members', 'view');
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);

  let data;
  try {
    const [households, people, memberships, plots, housePattas, notes] = await Promise.all([
      select('member_households', 'id,farm_unit,house_no,cluster,unit_type'),
      select('member_people', 'id,full_name,email,phone'),
      select('member_household_members', 'household_id,person_id,role,can_login'),
      select('member_plots', 'household_id,patta_no,reference_no,survey_no,area_hectares,area_acres,settlement'),
      select('member_house_pattas', 'household_id,patta_no,reference_no,survey_no,area_sq_ft,settlement'),
      select('member_household_notes', 'household_id,kind'),
    ]);
    data = { households, people, memberships, plots, housePattas, notes };
  } catch (err) {
    console.error('[members-admin] failed to load the register', err);
    return jsonResponse({ error: 'Server error' }, 500);
  }

  const reviewed = buildHouseholdReview(data);
  const showNames = canSeeNames(auth.staff.role);
  const households = reviewed.map((h: any) => ({
    ...h,
    people: h.people.map((p: any) => ({ ...p, name: showNames ? p.name : maskName(p.name) })),
  }));
  return jsonResponse({ totals: reviewTotals(reviewed), households, namesMasked: !showNames });
}

export default async (req: Request): Promise<Response> => {
  const { pathname } = new URL(req.url);
  if (pathname === '/api/members-admin/overview' && req.method === 'GET') return handleOverview(req);
  return jsonResponse({ error: 'Not found' }, 404);
};

export const config = { path: ['/api/members-admin/overview'] };
