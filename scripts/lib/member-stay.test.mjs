import test from 'node:test';
import assert from 'node:assert/strict';
import { availabilityFor, canCancelStay, checkOut, partyNote, validateStayDates, validateStayRequest, waitingBeds } from './member-stay.mjs';

const TODAY = '2026-10-21';
// A typed guest: everything tent allocation asks of a new guest (name, adult or child, gender, a mobile number).
const person = (name, over = {}) => ({ name, ageGroup: 'Adult', gender: 'Female', mobileNumber: '98450 12345', ...over });
// A member named from the register: adult or child is asked for everyone, gender and standing preferences for the member's own unit.
const member = (memberId, over = {}) => ({ memberId, ageGroup: 'Adult', gender: 'Female', ...over });
const req = (people, over = {}) => ({ startDate: '2026-11-01', nights: 2, people, ...over });
const family = new Map([
  ['m1', { name: 'Asha Rao', phone: '98450 54321', email: 'asha@example.com', own: true }],
  ['m2', { name: 'Ravi Rao', phone: null, email: null, own: true }],
  ['m3', { name: 'Kiran Menon', phone: '98450 77777', email: null, own: false }], // another unit's member
]);

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
  const r = validateStayRequest(req([member('m1', { gender: 'Female' }), member('m2', { gender: 'Male' }), member('m3'), person('Dev Rao', { ageGroup: 'Child', gender: 'Male' }), person('Meera Iyer', { email: 'meera@example.com' })], { note: ' near the stream ' }), TODAY, family);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.party.map((p) => [p.name, p.ageGroup, p.guest]), [['Asha Rao', 'Adult', false], ['Ravi Rao', 'Adult', false], ['Kiran Menon', 'Adult', false], ['Dev Rao', 'Child', true], ['Meera Iyer', 'Adult', true]]);
  assert.equal(r.guestCount, 2); // anyone typed is a paying guest, whatever the request says; the register's people never are
  assert.equal(r.note, 'near the stream');
  assert.equal('tents' in r, false);
  // contact: the register's own for members, what was typed for guests
  assert.deepEqual([r.party[0].mobileNumber, r.party[0].email], ['+919845054321', 'asha@example.com']);
  assert.equal(r.party[1].mobileNumber, undefined);
  assert.deepEqual([r.party[4].mobileNumber, r.party[4].email], ['+919845012345', 'meera@example.com']);
});

test('adult or child is asked for every person, member or not', () => {
  const bad = (p) => validateStayRequest(req([p]), TODAY, family).error;
  assert.match(bad(member('m1', { ageGroup: undefined })), /Asha Rao is an adult or a child/);
  assert.match(bad(member('m3', { ageGroup: 'Teen' })), /Kiran Menon is an adult or a child/);
  assert.match(bad(person('A', { ageGroup: 'Teen' })), /adult or a child/);
  const child = validateStayRequest(req([member('m2', { ageGroup: 'Child', gender: 'Male' })]), TODAY, family);
  assert.equal(child.party[0].ageGroup, 'Child'); // a member on the register can be a child
});

test("gender is asked for every guest and for the member's own unit, and kept on the directory record", () => {
  const bad = (p) => validateStayRequest(req([p]), TODAY, family).error;
  assert.match(bad(member('m1', { gender: undefined })), /gender for Asha Rao/);
  assert.match(bad(person('A', { gender: undefined })), /gender for A/);
  assert.match(bad(person('A', { gender: 'robot' })), /gender for A/);
  const ok = validateStayRequest(req([member('m1', { gender: 'NA' }), person('Kiran', { gender: 'NA' })]), TODAY, family);
  assert.equal(ok.party[0].gender, 'NA'); // "Prefer not to say" is an answer
  // another unit's member: their gender is not ours to ask, nor to change
  const other = validateStayRequest(req([member('m3', { gender: undefined })]), TODAY, family);
  assert.equal(other.error, undefined);
  assert.equal(other.party[0].gender, undefined);
});

test("a member's own unit shows standing allergies and preferences to review, which replace the record; another unit's are never touched", () => {
  const r = validateStayRequest(req([member('m1', { preferences: '  vegetarian,   no garlic ' }), member('m2', { preferences: '' }), member('m3', { preferences: 'ignored' })]), TODAY, family);
  assert.deepEqual([r.party[0].preferences, r.party[0].replacePreferences], ['vegetarian, no garlic', true]);
  assert.deepEqual([r.party[1].preferences, r.party[1].replacePreferences], [null, true]); // cleared on purpose
  assert.deepEqual([r.party[2].preferences, r.party[2].replacePreferences], [undefined, undefined]);
});

