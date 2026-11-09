// Laying the site plan over a live satellite map: the maths and the rules for the admin Site map's "Align to satellite" page
// (src/pages/internal/site-map-align.astro, netlify/functions/site-map-admin.mts). Pure (no network), so it is tested on its own.
//
// An admin pairs points: a spot on a plan page (a home's centre, or any point of the page) and the same spot on Google's
// satellite map, which gives a latitude and longitude. The latitude and longitude are turned into metres east and north of a
// reference point (geoToLocal; "local" coordinates have y pointing south, like the plan page). From three or more pairs this
// fits a similarity (scale, rotation and shift, no stretching) that takes a local point to the plan page's coordinates, by
// least squares, and says how far each pair is from the fit. A similarity is written as a complex number c = a + bi and a
// shift d: plan = c * local + d. Its scale is plan units per metre and its angle is how far the plan page is turned from
// north-up (north points that many degrees clockwise from the top of the page).
//
// Each plan page (H1-A, H1-B, H2) is aligned to the same ground on its own, from one shared reference point. Because the
// pages are then placed on the same ground, one page can be moved into another's coordinates (relativePlacement): that is
// how the member map joins H1-A and H1-B into one sheet without anyone guessing the offset (see mergeSheets in site-map.mjs).

import { CLUSTER_IDS } from './site-map-edit.mjs';
import { savedFor } from './site-map-groups.mjs';

export const MIN_PAIRS = 3;
const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LNG_AT_EQUATOR = 111320;
export const MAX_PAIRS = 12;
const LIMIT = 100000; // image pixels and plan units are a few thousand at most; this only stops a typo like 1e12
const round = (n, d = 4) => { const k = 10 ** d; return Math.round(n * k) / k; };
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isPoint = (p) => Array.isArray(p) && p.length === 2 && p.every((n) => isNum(n) && Math.abs(n) < LIMIT);

/**
 * Least-squares similarity from image points to plan points.
 * @param {{ image: number[], plan: number[] }[]} pairs
 * @param {number} [lockedScale] plan units per metre to keep (a group of homes is the same size as every other; only its
 *   turn and position are fitted), so two pairs are enough and a few close pairs cannot skew the size
 * @returns {{ a: number, b: number, tx: number, ty: number, scale: number, rotation: number, residuals: number[], rms: number } | null} null when it cannot be fitted
 */
export function fitSimilarity(pairs, lockedScale) {
  if (!Array.isArray(pairs) || pairs.length < 2) return null;
  const n = pairs.length;
  const mx = pairs.reduce((s, p) => s + p.image[0], 0) / n, my = pairs.reduce((s, p) => s + p.image[1], 0) / n;
  const nx = pairs.reduce((s, p) => s + p.plan[0], 0) / n, ny = pairs.reduce((s, p) => s + p.plan[1], 0) / n;
  let num_re = 0, num_im = 0, den = 0;
  for (const p of pairs) {
    const px = p.image[0] - mx, py = p.image[1] - my, zx = p.plan[0] - nx, zy = p.plan[1] - ny;
    // conj(p) * z
    num_re += px * zx + py * zy;
    num_im += px * zy - py * zx;
    den += px * px + py * py;
  }
  if (den < 1e-9) return null; // all the image points are the same point
  let a = num_re / den, b = num_im / den;
  if (lockedScale !== undefined) {
    const turn = Math.hypot(num_re, num_im);
    if (!(lockedScale > 0) || turn < 1e-9) return null;
    a = (lockedScale * num_re) / turn;
    b = (lockedScale * num_im) / turn;
  }
  const scale = Math.hypot(a, b);
  if (scale < 1e-9) return null;
  const tx = nx - (a * mx - b * my), ty = ny - (b * mx + a * my);
  const residuals = pairs.map((p) => Math.hypot(a * p.image[0] - b * p.image[1] + tx - p.plan[0], b * p.image[0] + a * p.image[1] + ty - p.plan[1]));
  const rms = Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / n);
  return { a, b, tx, ty, scale, rotation: (Math.atan2(b, a) * 180) / Math.PI, residuals, rms };
}

