// Run with: node --test scripts/lib/finance-party-suggestions.test.mjs
// Suggested changes on the Parties table. Every name here is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestChanges, sameName, nameWithin, niceName, postingStats } from './finance-party-suggestions.mjs';

const party = (id, name, extra = {}) => ({ id, name, kind: 'vendor', active: true, householdId: null, personId: null, accounts: [], stats: null, ...extra });
const acct = (verifiedName) => ({ verifiedName });
const stats = (over = {}) => ({ postings: 3, direction: 'debit', categoryName: 'Structures and infrastructure', categoryType: 'capex', categoryShare: 1, ...over });
const byType = (list, t) => list.filter((s) => s.type === t);

test('names match through a small spelling slip, a suffix or case, but never on short names', () => {
  assert.ok(sameName('Test Electricals', 'TEST ELECTRCIALS'));
  assert.ok(sameName('Green Nursery Pvt Ltd', 'green nursery'));
  assert.ok(!sameName('Ravi', 'Rani'));
  assert.ok(!sameName('Test Traders', 'Test Tractors'), 'a different word is not a slip');
  assert.ok(nameWithin('Sri Lakshmi Hardware', 'SRI LAKSHMI HARDWARE AND PAINTS'));
  assert.ok(!nameWithin('Ravi', 'Ravi Kumar Stores'), 'one word is too little to claim a longer name');
});

test('shouting names are made readable, normal ones are left alone', () => {
  assert.equal(niceName('MOHAN ELECTRICALS'), 'Mohan Electricals');
  assert.equal(niceName('Sri Lakshmi & Sons'), 'Sri Lakshmi & Sons');
  assert.equal(niceName('  T  N  '), 'T N');
});

test('two parties that are one payee are offered as a merge into the one holding the details', () => {
  const list = suggestChanges([
    party('a', 'Test Electricals', { kind: 'other' }),
    party('b', 'TEST ELECTRCIALS', { accounts: [acct('TEST ELECTRICALS')], stats: stats() }),
  ]);
  const merges = byType(list, 'merge');
  assert.equal(merges.length, 1);
  assert.deepEqual([merges[0].partyId, merges[0].targetId], ['a', 'b']);
  assert.match(merges[0].why, /bank showed “TEST ELECTRICALS”/);
  assert.equal(byType(list, 'rename').length, 0, 'the merged-away party gets nothing else');
});

test('members are never merged with each other, and a member linked to a household is never merged away', () => {
  assert.equal(suggestChanges([party('a', 'Asha Rao', { kind: 'member' }), party('b', 'Asha Rao', { kind: 'member' })]).length, 0);
  const linked = suggestChanges([party('a', 'Asha Rao', { kind: 'member', householdId: 'h1' }), party('b', 'Asha Rao', { kind: 'other' })]);
  assert.deepEqual(byType(linked, 'merge').map((m) => [m.partyId, m.targetId]), [['b', 'a']]);
});

test("a name the bank showed becomes a rename, unless the name is a member's or already taken", () => {
  const r = suggestChanges([party('a', 'Sri Lakshmi Hardware', { accounts: [acct('SRI LAKSHMI HARDWARE AND PAINTS')] })]);
  assert.deepEqual(byType(r, 'rename').map((x) => x.to), ['Sri Lakshmi Hardware and Paints']);
  const same = suggestChanges([party('a', 'Green Nursery', { accounts: [acct('GREEN NURSERY')] })]);
  assert.equal(same.length, 0, 'only the case differs from a shouted name: nothing to change');
  const member = suggestChanges([party('a', 'Asha R', { kind: 'member', personId: 'p', accounts: [acct('ASHA RAO')] })]);
  assert.equal(member.length, 0);
  const unrelated = suggestChanges([party('a', 'Green Nursery', { accounts: [acct('SOMEONE ELSE ENTIRELY')] })]);
  assert.equal(unrelated.length, 0, 'an unrelated bank name is a mistake to look at, not a rename');
});

test('Other becomes a kind only when most payments agree', () => {
  const k = (s) => byType(suggestChanges([party('a', 'Test Hardware', { kind: 'other', stats: s })]), 'kind')[0];
  assert.equal(k(stats())?.to, 'vendor');
  assert.equal(k(stats({ categoryName: 'Salaries', categoryType: 'opex' }))?.to, 'employee');
  assert.equal(k(stats({ direction: 'credit', categoryName: 'Event income', categoryType: 'revenue' }))?.to, 'customer');
  assert.equal(k(stats({ postings: 1 })), undefined, 'one payment is not a pattern');
  assert.equal(k(stats({ categoryShare: 0.5 })), undefined);
  assert.equal(k(null), undefined);
  assert.equal(byType(suggestChanges([party('a', 'Test Hardware', { kind: 'vendor', stats: stats() })]), 'kind').length, 0, 'only Other is touched');
});

test('merges come first, then renames, then kinds', () => {
  const list = suggestChanges([
    party('a', 'Test Electricals', { kind: 'other' }),
    party('b', 'TEST ELECTRCIALS', { accounts: [acct('TEST ELECTRICALS')] }),
    party('c', 'Sri Lakshmi Hardware', { accounts: [acct('SRI LAKSHMI HARDWARE AND PAINTS')] }),
    party('d', 'Hardware Two', { kind: 'other', stats: stats() }),
  ]);
  assert.deepEqual(list.map((s) => s.type), ['merge', 'rename', 'kind']);
});

test('posting stats count each party under its main party and take the dominant category', () => {
  const lines = [
    { id: 'l1', tran_date: '2026-09-01', direction: 'debit' },
    { id: 'l2', tran_date: '2026-10-05', direction: 'debit' },
    { id: 'l3', tran_date: '2026-10-09', direction: 'debit' },
    { id: 'l4', tran_date: '2026-10-20', direction: 'credit' },
  ];
  const cats = [{ id: 'c1', name: 'Repairs', type: 'opex' }, { id: 'c2', name: 'Equipment', type: 'capex' }, { id: 'c3', name: 'Event income', type: 'revenue' }];
  const allocations = [
    { bank_line_id: 'l1', party_id: 'dup', category_id: 'c1', amount_paise: 100000 },
    { bank_line_id: 'l2', party_id: 'main', category_id: 'c1', amount_paise: 250000 },
    { bank_line_id: 'l3', party_id: 'main', category_id: 'c2', amount_paise: 50000 },
    { bank_line_id: 'l4', party_id: 'main', category_id: 'c3', amount_paise: 999900 },
    { bank_line_id: 'gone', party_id: 'main', category_id: 'c1', amount_paise: 1 },
  ];
  const s = postingStats(allocations, lines, cats, new Map([['dup', 'main']])).get('main');
  assert.equal(s.paidPaise, 400000, 'receipts are not counted as paid');
  assert.equal(s.receivedPaise, 999900, 'and what came in from them is its own total');
  assert.equal(s.lastReceived, '2026-10-20');
  assert.equal(s.lines, 4, 'every line counts, whichever way the money went');
  assert.equal(s.lastPaid, '2026-10-09');
  assert.equal(s.direction, 'debit');
  assert.equal(s.postings, 3);
  assert.deepEqual([s.categoryName, s.categoryType], ['Repairs', 'opex']);
  assert.ok(Math.abs(s.categoryShare - 2 / 3) < 1e-9);
  assert.equal(postingStats([], lines, cats).size, 0);
});