test('a food or allergy need for this stay only is kept per person, apart from their standing preferences', () => {
  const r = validateStayRequest(req([member('m1', { preferences: 'vegetarian', stayRequirements: '  No onions   today ' }), member('m3', { stayRequirements: 'Jain meals' }), person('Meera Iyer', { stayRequirements: 'x'.repeat(500) }), member('m2')]), TODAY, family);
  assert.equal(r.party[0].stayRequirements, 'No onions today');
  assert.equal(r.party[0].preferences, 'vegetarian'); // the standing one is separate
  assert.equal(r.party[1].stayRequirements, 'Jain meals'); // anyone can have one, including another unit's member
  assert.equal(r.party[2].stayRequirements.length, 300);
  assert.equal('stayRequirements' in r.party[3], false);
});

test('a typed guest carries their allergies or preferences and email into the directory', () => {
  const r = validateStayRequest(req([person('Meera Iyer', { gender: 'Female', preferences: '  vegetarian,   nut allergy ', email: 'meera@example.com' })]), TODAY, family);
  assert.deepEqual([r.party[0].gender, r.party[0].preferences, r.party[0].email], ['Female', 'vegetarian, nut allergy', 'meera@example.com']);
  assert.equal(validateStayRequest(req([person('Long', { preferences: 'x'.repeat(500) })]), TODAY, family).party[0].preferences.length, 300);
});

test('every new guest needs a WhatsApp mobile number, as in tent allocation; email is optional', () => {
  const ok = (p) => validateStayRequest(req([p]), TODAY, family).error;
  assert.equal(ok(person('A')), undefined);
  assert.match(ok(person('A', { mobileNumber: '', email: 'a@example.com' })), /WhatsApp mobile number for A/);
  assert.match(ok(person('A', { mobileNumber: undefined, ageGroup: 'Child' })), /WhatsApp mobile number for A/);
  assert.match(ok(person('A', { mobileNumber: '123' })), /valid mobile/);
  assert.match(ok(person('A', { email: 'nope' })), /valid email/);
  assert.equal(ok(person('A', { email: '' })), undefined);
});

test('a request is refused for each way it can be wrong', () => {
  const bad = (people, over, available) => validateStayRequest(req(people, over), TODAY, family, available).error;
  assert.match(bad([]), /who is coming/);
  assert.match(bad([member('stranger')]), /not available to book for/);
  assert.match(bad([member('m1'), member('m1')]), /listed twice/);
  assert.match(bad([member('m1'), person('asha rao')]), /listed twice/);
  assert.match(bad([person(' ')]), /needs a name/);
  assert.match(bad([person('<img src=x onerror=alert(1)>')]), /cannot contain/);
  assert.match(bad([person('A'), person('B'), person('C')], {}, 2), /Only 2 places are free/);
  assert.match(bad([person('A')], {}, 0), /no room/);
  assert.match(bad([person('A')], { nights: 0 }), /nights/);
});

test('the note for Madhavan names everyone and carries no contact details', () => {
  const party = [{ name: 'Asha Rao', ageGroup: 'Adult', guest: false }, { name: 'Dev Rao', ageGroup: 'Child', guest: true }, { name: 'Meera Iyer', ageGroup: 'Adult', guest: true }];
  assert.equal(partyNote(party, ''), 'Needs tents. Party of 3: Asha Rao, Dev Rao (child) (paying guest), Meera Iyer (paying guest).');
  const reachable = partyNote([{ ...party[0], mobileNumber: '+919845012345' }], '');
  assert.match(reachable, /guest directory: search by name/);
  assert.equal(reachable.includes('9845'), false);
  assert.match(partyNote(party, 'late arrival'), /Note: late arrival$/);
  // food needs for a stay change after booking, so they live on the people, not in this fixed text
  assert.equal(partyNote([{ ...party[0], stayRequirements: 'no onions' }], '').includes('onions'), false);
});

test('cancelling is allowed only before check-in', () => {
  assert.equal(canCancelStay('2026-10-22', TODAY), true);
  assert.equal(canCancelStay('2026-10-21', TODAY), false);
  assert.equal(canCancelStay('2026-10-01', TODAY), false);
});
