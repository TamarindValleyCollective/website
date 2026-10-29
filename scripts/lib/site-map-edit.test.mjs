// Run with: node --test scripts/lib/site-map-edit.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEdit, auditDetail, normalizeRotation } from './site-map-edit.mjs';

const V1 = '2026-10-29T10:00:00+00:00';
const ctx = {
  units: [
    { house_no: 'H-02', cluster: 'H2', shape: 'S', x: '224.87', y: '532.14', rotation: '0.00', mirror_x: true, mirror_y: false, updated_at: V1 },
    { house_no: 'H-04', cluster: 'H2', shape: 'DG', x: '346.63', y: '459.10', rotation: '-180.00', mirror_x: true, mirror_y: false, updated_at: V1 },
    { house_no: 'H-05', cluster: 'H2', shape: 'DG', x: 407.83, y: 459.1, rotation: 0, mirror_x: false, mirror_y: false, updated_at: V1 },
  ],
  households: [{ house_no: 'H-02' }, { house_no: 'H-53' }, { house_no: null }],
};
const err = (body) => validateEdit(body, ctx).error;

test('rotation is kept in (-180, 180]', () => {
  assert.equal(normalizeRotation(190), -170);
  assert.equal(normalizeRotation(-180), 180);
  assert.equal(normalizeRotation(180), 180);
  assert.equal(normalizeRotation(360), 0);
  assert.equal(normalizeRotation(45.236), 45.24);
});

test('every edit names a known action and a real house number', () => {
  assert.match(err({ houseNo: 'H-02' }), /what to do/);
  assert.match(err({ action: 'delete', houseNo: 'H-02' }), /what to do/);
  assert.match(err({ action: 'update', houseNo: '7' }), /H-07/);
  assert.match(err({ action: 'update', houseNo: 'H-99', version: V1, x: 1 }), /not on the map/);
  assert.match(validateEdit(null, ctx).error, /what to do/);
});

test('update: changes only what changed, normalises rotation, and records before and after', () => {
  const r = validateEdit({ action: 'update', houseNo: 'H-05', version: V1, rotation: 190, x: 410.456 }, ctx).edit;
  assert.deepEqual(r.after, { x: 410.46, rotation: -170 });
  assert.deepEqual(r.before, { x: 407.83, rotation: 0 });
  assert.equal(r.row.shape, 'DG');
  assert.equal(r.row.mirror_x, false);
});

test('update: before values from the database come out as numbers, not strings', () => {
  const r = validateEdit({ action: 'update', houseNo: 'H-02', version: V1, x: 230 }, ctx).edit;
  assert.deepEqual(r.before, { x: 224.87 });
});

test('update: a changed shape or mirror counts as a change, and nothing changed is refused', () => {
  assert.deepEqual(validateEdit({ action: 'update', houseNo: 'H-05', version: V1, shape: 'TO' }, ctx).edit.after, { shape: 'TO' });
  assert.deepEqual(validateEdit({ action: 'update', houseNo: 'H-05', version: V1, mirrorY: true }, ctx).edit.after, { mirror_y: true });
  assert.match(err({ action: 'update', houseNo: 'H-05', version: V1 }), /Nothing changed/);
  // numeric strings from the database compare as numbers: -180 stored equals 180 typed? no, 180 is a different value
  assert.match(err({ action: 'update', houseNo: 'H-05', version: V1, x: 407.83, y: 459.1, rotation: 0 }), /Nothing changed/);
});

test('update: a stale version is refused, never overwritten', () => {
  const r = validateEdit({ action: 'update', houseNo: 'H-05', version: '2026-10-28T00:00:00+00:00', x: 1 }, ctx);
  assert.equal(r.status, 409);
  assert.match(r.error, /changed by someone else/);
  assert.match(err({ action: 'update', houseNo: 'H-05', x: 1 }), /Reload/);
});

