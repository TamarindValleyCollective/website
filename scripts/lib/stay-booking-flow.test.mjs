// Run with: node --test scripts/lib/stay-booking-flow.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { nightsOf, nightsBetween, bookableUnits, bookingType, allowedKinds, unitAvailability, stepProblem, buildPayload } from './stay-booking-flow.mjs';

const units = [
  { id: 'T1', label: 'Banyan', capacity: 3, kind: 'fixed', manager: 'tvc', status: 'rentable' },
  { id: 'T2', label: 'Neem', capacity: 2, kind: 'fixed', manager: 'tvc', status: 'rentable' },
  { id: 'T3', label: 'Own Tent', capacity: 3, kind: 'byot', manager: 'tvc', status: 'rentable' },
  { id: 'M1', label: 'Member Home', capacity: 4, kind: 'fixed', manager: 'member', status: 'rentable' },
  { id: 'K1', label: 'Common Kitchen', capacity: 0, kind: 'fixed', manager: 'tvc', status: 'rentable', ignoresFarmClosure: true },
  { id: 'O1', label: 'Old Hut', capacity: 2, kind: 'fixed', manager: 'tvc', status: 'offboarded' },
];
const ctx = { units, today: '2026-11-01' };
const base = () => ({ kind: 'guests', memberStay: false, member: '', eventMode: undefined, eventSlug: '', eventTitle: '', label: '', exclusive: false, wholeFarm: false,
  reason: '', startDate: '2026-11-06', nights: 3, tentIds: ['T1'], guests: [{ tentId: 'T1', name: 'Asha Rao', mobileNumber: '98450 12345', ageGroup: 'Adult', gender: 'NA' }], family: false, note: '' });
const booking = (id, type, startDate, nights, tentIds, extra = {}) => ({ id, type, startDate, nights, tents: tentIds.map((tentId) => ({ tentId, guests: [] })), ...extra });

test('dates: nights of a stay and nights between two days', () => {
  assert.deepEqual(nightsOf('2026-11-29', 3), ['2026-11-29', '2026-11-30', '2026-12-01']);
  assert.equal(nightsBetween('2026-11-06', '2026-11-09'), 3);
  assert.equal(nightsBetween('2026-11-09', '2026-11-06'), 0);
  assert.equal(nightsBetween('2026-11-06', '2026-11-06'), 0);
});

test('member-run and offboarded units cannot be booked by staff', () => {
  assert.deepEqual(bookableUnits(units).map((u) => u.id), ['T1', 'T2', 'T3', 'K1']);
});

test('the answers decide the booking type', () => {
  assert.equal(bookingType({ kind: 'guests' }), 'casual-stay');
  assert.equal(bookingType({ kind: 'guests', memberStay: true }), 'member-stay');
  assert.equal(bookingType({ kind: 'event', eventMode: 'public' }), 'public-event');
  assert.equal(bookingType({ kind: 'event', eventMode: 'private' }), 'private-event');
  assert.equal(bookingType({ kind: 'block' }), 'unit-closure');
  assert.equal(bookingType({ kind: 'block', wholeFarm: true }), 'farm-closure');
  assert.equal(bookingType({ kind: null }), null);
});

test('a restricted role only gets the starting choices its booking types allow', () => {
  assert.deepEqual(allowedKinds(null), { guests: true, memberStay: true, casualStay: true, event: true, publicEvent: true, privateEvent: true, block: true });
  const k = allowedKinds(['public-event']);
  assert.equal(k.event, true);
  assert.equal(k.guests, false);
  assert.equal(k.block, false);
  assert.equal(k.privateEvent, false);
});

test('a tent is taken when another booking holds it on any night of the stay', () => {
  const bookings = [booking('a', 'casual-stay', '2026-11-05', 2, ['T1'], { label: 'Rao family' }), booking('c', 'unit-closure', '2026-11-08', 1, ['T2'], { label: 'Roof repair' })];
  const free = (start, nights) => unitAvailability({ units, bookings, startDate: start, nights });
  assert.deepEqual(free('2026-11-06', 3).get('T1'), { reason: 'booked', by: 'Rao family' }); // 5th and 6th are Rao's; the 6th overlaps
  assert.equal(free('2026-11-07', 1).get('T1'), null); // Rao leaves on the 7th, the night is free
  assert.deepEqual(free('2026-11-07', 3).get('T2'), { reason: 'booked', by: 'Roof repair' }); // a tent closure holds it too
  assert.equal(free('2026-11-06', 1).get('T2'), null);
});

