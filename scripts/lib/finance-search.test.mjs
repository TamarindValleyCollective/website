// Run with: node --test scripts/lib/finance-search.test.mjs
// The Ledger's search chips, Group By and Favorites. Every value here is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildItems, cleanFavorite, optionCounts, passesChips, passesWords, periodOptions, readFavorites, withFavorite } from './finance-search.mjs';

const line = (id, date, direction, amountPaise, over = {}) => ({
  id, date, direction, amountPaise, state: 'unallocated', review: false, missingParty: false,
  effective: { category: '', party: '' }, allocation: null, ...over,
});
const LINES = [
  line('a', '2026-11-03', 'debit', 50000, { effective: { category: 'Fuel', party: 'Test Fuels' } }),
  line('b', '2026-10-20', 'credit', 250000, { state: 'allocated', effective: { category: 'Maintenance', party: 'Household A' }, allocation: { householdLabel: 'F-01 · H-01' } }),
  line('c', '2026-10-02', 'debit', 10000, { review: true, effective: { category: 'Repairs', party: '' } }),
  line('d', '2026-03-30', 'debit', 7000, { state: 'allocated', missingParty: true, effective: { category: 'Wages', party: '' } }),
];
const NOW = '2026-11-06';

test('options of one kind are alternatives; different kinds all have to hold', () => {
  const ids = (chips) => LINES.filter((l) => passesChips(l, chips, NOW)).map((l) => l.id);
  assert.deepEqual(ids([]), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ids([['status', 'unallocated']]), ['a', 'c']);
  assert.deepEqual(ids([['status', 'unallocated'], ['status', 'review']]), ['a', 'c']);
  assert.deepEqual(ids([['status', 'allocated'], ['status', 'review']]), ['b', 'c', 'd']);
  assert.deepEqual(ids([['status', 'allocated'], ['flow', 'in']]), ['b']);
  assert.deepEqual(ids([['status', 'noparty']]), ['d']);
});

test('an unknown chip is ignored, not treated as "show nothing"', () => {
  assert.equal(LINES.filter((l) => passesChips(l, [['status', 'gone'], ['nope', 'x']], NOW)).length, 4);
});

test('date periods follow today, and the financial year starts in April', () => {
  const p = periodOptions(NOW);
  const ids = (key) => LINES.filter(p[key][1]).map((l) => l.id);
  assert.deepEqual(ids('thismonth'), ['a']);
  assert.deepEqual(ids('lastmonth'), ['b', 'c']);
  assert.deepEqual(ids('thisquarter'), ['a', 'b', 'c']);
  assert.deepEqual(ids('thisyear'), ['a', 'b', 'c']); // 2026-03-30 is in the year before
  const jan = periodOptions('2027-01-15');
  assert.equal(jan.lastmonth[1](line('x', '2026-12-31', 'debit', 1)), true);
  assert.equal(jan.thisyear[1](line('x', '2026-04-01', 'debit', 1)), true); // FY 2026-27 still running in January
  assert.equal(jan.thisyear[1](line('x', '2026-03-31', 'debit', 1)), false);
});

test('option counts say how many lines each option shows on its own', () => {
  const c = optionCounts(LINES, NOW);
  assert.equal(c.status.unallocated, 2);
  assert.equal(c.status.allocated, 2);
  assert.equal(c.flow.in, 1);
  assert.equal(c.period.lastmonth, 2);
});

test('every word chip has to appear', () => {
  assert.equal(passesWords('diesel for tractor test fuels', ['fuel', 'DIESEL']), true);
  assert.equal(passesWords('diesel for tractor', ['fuel']), false);
  assert.equal(passesWords('anything', []), true);
});

test('group by month: newest first, with count and net (money in minus money out)', () => {
  const { items, visible } = buildItems(LINES, ['month'], new Set(), (m) => `M ${m}`);
  const groups = items.filter((i) => i.kind === 'group');
  assert.deepEqual(groups.map((g) => g.label), ['M 2026-11', 'M 2026-10', 'M 2026-03']);
  assert.deepEqual(groups.map((g) => g.count), [1, 2, 1]);
  assert.equal(groups[1].netPaise, 250000 - 10000);
  assert.equal(visible.length, 4);
  assert.equal(items.length, 4 + 3);
});

test('a collapsed group keeps its heading but hides its lines', () => {
  const first = buildItems(LINES, ['month']).items[0];
  const { items, visible } = buildItems(LINES, ['month'], new Set([first.key]));
  assert.equal(items.filter((i) => i.kind === 'group').length, 3);
  assert.equal(visible.length, 3);
  assert.equal(items[0].open, false);
});

