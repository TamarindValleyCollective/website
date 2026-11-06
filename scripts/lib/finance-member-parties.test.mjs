// Run with: node --test scripts/lib/finance-member-parties.test.mjs
// The member backfill's plan. Every name here is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAnswers, planMemberParties, summarise } from './finance-member-parties.mjs';

const person = (id, name, households = ['h1'], active = true) => ({ id, name, active, householdIds: households });
const party = (id, name, kind = 'member', over = {}) => ({ id, name, kind, active: true, householdId: null, personId: null, ...over });

test('a person with no party gets one, linked to their household', () => {
  const plan = planMemberParties({ people: [person('p1', 'Test Person One')], parties: [] });
  assert.deepEqual(plan.create, [{ personId: 'p1', name: 'Test Person One', householdId: 'h1' }]);
});

test('an existing member party with the same name is linked, not duplicated (case, punctuation and spacing ignored)', () => {
  const plan = planMemberParties({ people: [person('p1', 'Test  Person-One')], parties: [party('x1', 'test person one')] });
  assert.equal(plan.create.length, 0);
  assert.deepEqual(plan.link, [{ partyId: 'x1', personId: 'p1', householdId: 'h1' }]);
});

test('a same-named party of another kind is left alone and listed', () => {
  const plan = planMemberParties({ people: [person('p1', 'Test Person One')], parties: [party('x1', 'Test Person One', 'vendor')] });
  assert.equal(plan.create.length, 0);
  assert.equal(plan.link.length, 0);
  assert.equal(plan.otherKind.length, 1);
});

test('two people with the same name, or two parties with the same name, are never guessed', () => {
  const twoPeople = planMemberParties({ people: [person('p1', 'Test Person One'), person('p2', 'test person one', ['h2'])], parties: [] });
  assert.equal(twoPeople.create.length, 0);
  assert.equal(twoPeople.sameNamePeople.length, 2);
  const twoParties = planMemberParties({ people: [person('p1', 'Test Person One')], parties: [party('x1', 'Test Person One'), party('x2', 'Test Person One')] });
  assert.equal(twoParties.link.length, 0);
  assert.equal(twoParties.sameNameParties.length, 1);
});

test('a person who already has a party is left alone; running the plan again changes nothing', () => {
  const people = [person('p1', 'Test Person One')];
  const first = planMemberParties({ people, parties: [] });
  assert.equal(first.create.length, 1);
  const after = [party('new1', 'Test Person One', 'member', { personId: 'p1', householdId: 'h1' })];
  const second = planMemberParties({ people, parties: after });
  assert.equal(second.create.length, 0);
  assert.equal(second.link.length, 0);
  assert.equal(second.alreadyLinked.length, 1);
});

test('inactive people are skipped unless asked for; people without or with two households are listed', () => {
  const people = [person('p1', 'Test Person One', ['h1'], false), person('p2', 'Test Person Two', []), person('p3', 'Test Person Three', ['h1', 'h2'])];
  const plan = planMemberParties({ people, parties: [] });
  assert.equal(plan.skippedInactive.length, 1);
  assert.equal(plan.noHousehold.length, 1);
  assert.equal(plan.twoHouseholds.length, 1);
  assert.equal(plan.create.length, 2); // the person without a household still gets a party (no unit to suggest)
  assert.equal(planMemberParties({ people, parties: [], includeInactive: true }).create.length, 3);
});

test('member parties that match nobody are listed for a person to decide, and the summary is counts only', () => {
  const plan = planMemberParties({ people: [person('p1', 'Test Person One')], parties: [party('x9', 'Somebody Else')] });
  assert.equal(plan.unmatchedMemberParties.length, 1);
  const counts = summarise(plan);
  assert.equal(counts.create, 1);
  assert.ok(Object.values(counts).every((v) => typeof v === 'number'));
});

test('a person\'s answer links a party to a person whatever they are called, and beats a name match', () => {
  const people = [person('p1', 'Test Person One'), person('p2', 'Test Second', ['h2']), person('p3', 'Test Second Other', ['h3'])];
  const parties = [party('x1', 'TEST PERSON ONE FULL NAME'), party('x2', 'Test Label')];
  const plan = planMemberParties({ people, parties, answers: [{ partyName: 'test person one full name', personName: 'Test Person One' }, { partyName: 'Test Label', personName: 'Test Second' }] });
  assert.deepEqual(plan.link.map((l) => [l.partyId, l.personId, l.householdId]), [['x1', 'p1', 'h1'], ['x2', 'p2', 'h2']]);
  assert.deepEqual(plan.create.map((c) => c.personId), ['p3']);
  assert.equal(plan.unmatchedMemberParties.length, 0);
  assert.equal(plan.badAnswers.length, 0);
});

test('an answer that names nobody, or somebody twice, is reported and does nothing', () => {
  const people = [person('p1', 'Test Person One'), person('p2', 'Test Person One', ['h2'])];
  const parties = [party('x1', 'Test Label')];
  const plan = planMemberParties({ people, parties, answers: [{ partyName: 'Test Label', personName: 'Test Person One' }, { partyName: 'Nobody Here', personName: 'Test Person One' }, { partyName: 'Test Label', personName: 'Not A Person' }] });
  assert.equal(plan.badAnswers.length, 3);
  assert.equal(plan.link.length, 0);
});

test('answers are read from "party,person" lines, with or without a header and quotes', () => {
  assert.deepEqual(parseAnswers('party name,person name\n"A, B",C D\nE F,G H\n\n'), [{ partyName: 'A, B', personName: 'C D' }, { partyName: 'E F', personName: 'G H' }]);
  assert.deepEqual(parseAnswers(''), []);
});

import { applyMemberPlan } from './finance-member-parties.mjs';
test('applying goes row by row: one failure stops nothing, a row already there is not an error, and a canary limits each kind', async () => {
  const plan = { link: [{ partyId: 'x1', personId: 'p1' }, { partyId: 'x2', personId: 'p2' }], create: [{ personId: 'p3' }, { personId: 'p4' }, { personId: 'p5' }] };
  const calls = [];
  const io = {
    link: async (r) => (calls.push(['link', r.partyId]), r.partyId === 'x2' ? 'skipped' : 'linked'),
    create: async (r) => {
      calls.push(['create', r.personId]);
      if (r.personId === 'p4') throw new Error('boom');
      return r.personId === 'p5' ? 'exists' : 'created';
    },
  };
  assert.deepEqual(await applyMemberPlan(plan, io), { created: 1, linked: 1, alreadyThere: 2, failed: 1 });
  assert.equal(calls.length, 5);
  calls.length = 0;
  const small = await applyMemberPlan(plan, io, { canary: 1 });
  assert.equal(calls.length, 2); // one link and one create
  assert.deepEqual(small, { created: 1, linked: 1, alreadyThere: 0, failed: 0 });
});
