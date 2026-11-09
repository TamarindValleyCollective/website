// Run with: node --test scripts/lib/site-map-align.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { fitSimilarity, geoToLocal, localToGeo, imageToPlan, planToLocal, validateAlignment, originOf, withOrigin, relativePlacement, sheetsFromAlignments, shapeAlignment } from './site-map-align.mjs';

const ORIGIN = { lat: 29.7, lng: 79.6 };
// A known similarity from local metres to the plan page: 2 plan units per metre, rotated 30 degrees clockwise, shifted.
const truth = (() => { const s = 2, th = (30 * Math.PI) / 180; return { a: s * Math.cos(th), b: s * Math.sin(th), tx: 100, ty: -50 }; })();
const local = [[10, 20], [400, 30], [250, 300], [60, 280]];
const pairsFor = (t, origin = ORIGIN, noise = []) => local.map((p, i) => ({ house: null, geo: localToGeo(origin, p), plan: imageToPlan(t, p).map((v, j) => v + (noise[i]?.[j] ?? 0)) }));

test('latitude and longitude become metres east and south of the origin, and back', () => {
  const [x, y] = geoToLocal(ORIGIN, [ORIGIN.lat - 0.0001, ORIGIN.lng + 0.0001]);
  assert.ok(Math.abs(y - 11.054) < 0.01); // 0.0001 degree of latitude south is about 11 m, y points south
  assert.ok(Math.abs(x - 11.132 * Math.cos((ORIGIN.lat * Math.PI) / 180)) < 0.01);
  const back = localToGeo(ORIGIN, geoToLocal(ORIGIN, [29.7123, 79.6321]));
  assert.ok(Math.abs(back[0] - 29.7123) < 1e-9 && Math.abs(back[1] - 79.6321) < 1e-9);
});

test('exact pairs give back the scale, rotation and shift', () => {
  const f = fitSimilarity(pairsFor(truth).map((p) => ({ plan: p.plan, image: geoToLocal(ORIGIN, p.geo) })));
  assert.ok(Math.abs(f.scale - 2) < 1e-6 && Math.abs(f.rotation - 30) < 1e-6);
  assert.ok(Math.abs(f.tx - 100) < 1e-4 && Math.abs(f.ty + 50) < 1e-4);
  assert.ok(f.rms < 1e-4);
});

test('a pair that is off shows up as the biggest residual', () => {
  const f = fitSimilarity(pairsFor(truth, ORIGIN, [null, null, null, [20, -20]]).map((p) => ({ plan: p.plan, image: geoToLocal(ORIGIN, p.geo) })));
  assert.equal(f.residuals.indexOf(Math.max(...f.residuals)), 3);
});

test('planToLocal is the inverse of the fit', () => {
  const plan = imageToPlan(truth, [250, 300]);
  const [x, y] = planToLocal(truth, plan);
  assert.ok(Math.abs(x - 250) < 1e-9 && Math.abs(y - 300) < 1e-9);
});

test('one point, or points that are all the same, cannot be fitted', () => {
  assert.equal(fitSimilarity([{ image: [1, 1], plan: [2, 2] }]), null);
  assert.equal(fitSimilarity([{ image: [1, 1], plan: [2, 2] }, { image: [1, 1], plan: [5, 5] }]), null);
});

test('validateAlignment wants a cluster, three pairs and real positions, and makes the fit itself', () => {
  const ok = validateAlignment({ cluster: 'H1-B', pairs: pairsFor(truth).slice(0, 3).map((p, i) => ({ ...p, house: i ? 'H-4' + i : 'H-40' })) }, ORIGIN);
  assert.ok(!('error' in ok));
  assert.equal(ok.pairs[0].house, 'H-40');
  assert.deepEqual(ok.origin, ORIGIN);
  assert.ok(Math.abs(ok.fit.scale - 2) < 1e-3);
  // With no origin given, the pairs' average is used, and the fit is the same ground.
  const free = validateAlignment({ cluster: 'H1-B', pairs: pairsFor(truth) });
  assert.deepEqual(free.origin, originOf(free.pairs));
  assert.ok(Math.abs(free.fit.scale - 2) < 1e-3 && Math.abs(free.fit.rotation - 30) < 1e-3);
  for (const bad of [null, { cluster: 'H9', pairs: pairsFor(truth) }, { cluster: 'H2', pairs: pairsFor(truth).slice(0, 2) },
    { cluster: 'H2', pairs: [...pairsFor(truth).slice(0, 2), { geo: [95, 10], plan: [1, 2] }] },
    { cluster: 'H2', pairs: [...pairsFor(truth).slice(0, 2), { geo: ['x', 10], plan: [1, 2] }] },
    { cluster: 'H2', pairs: pairsFor(truth).map((p) => ({ ...p, geo: [29.7, 79.6] })) }]) assert.ok('error' in validateAlignment(bad, ORIGIN), JSON.stringify(bad)?.slice(0, 60));
});

