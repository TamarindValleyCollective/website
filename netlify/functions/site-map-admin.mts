// Netlify Function (v2 API) behind the admin portal's Site map page (src/pages/internal/site-map.astro): every home on the
// site plan with the household behind it, the member record's unit type, the house plot size, and what is missing or
// disagrees; and, for admins, changing the layout.
//
//   GET  /api/site-map-admin/overview    the clusters and every home, plus households that name a house the map does not have
//   POST /api/site-map-admin/units       change the layout: { action: update | add | renumber | remove, houseNo, ... }
//   GET  /api/site-map-admin/alignment   each plan page's satellite alignment (the pairs and the fit)
//   POST /api/site-map-admin/alignment   save a page's alignment from its point pairs { cluster, pairs } (or { cluster, clear: true });
//                                        a pair is a spot on the plan page and its latitude and longitude on Google's satellite map.
//                                        With `group: { houses }` it is the alignment of a group of homes that share walls instead
//                                        (and `scale` locks its size to the other homes'); { groupKey, clear: true } removes one. With `lines: true`
//                                        it is the placement of a group of lines on their own (the white boundaries along `group`'s plots, or the
//                                        page's other lines when there is no group); { lineGroupKey, clear: true } removes one.
//
// Auth: requireStaff on every request. Viewing needs `site-map` / `view` (a super admin gives the module to the admins who
// should have it, on Access); changing the layout needs `site-map` / `edit` (admin role only), because every member sees
// the result. Names are masked for the read-only role (staff-masking.ts); an email, phone or document is never selected.
// The shaping rules are in scripts/lib/site-map.mjs and the edit rules in scripts/lib/site-map-edit.mjs (both tested).
//
// Every edit is written to staff_audit_log BEFORE it is made (house number and the changed plan values only, never a name),
// and if the entry cannot be written the edit is refused, the same as the member register. An update carries the row's
// updated_at as loaded and is refused if the row has changed since, so two admins cannot silently overwrite each other.
import { requireStaff, logStaffAction } from './lib/staff-access';
import { canSeeNames, maskName } from './lib/staff-masking';
import { roleHasCapability } from './lib/staff-registry';
import { restHeaders } from '../../scripts/lib/supabase.mjs';
import { buildAdminSiteMap, shapeClusters } from '../../scripts/lib/site-map.mjs';
import { auditDetail, validateEdit, CLUSTER_IDS } from '../../scripts/lib/site-map-edit.mjs';
import { auditAlignment, planToLocal, shapeAlignment, validateAlignment, withOrigin } from '../../scripts/lib/site-map-align.mjs';

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

const UNIT_COLUMNS = 'house_no,cluster,shape,x,y,rotation,mirror_x,mirror_y,updated_at';

async function handleOverview(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'site-map', 'view');
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);

  const [clusters, units, households, people, memberships, pattas] = await Promise.all([
    select('site_map_clusters', 'select=cluster,base_size,view_box,plot_path&order=cluster.asc'),
    select('site_map_units', `select=${UNIT_COLUMNS}&order=house_no.asc`),
    select('member_households', 'house_no=not.is.null&select=id,farm_unit,house_no,unit_type'),
    select('member_people', 'select=id,full_name,active,google_picture_url'),
    select('member_household_members', 'select=household_id,person_id,role'),
    select('member_house_pattas', 'select=household_id,area_sq_ft'),
  ]);
  const map = buildAdminSiteMap({ units, households, people, memberships, pattas }, { seeNames: canSeeNames(auth.staff.role), maskName });
  return jsonResponse({ clusters: shapeClusters(clusters), ...map, namesMasked: !canSeeNames(auth.staff.role), canEdit: roleHasCapability('site-map', auth.staff.role, 'edit') });
}

