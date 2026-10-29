// Rules for changing the site map's layout from the admin portal (netlify/functions/site-map-admin.mts): which edits are
// valid, and when one must be refused. Pure (no network), so the rules are tested on their own. The function loads the
// current units and households, calls validateEdit, writes the audit entry, and only then changes anything.
//
// Four actions, all admin-only and audited:
//   update    change a home's shape, position, rotation or mirrors (it has a `version`: the updated_at the editor loaded,
//             so an edit made on a stale screen is refused instead of overwriting someone else's change)
//   add       draw a new home (house number, cluster, shape, position)
//   renumber  give a home another house number
//   remove    take a home off the map
// A home that a household is attached to (member_households.house_no) cannot be removed or renumbered: that would leave
// the household pointing at a home that is not there. Move the household first, on the Members page.

import { shapeIds } from './site-map.mjs';

export const CLUSTER_IDS = ['H1-A', 'H1-B', 'H2'];
export const ACTIONS = ['update', 'add', 'renumber', 'remove'];
const HOUSE_NO = /^H-\d{2}$/;
const LIMIT = 3000; // plan coordinates are a few hundred to a thousand; this only stops a typo like 1e9

const round2 = (n) => Math.round(n * 100) / 100;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// Any rotation is accepted and kept in (-180, 180], the range the map was fixed in.
export function normalizeRotation(deg) {
  const r = ((((deg + 180) % 360) + 360) % 360) - 180;
  return round2(r === -180 ? 180 : r);
}

function placement(body, base) {
  const out = {};
  // What the page sends must already be a number; what is stored comes back from the database as a string.
  const stored = (key) => (base?.[key] == null ? undefined : Number(base[key]));
  for (const key of ['x', 'y']) {
    const v = body[key] ?? stored(key);
    if (!isNum(v) || Math.abs(v) > LIMIT) return { error: `${key.toUpperCase()} must be a number.` };
    out[key] = round2(v);
  }
  const rot = body.rotation ?? stored('rotation') ?? 0;
  if (!isNum(rot) || Math.abs(rot) > 100000) return { error: 'Rotation must be a number of degrees.' };
  out.rotation = normalizeRotation(rot);
  for (const [key, field] of [['mirrorX', 'mirror_x'], ['mirrorY', 'mirror_y']]) {
    const v = body[key] ?? base?.[field] ?? false;
    if (typeof v !== 'boolean') return { error: 'Mirror must be on or off.' };
    out[key] = v;
  }
  return { value: out };
}

const columns = (v) => ({ x: v.x, y: v.y, rotation: v.rotation, mirror_x: v.mirrorX, mirror_y: v.mirrorY });
const same = (a, b) => Number(a) === Number(b);

/**
 * @param {any} body what the page sent
 * @param {{ units: { house_no: string, cluster: string, shape: string, x: any, y: any, rotation: any, mirror_x: boolean, mirror_y: boolean, updated_at: string }[], households: { house_no: string | null }[] }} ctx
 * @returns {{ error: string, status?: number } | { edit: { action: string, houseNo: string, newHouseNo?: string, row?: Record<string, unknown>, before?: Record<string, unknown>, after?: Record<string, unknown>, version?: string } }}
 */
export function validateEdit(body, ctx) {
  const action = body?.action;
  if (!ACTIONS.includes(action)) return { error: 'Choose what to do with the home.' };
  const houseNo = body?.houseNo;
  if (typeof houseNo !== 'string' || !HOUSE_NO.test(houseNo)) return { error: 'The house number must look like H-07.' };
  const current = ctx.units.find((u) => u.house_no === houseNo) ?? null;
  const attached = ctx.households.some((h) => h.house_no === houseNo);

  if (action === 'add') {
    if (current) return { error: `${houseNo} is already on the map.`, status: 409 };
    if (!CLUSTER_IDS.includes(body.cluster)) return { error: 'Choose a cluster.' };
    if (!shapeIds().includes(body.shape)) return { error: 'Choose a unit shape.' };
    const p = placement(body, null);
    if (p.error) return { error: p.error };
    const row = { house_no: houseNo, cluster: body.cluster, shape: body.shape, ...columns(p.value) };
    return { edit: { action, houseNo, row, after: { cluster: row.cluster, shape: row.shape, ...columns(p.value) } } };
  }

  if (!current) return { error: `${houseNo} is not on the map.`, status: 404 };

  if (action === 'remove') {
    if (attached) return { error: `${houseNo} has a household. Move the household to another house on the Members page first.`, status: 409 };
    return { edit: { action, houseNo, before: { cluster: current.cluster, shape: current.shape } } };
  }

  if (action === 'renumber') {
    const to = body.newHouseNo;
    if (typeof to !== 'string' || !HOUSE_NO.test(to)) return { error: 'The new house number must look like H-07.' };
    if (to === houseNo) return { error: 'That is already its house number.' };
    if (ctx.units.some((u) => u.house_no === to)) return { error: `${to} is already on the map.`, status: 409 };
    if (attached) return { error: `${houseNo} has a household. Change its house number on the Members page, then renumber the map to match.`, status: 409 };
    return { edit: { action, houseNo, newHouseNo: to, before: { houseNo }, after: { houseNo: to } } };
  }

  // update
  if (typeof body.version !== 'string' || !body.version) return { error: 'Reload the page and try again.' };
  if (body.version !== current.updated_at) return { error: `${houseNo} was changed by someone else since you opened it. Reload to see their change.`, status: 409 };
  const shape = body.shape ?? current.shape;
  if (!shapeIds().includes(shape)) return { error: 'Choose a unit shape.' };
  const p = placement(body, current);
  if (p.error) return { error: p.error };
  const next = { shape, ...columns(p.value) };
  // The database hands numeric columns back as strings; the audit entry should carry numbers.
  const was = { shape: current.shape, ...columns({ x: Number(current.x), y: Number(current.y), rotation: Number(current.rotation), mirrorX: current.mirror_x, mirrorY: current.mirror_y }) };
  const changed = Object.keys(next).filter((k) => (typeof next[k] === 'boolean' || k === 'shape' ? next[k] !== was[k] : !same(next[k], was[k])));
  if (changed.length === 0) return { error: 'Nothing changed.', status: 400 };
  return {
    edit: {
      action,
      houseNo,
      version: body.version,
      row: next,
      before: Object.fromEntries(changed.map((k) => [k, was[k]])),
      after: Object.fromEntries(changed.map((k) => [k, next[k]])),
    },
  };
}

// What goes in the audit entry: the house number and the changed fields with their old and new values. Plan numbers and
// shapes only, never a name, an email or a phone.
export function auditDetail(edit) {
  /** @type {Record<string, unknown>} */
  const detail = { houseNo: edit.houseNo };
  if (edit.newHouseNo) detail.newHouseNo = edit.newHouseNo;
  if (edit.before) detail.before = edit.before;
  if (edit.after) detail.after = edit.after;
  return detail;
}
