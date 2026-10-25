// Run with: node --test scripts/lib/member-units.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { offerProblem, enablePlan, offboardProblem, editPatch, statusChange, DEFAULT_CAPACITY } from './member-units.mjs';

const household = { farm_unit: 'F-12', house_no: 'H-10', cluster: 'H1-A' };
const offer = { id: 'o1', status: 'interested', shape: 'whole' };

test('an offer is a whole unit of 1 to 3 BHK, or a single room offered as 1 bedroom', () => {
  assert.equal(offerProblem({ shape: 'whole', typeId: '2bhk', delegateToTvc: true }), null);
  assert.equal(offerProblem({ shape: 'room', typeId: '1br', delegateToTvc: false }), null);
  assert.match(offerProblem({ shape: 'room', typeId: '2bhk', delegateToTvc: false }), /1 bedroom/);
  assert.match(offerProblem({ shape: 'room', typeId: '1br', delegateToTvc: true }), /yourself/);
  assert.match(offerProblem({ shape: 'whole', typeId: '1br', delegateToTvc: false }), /1, 2 or 3 BHK/);
  assert.match(offerProblem({ shape: 'house', typeId: '1bhk' }), /whole unit or a single room/);
});

test('enabling a whole unit TVC manages creates a rentable, auto-reject unit with a neutral name', () => {
  const plan = enablePlan({ offer, household, existing: null, typeId: '2bhk', delegateToTvc: true, nextSortOrder: 20 });
  assert.equal(plan.reuse, false);
  assert.equal(plan.unit.id, 'F-12');
  assert.equal(plan.unit.owner_farm_unit, 'F-12');
  assert.equal(plan.unit.pool_id, '2bhk');
  assert.equal(plan.unit.manager, 'tvc');
  assert.equal(plan.unit.listing_shape, 'whole');
  assert.equal(plan.unit.status, 'rentable');
  assert.equal(plan.unit.request_mode, 'reject');
  assert.equal(plan.unit.capacity, DEFAULT_CAPACITY['2bhk']);
  assert.equal(plan.unit.cluster, 'H1-A');
  assert.equal(plan.unit.ignores_farm_closure, false);
  assert.equal(plan.unit.name, 'Home H-10');
});

test('a whole unit not delegated, and a room, are managed by the member', () => {
  assert.equal(enablePlan({ offer, household, typeId: '1bhk', delegateToTvc: false, nextSortOrder: 1 }).unit.manager, 'member');
  const room = enablePlan({ offer: { ...offer, shape: 'room' }, household, typeId: '1br', delegateToTvc: false, nextSortOrder: 1 });
  assert.equal(room.unit.manager, 'member');
  assert.equal(room.unit.listing_shape, 'room');
});

test('a unit name never contains a member name', () => {
  const { unit } = enablePlan({ offer, household: { farm_unit: 'F-31', house_no: 'H-31', cluster: null }, typeId: '3bhk', delegateToTvc: false, nextSortOrder: 1 });
  assert.match(unit.name, /^Home H-31$/);
  assert.equal(unit.id, 'F-31');
});

test('a household with no home cannot be enabled, and the unit is named by its house number, not its plot', () => {
  assert.match(enablePlan({ offer, household: { farm_unit: 'F-09', house_no: null, cluster: null }, typeId: '2bhk', nextSortOrder: 1 }).error, /no home/);
  assert.equal(enablePlan({ offer, household, typeId: '2bhk', delegateToTvc: false, nextSortOrder: 1 }).unit.name, 'Home H-10');
});

test('enabling refuses an offer that is not waiting, a household with a unit, and a bad type', () => {
  assert.match(enablePlan({ offer: { ...offer, status: 'enabled' }, household, typeId: '2bhk', nextSortOrder: 1 }).error, /not waiting/);
  assert.match(enablePlan({ offer, household, existing: { status: 'rentable' }, typeId: '2bhk', nextSortOrder: 1 }).error, /already has a unit/);
  assert.match(enablePlan({ offer, household, existing: { status: 'paused' }, typeId: '2bhk', nextSortOrder: 1 }).error, /already has a unit/);
  assert.match(enablePlan({ offer, household, typeId: '1br', nextSortOrder: 1 }).error, /1, 2 or 3 BHK/);
  assert.match(enablePlan({ offer, household: { farm_unit: 'x' }, typeId: '2bhk', nextSortOrder: 1 }).error, /no farm unit/);
});

test('an offboarded unit is reused, keeping its history on one row', () => {
  const plan = enablePlan({ offer, household, existing: { status: 'offboarded' }, typeId: '2bhk', delegateToTvc: false, nextSortOrder: 5 });
  assert.equal(plan.reuse, true);
  assert.equal(plan.unit.status, 'rentable');
});

test('offboarding is refused while there are future bookings', () => {
  assert.equal(offboardProblem([]), null);
  assert.equal(offboardProblem(undefined), null);
  assert.match(offboardProblem([{}]), /1 future booking\. Reallocate or cancel it first/);
  assert.match(offboardProblem([{}, {}]), /2 future bookings\. Reallocate or cancel them first/);
});

test('editing tags, cluster, capacity and the private note', () => {
  assert.deepEqual(editPatch({ tags: [' Kitchen ', 'ground  floor', 'kitchen', ''] }).patch, { tags: ['kitchen', 'ground floor'] });
  assert.deepEqual(editPatch({ cluster: 'H2', capacity: 5, note: '  Road noise  ' }).patch, { cluster: 'H2', capacity: 5, note: 'Road noise' });
  assert.deepEqual(editPatch({ cluster: null, note: '' }).patch, { cluster: null, note: null });
  assert.match(editPatch({ cluster: 'X' }).error, /cluster/);
  assert.match(editPatch({ capacity: 0 }).error, /1 to 12/);
  assert.match(editPatch({ capacity: 2.5 }).error, /whole number/);
  assert.match(editPatch({ tags: 'kitchen' }).error, /at most/);
  assert.match(editPatch({ tags: ['x'.repeat(31)] }).error, /30 characters/);
  assert.match(editPatch({ note: 'x'.repeat(501) }).error, /500/);
  assert.match(editPatch({}).error, /Nothing to change/);
});

test('a unit can be paused and resumed, not an offboarded one', () => {
  assert.deepEqual(statusChange({ status: 'rentable' }, 'paused'), { status: 'paused' });
  assert.deepEqual(statusChange({ status: 'paused' }, 'rentable'), { status: 'rentable' });
  assert.match(statusChange({ status: 'rentable' }, 'rentable').error, /already/);
  assert.match(statusChange({ status: 'offboarded' }, 'rentable').error, /offboarded/);
  assert.match(statusChange({ status: 'rentable' }, 'offboarded').error, /paused or resumed/);
  assert.match(statusChange(undefined, 'paused').error, /not found/);
});
