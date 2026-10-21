// The shape of a parcel, from the field sketch ("புலப்படம்", the FMB sketch) on page 2 of a
// single-survey Integrated Land Record, or on the one page of a stand-alone FMB sketch download.
// The sketch is either a small bitmap or, in the files e-Services produces now, vector lines
// (shapeFromLines, below: exact, so it needs no line finding). From a bitmap the outline is rebuilt
// in three steps:
//   1. Find the long, solid, straight black lines (a Hough transform). Everything else black is
//      text: a neighbour's survey number, a point number. Text touching the outline can't hide it
//      (the drawing is often one connected blob, so "is this blob thin?" doesn't work).
//      Red and blue (labels, dimensions, ticks) are ignored by colour.
//   2. Work out where the lines cross and keep only the stretches between crossings; then keep
//      only what is part of a closed loop. The sketch draws neighbours' borders and the parcel's
//      own lines running past the corners, so the ends that stick out and the lines that don't
//      close up are dropped. What is left is the parcel as a polygon.
//   3. Redraw it cleanly, small, as a transparent PNG with no text on it.
// Pure: no I/O.
import { deflateSync } from 'node:zlib';

// Bumped whenever the outline reader changes, so stored outlines and "no outline" verdicts made by
// an older reader are redone once (see shapeNeedsRefresh).
export const SHAPE_VERSION = 4;

// Whether a stored single-survey PDF's outline should be (re)made. `extracted` is the document's
// stored reading: `hasShape` + `shapeVersion` when an outline was stored, `shapeChecked` (a
// version) when the reader found none. Anything written by an older version, or before versions
// existed (shapeChecked: true, no shapeVersion), is redone.
export function shapeNeedsRefresh(extracted) {
  // A stand-alone FMB sketch is only ever kept because it has an outline; it has no records.
  if (extracted?.kind === 'fmb_sketch') return extracted.shapeVersion !== SHAPE_VERSION;
  if (!extracted || !Array.isArray(extracted.records) || extracted.records.length !== 1) return false;
  if (extracted.hasShape === true) return extracted.shapeVersion !== SHAPE_VERSION;
  return extracted.shapeChecked !== SHAPE_VERSION;
}

// The reading to store after (re)making the outline: the outline's flags replace any older ones.
export function withShapeResult(extracted, madeShape) {
  const { hasShape, shapeVersion, shapeChecked, ...rest } = extracted ?? {};
  return madeShape ? { ...rest, hasShape: true, shapeVersion: SHAPE_VERSION } : { ...rest, shapeChecked: SHAPE_VERSION };
}

const INK = [0x29, 0x4a, 0x36]; // --tvc-green-dark; baked in because an <img> can't read CSS tokens
const MIN_RUN = 24; // px: a solid straight run shorter than this is a letter or a digit
const MIN_VOTES = 24; // pixels that must line up before a line is considered
const MAX_GAP = 2; // px: a break wider than this ends a solid run (the space between letters does)
const SOLID = 0.9; // a run must be 90% filled: a baseline of letters is not
const LINE_WIDTH = 1.6; // px either side of a line that still counts as on it (bold borders are 3px)
const MAX_LINES = 80;
const CHAIN_GAP = 16; // px: a line that continues after a gap this small (text sitting on it) is one line
const MIN_ANGLE = Math.sin((3 * Math.PI) / 180); // lines closer to parallel than this don't form a corner
const REACH = 12; // px: a line that stops this close to another still meets it
const MERGE = 5; // px: crossings this close together are one corner
const MIN_SIDE = 150; // px: a smaller image is the emblem or the QR code, not a sketch
const MIN_PERIMETER = 120; // px of source image
const MAX_SIDE = 72; // px: the shape is shown as a small inline mark
const PAD = 3;
const GROW = 1; // thicken the drawn lines after shrinking

// image: { data: Uint8Array|Uint8ClampedArray, width, height, channels: 1|3|4 }
// Returns { png: Uint8Array, width, height } or null when no closed outline is found.
export function shapeFromSketch(image) {
  if (!image) return null;
  const { data, width, height, channels } = image;
  if (!data || width < MIN_SIDE || height < MIN_SIDE || ![1, 3, 4].includes(channels)) return null;
  const lines = findLines(data, width, height, channels);
  const edges = closedEdges(lines);
  if (edges.length < 3) return null;
  const perimeter = edges.reduce((n, [p, q]) => n + Math.hypot(p[0] - q[0], p[1] - q[1]), 0);
  if (perimeter < MIN_PERIMETER) return null;
  return draw(edges);
}