test('a whole-farm closure shuts every unit except those set to stay open', () => {
  const bookings = [booking('f', 'farm-closure', '2026-11-10', 2, [], { note: 'Farm on Vacation' })];
  const a = unitAvailability({ units, bookings, startDate: '2026-11-11', nights: 1 });
  assert.deepEqual(a.get('T1'), { reason: 'closed', by: 'Farm on Vacation' });
  assert.equal(a.get('K1'), null);
  assert.equal(unitAvailability({ units, bookings, startDate: '2026-11-12', nights: 1 }).get('T1'), null);
});

test('step 1: what it is', () => {
  assert.equal(stepProblem({ ...base(), kind: null }, 1, ctx), 'Choose what this is.');
  assert.equal(stepProblem({ ...base(), kind: 'event' }, 1, ctx), 'Choose a public event or a private one.');
  assert.equal(stepProblem({ ...base(), memberStay: true }, 1, ctx), 'Choose which member is staying.');
  assert.equal(stepProblem(base(), 1, ctx), null);
  assert.match(stepProblem(base(), 1, { ...ctx, allowedTypes: ['public-event'] }), /not allowed/);
});

test('step 2: dates, never in the past', () => {
  assert.equal(stepProblem({ ...base(), startDate: '' }, 2, ctx), 'Choose the check-in day.');
  assert.match(stepProblem({ ...base(), nights: 0 }, 2, ctx), /check-out/);
  assert.match(stepProblem({ ...base(), startDate: '2026-10-30' }, 2, ctx), /past/);
  assert.equal(stepProblem(base(), 2, ctx), null);
  assert.equal(stepProblem({ ...base(), startDate: '2026-11-01' }, 2, ctx), null); // today is fine
});

test('step 3: tents, with the whole-farm cases needing none', () => {
  assert.equal(stepProblem({ ...base(), tentIds: [] }, 3, ctx), 'Choose at least one tent.');
  assert.match(stepProblem({ ...base(), kind: 'block', tentIds: [] }, 3, ctx), /whole farm/);
  assert.equal(stepProblem({ ...base(), kind: 'block', wholeFarm: true, tentIds: [] }, 3, ctx), null);
  assert.equal(stepProblem({ ...base(), kind: 'event', eventMode: 'private', exclusive: true, tentIds: [] }, 3, ctx), null);
});

test('step 4: guests need a name, a mobile (unless already known), a tent in the booking, and to fit', () => {
  assert.equal(stepProblem(base(), 4, ctx), null);
  assert.equal(stepProblem({ ...base(), guests: [] }, 4, ctx), 'Add at least the lead guest.');
  const noMobile = { ...base(), guests: [{ tentId: 'T1', name: 'Asha' }] };
  assert.equal(stepProblem(noMobile, 4, ctx), 'Asha needs a mobile number.');
  // a returning guest picked from the directory has no number typed, and needs none
  assert.equal(stepProblem({ ...base(), guests: [{ tentId: 'T1', name: 'Asha', personId: 'p1' }] }, 4, ctx), null);
  assert.equal(stepProblem({ ...base(), guests: [{ tentId: 'T1', mobileNumber: '98450 12345' }] }, 4, ctx), 'Every guest needs a name.');
  assert.match(stepProblem({ ...base(), guests: [{ tentId: 'T9', name: 'Asha', mobileNumber: '9845012345' }] }, 4, ctx), /not in one of the chosen tents/);
  const crowded = { ...base(), tentIds: ['T2'], guests: ['A', 'B', 'C'].map((name) => ({ tentId: 'T2', name, mobileNumber: '9845012345' })) };
  assert.equal(stepProblem(crowded, 4, ctx), 'Neem holds at most 2.');
});

test('step 4: a family booking is one listed guest per tent, and not in a Bring Your Own Tent slot', () => {
  assert.equal(stepProblem({ ...base(), family: true }, 4, ctx), null);
  const two = { ...base(), family: true, guests: ['A', 'B'].map((name) => ({ tentId: 'T1', name, mobileNumber: '9845012345' })) };
  assert.match(stepProblem(two, 4, ctx), /one guest per tent/);
  const byot = { ...base(), family: true, tentIds: ['T3'], guests: [{ tentId: 'T3', name: 'A', mobileNumber: '9845012345' }] };
  assert.match(stepProblem(byot, 4, ctx), /Bring Your Own Tent/);
});

