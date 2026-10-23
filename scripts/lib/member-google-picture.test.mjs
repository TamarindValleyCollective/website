import test from 'node:test';
import assert from 'node:assert/strict';
import { pictureChange, pictureUpdate, safeGooglePicture, sizedPicture } from './member-google-picture.mjs';

const PIC = 'https://lh3.googleusercontent.com/a/AbCdEf123=s96-c';

test('only an https picture from Google\'s image hosts is accepted', () => {
  assert.equal(safeGooglePicture(PIC), PIC);
  assert.equal(safeGooglePicture('https://lh3.ggpht.com/abc'), 'https://lh3.ggpht.com/abc');
  for (const bad of ['http://lh3.googleusercontent.com/a', 'https://evil.example/a.jpg', 'https://googleusercontent.com.evil.example/a', 'https://user:pw@lh3.googleusercontent.com/a', 'javascript:alert(1)', '', null, undefined, 42, `https://lh3.googleusercontent.com/${'a'.repeat(600)}`]) {
    assert.equal(safeGooglePicture(bad), null, String(bad));
  }
});

test('a picture can be asked for at another size', () => {
  assert.equal(sizedPicture(PIC, 128), 'https://lh3.googleusercontent.com/a/AbCdEf123=s128-c');
  assert.equal(sizedPicture('https://lh3.googleusercontent.com/a/XyZ', 64), 'https://lh3.googleusercontent.com/a/XyZ=s64-c');
  assert.equal(sizedPicture('https://evil.example/x', 64), null);
});

test('nothing is kept until the member has accepted the notice that covers it', () => {
  assert.deepEqual(pictureUpdate({ stored: null, seen: PIC, acceptedVersion: 6, requiredVersion: 7 }), { write: false });
  assert.deepEqual(pictureUpdate({ stored: null, seen: PIC, acceptedVersion: null, requiredVersion: 7 }), { write: false });
  assert.deepEqual(pictureUpdate({ stored: null, seen: PIC, acceptedVersion: 7, requiredVersion: 7 }), { write: true, value: PIC });
});

test('it is refreshed when it changes, cleared when Google no longer has one, and left alone when the same', () => {
  const NEW = 'https://lh3.googleusercontent.com/a/Other=s96-c';
  assert.deepEqual(pictureUpdate({ stored: PIC, seen: NEW, acceptedVersion: 7, requiredVersion: 7 }), { write: true, value: NEW });
  assert.deepEqual(pictureUpdate({ stored: PIC, seen: undefined, acceptedVersion: 7, requiredVersion: 7 }), { write: true, value: null });
  assert.deepEqual(pictureUpdate({ stored: PIC, seen: PIC, acceptedVersion: 7, requiredVersion: 7 }), { write: false });
  assert.deepEqual(pictureUpdate({ stored: null, seen: 'https://evil.example/x', acceptedVersion: 7, requiredVersion: 7 }), { write: false });
});

test('an admin picture is written when it changes, cleared when gone, and left alone when the same', () => {
  const NEW = 'https://lh3.googleusercontent.com/a/Other=s96-c';
  assert.deepEqual(pictureChange({ stored: null, seen: PIC }), { write: true, value: PIC });
  assert.deepEqual(pictureChange({ stored: PIC, seen: NEW }), { write: true, value: NEW });
  assert.deepEqual(pictureChange({ stored: PIC, seen: undefined }), { write: true, value: null });
  assert.deepEqual(pictureChange({ stored: PIC, seen: PIC }), { write: false });
  assert.deepEqual(pictureChange({ stored: null, seen: 'https://evil.example/x' }), { write: false });
  assert.deepEqual(pictureChange({ stored: null, seen: null }), { write: false });
});