// The largest image on the sketch page that is big enough to be one. images: unpdf's extractImages().
export function pickSketch(images) {
  const big = (images ?? []).filter((i) => i.width >= MIN_SIDE && i.height >= MIN_SIDE);
  big.sort((a, b) => b.width * b.height - a.width * a.height);
  return big[0] ?? null;
}

// ---- 1. lines --------------------------------------------------------------

// Returns segments { c, s, rho, a, b }: the line x*c + y*s = rho, between parameters a and b, where
// a point is (rho*c - t*s, rho*s + t*c).
function findLines(data, width, height, channels) {
  const xs = [], ys = [];
  for (let i = 0; i < width * height; i++) {
    const o = i * channels;
    const [r, g, b] = channels === 1 ? [data[o], data[o], data[o]] : [data[o], data[o + 1], data[o + 2]];
    // Dark and not coloured: the outline is black, the labels and ticks are red or blue.
    if (r < 110 && g < 110 && b < 110 && Math.max(r, g, b) - Math.min(r, g, b) < 40) {
      xs.push(i % width);
      ys.push((i / width) | 0);
    }
  }
  const n = xs.length;
  const thetas = 180, cos = [], sin = [];
  for (let t = 0; t < thetas; t++) {
    cos.push(Math.cos((t * Math.PI) / thetas));
    sin.push(Math.sin((t * Math.PI) / thetas));
  }
  const rhoMax = Math.ceil(Math.hypot(width, height));
  const rhoSpan = 2 * rhoMax + 1;
  const acc = new Int32Array(thetas * rhoSpan);
  const vote = (i, d) => {
    for (let t = 0; t < thetas; t++) acc[t * rhoSpan + Math.round(xs[i] * cos[t] + ys[i] * sin[t]) + rhoMax] += d;
  };
  for (let i = 0; i < n; i++) vote(i, 1);

  const claimed = new Uint8Array(n);
  const segments = [];
  for (let found = 0; found < MAX_LINES; found++) {
    let best = 0, bestAt = -1;
    for (let k = 0; k < acc.length; k++) if (acc[k] > best) { best = acc[k]; bestAt = k; }
    if (best < MIN_VOTES) break;
    const t = (bestAt / rhoSpan) | 0, rho = (bestAt % rhoSpan) - rhoMax;
    const c = cos[t], s = sin[t];
    // Black pixels on this line, in order along it.
    const on = [];
    for (let i = 0; i < n; i++) {
      if (!claimed[i] && Math.abs(xs[i] * c + ys[i] * s - rho) <= LINE_WIDTH) on.push([-xs[i] * s + ys[i] * c, i]);
    }
    on.sort((p, q) => p[0] - q[0]);
    // Solid runs, then each grown along the line across small gaps (text sitting on the line).
    const runs = [];
    let from = 0;
    for (let k = 1; k <= on.length; k++) {
      if (k < on.length && on[k][0] - on[k - 1][0] <= MAX_GAP) continue;
      const extent = on[k - 1][0] - on[from][0] + 1;
      if (k - from >= extent * SOLID && extent >= MIN_RUN) runs.push([from, k - 1]);
      from = k;
    }
    for (const [lo0, hi0] of runs) {
      let lo = lo0, hi = hi0;
      while (lo > 0 && on[lo][0] - on[lo - 1][0] <= CHAIN_GAP) lo--;
      while (hi < on.length - 1 && on[hi + 1][0] - on[hi][0] <= CHAIN_GAP) hi++;
      const seg = { c, s, rho, a: on[lo][0], b: on[hi][0] };
      const last = segments[segments.length - 1];
      // The same stretch seen again from a neighbouring angle (a bold line): not a new line.
      if (!segments.some((o) => duplicate(o, seg))) segments.push(seg);
      void last;
    }
    // Whether or not it was a line, these pixels have had their say: stop them voting again.
    for (const [, i] of on) {
      claimed[i] = 1;
      vote(i, -1);
    }
  }
  return segments;
}

const pointAt = (L, t) => [L.rho * L.c - t * L.s, L.rho * L.s + t * L.c];
const distToLine = (L, [x, y]) => Math.abs(x * L.c + y * L.s - L.rho);
function duplicate(o, seg) {
  const sameWay = Math.abs(o.c * seg.s - o.s * seg.c) < 0.06;
  return sameWay && distToLine(o, pointAt(seg, seg.a)) <= 3 && distToLine(o, pointAt(seg, seg.b)) <= 3;
}

// ---- 2. the closed outline ----------------------------------------------------