/** Metres east and (y down) south of `origin` for a [lat, lng]: the fit's "local" coordinates. */
export function geoToLocal(origin, [lat, lng]) {
  return [(lng - origin.lng) * M_PER_DEG_LNG_AT_EQUATOR * Math.cos((origin.lat * Math.PI) / 180), -(lat - origin.lat) * M_PER_DEG_LAT];
}
/** The [lat, lng] of a local point. */
export function localToGeo(origin, [x, y]) {
  return [origin.lat - y / M_PER_DEG_LAT, origin.lng + x / (M_PER_DEG_LNG_AT_EQUATOR * Math.cos((origin.lat * Math.PI) / 180))];
}
// ---- Fine-tuning -------------------------------------------------------------------------------------------------
// After the fit from the pairs, an admin can move, turn and resize the plan on the ground by hand. That is a change of the
// plan's position on the ground (G) about a pivot P (the middle of the pairs): ground' = P + scale * R(rotate) * (ground - P) +
// (east, north). Applied to the fit it gives another similarity, so nothing else has to know about it: the stored a, b, tx, ty
// are the fine-tuned fit, and tuneBetween works the adjustment back out of a stored fit and its pairs when a page is reopened.
// East is metres east and north metres north on the map; rotate is degrees clockwise; scale is a factor (1.01 is 1% larger).
export const NO_TUNE = Object.freeze({ east: 0, north: 0, rotate: 0, scale: 1 });
export const TUNE_LIMITS = { move: 300, rotate: 30, scaleMin: 0.8, scaleMax: 1.25 };
const cmul = (p, q) => [p[0] * q[0] - p[1] * q[1], p[0] * q[1] + p[1] * q[0]];
const cdiv = (p, q) => { const k = q[0] * q[0] + q[1] * q[1]; return [(p[0] * q[0] + p[1] * q[1]) / k, (p[1] * q[0] - p[0] * q[1]) / k]; };

/** True when the adjustment is more than rounding noise. */
export const isTuned = (t) => !!t && (Math.abs(t.east) >= 0.01 || Math.abs(t.north) >= 0.01 || Math.abs(t.rotate) >= 0.005 || Math.abs(t.scale - 1) >= 1e-4);

/** The pivot (local metres) of a page's pairs: where a turn or a resize leaves the plan in place. */
export function pivotOf(pairs, origin) {
  const pts = pairs.map((p) => geoToLocal(origin, p.geo));
  return [pts.reduce((sum, q) => sum + q[0], 0) / pts.length, pts.reduce((sum, q) => sum + q[1], 0) / pts.length];
}

/** The fit with an adjustment applied: { a, b, tx, ty } only (the caller recomputes how far the pairs are from it). */
export function applyTune(fit, tune, pivot) {
  const r = (tune.rotate * Math.PI) / 180;
  const m = [tune.scale * Math.cos(r), tune.scale * Math.sin(r)];
  const v = [tune.east, -tune.north]; // local y points south
  const c = [fit.a, fit.b];
  const cFin = cdiv(c, m);
  const t = cmul(c, [pivot[0] - cdiv([pivot[0] + v[0], pivot[1] + v[1]], m)[0], pivot[1] - cdiv([pivot[0] + v[0], pivot[1] + v[1]], m)[1]]);
  return { a: cFin[0], b: cFin[1], tx: t[0] + fit.tx, ty: t[1] + fit.ty };
}

/** The adjustment that turns `base` (the fit from the pairs) into `fine` (the stored fit): the inverse of applyTune. */
export function tuneBetween(base, fine, pivot) {
  const c = [base.a, base.b];
  const m = cdiv(c, [fine.a, fine.b]);
  const q = cdiv([fine.tx - base.tx, fine.ty - base.ty], c);
  const mv = cmul(m, [pivot[0] - q[0], pivot[1] - q[1]]);
  const out = { east: mv[0] - pivot[0], north: -(mv[1] - pivot[1]), rotate: (Math.atan2(m[1], m[0]) * 180) / Math.PI, scale: Math.hypot(m[0], m[1]) };
  return isTuned(out) ? out : { ...NO_TUNE };
}

