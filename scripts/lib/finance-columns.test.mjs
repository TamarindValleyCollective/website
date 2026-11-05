// Run with: node --test scripts/lib/finance-columns.test.mjs
// The Ledger table's column search and sort (docs/finance/FINANCE.md, "The table"): what a person types under a column header
// and how rows are ordered. Every value here is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SORT_KEYS, compareRows, describeCondition, matchAmount, matchDate, matchText, parseAmount, parseDate, parseText } from './finance-columns.mjs';

test('plain text means "contains", ignoring case', () => {
  const c = parseText('Nursery');
  assert.equal(matchText(c, 'Green nursery pvt'), true);
  assert.equal(matchText(c, 'Test Traders'), false);
  assert.equal(parseText('   '), null);
  assert.equal(matchText(null, 'anything'), true);
});

test('= is an exact match, != is "is not", ^ is "starts with", ! is "does not contain"', () => {
  assert.equal(matchText(parseText('=Bank charges'), 'bank charges'), true);
  assert.equal(matchText(parseText('=Bank'), 'Bank charges'), false);
  assert.equal(matchText(parseText('!=Bank charges'), 'Bank charges'), false);
  assert.equal(matchText(parseText('!=Bank charges'), 'Groceries'), true);
  assert.equal(matchText(parseText('^Green'), 'Green Nursery'), true);
  assert.equal(matchText(parseText('^Nursery'), 'Green Nursery'), false);
  assert.equal(matchText(parseText('!nursery'), 'Green Nursery'), false);
  assert.equal(matchText(parseText('!nursery'), 'Test Traders'), true);
});

test('= on its own means empty, != on its own means not empty', () => {
  assert.equal(matchText(parseText('='), ''), true);
  assert.equal(matchText(parseText('='), 'x'), false);
  assert.equal(matchText(parseText('!='), 'x'), true);
  assert.equal(matchText(parseText('!='), ''), false);
  assert.equal(matchText(parseText('!='), null), false);
});

test('text conditions are described the way ServiceNow shows them', () => {
  assert.equal(describeCondition('Category', parseText('!=Bank charges')), 'Category != Bank charges');
  assert.equal(describeCondition('Party', parseText('nursery')), 'Party contains nursery');
  assert.equal(describeCondition('Wording', parseText('=')), 'Wording is empty');
  assert.equal(describeCondition('Wording', parseText('!=')), 'Wording is not empty');
  assert.equal(describeCondition('Narration', parseText('^UPI')), 'Narration starts with UPI');
  assert.equal(describeCondition('Narration', parseText('!gst')), 'Narration does not contain gst');
});

test('amounts: a number, an operator or a range, in rupees', () => {
  assert.equal(matchAmount(parseAmount('2500'), 250000), true);
  assert.equal(matchAmount(parseAmount('2500'), 250001), false);
  assert.equal(matchAmount(parseAmount('>1,000'), 250000), true);
  assert.equal(matchAmount(parseAmount('>2500'), 250000), false);
  assert.equal(matchAmount(parseAmount('>=2500'), 250000), true);
  assert.equal(matchAmount(parseAmount('<500.50'), 50049), true);
  assert.equal(matchAmount(parseAmount('<=500.50'), 50050), true);
  assert.equal(matchAmount(parseAmount('1000..3000'), 250000), true);
  assert.equal(matchAmount(parseAmount('1000..3000'), 300001), false);
  assert.equal(matchAmount(parseAmount('!=2500'), 250000), false);
  assert.equal(matchAmount(parseAmount('!=2500'), 100), true);
  assert.equal(matchAmount(null, 1), true);
});

test('amount filters that make no sense are errors, not silently ignored', () => {
  for (const bad of ['abc', '>', '10..', '..10', '5..1', '1.234', '>>5']) assert.ok(parseAmount(bad)?.error, bad);
  assert.equal(parseAmount(''), null);
  assert.equal(describeCondition('Amount', parseAmount('>5000')), 'Amount > 5000');
  assert.equal(describeCondition('Amount', parseAmount('1000..3000')), 'Amount between 1000 and 3000');
});

