import test from 'node:test';
import assert from 'node:assert/strict';
import { availabilityFor, canCancelStay, checkOut, partyNote, validateStayDates, validateStayRequest, waitingBeds } from './member-stay.mjs';

const TODAY = '2026-10-21';
const person = (name, over = {}) => ({ name, ageGroup: 'Adult', ...over });
const req = (people, over = {}) => ({ startDate: '2026-11-01', nights: 2, people, ...over });
const family = new Map([['m1', { name: 'Asha Rao' }], ['m2', { name: 'Ravi Rao' }]]);

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

test('availability shows fixed and portable tents apart, never the pitches', () => {
  const all = availabilityFor({ occupiedTentIds: [], wholeFarmBlocked: false });
  assert.deepEqual(all.fixed, { tents: 5, beds: 13 });
  assert.deepEqual(all.portable, { tents: 4, beds: 9 });
  assert.equal(all.bedsFree, 22);
  assert.equal(all.maxParty, 22);
  const some = availabilityFor({ occupiedTentIds: ['Tent01', 'Tent06', 'Tent09', 'BYOT02'], wholeFarmBlocked: false });
  assert.deepEqual(some.fixed, { tents: 3, beds: 8 });
  assert.deepEqual(some.portable, { tents: 3, beds: 7 });
});

test('people already asked for and not yet given tents are taken off what is free', () => {
  const a = availabilityFor({ occupiedTentIds: ['Tent01'], wholeFarmBlocked: false, waiting: 5 });
  assert.equal(a.bedsFree, 19);
  assert.equal(a.maxParty, 14);
  assert.equal(availabilityFor({ occupiedTentIds: [], wholeFarmBlocked: false, waiting: 40 }).maxParty, 0);
});

test('a closure or exclusive event leaves nothing free', () => {
  const a = availabilityFor({ occupiedTentIds: [], wholeFarmBlocked: true });
  assert.equal(a.bedsFree, 0);
  assert.equal(a.maxParty, 0);
  assert.equal(a.wholeFarmBlocked, true);
});

test('waiting beds are the busiest night of the stay', () => {
  const waiting = [{ startDate: '2026-11-01', nights: 2, people: 4 }, { startDate: '2026-11-02', nights: 3, people: 3 }, { startDate: '2026-12-01', nights: 1, people: 9 }];
  assert.equal(waitingBeds(waiting, '2026-11-01', 1), 4);
  assert.equal(waitingBeds(waiting, '2026-11-01', 3), 7); // the night of the 2nd has both
  assert.equal(waitingBeds(waiting, '2026-11-05', 2), 0);
  assert.equal(waitingBeds([], '2026-11-01', 2), 0);
});

test('a valid request keeps the party, counts paying guests, and never asks for tents', () => {
  const r = validateStayRequest(req([{ memberId: 'm1', guest: true }, { memberId: 'm2' }, person('Dev Rao', { ageGroup: 'Child' }), person('Meera Iyer', { guest: false })], { note: ' near the stream ' }), TODAY, family);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.party.map((p) => [p.name, p.ageGroup, p.guest]), [['Asha Rao', 'Adult', false], ['Ravi Rao', 'Adult', false], ['Dev Rao', 'Child', true], ['Meera Iyer', 'Adult', true]]);
  assert.equal(r.guestCount, 2); // anyone typed is a paying guest, whatever the request says; the register's people never are
  assert.equal(r.note, 'near the stream');
  assert.equal('tents' in r, false);
});

test('a request is refused for each way it can be wrong', () => {
  const bad = (people, over, available) => validateStayRequest(req(people, over), TODAY, family, available).error;
  assert.match(bad([]), /who is coming/);
  assert.match(bad([{ memberId: 'stranger' }]), /not available to book for/);
  assert.match(bad([{ memberId: 'm1' }, { memberId: 'm1' }]), /listed twice/);
  assert.match(bad([{ memberId: 'm1' }, person('asha rao')]), /listed twice/);
  assert.match(bad([person('A', { ageGroup: 'Teen' })]), /adult or a child/);
  assert.match(bad([person(' ')]), /needs a name/);
  assert.match(bad([person('A'), person('B'), person('C')], {}, 2), /Only 2 places are free/);
  assert.match(bad([person('A')], {}, 0), /no room/);
  assert.match(bad([person('A')], { nights: 0 }), /nights/);
});

test('the note for Madhavan names everyone and carries no contact details', () => {
  const party = [{ name: 'Asha Rao', ageGroup: 'Adult', guest: false }, { name: 'Dev Rao', ageGroup: 'Child', guest: false }, { name: 'Meera Iyer', ageGroup: 'Adult', guest: true }];
  assert.equal(partyNote(party, ''), 'Needs tents. Party of 3: Asha Rao, Dev Rao (child), Meera Iyer (paying guest).');
  assert.match(partyNote(party, 'late arrival'), /Note: late arrival$/);
});

test('cancelling is allowed only before check-in', () => {
  assert.equal(canCancelStay('2026-10-22', TODAY), true);
  assert.equal(canCancelStay('2026-10-21', TODAY), false);
  assert.equal(canCancelStay('2026-10-01', TODAY), false);
});