function parseTune(raw) {
  if (raw == null) return { ...NO_TUNE };
  if (typeof raw !== 'object') return { error: 'The fine-tune is not valid.' };
  const t = { east: raw.east ?? 0, north: raw.north ?? 0, rotate: raw.rotate ?? 0, scale: raw.scale ?? 1 };
  if (![t.east, t.north, t.rotate, t.scale].every(isNum)) return { error: 'The fine-tune is not valid.' };
  if (Math.abs(t.east) > TUNE_LIMITS.move || Math.abs(t.north) > TUNE_LIMITS.move) return { error: `Fine-tune can move the plan by at most ${TUNE_LIMITS.move} m.` };
  if (Math.abs(t.rotate) > TUNE_LIMITS.rotate) return { error: `Fine-tune can turn the plan by at most ${TUNE_LIMITS.rotate} degrees.` };
  if (t.scale < TUNE_LIMITS.scaleMin || t.scale > TUNE_LIMITS.scaleMax) return { error: 'Fine-tune can only resize the plan by a little.' };
  return { east: round(t.east, 3), north: round(t.north, 3), rotate: round(t.rotate, 4), scale: round(t.scale, 5) };
}

/** How far each pair is (plan units) from a fit { a, b, tx, ty }, and the root-mean-square. */
export function residualsFor(t, pairs) {
  const residuals = pairs.map((p) => Math.hypot(t.a * p.image[0] - t.b * p.image[1] + t.tx - p.plan[0], t.b * p.image[0] + t.a * p.image[1] + t.ty - p.plan[1]));
  return { residuals, rms: Math.sqrt(residuals.reduce((sum, r) => sum + r * r, 0) / residuals.length) };
}

/** A plan point for a local point. */
export const imageToPlan = (t, [x, y]) => [t.a * x - t.b * y + t.tx, t.b * x + t.a * y + t.ty];
/** The local point for a plan point (the inverse of the fit): where a spot of the plan is on the ground. */
export function planToLocal(t, [x, y]) {
  const k = t.a * t.a + t.b * t.b;
  const dx = x - t.tx, dy = y - t.ty;
  return [(t.a * dx + t.b * dy) / k, (t.a * dy - t.b * dx) / k];
}

const isLat = (n) => isNum(n) && Math.abs(n) <= 90;
const isLng = (n) => isNum(n) && Math.abs(n) <= 180;

/** The reference point for a page's pairs: the average of their positions, to about a metre. */
export function originOf(pairs) {
  const r6 = (n) => Math.round(n * 1e6) / 1e6;
  return { lat: r6(pairs.reduce((sum, p) => sum + p.geo[0], 0) / pairs.length), lng: r6(pairs.reduce((sum, p) => sum + p.geo[1], 0) / pairs.length) };
}

/**
 * What an admin may save for a page: the pairs (a home's number is kept so a re-opened page can show it) and the fit made
 * from them around `origin`. The server makes the fit itself, so a page cannot store numbers the pairs do not give. The
 * origin is the one the other saved pages use (so all pages share one frame), or, for the first page, the pairs' average.
 * @param {unknown} body
 * @param {{ lat: number, lng: number } | null} [origin]
 * `body.group` (optional, { houses }) makes it the alignment of a group of homes rather than a whole page; `body.direct` ({ a, b, tx, ty }) is a placement made by dragging on the map instead of by pairs; `body.scale` (optional)
 * locks the size (plan units per metre) so only the turn and position are fitted. `body.tune` (optional) is the hand fine-tune; the fit that comes back is the fine-tuned one, with the pairs' distances from it.
 * @returns {{ error: string } | { cluster: string, group: { key: string, houses: string[] } | null, direct: boolean, lockedScale: number | null, pairs: object[], origin: { lat: number, lng: number }, tune: typeof NO_TUNE, fit: NonNullable<ReturnType<typeof fitSimilarity>> }}
 */
