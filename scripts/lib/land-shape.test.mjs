import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { SHAPE_VERSION, pickSketch, shapeFromLines, shapeFromSketch, shapeNeedsRefresh, strokedLinesFromOps, withShapeResult } from './land-shape.mjs';

// A white RGB image with drawing helpers.
function canvas(width, height) {
  const data = new Uint8Array(width * height * 3).fill(255);
  const dot = (x, y, [r, g, b]) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    data.set([r, g, b], (y * width + x) * 3);
  };
  const line = (x0, y0, x1, y1, color = [0, 0, 0]) => {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let i = 0; i <= n; i++) dot(Math.round(x0 + ((x1 - x0) * i) / n), Math.round(y0 + ((y1 - y0) * i) / n), color);
  };
  // A stand-in for a printed label: several small, separate glyph-sized blocks side by side.
  const label = (x, y, glyphs, color = [0, 0, 0]) => {
    for (let g = 0; g < glyphs; g++) for (let i = 0; i < 6; i++) for (let j = 0; j < 9; j++) if ((i + j + g) % 3 !== 0) dot(x + g * 9 + i, y + j, color);
  };
  return { width, height, channels: 3, data, dot, line, label };
}

// Decodes the RGBA PNG that shapeFromSketch writes, to check what is on it.
function alphaOf({ png, width, height }) {
  const idat = [];
  for (let at = 8; at < png.length; ) {
    const len = new DataView(png.buffer, png.byteOffset + at).getUint32(0);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    if (type === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const row = 1 + width * 4;
  const alpha = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) alpha.push(raw[y * row + 1 + x * 4 + 3]);
  return alpha;
}

function sketch() {
  const c = canvas(450, 500);
  // The parcel: a thin wedge and its base line.
  c.line(155, 100, 220, 470);
  c.line(155, 100, 260, 470);
  c.line(180, 468, 300, 474);
  // What is around it: neighbours' survey numbers in black, a red and a blue label, a blue tick.
  c.label(140, 50, 4);
  c.label(100, 290, 3);
  c.label(335, 240, 1);
  c.label(150, 82, 2, [220, 30, 30]);
  c.label(195, 357, 2, [30, 30, 220]);
  c.line(248, 470, 232, 500, [30, 30, 220]);
  return c;
}

test('keeps the outline and drops every label, the red and blue text and the blue tick', () => {
  const out = shapeFromSketch(sketch());
  assert.ok(out);
  // Cropped to the outline and shrunk to a small mark: taller than wide, the longer side 72px.
  assert.ok(out.height >= 72 && out.height <= 74, `${out.height}`);
  assert.ok(out.width < out.height / 2, `${out.width}x${out.height}`);
  const alpha = alphaOf(out);
  assert.ok(alpha.some((a) => a === 255));
  // Taller than wide, with the base at the bottom: ink along the last rows, none of the label blocks in the top-left.
  const inkAt = (x, y) => alpha[y * out.width + x] === 255;
  assert.ok([...Array(out.width).keys()].some((x) => inkAt(x, out.height - 4)));
});

test('labels touching the outline do not hide it', () => {
  // The whole drawing is one connected blob here: a column of neighbours' numbers butts against the left edge.
  const c = canvas(450, 500);
  c.line(140, 60, 100, 450); // left edge
  c.line(100, 450, 260, 470);
  c.line(260, 470, 300, 100);
  c.line(300, 100, 140, 60);
  for (let y = 70; y < 400; y += 22) c.label(141, y, 3); // each label starts on the edge
  const out = shapeFromSketch(c);
  assert.ok(out, 'the outline is found');
  assert.ok(out.height >= 72 && out.height <= 74);
  const alpha = alphaOf(out);
  const inkAt = (x, y) => alpha[y * out.width + x] === 255;
  // The far (right) edge is a clean line: ink in its column near mid-height.
  assert.ok([...Array(out.width).keys()].some((x) => x > out.width * 0.7 && inkAt(x, Math.round(out.height / 2))));
});

test('lines running past the corners are cut off: the shape is the polygon only', () => {
  const c = canvas(450, 500);
  // A 100 x 200 rectangle whose four borders all run 80px past the corners, as the sketches draw them.
  c.line(120, 100, 220, 100); c.line(40, 100, 300, 100);
  c.line(120, 300, 220, 300); c.line(40, 300, 300, 300);
  c.line(120, 20, 120, 380);
  c.line(220, 20, 220, 380);
  const out = shapeFromSketch(c);
  assert.ok(out);
  // The rectangle is 1:2. With the extensions it would be 260 x 360 (about 3:4).
  const ratio = out.width / out.height;
  assert.ok(ratio > 0.4 && ratio < 0.6, `ratio ${ratio}`);
});

test('a sketch with only text on it gives no shape', () => {
  const c = canvas(450, 500);
  c.label(140, 50, 4);
  c.label(100, 290, 3);
  c.label(335, 240, 1);
  assert.equal(shapeFromSketch(c), null);
});

test('images too small to be a sketch, or in an unknown format, give no shape', () => {
  assert.equal(shapeFromSketch(canvas(100, 100)), null);
  assert.equal(shapeFromSketch({ ...sketch(), channels: 2 }), null);
  assert.equal(shapeFromSketch(null), null);
});

test('the output is a valid PNG with a transparent background', () => {
  const out = shapeFromSketch(sketch());
  assert.deepEqual([...out.png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const alpha = alphaOf(out);
  assert.ok(alpha.filter((a) => a === 0).length > alpha.length * 0.6); // mostly transparent
});

test('picks the sketch, not the emblem or the QR code', () => {
  const images = [{ width: 250, height: 167 }, { width: 450, height: 500 }, { width: 100, height: 100 }];
  assert.equal(pickSketch(images).width, 450);
  assert.equal(pickSketch([{ width: 100, height: 100 }]), null);
  assert.equal(pickSketch(undefined), null);
});

// What was stored by earlier readers must be redone once; what the current reader stored must not.
test('outlines and "no outline" verdicts from an older reader are refreshed once', () => {
  const one = (over) => ({ records: [{ surveyNo: '450/3C' }], ...over });
  assert.equal(shapeNeedsRefresh(one({})), true, 'never checked');
  assert.equal(shapeNeedsRefresh(one({ shapeChecked: true })), true, 'gave up under the first reader');
  assert.equal(shapeNeedsRefresh(one({ shapeChecked: SHAPE_VERSION - 1 })), true, 'gave up under an earlier version');
  assert.equal(shapeNeedsRefresh(one({ hasShape: true })), true, 'outline made before versions existed');
  assert.equal(shapeNeedsRefresh(one({ hasShape: true, shapeVersion: SHAPE_VERSION - 1 })), true, 'outline from an earlier version');
  assert.equal(shapeNeedsRefresh(one({ hasShape: true, shapeVersion: SHAPE_VERSION })), false, 'current outline');
  assert.equal(shapeNeedsRefresh(one({ shapeChecked: SHAPE_VERSION })), false, 'current "no outline"');
  assert.equal(shapeNeedsRefresh({ records: [{}, {}] }), false, 'a multi-survey patta has no sketch');
  assert.equal(shapeNeedsRefresh(null), false);
});

test('the stored flags always say which reader made them, and replace older ones', () => {
  const old = { records: [1], hasShape: true, shapeChecked: true };
  assert.deepEqual(withShapeResult(old, true), { records: [1], hasShape: true, shapeVersion: SHAPE_VERSION });
  assert.deepEqual(withShapeResult(old, false), { records: [1], shapeChecked: SHAPE_VERSION });
  assert.equal(shapeNeedsRefresh(withShapeResult(old, true)), false);
  assert.equal(shapeNeedsRefresh(withShapeResult(old, false)), false);
});

test('a stand-alone FMB sketch keeps its outline refreshed too, and a patta page is not mistaken for one', () => {
  assert.equal(shapeNeedsRefresh({ kind: 'fmb_sketch', surveyNo: '478/7' }), true);
  assert.equal(shapeNeedsRefresh({ kind: 'fmb_sketch', hasShape: true, shapeVersion: SHAPE_VERSION - 1 }), true);
  assert.equal(shapeNeedsRefresh({ kind: 'fmb_sketch', hasShape: true, shapeVersion: SHAPE_VERSION }), false);
  assert.deepEqual(withShapeResult({ kind: 'fmb_sketch', surveyNo: '478/7' }, true), { kind: 'fmb_sketch', surveyNo: '478/7', hasShape: true, shapeVersion: SHAPE_VERSION });
});

// ---- vector sketches -------------------------------------------------------------

// The sketch of survey 478/7 as e-Services draws it: pdf.js operations with y running up the page.
const OPS = { save: 10, restore: 11, transform: 12, setStrokeRGBColor: 13, constructPath: 14, stroke: 20, closeStroke: 21, fill: 22, endPath: 28, fillStroke: 24, eoFillStroke: 25, closeFillStroke: 26, closeEOFillStroke: 27 };
const view = [0, 0, 595, 841];
const seg = (x1, y1, x2, y2, paint = OPS.stroke) => [OPS.constructPath, [paint, [[0, x1, y1, 1, x2, y2]], [x1, y1, x2, y2]]];
const color = (hex) => [OPS.setStrokeRGBColor, [hex]];
const ops = (...items) => ({ fnArray: items.map((i) => i[0]), argsArray: items.map((i) => i[1] ?? null) });

// Parcel: top 1a-b25, left side (in two pieces, as drawn: it bends 0.1 degrees at 1b), bottom c1-c2,
// right side (two pieces). Then what is around it.
const parcel = [
  seg(225, 525, 326, 515), // top
  seg(225, 525, 266, 246), seg(266, 246, 273, 199), // left, bent at 1b
  seg(273, 198, 363, 198), // bottom
  seg(363, 198, 358, 238), seg(358, 238, 326, 515), // right, bent at b23
];
const around = [
  seg(225, 525, 201, 522), // tick past the top-left corner
  seg(266, 246, 241, 243), // tick at 1b, on the left side
  seg(358, 238, 383, 242), seg(358, 238, 383, 242), // tick at b23, drawn twice
  seg(326, 515, 351, 516), // tick at b25
  seg(34, 807, 34, 34), seg(34, 34, 561, 34), seg(561, 34, 561, 807), seg(561, 807, 34, 807), // the frame
  seg(561, 726, 34, 726), // the rule under the header
];
const blue = [color('#0000ff'), seg(225, 515, 326, 525), seg(225, 246, 266, 525), seg(1000, 1000, 1200, 1200)];

test('draws the parcel from the black lines and ignores the frame, ticks, double-drawn lines and blue dimensions', () => {
  const lines = strokedLinesFromOps(ops(color('#000000'), ...parcel, ...around, ...blue, color('#404040'), seg(1, 840, 1, 1)), OPS, view);
  const out = shapeFromLines(lines, { width: 595, height: 841 });
  assert.ok(out);
  // Taller than wide (26 m by about 9 m), the longer side 72px.
  assert.ok(out.height >= 72 && out.height <= 74, `${out.height}`);
  assert.ok(out.width < out.height / 1.5, `${out.width}`);
  // Hollow: the middle of the shape is empty, so it is an outline and not a blob.
  const a = alphaOf(out);
  assert.equal(a[Math.floor(out.height / 2) * out.width + Math.floor(out.width / 2)], 0);
  // The page frame would have made it as wide as the page.
  assert.ok(a.some((v) => v === 255));
});

test('keeps the page up the right way: the top of the page is the top of the shape', () => {
  // A triangle with its point up (y runs up in a PDF).
  const lines = strokedLinesFromOps(ops(seg(100, 100, 200, 100), seg(200, 100, 150, 300), seg(150, 300, 100, 100)), OPS, view);
  const out = shapeFromLines(lines, { width: 595, height: 841 });
  const a = alphaOf(out);
  const rowSum = (y) => a.slice(y * out.width, (y + 1) * out.width).filter(Boolean).length;
  assert.ok(rowSum(1) < rowSum(out.height - 3), 'narrow at the top, wide at the bottom');
});

test('follows the scale and shift a page puts on its drawing, inside save and restore', () => {
  const scaled = ops(
    [OPS.save], [OPS.transform, [0.5, 0, 0, 0.5, 40, 60]], color('#000000'),
    seg(100, 100, 300, 100), seg(300, 100, 300, 400), seg(300, 400, 100, 400), seg(100, 400, 100, 100),
    [OPS.restore],
    seg(5000, 5000, 5100, 5000), // outside the save: not scaled
  );
  const lines = strokedLinesFromOps(scaled, OPS, view);
  assert.deepEqual(lines[0], [90, 841 - 110, 190, 841 - 110]);
  assert.ok(shapeFromLines(lines.slice(0, 4), { width: 595, height: 841 }));
});

test('a colour set inside a save does not leak out of the restore', () => {
  const l = strokedLinesFromOps(ops([OPS.save], color('#0000ff'), seg(1, 1, 50, 1), [OPS.restore], seg(1, 5, 50, 5)), OPS, view);
  assert.equal(l.length, 1);
  assert.equal(l[0][1], 841 - 5);
});

test('filled shapes (text) and curves are not outline lines', () => {
  assert.deepEqual(strokedLinesFromOps(ops(seg(1, 1, 50, 1, OPS.fill), seg(1, 1, 50, 1, OPS.endPath)), OPS, view), []);
  const curve = [OPS.constructPath, [OPS.stroke, [[0, 1, 1, 2, 5, 5, 9, 9, 20, 1]], [1, 1, 20, 9]]];
  assert.deepEqual(strokedLinesFromOps(ops(curve), OPS, view), []);
});

test('a ruled table is not a parcel, and lines that do not close make no shape', () => {
  // Rows and columns crossing: closed boxes, but they span the page, so they are the frame.
  const table = [seg(34, 700, 561, 700), seg(34, 600, 561, 600), seg(34, 500, 561, 500), seg(34, 500, 34, 700), seg(298, 500, 298, 700), seg(561, 500, 561, 700)];
  assert.equal(shapeFromLines(strokedLinesFromOps(ops(...table), OPS, view), { width: 595, height: 841 }), null);
  // Two sides of a parcel only.
  assert.equal(shapeFromLines([[100, 100, 100, 300], [100, 300, 200, 320]], { width: 595, height: 841 }), null);
  assert.equal(shapeFromLines([], { width: 595, height: 841 }), null);
});
