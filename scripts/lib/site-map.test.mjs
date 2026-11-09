// Run with: node --test scripts/lib/site-map.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSiteMap, buildAdminSiteMap, shapeClusters, SHAPES, shapeIds, houseNumber } from './site-map.mjs';

const unit = (house_no, extra = {}) => ({ house_no, cluster: 'H1-A', shape: 'S', x: '10.50', y: 20, rotation: '114.00', mirror_x: false, mirror_y: false, ...extra });
const data = {
  units: [unit('H-10'), unit('H-02', { shape: 'TO', mirror_x: true }), unit('H-03'), unit('H-04'), unit('H-05', { shape: 'ZZ' })],
  households: [
    { id: 'h2', farm_unit: 'F-02', house_no: 'H-02', unit_type: 'TO1-V2' },
    { id: 'h3', farm_unit: 'F-03', house_no: 'H-03', unit_type: 'S1' },
    { id: 'h10', farm_unit: 'F-10', house_no: 'H-10', unit_type: null },
    { id: 'h5', farm_unit: 'F-05', house_no: null, unit_type: 'S1' },
  ],
  people: [
    { id: 'a', full_name: 'Zed Owner' },
    { id: 'b', full_name: 'Amy Owner' },
    { id: 'c', full_name: 'Hidden Person', directory_visible: false },
    { id: 'd', full_name: 'Gone Person', active: false },
    { id: 'e', full_name: 'Family Only' },
  ],
  memberships: [
    { household_id: 'h2', person_id: 'a', role: 'owner' },
    { household_id: 'h2', person_id: 'b', role: 'owner' },
    { household_id: 'h2', person_id: 'e', role: 'family' },
    { household_id: 'h3', person_id: 'c', role: 'owner' },
    { household_id: 'h10', person_id: 'e', role: 'family' },
  ],
};
const byHouse = (units) => Object.fromEntries(units.map((u) => [u.houseNo, u]));

test('homes come back in house-number order, with numbers as numbers', () => {
  const out = buildSiteMap(data, null);
  assert.deepEqual(out.map((u) => u.houseNo), ['H-02', 'H-03', 'H-04', 'H-05', 'H-10']);
  assert.equal(out[0].x, 10.5);
  assert.equal(out[0].rotation, 114);
  assert.equal(out[0].mirrorX, true);
});

test('named owners are listed by name, family is not named while an owner is listed', () => {
  const u = byHouse(buildSiteMap(data, null))['H-02'];
  assert.equal(u.status, 'named');
  assert.deepEqual(u.names, ['Amy Owner', 'Zed Owner']);
  assert.equal(u.farmUnit, 'F-02');
});

test('a person who opted out is never named, and a household with nobody listed is private, with no profile to open', () => {
  const u = byHouse(buildSiteMap(data, null))['H-03'];
  assert.equal(u.status, 'private');
  assert.deepEqual(u.names, []);
  assert.equal(u.farmUnit, null);
  assert.ok(!JSON.stringify(buildSiteMap(data, null)).includes('Hidden Person'));
  assert.ok(!JSON.stringify(buildSiteMap(data, null)).includes('Gone Person'));
});

test('with no listed owner, everyone listed is shown, as in the directory', () => {
  const u = byHouse(buildSiteMap(data, null))['H-10'];
  assert.equal(u.status, 'named');
  assert.deepEqual(u.names, ['Family Only']);
});

test('a home with no household is vacant; a household with no house built is not on the map at all', () => {
  const out = byHouse(buildSiteMap(data, null));
  assert.equal(out['H-04'].status, 'vacant');
  assert.deepEqual(out['H-04'].names, []);
  assert.equal(out['H-04'].unitType, null);
});

test('the bedroom count follows the member record, and falls back to the shape', () => {
  const out = byHouse(buildSiteMap(data, null));
  assert.equal(out['H-02'].bhk, '3 BHK');
  assert.equal(out['H-02'].unitType, 'TO1-V2');
  assert.equal(out['H-03'].bhk, '1 BHK');
  assert.equal(out['H-04'].bhk, '1 BHK'); // vacant: from the shape
  assert.equal(out['H-10'].unitType, null);
});

