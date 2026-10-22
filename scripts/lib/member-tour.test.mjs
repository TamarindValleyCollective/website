// Run with: node --test scripts/lib/member-tour.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { TOUR_LATEST, TOUR_STEPS, fullTourFor, tourStepsFor, validateTourSeen } from './member-tour.mjs';

test('steps are unique, ordered by since, and since starts at 1 with no gaps', () => {
  assert.equal(new Set(TOUR_STEPS.map((s) => s.id)).size, TOUR_STEPS.length);
  const sinces = TOUR_STEPS.map((s) => s.since);
  assert.deepEqual(sinces, [...sinces].sort((a, b) => a - b));
  for (let n = 1; n <= TOUR_LATEST; n++) assert.ok(sinces.includes(n), `no step has since ${n}`);
});

test('a brand new owner gets every step', () => {
  assert.deepEqual(tourStepsFor({ role: 'owner', seenThrough: null }), TOUR_STEPS);
});

test('an existing member gets only what was added after what they saw', () => {
  const steps = tourStepsFor({ role: 'owner', seenThrough: 1 });
  assert.ok(steps.length > 0);
  assert.ok(steps.every((s) => s.since > 1));
  assert.deepEqual(tourStepsFor({ role: 'owner', seenThrough: TOUR_LATEST }), []);
});

test('owner-only steps are never shown to family members or non-owners', () => {
  for (const role of ['family', 'non_owner']) {
    assert.ok(tourStepsFor({ role, seenThrough: null }).every((s) => s.audience === 'all'));
    assert.ok(fullTourFor(role).every((s) => s.audience === 'all'));
  }
  assert.equal(fullTourFor('owner').length, TOUR_STEPS.length);
});

test('an unreadable value means no tour, not the whole tour', () => {
  for (const seenThrough of [undefined, 'x', 1.5, NaN]) assert.deepEqual(tourStepsFor({ role: 'owner', seenThrough }), []);
});

test('recording what was seen never goes down or past the newest step', () => {
  assert.deepEqual(validateTourSeen({ through: TOUR_LATEST }, null), { ok: true, through: TOUR_LATEST });
  assert.deepEqual(validateTourSeen({ through: 1 }, TOUR_LATEST), { ok: true, through: TOUR_LATEST });
  for (const body of [{ through: TOUR_LATEST + 1 }, { through: 0 }, { through: '2' }, { through: 1.5 }, {}, null, [], 'x']) {
    assert.equal(validateTourSeen(body, null).ok, false);
  }
});
