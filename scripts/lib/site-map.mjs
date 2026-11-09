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

// ---- One sheet for several plan pages ----------------------------------------------------------------------------
// The 2023 plan is drawn on one page per cluster (H1-A, H1-B, H2), each with its own coordinates and scale. The member map
// shows them as one sheet: every page of a sheet is moved into the first page's coordinates with a placement (scale, a
// clockwise rotation in degrees, and an offset), so each cluster has its own rotation and position. The homes are not
// rescaled: every home on the sheet is drawn at the one base size (the first page's), because a home is the same size
// wherever it stands; only where the homes and plot lines are moves with the cluster's placement. The database keeps each
// home in its own page's coordinates, so the admin layout editor is untouched; only what is sent to the member portal is
// combined. The placements come from the satellite alignments (site-map-align.mjs, set on the admin page "Align to
// satellite"); SHEETS holds the placement used until a sheet's pages are all aligned.
export const SHEETS = {
  // One sheet for the whole farm: H1-A is the frame, H1-B and H2 are placed against it. These are the placements the saved satellite
  // alignments give (2026-11-09), kept as the fallback for when a page has no alignment.
  All: [
    { page: 'H1-A', scale: 1, rotate: 0, dx: 0, dy: 0 },
    { page: 'H1-B', scale: 0.9614, rotate: 1.7, dx: -759, dy: -398.1 },
    { page: 'H2', scale: 0.9452, rotate: -10.62, dx: 899.8, dy: 802 },
  ],
};
/** The sheet a plan page belongs to ("All": the whole farm is one sheet); a page on no sheet is its own. */
export const sheetOf = (page, sheets = SHEETS) => Object.entries(sheets).find(([, pages]) => pages.some((p) => p.page === page))?.[0] ?? page;

const round2 = (n) => Math.round(n * 100) / 100;
// A point of a page in the sheet: scaled, rotated clockwise about the page's origin, then shifted.
const place = (t, x, y) => {
  const r = ((t.rotate ?? 0) * Math.PI) / 180, c = Math.cos(r) * t.scale, s = Math.sin(r) * t.scale;
  return [round2(c * x - s * y + t.dx), round2(s * x + c * y + t.dy)];
};
const movePath = (d, t) => String(d ?? '').replace(/(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g, (_, x, y) => place(t, Number(x), Number(y)).join(' '));
const normDeg = (deg) => { const r = ((((deg + 180) % 360) + 360) % 360) - 180; return r2(r === -180 ? 180 : r); };
const r2 = round2;

// The subpaths of a plot path, apart: the plan's own lines (open) and each home's closed plot outline (ending in Z).
function splitPlot(plot) {
  const lines = [], closed = [];
  for (const sub of String(plot ?? '').split('M').slice(1)) (/Z\s*$/i.test(sub.trim()) ? closed : lines).push(`M${sub.trim()}`);
  return { lines, closed };
}
const pointsOf = (sub) => { const n = (sub.match(/-?\d+(?:\.\d+)?/g) || []).map(Number); const pts = []; for (let i = 0; i + 1 < n.length; i += 2) pts.push([n[i], n[i + 1]]); return pts; };
// How far a point is from a segment, and whether two segments run the same way (within `maxDeg` degrees).
const distToSegment = (p, a, b) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
  const t = len2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
};
const parallelSegments = (a, b, c, d, maxDeg = 5) => {
  const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]), l2 = Math.hypot(d[0] - c[0], d[1] - c[1]);
  if (l1 < 1e-9 || l2 < 1e-9) return false;
  return Math.abs((b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0])) / (l1 * l2) <= Math.sin((maxDeg * Math.PI) / 180);
};
const insidePoly = (pts, px, py) => {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

/**
 * A page's open lines, split by what they bound. A stretch that lies along a home's plot outline (within a few plan units, running the
 * same way) belongs to that home's group (`groupOfHome[house]`, else the home itself, "h:H-40"); every other stretch (roads, the site
 * boundary) is "other". Lines are cut where the owner changes. Used by the member map and the admin Align page, so both see the same
 * groups of lines.
 * @param {string} plotPath
 * @param {{ houseNo?: string, x: number, y: number }[]} units the homes of this plan page
 * @param {Record<string, string>} [groupOfHome]
 * @returns {Map<string, [number, number][][]>} key -> polylines in the plan page's coordinates
 */
export function assignLines(plotPath, units, groupOfHome = {}) {
  const { lines, closed } = splitPlot(plotPath);
  const owned = [];
  for (const sub of closed) {
    const pts = pointsOf(sub);
    if (pts.length < 3) continue;
    const cx = pts.reduce((sum, q) => sum + q[0], 0) / pts.length, cy = pts.reduce((sum, q) => sum + q[1], 0) / pts.length;
    const owner = units.filter((u) => u.houseNo && insidePoly(pts, u.x, u.y)).sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy))[0];
    if (owner) owned.push({ pts, key: groupOfHome[owner.houseNo] ?? `h:${owner.houseNo}` });
  }
  const keyOfStretch = (a, b) => {
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    for (const o of owned) for (let k = 0; k < o.pts.length; k++) {
      const e1 = o.pts[k], e2 = o.pts[(k + 1) % o.pts.length];
      if (distToSegment(mid, e1, e2) <= 3 && parallelSegments(a, b, e1, e2)) return o.key;
    }
    return 'other';
  };
  const out = new Map();
  for (const sub of lines) {
    const pts = pointsOf(sub);
    let run = null;
    const flush = () => { if (run && run.pts.length > 1) { if (!out.has(run.key)) out.set(run.key, []); out.get(run.key).push(run.pts); } run = null; };
    for (let k = 0; k + 1 < pts.length; k++) {
      const key = keyOfStretch(pts[k], pts[k + 1]);
      if (!run || run.key !== key) { flush(); run = { key, pts: [pts[k]] }; }
      run.pts.push(pts[k + 1]);
    }
    flush();
  }
  return out;
}
/** Polylines as path data. */
export const pathOfLines = (polys) => polys.map((pts) => `M${pts.map(([x, y]) => `${x} ${y}`).join(' L')}`).join(' ');

