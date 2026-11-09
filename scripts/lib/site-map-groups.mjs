// Sub-clusters of the site map: a group of homes that share walls (one home or more). The 2023 plan and what is built on
// the ground differ a little, but homes that share walls were built as one piece, so each group is aligned to the satellite
// map on its own (site-map-align.mjs) and its homes and their plots move with it. Pure (no network): the admin page, the
// member map function and the tests all use this one grouping.
//
// Two homes are in one group when a wall of one lies on a wall of the other: parallel (within 4 degrees), no further apart
// than `tolerance` plan units, and overlapping alongside by at least `overlap` units. Groups never cross a plan page.

import { footprintPoints, edgesOf } from './site-map-snap.mjs';

const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const PARALLEL = Math.sin((4 * Math.PI) / 180);

/** True when a wall of `pa` lies on a wall of `pb`. Both are lists of corners. */
export function sharesWall(pa, pb, tolerance = 4, overlap = 6, minWall = 8) {
  for (const e of edgesOf(pa)) {
    const dx = e.b[0] - e.a[0], dy = e.b[1] - e.a[1], len = Math.hypot(dx, dy);
    if (len < minWall) continue;
    const d = [dx / len, dy / len], n = [-d[1], d[0]];
    const lo = Math.min(dot(e.a, d), dot(e.b, d)), hi = Math.max(dot(e.a, d), dot(e.b, d));
    for (const t of edgesOf(pb)) {
      const tx = t.b[0] - t.a[0], ty = t.b[1] - t.a[1], tl = Math.hypot(tx, ty);
      if (tl < minWall) continue;
      if (Math.abs((d[0] * ty - d[1] * tx) / tl) > PARALLEL) continue;
      if (Math.abs(dot([t.a[0] - e.a[0], t.a[1] - e.a[1]], n)) > tolerance) continue;
      const a = Math.min(dot(t.a, d), dot(t.b, d)), b = Math.max(dot(t.a, d), dot(t.b, d));
      if (Math.min(hi, b) - Math.max(lo, a) >= overlap) return true;
    }
  }
  return false;
}

/** The key of a group: its plan page and its lowest house number, e.g. "H1-B:H-33". */
export const groupKey = (cluster, houses) => `${cluster}:${[...houses].sort()[0]}`;

/**
 * The groups of homes that share walls.
 * @param {{ houseNo: string, cluster: string, shape: string, x: number, y: number, rotation: number, mirrorX: boolean, mirrorY: boolean }[]} units
 * @param {Record<string, number>} baseSizes the base size of each plan page (cluster id)
 * @returns {{ key: string, cluster: string, houses: string[] }[]} sorted by page then house number
 */
export function detectGroups(units, baseSizes) {
  const out = [];
  const pages = [...new Set(units.map((u) => u.cluster))].sort();
  for (const page of pages) {
    const homes = units.filter((u) => u.cluster === page).sort((a, b) => a.houseNo.localeCompare(b.houseNo))
      .map((u) => ({ n: u.houseNo, pts: footprintPoints({ shape: u.shape, x: u.x, y: u.y, rotation: u.rotation, mirrorX: u.mirrorX, mirrorY: u.mirrorY }, baseSizes[page] ?? 1) }));
    const parent = new Map(homes.map((h) => [h.n, h.n]));
    const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    for (let i = 0; i < homes.length; i++) for (let j = i + 1; j < homes.length; j++) if (sharesWall(homes[i].pts, homes[j].pts)) parent.set(find(homes[i].n), find(homes[j].n));
    const groups = new Map();
    for (const h of homes) { const r = find(h.n); groups.set(r, [...(groups.get(r) ?? []), h.n]); }
    for (const houses of groups.values()) out.push({ key: groupKey(page, houses), cluster: page, houses: houses.sort() });
  }
  return out.sort((a, b) => a.cluster.localeCompare(b.cluster) || a.houses[0].localeCompare(b.houses[0]));
}

/**
 * The saved alignment for a group, if any: the saved row that shares the most homes with it (so a group whose lowest house
 * number changed, or that gained or lost a home, keeps its alignment), and at least half of the homes in common.
 * @param {{ houses: string[] }} group
 * @param {{ houses: string[] }[]} savedRows
 */
export function savedFor(group, savedRows) {
  let best = null;
  for (const row of savedRows) {
    const common = row.houses.filter((h) => group.houses.includes(h)).length;
    if (common * 2 >= Math.max(group.houses.length, row.houses.length) && (!best || common > best.common)) best = { row, common };
  }
  return best ? best.row : null;
}