test('an unknown shape is drawn as S rather than breaking the page', () => {
  assert.equal(byHouse(buildSiteMap(data, null))['H-05'].shape, 'S');
});

test('only the viewer\'s own home is marked yours', () => {
  const out = buildSiteMap(data, 'h2');
  assert.deepEqual(out.filter((u) => u.isYours).map((u) => u.houseNo), ['H-02']);
  assert.equal(buildSiteMap(data, null).some((u) => u.isYours), false);
});

test('nothing but the allowed fields goes out: no email, phone or ids', () => {
  const keys = Object.keys(buildSiteMap(data, 'h2')[0]).sort();
  assert.deepEqual(keys, ['bhk', 'cluster', 'detail', 'farmUnit', 'houseNo', 'isYours', 'mirrorX', 'mirrorY', 'names', 'rotation', 'shape', 'status', 'unitType', 'x', 'y']);
});

// ---- label position ----
import { labelAnchor, plotOutline, plotPolygons } from './site-map.mjs';

test('label: the plot a home is in is the closed outline containing its centre, and the label goes at that outline\'s centre', () => {
  const path = 'M0 0 L100 0 L100 50 L0 50 L0 0 M200 0 L300 0 L300 100 L200 100 Z M0 0 L100 0 L100 50 L0 50 Z';
  assert.deepEqual(labelAnchor(path, 30, 20), [50, 25]);
  assert.deepEqual(labelAnchor(path, 250, 90), [250, 50]);
});

test('label: open lines are not plots, and a home outside every outline gets no anchor', () => {
  const path = 'M0 0 L100 0 L100 50 L0 50 L0 0';
  assert.equal(plotPolygons(path).length, 0);
  assert.equal(labelAnchor(path, 30, 20), null);
  assert.equal(labelAnchor('M0 0 L10 0 L10 10 Z', 50, 50), null);
  assert.equal(labelAnchor('', 1, 1), null);
});

test('label: when outlines nest, the smallest one wins', () => {
  const path = 'M0 0 L200 0 L200 200 L0 200 Z M50 50 L100 50 L100 100 L50 100 Z';
  assert.deepEqual(labelAnchor(path, 70, 70), [75, 75]);
  assert.deepEqual(labelAnchor(path, 150, 150), [100, 100]);
});

test('label: an L-shaped plot is centred by area, not by its corners', () => {
  const [x, y] = labelAnchor('M0 0 L100 0 L100 20 L20 20 L20 100 L0 100 Z', 10, 10);
  assert.ok(x > 20 && x < 40 && y > 20 && y < 40);
});

// ---- admin view ----
const adminData = {
  ...data,
  people: [...data.people, { id: 'f', full_name: 'Opted Out Owner', directory_visible: false }],
  memberships: [...data.memberships, { household_id: 'h5', person_id: 'f', role: 'owner' }],
  households: [...data.households, { id: 'h53', farm_unit: 'F-53', house_no: 'H-53', unit_type: 'S1' }],
  pattas: [{ household_id: 'h2', area_sq_ft: '2400.50' }, { household_id: 'h2', area_sq_ft: 100 }, { household_id: 'h3', area_sq_ft: null }],
};

test('admin: sees owners who opted out of the directory (the register is theirs), but never inactive people', () => {
  const out = byHouse(buildAdminSiteMap(adminData).units);
  assert.deepEqual(out['H-03'].owners, ['Hidden Person']);
  assert.ok(!JSON.stringify(buildAdminSiteMap(adminData)).includes('Gone Person'));
});

test('admin: plot size adds a household\'s house pattas; none recorded stays null, never zero', () => {
  const out = byHouse(buildAdminSiteMap(adminData).units);
  assert.equal(out['H-02'].plotSqFt, 2500.5);
  assert.equal(out['H-03'].plotSqFt, null);
  assert.ok(out['H-03'].gaps.includes('House plot size not recorded'));
  assert.equal(out['H-04'].plotSqFt, null); // vacant: nothing to record
  assert.deepEqual(out['H-04'].gaps, []);
});

