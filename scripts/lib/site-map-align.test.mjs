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

test('fine-tune moves the plan on the ground by what was asked, about the pairs\' middle', async () => {
  const { applyTune, tuneBetween, pivotOf, isTuned, NO_TUNE, planToLocal } = await import('./site-map-align.mjs');
  const base = { ...truth };
  const pivot = [200, 150];
  // No adjustment changes nothing.
  const same = applyTune(base, NO_TUNE, pivot);
  assert.ok(Math.abs(same.a - base.a) < 1e-12 && Math.abs(same.tx - base.tx) < 1e-9);
  // 10 m east, 4 m north: every plan point lands 10 m east and 4 m north of where it was (local y points south).
  const moved = applyTune(base, { east: 10, north: 4, rotate: 0, scale: 1 }, pivot);
  const plan = [321, -77];
  const before = planToLocal(base, plan), after = planToLocal(moved, plan);
  assert.ok(Math.abs(after[0] - before[0] - 10) < 1e-9 && Math.abs(after[1] - before[1] + 4) < 1e-9);
  // A turn leaves the pivot where it is, and turns every other point clockwise about it.
  const turnPlan = imageToPlan(base, pivot);
  const turned = applyTune(base, { east: 0, north: 0, rotate: 10, scale: 1 }, pivot);
  const pivotAfter = planToLocal(turned, turnPlan);
  assert.ok(Math.abs(pivotAfter[0] - pivot[0]) < 1e-9 && Math.abs(pivotAfter[1] - pivot[1]) < 1e-9);
  assert.ok(Math.abs(turned.a === undefined ? 1 : Math.atan2(turned.b, turned.a) * 180 / Math.PI - (30 - 10)) < 1e-9); // the plan turns clockwise, the fit's angle falls
  // Resizing 5% about the pivot, then asking what the adjustment was, gives the same adjustment back.
  const tune = { east: 3.5, north: -2, rotate: 1.25, scale: 1.05 };
  const back = tuneBetween(base, applyTune(base, tune, pivot), pivot);
  for (const k of Object.keys(tune)) assert.ok(Math.abs(back[k] - tune[k]) < 1e-9, k);
  assert.ok(!isTuned(NO_TUNE) && isTuned(tune));
  assert.deepEqual(tuneBetween(base, base, pivot), { ...NO_TUNE });
  assert.ok(Array.isArray(pivotOf([{ geo: [29.7, 79.6] }, { geo: [29.7002, 79.6002] }], ORIGIN)));
});

test('validateAlignment applies a fine-tune, rejects an absurd one, and keeps the pairs\' distances from the tuned fit', () => {
  const body = (tune) => ({ cluster: 'H1-B', pairs: pairsFor(truth), tune });
  const plain = validateAlignment(body(undefined), ORIGIN);
  const tuned = validateAlignment(body({ east: 5, north: 0, rotate: 0, scale: 1 }), ORIGIN);
  assert.ok(!('error' in tuned));
  assert.deepEqual(tuned.tune, { east: 5, north: 0, rotate: 0, scale: 1 });
  assert.ok(plain.fit.rms < 0.05); // coordinates are kept to 7 decimals (about a centimetre)
  // Moving the plan 5 m puts every pair 5 m (10 plan units at 2 per metre) from the fit.
  assert.ok(Math.abs(tuned.fit.rms - 10) < 0.05, String(tuned.fit.rms));
  for (const bad of [{ east: 400 }, { rotate: 40 }, { scale: 2 }, { scale: 0.5 }, { east: 'x' }, 7]) assert.ok('error' in validateAlignment(body(bad), ORIGIN), JSON.stringify(bad));
});

test('a locked size fits only the turn and position, so two pairs are enough and the size stays', () => {
  const pairs = pairsFor(truth).slice(0, 2).map((p) => ({ plan: p.plan, image: geoToLocal(ORIGIN, p.geo) }));
  const f = fitSimilarity(pairs, 2);
  assert.ok(Math.abs(f.scale - 2) < 1e-9 && Math.abs(f.rotation - 30) < 1e-4 && f.rms < 0.05);
  // Asked for a different size than the pairs imply, the size is kept and the pairs show the difference.
  const forced = fitSimilarity(pairs, 2.2);
  assert.ok(Math.abs(forced.scale - 2.2) < 1e-9 && forced.rms > 0.5);
  assert.equal(fitSimilarity(pairs.slice(0, 1), 2), null);
});

