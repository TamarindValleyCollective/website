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
 * @returns {{ a: number, b: number, tx: number, ty: number, scale: number, rotation: number, residuals: number[], rms: number } | null} null when it cannot be fitted
 */
export function fitSimilarity(pairs) {
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
  const a = num_re / den, b = num_im / den;
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
 * `body.tune` (optional) is the hand fine-tune; the fit that comes back is the fine-tuned one, with the pairs' distances from it.
 * @returns {{ error: string } | { cluster: string, pairs: object[], origin: { lat: number, lng: number }, tune: typeof NO_TUNE, fit: NonNullable<ReturnType<typeof fitSimilarity>> }}
 */
export function validateAlignment(body, origin = null) {
  if (!body || typeof body !== 'object') return { error: 'Nothing to save.' };
  if (!CLUSTER_IDS.includes(body.cluster)) return { error: 'Pick a cluster.' };
  if (!Array.isArray(body.pairs) || body.pairs.length < MIN_PAIRS) return { error: `Pair at least ${MIN_PAIRS} points.` };
  if (body.pairs.length > MAX_PAIRS) return { error: `Use at most ${MAX_PAIRS} pairs.` };
  const pairs = [];
  for (const p of body.pairs) {
    if (!p || !isPoint(p.plan) || !Array.isArray(p.geo) || p.geo.length !== 2 || !isLat(p.geo[0]) || !isLng(p.geo[1])) return { error: 'Every pair needs a point on the plan and a point on the map.' };
    const house = typeof p.house === 'string' && /^H-\d{2}$/.test(p.house) ? p.house : null;
    pairs.push({ house, plan: p.plan.map((n) => round(n, 2)), geo: p.geo.map((n) => round(n, 7)) });
  }
  const frame = origin ?? originOf(pairs);
  const tune = parseTune(body.tune);
  if ('error' in tune) return { error: tune.error };
  const local = pairs.map((p) => ({ plan: p.plan, image: geoToLocal(frame, p.geo) }));
  let fit = fitSimilarity(local);
  if (!fit) return { error: 'These points cannot be fitted. Pick points that are apart from each other.' };
  if (isTuned(tune)) {
    const t = applyTune(fit, tune, pivotOf(pairs, frame));
    const scale = Math.hypot(t.a, t.b);
    fit = { ...t, scale, rotation: (Math.atan2(t.b, t.a) * 180) / Math.PI, ...residualsFor(t, local) };
  }
  if (fit.scale < 0.05 || fit.scale > 20) return { error: 'These points give an unlikely scale. Check that each pair is the same spot.' };
  return { cluster: body.cluster, pairs, origin: frame, tune, fit };
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
  cluster: row.cluster,
  a: Number(row.a), b: Number(row.b), tx: Number(row.tx), ty: Number(row.ty),
  scale: Math.hypot(Number(row.a), Number(row.b)),
  rotation: (Math.atan2(Number(row.b), Number(row.a)) * 180) / Math.PI,
  originLat: Number(row.origin_lat), originLng: Number(row.origin_lng),
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