/** @typedef {{ scale: number, rotate?: number, dx: number, dy: number }} Placement */

/**
 * Combine the pages of each sheet into one cluster: plot lines, view box and homes moved into the first page's coordinates.
 * A home can also have a placement of its own (`homes`, from the alignment of the group of homes it shares walls with): the
 * home and its plot outline then move with that placement instead of the page's, so a group can sit differently on the ground
 * from the plan. The page's other lines (roads, boundaries) stay with the page.
 * @param {{ id: string, baseSize: number, viewBox: number[], plot: string }[]} clusters as from shapeClusters
 * @param {{ houseNo?: string, cluster: string, x: number, y: number, rotation?: number }[]} units as from buildSiteMap
 * @param {Record<string, { page: string, scale: number, rotate?: number, dx: number, dy: number }[]>} [sheets] the placements to use (the defaults, or those from the satellite alignments)
 * @param {{ homes?: Record<string, Placement>, groupOfHome?: Record<string, string>, lineGroups?: Record<string, Record<string, Placement>> }} [extra]
 *   `groupOfHome` says which group of homes each home is in; `lineGroups` gives a group's lines (the boundary lines along its homes' plots, or
 *   "other" for the roads and site boundary) a placement of their own, per plan page, because the lines can sit differently on the ground from the
 *   homes. A group's lines without one follow the group's homes (so a plot is drawn once), and "other" follows the page.
 */
