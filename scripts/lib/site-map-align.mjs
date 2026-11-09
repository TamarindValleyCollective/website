// Laying the site plan over a satellite image: the maths and the rules for the admin Site map's "Align to satellite" page
// (src/pages/internal/site-map-align.astro, netlify/functions/site-map-admin.mts). Pure (no network), so it is tested on its own.
//
// An admin pairs points: a spot on a plan page (a home's centre, or any point of the page) and the same spot on the satellite
// image. From three or more pairs this fits a similarity (scale, rotation and shift, no stretching) that takes a point of the
// image to the plan page's coordinates, by least squares, and says how far each pair is from the fit. A similarity is written
// as a complex number c = a + bi and a shift d: plan = c * image + d, with the picture's y pointing down as everywhere here.
//
// Each plan page (H1-A, H1-B, H2) is aligned to the same image on its own. Because both pages are then placed on the same
// ground, one page can be moved into another's coordinates (relativePlacement): that is how the member map joins H1-A and
// H1-B into one sheet without anyone guessing the offset (see mergeSheets in site-map.mjs).

import { CLUSTER_IDS } from './site-map-edit.mjs';

export const MIN_PAIRS = 3;
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

/** A plan point for an image point. */
export const imageToPlan = (t, [x, y]) => [t.a * x - t.b * y + t.tx, t.b * x + t.a * y + t.ty];

/** The SVG matrix(...) numbers that draw plan-page content in image pixels (the inverse of the fit): for the overlay. */
export function planToImageMatrix(t) {
  const k = t.a * t.a + t.b * t.b;
  const p = t.a / k, q = -t.b / k; // 1 / c
  return { a: p, b: q, c: -q, d: p, e: -(p * t.tx - q * t.ty), f: -(q * t.tx + p * t.ty) };
}

/**
 * What an admin may save for a page: the pairs (a home's number is kept so a re-opened page can show it) and the fit made
 * from them. The server makes the fit itself, so a page cannot store numbers the pairs do not give.
 * @returns {{ error: string } | { cluster: string, pairs: object[], fit: ReturnType<typeof fitSimilarity> & object }}
 */
export function validateAlignment(body) {
  if (!body || typeof body !== 'object') return { error: 'Nothing to save.' };
  if (!CLUSTER_IDS.includes(body.cluster)) return { error: 'Pick a cluster.' };
  if (!Array.isArray(body.pairs) || body.pairs.length < MIN_PAIRS) return { error: `Pair at least ${MIN_PAIRS} points.` };
  if (body.pairs.length > MAX_PAIRS) return { error: `Use at most ${MAX_PAIRS} pairs.` };
  const pairs = [];
  for (const p of body.pairs) {
    if (!p || !isPoint(p.image) || !isPoint(p.plan)) return { error: 'Every pair needs a point on the plan and a point on the image.' };
    const house = typeof p.house === 'string' && /^H-\d{2}$/.test(p.house) ? p.house : null;
    pairs.push({ house, image: p.image.map((n) => round(n, 1)), plan: p.plan.map((n) => round(n, 2)) });
  }
  const fit = fitSimilarity(pairs);
  if (!fit) return { error: 'These points cannot be fitted. Pick points that are apart from each other.' };
  if (fit.scale < 0.05 || fit.scale > 20) return { error: 'These points give an unlikely scale. Check that each pair is the same spot.' };
  return { cluster: body.cluster, pairs, fit };
}

/** The audit detail for a saved alignment: the cluster and the result, never anything personal. */
export const auditAlignment = (cluster, fit, count) => `${cluster}: ${count} pairs, scale ${round(fit.scale, 3)}, rotation ${round(fit.rotation, 2)} deg, rms ${round(fit.rms, 1)}`;

/** A stored row as the pages and the merge use it. */
export const shapeAlignment = (row) => ({
  cluster: row.cluster,
  a: Number(row.a), b: Number(row.b), tx: Number(row.tx), ty: Number(row.ty),
  scale: Math.hypot(Number(row.a), Number(row.b)),
  rotation: (Math.atan2(Number(row.b), Number(row.a)) * 180) / Math.PI,
  rms: row.rms == null ? null : Number(row.rms),
  pairs: Array.isArray(row.pairs) ? row.pairs : [],
  updatedAt: row.updated_at ?? null,
});

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
    out[sheet] = [first, ...rest.map((p) => ({ page: p.page, ...relativePlacement(base, by.get(p.page)) }))];
  }
  return out;
}

// The satellite image is sent as a data URL (the page shrinks it first), kept as one string in a private store, and only
// ever given back to a signed-in admin. Only PNG or JPEG, checked by their first bytes and not by what the page says.
export const MAX_IMAGE_CHARS = 6_000_000; // about 4.5 MB of image: under the function request limit
export function validateSatellite(dataUrl) {
  const m = typeof dataUrl === 'string' ? dataUrl.match(/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/) : null;
  if (!m) return { error: 'Send a PNG or JPEG image.' };
  if (dataUrl.length > MAX_IMAGE_CHARS) return { error: 'That image is too large. Use one under 4 MB.' };
  const head = Buffer.from(m[2].slice(0, 16), 'base64');
  const png = head.length >= 4 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  const jpeg = head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if ((m[1] === 'png' && !png) || (m[1] === 'jpeg' && !jpeg)) return { error: 'That file is not a PNG or JPEG image.' };
  return { dataUrl, kb: Math.round((dataUrl.length * 3) / 4 / 1024) };
}
