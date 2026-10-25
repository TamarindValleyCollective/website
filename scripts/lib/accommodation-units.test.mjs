// Run with: node --test scripts/lib/accommodation-units.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCOMMODATION_UNITS } from './accommodation.mjs';
import { unitFromRow, unitFromSeed, typeFromRow, writeProblem, closureApplies, UNIT_SELECT } from './accommodation-units.mjs';

const tentRow = { id: 'Tent01', name: 'Malabar Hut Fixed Tent (N)', short_name: 'Fixed Tent (N)', group_name: 'Malabar Hut', kind: 'fixed', capacity: 3, owner_type: 'tvc', owner_farm_unit: null, pool_id: 'tent', status: 'rentable', manager: 'tvc', listing_shape: null, cluster: null, tags: [], note: 'Road noise at night', ignores_farm_closure: false, sort_order: 1 };

test('a unit row becomes the shape the calendar uses', () => {
  assert.deepEqual(unitFromRow(tentRow), {
    id: 'Tent01', label: 'Malabar Hut Fixed Tent (N)', shortLabel: 'Fixed Tent (N)', capacity: 3, kind: 'fixed', group: 'Malabar Hut', type: 'tent',
    status: 'rentable', manager: 'tvc', ownerFarmUnit: null, listingShape: null, cluster: null, tags: [], ignoresFarmClosure: false, requestMode: 'reject',
  });
});

test('the private note is only included when asked for', () => {
  assert.equal(unitFromRow(tentRow).note, undefined);
  assert.equal(unitFromRow(tentRow, { includeNote: true }).note, 'Road noise at night');
});

test('missing optional columns fall back to safe values', () => {
  const u = unitFromRow({ id: 'X', name: 'X', kind: 'fixed', capacity: 2 });
  assert.equal(u.shortLabel, 'X');
  assert.equal(u.group, '');
  assert.equal(u.type, '');
  assert.equal(u.status, 'rentable');
  assert.equal(u.manager, 'tvc');
  assert.deepEqual(u.tags, []);
});

test('a type row becomes a label and an owner', () => {
  assert.deepEqual(typeFromRow({ id: '2bhk', name: '2 BHK', owner_type: 'member' }), { id: '2bhk', label: '2 BHK', ownerType: 'member' });
});

test('the built-in list maps to TVC-managed, rentable units of a type', () => {
  for (const seed of ACCOMMODATION_UNITS) {
    const u = unitFromSeed(seed);
    assert.equal(u.manager, 'tvc');
    assert.equal(u.status, 'rentable');
    assert.ok(['tent', 'hut', 'byot'].includes(u.type), `${u.id} has a type`);
  }
});

test('the row select names every column the mapper reads', () => {
  for (const col of ['status', 'manager', 'listing_shape', 'cluster', 'tags', 'note', 'ignores_farm_closure', 'request_mode', 'pool_id']) {
    assert.ok(UNIT_SELECT.split(',').includes(col), col);
  }
});

test('staff may write to TVC-managed units, not to a member-managed or an offboarded one', () => {
  assert.equal(writeProblem(unitFromRow(tentRow)), null);
  assert.equal(writeProblem(undefined), null);
  const member = unitFromRow({ ...tentRow, id: 'F12', name: 'Kiran home', owner_type: 'member', owner_farm_unit: 'F-12', manager: 'member', listing_shape: 'room', pool_id: '1br' });
  const problem = writeProblem(member);
  assert.equal(problem.status, 403);
  assert.match(problem.message, /managed by its member/);
  const gone = writeProblem(unitFromRow({ ...tentRow, status: 'offboarded' }));
  assert.equal(gone.status, 400);
  assert.match(gone.message, /no longer in use/);
  // paused: still the farm manager's to edit
  assert.equal(writeProblem(unitFromRow({ ...tentRow, status: 'paused' })), null);
});

test('a whole-farm closure applies to a unit unless it stays open or is offboarded', () => {
  assert.equal(closureApplies(unitFromRow(tentRow)), true);
  assert.equal(closureApplies(unitFromRow({ ...tentRow, status: 'paused' })), true);
  assert.equal(closureApplies(unitFromRow({ ...tentRow, ignores_farm_closure: true })), false);
  assert.equal(closureApplies(unitFromRow({ ...tentRow, status: 'offboarded' })), false);
});
