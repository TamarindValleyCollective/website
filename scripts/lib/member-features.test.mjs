// Run with: node --test scripts/lib/member-features.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { FEATURES, featureOn, featureIds, validateAccess } from './member-features.mjs';

test('a feature is on for everyone only when its flag is exactly "true"; otherwise only for a listed household', () => {
  assert.equal(featureOn('true', false), true);
  assert.equal(featureOn('false', false), false);
  assert.equal(featureOn(undefined, false), false);
  assert.equal(featureOn('TRUE', false), false);
  assert.equal(featureOn('false', true), true);
  assert.equal(featureOn(undefined, true), true);
});

const ID = '3f2b6c1e-8a44-4d2e-9d57-0a1b2c3d4e5f';

test('adding or removing a household: chosen from the member list, a known feature, and an explicit on or off', () => {
  assert.deepEqual(validateAccess({ householdId: ID, feature: 'rental', enabled: true }).access, { householdId: ID, feature: 'rental', enabled: true });
  assert.equal(validateAccess({ householdId: ID, feature: 'rental', enabled: false }).access.enabled, false);
  assert.match(validateAccess({ householdId: 'F-12', feature: 'rental', enabled: true }).error, /member from the list/);
  assert.match(validateAccess({ feature: 'rental', enabled: true }).error, /member from the list/);
  assert.match(validateAccess({ householdId: ID, feature: 'chat', enabled: true }).error, /feature/);
  assert.match(validateAccess({ householdId: ID, feature: 'rental' }).error, /on or off/);
  assert.match(validateAccess(null).error, /member from the list/);
});

test('every feature names its flag', () => {
  assert.deepEqual(featureIds(), ['rental']);
  assert.equal(FEATURES.rental.env, 'MEMBER_RENTAL_ENABLED');
});
