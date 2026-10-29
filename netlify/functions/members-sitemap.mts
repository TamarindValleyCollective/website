// Netlify Function (v2 API) behind "Site map" in the member portal (members.tvc.farm): every home drawn on the site plan,
// with who it belongs to and what type it is. Read-only for members; admins change the layout from the admin portal.
//
//   GET /api/members-me/site-map    the clusters (plot lines, view box, base size) and every home with what this member may see
//
// What a member may see of each home follows the directory exactly (scripts/lib/site-map.mjs, tested there): names only for
// people who are active and have not opted out, never an email, phone or land record. The whole feature is dark until
// MEMBER_SITE_MAP_ENABLED=true (everyone), or for the households a super admin lists under Units -> Early access
// (member_feature_access, feature 'site_map'): anyone else gets "Not found", so the page is not even revealed.
import { requireMember } from './lib/member-access';
import { privacyNoticeRequired } from '../../scripts/lib/member-privacy.mjs';
import { restHeaders } from '../../scripts/lib/supabase.mjs';
import { featureOn } from '../../scripts/lib/member-features.mjs';
import { buildSiteMap, shapeClusters } from '../../scripts/lib/site-map.mjs';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

function base(): string {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error('Missing SUPABASE_URL');
  return `${url}/rest/v1`;
}

async function select(table: string, query: string): Promise<any[]> {
  const res = await fetch(`${base()}/${table}?${query}`, { headers: restHeaders() });
  if (!res.ok) throw new Error(`${table} select failed: ${res.status}`);
  return res.json();
}

// On for everyone when MEMBER_SITE_MAP_ENABLED is "true"; otherwise only for a household a super admin has listed.
async function siteMapOn(householdId: string | undefined): Promise<boolean> {
  if (featureOn(process.env.MEMBER_SITE_MAP_ENABLED, false)) return true;
  if (!householdId) return false;
  const rows = await select('member_feature_access', `household_id=eq.${householdId}&feature=eq.site_map&select=feature`);
  return featureOn(process.env.MEMBER_SITE_MAP_ENABLED, rows.length > 0);
}

async function handleGet(req: Request): Promise<Response> {
  const auth = await requireMember(req);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
  if (privacyNoticeRequired(auth.member.privacyVersion)) return jsonResponse({ error: 'Please read the privacy notice first.' }, 403);
  const householdId = auth.member.householdIds[0];
  if (!(await siteMapOn(householdId))) return jsonResponse({ error: 'Not found' }, 404);

  // Only the columns the page may show: ids and names, no email, phone or land fields.
  const [clusters, units, households, people, memberships] = await Promise.all([
    select('site_map_clusters', 'select=cluster,base_size,view_box,plot_path&order=cluster.asc'),
    select('site_map_units', 'select=house_no,cluster,shape,x,y,rotation,mirror_x,mirror_y&order=house_no.asc'),
    select('member_households', 'house_no=not.is.null&select=id,farm_unit,house_no,unit_type'),
    select('member_people', 'select=id,full_name,active,directory_visible'),
    select('member_household_members', 'select=household_id,person_id,role'),
  ]);
  return jsonResponse({ enabled: true, clusters: shapeClusters(clusters), units: buildSiteMap({ units, households, people, memberships }, householdId ?? null) });
}

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'GET') return jsonResponse({ error: 'Not found' }, 404);
  try {
    return await handleGet(req);
  } catch (err) {
    console.error('[members-sitemap] request failed', err);
    return jsonResponse({ error: 'Server error' }, 500);
  }
};

export const config = { path: '/api/members-me/site-map' };
