// Run with: node --test scripts/lib/member-rental.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateOffer, validateSettings, validateBlock, canRemoveBlock, rentalState, shapeUnitBookings, offerNotice, MAX_BLOCK_NIGHTS } from './member-rental.mjs';

test('an offer: a room is "1 bedroom", a whole unit needs a size, only a whole unit can be delegated', () => {
  assert.deepEqual(validateOffer({ shape: 'room' }).offer, { shape: 'room', typeId: '1br', delegateToTvc: false });
  assert.deepEqual(validateOffer({ shape: 'whole', size: '2bhk', delegateToTvc: true }).offer, { shape: 'whole', typeId: '2bhk', delegateToTvc: true });
  assert.deepEqual(validateOffer({ shape: 'whole', size: '3bhk' }).offer, { shape: 'whole', typeId: '3bhk', delegateToTvc: false });
  assert.match(validateOffer({ shape: 'whole' }).error, /1, 2 or 3 BHK/);
  assert.match(validateOffer({ shape: 'whole', size: '1br' }).error, /1, 2 or 3 BHK/);
  assert.match(validateOffer({ shape: 'room', delegateToTvc: true }).error, /yourself/);
  assert.match(validateOffer({ shape: 'house' }).error, /whole unit or a single room/);
  assert.match(validateOffer(null).error, /whole unit or a single room/);
  assert.equal(validateOffer({ shape: 'whole', size: '1bhk', delegateToTvc: 'yes' }).offer.delegateToTvc, false);
});

const memberUnit = { status: 'rentable', manager: 'member' };
const delegated = { status: 'rentable', manager: 'tvc' };

test('a member sets how requests are answered only when they manage the unit', () => {
  assert.deepEqual(validateSettings({ requestMode: 'ask' }, memberUnit).patch, { request_mode: 'ask' });
  assert.match(validateSettings({ requestMode: 'ask' }, delegated).error, /TVC answers requests/);
  assert.match(validateSettings({ requestMode: 'sometimes' }, memberUnit).error, /auto-reject, ask me each time, or auto-accept/);
});

test('whether a farm closure applies is the member’s either way', () => {
  assert.deepEqual(validateSettings({ ignoresFarmClosure: true }, delegated).patch, { ignores_farm_closure: true });
  assert.deepEqual(validateSettings({ requestMode: 'auto', ignoresFarmClosure: false }, memberUnit).patch, { request_mode: 'auto', ignores_farm_closure: false });
  assert.match(validateSettings({ ignoresFarmClosure: 'yes' }, memberUnit).error, /stays open/);
});

test('settings need a unit that is still offered, and something to change', () => {
  assert.match(validateSettings({ requestMode: 'ask' }, undefined).error, /no unit/);
  assert.match(validateSettings({ requestMode: 'ask' }, { ...memberUnit, status: 'offboarded' }).error, /no longer offered/);
  assert.match(validateSettings({}, memberUnit).error, /Nothing to change/);
});

test('blocking dates: real dates, from today, in order, within the limit', () => {
  assert.deepEqual(validateBlock({ from: '2026-11-20', to: '2026-11-24' }, '2026-10-27'), { from: '2026-11-20', nights: 5 });
  assert.deepEqual(validateBlock({ from: '2026-10-27', to: '2026-10-27' }, '2026-10-27'), { from: '2026-10-27', nights: 1 });
  assert.match(validateBlock({ from: '2026-10-26', to: '2026-10-28' }, '2026-10-27').error, /from today/);
  assert.match(validateBlock({ from: '2026-11-24', to: '2026-11-20' }, '2026-10-27').error, /cannot be before/);
  assert.match(validateBlock({ from: '2026-02-30', to: '2026-03-02' }, '2026-01-01').error, /first and the last night/);
  assert.match(validateBlock({ from: '2026-11-01' }, '2026-10-27').error, /first and the last night/);
  assert.match(validateBlock({ from: '2026-11-01', to: '2027-03-01' }, '2026-10-27').error, new RegExp(String(MAX_BLOCK_NIGHTS)));
  assert.ok(validateBlock({ from: '2026-11-01', to: '2026-01-29'.replace('2026-01', '2027-01') }, '2026-10-27').nights);
});

const myBlock = { id: 'b1', type: 'unit-closure', createdBy: 'member:p1', startDate: '2026-11-20', nights: 5, tents: [{ tentId: 'F-31', guests: [] }] };

