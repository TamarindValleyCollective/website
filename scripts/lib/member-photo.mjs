// Member photos: what may be stored, where, and who may see it. Pure (no network), so the
// rules are tested on their own; netlify/functions/members-me.mts and members-admin.mts call these.
//
// A photo is two JPEGs made in the member's browser (a canvas re-encode, which also drops the
// camera's location and other metadata): a 400x400 square for the card, and an uncropped copy
// up to 1600px for click-to-enlarge. The server never trusts that: it checks the bytes really are
// JPEGs, the sizes, and that no EXIF block (where GPS lives) was left in.
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

// The two files of one upload. Anything the page's own resizing would never produce is refused.
export function validatePhotoPair(square, full) {
  if (!(square instanceof Uint8Array) || !(full instanceof Uint8Array)) return fail('Choose a photo.');
  if (square.length > MAX_SQUARE_BYTES || full.length > MAX_FULL_BYTES) return fail('That photo is too large. Try a smaller one.');
  const s = jpegInfo(square);
  if (!s.ok) return fail(s.error);
  const f = jpegInfo(full);
  if (!f.ok) return fail(f.error);
  if (s.hasExif || f.hasExif) return fail('That photo still carries camera or location details. Reload the page and try again.');
  if (s.width !== s.height || s.width < SQUARE_PX_MIN || s.width > SQUARE_PX_MAX) return fail('The photo was not prepared correctly. Reload the page and try again.');
  if (Math.max(f.width, f.height) > FULL_PX_MAX || Math.min(f.width, f.height) < SQUARE_PX_MIN) return fail('The photo was not prepared correctly. Reload the page and try again.');
  return { ok: true };
}

// Who may be sent an uploaded photo. `row` is the member_stories row that holds the photo id in one
// of its copies; `listed` says whether that person is active and in the directory.
//   own       the author, for the draft, the submitted or the approved photo
//   approved  any signed-in member, for the APPROVED photo of someone who is listed
//   review    staff, for a photo in review or an approved one (decided by the caller's role)
export function photoAccess({ viewerPersonId, row, photoId, listed }) {
  if (!row || !isUploadedPhoto(photoId)) return null;
  const inCopy = (copy) => !!copy && copy.photo === photoId;
  if (row.person_id === viewerPersonId && (inCopy(row.draft) || inCopy(row.submitted) || inCopy(row.approved))) return 'own';
  if (inCopy(row.approved) && listed) return 'approved';
  return null;
}
