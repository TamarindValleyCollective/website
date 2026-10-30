// The member portal's site map: what a signed-in member may see of each home. Pure (no network), so the rule is tested on
// its own; netlify/functions/members-sitemap.mts selects the rows and calls this.
//
// The privacy rule is the directory's (member-directory.mjs): a person is named only when they are active and have not
// opted out (directory_visible); nothing else about a person is ever passed in. A home with a household but nobody
// listed is "private" (no name, no profile to open); a home with no household is "vacant". The unit's shape and type are
// facts about the home, not the member, so they are shown for every home.

import { bedroomsOf } from './member-directory.mjs';

// The standard unit shapes, in the member portal's words. The drawing is the same for everyone; only the label is here.
export const SHAPES = {
  S: { bhk: '1 BHK', detail: 'All on the ground floor' },
  DG: { bhk: '2 BHK', detail: 'Second bedroom on the ground floor' },
  DF: { bhk: '2 BHK', detail: 'Second bedroom on the first floor' },
  DO: { bhk: '2 BHK', detail: 'Second bedroom in a separate block' },
  TO: { bhk: '3 BHK', detail: 'Two blocks, third bedroom on the first floor' },
};
export const shapeIds = () => Object.keys(SHAPES);

// H-07 -> 7, so homes sort and search by number.
export const houseNumber = (houseNo) => parseInt(String(houseNo).slice(2), 10) || 0;

/**
 * @param {{
 *   units: { house_no: string, cluster: string, shape: string, x: number | string, y: number | string, rotation: number | string, mirror_x: boolean, mirror_y: boolean }[],
 *   households: { id: string, farm_unit: string, house_no: string | null, unit_type?: string | null }[],
 *   people: { id: string, full_name: string, active?: boolean, directory_visible?: boolean }[],
 *   memberships: { household_id: string, person_id: string, role?: string }[],
 * }} data
 * @param {string | null} viewerHouseholdId the signed-in member's household, to mark "yours"
 */
export function buildSiteMap(data, viewerHouseholdId) {
  const listed = new Map(data.people.filter((p) => p.active !== false && p.directory_visible !== false).map((p) => [p.id, p]));
  const householdByHouse = new Map(data.households.filter((h) => h.house_no).map((h) => [h.house_no, h]));

  const units = data.units.map((u) => {
    const hh = householdByHouse.get(u.house_no) ?? null;
    const members = hh ? data.memberships.filter((m) => m.household_id === hh.id && listed.has(m.person_id)) : [];
    // Owners are the primary members; if none of the listed people is an owner, everyone listed is shown (as in the directory).
    const owners = members.some((m) => (m.role ?? 'owner') === 'owner') ? members.filter((m) => (m.role ?? 'owner') === 'owner') : members;
    const names = owners.map((m) => listed.get(m.person_id).full_name).sort((a, b) => a.localeCompare(b));
    const status = !hh ? 'vacant' : names.length ? 'named' : 'private';
    const shape = SHAPES[u.shape] ? u.shape : 'S';
    return {
      houseNo: u.house_no,
      cluster: u.cluster,
      shape,
      x: Number(u.x),
      y: Number(u.y),
      rotation: Number(u.rotation),
      mirrorX: !!u.mirror_x,
      mirrorY: !!u.mirror_y,
      status,
      names,
      // The member record's own code (DG1, TO1-V2) when there is one; the bedroom count follows the record, as in the directory.
      unitType: hh?.unit_type ?? null,
      bhk: bedroomsOf(hh?.unit_type) ?? SHAPES[shape].bhk,
      detail: SHAPES[shape].detail,
      // The directory only lists a household with somebody named, so only then is there a profile to open.
      farmUnit: status === 'named' ? hh.farm_unit : null,
      isYours: !!hh && hh.id === viewerHouseholdId,
    };
  });
  return units.sort((a, b) => houseNumber(a.houseNo) - houseNumber(b.houseNo));
}

// Clusters as sent to the page: the plot lines, view box and the one base size every home in the cluster is drawn at.
export function shapeClusters(rows) {
  return rows.map((c) => ({ id: c.cluster, baseSize: Number(c.base_size), viewBox: c.view_box, plot: c.plot_path }));
}