test('admin: status is vacant, ok or mismatch; a record whose type letters differ from the shape is flagged', () => {
  const d = { ...adminData, units: adminData.units.map((u) => (u.house_no === 'H-03' ? { ...u, shape: 'DG' } : u)) };
  const out = byHouse(buildAdminSiteMap(d).units);
  assert.equal(out['H-04'].status, 'vacant');
  assert.equal(out['H-02'].status, 'ok'); // TO1-V2 on a TO
  assert.equal(out['H-03'].status, 'mismatch'); // S1 on a DG
  assert.ok(out['H-03'].gaps.some((g) => /DG/.test(g) && /S1/.test(g)));
  assert.equal(buildAdminSiteMap(d).summary.mismatch, 1);
});

test('admin: read-only roles get masked names, using the mask the caller passes', () => {
  const out = byHouse(buildAdminSiteMap(adminData, { seeNames: false, maskName: (n) => n[0] + '***' }).units);
  assert.deepEqual(out['H-02'].owners, ['A***', 'Z***']);
});

test('admin: each home lists its people, owners first, with role and picture; the read-only role gets neither name nor picture', () => {
  const d = {
    ...adminData,
    people: adminData.people.map((p) => (p.id === 'a' ? { ...p, google_picture_url: 'https://pics.example/a.jpg' } : p)),
  };
  const people = byHouse(buildAdminSiteMap(d).units)['H-02'].people;
  assert.ok(people.length >= 2);
  assert.ok(people.every((p) => ['name', 'role', 'picture'].every((k) => k in p)));
  assert.equal(people[0].role, 'owner');
  assert.ok(people.some((p) => p.picture === 'https://pics.example/a.jpg'));
  const masked = byHouse(buildAdminSiteMap(d, { seeNames: false, maskName: (n) => n[0] + '***' }).units)['H-02'].people;
  assert.ok(masked.every((p) => p.picture === null && /\*\*\*$/.test(p.name)));
  assert.deepEqual(byHouse(buildAdminSiteMap(d).units)['H-04'].people, []); // vacant
});

test('plot outline: the smallest closed outline round a point, as path data', () => {
  const path = 'M0 0 L200 0 L200 200 L0 200 Z M50 50 L100 50 L100 100 L50 100 Z';
  assert.equal(plotOutline(path, 70, 70), 'M50 50L100 50L100 100L50 100Z');
  assert.equal(plotOutline(path, 500, 500), null);
});

test('admin: a household naming a house that is not on the map is listed, and the summary counts add up', () => {
  const r = buildAdminSiteMap(adminData);
  assert.deepEqual(r.notOnMap, [{ houseNo: 'H-53', farmUnit: 'F-53' }]);
  assert.equal(r.summary.homes, 5);
  assert.equal(r.summary.assigned + r.summary.vacant, 5);
});

test('admin: only the allowed fields go out (no email, phone or person ids)', () => {
  const keys = Object.keys(buildAdminSiteMap(adminData).units[0]).sort();
  assert.deepEqual(keys, ['bhk', 'cluster', 'detail', 'farmUnit', 'gaps', 'houseNo', 'mirrorX', 'mirrorY', 'otherMembers', 'owners', 'people', 'plotSqFt', 'recordType', 'rotation', 'shape', 'status', 'version', 'x', 'y']);
});

test('shapes and clusters', () => {
  assert.deepEqual(shapeIds(), ['S', 'DG', 'DF', 'DO', 'TO']);
  assert.equal(SHAPES.TO.bhk, '3 BHK');
  assert.equal(houseNumber('H-07'), 7);
  assert.deepEqual(shapeClusters([{ cluster: 'H2', base_size: '1.800', view_box: [1, 2, 3, 4], plot_path: 'M0 0' }]), [{ id: 'H2', baseSize: 1.8, viewBox: [1, 2, 3, 4], plot: 'M0 0' }]);
});

test('plot span: the size of the smallest outline round a point', async () => {
  const { plotSpan } = await import('./site-map.mjs');
  const path = 'M0 0 L200 0 L200 100 L0 100 Z M50 10 L90 10 L90 60 L50 60 Z';
  assert.deepEqual(plotSpan(path, 60, 20), { w: 40, h: 50 });
  assert.equal(plotSpan(path, 500, 500), null);
});

