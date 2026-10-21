// Run with: node --test scripts/lib/member-photo.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SQUARE_BYTES, isLegacyPhoto, isPhotoRef, isUploadedPhoto, jpegInfo, photoKeys, stripJpegMetadata, validatePhotoPair } from './member-photo.mjs';

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

// A JPEG with the segments a camera, a browser or an editor puts around the picture. `segment` builds one marker segment.
const segment = (marker, payload) => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 255, ...payload];
const ascii = (t) => [...t].map((c) => c.charCodeAt(0));
function richJpeg({ width = 400, height = 400, trailing = [] } = {}) {
  const parts = [
    [0xff, 0xd8],
    segment(0xe0, [...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]), // JFIF: kept
    segment(0xe1, [...ascii('Exif'), 0, 0, ...ascii('GPSLatitude=12.97;Make=Acme Phone')]), // EXIF with a position: removed
    segment(0xe1, [...ascii('http://ns.adobe.com/xap/1.0/'), 0, ...ascii('<x:xmpmeta>owner</x:xmpmeta>')]), // XMP: removed
    segment(0xe2, [...ascii('ICC_PROFILE'), 0, 1, 1, ...ascii('colour')]), // colour profile: kept
    segment(0xe2, [...ascii('MPF'), 0, ...ascii('second image offsets')]), // multi-picture offsets: removed
    segment(0xed, [...ascii('Photoshop 3.0'), 0, ...ascii('caption')]), // IPTC: removed
    segment(0xfe, ascii('a comment with a name')), // comment: removed
    segment(0xc0, [8, height >> 8, height & 255, width >> 8, width & 255, 1, 1, 0x11, 0]),
    segment(0xdb, [0, ...new Array(64).fill(8)]), // a quantisation table: kept
    [0xff, 0xda, 0x00, 0x02, 0x12, 0x34, 0xff, 0x00, 0x56], // the pixel data, with a stuffed 0xff
    [0xff, 0xd9],
    trailing,
  ];
  return Uint8Array.from(parts.flat());
}
const has = (bytes, text) => Buffer.from(bytes).includes(Buffer.from(text));

test('metadata is removed, the picture and its colour profile are kept', () => {
  const clean = stripJpegMetadata(richJpeg());
  for (const gone of ['GPSLatitude', 'Acme Phone', 'xmpmeta', 'second image', 'Photoshop', 'a comment with a name']) assert.equal(has(clean, gone), false, gone);
  for (const kept of ['JFIF', 'ICC_PROFILE']) assert.equal(has(clean, kept), true, kept);
  assert.deepEqual(jpegInfo(clean), { ok: true, width: 400, height: 400, hasExif: false }); // still a valid JPEG, same size
});

test('the pixel data is copied exactly and anything after the end of the image is dropped', () => {
  const trailing = [...ascii('MPF-extra-image-or-metadata')];
  const clean = stripJpegMetadata(richJpeg({ trailing }));
  assert.equal(has(clean, 'extra-image'), false);
  assert.deepEqual([...clean.slice(-7)], [0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd9]); // the scan data intact (its stuffed 0xff too), then the end of the image
  // a JPEG with nothing to remove is returned unchanged
  const plain = jpeg(400, 400);
  assert.deepEqual([...stripJpegMetadata(plain)], [...plain]);
});

test('a pair carrying EXIF (as Safari\'s canvas writes it) is accepted, and what is kept has none', () => {
  const r = validatePhotoPair(jpeg(400, 400, { exif: true }), richJpeg({ width: 1600, height: 1067 }));
  assert.equal(r.ok, true);
  assert.equal(jpegInfo(r.square).hasExif, false);
  assert.equal(jpegInfo(r.full).hasExif, false);
  assert.equal(has(r.full, 'GPSLatitude'), false);
  assert.equal(has(r.square, 'Exif'), false);
});

test('a damaged file is still refused, and what is stored is the cleaned bytes', () => {
  assert.match(validatePhotoPair(Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x20, 0x45]), jpeg(1600, 1067)).error, /damaged/);
  const ok = validatePhotoPair(jpeg(400, 400), jpeg(1600, 1067));
  assert.ok(ok.square instanceof Uint8Array && ok.full instanceof Uint8Array);
});
