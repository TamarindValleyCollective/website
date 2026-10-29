// Run with: node --test scripts/lib/site-map.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSiteMap, shapeClusters, SHAPES, shapeIds, houseNumber } from './site-map.mjs';

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

test('shapes and clusters', () => {
  assert.deepEqual(shapeIds(), ['S', 'DG', 'DF', 'DO', 'TO']);
  assert.equal(SHAPES.TO.bhk, '3 BHK');
  assert.equal(houseNumber('H-07'), 7);
  assert.deepEqual(shapeClusters([{ cluster: 'H2', base_size: '1.800', view_box: [1, 2, 3, 4], plot_path: 'M0 0' }]), [{ id: 'H2', baseSize: 1.8, viewBox: [1, 2, 3, 4], plot: 'M0 0' }]);
});
