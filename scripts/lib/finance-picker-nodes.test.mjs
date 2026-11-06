// Run with: node --test scripts/lib/finance-picker-nodes.test.mjs
// The ledger's category and party trees. Every name here is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { categoryNodes, categoryPath, partyNodes, partyPath, partyStart, readCategoryPath, unitNodes, yearsFor } from './finance-picker-nodes.mjs';
import { labelsOf, levelAt, rowsAt } from './linked-picker-core.mjs';

const CATS = [
  { id: 'c1', name: 'Member maintenance', type: 'member_contribution', active: true },
  { id: 'c2', name: 'Fuel', type: 'opex', active: true },
  { id: 'c3', name: 'Plantation', type: 'capex', active: true },
];
const HOUSEHOLDS = [{ id: 'h1', label: 'F-01 · H-10', people: ['Test Person One'] }, { id: 'h2', label: 'F-02 · H-04', people: ['Another Member'] }];
const PROJECTS = [{ id: 'pr1', name: 'Nursery shed', financial_year: 2026 }];
const PARTIES = [
  { id: 'm1', name: 'Test Person One', kind: 'member', household_id: 'h1' },
  { id: 'm2', name: 'Former Owner', kind: 'member', household_id: 'h2', former_since: '2026-03-01' },
  { id: 'v1', name: 'Test Fuels', kind: 'vendor' },
  { id: 'v2', name: 'Wecommunities Test Co', kind: 'vendor' },
];

test('years: the payment\'s own financial year first', () => {
  assert.deepEqual(yearsFor('2026-11-06'), ['2026-27', '2027-28', '2025-26', '2024-25']);
  assert.equal(yearsFor('2026-11-06')[0], '2026-27');
  assert.equal(yearsFor('2027-02-01')[0], '2026-27');
  assert.equal(new Set(yearsFor('2026-11-06')).size, 4);
});

test('maintenance goes category > year > unit; a plain category is just itself', () => {
  const nodes = categoryNodes({ categories: CATS, households: HOUSEHOLDS, projects: PROJECTS, date: '2026-11-06' });
  assert.deepEqual(labelsOf(nodes, ['c1', '2026-27', 'h1']), ['Member maintenance', '2026-27', 'F-01 · H-10']);
  assert.equal(levelAt(nodes, ['c2']), null);
  assert.deepEqual(rowsAt(nodes, ['c1'], '').map((r) => `${r.kind}:${r.node.value}`).slice(0, 2), ['enter:2026-27', 'enter:2027-28']);
});

test('units are found by the people living in them, and the payer\'s own is first', () => {
  const nodes = categoryNodes({ categories: CATS, households: HOUSEHOLDS, date: '2026-11-06', suggestedUnit: 'h2' });
  const units = rowsAt(nodes, ['c1', '2026-27'], '').map((r) => r.node);
  assert.deepEqual(units.map((u) => u.value), ['h2', 'h1']);
  assert.equal(units[0].sub, 'the payer’s unit');
  assert.deepEqual(rowsAt(nodes, ['c1', '2026-27'], 'person one').map((r) => r.node.value), ['h1']);
});

test('a capital purchase can be picked as it is, or taken down to a project', () => {
  const nodes = categoryNodes({ categories: CATS, projects: PROJECTS, date: '2026-11-06' });
  const rows = rowsAt(nodes, [], 'plantation').map((r) => `${r.kind}:${r.node.value}`);
  assert.deepEqual(rows, ['pick:c3', 'enter:c3']);
  assert.deepEqual(labelsOf(nodes, ['c3', 'pr1']), ['Plantation', 'Nursery shed (2026)']);
  assert.equal(levelAt(categoryNodes({ categories: CATS, projects: [], date: '2026-11-06' }), ['c3']), null); // no projects: nothing to go down to
});

