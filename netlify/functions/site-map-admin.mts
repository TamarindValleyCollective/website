// Netlify Function (v2 API) behind the admin portal's Site map page (src/pages/internal/site-map.astro): every home on the
// site plan with the household behind it, the member record's unit type, the house plot size, and what is missing or
// disagrees; and, for admins, changing the layout.
//
//   GET  /api/site-map-admin/overview    the clusters and every home, plus households that name a house the map does not have
//   POST /api/site-map-admin/units       change the layout: { action: update | add | renumber | remove, houseNo, ... }
//   GET  /api/site-map-admin/alignment   each plan page's satellite alignment (the pairs and the fit)
//   POST /api/site-map-admin/alignment   save a page's alignment from its point pairs { cluster, pairs } (or { cluster, clear: true })
//   GET  /api/site-map-admin/satellite   the satellite image (a data URL) the pages are aligned to, from a private store
//   POST /api/site-map-admin/satellite   replace it { image: data URL }
//
// Auth: requireStaff on every request. Viewing needs `site-map` / `view` (a super admin gives the module to the admins who
// should have it, on Access); changing the layout needs `site-map` / `edit` (admin role only), because every member sees
// the result. Names are masked for the read-only role (staff-masking.ts); an email, phone or document is never selected.
// The shaping rules are in scripts/lib/site-map.mjs and the edit rules in scripts/lib/site-map-edit.mjs (both tested).
//
// Every edit is written to staff_audit_log BEFORE it is made (house number and the changed plan values only, never a name),
// and if the entry cannot be written the edit is refused, the same as the member register. An update carries the row's
// updated_at as loaded and is refused if the row has changed since, so two admins cannot silently overwrite each other.
import { getStore } from '@netlify/blobs';
import { requireStaff, logStaffAction } from './lib/staff-access';
import { canSeeNames, maskName } from './lib/staff-masking';
import { roleHasCapability } from './lib/staff-registry';
import { restHeaders } from '../../scripts/lib/supabase.mjs';
import { buildAdminSiteMap, shapeClusters } from '../../scripts/lib/site-map.mjs';
import { auditDetail, validateEdit, CLUSTER_IDS } from '../../scripts/lib/site-map-edit.mjs';
import { auditAlignment, shapeAlignment, validateAlignment, validateSatellite } from '../../scripts/lib/site-map-align.mjs';

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
// The image is imagery from a map provider, so it is kept in a private store and handed only to signed-in admins; members are
// never served it. Each page's fit is made here from the pairs, so the stored numbers always follow from the stored pairs.
const satelliteStore = () => getStore('site-map');

async function handleAlignmentRead(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'site-map', 'view');
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
  const [rows, image] = await Promise.all([select('site_map_alignment', 'select=cluster,a,b,tx,ty,rms,pairs,updated_at&order=cluster.asc'), satelliteStore().get('satellite')]);
  return jsonResponse({ alignments: rows.map(shapeAlignment), hasImage: !!image, canEdit: roleHasCapability('site-map', auth.staff.role, 'edit') });
}

async function handleSatelliteRead(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'site-map', 'view');
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
  const image = await satelliteStore().get('satellite');
  if (!image) return jsonResponse({ error: 'No satellite image has been uploaded yet.' }, 404);
  return jsonResponse({ image });
}

async function handleSatelliteWrite(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'site-map', 'edit');
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
  let body: any = null;
  try { body = await req.json(); } catch { /* validateSatellite answers for a missing body */ }
  const checked = validateSatellite(body?.image);
  if ('error' in checked) return jsonResponse({ error: checked.error }, 400);
  try {
    await logStaffAction({ actorId: auth.staff.id, action: 'site-map.satellite-upload', module: 'site-map', detail: { kb: checked.kb } });
  } catch (err) {
    console.error('[site-map-admin] audit log write failed; upload refused', err);
    return jsonResponse({ error: 'Could not record the change, so nothing was changed. Try again.' }, 500);
  }
  await satelliteStore().set('satellite', checked.dataUrl);
  return jsonResponse({ ok: true });
}

async function handleAlignmentWrite(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'site-map', 'edit');
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
  let body: any = null;
  try { body = await req.json(); } catch { /* validateAlignment answers for a missing body */ }

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

  const checked = validateAlignment(body);
  if ('error' in checked) return jsonResponse({ error: checked.error }, 400);
  const { cluster, pairs, fit } = checked;
  try {
    await logStaffAction({ actorId: auth.staff.id, action: 'site-map.alignment', module: 'site-map', detail: { cluster, pairs: pairs.length, summary: auditAlignment(cluster, fit, pairs.length) } });
  } catch (err) {
    console.error('[site-map-admin] audit log write failed; edit refused', err);
    return jsonResponse({ error: 'Could not record the change, so nothing was changed. Try again.' }, 500);
  }
  const row = { cluster, a: fit.a, b: fit.b, tx: fit.tx, ty: fit.ty, rms: Math.round(fit.rms * 100) / 100, pairs, updated_at: new Date().toISOString() };
  const res = await fetch(`${base()}/site_map_alignment?on_conflict=cluster`, { method: 'POST', headers: restHeaders({ Prefer: 'return=representation,resolution=merge-duplicates' }), body: JSON.stringify(row) });
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
    if (req.method === 'GET' && path === '/api/site-map-admin/satellite') return await handleSatelliteRead(req);
    if (req.method === 'POST' && path === '/api/site-map-admin/satellite') return await handleSatelliteWrite(req);
    return jsonResponse({ error: 'Not found' }, 404);
  } catch (err) {
    console.error('[site-map-admin] request failed', err);
    return jsonResponse({ error: 'Server error' }, 500);
  }
};

export const config = { path: ['/api/site-map-admin/overview', '/api/site-map-admin/units', '/api/site-map-admin/alignment', '/api/site-map-admin/satellite'] };
