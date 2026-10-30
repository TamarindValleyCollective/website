// Run with: node --test scripts/lib/site-map-snap.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { edgesOf, footprintPoints, segmentsOfPath, snapPosition, snapRotation } from './site-map-snap.mjs';

const home = (x, y, extra = {}) => ({ shape: 'S', x, y, rotation: 0, mirrorX: false, mirrorY: false, ...extra });

test('footprint: placed at its centre, scaled, and turned', () => {
  const pts = footprintPoints(home(100, 200), 2);
  assert.deepEqual(pts[0], [100 - 34, 200 + (-18 - 0.5) * 2]);
  const turned = footprintPoints(home(0, 0, { rotation: 90 }), 1);
  assert.ok(Math.abs(turned[0][0] - 18.5) < 1e-9 && Math.abs(turned[0][1] + 17) < 1e-9);
});

test('snap: a wall close to a neighbour\'s parallel wall is pulled onto it', () => {
  const target = edgesOf(footprintPoints(home(36, 0), 1)); // its left wall is at x 19
  const { dx, dy, guides } = snapPosition(footprintPoints(home(1.5, 0), 1), target, 3); // right wall at 18.5
  assert.ok(Math.abs(dx - 0.5) < 1e-9, `dx ${dx}`);
  assert.ok(Math.abs(dy) < 1e-9);
  assert.ok(guides.length >= 1);
});

test('snap: a wall further than the threshold is left alone', () => {
  const target = edgesOf(footprintPoints(home(36, 0), 1));
  const far = footprintPoints(home(-20, 0), 1);
  assert.deepEqual(snapPosition(far, target, 3), { dx: 0, dy: 0, guides: [] });
});

test('snap: a wall at another angle is not a candidate', () => {
  const target = edgesOf(footprintPoints(home(36, 0, { rotation: 30 }), 1));
  assert.deepEqual(snapPosition(footprintPoints(home(10, 0), 1), target, 2), { dx: 0, dy: 0, guides: [] });
});

test('snap: plot lines are targets too, and two directions can settle a corner', () => {
  const lines = segmentsOfPath('M20 -100 L20 100 M-100 25 L100 25');
  const { dx, dy } = snapPosition(footprintPoints(home(1, 5.5), 1), lines, 4);
  assert.ok(Math.abs(dx - 2) < 1e-9, `dx ${dx}`); // right wall 18 -> 20
  assert.ok(Math.abs(dy - 1) < 1e-9, `dy ${dy}`); // bottom wall 24 -> 25
});

test('path segments: open lines and closed outlines', () => {
  assert.equal(segmentsOfPath('M0 0 L10 0 L10 10').length, 2);
  assert.equal(segmentsOfPath('M0 0 L10 0 L10 10 Z').length, 3);
  assert.deepEqual(segmentsOfPath(''), []);
});

test('rotation: snaps to a neighbour within the tolerance, including the opposite way round', () => {
  assert.equal(snapRotation(113, [114, 20]), 114);
  assert.equal(snapRotation(-65, [114]), -66);
  assert.equal(snapRotation(120, [114]), null);
  assert.equal(snapRotation(114, [114]), null); // already equal: nothing to do
});
