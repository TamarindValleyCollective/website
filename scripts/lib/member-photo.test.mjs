// Run with: node --test scripts/lib/member-photo.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SQUARE_BYTES, isLegacyPhoto, isPhotoRef, isUploadedPhoto, jpegInfo, photoAccess, photoKeys, validatePhotoPair } from './member-photo.mjs';

// A minimal JPEG: SOI, optional EXIF, a frame header with the given size, then the end.
function jpeg(width, height, { exif = false, padTo = 0 } = {}) {
  const parts = [[0xff, 0xd8]];
  if (exif) parts.push([0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00]);
  parts.push([0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x01, 0x01, 0x11, 0x00]);
  parts.push([0xff, 0xda, 0x00, 0x02]);
  parts.push([0xff, 0xd9]);
  let bytes = Uint8Array.from(parts.flat());
  if (padTo > bytes.length) { const p = new Uint8Array(padTo); p.set(bytes); bytes = p; }
  return bytes;
}

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

test('a JPEG’s size and EXIF block are read without decoding it', () => {
  assert.deepEqual(jpegInfo(jpeg(400, 400)), { ok: true, width: 400, height: 400, hasExif: false });
  assert.deepEqual(jpegInfo(jpeg(1600, 1067, { exif: true })), { ok: true, width: 1600, height: 1067, hasExif: true });
});

test('anything that is not a whole JPEG is refused', () => {
  assert.equal(jpegInfo(Uint8Array.from([0x89, 0x50, 0x4e, 0x47])).ok, false); // a PNG
  assert.equal(jpegInfo(new Uint8Array(0)).ok, false);
  assert.equal(jpegInfo(Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08])).ok, false); // truncated
  assert.equal(jpegInfo(jpeg(0, 0)).ok, false);
});

test('a prepared pair is accepted; a wrong one is refused with a reason', () => {
  assert.equal(validatePhotoPair(jpeg(400, 400), jpeg(1600, 1067)).ok, true);
  assert.match(validatePhotoPair(jpeg(400, 300), jpeg(1600, 1067)).error, /not prepared correctly/); // not square
  assert.match(validatePhotoPair(jpeg(400, 400), jpeg(4000, 3000)).error, /not prepared correctly/); // too big
  assert.match(validatePhotoPair(jpeg(100, 100), jpeg(1600, 1067)).error, /not prepared correctly/); // too small
  assert.match(validatePhotoPair(jpeg(400, 400, { exif: true }), jpeg(1600, 1067)).error, /camera or location/);
  assert.match(validatePhotoPair(jpeg(400, 400, { padTo: MAX_SQUARE_BYTES + 1 }), jpeg(1600, 1067)).error, /too large/);
  assert.match(validatePhotoPair(Uint8Array.from([1, 2, 3, 4]), jpeg(1600, 1067)).error, /not a JPEG/);
  assert.match(validatePhotoPair(null, jpeg(1600, 1067)).error, /Choose a photo/);
});

test('a photo is a uuid or a path on the public site, nothing else', () => {
  assert.ok(isUploadedPhoto(A) && isPhotoRef(A));
  assert.ok(isLegacyPhoto('/images/members/abhinav-and-divya.jpg') && isPhotoRef('/images/members/x-y.webp'));
  for (const bad of ['', null, 'https://evil.test/x.jpg', '/images/members/../brand/x.jpg', '/images/members/a b.jpg', '/other/x.jpg', 'not-a-uuid']) {
    assert.equal(isPhotoRef(bad), false, String(bad));
  }
});

test('storage keys are built from two uuids only, so they cannot address another path', () => {
  assert.deepEqual(photoKeys(A, B), { square: `member-photos/${A}/${B}.jpg`, full: `member-photos/${A}/${B}-full.jpg` });
  assert.throws(() => photoKeys('../x', B), /Invalid photo key/);
  assert.throws(() => photoKeys(A, `${B}/../..`), /Invalid photo key/);
});

test('who may fetch an uploaded photo: the author for any copy, others only for an approved photo of a listed person', () => {
  const row = { person_id: A, draft: { photo: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }, submitted: { photo: 'ssssssss-0000-4000-8000-000000000000'.replace(/s/g, 'a') }, approved: { photo: B } };
  const draftId = row.draft.photo;
  assert.equal(photoAccess({ viewerPersonId: A, row, photoId: draftId, listed: true }), 'own'); // their own draft
  assert.equal(photoAccess({ viewerPersonId: 'someone-else', row, photoId: draftId, listed: true }), null); // never another's draft
  assert.equal(photoAccess({ viewerPersonId: 'someone-else', row, photoId: row.submitted.photo, listed: true }), null); // nor one in review
  assert.equal(photoAccess({ viewerPersonId: 'someone-else', row, photoId: B, listed: true }), 'approved');
  assert.equal(photoAccess({ viewerPersonId: 'someone-else', row, photoId: B, listed: false }), null); // opted out of the directory
  assert.equal(photoAccess({ viewerPersonId: A, row, photoId: B, listed: false }), 'own'); // the author still sees their own
  assert.equal(photoAccess({ viewerPersonId: A, row: null, photoId: B, listed: true }), null);
  assert.equal(photoAccess({ viewerPersonId: A, row, photoId: '/images/members/x.jpg', listed: true }), null); // public paths are not served here
});