export function validateAlignment(body, origin = null) {
  if (!body || typeof body !== 'object') return { error: 'Nothing to save.' };
  if (!CLUSTER_IDS.includes(body.cluster)) return { error: 'Pick a cluster.' };
  const lockedScale = body.scale == null ? undefined : body.scale;
  if (lockedScale !== undefined && !(isNum(lockedScale) && lockedScale >= 0.05 && lockedScale <= 20)) return { error: 'The locked size is not valid.' };
  const direct = body.direct ?? null;
  const needed = direct ? 0 : lockedScale === undefined ? MIN_PAIRS : 2;
  if (!direct && (!Array.isArray(body.pairs) || body.pairs.length < needed)) return { error: `Pair at least ${needed} points.` };
  if (Array.isArray(body.pairs) && body.pairs.length > MAX_PAIRS) return { error: `Use at most ${MAX_PAIRS} pairs.` };
  const pairs = [];
  for (const p of direct ? [] : body.pairs) {
    if (!p || !isPoint(p.plan) || !Array.isArray(p.geo) || p.geo.length !== 2 || !isLat(p.geo[0]) || !isLng(p.geo[1])) return { error: 'Every pair needs a point on the plan and a point on the map.' };
    const house = typeof p.house === 'string' && /^H-\d{2}$/.test(p.house) ? p.house : null;
    pairs.push({ house, plan: p.plan.map((n) => round(n, 2)), geo: p.geo.map((n) => round(n, 7)) });
  }
  const frame = origin ?? (pairs.length ? originOf(pairs) : null);
  if (!frame) return { error: 'These points cannot be fitted. Pick points that are apart from each other.' };
  if (direct) {
    // A page or a group placed by dragging it on the map: no pairs, the fit itself (a turn, a position and the size) is what is stored.
    // It is fitted around the shared reference point (the caller supplies it; for the very first placement, the map's own centre), and
    // the caller checks how far it is from what is already saved.
    if (!origin) return { error: 'There is no reference point yet. Place the plan on the map first.' };
    if (typeof direct !== 'object' || ![direct.a, direct.b, direct.tx, direct.ty].every(isNum) || Math.abs(direct.tx) > 1e6 || Math.abs(direct.ty) > 1e6) return { error: 'That placement is not valid.' };
  }
  const tune = parseTune(body.tune);
  if ('error' in tune) return { error: tune.error };
  let group = null;
  if (body.group != null) {
    const houses = body.group.houses;
    if (!Array.isArray(houses) || houses.length < 1 || houses.length > 40 || !houses.every((h) => typeof h === 'string' && /^H-\d{2}$/.test(h))) return { error: 'The group of homes is not valid.' };
    const sorted = [...new Set(houses)].sort();
    group = { key: `${body.cluster}:${sorted[0]}`, houses: sorted };
  }
  const local = pairs.map((p) => ({ plan: p.plan, image: geoToLocal(frame, p.geo) }));
  let fit = direct
    ? { a: direct.a, b: direct.b, tx: direct.tx, ty: direct.ty, scale: Math.hypot(direct.a, direct.b), rotation: (Math.atan2(direct.b, direct.a) * 180) / Math.PI, residuals: [], rms: 0 }
    : fitSimilarity(local, lockedScale);
  if (!fit) return { error: 'These points cannot be fitted. Pick points that are apart from each other.' };
  if (isTuned(tune) && !direct) {
    const t = applyTune(fit, tune, pivotOf(pairs, frame));
    const scale = Math.hypot(t.a, t.b);
    fit = { ...t, scale, rotation: (Math.atan2(t.b, t.a) * 180) / Math.PI, ...residualsFor(t, local) };
  }
  if (fit.scale < 0.05 || fit.scale > 20) return { error: 'These points give an unlikely scale. Check that each pair is the same spot.' };
  return { cluster: body.cluster, group, direct: !!direct, lockedScale: lockedScale ?? null, pairs, origin: frame, tune, fit };
}

/** The audit detail for a saved alignment: the cluster and the result, never anything personal.
 * @param {string} cluster
 * @param {{ scale: number, rotation: number, rms: number }} fit
 * @param {number} count
 * @param {{ east: number, north: number, rotate: number, scale: number } | null} [tune]
 */