test('dates: text matches the ISO date or the day-and-month label; operators and ranges take ISO dates', () => {
  const label = '31 Oct 2026';
  assert.equal(matchDate(parseDate('2026-10'), '2026-10-31', label), true);
  assert.equal(matchDate(parseDate('oct'), '2026-10-31', label), true);
  assert.equal(matchDate(parseDate('2026-11'), '2026-10-31', label), false);
  assert.equal(matchDate(parseDate('>2026-10-15'), '2026-10-31', label), true);
  assert.equal(matchDate(parseDate('>2026-10-31'), '2026-10-31', label), false);
  assert.equal(matchDate(parseDate('>=2026-10-31'), '2026-10-31', label), true);
  assert.equal(matchDate(parseDate('<2026-11-01'), '2026-10-31', label), true);
  assert.equal(matchDate(parseDate('2026-10-01..2026-10-31'), '2026-10-31', label), true);
  assert.equal(matchDate(parseDate('2026-10-01..2026-10-30'), '2026-10-31', label), false);
  assert.ok(parseDate('>last week')?.error);
  assert.ok(parseDate('2026-10-31..2026-10-01')?.error);
});

const rows = [
  { id: 'a', date: '2026-10-02', narration: 'Beta', amount: 500, category: 'Groceries', party: '', nature: 'Milk', status: 'unallocated' },
  { id: 'b', date: '2026-10-09', narration: 'alpha', amount: 90000, category: '', party: 'Zed', nature: '', status: 'allocated' },
  { id: 'c', date: '2026-10-09', narration: 'Gamma', amount: 90000, category: 'Bank charges', party: 'Amit', nature: 'Fees', status: 'review' },
  { id: 'd', date: '2026-09-30', narration: 'Delta', amount: 12, category: 'Groceries', party: 'Bob', nature: 'Eggs', status: 'partly_allocated' },
];
const order = (key, dir) => [...rows].sort(compareRows(key, dir)).map((r) => r.id).join('');

test('sorting by every column, in both directions, ties broken by newest date then id', () => {
  assert.deepEqual(SORT_KEYS, ['date', 'narration', 'amount', 'category', 'party', 'nature', 'status']);
  assert.equal(order('date', 'desc'), 'bcad');
  assert.equal(order('date', 'asc'), 'dabc');
  assert.equal(order('amount', 'asc'), 'dabc'); // 12, 500, then the two 90000s in id order
  assert.equal(order('amount', 'desc'), 'bcad');
  assert.equal(order('party', 'asc'), 'cdba'); // Amit, Bob, Zed, then the empty one last
  assert.equal(order('nature', 'desc'), 'acdb'); // Milk, Fees, Eggs, then the empty one last
});

test('narration sorts without regard to case', () => {
  assert.equal(order('narration', 'asc'), 'badc');
  assert.deepEqual([...rows].sort(compareRows('narration', 'asc')).map((r) => r.narration), ['alpha', 'Beta', 'Delta', 'Gamma']);
});

test('empty cells sort last whichever way, so the filled ones come first', () => {
  const cats = (dir) => [...rows].sort(compareRows('category', dir)).map((r) => r.category);
  assert.deepEqual(cats('asc'), ['Bank charges', 'Groceries', 'Groceries', '']);
  assert.deepEqual(cats('desc'), ['Groceries', 'Groceries', 'Bank charges', '']);
});

test('status sorts in working order: review, then to allocate, partly, allocated', () => {
  assert.deepEqual([...rows].sort(compareRows('status', 'asc')).map((r) => r.status), ['review', 'unallocated', 'partly_allocated', 'allocated']);
  assert.deepEqual([...rows].sort(compareRows('status', 'desc')).map((r) => r.status), ['allocated', 'partly_allocated', 'unallocated', 'review']);
});

test('an unknown sort key falls back to date', () => {
  assert.equal([...rows].sort(compareRows('nonsense', 'desc')).map((r) => r.id).join(''), order('date', 'desc'));
});
