// Run with: node --test scripts/lib/member-privacy.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { PRIVACY_NOTICE_VERSION, SECTIONS, privacyNoticeRequired, validateAcceptance } from './member-privacy.mjs';

test('a notice is required until the current version is on record', () => {
  assert.equal(privacyNoticeRequired(null), true);
  assert.equal(privacyNoticeRequired(undefined), true);
  assert.equal(privacyNoticeRequired(PRIVACY_NOTICE_VERSION - 1), true);
  assert.equal(privacyNoticeRequired(PRIVACY_NOTICE_VERSION), false);
  assert.equal(privacyNoticeRequired(PRIVACY_NOTICE_VERSION + 1), false);
  assert.equal(privacyNoticeRequired('1'), true); // only a real integer counts
});

test('only the version that was shown can be acknowledged', () => {
  assert.deepEqual(validateAcceptance({ version: PRIVACY_NOTICE_VERSION }), { ok: true, version: PRIVACY_NOTICE_VERSION });
  for (const body of [{ version: PRIVACY_NOTICE_VERSION - 1 }, { version: String(PRIVACY_NOTICE_VERSION) }, {}, null, [], 'x']) {
    assert.equal(validateAcceptance(body).ok, false);
  }
});

test('every section has a heading and text', () => {
  assert.ok(SECTIONS.length > 0);
  for (const s of SECTIONS) {
    assert.ok(s.heading && s.body);
  }
});