async function write(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<{ ok: boolean; status: number; rows: any[] }> {
  const res = await fetch(`${base()}/${path}`, { method, headers: restHeaders({ Prefer: 'return=representation' }), body: body === undefined ? undefined : JSON.stringify(body) });
  const rows = res.ok ? await res.json().catch(() => []) : [];
  return { ok: res.ok, status: res.status, rows };
}

async function handleUnits(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'site-map', 'edit');
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);

  let body: any = null;
  try {
    body = await req.json();
  } catch {
    // validateEdit answers for a missing body
  }
  const [units, households] = await Promise.all([select('site_map_units', `select=${UNIT_COLUMNS}`), select('member_households', 'house_no=not.is.null&select=house_no')]);
  const checked = validateEdit(body, { units, households });
  if ('error' in checked) return jsonResponse({ error: checked.error }, checked.status ?? 400);
  const { edit } = checked;

  // The audit entry comes first: no entry, no change.
  try {
    await logStaffAction({ actorId: auth.staff.id, action: `site-map.${edit.action}`, module: 'site-map', detail: auditDetail(edit) });
  } catch (err) {
    console.error('[site-map-admin] audit log write failed; edit refused', err);
    return jsonResponse({ error: 'Could not record the change, so nothing was changed. Try again.' }, 500);
  }

  const now = new Date().toISOString();
  const table = 'site_map_units';
  let done: { ok: boolean; status: number; rows: any[] };
  if (edit.action === 'add') done = await write('POST', table, edit.row);
  else if (edit.action === 'remove') done = await write('DELETE', `${table}?house_no=eq.${encodeURIComponent(edit.houseNo)}`);
  else if (edit.action === 'renumber') done = await write('PATCH', `${table}?house_no=eq.${encodeURIComponent(edit.houseNo)}`, { house_no: edit.newHouseNo, updated_at: now });
  else done = await write('PATCH', `${table}?house_no=eq.${encodeURIComponent(edit.houseNo)}&updated_at=eq.${encodeURIComponent(edit.version as string)}`, { ...edit.row, updated_at: now });

  if (done.status === 409) return jsonResponse({ error: 'That house number is already on the map. Reload and try again.' }, 409);
  if (!done.ok) {
    console.error('[site-map-admin] write failed', edit.action, done.status);
    return jsonResponse({ error: 'Server error' }, 500);
  }
  // A guarded update or a delete that matched nothing means the row changed or went while the edit was being made.
  if (edit.action !== 'add' && done.rows.length === 0) return jsonResponse({ error: `${edit.houseNo} was changed by someone else just now. Reload to see it.` }, 409);
  return jsonResponse({ ok: true });
}

// ---- Satellite alignment -----------------------------------------------------------------------------------------
// Each page's fit is made here from the pairs, so the stored numbers always follow from the stored pairs. Every page is fitted
// around one reference point (the first saved page's, or the new pairs' average for the first page), so the pages of a sheet
// can be compared. No map imagery is stored: the page shows Google's live map.
const ALIGNMENT_COLUMNS = 'cluster,a,b,tx,ty,origin_lat,origin_lng,rms,pairs,updated_at';
const GROUP_COLUMNS = `group_key,houses,locked_scale,${ALIGNMENT_COLUMNS}`;
const LINE_COLUMNS = 'group_key,houses,cluster,a,b,tx,ty,origin_lat,origin_lng,updated_at';

// The reference point every saved page and group is fitted around, so all of them share one frame. `exceptPage` / `exceptGroup`
// leave out the one being saved (re-aligning it may move it).
async function sharedOrigin(exceptPage: string | null, exceptGroup: string | null): Promise<{ lat: number; lng: number } | null> {
  const pages = await select('site_map_alignment', `select=origin_lat,origin_lng${exceptPage ? `&cluster=neq.${encodeURIComponent(exceptPage)}` : ''}&limit=1`);
  const row = pages[0] ?? (await select('site_map_group_alignment', `select=origin_lat,origin_lng${exceptGroup ? `&group_key=neq.${encodeURIComponent(exceptGroup)}` : ''}&limit=1`).catch(() => []))[0];
  return row ? { lat: Number(row.origin_lat), lng: Number(row.origin_lng) } : null;
}

async function handleAlignmentRead(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'site-map', 'view');
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
  const [rows, groups, lines] = await Promise.all([
    select('site_map_alignment', `select=${ALIGNMENT_COLUMNS}&order=cluster.asc`),
    // Group alignments (migration 0096): none until it is applied.
    select('site_map_group_alignment', `select=${GROUP_COLUMNS}&order=group_key.asc`).catch(() => []),
    // The placement of groups of lines on their own (migration 0097): none until it is applied.
    select('site_map_line_group_alignment', `select=${LINE_COLUMNS}&order=group_key.asc`).catch(() => []),
  ]);
  return jsonResponse({ alignments: rows.map(shapeAlignment), groups: groups.map(shapeAlignment), lines: lines.map(shapeAlignment), canEdit: roleHasCapability('site-map', auth.staff.role, 'edit') });
}

