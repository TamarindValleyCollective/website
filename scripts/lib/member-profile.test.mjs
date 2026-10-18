// Run with: node --test scripts/lib/member-profile.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProfileEdit, profileAuditDetail } from './member-profile.mjs';

const good = (b) => {
  const r = validateProfileEdit(b);
  assert.ok(r.ok, r.error);
  return r.edit;
};
const bad = (b) => {
  const r = validateProfileEdit(b);
  assert.equal(r.ok, false);
  return r.error;
};

test('a mobile number is normalised to +91 form; null or empty removes it', () => {
  assert.deepEqual(good({ phone: '98450 12345' }), { phone: '+919845012345' });
  assert.deepEqual(good({ phone: null }), { phone: null });
  assert.deepEqual(good({ phone: '   ' }), { phone: null });
  assert.match(bad({ phone: '12345' }), /valid mobile number/);
  assert.match(bad({ phone: 12345 }), /must be text/);
});

test('the directory listing takes only true or false', () => {
  assert.deepEqual(good({ directoryVisible: false }), { directoryVisible: false });
  assert.deepEqual(good({ directoryVisible: true, phone: null }), { directoryVisible: true, phone: null });
  assert.match(bad({ directoryVisible: 'no' }), /on or off/);
});

test('anything else is refused, including email, name and ids', () => {
  for (const body of [{ email: 'x@example.com' }, { fullName: 'New Name' }, { personId: 'abc' }, { phone: '9845012345', role: 'owner' }]) {
    assert.match(bad(body), /core team/);
  }
});

test('an empty or malformed request does nothing', () => {
  assert.match(bad({}), /Nothing to change/);
  assert.match(bad(null), /Nothing to do/);
  assert.match(bad('phone'), /Nothing to do/);
  assert.match(bad([]), /Nothing to do/);
});

test('the audit detail names the fields but never the phone number', () => {
  const d = profileAuditDetail(good({ phone: '9845012345', directoryVisible: false }));
  assert.deepEqual(d.fields.sort(), ['directoryVisible', 'phone']);
  assert.equal(d.directoryVisible, false);
  assert.ok(!JSON.stringify(d).includes('9845'));
});
