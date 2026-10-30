// Snapping for the admin site map editor: while a home is dragged, its walls are pulled onto a neighbour's wall or a plot
// line that is nearly parallel and close, and its angle onto a neighbour's when it is within a couple of degrees. Pure
// geometry (no DOM), so it is tested on its own; the page (src/pages/internal/site-map.astro) calls it on every drag move.

import { footprintOf, SHAPE_OFFSET_Y } from './site-map-draw.mjs';

const RAD = Math.PI / 180;
const PARALLEL = Math.sin(3 * RAD); // walls within 3 degrees of parallel count as parallel
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];

/** The corners of a home's footprint on the plan: scaled (with mirrors), turned, then moved to its centre. Same order the SVG draws it. */
export function footprintPoints(u, baseSize) {
  const sx = u.mirrorX ? -baseSize : baseSize;
  const sy = u.mirrorY ? -baseSize : baseSize;
  const c = Math.cos(u.rotation * RAD);
  const s = Math.sin(u.rotation * RAD);
  return footprintOf(u.shape).map(([px, py]) => {
    const x = px * sx;
    const y = (py + SHAPE_OFFSET_Y) * sy;
    return [u.x + x * c - y * s, u.y + x * s + y * c];
  });
}

/** Walls of a closed polygon as segments. */
export const edgesOf = (pts) => pts.map((a, i) => ({ a, b: pts[(i + 1) % pts.length] }));

/** Every line of a plan path ("M x y L x y ...", subpaths ending in Z are closed) as segments. */
export function segmentsOfPath(path) {
  const out = [];
  for (const sub of String(path ?? '').split('M').slice(1)) {
    const n = (sub.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    const pts = [];
    for (let i = 0; i + 1 < n.length; i += 2) pts.push([n[i], n[i + 1]]);
    for (let i = 0; i + 1 < pts.length; i++) out.push({ a: pts[i], b: pts[i + 1] });
    if (/Z\s*$/i.test(sub.trim()) && pts.length > 2) out.push({ a: pts[pts.length - 1], b: pts[0] });
  }
  return out;
}

const unit = (seg) => {
  const dx = seg.b[0] - seg.a[0];
  const dy = seg.b[1] - seg.a[1];
  const len = Math.hypot(dx, dy);
  return len < 1e-9 ? null : { d: [dx / len, dy / len], len };
};

// The smallest shift of `moving` along one wall's normal that lays a wall of it exactly on a target wall; null if none is close.
function best(moving, targets, threshold, avoid) {
  let pick = null;
  for (const e of moving) {
    const ue = unit(e);
    if (!ue || ue.len < threshold) continue;
    const n = [-ue.d[1], ue.d[0]];
    if (avoid && Math.abs(dot(n, avoid)) > 0.5) continue; // only walls turned away from the first shift
    const lo = Math.min(dot(e.a, ue.d), dot(e.b, ue.d));
    const hi = Math.max(dot(e.a, ue.d), dot(e.b, ue.d));
    for (const t of targets) {
      const ut = unit(t);
      if (!ut || Math.abs(ue.d[0] * ut.d[1] - ue.d[1] * ut.d[0]) > PARALLEL) continue;
      const shift = dot([t.a[0] - e.a[0], t.a[1] - e.a[1]], n);
      if (Math.abs(shift) > threshold) continue;
      const tl = Math.min(dot(t.a, ue.d), dot(t.b, ue.d));
      const th = Math.max(dot(t.a, ue.d), dot(t.b, ue.d));
      if (Math.min(hi, th) - Math.max(lo, tl) < -threshold) continue; // beside it, not alongside it
      if (!pick || Math.abs(shift) < pick.dist) pick = { dist: Math.abs(shift), dx: n[0] * shift, dy: n[1] * shift, n, guide: t };
    }
  }
  return pick;
}

/**
 * How far to move a home so its walls lie on a neighbour's wall or a plot line: one shift, then (for walls turned the other
 * way) a second, so a corner can settle. `guides` are the walls it caught on, to draw.
 * @param {[number, number][]} points the home's corners where the drag has put it
 * @param {{ a: [number, number], b: [number, number] }[]} targets
 * @param {number} threshold in plan units (screen pixels times units per pixel)
 */
export function snapPosition(points, targets, threshold) {
  const first = best(edgesOf(points), targets, threshold, null);
  if (!first) return { dx: 0, dy: 0, guides: [] };
  const moved = points.map(([x, y]) => [x + first.dx, y + first.dy]);
  const second = best(edgesOf(moved), targets, threshold, first.n);
  return { dx: first.dx + (second?.dx ?? 0), dy: first.dy + (second?.dy ?? 0), guides: [first.guide, ...(second ? [second.guide] : [])] };
}

/** The neighbour's angle when `rotation` is within `tolerance` degrees of one (turning the other way round, 180 apart, counts too); else null. */
export function snapRotation(rotation, neighbourRotations, tolerance = 2.5) {
  let pick = null;
  for (const r of neighbourRotations) {
    for (const turn of [0, 180]) {
      const diff = ((((rotation - (r + turn)) % 360) + 540) % 360) - 180;
      if (Math.abs(diff) <= tolerance && Math.abs(diff) > 1e-9 && (!pick || Math.abs(diff) < pick.d)) pick = { d: Math.abs(diff), to: r + turn };
    }
  }
  if (!pick) return null;
  const to = ((((pick.to + 180) % 360) + 360) % 360) - 180;
  return Math.round(to * 100) / 100;
}
