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

test('adding or removing a household: farm unit, a known feature, and an explicit on or off', () => {
  assert.deepEqual(validateAccess({ farmUnit: ' f-12 ', feature: 'rental', enabled: true }).access, { farmUnit: 'F-12', feature: 'rental', enabled: true });
  assert.equal(validateAccess({ farmUnit: 'f12', feature: 'rental', enabled: false }).access.farmUnit, 'F-12');
  assert.match(validateAccess({ farmUnit: 'tent 3', feature: 'rental', enabled: true }).error, /farm unit/);
  assert.match(validateAccess({ farmUnit: 'F-12', feature: 'chat', enabled: true }).error, /feature/);
  assert.match(validateAccess({ farmUnit: 'F-12', feature: 'rental' }).error, /on or off/);
  assert.match(validateAccess(null).error, /farm unit/);
});

test('every feature names its flag', () => {
  assert.deepEqual(featureIds(), ['rental']);
  assert.equal(FEATURES.rental.env, 'MEMBER_RENTAL_ENABLED');
});
