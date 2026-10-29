// Netlify Function (v2 API) behind the admin portal's Site map page (src/pages/internal/site-map.astro): every home on the
// site plan with the household behind it, the member record's unit type, the house plot size, and what is missing or
// disagrees. Read-only for now.
//
//   GET /api/site-map-admin/overview    the clusters and every home, plus households that name a house the map does not have
//
// Auth: requireStaff('site-map', 'view') on every request. The module is given by a super admin to the admins who should
// have it (Access), so only chosen admins reach it. Names are masked for the read-only role (staff-masking.ts); an email,
// phone or document is never selected, so none can leak. The shaping rules are in scripts/lib/site-map.mjs (tested there).
import { requireStaff } from './lib/staff-access';
import { canSeeNames, maskName } from './lib/staff-masking';
import { restHeaders } from '../../scripts/lib/supabase.mjs';
import { buildAdminSiteMap, shapeClusters } from '../../scripts/lib/site-map.mjs';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

async function select(table: string, query: string): Promise<any[]> {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error('Missing SUPABASE_URL');
  const res = await fetch(`${url}/rest/v1/${table}?${query}`, { headers: restHeaders() });
  if (!res.ok) throw new Error(`${table} select failed: ${res.status}`);
  return res.json();
}

async function handleOverview(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'site-map', 'view');
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);

  const [clusters, units, households, people, memberships, pattas] = await Promise.all([
    select('site_map_clusters', 'select=cluster,base_size,view_box,plot_path&order=cluster.asc'),
    select('site_map_units', 'select=house_no,cluster,shape,x,y,rotation,mirror_x,mirror_y&order=house_no.asc'),
    select('member_households', 'house_no=not.is.null&select=id,farm_unit,house_no,unit_type'),
    select('member_people', 'select=id,full_name,active'),
    select('member_household_members', 'select=household_id,person_id,role'),
    select('member_house_pattas', 'select=household_id,area_sq_ft'),
  ]);
  const map = buildAdminSiteMap({ units, households, people, memberships, pattas }, { seeNames: canSeeNames(auth.staff.role), maskName });
  return jsonResponse({ clusters: shapeClusters(clusters), ...map, namesMasked: !canSeeNames(auth.staff.role) });
}

export default async (req: Request): Promise<Response> => {
  const path = new URL(req.url).pathname;
  if (req.method !== 'GET' || path !== '/api/site-map-admin/overview') return jsonResponse({ error: 'Not found' }, 404);
  try {
    return await handleOverview(req);
  } catch (err) {
    console.error('[site-map-admin] request failed', err);
    return jsonResponse({ error: 'Server error' }, 500);
  }
};

export const config = { path: '/api/site-map-admin/overview' };