export const auditAlignment = (cluster, fit, count, tune) => `${cluster}: ${count} pairs, ${round(fit.scale, 3)} plan units per metre, rotation ${round(fit.rotation, 2)} deg, error ${round(fit.rms / fit.scale, 1)} m${isTuned(tune) ? `, fine-tuned (${round(tune.east, 2)} m east, ${round(tune.north, 2)} m north, ${round(tune.rotate, 2)} deg, x${round(tune.scale, 4)})` : ''}`;

/** A stored row as the pages and the merge use it. */
export const shapeAlignment = (row) => ({
  key: row.group_key ?? row.cluster,
  cluster: row.cluster,
  houses: Array.isArray(row.houses) ? row.houses : null,
  a: Number(row.a), b: Number(row.b), tx: Number(row.tx), ty: Number(row.ty),
  scale: Math.hypot(Number(row.a), Number(row.b)),
  rotation: (Math.atan2(Number(row.b), Number(row.a)) * 180) / Math.PI,
  originLat: Number(row.origin_lat), originLng: Number(row.origin_lng),
  lockedScale: row.locked_scale == null ? null : Number(row.locked_scale),
  rms: row.rms == null ? null : Number(row.rms),
  pairs: Array.isArray(row.pairs) ? row.pairs : [],
  updatedAt: row.updated_at ?? null,
});

/**
 * The same fit expressed around another reference point (the pages of a sheet must share one before they are compared):
 * a shift of the origin by v metres changes the plan shift by c * v.
 */
export function withOrigin(al, origin) {
  const [vx, vy] = geoToLocal({ lat: al.originLat, lng: al.originLng }, [origin.lat, origin.lng]); // the new origin, in the old frame
  return { ...al, originLat: origin.lat, originLng: origin.lng, tx: al.a * vx - al.b * vy + al.tx, ty: al.b * vx + al.a * vy + al.ty };
}

/**
 * Where to move `page` so it sits in `into`'s coordinates, from the two pages' alignments to the same image:
 * from = plan_into = c_into * (plan_page - d_page) / c_page + d_into. Returned as the placement mergeSheets applies
 * (scale, clockwise rotation in degrees, then shift).
 */
export function relativePlacement(into, page) {
  const k = page.a * page.a + page.b * page.b;
  // c = c_into / c_page
  const ca = (into.a * page.a + into.b * page.b) / k, cb = (into.b * page.a - into.a * page.b) / k;
  const dx = into.tx - (ca * page.tx - cb * page.ty), dy = into.ty - (cb * page.tx + ca * page.ty);
  return { scale: Math.hypot(ca, cb), rotate: (Math.atan2(cb, ca) * 180) / Math.PI, dx, dy };
}

/**
 * The sheets mergeSheets should use: the stored defaults, with H1-B placed from the satellite alignments when both of the
 * sheet's pages have one. A sheet whose pages are not all aligned keeps its defaults.
 * @param {Record<string, { page: string, scale: number, rotate?: number, dx: number, dy: number }[]>} defaults
 * @param {ReturnType<typeof shapeAlignment>[]} alignments
 * @returns {Record<string, { page: string, scale: number, rotate?: number, dx: number, dy: number }[]>}
 */
export function sheetsFromAlignments(defaults, alignments) {
  const by = new Map(alignments.map((a) => [a.cluster, a]));
  /** @type {Record<string, { page: string, scale: number, rotate?: number, dx: number, dy: number }[]>} */
  const out = {};
  for (const [sheet, pages] of Object.entries(defaults)) {
    const [first, ...rest] = pages;
    const base = by.get(first.page);
    if (!base || rest.some((p) => !by.get(p.page))) { out[sheet] = pages; continue; }
    const frame = { lat: base.originLat, lng: base.originLng };
    out[sheet] = [first, ...rest.map((p) => ({ page: p.page, ...relativePlacement(base, withOrigin(by.get(p.page), frame)) }))];
  }
  return out;
}

