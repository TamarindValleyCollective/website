// Run with: node --test scripts/lib/stay-tent-sheet.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { canWriteBooking, tentGuests, otherTentIds, stayState, stayStatus, guestsProblem, datesProblem, buildUpdatePayload, freeTentsFor } from './stay-tent-sheet.mjs';

const units = [
  { id: 'T1', label: 'Banyan', capacity: 3, kind: 'fixed', manager: 'tvc', status: 'rentable' },
  { id: 'T2', label: 'Neem', capacity: 2, kind: 'fixed', manager: 'tvc', status: 'rentable' },
  { id: 'T3', label: 'Own Tent', capacity: 3, kind: 'byot', manager: 'tvc', status: 'rentable' },
  { id: 'T4', label: 'Jamun', capacity: 1, kind: 'fixed', manager: 'tvc', status: 'rentable' },
  { id: 'M1', label: 'Member Home', capacity: 4, kind: 'fixed', manager: 'member', status: 'rentable' },
];
const guest = (name, extra = {}) => ({ personId: `p-${name}`, name, ageGroup: 'Adult', gender: 'Female', hasMobile: true, ...extra });
const booking = (extra = {}) => ({
  id: 'b1', type: 'casual-stay', startDate: '2026-11-06', nights: 3, label: undefined, note: 'Late arrival',
  tents: [{ tentId: 'T1', solo: false, guests: [guest('Asha', { preferences: 'Nut allergy' }), guest('Dev', { ageGroup: 'Child', gender: 'Male' })] }, { tentId: 'T2', solo: true, guests: [guest('Ravi')] }],
  ...extra,
});

test('who may change a booking', () => {
  assert.equal(canWriteBooking('admin', null, 'casual-stay'), true);
  assert.equal(canWriteBooking('restricted', ['public-event'], 'public-event'), true);
  assert.equal(canWriteBooking('restricted', ['public-event'], 'casual-stay'), false);
  assert.equal(canWriteBooking('viewer', [], 'casual-stay'), false);
});

test('one tent of a booking: its guests and the other tents', () => {
  assert.deepEqual(tentGuests(booking(), 'T1').map((g) => g.name), ['Asha', 'Dev']);
  assert.deepEqual(tentGuests(booking(), 'T9'), []);
  assert.deepEqual(otherTentIds(booking(), 'T1'), ['T2']);
});

test('the stay on a day: arriving, staying until, or leaving', () => {
  const b = booking();
  assert.deepEqual(stayState(b, '2026-11-06'), { k: 'arriving', until: '2026-11-09' });
  assert.deepEqual(stayState(b, '2026-11-07'), { k: 'staying', until: '2026-11-09' });
  assert.deepEqual(stayState(b, '2026-11-09'), { k: 'leaving', until: '2026-11-09' });
});

test('guests: a name, a mobile for a new one, capacity, and the family rule', () => {
  const u = { label: 'Neem', capacity: 2 };
  assert.equal(guestsProblem([guest('Ravi')], u, false), null);
  assert.equal(guestsProblem([guest('A'), guest('B'), guest('C')], u, false), 'Neem holds at most 2.');
  assert.match(guestsProblem([guest('A'), guest('B')], u, true), /family booking/);
  assert.equal(guestsProblem([{ name: ' ' }], u, false), 'Every guest needs a name.');
  assert.equal(guestsProblem([{ name: 'Meera' }], u, false), 'Meera needs a mobile number.');
  assert.equal(guestsProblem([{ name: 'Meera', mobileNumber: '98450 12345' }], u, false), null);
  assert.equal(guestsProblem([], u, true), null); // taking everyone out is allowed
});

test('dates', () => {
  assert.equal(datesProblem('', 2), 'Choose the check-in day.');
  assert.equal(datesProblem('2026-11-06', 0), 'Check-out must be after check-in.');
  assert.equal(datesProblem('2026-11-06', 2), null);
});

test('payload: changing one tent\'s guests carries every other tent and the booking\'s own fields across', () => {
  const b = booking({ type: 'private-event', exclusive: true, label: 'Retreat' });
  const p = buildUpdatePayload(b, { kind: 'guests', tentId: 'T2', guests: [guest('Ravi'), { name: 'Meera', mobileNumber: '98450 12345', ageGroup: 'Child' }] }, { units });
  assert.equal(p.id, 'b1');
  assert.equal(p.type, 'private-event');
  assert.equal(p.exclusive, true);
  assert.equal(p.label, 'Retreat');
  assert.equal(p.note, 'Late arrival');
  assert.deepEqual(p.tents[0].guests.map((g) => g.name), ['Asha', 'Dev']); // T1 untouched
  assert.deepEqual(p.tents[1].guests.map((g) => [g.name, g.personId ?? null, g.mobileNumber ?? null]), [['Ravi', 'p-Ravi', null], ['Meera', null, '98450 12345']]);
});