test('H1-A and H1-B are combined into one H1 sheet, in H1-A coordinates', async () => {
  const { mergeSheets, sheetOf, SHEETS } = await import('./site-map.mjs');
  const [a, b] = SHEETS.H1;
  const clusters = [
    { id: 'H1-A', baseSize: 1.63, viewBox: [330, 90, 560, 930], plot: 'M10 20 L30 40 Z' },
    { id: 'H1-B', baseSize: 1.8, viewBox: [190, 130, 920, 500], plot: 'M100 200 L300 400 Z' },
    { id: 'H2', baseSize: 1.8, viewBox: [110, 330, 1010, 310], plot: 'M1 2 L3 4' },
  ];
  const units = [{ houseNo: 'H-16', cluster: 'H1-A', x: 400, y: 500 }, { houseNo: 'H-40', cluster: 'H1-B', x: 500, y: 300 }, { houseNo: 'H-01', cluster: 'H2', x: 160, y: 530 }];
  const out = mergeSheets(clusters, units);
  assert.deepEqual(out.clusters.map((c) => c.id), ['H1', 'H2']);
  assert.equal(out.clusters[0].baseSize, 1.63);
  assert.equal(out.clusters[1].plot, 'M1 2 L3 4');
  assert.deepEqual(out.units.map((u) => u.cluster), ['H1', 'H1', 'H2']);
  assert.deepEqual([out.units[0].x, out.units[0].y], [400, 500]);
  assert.equal(out.units[1].x, Math.round((500 * b.scale + b.dx) * 100) / 100);
  assert.equal(out.units[1].y, Math.round((300 * b.scale + b.dy) * 100) / 100);
  assert.deepEqual([out.units[2].x, out.units[2].y], [160, 530]);
  // The plot lines of both pages are in the combined cluster, and the view box covers both.
  assert.match(out.clusters[0].plot, /^M10 20 L30 40 Z M/);
  const [x, y, w, h] = out.clusters[0].viewBox;
  assert.ok(x <= 330 && x <= 190 * b.scale + b.dx + 0.01 && x + w >= 890 && y + h >= 1020);
  assert.equal(sheetOf('H1-B'), 'H1');
  assert.equal(sheetOf('H2'), 'H2');
  assert.equal(a.scale, 1);
});

test('a cluster is rotated on its own, and homes keep the one base size', async () => {
  const { mergeSheets } = await import('./site-map.mjs');
  const sheets = { H1: [{ page: 'H1-A', scale: 1, rotate: 0, dx: 0, dy: 0 }, { page: 'H1-B', scale: 2, rotate: 90, dx: 10, dy: 20 }] };
  const clusters = [
    { id: 'H1-A', baseSize: 1.63, viewBox: [0, 0, 100, 50], plot: 'M0 0 L10 0 Z' },
    { id: 'H1-B', baseSize: 1.8, viewBox: [0, 0, 100, 50], plot: 'M0 0 L10 0 Z' },
  ];
  const units = [{ houseNo: 'H-01', cluster: 'H1-A', x: 5, y: 5, rotation: 30 }, { houseNo: 'H-40', cluster: 'H1-B', x: 10, y: 0, rotation: 100 }];
  const out = mergeSheets(clusters, units, sheets);
  assert.equal(out.clusters.length, 1);
  assert.equal(out.clusters[0].baseSize, 1.63); // one size for every home, never rescaled per page
  const [a, b] = out.units;
  assert.deepEqual([a.x, a.y, a.rotation], [5, 5, 30]);
  // (10, 0) turned 90 degrees clockwise is (0, 10); doubled is (0, 20); shifted by (10, 20) is (10, 40).
  assert.deepEqual([b.x, b.y], [10, 40]);
  assert.equal(b.rotation, -170); // 100 + 90, kept in (-180, 180]
  assert.match(out.clusters[0].plot, /M0 0 L10 0 Z M10 20 L10 40 Z/);
});
