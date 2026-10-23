// Run with: node --test scripts/lib/staff-tour.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { TOUR_LATEST, TOUR_STEPS, fullTourFor, tourStepsFor } from './staff-tour.mjs';

test('steps are unique, ordered by since, and since starts at 1 with no gaps', () => {
  assert.equal(new Set(TOUR_STEPS.map((s) => s.id)).size, TOUR_STEPS.length);
  const sinces = TOUR_STEPS.map((s) => s.since);
  assert.deepEqual(sinces, [...sinces].sort((a, b) => a - b));
  for (let n = 1; n <= TOUR_LATEST; n++) assert.ok(sinces.includes(n), `no step has since ${n}`);
});

test('a brand new super admin gets every step', () => {
  assert.deepEqual(tourStepsFor({ isSuperAdmin: true, seenThrough: null }), TOUR_STEPS);
});

test('an existing admin gets only what was added after what they saw', () => {
  assert.deepEqual(tourStepsFor({ isSuperAdmin: true, seenThrough: TOUR_LATEST }), []);
  assert.ok(tourStepsFor({ isSuperAdmin: true, seenThrough: 0 }).length > 0);
  assert.ok(tourStepsFor({ isSuperAdmin: true, seenThrough: 1 }).every((s) => s.since > 1));
});

test('super-admin steps are never shown to other admins', () => {
  for (const isSuperAdmin of [false, undefined]) {
    assert.ok(tourStepsFor({ isSuperAdmin, seenThrough: null }).every((s) => s.audience === 'all'));
    assert.ok(fullTourFor(isSuperAdmin).every((s) => s.audience === 'all'));
  }
  assert.equal(fullTourFor(true).length, TOUR_STEPS.length);
  assert.ok(fullTourFor(false).length < TOUR_STEPS.length);
});

test('a failed or odd read of what was seen shows no tour at all', () => {
  for (const seenThrough of [undefined, NaN, '1', 1.5]) assert.deepEqual(tourStepsFor({ isSuperAdmin: true, seenThrough }), []);
});