test('in the bar, maintenance and each year can also be picked as they are', () => {
  const nodes = categoryNodes({ categories: CATS, households: HOUSEHOLDS, date: '2026-11-06', bar: true });
  assert.ok(rowsAt(nodes, [], 'maintenance').some((r) => r.kind === 'pick'));
  assert.ok(rowsAt(nodes, ['c1'], '2026-27').some((r) => r.kind === 'pick'));
  const line = categoryNodes({ categories: CATS, households: HOUSEHOLDS, date: '2026-11-06' });
  assert.ok(!rowsAt(line, [], 'maintenance').some((r) => r.kind === 'pick'));
});

test('a category path reads back into its parts and is built from them', () => {
  assert.deepEqual(readCategoryPath(['c1', '2026-27', 'h1'], 'member_contribution'), { categoryId: 'c1', year: '2026-27', householdId: 'h1', projectId: '' });
  assert.deepEqual(readCategoryPath(['c3', 'pr1'], 'capex'), { categoryId: 'c3', year: '', householdId: '', projectId: 'pr1' });
  assert.deepEqual(readCategoryPath(['c2'], 'opex'), { categoryId: 'c2', year: '', householdId: '', projectId: '' });
  assert.deepEqual(categoryPath({ categoryId: 'c1', type: 'member_contribution', year: '2026-27', unit: 'h1' }), ['c1', '2026-27', 'h1']);
  assert.deepEqual(categoryPath({ categoryId: 'c1', type: 'member_contribution', year: '2026-27' }), ['c1']); // no unit yet: not a complete choice
  assert.deepEqual(categoryPath({ categoryId: '' }), []);
});

test('parties sit under their kind; former members are last and marked; everyone is under All parties', () => {
  const nodes = partyNodes({ parties: PARTIES, unitLabels: new Map([['h1', 'F-01 · H-10']]) });
  assert.deepEqual(nodes.map((n) => n.value), ['member', 'vendor', 'all']); // kinds with nobody in them are not listed
  assert.deepEqual(levelAt(nodes, ['member']).map((n) => n.label), ['Test Person One', 'Former Owner · former member']);
  assert.equal(levelAt(nodes, ['all']).length, 4);
  assert.deepEqual(labelsOf(nodes, partyPath(PARTIES[2])), ['Vendors', 'Test Fuels']);
});

test('for a unit\'s maintenance the people living there come first, under their own heading', () => {
  const nodes = partyNodes({ parties: PARTIES, unitId: 'h1', unitLabels: new Map([['h1', 'F-01 · H-10']]) });
  assert.equal(nodes[0].value, 'unit');
  assert.equal(nodes[0].label, 'People in F-01 · H-10');
  assert.deepEqual(levelAt(nodes, ['unit']).map((n) => n.value), ['m1']);
  assert.equal(partyNodes({ parties: PARTIES, unitId: 'h9' })[0].value, 'member'); // a unit nobody lives in adds no heading
});

test('where the party list opens', () => {
  assert.deepEqual(partyStart({ categoryType: 'member_contribution', unitId: 'h1', unitHasPeople: true, parties: PARTIES }), ['unit']);
  assert.equal(partyStart({ categoryType: 'member_contribution', unitId: '', parties: PARTIES }), null);
  assert.deepEqual(partyStart({ categoryType: 'opex', parties: PARTIES }), ['vendor']);
  assert.equal(partyStart({ categoryType: 'tax', parties: PARTIES }), null); // nobody of that kind: show all kinds
  assert.equal(partyStart({ categoryType: 'sinking_fund', parties: PARTIES }), null);
});

test('unitNodes without a suggestion keeps the order given', () => {
  assert.deepEqual(unitNodes(HOUSEHOLDS).map((u) => u.value), ['h1', 'h2']);
});

test('a capital category that can be picked as it is or taken to a project says which row is which', () => {
  const nodes = categoryNodes({ categories: [{ id: 'c1', name: 'Equipment', type: 'capex', active: true }], projects: [{ id: 'p1', name: 'Pump', financial_year: 2026 }], date: '2026-11-06' });
  assert.equal(nodes[0].selectable, true);
  assert.equal(nodes[0].pickSub, 'no project');
  assert.equal(nodes[0].enterLabel, 'Equipment · choose a project');
});