/**
 * The placement each home gets from the alignment of its group, for mergeSheets: a group aligned to the same ground as its
 * sheet's first page is moved into that page's coordinates the same way a whole page is. Homes whose group has no alignment
 * (or whose sheet's first page has none) are left out, and so keep their page's placement.
 * @param {Record<string, { page: string }[]>} sheets
 * @param {ReturnType<typeof shapeAlignment>[]} pageAlignments
 * @param {ReturnType<typeof shapeAlignment>[]} groupRows saved group alignments (with `houses`)
 * @param {{ cluster: string, houses: string[] }[]} detected the groups as they are now (detectGroups)
 * @returns {Record<string, { scale: number, rotate: number, dx: number, dy: number }>}
 */
export function groupPlacements(sheets, pageAlignments, groupRows, detected) {
  /** @type {Record<string, { scale: number, rotate: number, dx: number, dy: number }>} */
  const out = {};
  const pages = new Map(pageAlignments.map((a) => [a.cluster, a]));
  for (const list of Object.values(sheets)) {
    const frame = pages.get(list[0].page);
    if (!frame) continue;
    const origin = { lat: frame.originLat, lng: frame.originLng };
    const onSheet = new Set(list.map((p) => p.page));
    for (const g of detected.filter((d) => onSheet.has(d.cluster))) {
      const row = savedFor(g, groupRows.filter((r) => r.cluster === g.cluster && r.houses));
      if (!row) continue;
      const placement = relativePlacement(frame, withOrigin(row, origin));
      for (const h of g.houses) out[h] = placement;
    }
  }
  return out;
}

// ---- Snapping a group to the group beside it -------------------------------------------------------------------------
// Homes that adjoin on the plan have plots that touch. When two groups are aligned on their own they can end up a little apart
// or overlapping on the ground where they meet. `snapShift` finds the walls of one group's plot outlines that lie along the
// other's on the plan, then works out the move (on the ground, in metres) that brings the first group's walls onto the second's.
// The move is only a shift: it is added to the group's fine-tune.

/**
 * The shift v (x, y) that best satisfies a set of "n . v = -d" constraints, given M = sum(n n^T) and r = -sum(d n). Walls that run nearly the
 * same way but sit at different offsets barely constrain the direction across them: dividing by that tiny eigenvalue would throw the group
 * across the farm. So only the directions the walls pin down (an eigenvalue of at least a tenth of the total) are solved; the rest stay put.
 */
function solveShift(m11, m12, m22, r1, r2) {
  const trace = m11 + m22;
  if (trace < 1e-9) return [0, 0];
  const root = Math.sqrt(((m11 - m22) / 2) ** 2 + m12 * m12);
  let vx = 0, vy = 0;
  for (const lambda of [trace / 2 + root, trace / 2 - root]) {
    if (lambda < 0.1 * trace) continue;
    // eigenvector of [[m11, m12], [m12, m22]] for lambda
    let ex = m12, ey = lambda - m11;
    if (Math.hypot(ex, ey) < 1e-12) { ex = lambda - m22; ey = m12; }
    if (Math.hypot(ex, ey) < 1e-12) { ex = 1; ey = 0; }
    const len = Math.hypot(ex, ey);
    ex /= len; ey /= len;
    const k = (ex * r1 + ey * r2) / lambda;
    vx += k * ex; vy += k * ey;
  }
  return [vx, vy];
}

const PLAN_PARALLEL = Math.sin((5 * Math.PI) / 180);
const edgeList = (pts) => pts.map((a, i) => [a, pts[(i + 1) % pts.length]]);
const dotp = (a, b) => a[0] * b[0] + a[1] * b[1];