test('a member can remove their own future block, and nothing else', () => {
  assert.equal(canRemoveBlock(myBlock, 'F-31', '2026-10-27'), true);
  assert.equal(canRemoveBlock({ ...myBlock, createdBy: 'a staff id' }, 'F-31', '2026-10-27'), false);
  assert.equal(canRemoveBlock({ ...myBlock, type: 'casual-stay' }, 'F-31', '2026-10-27'), false);
  assert.equal(canRemoveBlock(myBlock, 'F-12', '2026-10-27'), false);
  assert.equal(canRemoveBlock({ ...myBlock, tents: [{ tentId: 'F-31' }, { tentId: 'Tent01' }] }, 'F-31', '2026-10-27'), false);
  assert.equal(canRemoveBlock(myBlock, 'F-31', '2026-11-25'), false); // already over
  assert.equal(canRemoveBlock(myBlock, 'F-31', '2026-11-24'), true); // still has its last night
  assert.equal(canRemoveBlock(undefined, 'F-31', '2026-10-27'), false);
});

test('where the rental stands', () => {
  assert.equal(rentalState({ offer: null, unit: null }), 'none');
  assert.equal(rentalState({ offer: { status: 'interested' }, unit: null }), 'interested');
  assert.equal(rentalState({ offer: { status: 'enabled' }, unit: { status: 'rentable' } }), 'rentable');
  assert.equal(rentalState({ offer: { status: 'enabled' }, unit: { status: 'paused' } }), 'paused');
  assert.equal(rentalState({ offer: { status: 'declined' }, unit: null }), 'none');
  assert.equal(rentalState({ offer: { status: 'enabled' }, unit: { status: 'offboarded' } }), 'none');
});

test('bookings on a unit: stays show guests without contact details, blocks say whether they are the member’s', () => {
  const stay = { id: 's1', type: 'casual-stay', label: 'Iyer', startDate: '2026-11-02', nights: 2, tents: [{ tentId: 'F-31', guests: [{ name: 'Meera Iyer', ageGroup: 'Adult', gender: 'Female', preferences: 'vegetarian', mobileNumber: '+919999999999', email: 'm@example.com' }] }] };
  const other = { id: 's2', type: 'casual-stay', startDate: '2026-11-05', nights: 1, tents: [{ tentId: 'Tent01', guests: [{ name: 'Someone Else' }] }] };
  const staffBlock = { id: 'b2', type: 'unit-closure', createdBy: 'a staff id', startDate: '2026-11-10', nights: 2, tents: [{ tentId: 'F-31', guests: [] }] };
  const farm = { id: 'b3', type: 'farm-closure', createdBy: 'a staff id', startDate: '2026-11-15', nights: 3, tents: [] };
  const out = shapeUnitBookings([stay, other, myBlock, staffBlock, farm], 'F-31', '2026-10-27');
  assert.equal(out.stays.length, 1);
  assert.deepEqual(out.stays[0].guests, [{ name: 'Meera Iyer', ageGroup: 'Adult', gender: 'Female', preferences: 'vegetarian' }]);
  assert.ok(!JSON.stringify(out).includes('+9199'));
  assert.ok(!JSON.stringify(out).includes('example.com'));
  assert.deepEqual(out.blocks.map((b) => [b.id, b.mine, b.farm]), [['b2', false, false], ['b3', false, true], ['b1', true, false]]);
  assert.ok(!('label' in out.blocks[0]) && !('note' in out.blocks[0]), 'a block does not say why');
});

test('the notice names the unit, the offer, who manages it and who to talk to', () => {
  const n = offerNotice({ houseNo: 'H-10', farmUnit: 'F-12', cluster: 'H1-A', shape: 'whole', typeLabel: '2 BHK', delegateToTvc: true, memberName: 'Kiran Rao', memberEmail: 'kiran@example.com' });
  assert.equal(n.subject, 'A member is offering a home: H-10 (2 BHK)');
  const rows = Object.fromEntries(n.rows);
  assert.equal(rows['Home'], 'H-10 (cluster H1-A)');
  assert.equal(rows['Plot (reference)'], 'F-12');
  assert.equal(rows['Offered as'], 'Whole unit, 2 BHK');
  assert.match(rows['Managed by'], /TVC for the member/);
  assert.equal(rows['Member'], 'Kiran Rao');
  assert.equal(rows['Sign-in email'], 'kiran@example.com');
  const room = Object.fromEntries(offerNotice({ houseNo: 'H-31', farmUnit: 'F-31', cluster: null, shape: 'room', typeLabel: '1 bedroom', delegateToTvc: false, memberName: 'D', memberEmail: 'd@example.com' }).rows);
  assert.equal(room['Offered as'], 'A single room, 1 bedroom');
  assert.equal(room['Managed by'], 'The member');
  assert.equal(room['Home'], 'H-31');
});