test('step 4: a closure needs a reason', () => {
  assert.equal(stepProblem({ ...base(), kind: 'block', reason: '' }, 4, ctx), 'Say why it is closed.');
  assert.equal(stepProblem({ ...base(), kind: 'block', reason: 'Roof repair' }, 4, ctx), null);
});

test('payload: a guest stay', () => {
  const p = buildPayload({ ...base(), note: ' arrives late ', guests: [{ tentId: 'T1', name: ' Asha Rao ', mobileNumber: '98450 12345', preferences: ' nut allergy ', email: '' }, { tentId: 'T1', name: 'Dev', mobileNumber: '98450 12345', ageGroup: 'Child', gender: 'Male' }] }, units);
  assert.deepEqual(p, {
    type: 'casual-stay', startDate: '2026-11-06', nights: 3, note: 'arrives late',
    tents: [{ tentId: 'T1', solo: false, guests: [
      { personId: undefined, name: 'Asha Rao', ageGroup: 'Adult', gender: 'NA', mobileNumber: '98450 12345', email: undefined, preferences: 'nut allergy' },
      { personId: undefined, name: 'Dev', ageGroup: 'Child', gender: 'Male', mobileNumber: '98450 12345', email: undefined, preferences: undefined },
    ] }],
  });
});

test('payload: guests are split across the chosen tents, and a blank row is dropped', () => {
  const s = { ...base(), tentIds: ['T1', 'T2'], guests: [{ tentId: 'T1', name: 'A', mobileNumber: '9845012345' }, { tentId: 'T2', name: 'B', mobileNumber: '9845012345' }, { tentId: 'T2', name: '' }] };
  const p = buildPayload(s, units);
  assert.deepEqual(p.tents.map((t) => [t.tentId, t.guests.map((g) => g.name)]), [['T1', ['A']], ['T2', ['B']]]);
});

test('payload: a family booking marks each single-guest tent solo, never a BYOT slot', () => {
  const fam = { ...base(), family: true, tentIds: ['T1', 'T3'], guests: [{ tentId: 'T1', name: 'A', mobileNumber: '9845012345' }, { tentId: 'T3', name: 'B', mobileNumber: '9845012345' }] };
  assert.deepEqual(buildPayload(fam, units).tents.map((t) => [t.tentId, t.solo]), [['T1', true], ['T3', false]]);
});

test('payload: a member stay carries the member as its label', () => {
  const p = buildPayload({ ...base(), memberStay: true, member: 'Priya Raman' }, units);
  assert.equal(p.type, 'member-stay');
  assert.equal(p.label, 'Priya Raman');
});

test('payload: a public event carries its slug and title, a private one its label and exclusivity', () => {
  const pub = buildPayload({ ...base(), kind: 'event', eventMode: 'public', eventSlug: 'foraging-day', eventTitle: 'Foraging Day', guests: [] }, units);
  assert.equal(pub.type, 'public-event');
  assert.equal(pub.eventSlug, 'foraging-day');
  assert.equal(pub.eventTitle, 'Foraging Day');
  assert.deepEqual(pub.tents[0].guests, []);
  const priv = buildPayload({ ...base(), kind: 'event', eventMode: 'private', label: 'Retreat', exclusive: true, guests: [] }, units);
  assert.equal(priv.type, 'private-event');
  assert.equal(priv.label, 'Retreat');
  assert.equal(priv.exclusive, true);
});

test('payload: closures', () => {
  assert.deepEqual(buildPayload({ ...base(), kind: 'block', reason: 'Roof repair', guests: [] }, units), { type: 'unit-closure', startDate: '2026-11-06', nights: 3, label: 'Roof repair', note: undefined, tents: [{ tentId: 'T1', solo: false, guests: [] }] });
  assert.deepEqual(buildPayload({ ...base(), kind: 'block', wholeFarm: true, reason: 'Farm on Vacation', tentIds: [] }, units), { type: 'farm-closure', startDate: '2026-11-06', nights: 3, tents: [], label: 'Farm on Vacation', note: 'Farm on Vacation' });
});