// ---- Where a home's house-number label goes ----------------------------------------------------------------------
// The label sits inside the home's land plot, not on the building. A cluster's plot_path holds the plan's raw lines and,
// since migration 0075, one closed outline (ending in Z) per plot. The plot a home is in is the smallest closed outline
// that contains the home's base centre; the label goes at that outline's centre. A home outside every outline (a new one
// an admin has just dropped, or one drawn across a boundary) is labelled on the home itself.

const polygonCache = new Map();
const signedArea = (pts) => pts.reduce((sum, [x1, y1], i) => { const [x2, y2] = pts[(i + 1) % pts.length]; return sum + (x1 * y2 - x2 * y1); }, 0) / 2;

/** The closed outlines (subpaths ending in Z) of a plot_path, each as { pts, area }. */
export function plotPolygons(path) {
  if (polygonCache.has(path)) return polygonCache.get(path);
  const out = [];
  for (const sub of String(path ?? '').split('M').slice(1)) {
    if (!/Z\s*$/i.test(sub.trim())) continue;
    const n = (sub.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    const pts = [];
    for (let i = 0; i + 1 < n.length; i += 2) pts.push([n[i], n[i + 1]]);
    if (pts.length >= 3) out.push({ pts, area: Math.abs(signedArea(pts)) });
  }
  polygonCache.set(path, out);
  return out;
}

const contains = (pts, px, py) => {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

const centroid = (pts) => {
  const a = signedArea(pts);
  if (Math.abs(a) < 1e-6) return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
  let cx = 0, cy = 0;
  pts.forEach(([x1, y1], i) => { const [x2, y2] = pts[(i + 1) % pts.length]; const f = x1 * y2 - x2 * y1; cx += (x1 + x2) * f; cy += (y1 + y2) * f; });
  return [cx / (6 * a), cy / (6 * a)];
};

/** The path data ("M... Z") of the smallest plot outline containing (x, y), or null if it is in none: the home's land plot. */
export function plotOutline(plotPath, x, y) {
  const inside = plotPolygons(plotPath).filter((p) => contains(p.pts, x, y)).sort((a, b) => a.area - b.area);
  return inside.length ? `M${inside[0].pts.map(([px, py]) => `${px} ${py}`).join('L')}Z` : null;
}

/** The width and height of the smallest plot outline containing (x, y), or null: how much room the home's label has. */
export function plotSpan(plotPath, x, y) {
  const inside = plotPolygons(plotPath).filter((p) => contains(p.pts, x, y)).sort((a, b) => a.area - b.area);
  if (!inside.length) return null;
  const xs = inside[0].pts.map((q) => q[0]);
  const ys = inside[0].pts.map((q) => q[1]);
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

/** [x, y] for a home's label: the centre of the smallest plot outline containing (x, y), or null if it is in none. */
export function labelAnchor(plotPath, x, y) {
  const inside = plotPolygons(plotPath).filter((p) => contains(p.pts, x, y)).sort((a, b) => a.area - b.area);
  return inside.length ? centroid(inside[0].pts) : null;
}

// ---- Admin view -------------------------------------------------------------------------------------------------
// What an admin sees of each home: the same placement, plus the household behind it, the member record's unit type and
// the house plot size, and what is missing or disagrees, so the gaps are visible on the map. Admins are not bound by the
// directory's opt-out (they run the register), but names are masked for the read-only role (the caller passes seeNames and
// maskName; see netlify/functions/lib/staff-masking.ts) and an email or phone is never passed in.

const baseLetters = (code) => (typeof code === 'string' ? (code.trim().match(/^[A-Za-z]+/) || [''])[0].toUpperCase() : '');

/**
 * @param {{
 *   units: { house_no: string, cluster: string, shape: string, x: number | string, y: number | string, rotation: number | string, mirror_x: boolean, mirror_y: boolean }[],
 *   households: { id: string, farm_unit: string, house_no: string | null, unit_type?: string | null }[],
 *   people: { id: string, full_name: string, active?: boolean, google_picture_url?: string | null }[],
 *   memberships: { household_id: string, person_id: string, role?: string }[],
 *   pattas: { household_id: string, area_sq_ft: number | string | null }[],
 * }} data
 * @param {{ seeNames?: boolean, maskName?: (name: string) => string }} [options]
 */
export function buildAdminSiteMap(data, options = {}) {
  const seeNames = options.seeNames !== false;
  const maskName = options.maskName ?? ((n) => n);
  const people = new Map(data.people.filter((p) => p.active !== false).map((p) => [p.id, p]));
  const householdByHouse = new Map(data.households.filter((h) => h.house_no).map((h) => [h.house_no, h]));
  const plotOf = (householdId) => {
    const areas = data.pattas.filter((p) => p.household_id === householdId && p.area_sq_ft != null && p.area_sq_ft !== '').map((p) => Number(p.area_sq_ft));
    return areas.length ? Math.round(areas.reduce((a, b) => a + b, 0) * 100) / 100 : null;
  };

  const units = data.units.map((u) => {
    const hh = householdByHouse.get(u.house_no) ?? null;
    const members = hh ? data.memberships.filter((m) => m.household_id === hh.id && people.has(m.person_id)) : [];
    const owners = members.some((m) => (m.role ?? 'owner') === 'owner') ? members.filter((m) => (m.role ?? 'owner') === 'owner') : members;
    const ownerNames = owners.map((m) => people.get(m.person_id).full_name).sort((a, b) => a.localeCompare(b));
    // Everyone on the household, owners first: a name, the role, and the Google picture the admin register also shows
    // (never an email or phone). Names and pictures are withheld from the read-only role.
    const ownerIds = new Set(owners.map((m) => m.person_id));
    const household = members
      .map((m) => ({ name: people.get(m.person_id).full_name, role: m.role ?? 'owner', owner: ownerIds.has(m.person_id), picture: people.get(m.person_id).google_picture_url || null }))
      .sort((a, b) => Number(b.owner) - Number(a.owner) || a.name.localeCompare(b.name))
      .map(({ name, role, picture }) => ({ name: seeNames ? name : maskName(name), role, picture: seeNames ? picture : null }));
    const shape = SHAPES[u.shape] ? u.shape : 'S';
    const recordType = hh?.unit_type ?? null;
    const plotSqFt = hh ? plotOf(hh.id) : null;
    const mismatch = !!recordType && baseLetters(recordType) !== shape;
    const gaps = [];
    if (hh && ownerNames.length === 0) gaps.push('No active owner on the household');
    if (hh && !recordType) gaps.push('No unit type on the member record');
    if (mismatch) gaps.push(`Map shape ${shape} but the record says ${recordType}`);
    if (hh && plotSqFt == null) gaps.push('House plot size not recorded');
    return {
      houseNo: u.house_no,
      cluster: u.cluster,
      shape,
      x: Number(u.x),
      y: Number(u.y),
      rotation: Number(u.rotation),
      mirrorX: !!u.mirror_x,
      mirrorY: !!u.mirror_y,
      status: !hh ? 'vacant' : mismatch ? 'mismatch' : 'ok',
      // The row's updated_at as loaded: an edit sends it back so a change made on a stale screen is refused.
      version: u.updated_at ?? null,
      farmUnit: hh?.farm_unit ?? null,
      owners: ownerNames.map((n) => (seeNames ? n : maskName(n))),
      otherMembers: members.length - owners.length,
      people: household,
      recordType,
      bhk: bedroomsOf(recordType) ?? SHAPES[shape].bhk,
      detail: SHAPES[shape].detail,
      plotSqFt,
      gaps,
    };
  }).sort((a, b) => houseNumber(a.houseNo) - houseNumber(b.houseNo));

  // Households that name a house the map does not have (a house built but not drawn, or a number to correct).
  const drawn = new Set(data.units.map((u) => u.house_no));
  const notOnMap = data.households.filter((h) => h.house_no && !drawn.has(h.house_no)).map((h) => ({ houseNo: h.house_no, farmUnit: h.farm_unit })).sort((a, b) => houseNumber(a.houseNo) - houseNumber(b.houseNo));
  const count = (s) => units.filter((u) => u.status === s).length;
  return {
    units,
    notOnMap,
    summary: { homes: units.length, assigned: units.length - count('vacant'), vacant: count('vacant'), mismatch: count('mismatch'), noPlotSize: units.filter((u) => u.farmUnit && u.plotSqFt == null).length },
  };
}