test('payload: an existing guest is sent by personId with no contact details, and gets safe defaults', () => {
  const p = buildUpdatePayload(booking(), { kind: 'dates', startDate: '2026-11-07', nights: 2 });
  const asha = p.tents[0].guests[0];
  assert.deepEqual(asha, { personId: 'p-Asha', name: 'Asha', ageGroup: 'Adult', gender: 'Female', preferences: 'Nut allergy', mobileNumber: undefined });
  const noGender = buildUpdatePayload(booking({ tents: [{ tentId: 'T1', solo: false, guests: [{ personId: 'p', name: 'X' }] }] }), { kind: 'dates', startDate: '2026-11-07', nights: 1 });
  assert.equal(noGender.tents[0].guests[0].gender, 'NA');
  assert.equal(noGender.tents[0].guests[0].ageGroup, 'Adult');
});

test('payload: new dates change only the dates', () => {
  const p = buildUpdatePayload(booking(), { kind: 'dates', startDate: '2026-11-08', nights: 4 }, { reason: ' Guest asked ' });
  assert.deepEqual([p.startDate, p.nights, p.reason], ['2026-11-08', 4, 'Guest asked']);
  assert.deepEqual(p.tents.map((t) => t.tentId), ['T1', 'T2']);
});

test('payload: moving a tent swaps the tent id and keeps its guests; a BYOT slot cannot be a family booking', () => {
  const p = buildUpdatePayload(booking(), { kind: 'move', from: 'T2', to: 'T4' }, { units });
  assert.deepEqual(p.tents.map((t) => [t.tentId, t.solo, t.guests.length]), [['T1', false, 2], ['T4', true, 1]]);
  const byot = buildUpdatePayload(booking(), { kind: 'move', from: 'T2', to: 'T3' }, { units });
  assert.equal(byot.tents[1].solo, false);
});

test('payload: removing a tent leaves the rest', () => {
  assert.deepEqual(buildUpdatePayload(booking(), { kind: 'removeTent', tentId: 'T1' }).tents.map((t) => t.tentId), ['T2']);
});

test('payload: a closure and a whole-farm closure round-trip', () => {
  const closure = { id: 'c', type: 'unit-closure', startDate: '2026-11-10', nights: 2, label: 'Roof repair', tents: [{ tentId: 'T1', guests: [] }] };
  const p = buildUpdatePayload(closure, { kind: 'dates', startDate: '2026-11-11', nights: 3 });
  assert.deepEqual([p.type, p.label, p.startDate, p.tents.map((t) => t.tentId)], ['unit-closure', 'Roof repair', '2026-11-11', ['T1']]);
  const farm = { id: 'f', type: 'farm-closure', startDate: '2026-12-01', nights: 2, tents: [], note: 'Farm on Vacation', label: 'Farm on Vacation' };
  assert.deepEqual(buildUpdatePayload(farm, { kind: 'dates', startDate: '2026-12-02', nights: 2 }).tents, []);
});

test('moving: only tents free on every night, that fit the guests, not member-run, not already in the booking', () => {
  const others = [{ id: 'x', type: 'casual-stay', startDate: '2026-11-07', nights: 1, tents: [{ tentId: 'T4', guests: [] }] }];
  const b = booking({ tents: [{ tentId: 'T1', solo: false, guests: [guest('A'), guest('B')] }] });
  // T2 fits 2, T3 fits 3, T4 holds 1 (too small, and taken), M1 is member-run
  assert.deepEqual(freeTentsFor({ units, bookings: [...others, b], booking: b, tentId: 'T1' }).map((u) => u.id), ['T2', 'T3']);
  // the booking's own tent is never offered, and a tent it already has is not either
  const two = booking();
  assert.equal(freeTentsFor({ units, bookings: [two], booking: two, tentId: 'T1' }).some((u) => u.id === 'T1' || u.id === 'T2'), false);
});

test('the status says "today" only when it is today, and uses a date or the past tense otherwise', () => {
  const b = booking(); // 6 Nov for 3 nights, leaves 9 Nov
  const f = (d) => `<${d.slice(5)}>`;
  assert.equal(stayStatus(b, '2026-11-06', '2026-11-06', f), 'Arriving today');
  assert.equal(stayStatus(b, '2026-11-06', '2026-11-01', f), 'Arriving <11-06>'); // a future day
  assert.equal(stayStatus(b, '2026-11-06', '2026-11-20', f), 'Arrived <11-06>'); // a day gone by
  assert.equal(stayStatus(b, '2026-11-09', '2026-11-09', f), 'Leaving today');
  assert.equal(stayStatus(b, '2026-11-09', '2026-11-05', f), 'Leaving <11-09>');
  assert.equal(stayStatus(b, '2026-11-09', '2026-11-20', f), 'Left <11-09>');
  assert.equal(stayStatus(b, '2026-11-07', '2026-11-07', f), 'Staying until <11-09>');
  assert.equal(stayStatus(b, '2026-11-07', '2026-11-20', f), 'Stayed until <11-09>'); // the whole stay is behind us
  assert.equal(stayStatus(b, '2026-11-07', '2026-11-08', f), 'Staying until <11-09>'); // still under way
});