test('the same fit around another origin places every ground point where it was', () => {
  const al = shapeAlignment({ cluster: 'H1-A', a: truth.a, b: truth.b, tx: truth.tx, ty: truth.ty, origin_lat: ORIGIN.lat, origin_lng: ORIGIN.lng, pairs: [] });
  const other = { lat: ORIGIN.lat + 0.0004, lng: ORIGIN.lng - 0.0006 };
  const moved = withOrigin(al, other);
  const ground = [29.7013, 79.6021];
  const before = imageToPlan(al, geoToLocal(ORIGIN, ground)), after = imageToPlan(moved, geoToLocal(other, ground));
  // (the metres per degree of longitude follow the origin's latitude, so equal to a few thousandths of a plan unit)
  assert.ok(Math.abs(before[0] - after[0]) < 5e-3 && Math.abs(before[1] - after[1]) < 5e-3);
});

test('relativePlacement moves a page into another page\'s coordinates', () => {
  const th = (40 * Math.PI) / 180;
  const B = { a: Math.cos(th), b: Math.sin(th), tx: 20, ty: 30 }; // 1 plan unit per metre, rotation 40
  const A = truth; // 2 plan units per metre, rotation 30
  const place = relativePlacement(A, B);
  const q = [123, 77];
  const onB = imageToPlan(B, q), onA = imageToPlan(A, q);
  const r = (place.rotate * Math.PI) / 180;
  const moved = [place.scale * (Math.cos(r) * onB[0] - Math.sin(r) * onB[1]) + place.dx, place.scale * (Math.sin(r) * onB[0] + Math.cos(r) * onB[1]) + place.dy];
  assert.ok(Math.abs(moved[0] - onA[0]) < 1e-6 && Math.abs(moved[1] - onA[1]) < 1e-6);
  assert.ok(Math.abs(place.scale - 2) < 1e-9 && Math.abs(place.rotate + 10) < 1e-9);
});

test('sheetsFromAlignments uses the map when every page of a sheet is aligned, and the defaults otherwise', () => {
  const defaults = { H1: [{ page: 'H1-A', scale: 1, dx: 0, dy: 0 }, { page: 'H1-B', scale: 0.9, dx: -5, dy: -6 }] };
  const al = (cluster, t, origin) => shapeAlignment({ cluster, a: t.a, b: t.b, tx: t.tx, ty: t.ty, origin_lat: origin.lat, origin_lng: origin.lng, rms: 1, pairs: [] });
  assert.deepEqual(sheetsFromAlignments(defaults, [al('H1-A', truth, ORIGIN)]), defaults);
  // The two pages were saved around different origins: the result must not depend on that.
  const B = { a: 1, b: 0, tx: 0, ty: 0 };
  const same = sheetsFromAlignments(defaults, [al('H1-A', truth, ORIGIN), al('H1-B', B, ORIGIN)]);
  const shifted = withOrigin(al('H1-B', B, ORIGIN), { lat: ORIGIN.lat + 0.0002, lng: ORIGIN.lng + 0.0003 });
  const other = sheetsFromAlignments(defaults, [al('H1-A', truth, ORIGIN), { ...shifted, cluster: 'H1-B' }]);
  assert.deepEqual(same.H1[0], defaults.H1[0]);
  assert.ok(Math.abs(same.H1[1].scale - 2) < 1e-9);
  for (const k of ['scale', 'rotate', 'dx', 'dy']) assert.ok(Math.abs(same.H1[1][k] - other.H1[1][k]) < 5e-3, k);
});