test('update: bad numbers, shapes and mirrors are refused', () => {
  assert.match(err({ action: 'update', houseNo: 'H-05', version: V1, x: 'a' }), /X must be a number/);
  assert.match(err({ action: 'update', houseNo: 'H-05', version: V1, y: 1e9 }), /Y must be a number/);
  assert.match(err({ action: 'update', houseNo: 'H-05', version: V1, x: NaN }), /X must be a number/);
  assert.match(err({ action: 'update', houseNo: 'H-05', version: V1, rotation: 'left' }), /Rotation/);
  assert.match(err({ action: 'update', houseNo: 'H-05', version: V1, shape: 'ZZ' }), /shape/);
  assert.match(err({ action: 'update', houseNo: 'H-05', version: V1, mirrorX: 'yes' }), /Mirror/);
});

test('add: a new house number in a known cluster with a shape and a position', () => {
  const r = validateEdit({ action: 'add', houseNo: 'H-53', cluster: 'H2', shape: 'S', x: 100, y: 200.555 }, ctx).edit;
  assert.deepEqual(r.row, { house_no: 'H-53', cluster: 'H2', shape: 'S', x: 100, y: 200.56, rotation: 0, mirror_x: false, mirror_y: false });
  assert.match(err({ action: 'add', houseNo: 'H-02', cluster: 'H2', shape: 'S', x: 1, y: 1 }), /already on the map/);
  assert.match(err({ action: 'add', houseNo: 'H-60', cluster: 'H3', shape: 'S', x: 1, y: 1 }), /cluster/);
  assert.match(err({ action: 'add', houseNo: 'H-60', cluster: 'H2', shape: 'Q', x: 1, y: 1 }), /shape/);
  assert.match(err({ action: 'add', houseNo: 'H-60', cluster: 'H2', shape: 'S', y: 1 }), /X must be/);
});

test('remove: refused while a household is attached, allowed for an empty home', () => {
  const r = validateEdit({ action: 'remove', houseNo: 'H-02' }, ctx);
  assert.equal(r.status, 409);
  assert.match(r.error, /has a household/);
  assert.deepEqual(validateEdit({ action: 'remove', houseNo: 'H-04' }, ctx).edit.before, { cluster: 'H2', shape: 'DG' });
});

test('renumber: needs a free number and no household on the old one', () => {
  assert.deepEqual(validateEdit({ action: 'renumber', houseNo: 'H-04', newHouseNo: 'H-40' }, ctx).edit.after, { houseNo: 'H-40' });
  assert.match(err({ action: 'renumber', houseNo: 'H-02', newHouseNo: 'H-40' }), /has a household/);
  assert.match(err({ action: 'renumber', houseNo: 'H-04', newHouseNo: 'H-05' }), /already on the map/);
  assert.match(err({ action: 'renumber', houseNo: 'H-04', newHouseNo: 'H-04' }), /already its house number/);
  assert.match(err({ action: 'renumber', houseNo: 'H-04', newHouseNo: 'seven' }), /H-07/);
  // a household that already names the new number is fine: this is how a house that was built but not drawn gets matched
  assert.ok(validateEdit({ action: 'renumber', houseNo: 'H-04', newHouseNo: 'H-53' }, ctx).edit);
});

test('the audit detail has the house number and changed values only', () => {
  const edit = validateEdit({ action: 'update', houseNo: 'H-05', version: V1, rotation: 10 }, ctx).edit;
  assert.deepEqual(auditDetail(edit), { houseNo: 'H-05', before: { rotation: 0 }, after: { rotation: 10 } });
  const rn = validateEdit({ action: 'renumber', houseNo: 'H-04', newHouseNo: 'H-40' }, ctx).edit;
  assert.deepEqual(auditDetail(rn), { houseNo: 'H-04', newHouseNo: 'H-40', before: { houseNo: 'H-04' }, after: { houseNo: 'H-40' } });
});