export function mergeSheets(clusters, units, sheets = SHEETS, extra = {}) {
  const pageOf = (page) => Object.values(sheets).flat().find((p) => p.page === page);
  const homePlacement = (u) => extra.homes?.[u.houseNo] ?? pageOf(u.cluster);
  const moved = {}; // the points placed on each sheet, so its view box can cover them
  const move = (u) => {
    const t = homePlacement(u);
    if (!t) return u;
    const [x, y] = place(t, u.x, u.y);
    (moved[sheetOf(u.cluster, sheets)] ??= []).push([x, y]);
    return { ...u, cluster: sheetOf(u.cluster, sheets), page: u.cluster, x, y, rotation: normDeg((u.rotation ?? 0) + (t.rotate ?? 0)) };
  };
  const out = [];
  for (const c of clusters) {
    const sheet = sheetOf(c.id, sheets);
    const t = (sheets[sheet] ?? []).find((p) => p.page === c.id);
    if (!t) { out.push(c); continue; }
    // The page's frame is a rectangle; once it is rotated its bounding box is what the sheet has to cover.
    const [x, y, w, h] = c.viewBox;
    const corners = [place(t, x, y), place(t, x + w, y), place(t, x, y + h), place(t, x + w, y + h)];
    const box = [Math.min(...corners.map((p) => p[0])), Math.min(...corners.map((p) => p[1])), Math.max(...corners.map((p) => p[0])), Math.max(...corners.map((p) => p[1]))];
    // Each home's plot outline goes with the home; everything else in the plot path goes with the page.
    const here = units.filter((u) => u.cluster === c.id);
    const { closed } = splitPlot(c.plot);
    const withPage = [], withHomes = [];
    for (const sub of closed) {
      const pts = pointsOf(sub);
      const cx = pts.reduce((sum, q) => sum + q[0], 0) / pts.length, cy = pts.reduce((sum, q) => sum + q[1], 0) / pts.length;
      const owner = here.filter((u) => u.houseNo && insidePoly(pts, u.x, u.y)).sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy))[0];
      if (!owner) { withPage.push(movePath(sub, t)); continue; }
      const own = homePlacement(owner);
      const moveSub = movePath(sub, own);
      withHomes.push(moveSub);
      for (const q of pointsOf(moveSub)) (moved[sheet] ??= []).push(q);
    }
    // The plan's own lines, group by group (assignLines): a group's lines have a placement of their own if they have been placed, else they follow
    // their homes' group (so a plot is drawn once, not twice a little apart); "other" (roads, site boundaries) follows the page.
    const repHome = {};
    for (const u of here) repHome[extra.groupOfHome?.[u.houseNo] ?? `h:${u.houseNo}`] ??= u;
    for (const [key, polys] of assignLines(c.plot, here, extra.groupOfHome ?? {})) {
      const own = extra.lineGroups?.[c.id]?.[key];
      const placement = own ?? (key === 'other' ? t : repHome[key] ? homePlacement(repHome[key]) : t);
      withPage.push(movePath(pathOfLines(polys), placement));
    }
    const plot = [...withPage, ...withHomes].filter(Boolean).join(' ');
    const have = out.find((o) => o.id === sheet);
    if (!have) { out.push({ id: sheet, baseSize: c.baseSize, viewBox: [round2(box[0]), round2(box[1]), round2(box[2] - box[0]), round2(box[3] - box[1])], plot }); continue; }
    const [hx, hy, hw, hh] = have.viewBox;
    const x1 = Math.min(hx, box[0]), y1 = Math.min(hy, box[1]), x2 = Math.max(hx + hw, box[2]), y2 = Math.max(hy + hh, box[3]);
    have.viewBox = [round2(x1), round2(y1), round2(x2 - x1), round2(y2 - y1)];
    have.plot = `${have.plot} ${plot}`;
  }
  const result = { clusters: out, units: units.map(move) };
  // A group can sit well away from where its page's frame puts it; the view box has to cover every home and outline too.
  for (const c of result.clusters) {
    if (!sheets[c.id]) continue;
    const pts = [...(moved[c.id] ?? []), ...pointsOf(c.plot)].filter(([px, py]) => Number.isFinite(px) && Number.isFinite(py));
    const [vx, vy, vw, vh] = c.viewBox;
    const x1 = Math.min(vx, ...pts.map((q) => q[0])), y1 = Math.min(vy, ...pts.map((q) => q[1]));
    const x2 = Math.max(vx + vw, ...pts.map((q) => q[0])), y2 = Math.max(vy + vh, ...pts.map((q) => q[1]));
    // The pages' own view boxes end on a drawn line; a margin keeps the outermost homes and their labels inside the frame.
    c.viewBox = [round2(x1 - 30), round2(y1 - 30), round2(x2 - x1 + 60), round2(y2 - y1 + 60)];
  }
  return result;
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