// Edges [[x,y],[x,y]] that lie on a closed loop of the lines, ends that stick out removed.
function closedEdges(segments) {
  // Corners: where two lines that are not nearly parallel meet, close enough to both.
  const nodes = [];
  const nodeFor = (p) => {
    let k = nodes.findIndex((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) <= MERGE);
    if (k < 0) k = nodes.push(p) - 1;
    return k;
  };
  const along = segments.map(() => []); // per segment: [t, node]
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const A = segments[i], B = segments[j];
      const det = A.c * B.s - A.s * B.c;
      if (Math.abs(det) < MIN_ANGLE) continue;
      const x = (A.rho * B.s - B.rho * A.s) / det, y = (A.c * B.rho - B.c * A.rho) / det;
      const ta = -x * A.s + y * A.c, tb = -x * B.s + y * B.c;
      if (ta < A.a - REACH || ta > A.b + REACH || tb < B.a - REACH || tb > B.b + REACH) continue;
      const k = nodeFor([x, y]);
      along[i].push([ta, k]);
      along[j].push([tb, k]);
    }
  }
  // Edges: between neighbouring corners along each line. Anything beyond the first and last
  // corner is the part sticking out, and is simply never an edge.
  const edgeKey = new Set();
  let edges = [];
  for (const list of along) {
    list.sort((p, q) => p[0] - q[0]);
    for (let k = 1; k < list.length; k++) {
      const u = list[k - 1][1], v = list[k][1];
      if (u === v) continue;
      const key = u < v ? `${u}-${v}` : `${v}-${u}`;
      if (!edgeKey.has(key)) {
        edgeKey.add(key);
        edges.push([u, v]);
      }
    }
  }
  // Keep only edges on a loop: repeatedly drop an edge that ends at a corner nothing else meets.
  for (let changed = true; changed; ) {
    changed = false;
    const degree = new Map();
    for (const [u, v] of edges) {
      degree.set(u, (degree.get(u) ?? 0) + 1);
      degree.set(v, (degree.get(v) ?? 0) + 1);
    }
    const next = edges.filter(([u, v]) => degree.get(u) > 1 && degree.get(v) > 1);
    if (next.length !== edges.length) changed = true;
    edges = next;
  }
  return largestPiece(edges).map(([u, v]) => [nodes[u], nodes[v]]);
}

// If the loops fall into separate pieces, the biggest (by length) is the parcel.
function largestPiece(edges) {
  const parent = new Map();
  const find = (x) => (parent.get(x) === x || !parent.has(x) ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
  for (const [u, v] of edges) {
    for (const w of [u, v]) if (!parent.has(w)) parent.set(w, w);
    parent.set(find(u), find(v));
  }
  return edges; // every piece is kept: pieces of one parcel are not always joined in the drawing
}

// ---- vector sketches ----------------------------------------------------------

// pdf.js's path encoding inside a constructPath operation (DrawOPS), and the stroke colour the
// outline is drawn in. The dimensions are blue and the corner labels red; the page frame is black
// too, and is told apart by length (dropFrame).
const PATH = { moveTo: 0, lineTo: 1, curveTo: 2, quadraticCurveTo: 3, closePath: 4 };
const OUTLINE_INK = 0x30; // each channel at or below this is black; the frame's grey (#404040) is not
const SNAP = 2.5; // pt: ends this close are one corner, and a corner this close to a line is on it
const MIN_VECTOR_PERIMETER = 60; // pt

const mulMatrix = (m, n) => [ // m first, then n (PDF's "cm": new = m x current)
  n[0] * m[0] + n[2] * m[1], n[1] * m[0] + n[3] * m[1],
  n[0] * m[2] + n[2] * m[3], n[1] * m[2] + n[3] * m[3],
  n[0] * m[4] + n[2] * m[5] + n[4], n[1] * m[4] + n[3] * m[5] + n[5],
];

// The black stroked straight lines of a page, as [x1, y1, x2, y2] in points with y running down
// the page. list: pdf.js's getOperatorList() result; OPS: pdf.js's OPS table; view: page.view.
// Curves are skipped (an FMB parcel is straight lines); text is glyph shapes, filled, never stroked.
export function strokedLinesFromOps(list, OPS, view) {
  const strokeOps = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const stack = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  let black = true; // the initial stroke colour is black
  const lines = [];
  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i];
    const args = list.argsArray[i];
    if (fn === OPS.save) stack.push([ctm, black]);
    else if (fn === OPS.restore) [ctm, black] = stack.pop() ?? [[1, 0, 0, 1, 0, 0], true];
    else if (fn === OPS.transform) ctm = mulMatrix(args, ctm);
    else if (fn === OPS.setStrokeRGBColor) black = /^#[0-9a-f]{6}$/i.test(args?.[0] ?? '') && [1, 3, 5].every((k) => parseInt(args[0].slice(k, k + 2), 16) <= OUTLINE_INK);
    else if (fn === OPS.constructPath && black && strokeOps.has(args?.[0])) {
      const d = args[1]?.[0];
      if (!d || typeof d.length !== 'number') continue;
      const at = (x, y) => [ctm[0] * x + ctm[2] * y + ctm[4] - view[0], view[3] - (ctm[1] * x + ctm[3] * y + ctm[5])];
      let start = null, cur = null;
      for (let k = 0; k < d.length; ) {
        const op = d[k++];
        if (op === PATH.moveTo) { cur = start = at(d[k], d[k + 1]); k += 2; }
        else if (op === PATH.lineTo) { const p = at(d[k], d[k + 1]); k += 2; if (cur) lines.push([...cur, ...p]); cur = p; }
        else if (op === PATH.curveTo) { cur = at(d[k + 4], d[k + 5]); k += 6; }
        else if (op === PATH.quadraticCurveTo) { cur = at(d[k + 2], d[k + 3]); k += 4; }
        else if (op === PATH.closePath) { if (cur && start) lines.push([...cur, ...start]); cur = start; }
        else break; // not a path we understand
      }
    }
  }
  return lines;
}

