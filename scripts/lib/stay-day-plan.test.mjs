// Run with: node --test scripts/lib/stay-day-plan.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDayPlan, planToTemplateParams, planToMessageText, tentsLabel } from './stay-day-plan.mjs';

const labels = new Map([['T1', 'Banyan'], ['T2', 'Neem'], ['T3', 'Jamun']]);
const guest = (name, preferences) => ({ personId: name, name, ageGroup: 'Adult', preferences });
const booking = (id, startDate, nights, tents, extra = {}) => ({ id, type: 'casual-stay', startDate, nights, tents, ...extra });

const bookings = [
  booking('a', '2026-11-05', 3, [{ tentId: 'T1', guests: [guest('Rao'), guest('Meera'), guest('Kid'), guest('Kiran')] }]), // 5-8
  booking('b', '2026-11-06', 3, [{ tentId: 'T3', guests: [guest('Asha', 'Nut allergy'), guest('Dev')] }], { note: 'Arrives after 8 pm' }), // 6-9
  booking('c', '2026-11-04', 2, [{ tentId: 'T2', guests: [guest('Menon'), guest('Mrs Menon')] }]), // 4-6
  booking('d', '2026-11-06', 2, [{ tentId: 'T2', guests: [] }], { type: 'unit-closure' }), // closure: never counted
];

test('arrivals, departures and meal counts on a busy day', () => {
  const plan = buildDayPlan(bookings, '2026-11-06', labels);
  assert.deepEqual(plan.arriving.map((a) => [a.who, a.guests, a.tents]), [['Asha', 2, ['Jamun']]]);
  assert.deepEqual(plan.leaving.map((a) => [a.who, a.guests]), [['Menon', 2]]);
  // Breakfast: the Rao party (slept 5th) and the Menons (leaving after breakfast); Asha has not arrived yet.
  assert.equal(plan.breakfast, 6);
  // Dinner: the Raos and Asha's party; the Menons are gone.
  assert.equal(plan.dinner, 6);
});

test('food needs and notes cover everyone on the farm that day', () => {
  const plan = buildDayPlan(bookings, '2026-11-06', labels);
  assert.deepEqual(plan.food, [{ who: 'Asha', need: 'Nut allergy' }]);
  assert.deepEqual(plan.notes, [{ who: 'Asha', note: 'Arrives after 8 pm' }]);
});

test('the check-out day is not a night, so a leaver is not counted for dinner', () => {
  const plan = buildDayPlan(bookings, '2026-11-08', labels);
  assert.deepEqual(plan.leaving.map((a) => a.who), ['Rao']);
  assert.equal(plan.dinner, 2); // only Asha's party is left
  assert.equal(plan.breakfast, 6);
});

test('a day with nobody on the farm is quiet', () => {
  assert.equal(buildDayPlan(bookings, '2026-11-20', labels).quiet, true);
  assert.equal(buildDayPlan(bookings, '2026-11-06', labels).quiet, false);
});

test('a stay across a month boundary still leaves on its check-out day', () => {
  const plan = buildDayPlan([booking('e', '2026-10-30', 2, [{ tentId: 'T1', guests: [guest('Lee')] }])], '2026-11-01', labels);
  assert.deepEqual(plan.leaving.map((a) => a.who), ['Lee']);
});

test('template values are single lines and never empty', () => {
  const params = planToTemplateParams(buildDayPlan(bookings, '2026-11-06', labels), 'Friday, 6 November 2026');
  assert.equal(params.length, 5);
  assert.deepEqual(params, [
    'Friday, 6 November 2026',
    'Asha (2 guests, Jamun)',
    'Menon (2 guests, Neem)',
    'Breakfast 6, dinner 6',
    'Asha: Nut allergy; Asha: Arrives after 8 pm',
  ]);
  for (const p of params) assert.doesNotMatch(p, /[\n\t]/);
  const empty = planToTemplateParams(buildDayPlan([], '2026-11-20', labels), 'x');
  assert.deepEqual(empty.slice(1), ['Nobody', 'Nobody', 'Breakfast 0, dinner 0', 'None']);
});

test('guests already on the farm are "staying through", with when they leave', () => {
  const plan = buildDayPlan(bookings, '2026-11-06', labels);
  assert.deepEqual(plan.staying.map((a) => [a.who, a.until]), [['Rao', '2026-11-08']]);
  // Arrivals and leavers are not also "staying".
  assert.equal(plan.staying.some((a) => a.who === 'Asha' || a.who === 'Menon'), false);
});

test('each entry carries its booking note', () => {
  const plan = buildDayPlan(bookings, '2026-11-06', labels);
  assert.equal(plan.arriving[0].note, 'Arrives after 8 pm');
  assert.equal(plan.leaving[0].note, '');
});

test('the pasteable message lists check-ins, check-outs, meals, food and notes', () => {
  const text = planToMessageText(buildDayPlan(bookings, '2026-11-06', labels), 'Fri 6 Nov');
  assert.equal(text, [
    'Stays plan, Fri 6 Nov',
    '',
    'Check-ins: Jamun Asha (2 guests)',
    'Check-outs: Neem Menon (2 guests)',
    'Breakfast: 6. Dinner: 6.',
    'Food: Asha - Nut allergy',
    'Notes: Asha - Arrives after 8 pm',
  ].join('\n'));
});

test('a quiet day still gives a valid message', () => {
  const text = planToMessageText(buildDayPlan([], '2026-11-20', labels), 'Fri 20 Nov');
  assert.equal(text, ['Stays plan, Fri 20 Nov', '', 'Check-ins: none', 'Check-outs: none', 'Breakfast: 0. Dinner: 0.'].join('\n'));
});

test('a booking over many tents is a count, not a wall of names', () => {
  assert.equal(tentsLabel(['Banyan']), 'Banyan');
  assert.equal(tentsLabel(['Banyan', 'Neem']), 'Banyan and Neem');
  assert.equal(tentsLabel(['A', 'B', 'C', 'D', 'E', 'F', 'G']), '7 tents');
  const farm = [booking('e', '2026-11-10', 1, ['T1', 'T2', 'T3'].map((tentId) => ({ tentId, guests: [guest(tentId)] })), { type: 'public-event', eventTitle: 'Foraging Day' })];
  const plan = buildDayPlan(farm, '2026-11-10', new Map());
  assert.equal(planToMessageText(plan, 'x').split('\n')[2], 'Check-ins: 3 tents Foraging Day (3 guests)');
  assert.equal(planToTemplateParams(plan, 'x')[1], 'Foraging Day (3 guests, 3 tents)');
});

test('the same guest with the same food note on two tents is listed once', () => {
  const twice = [booking('f', '2026-11-10', 1, [
    { tentId: 'T1', guests: [guest('Arthi', '2 kids above 10')] },
    { tentId: 'T2', guests: [guest('Arthi', '2 kids above 10'), guest('Arthi', 'Vegan')] },
  ])];
  assert.deepEqual(buildDayPlan(twice, '2026-11-10', labels).food, [
    { who: 'Arthi', need: '2 kids above 10' },
    { who: 'Arthi', need: 'Vegan' },
  ]);
});
