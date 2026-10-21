import test from 'node:test';
import assert from 'node:assert/strict';
import { availabilityFor, canCancelStay, checkOut, validateStayDates, validateStayRequest } from './member-stay.mjs';

const TODAY = '2026-10-21';
const person = (name, over = {}) => ({ name, ageGroup: 'Adult', gender: 'NA', ...over });
const req = (tents, over = {}) => ({ startDate: '2026-11-01', nights: 2, tents, ...over });

test('dates: past, missing and too-long are refused; today is fine', () => {
  assert.equal(validateStayDates({ startDate: '2026-10-21', nights: 1 }, TODAY), null);
  assert.match(validateStayDates({ startDate: '2026-10-20', nights: 1 }, TODAY), /past/);
  assert.match(validateStayDates({ startDate: '2026-02-30', nights: 1 }, TODAY), /check-in/);
  assert.match(validateStayDates({ startDate: '2026-11-01', nights: 0 }, TODAY), /nights/);
  assert.match(validateStayDates({ startDate: '2026-11-01', nights: 31 }, TODAY), /at most 30/);
  assert.match(validateStayDates({ startDate: '2028-01-01', nights: 1 }, TODAY), /too far/);
});

test('check-out is check-in plus nights', () => {
  assert.equal(checkOut('2026-10-30', 3), '2026-11-02');
});

test('availability counts only free farm tents and beds, and pitches apart', () => {
  const all = availabilityFor({ occupiedTentIds: [], wholeFarmBlocked: false });
  assert.equal(all.tentsFree, 9);
  assert.equal(all.bedsFree, 22);
  assert.equal(all.pitchesFree, 5);
  const some = availabilityFor({ occupiedTentIds: ['Tent01', 'Tent06', 'BYOT02'], wholeFarmBlocked: false });
  assert.equal(some.tentsFree, 7);
  assert.equal(some.bedsFree, 22 - 3 - 2);
  assert.equal(some.pitchesFree, 4);
  const malabar = some.groups.find((g) => g.group === 'Malabar Hut');
  assert.deepEqual(malabar.units.map((u) => u.free), [false, true, true]);
  assert.equal(some.groups.find((g) => g.group === 'Bring Your Own Tent').byot, true);
});

test('a closure or exclusive event leaves nothing free', () => {
  const a = availabilityFor({ occupiedTentIds: [], wholeFarmBlocked: true });
  assert.equal(a.tentsFree, 0);
  assert.equal(a.bedsFree, 0);
  assert.equal(a.pitchesFree, 0);
  assert.equal(a.wholeFarmBlocked, true);
});

test('a valid request is shaped for the booking RPC and counts paying guests', () => {
  const r = validateStayRequest(req([{ tentId: 'Tent01', guests: [person('Asha Rao'), person('Kiran', { guest: true, mobileNumber: '98450 12345' })] }]), TODAY);
  assert.equal(r.error, undefined);
  assert.equal(r.guestCount, 1);
  assert.equal(r.tents[0].guests[1].mobileNumber, '+919845012345');
  assert.equal('guest' in r.tents[0].guests[1], false);
});

test('a request is refused for each way it can be wrong', () => {
  const bad = (tents, over) => validateStayRequest(req(tents, over), TODAY).error;
  assert.match(bad([]), /at least one tent/);
  assert.match(bad([{ tentId: 'Nope', guests: [person('A')] }]), /not one we have/);
  assert.match(bad([{ tentId: 'Tent06', guests: [] }]), /who is staying/);
  assert.match(bad([{ tentId: 'Tent06', guests: [person('A'), person('B'), person('C')] }]), /holds at most 2/);
  assert.match(bad([{ tentId: 'Tent01', guests: [person('A')] }, { tentId: 'Tent01', guests: [person('B')] }]), /twice/);
  assert.match(bad([{ tentId: 'Tent01', guests: [person('A')] }, { tentId: 'Tent02', guests: [person('a')] }]), /listed twice/);
  assert.match(bad([{ tentId: 'Tent01', guests: [person('A', { ageGroup: 'Teen' })] }]), /adult or a child/);
  assert.match(bad([{ tentId: 'Tent01', guests: [person('A', { gender: 'x' })] }]), /gender/);
  assert.match(bad([{ tentId: 'Tent01', guests: [person('A', { mobileNumber: '123' })] }]), /valid mobile/);
  assert.match(bad([{ tentId: 'Tent01', guests: [person(' ')] }]), /needs a name/);
});

test('cancelling is allowed only before check-in', () => {
  assert.equal(canCancelStay('2026-10-22', TODAY), true);
  assert.equal(canCancelStay('2026-10-21', TODAY), false);
  assert.equal(canCancelStay('2026-10-01', TODAY), false);
});