// The parcel outline from a page's black lines (strokedLinesFromOps), or null. page: { width, height }.
export function shapeFromLines(lines, page) {
  const kept = dropFrame(lines.filter(([x1, y1, x2, y2]) => Math.hypot(x2 - x1, y2 - y1) >= 1), page);
  const edges = vectorEdges(kept);
  if (edges.length < 3) return null;
  const perimeter = edges.reduce((n, [p, q]) => n + Math.hypot(p[0] - q[0], p[1] - q[1]), 0);
  if (perimeter < MIN_VECTOR_PERIMETER) return null;
  return draw(edges);
}

// The sketch sits in a ruled frame: an outer border, a rule under the header and one above the
// footer. They are straight horizontal or vertical lines nearly as long as the frame is wide or
// tall, which no side of a parcel (drawn inside the frame, with its labels around it) is.
function dropFrame(lines, { width, height }) {
  const axis = (l) => (Math.abs(l[0] - l[2]) < 1 ? 'v' : Math.abs(l[1] - l[3]) < 1 ? 'h' : null);
  const len = (l) => Math.hypot(l[2] - l[0], l[3] - l[1]);
  const longest = { h: 0, v: 0 };
  for (const l of lines) if (axis(l)) longest[axis(l)] = Math.max(longest[axis(l)], len(l));
  const floor = { h: 0.5 * width, v: 0.5 * height };
  return lines.filter((l) => {
    const a = axis(l);
    return !(a && len(l) >= 0.9 * longest[a] && len(l) >= floor[a]);
  });
}