async function handleAlignmentWrite(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'site-map', 'edit');
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
  let body: any = null;
  try { body = await req.json(); } catch { /* validateAlignment answers for a missing body */ }

  if (body?.clear === true && typeof body.groupKey === 'string') {
    if (!/^[A-Z0-9-]+:H-\d{2}$/.test(body.groupKey)) return jsonResponse({ error: 'Pick a group.' }, 400);
    try {
      await logStaffAction({ actorId: auth.staff.id, action: 'site-map.group-alignment-clear', module: 'site-map', detail: { group: body.groupKey } });
    } catch (err) {
      console.error('[site-map-admin] audit log write failed; edit refused', err);
      return jsonResponse({ error: 'Could not record the change, so nothing was changed. Try again.' }, 500);
    }
    const gone = await write('DELETE', `site_map_group_alignment?group_key=eq.${encodeURIComponent(body.groupKey)}`);
    return gone.ok ? jsonResponse({ ok: true }) : jsonResponse({ error: 'Server error' }, 500);
  }

  if (body?.clear === true && typeof body.lineGroupKey === 'string') {
    if (!/^[A-Z0-9-]+:(H-\d{2}|other)$/.test(body.lineGroupKey)) return jsonResponse({ error: 'Pick a group of lines.' }, 400);
    try {
      await logStaffAction({ actorId: auth.staff.id, action: 'site-map.lines-alignment-clear', module: 'site-map', detail: { lines: body.lineGroupKey } });
    } catch (err) {
      console.error('[site-map-admin] audit log write failed; edit refused', err);
      return jsonResponse({ error: 'Could not record the change, so nothing was changed. Try again.' }, 500);
    }
    const gone = await write('DELETE', `site_map_line_group_alignment?group_key=eq.${encodeURIComponent(body.lineGroupKey)}`);
    return gone.ok ? jsonResponse({ ok: true }) : jsonResponse({ error: 'Server error' }, 500);
  }

  if (body?.clear === true) {
    if (!CLUSTER_IDS.includes(body.cluster)) return jsonResponse({ error: 'Pick a cluster.' }, 400);
    try {
      await logStaffAction({ actorId: auth.staff.id, action: 'site-map.alignment-clear', module: 'site-map', detail: { cluster: body.cluster } });
    } catch (err) {
      console.error('[site-map-admin] audit log write failed; edit refused', err);
      return jsonResponse({ error: 'Could not record the change, so nothing was changed. Try again.' }, 500);
    }
    const gone = await write('DELETE', `site_map_alignment?cluster=eq.${encodeURIComponent(body.cluster)}`);
    return gone.ok ? jsonResponse({ ok: true }) : jsonResponse({ error: 'Server error' }, 500);
  }

  // The reference point of the pages already saved (not this one: re-aligning it may move it), so all pages share one frame.
  const isGroup = body?.group != null;
  const isLines = body?.lines === true;
  const groupKeyOf = isGroup && Array.isArray(body.group?.houses) && typeof body.cluster === 'string' ? `${body.cluster}:${[...body.group.houses].sort()[0]}` : null;
  let origin = await sharedOrigin(isGroup || isLines ? null : String(body?.cluster ?? ''), isGroup ? groupKeyOf : null);
  // The very first placement has no reference point to share: it brings its own (the map's centre when the plan was placed).
  if (!origin && body?.direct && typeof body.origin?.lat === 'number' && typeof body.origin?.lng === 'number' && Math.abs(body.origin.lat) <= 90 && Math.abs(body.origin.lng) <= 180) origin = { lat: Math.round(body.origin.lat * 1e6) / 1e6, lng: Math.round(body.origin.lng * 1e6) / 1e6 };
  const checked = validateAlignment(body, origin);
  if ('error' in checked) return jsonResponse({ error: checked.error }, 400);
  const { cluster, pairs, fit, tune, group } = checked;
  if (checked.direct && (group || isLines)) {
    // A group (or a page's lines) placed by dragging starts from its page and is only moved, turned and slightly resized: it must still be near what the
    // page's own alignment says (about 150 m and 20% in size), so a typo or a bad drag cannot throw a group across the farm.
    const [pageRows, onPage] = await Promise.all([
      select('site_map_alignment', `select=${ALIGNMENT_COLUMNS}&cluster=eq.${encodeURIComponent(cluster)}`),
      select('site_map_units', `select=house_no,x,y&cluster=eq.${encodeURIComponent(cluster)}`),
    ]);
    if (!pageRows[0]) return jsonResponse({ error: 'Align the whole plan page first: a group (or its lines) starts from its page.' }, 400);
    const page = withOrigin(shapeAlignment(pageRows[0]), checked.origin);
    const mine = group ? onPage.filter((u: any) => group.houses.includes(u.house_no)) : onPage;
    if (!mine.length) return jsonResponse({ error: 'A home in that group is not on this plan page. Reload and try again.' }, 400);
    const centre: [number, number] = [mine.reduce((sum: number, u: any) => sum + Number(u.x), 0) / mine.length, mine.reduce((sum: number, u: any) => sum + Number(u.y), 0) / mine.length];
    const here = planToLocal(fit, centre), there = planToLocal(page, centre);
    const ratio = fit.scale / page.scale;
    if (Math.hypot(here[0] - there[0], here[1] - there[1]) > 150 || ratio < 0.8 || ratio > 1.25) return jsonResponse({ error: 'That placement is too far from where the page puts the group. Undo the last move and try again.' }, 400);
  }
  if (checked.direct && !group && !isLines) {
    // A whole page placed by dragging: its size must be in line with the pages already saved (the same house, drawn at this page's base
    // size, is the same size on the ground), so a slipped value cannot blow the plan up or shrink it away.
    const [others, bases] = await Promise.all([
      select('site_map_alignment', `select=${ALIGNMENT_COLUMNS}&cluster=neq.${encodeURIComponent(cluster)}`),
      select('site_map_clusters', 'select=cluster,base_size'),
    ]);
    const baseOf = (c: string) => Number(bases.find((b: any) => b.cluster === c)?.base_size);
    const ref = others.map(shapeAlignment).filter((o: any) => baseOf(o.cluster) > 0).sort((a: any, b: any) => (a.rms ?? 1e9) / a.scale - (b.rms ?? 1e9) / b.scale)[0];
    if (ref && baseOf(cluster) > 0) {
      const expected = (ref.scale / baseOf(ref.cluster)) * baseOf(cluster);
      if (fit.scale / expected < 0.75 || fit.scale / expected > 1.33) return jsonResponse({ error: 'That size is out of line with the other pages. Undo the last resize and try again.' }, 400);
    }
  }
  if (group) {
    // Every home of the group must be on the map, on this plan page.
    const onPage = await select('site_map_units', `select=house_no&cluster=eq.${encodeURIComponent(cluster)}`);
    const known = new Set(onPage.map((u: any) => u.house_no));
    if (!group.houses.every((h: string) => known.has(h))) return jsonResponse({ error: 'A home in that group is not on this plan page. Reload and try again.' }, 400);
  }
  try {
    await logStaffAction({ actorId: auth.staff.id, action: isLines ? 'site-map.lines-alignment' : 'site-map.alignment', module: 'site-map', detail: { cluster, ...(isLines ? { lines: true } : {}), ...(group ? { group: group.key, homes: group.houses.length } : {}), pairs: pairs.length, summary: auditAlignment(isLines ? `${cluster} lines` : group ? group.key : cluster, fit, pairs.length, tune) } });
  } catch (err) {
    console.error('[site-map-admin] audit log write failed; edit refused', err);
    return jsonResponse({ error: 'Could not record the change, so nothing was changed. Try again.' }, 500);
  }
  if (isLines) {
    const lineRow = { group_key: group ? group.key : `${cluster}:other`, houses: group ? group.houses : null, cluster, a: fit.a, b: fit.b, tx: fit.tx, ty: fit.ty, origin_lat: checked.origin.lat, origin_lng: checked.origin.lng, updated_at: new Date().toISOString() };
    const done = await fetch(`${base()}/site_map_line_group_alignment?on_conflict=group_key`, { method: 'POST', headers: restHeaders({ Prefer: 'return=representation,resolution=merge-duplicates' }), body: JSON.stringify(lineRow) });
    if (!done.ok) { console.error('[site-map-admin] lines alignment write failed', done.status); return jsonResponse({ error: 'Server error' }, 500); }
    return jsonResponse({ ok: true, alignment: shapeAlignment(lineRow) });
  }
  const row = { ...(group ? { group_key: group.key, houses: group.houses, locked_scale: checked.lockedScale } : {}), cluster, a: fit.a, b: fit.b, tx: fit.tx, ty: fit.ty, origin_lat: checked.origin.lat, origin_lng: checked.origin.lng, rms: Math.round(fit.rms * 100) / 100, pairs, updated_at: new Date().toISOString() };
  const res = await fetch(`${base()}/${group ? 'site_map_group_alignment?on_conflict=group_key' : 'site_map_alignment?on_conflict=cluster'}`, { method: 'POST', headers: restHeaders({ Prefer: 'return=representation,resolution=merge-duplicates' }), body: JSON.stringify(row) });
  if (!res.ok) {
    console.error('[site-map-admin] alignment write failed', res.status);
    return jsonResponse({ error: 'Server error' }, 500);
  }
  return jsonResponse({ ok: true, alignment: shapeAlignment(row) });
}

export default async (req: Request): Promise<Response> => {
  const path = new URL(req.url).pathname;
  try {
    if (req.method === 'GET' && path === '/api/site-map-admin/overview') return await handleOverview(req);
    if (req.method === 'POST' && path === '/api/site-map-admin/units') return await handleUnits(req);
    if (req.method === 'GET' && path === '/api/site-map-admin/alignment') return await handleAlignmentRead(req);
    if (req.method === 'POST' && path === '/api/site-map-admin/alignment') return await handleAlignmentWrite(req);
    return jsonResponse({ error: 'Not found' }, 404);
  } catch (err) {
    console.error('[site-map-admin] request failed', err);
    return jsonResponse({ error: 'Server error' }, 500);
  }
};

export const config = { path: ['/api/site-map-admin/overview', '/api/site-map-admin/units', '/api/site-map-admin/alignment'] };
