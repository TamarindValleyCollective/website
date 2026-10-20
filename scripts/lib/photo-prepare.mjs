// Runs in the member's browser (the portal's "Your story" page): turns a chosen photo into the two
// JPEGs the server accepts (scripts/lib/member-photo.mjs): a 400x400 centre-cropped square for the
// card, and an uncropped copy up to 1600px for click-to-enlarge.
//
// Drawing through a canvas also drops everything else in the file: the camera's make and model, the
// time, and above all the GPS position, which the server then refuses to accept if it is still there.
// imageOrientation 'from-image' applies the camera's rotation first, so a phone photo is upright.
import { FULL_PX_MAX, MAX_FULL_BYTES, MAX_SQUARE_BYTES, SQUARE_PX_MIN } from './member-photo.mjs';

export const SQUARE_PX = 400;

const toBlob = (canvas, quality) =>
  new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not prepare the photo.'))), 'image/jpeg', quality));

// The best quality that fits the size limit.
async function encode(canvas, maxBytes) {
  for (const quality of [0.85, 0.75, 0.65, 0.5]) {
    const blob = await toBlob(canvas, quality);
    if (blob.size <= maxBytes) return blob;
  }
  throw new Error('That photo is too large. Try a smaller one.');
}

function draw(bitmap, sx, sy, sw, sh, w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // a transparent PNG becomes white, not black
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, w, h);
  return canvas;
}

/** @param {File} file @returns {Promise<{ square: Blob, full: Blob }>} */
export async function preparePhoto(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('Choose a JPEG, PNG or WebP photo.');
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('That image could not be read. Try a JPEG or PNG.');
  }
  const { width, height } = bitmap;
  if (Math.min(width, height) < SQUARE_PX_MIN) throw new Error(`That photo is too small. Use one at least ${SQUARE_PX_MIN} pixels across.`);
  if (Math.max(width, height) / Math.min(width, height) > 4) throw new Error('Use a photo that is not extremely wide or tall.');

  const side = Math.min(width, height);
  const square = await encode(draw(bitmap, (width - side) / 2, (height - side) / 2, side, side, SQUARE_PX, SQUARE_PX), MAX_SQUARE_BYTES);
  const scale = Math.min(1, FULL_PX_MAX / Math.max(width, height));
  const full = await encode(draw(bitmap, 0, 0, width, height, Math.round(width * scale), Math.round(height * scale)), MAX_FULL_BYTES);
  bitmap.close?.();
  return { square, full };
}
