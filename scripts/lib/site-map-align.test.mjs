// Run with: node --test scripts/lib/site-map-align.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { fitSimilarity, imageToPlan, planToImageMatrix, validateAlignment, relativePlacement, sheetsFromAlignments, shapeAlignment } from './site-map-align.mjs';

// A known similarity: scale 2, rotated 30 degrees clockwise, shifted by (100, -50).
const truth = (() => { const s = 2, th = (30 * Math.PI) / 180; return { a: s * Math.cos(th), b: s * Math.sin(th), tx: 100, ty: -50 }; })();
const image = [[10, 20], [400, 30], [250, 300], [60, 280]];
const pairsOf = (t, noise = []) => image.map((p, i) => ({ house: null, image: p, plan: imageToPlan(t, p).map((v, j) => v + (noise[i]?.[j] ?? 0)) }));

test('three or more exact pairs give back the scale, rotation and shift', () => {
  const f = fitSimilarity(pairsOf(truth));
  assert.ok(Math.abs(f.scale - 2) < 1e-9);
  assert.ok(Math.abs(f.rotation - 30) < 1e-9);
  assert.ok(Math.abs(f.tx - 100) < 1e-9 && Math.abs(f.ty + 50) < 1e-9);
  assert.ok(f.rms < 1e-9);
});

test('a pair that is off shows up as the biggest residual', () => {
  const f = fitSimilarity(pairsOf(truth, [null, null, null, [20, -20]]));
  assert.equal(f.residuals.indexOf(Math.max(...f.residuals)), 3);
  assert.ok(f.rms > 1);
});

test('the plan-to-image matrix draws a plan point where its image point is', () => {
  const m = planToImageMatrix(truth);
  const plan = imageToPlan(truth, [250, 300]);
  const x = m.a * plan[0] + m.c * plan[1] + m.e, y = m.b * plan[0] + m.d * plan[1] + m.f;
  assert.ok(Math.abs(x - 250) < 1e-6 && Math.abs(y - 300) < 1e-6);
});

test('one point, or points that are all the same, cannot be fitted', () => {
  assert.equal(fitSimilarity([{ image: [1, 1], plan: [2, 2] }]), null);
  assert.equal(fitSimilarity([{ image: [1, 1], plan: [2, 2] }, { image: [1, 1], plan: [5, 5] }]), null);
});

test('validateAlignment wants a cluster, three pairs and points, and makes the fit itself', () => {
  const ok = validateAlignment({ cluster: 'H1-B', pairs: pairsOf(truth).slice(0, 3).map((p, i) => ({ ...p, house: i ? 'H-4' + i : 'H-40' })) });
  assert.ok(!('error' in ok));
  assert.equal(ok.pairs[0].house, 'H-40');
  assert.ok(Math.abs(ok.fit.scale - 2) < 1e-3);
  for (const bad of [null, { cluster: 'H9', pairs: pairsOf(truth) }, { cluster: 'H2', pairs: pairsOf(truth).slice(0, 2) },
    { cluster: 'H2', pairs: [...pairsOf(truth).slice(0, 2), { image: [1, 2], plan: ['x', 3] }] },
    { cluster: 'H2', pairs: pairsOf(truth).map((p) => ({ ...p, image: [5, 5] })) },
    { cluster: 'H2', pairs: pairsOf({ a: 0.001, b: 0, tx: 0, ty: 0 }) }]) assert.ok('error' in validateAlignment(bad), JSON.stringify(bad)?.slice(0, 60));
});

test('relativePlacement moves a page into another page\'s coordinates', () => {
  // The same ground seen from two pages: page A as truth, page B scaled 0.5 and rotated 10 degrees more, shifted.
  const th = (40 * Math.PI) / 180;
  const B = { a: Math.cos(th), b: Math.sin(th), tx: 20, ty: 30 }; // scale 1, rotation 40
  const A = truth; // scale 2, rotation 30
  const place = relativePlacement(A, B);
  // A point on the image, as seen on page B, is moved by the placement to where page A sees it.
  const q = [123, 77];
  const onB = imageToPlan(B, q), onA = imageToPlan(A, q);
  const r = (place.rotate * Math.PI) / 180;
  const moved = [place.scale * (Math.cos(r) * onB[0] - Math.sin(r) * onB[1]) + place.dx, place.scale * (Math.sin(r) * onB[0] + Math.cos(r) * onB[1]) + place.dy];
  assert.ok(Math.abs(moved[0] - onA[0]) < 1e-6 && Math.abs(moved[1] - onA[1]) < 1e-6);
  assert.ok(Math.abs(place.scale - 2) < 1e-9 && Math.abs(place.rotate + 10) < 1e-9);
});

test('sheetsFromAlignments uses the satellite when every page of a sheet is aligned, and the defaults otherwise', () => {
  const defaults = { H1: [{ page: 'H1-A', scale: 1, dx: 0, dy: 0 }, { page: 'H1-B', scale: 0.9, dx: -5, dy: -6 }] };
  const al = (cluster, t) => shapeAlignment({ cluster, a: t.a, b: t.b, tx: t.tx, ty: t.ty, rms: 1, pairs: [] });
  assert.deepEqual(sheetsFromAlignments(defaults, [al('H1-A', truth)]), defaults);
  const out = sheetsFromAlignments(defaults, [al('H1-A', truth), al('H1-B', { a: 1, b: 0, tx: 0, ty: 0 })]);
  assert.deepEqual(out.H1[0], defaults.H1[0]);
  assert.equal(out.H1[1].page, 'H1-B');
  assert.ok(Math.abs(out.H1[1].scale - 2) < 1e-9);
});

test('validateSatellite accepts a real PNG or JPEG data URL and nothing else', async () => {
  const { validateSatellite } = await import('./site-map-align.mjs');
  const png = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString('base64');
  const jpg = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]).toString('base64');
  assert.ok(!('error' in validateSatellite(png)));
  assert.ok(!('error' in validateSatellite(jpg)));
  assert.ok('error' in validateSatellite(png.replace('image/png', 'image/jpeg'))); // says JPEG, is a PNG
  assert.ok('error' in validateSatellite('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='));
  assert.ok('error' in validateSatellite('data:text/html;base64,PGI+'));
  assert.ok('error' in validateSatellite(null));
  assert.ok('error' in validateSatellite('data:image/png;base64,' + 'A'.repeat(6_000_001)));
});
