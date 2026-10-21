// Member photos: what may be stored, where, and who may see it. Pure (no network), so the
// rules are tested on their own; netlify/functions/members-me.mts and members-admin.mts call these.
//
// A photo is two JPEGs made in the member's browser (a canvas re-encode, which is meant to drop the
// camera's location and other metadata): a 400x400 square for the card, and an uncropped copy
// up to 1600px for click-to-enlarge. The server never trusts that: it checks the bytes really are
// JPEGs and the sizes, and it REMOVES every metadata block itself (stripJpegMetadata) and stores only
// the cleaned bytes. It used to refuse a file that still had an EXIF block, but Safari's canvas export
// writes a small one of its own (colour space, pixel size), so an iPhone upload was refused for a header
// with nothing private in it. Removing it keeps the guarantee, whatever the browser did.
//
// A story's photo is a string inside its draft / submitted / approved copy, like the text:
//   - a uuid: an uploaded photo, kept in the private R2 bucket under member-photos/<person>/<uuid>
//   - a path under /images/members/: a photo that is already on the public site (the seeded cards)
//   - empty: none
// Because it rides in the same copy as the text, a new photo is reviewed with the text and an edit
// never changes the live (approved) photo until the core team approves it.

export const SQUARE_PX_MIN = 200;
export const SQUARE_PX_MAX = 512;
export const FULL_PX_MAX = 1600;
export const MAX_SQUARE_BYTES = 250 * 1024;
export const MAX_FULL_BYTES = 1024 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LEGACY = /^\/images\/members\/[a-z0-9-]+\.(jpg|jpeg|png|webp|avif)$/;

export const isUploadedPhoto = (ref) => typeof ref === 'string' && UUID.test(ref);
export const isLegacyPhoto = (ref) => typeof ref === 'string' && LEGACY.test(ref);
export const isPhotoRef = (ref) => isUploadedPhoto(ref) || isLegacyPhoto(ref);

// R2 keys for an uploaded photo. Both ids are uuids, so a key can never address another path.
export function photoKeys(personId, photoId) {
  if (!UUID.test(personId) || !UUID.test(photoId)) throw new Error('Invalid photo key');
  return { square: `member-photos/${personId}/${photoId}.jpg`, full: `member-photos/${personId}/${photoId}-full.jpg` };
}

// Reads a JPEG's size and whether it carries an EXIF block, without decoding it.
// Returns { ok: true, width, height, hasExif } or { ok: false, error }.
export function jpegInfo(bytes) {
  const b = bytes;
  if (!(b instanceof Uint8Array) || b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return { ok: false, error: 'That is not a JPEG image.' };
  let i = 2;
  let hasExif = false;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return { ok: false, error: 'That image file is damaged.' };
    const marker = b[i + 1];
    if (marker === 0xff) { i += 1; continue; } // padding
    if (marker === 0xd9 || marker === 0xda) break; // end of image / start of the pixel data
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; } // markers with no length
    const length = (b[i + 2] << 8) | b[i + 3];
    if (length < 2 || i + 2 + length > b.length) return { ok: false, error: 'That image file is damaged.' };
    if (marker === 0xe1 && b[i + 4] === 0x45 && b[i + 5] === 0x78 && b[i + 6] === 0x69 && b[i + 7] === 0x66) hasExif = true; // APP1 "Exif"
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (length < 8) return { ok: false, error: 'That image file is damaged.' };
      const height = (b[i + 5] << 8) | b[i + 6];
      const width = (b[i + 7] << 8) | b[i + 8];
      if (!width || !height) return { ok: false, error: 'That image file is damaged.' };
      // Keep scanning for an EXIF block that follows the frame header (rare), but the size is known.
      let j = i + 2 + length;
      while (j + 4 <= b.length && b[j] === 0xff && b[j + 1] !== 0xda && b[j + 1] !== 0xd9) {
        const m = b[j + 1];
        if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { j += 2; continue; }
        const l = (b[j + 2] << 8) | b[j + 3];
        if (l < 2) break;
        if (m === 0xe1 && b[j + 4] === 0x45 && b[j + 5] === 0x78 && b[j + 6] === 0x69 && b[j + 7] === 0x66) hasExif = true;
        j += 2 + l;
      }
      return { ok: true, width, height, hasExif };
    }
    i += 2 + length;
  }
  return { ok: false, error: 'That image file is damaged.' };
}

const fail = (error) => ({ ok: false, error });

// Removes every metadata segment from a JPEG that jpegInfo has accepted, copying everything else byte for
// byte: EXIF (where the position and the camera's make live), XMP, IPTC, comments, multi-picture offsets and
// every other application block. Kept: the JFIF header, the ICC colour profile (without it a Display P3 photo
// looks washed out) and Adobe's colour-transform marker. Anything after the end of the image is dropped.
const ICC = [0x49, 0x43, 0x43, 0x5f, 0x50, 0x52, 0x4f, 0x46, 0x49, 0x4c, 0x45, 0x00]; // "ICC_PROFILE\0"
export function stripJpegMetadata(bytes) {
  const out = [bytes.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= bytes.length && bytes[i] === 0xff) {
    const marker = bytes[i + 1];
    if (marker === 0xff) { i += 1; continue; } // padding
    if (marker === 0xda) break; // the pixel data starts here
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { out.push(bytes.subarray(i, i + 2)); i += 2; continue; }
    const end = i + 2 + ((bytes[i + 2] << 8) | bytes[i + 3]);
    const colourProfile = marker === 0xe2 && ICC.every((c, k) => bytes[i + 4 + k] === c);
    const metadata = (marker >= 0xe1 && marker <= 0xef && !colourProfile && marker !== 0xee) || marker === 0xfe;
    if (!metadata) out.push(bytes.subarray(i, end));
    i = end;
  }
  // From the start of the scan to the first end-of-image marker (inside the data a 0xff is followed by 0x00 or a restart
  // marker, never 0xd9), exactly as it was.
  let eoi = bytes.length;
  for (let j = i; j + 1 < bytes.length; j++) {
    if (bytes[j] === 0xff && bytes[j + 1] === 0xd9) { eoi = j + 2; break; }
  }
  out.push(bytes.subarray(i, eoi));
  const cleaned = new Uint8Array(out.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of out) { cleaned.set(part, at); at += part.length; }
  return cleaned;
}

// The two files of one upload. Anything the page's own resizing would never produce is refused; what is accepted comes
// back with its metadata removed, and THAT is what must be stored: { ok: true, square, full }.
export function validatePhotoPair(square, full) {
  if (!(square instanceof Uint8Array) || !(full instanceof Uint8Array)) return fail('Choose a photo.');
  if (square.length > MAX_SQUARE_BYTES || full.length > MAX_FULL_BYTES) return fail('That photo is too large. Try a smaller one.');
  const s = jpegInfo(square);
  if (!s.ok) return fail(s.error);
  const f = jpegInfo(full);
  if (!f.ok) return fail(f.error);
  if (s.width !== s.height || s.width < SQUARE_PX_MIN || s.width > SQUARE_PX_MAX) return fail('The photo was not prepared correctly. Reload the page and try again.');
  if (Math.max(f.width, f.height) > FULL_PX_MAX || Math.min(f.width, f.height) < SQUARE_PX_MIN) return fail('The photo was not prepared correctly. Reload the page and try again.');
  return { ok: true, square: stripJpegMetadata(square), full: stripJpegMetadata(full) };
}

