// The shape of a parcel, from the field sketch ("புலப்படம்") on page 2 of a single-survey
// Integrated Land Record. The sketch is a small bitmap, not vector lines, so it can't be
// redrawn from coordinates. What can be done reliably is to keep only the long thin black
// strokes (the parcel's outline) and drop everything else: the survey numbers of the
// neighbouring parcels, the red and blue labels and ticks. The result is a transparent
// PNG of the outline alone, with no text on it. Pure: no I/O.
import { deflateSync } from 'node:zlib';

const INK = [0x29, 0x4a, 0x36]; // --tvc-green-dark; baked in because an <img> can't read CSS tokens
const MIN_STROKE = 20; // px: shorter than this is a letter, a digit or a speck
const MAX_THICKNESS = 3.5; // ink pixels per px of length: a word of text is far denser than a line
const MIN_SIDE = 150; // px: a smaller image is the emblem or the QR code, not a sketch
const MIN_INK = 150;
const PAD = 8;
const MAX_SIDE = 72; // px: the shape is shown as a small inline mark
const GROW = 1; // thicken the lines after shrinking

// image: { data: Uint8Array|Uint8ClampedArray, width, height, channels: 1|3|4 }
// Returns { png: Uint8Array, width, height } or null when no outline is found.
export function shapeFromSketch(image) {
  if (!image) return null;
  const { data, width, height, channels } = image;
  if (!data || width < MIN_SIDE || height < MIN_SIDE || ![1, 3, 4].includes(channels)) return null;
  const black = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * channels;
    const [r, g, b] = channels === 1 ? [data[o], data[o], data[o]] : [data[o], data[o + 1], data[o + 2]];
    // Dark and not coloured: the outline is black, the labels and ticks are red or blue.
    if (r < 110 && g < 110 && b < 110 && Math.max(r, g, b) - Math.min(r, g, b) < 40) black[i] = 1;
  }

  // Connected strokes (8-neighbour), keeping the long thin ones.
  const seen = new Uint8Array(width * height);
  const keep = new Uint8Array(width * height);
  const stack = [];
  let minX = width, minY = height, maxX = -1, maxY = -1, ink = 0;
  for (let start = 0; start < black.length; start++) {
    if (!black[start] || seen[start]) continue;
    const pixels = [];
    let x0 = width, y0 = height, x1 = -1, y1 = -1;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const p = stack.pop();
      pixels.push(p);
      const x = p % width, y = (p / width) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const q = ny * width + nx;
          if (black[q] && !seen[q]) {
            seen[q] = 1;
            stack.push(q);
          }
        }
      }
    }
    const length = Math.hypot(x1 - x0 + 1, y1 - y0 + 1);
    if (length < MIN_STROKE || pixels.length / length > MAX_THICKNESS) continue;
    ink += pixels.length;
    for (const p of pixels) keep[p] = 1;
    minX = Math.min(minX, x0); maxX = Math.max(maxX, x1); minY = Math.min(minY, y0); maxY = Math.max(maxY, y1);
  }
  // A real outline is a few hundred pixels of line; a speck or a single tick is not a shape.
  if (ink < MIN_INK) return null;

  // Crop to the outline, then shrink so the longer side is MAX_SIDE: a stroke that is a pixel
  // wide in a big bitmap would vanish when the browser scales it down to a small inline mark.
  // A cell of the small image is ink when any pixel of the cell it covers is.
  const cx = Math.max(0, minX - PAD), cy = Math.max(0, minY - PAD);
  const cw = Math.min(width, maxX + PAD + 1) - cx, ch = Math.min(height, maxY + PAD + 1) - cy;
  const f = Math.min(1, MAX_SIDE / Math.max(cw, ch));
  const w = Math.max(1, Math.round(cw * f)), h = Math.max(1, Math.round(ch * f));
  const small = new Uint8Array(w * h);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      if (keep[(y + cy) * width + (x + cx)]) small[Math.min(h - 1, Math.floor(y * f)) * w + Math.min(w - 1, Math.floor(x * f))] = 1;
    }
  }
  const alpha = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!small[y * w + x]) continue;
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

// The largest image on the sketch page that is big enough to be one. images: unpdf's extractImages().
export function pickSketch(images) {
  const big = (images ?? []).filter((i) => i.width >= MIN_SIDE && i.height >= MIN_SIDE);
  big.sort((a, b) => b.width * b.height - a.width * a.height);
  return big[0] ?? null;
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