/** The pairs of walls (one of each group's plot outlines, plan coordinates) that lie along each other on the plan. */
export function sharedWalls(mine, theirs, tolerance = 3, overlap = 6) {
  const out = [];
  for (const pm of mine) for (const em of edgeList(pm)) {
    const dx = em[1][0] - em[0][0], dy = em[1][1] - em[0][1], len = Math.hypot(dx, dy);
    if (len < 8) continue;
    const d = [dx / len, dy / len], n = [-d[1], d[0]];
    const lo = Math.min(dotp(em[0], d), dotp(em[1], d)), hi = Math.max(dotp(em[0], d), dotp(em[1], d));
    for (const pt of theirs) for (const et of edgeList(pt)) {
      const tx = et[1][0] - et[0][0], ty = et[1][1] - et[0][1], tl = Math.hypot(tx, ty);
      if (tl < 8 || Math.abs((d[0] * ty - d[1] * tx) / tl) > PLAN_PARALLEL) continue;
      if (Math.abs(dotp([et[0][0] - em[0][0], et[0][1] - em[0][1]], n)) > tolerance) continue;
      const a = Math.min(dotp(et[0], d), dotp(et[1], d)), b = Math.max(dotp(et[0], d), dotp(et[1], d));
      if (Math.min(hi, b) - Math.max(lo, a) >= overlap) out.push({ mine: em, theirs: et });
    }
  }
  return out;
}

/**
 * The shift that snaps `mine` (plot outlines of the group being placed) onto `theirs` (the neighbour's), each drawn with its own
 * fit. Returns { east, north, walls, before } (metres; `before` is how far apart the walls were, on average) or null when the
 * groups do not touch on the plan.
 * @param {{ mine: number[][][], theirs: number[][][], fitMine: { a: number, b: number, tx: number, ty: number }, fitTheirs: { a: number, b: number, tx: number, ty: number } }} input
 */
export function snapShift({ mine, theirs, fitMine, fitTheirs }) {
  const walls = sharedWalls(mine, theirs);
  if (!walls.length) return null;
  // The unknown is a shift v (ground, y south). For each wall the two ends of mine, on the ground, should lie on the neighbour's wall
  // line: n . (p + v - a) = 0, n the neighbour wall's unit normal. Least squares over every end of every shared wall.
  let m11 = 0, m12 = 0, m22 = 0, r1 = 0, r2 = 0, sum = 0, count = 0;
  for (const w of walls) {
    const a = planToLocal(fitTheirs, w.theirs[0]), b = planToLocal(fitTheirs, w.theirs[1]);
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
    const n = [-dy / len, dx / len];
    for (const end of w.mine) {
      const p = planToLocal(fitMine, end);
      const dist = n[0] * (p[0] - a[0]) + n[1] * (p[1] - a[1]);
      m11 += n[0] * n[0]; m12 += n[0] * n[1]; m22 += n[1] * n[1];
      r1 -= dist * n[0]; r2 -= dist * n[1];
      sum += Math.abs(dist); count += 1;
    }
  }
  const [vx, vy] = solveShift(m11, m12, m22, r1, r2);
  return { east: vx, north: -vy, walls: walls.length, before: sum / count };
}

/**
 * The placement each group of lines gets from its own alignment, for mergeSheets (the same move into the sheet's first page that a group of homes
 * gets). A group of lines is the boundary lines along a group of homes' plots (keyed by that group of homes, matched like a group's own alignment)
 * or the "other" lines of a page (roads, the site boundary). Anything not placed on its own is left out and follows its homes, or its page.
 * @param {Record<string, { page: string }[]>} sheets
 * @param {ReturnType<typeof shapeAlignment>[]} pageAlignments
 * @param {ReturnType<typeof shapeAlignment>[]} lineRows saved line-group alignments (`houses` null for a page's "other" lines)
 * @param {{ key: string, cluster: string, houses: string[] }[]} detected the groups of homes as they are now (detectGroups)
 * @returns {Record<string, Record<string, { scale: number, rotate: number, dx: number, dy: number }>>} page -> group key (or "other") -> placement
 */
