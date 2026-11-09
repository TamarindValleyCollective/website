// Netlify Function (v2 API) behind "Site map" in the member portal (members.tvc.farm): every home drawn on the site plan,
// with who it belongs to and what type it is. Read-only for members; admins change the layout from the admin portal.
//
//   GET /api/members-me/site-map    the clusters (plot lines, view box, base size) and every home with what this member may see
//
// What a member may see of each home follows the directory exactly (scripts/lib/site-map.mjs, tested there): names only for
// people who are active and have not opted out, never an email, phone or land record. Open to every signed-in member who has
// read the privacy notice.
import { requireMember } from './lib/member-access';
import { privacyNoticeRequired } from '../../scripts/lib/member-privacy.mjs';
import { restHeaders } from '../../scripts/lib/supabase.mjs';
import { buildSiteMap, mergeSheets, shapeClusters, SHEETS } from '../../scripts/lib/site-map.mjs';
import { groupPlacements, lineGroupPlacements, shapeAlignment, sheetsFromAlignments } from '../../scripts/lib/site-map-align.mjs';
import { detectGroups } from '../../scripts/lib/site-map-groups.mjs';

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

async function handleGet(req: Request): Promise<Response> {
  const auth = await requireMember(req);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
  if (privacyNoticeRequired(auth.member.privacyVersion)) return jsonResponse({ error: 'Please read the privacy notice first.' }, 403);
  const householdId = auth.member.householdIds[0];

  // Only the columns the page may show: ids and names, no email, phone or land fields.
  const [clusters, units, households, people, memberships, alignments, groupRows, lineRows] = await Promise.all([
    select('site_map_clusters', 'select=cluster,base_size,view_box,plot_path&order=cluster.asc'),
    select('site_map_units', 'select=house_no,cluster,shape,x,y,rotation,mirror_x,mirror_y&order=house_no.asc'),
    select('member_households', 'house_no=not.is.null&select=id,farm_unit,house_no,unit_type'),
    select('member_people', 'select=id,full_name,active,directory_visible'),
    select('member_household_members', 'select=household_id,person_id,role'),
    // How each plan page sits on the ground (a fit to Google's satellite map): only the numbers. Pages joined into one sheet are
    // placed from these once all of the sheet's pages have one; until then the defaults in SHEETS apply.
    select('site_map_alignment', 'select=cluster,a,b,tx,ty,origin_lat,origin_lng,rms,pairs,updated_at').catch(() => []),
    // The same for each group of homes that share walls (migration 0096): the home and its plot move with its group.
    select('site_map_group_alignment', 'select=group_key,houses,cluster,a,b,tx,ty,origin_lat,origin_lng,rms,pairs,updated_at').catch(() => []),
    // The placement of groups of lines on their own (migration 0097): until a group of lines has one it follows its homes.
    select('site_map_line_group_alignment', 'select=group_key,houses,cluster,a,b,tx,ty,origin_lat,origin_lng,updated_at').catch(() => []),
  ]);
  const mapUnits = buildSiteMap({ units, households, people, memberships }, householdId ?? null);
  const pageFits = alignments.map(shapeAlignment);
  // Each group of homes that share walls and has an alignment of its own moves, with its plot outlines, as that alignment says.
  const homes = groupPlacements(SHEETS, pageFits, groupRows.map(shapeAlignment), detectGroups(mapUnits, Object.fromEntries(clusters.map((c: any) => [c.cluster, Number(c.base_size)]))));
  const detected = detectGroups(mapUnits, Object.fromEntries(clusters.map((c: any) => [c.cluster, Number(c.base_size)])));
  const groupOfHome: Record<string, string> = {};
  for (const g of detected) for (const h of g.houses) groupOfHome[h] = g.key;
  // A group's lines (the boundary lines along its homes' plots), or a page's other lines, can be placed on their own; otherwise they follow their homes.
  const lineGroups = lineGroupPlacements(SHEETS, pageFits, lineRows.map(shapeAlignment), detected);
  const merged = mergeSheets(shapeClusters(clusters), mapUnits, sheetsFromAlignments(SHEETS, pageFits), { homes, groupOfHome, lineGroups });
  // Where each sheet sits on the ground (its first page's fit to the satellite map), so the page can draw it on Google's map:
  // only the numbers of the fit, never imagery. A sheet with no alignment has none and offers no satellite layer.
  const ground: Record<string, unknown> = {};
  for (const c of merged.clusters) {
    const page = SHEETS[c.id as keyof typeof SHEETS]?.[0]?.page ?? c.id;
    const fit = pageFits.find((f: any) => f.cluster === page);
    if (fit) ground[c.id] = { a: fit.a, b: fit.b, tx: fit.tx, ty: fit.ty, originLat: fit.originLat, originLng: fit.originLng };
  }
  return jsonResponse({ enabled: true, ...merged, ground });
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