// Straight lines -> the edges that lie on a closed loop. Ends that meet (within SNAP) are one
// corner, a corner on the inside of another line splits it, and lines that cross split each
// other; then every line is cut into pieces between corners, and pieces ending at a corner nothing
// else meets (a tick past the end of a side, a stub) are dropped until only loops remain.
function vectorEdges(lines) {
  const nodes = [];
  const nodeAt = (p) => {
    let k = nodes.findIndex((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) <= SNAP);
    if (k < 0) k = nodes.push(p) - 1;
    return k;
  };
  const segs = lines.map(([x1, y1, x2, y2]) => ({ a: nodeAt([x1, y1]), b: nodeAt([x2, y2]), cuts: [] }));
  const along = (s, p) => {
    const [ax, ay] = nodes[s.a], [bx, by] = nodes[s.b];
    const dx = bx - ax, dy = by - ay, n2 = dx * dx + dy * dy;
    return n2 === 0 ? null : { t: ((p[0] - ax) * dx + (p[1] - ay) * dy) / n2, off: Math.abs((p[0] - ax) * dy - (p[1] - ay) * dx) / Math.sqrt(n2), len: Math.sqrt(n2) };
  };
  // A corner that lies on the inside of a line.
  const ends = nodes.length;
  for (const s of segs) {
    if (s.a === s.b) continue;
    for (let k = 0; k < ends; k++) {
      if (k === s.a || k === s.b) continue;
      const m = along(s, nodes[k]);
      if (m && m.off <= SNAP && m.t > 0 && m.t < 1 && m.t * m.len > SNAP && (1 - m.t) * m.len > SNAP) s.cuts.push([m.t, k]);
    }
  }
  // Two lines that cross each other.
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const A = segs[i], B = segs[j];
      if (A.a === A.b || B.a === B.b) continue;
      const [p, q] = [nodes[A.a], nodes[A.b]], [r, u] = [nodes[B.a], nodes[B.b]];
      const d1x = q[0] - p[0], d1y = q[1] - p[1], d2x = u[0] - r[0], d2y = u[1] - r[1];
      const det = d1x * d2y - d1y * d2x;
      if (Math.abs(det) < 0.05 * Math.hypot(d1x, d1y) * Math.hypot(d2x, d2y)) continue; // parallel
      const t = ((r[0] - p[0]) * d2y - (r[1] - p[1]) * d2x) / det;
      const v = ((r[0] - p[0]) * d1y - (r[1] - p[1]) * d1x) / det;
      if (t <= 0 || t >= 1 || v <= 0 || v >= 1) continue;
      const k = nodeAt([p[0] + t * d1x, p[1] + t * d1y]);
      A.cuts.push([t, k]);
      B.cuts.push([v, k]);
    }
  }
  const seen = new Set();
  let edges = [];
  for (const s of segs) {
    const chain = [[0, s.a], ...s.cuts.sort((x, y) => x[0] - y[0]), [1, s.b]];
    for (let k = 1; k < chain.length; k++) {
      const u = chain[k - 1][1], v = chain[k][1];
      if (u === v) continue;
      const key = u < v ? `${u}-${v}` : `${v}-${u}`;
      if (!seen.has(key)) {
        seen.add(key);
        edges.push([u, v]);
      }
    }
  }
  for (let changed = true; changed; ) {
    const degree = new Map();
    for (const [u, v] of edges) {
      degree.set(u, (degree.get(u) ?? 0) + 1);
      degree.set(v, (degree.get(v) ?? 0) + 1);
    }
    const next = edges.filter(([u, v]) => degree.get(u) > 1 && degree.get(v) > 1);
    changed = next.length !== edges.length;
    edges = next;
  }
  return edges.map(([u, v]) => [nodes[u], nodes[v]]);
}

// ---- 3. drawing --------------------------------------------------------------

function draw(edges) {
  const pts = edges.flat();
  const minX = Math.min(...pts.map((p) => p[0])), maxX = Math.max(...pts.map((p) => p[0]));
  const minY = Math.min(...pts.map((p) => p[1])), maxY = Math.max(...pts.map((p) => p[1]));
  const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
  const f = (MAX_SIDE - 2 * PAD) / Math.max(bw, bh);
  const w = Math.round(bw * f) + 2 * PAD + 1, h = Math.round(bh * f) + 2 * PAD + 1;
  const dot = new Uint8Array(w * h);
  for (const [p, q] of edges) {
    const x0 = (p[0] - minX) * f + PAD, y0 = (p[1] - minY) * f + PAD, x1 = (q[0] - minX) * f + PAD, y1 = (q[1] - minY) * f + PAD;
    const steps = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2) + 1;
    for (let k = 0; k <= steps; k++) {
      const x = Math.round(x0 + ((x1 - x0) * k) / steps), y = Math.round(y0 + ((y1 - y0) * k) / steps);
      if (x >= 0 && y >= 0 && x < w && y < h) dot[y * w + x] = 1;
    }
  }
  const alpha = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!dot[y * w + x]) continue;
      for (let dy = -GROW; dy <= GROW; dy++) {
        for (let dx = -GROW; dx <= GROW; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h) alpha[ny * w + nx] = 255;
        }
      }
    }
  }
  return { png: encodePng(alpha, w, h), width: w, height: h };
}

// A single-colour PNG whose alpha channel is the shape.
function encodePng(alpha, w, h) {
  const row = 1 + w * 4;
  const raw = new Uint8Array(row * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * row + 1 + x * 4;
      raw[o] = INK[0]; raw[o + 1] = INK[1]; raw[o + 2] = INK[2]; raw[o + 3] = alpha[y * w + x];
    }
  }
  const chunk = (type, body) => {
    const out = new Uint8Array(12 + body.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, body.length);
    out.set([...type].map((c) => c.charCodeAt(0)), 4);
    out.set(body, 8);
    view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, w); iv.setUint32(4, h);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0))];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { png.set(p, at); at += p.length; }
  return png;
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
