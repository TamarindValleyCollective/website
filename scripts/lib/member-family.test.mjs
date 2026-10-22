// Run with: node --test scripts/lib/member-family.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFamilyAdd, validateFamilyRemove, validateFamilyUpdate, familyAddOutcome, FAMILY_LOGIN_LIMIT, FAMILY_PENDING_LIMIT } from './member-family.mjs';

const good = (b) => {
  const r = validateFamilyAdd(b);
  assert.ok(r.ok, r.error);
  return r.edit;
};
const bad = (b) => {
  const r = validateFamilyAdd(b);
  assert.equal(r.ok, false);
  return r.error;
};

test('a name and a sign-in email are required; the email is lower-cased and the mobile normalised', () => {
  assert.deepEqual(good({ fullName: '  Ravi   Kumar ', email: ' Ravi@Example.com ' }), { fullName: 'Ravi Kumar', email: 'ravi@example.com', phone: null });
  assert.equal(good({ fullName: 'Ravi', email: 'r@x.in', phone: '98450 12345' }).phone, '+919845012345');
  assert.equal(good({ fullName: 'Ravi', email: 'r@x.in', phone: '' }).phone, null);
  assert.match(bad({ email: 'r@x.in' }), /name/);
  assert.match(bad({ fullName: 'Ravi' }), /email/);
  assert.match(bad({ fullName: 'Ravi', email: 'not-an-email' }), /email/);
  assert.match(bad({ fullName: 'Ravi', email: 'r@x.in', phone: '123' }), /mobile/);
});

test('nothing else can be smuggled in, such as a role or a household', () => {
  assert.match(bad({ fullName: 'Ravi', email: 'r@x.in', role: 'owner' }), /all we need/);
  assert.match(bad(null), /Nothing to do/);
  assert.match(bad([]), /Nothing to do/);
});

test('removal needs a person id', () => {
  assert.equal(validateFamilyRemove({ personId: '3f2b8c1e-5d4a-4e6b-9a7c-1b2d3e4f5a6b' }).ok, true);
  assert.equal(validateFamilyRemove({ personId: 'x' }).ok, false);
  assert.equal(validateFamilyRemove(null).ok, false);
});

test('a unit adds family straight away up to the limit, then asks the core team', () => {
  assert.equal(FAMILY_LOGIN_LIMIT, 2);
  assert.equal(familyAddOutcome({ familyLogins: 0, pendingRequests: 0 }), 'add');
  assert.equal(familyAddOutcome({ familyLogins: 1, pendingRequests: 0 }), 'add');
  assert.equal(familyAddOutcome({ familyLogins: 2, pendingRequests: 0 }), 'request');
  assert.equal(familyAddOutcome({ familyLogins: 2, pendingRequests: FAMILY_PENDING_LIMIT - 1 }), 'request');
  assert.equal(familyAddOutcome({ familyLogins: 2, pendingRequests: FAMILY_PENDING_LIMIT }), 'full');
});

test('an update changes only what is given; blanks keep what is on file', () => {
  const id = '3f2b8c1e-5d4a-4e6b-9a7c-1b2d3e4f5a6b';
  assert.deepEqual(validateFamilyUpdate({ personId: id, email: ' New@X.in ', phone: '', fullName: '' }), { ok: true, personId: id, edit: { email: 'new@x.in' } });
  assert.deepEqual(validateFamilyUpdate({ personId: id, phone: '98450 12345' }).edit, { phone: '+919845012345' });
  assert.equal(validateFamilyUpdate({ personId: id }).ok, false);
  assert.equal(validateFamilyUpdate({ personId: id, email: 'nope' }).ok, false);
  assert.equal(validateFamilyUpdate({ personId: id, phone: '1' }).ok, false);
  assert.equal(validateFamilyUpdate({ personId: id, role: 'owner', email: 'a@b.in' }).ok, false);
  assert.equal(validateFamilyUpdate({ personId: 'x', email: 'a@b.in' }).ok, false);
});
