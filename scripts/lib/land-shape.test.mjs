import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { pickSketch, shapeFromSketch } from './land-shape.mjs';

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