test('validateAlignment takes a group of homes and a locked size', () => {
  const ok = validateAlignment({ cluster: 'H1-B', group: { houses: ['H-35', 'H-33', 'H-33'] }, scale: 2, pairs: pairsFor(truth).slice(0, 3) }, ORIGIN);
  assert.ok(!('error' in ok));
  assert.deepEqual(ok.group, { key: 'H1-B:H-33', houses: ['H-33', 'H-35'] });
  assert.ok(Math.abs(ok.fit.scale - 2) < 1e-9);
  assert.equal(validateAlignment({ cluster: 'H1-B', pairs: pairsFor(truth) }, ORIGIN).group, null);
  for (const bad of [{ houses: [] }, { houses: ['x'] }, { houses: 'H-33' }]) assert.ok('error' in validateAlignment({ cluster: 'H1-B', group: bad, pairs: pairsFor(truth) }, ORIGIN));
  assert.ok('error' in validateAlignment({ cluster: 'H1-B', scale: 100, pairs: pairsFor(truth) }, ORIGIN));
});

test('groupPlacements moves a group into its sheet\'s first page the way a page is moved, and leaves unaligned groups out', async () => {
  const { groupPlacements } = await import('./site-map-align.mjs');
  const mk = (cluster, t, extra = {}) => shapeAlignment({ cluster, a: t.a, b: t.b, tx: t.tx, ty: t.ty, origin_lat: ORIGIN.lat, origin_lng: ORIGIN.lng, ...extra });
  const A = mk('H1-A', truth);
  const sheets = { H1: [{ page: 'H1-A' }, { page: 'H1-B' }] };
  const detected = [{ cluster: 'H1-B', houses: ['H-33', 'H-34'] }, { cluster: 'H1-B', houses: ['H-38'] }, { cluster: 'H1-A', houses: ['H-23', 'H-24'] }];
  const B = { a: 1, b: 0, tx: 5, ty: 6 };
  const rows = [mk('H1-B', B, { group_key: 'H1-B:H-33', houses: ['H-33', 'H-34'] })];
  const out = groupPlacements(sheets, [A], rows, detected);
  assert.deepEqual(Object.keys(out).sort(), ['H-33', 'H-34']);
  const direct = relativePlacement(A, mk('H1-B', B));
  for (const k of ['scale', 'rotate', 'dx', 'dy']) assert.ok(Math.abs(out['H-33'][k] - direct[k]) < 1e-9, k);
  assert.deepEqual(groupPlacements(sheets, [], rows, detected), {}); // no frame page alignment yet
});

test('a group dragged into place is saved as a direct fit, only for a group and only once the page has a frame', () => {
  const direct = { a: 4, b: 0.5, tx: 10, ty: -20 };
  const body = { cluster: 'H1-B', group: { houses: ['H-33', 'H-34'] }, direct, pairs: [] };
  const ok = validateAlignment(body, ORIGIN);
  assert.ok(!('error' in ok));
  assert.equal(ok.direct, true);
  assert.deepEqual([ok.fit.a, ok.fit.b, ok.fit.tx, ok.fit.ty], [4, 0.5, 10, -20]);
  assert.equal(ok.pairs.length, 0);
  assert.ok('error' in validateAlignment({ ...body, group: undefined }, ORIGIN)); // a whole page cannot be dragged
  assert.ok('error' in validateAlignment(body, null)); // no frame yet
  assert.ok('error' in validateAlignment({ ...body, direct: { ...direct, a: 'x' } }, ORIGIN));
});

test('snapShift brings a group\'s wall onto the neighbour\'s, in metres', async () => {
  const { snapShift, sharedWalls } = await import('./site-map-align.mjs');
  // Two plots that touch on the plan along x = 100 (mine on the left, theirs on the right), 20 plan units apart on the y axis.
  const mine = [[[0, 0], [100, 0], [100, 60], [0, 60]]];
  const theirs = [[[100, 0], [200, 0], [200, 60], [100, 60]]];
  assert.equal(sharedWalls(mine, theirs).length, 1);
  // Both drawn at 2 plan units per metre with no turn; mine sits 3 m too far east, past the neighbour's wall.
  const fitTheirs = { a: 2, b: 0, tx: 0, ty: 0 };
  const fitMine = { a: 2, b: 0, tx: -6, ty: 0 }; // its plan points land 3 m further east on the ground than theirs
  // (planToLocal: local = (plan - t) / c, so tx = -6 moves everything +3 m east)
  const s = snapShift({ mine, theirs, fitMine, fitTheirs });
  assert.ok(Math.abs(s.east + 3) < 1e-3 && Math.abs(s.north) < 1e-3, JSON.stringify(s)); // move 3 m west
  assert.ok(Math.abs(s.before - 3) < 1e-3);
  // Groups that do not touch have nothing to snap to.
  assert.equal(snapShift({ mine, theirs: [[[300, 0], [400, 0], [400, 60], [300, 60]]], fitMine, fitTheirs }), null);
});