export function lineGroupPlacements(sheets, pageAlignments, lineRows, detected) {
  /** @type {Record<string, Record<string, { scale: number, rotate: number, dx: number, dy: number }>>} */
  const out = {};
  const pages = new Map(pageAlignments.map((a) => [a.cluster, a]));
  for (const list of Object.values(sheets)) {
    const frame = pages.get(list[0].page);
    if (!frame) continue;
    const origin = { lat: frame.originLat, lng: frame.originLng };
    for (const p of list) {
      const mine = lineRows.filter((r) => r.cluster === p.page);
      const other = mine.find((r) => !r.houses);
      if (other) (out[p.page] ??= {}).other = relativePlacement(frame, withOrigin(other, origin));
      for (const g of detected.filter((d) => d.cluster === p.page)) {
        const row = savedFor(g, mine.filter((r) => r.houses));
        if (row) (out[p.page] ??= {})[g.key] = relativePlacement(frame, withOrigin(row, origin));
      }
    }
  }
  return out;
}

// ---- Snapping a group to the plan's lines ------------------------------------------------------------------------------
// The plan's lines (the white boundaries) say where plots end. `snapToLines` finds the walls of a group's plot outlines that run along one
// of the lines, on the ground (each drawn with its own placement), and works out the shift, in metres, that lays them on those lines. Only
// a nearby, parallel line counts (within `reach` metres and 8 degrees), so the group is never pulled onto a line that is not its boundary.

const ground = (fit, pts) => pts.map((p) => planToLocal(fit, p));
/**
 * @param {{ mine: number[][][], lines: { polys: number[][][], fit: { a: number, b: number, tx: number, ty: number } }[], fitMine: { a: number, b: number, tx: number, ty: number }, reach?: number }} input
 *   `mine` are plot outlines in plan-page coordinates; `lines` are sets of polylines (in plan-page coordinates), each set with the placement it is
 *   drawn with (groups of lines can sit differently on the ground).
 * @returns {{ east: number, north: number, walls: number, before: number } | null}
 */
export function snapToLines({ mine, lines, fitMine, reach = 6 }) {
  const segs = [];
  for (const set of lines) for (const line of set.polys) { const g = ground(set.fit, line); for (let i = 0; i + 1 < g.length; i++) segs.push([g[i], g[i + 1]]); }
  const PARALLEL = Math.sin((8 * Math.PI) / 180);
  let m11 = 0, m12 = 0, m22 = 0, r1 = 0, r2 = 0, sum = 0, count = 0, walls = 0;
  for (const poly of mine) {
    const g = ground(fitMine, poly);
    for (let i = 0; i < g.length; i++) {
      const a = g[i], b = g[(i + 1) % g.length];
      const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
      if (len < 3) continue;
      const d = [dx / len, dy / len];
      let best = null;
      for (const [s1, s2] of segs) {
        const sx = s2[0] - s1[0], sy = s2[1] - s1[1], sl = Math.hypot(sx, sy);
        if (sl < 2 || Math.abs((d[0] * sy - d[1] * sx) / sl) > PARALLEL) continue;
        const n = [-sy / sl, sx / sl];
        const dist = n[0] * ((a[0] + b[0]) / 2 - s1[0]) + n[1] * ((a[1] + b[1]) / 2 - s1[1]);
        if (Math.abs(dist) > reach) continue;
        // along the wall, how much of it the line covers
        const t = (p) => ((p[0] - s1[0]) * sx + (p[1] - s1[1]) * sy) / sl;
        const lo = Math.max(Math.min(t(a), t(b)), 0), hi = Math.min(Math.max(t(a), t(b)), sl);
        if (hi - lo < Math.min(len * 0.4, 4)) continue;
        if (!best || Math.abs(dist) < Math.abs(best.dist)) best = { n, dist };
      }
      if (!best) continue;
      walls += 1;
      for (const p of [a, b]) {
        const dist = best.n[0] * (p[0] - ((a[0] + b[0]) / 2 - best.n[0] * best.dist)) + best.n[1] * (p[1] - ((a[1] + b[1]) / 2 - best.n[1] * best.dist));
        m11 += best.n[0] * best.n[0]; m12 += best.n[0] * best.n[1]; m22 += best.n[1] * best.n[1];
        r1 -= dist * best.n[0]; r2 -= dist * best.n[1];
        sum += Math.abs(dist); count += 1;
      }
    }
  }
  if (!walls) return null;
  const [vx, vy] = solveShift(m11, m12, m22, r1, r2);
  return { east: vx, north: -vy, walls, before: sum / count };
}
