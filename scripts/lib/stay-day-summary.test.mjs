// Run with: node --test scripts/lib/stay-day-summary.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { deidentify, buildAiFacts, cleanSummary, summariseDay, buildUserText, summaryDateProblem } from './stay-day-summary.mjs';

const labels = new Map([['T1', 'Banyan'], ['T2', 'Neem'], ['T3', 'Jamun']]);
const guest = (name, preferences) => ({ personId: name, name, ageGroup: 'Adult', preferences, mobileNumber: '+91 98450 12345', email: `${name}@example.com` });
const booking = (id, startDate, nights, tents, extra = {}) => ({ id, type: 'casual-stay', startDate, nights, tents, ...extra });

test('names, emails and phone numbers are taken out of free text', () => {
  const out = deidentify('Subbu cannot eat wheat. Call Subbu on 98450 12345 or subbu@mail.com. Madhuri is vegan', ['Subbu K', 'Madhuri']);
  assert.equal(out, 'the guest cannot eat wheat. Call the guest on [removed] or [removed]. the guest is vegan');
});

test('a name only matches as a whole word, and very short names are left alone', () => {
  assert.equal(deidentify('Rao family likes Raoul', ['Rao']), 'the guest family likes Raoul');
  assert.equal(deidentify('Om is at 5 pm', ['Om']), 'Om is at 5 pm');
});

test('the facts carry no names, numbers or emails', () => {
  const bookings = [
    booking('a', '2026-11-06', 2, [{ tentId: 'T3', guests: [guest('Asha Rao', 'Nut allergy, ask Asha'), guest('Dev Rao')] }], { label: 'Rao family', note: 'Asha arrives after 8 pm' }),
    booking('e', '2026-11-06', 1, [{ tentId: 'T1', guests: [guest('Kartik', '2ad, 2 kids under 10')] }, { tentId: 'T2', guests: [guest('Janani')] }], { type: 'public-event', eventTitle: 'Foraging Day', label: 'Kartik group' }),
  ];
  const facts = buildAiFacts(bookings, '2026-11-06', labels, 'Friday, 6 November 2026');
  const json = JSON.stringify(facts);
  for (const secret of ['Asha', 'Dev', 'Rao', 'Kartik', 'Janani', '98450', '@example.com']) assert.equal(json.includes(secret), false, `${secret} leaked: ${json}`);
  assert.equal(facts.breakfastCount, 0);
  assert.equal(facts.dinnerCount, 4);
  const stay = facts.checkIns.find((c) => c.kind === 'guest stay');
  assert.deepEqual(stay, { kind: 'guest stay', guests: 2, tents: 'Jamun', note: 'the guest arrives after 8 pm', dietaryNotes: ['Nut allergy, ask the guest'] });
  const event = facts.checkIns.find((c) => c.kind === 'public event');
  assert.equal(event.title, 'Foraging Day'); // the public event's own title is not personal
  assert.equal(event.tents, 'Banyan and Neem');
});

test('a private booking never gets its label sent as a title', () => {
  const b = [booking('p', '2026-11-06', 1, [{ tentId: 'T1', guests: [guest('Meera')] }], { type: 'private-event', label: "Meera's birthday" })];
  const json = JSON.stringify(buildAiFacts(b, '2026-11-06', labels, 'x'));
  assert.equal(json.includes('Meera'), false);
  assert.match(json, /private event/);
});

test('a quiet day has no facts, so nothing is ever sent', () => {
  assert.equal(buildAiFacts([], '2026-11-20', labels, 'x'), null);
});

test('the summary is plain text of limited length', () => {
  assert.equal(cleanSummary('**Check-ins:** 2\n\n\n# Heads up\n* one\n* two'), 'Check-ins: 2\n\nHeads up\n- one\n- two');
  assert.ok(cleanSummary('x'.repeat(2000)).length <= 900);
});

const facts = { date: 'Friday, 6 November 2026', checkIns: [], checkOuts: [], stayingThrough: [], breakfastCount: 2, dinnerCount: 2 };
const makeDeps = (over = {}) => {
  const cache = new Map();
  const calls = [];
  return { cache, calls, deps: { hash: (s) => s, cacheGet: async (k) => cache.get(k) ?? null, cacheSet: async (k, v) => void cache.set(k, v), allow: async () => true, callModel: async (sys, user) => (calls.push({ sys, user }), '**Two** guests'), ...over } };
};

test('an unchanged day is asked once, then served from the cache', async () => {
  const { deps, calls } = makeDeps();
  assert.deepEqual(await summariseDay(facts, deps), { summary: 'Two guests', cached: false });
  assert.deepEqual(await summariseDay(facts, deps), { summary: 'Two guests', cached: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].user, buildUserText(facts));
});

test('a changed day is asked again', async () => {
  const { deps, calls } = makeDeps();
  await summariseDay(facts, deps);
  await summariseDay({ ...facts, dinnerCount: 9 }, deps);
  assert.equal(calls.length, 2);
});

test('every failure becomes "no summary" rather than an error', async () => {
  assert.deepEqual(await summariseDay(null, makeDeps().deps), { summary: null, reason: 'quiet' });
  assert.deepEqual(await summariseDay(facts, makeDeps({ allow: async () => false }).deps), { summary: null, reason: 'limit' });
  assert.deepEqual(await summariseDay(facts, makeDeps({ callModel: async () => null }).deps), { summary: null, reason: 'unavailable' });
  assert.deepEqual(await summariseDay(facts, makeDeps({ cacheGet: async () => { throw new Error('blobs down'); } }).deps), { summary: 'Two guests', cached: false });
});

test('a limited day never reaches the model', async () => {
  const { deps, calls } = makeDeps({ allow: async () => false });
  await summariseDay(facts, deps);
  assert.equal(calls.length, 0);
});

test('a day whose bookings list no guests is treated as nobody here', () => {
  const noGuests = [booking('x', '2026-11-06', 2, [{ tentId: 'T1', guests: [] }], { type: 'public-event', eventTitle: 'Open house' })];
  assert.equal(buildAiFacts(noGuests, '2026-11-06', labels, 'x'), null);
  // A tent closure is never "someone".
  const closure = [booking('c', '2026-11-06', 2, [{ tentId: 'T1', guests: [guest('A')] }], { type: 'unit-closure' })];
  assert.equal(buildAiFacts(closure, '2026-11-06', labels, 'x'), null);
});

test('only today and the days ahead (up to two months) can be summarised', () => {
  assert.equal(summaryDateProblem('2026-11-05', '2026-11-06'), 'past');
  assert.equal(summaryDateProblem('2026-11-06', '2026-11-06'), null);
  assert.equal(summaryDateProblem('2026-11-07', '2026-11-06'), null);
  assert.equal(summaryDateProblem('2027-01-06', '2026-11-06'), null);
  assert.equal(summaryDateProblem('2027-01-08', '2026-11-06'), 'too-far');
});

test('writing it again skips the cache and replaces the cached text', async () => {
  let n = 0;
  const { deps, cache } = makeDeps({ callModel: async () => `version ${++n}` });
  assert.equal((await summariseDay(facts, deps)).summary, 'version 1');
  assert.equal((await summariseDay(facts, deps)).summary, 'version 1'); // cached
  assert.deepEqual(await summariseDay(facts, deps, { refresh: true }), { summary: 'version 2', cached: false });
  assert.equal((await summariseDay(facts, deps)).summary, 'version 2'); // everyone now sees the new one
  assert.equal(n, 2);
  assert.equal(cache.size, 1);
});