test('two levels nest, and "No ..." groups come last', () => {
  const { items } = buildItems(LINES, ['status', 'party']);
  const labels = items.filter((i) => i.kind === 'group').map((g) => `${g.depth}:${g.label}`);
  assert.equal(labels[0].startsWith('0:'), true);
  const partyGroups = items.filter((i) => i.kind === 'group' && i.field === 'party');
  assert.equal(partyGroups.some((g) => g.label === 'No party'), true);
  // within a status group, "No party" is after any named party
  const sameStatus = items.slice(items.findIndex((i) => i.label === 'To review'));
  const firstNo = sameStatus.findIndex((i) => i.label === 'No party');
  assert.ok(firstNo === -1 || sameStatus.slice(0, firstNo).every((i) => i.label !== 'No party'));
});

test('an unknown group field is dropped and at most two are used', () => {
  const { items } = buildItems(LINES, ['nope', 'category', 'party', 'unit']);
  assert.equal(items.filter((i) => i.kind === 'group' && i.depth === 2).length, 0);
  assert.ok(items.some((i) => i.kind === 'group' && i.field === 'category'));
});

test('favorites are cleaned on the way in and out', () => {
  assert.equal(cleanFavorite({ name: '  ' }), null);
  assert.equal(cleanFavorite(null), null);
  const f = cleanFavorite({ name: ' Unit rent ', chips: [['status', 'review'], 'junk', [1, 2]], words: ['  fuel ', ''], groups: ['month', 'bogus', 'party', 'unit'] });
  assert.deepEqual(f, { name: 'Unit rent', chips: [['status', 'review']], words: ['fuel'], groups: ['month', 'party'] });
  assert.deepEqual(readFavorites('not json'), []);
  assert.deepEqual(readFavorites('{"a":1}'), []);
  assert.equal(readFavorites(JSON.stringify([{ name: 'x' }, { nothing: true }])).length, 1);
});

test('saving a favorite under an existing name replaces it', () => {
  const one = withFavorite([], { name: 'Review', chips: [['status', 'review']] });
  const two = withFavorite(one, { name: 'review', chips: [['status', 'noparty']] });
  assert.equal(two.length, 1);
  assert.deepEqual(two[0].chips, [['status', 'noparty']]);
});

import { matchOptions } from './finance-search.mjs';
test('typing narrows the picker: every word must appear, best matches first', () => {
  const opts = [
    { value: 'a', label: 'Accfinsource consulting Services' },
    { value: 'b', label: 'Amaan Enterprises' },
    { value: 'c', label: 'Test Gas Services' },
    { value: 'd', label: 'Gas Agency Muthu' },
  ];
  assert.deepEqual(matchOptions(opts, '').map((o) => o.value), ['a', 'b', 'c', 'd']);
  assert.deepEqual(matchOptions(opts, 'gas').map((o) => o.value), ['d', 'c']); // starts with first, then a later word
  assert.deepEqual(matchOptions(opts, 'serv gas').map((o) => o.value), ['c']);
  assert.deepEqual(matchOptions(opts, 'ACC').map((o) => o.value), ['a']);
  assert.deepEqual(matchOptions(opts, 'zzz'), []);
});

import { partyOptions } from './finance-ui.mjs';
test('the party picker lists current parties first and marks former members', () => {
  const out = partyOptions([{ id: 'a', name: 'Ann' }, { id: 'b', name: 'Bo', former_since: '2026-03-01' }, { id: 'c', name: 'Cy' }]);
  assert.deepEqual(out.map((o) => o.label), ['Ann', 'Cy', 'Bo · former member']);
  assert.deepEqual(out.map((o) => o.value), ['a', 'c', 'b']);
});

import { defaultUnitFor, financialYearOf, maintenanceYears, partyKindsFor } from './finance-search.mjs';
test('the category type suggests party kinds; unknown types suggest none', () => {
  assert.deepEqual(partyKindsFor('member_contribution'), ['member']);
  assert.deepEqual(partyKindsFor('opex'), ['vendor', 'employee']);
  assert.equal(partyKindsFor('sinking_fund'), null);
  assert.equal(partyKindsFor(undefined), null);
});
test('financial years run April to March; the maintenance years offered surround the payment', () => {
  assert.equal(financialYearOf('2026-11-06'), '2026-27');
  assert.equal(financialYearOf('2027-03-31'), '2026-27');
  assert.equal(financialYearOf('2027-04-01'), '2027-28');
  assert.equal(financialYearOf('2099-12-31'), '2099-00'); // century rollover keeps two digits
  assert.deepEqual(maintenanceYears('2026-11-06'), ['2024-25', '2025-26', '2026-27', '2027-28']);
});
test('the default unit is only the payer\'s own, for a current member with a unit', () => {
  assert.equal(defaultUnitFor({ kind: 'member', household_id: 'h1' }), 'h1');
  assert.equal(defaultUnitFor({ kind: 'member', household_id: 'h1', former_since: '2026-03-01' }), null);
  assert.equal(defaultUnitFor({ kind: 'member', household_id: null }), null);
  assert.equal(defaultUnitFor({ kind: 'vendor', household_id: 'h1' }), null);
  assert.equal(defaultUnitFor(null), null);
});
