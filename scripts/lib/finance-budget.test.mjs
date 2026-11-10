// Run with: node --test scripts/lib/finance-budget.test.mjs
// The budget editor's rules (docs/finance/FINANCE.md, "The budget editor"): reading a typed amount, checking a set of lines before
// they are saved, and the totals shown under each head. Used by the function (which refuses a bad save) and by the page (which says
// what is wrong before it asks). Every amount is invented, in paise.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BUDGET_HEADS, MAX_LINES, budgetTotals, editorRows, lineHead, linesFromInputs, parseRupees, rupeesInput, validateBudgetLines } from './finance-budget.mjs';

const RS = 100;
const ID = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const categories = [
  { id: ID(1), name: 'Groceries', type: 'opex', head: 'farm', active: true },
  { id: ID(2), name: 'Salaries', type: 'opex', head: 'farm', active: true },
  { id: ID(3), name: 'Professional fees', type: 'opex', head: 'company', active: true },
  { id: ID(4), name: 'Guest stays', type: 'revenue', head: null, active: true },
  { id: ID(5), name: 'Member maintenance', type: 'member_contribution', head: null, active: true },
  { id: ID(6), name: 'Sinking fund deposits', type: 'sinking_fund', head: 'investment', active: true },
  { id: ID(7), name: 'Unplaced spending', type: 'opex', head: null, active: true },
  { id: ID(8), name: 'Old category', type: 'opex', head: 'farm', active: false },
];
const projects = [{ id: ID(21), name: 'Water storage', kind: 'project' }, { id: ID(22), name: 'A fair', kind: 'event' }];
const ctx = { categories, projects };

test('typed rupees become paise: commas, a rupee sign, spaces and up to two decimals are fine', () => {
  assert.equal(parseRupees('50000'), 50000 * RS);
  assert.equal(parseRupees('12,34,567'), 1234567 * RS);
  assert.equal(parseRupees(' ₹ 1,500 '), 1500 * RS);
  assert.equal(parseRupees('1,234,567'), 1234567 * RS); // Western grouping reads the same
  assert.equal(parseRupees('2500.50'), 250050);
  assert.equal(parseRupees('0'), 0);
  assert.equal(parseRupees('.5'), null);
});

test('typed rupees that are not an amount are refused, never guessed', () => {
  for (const bad of ['', '   ', 'abc', '1.234', '-500', '12,,3x', ',500', '500,', '1,', '1e5', '5 lakh', '₹']) assert.equal(parseRupees(bad), null, JSON.stringify(bad));
  assert.equal(parseRupees(null), null);
  assert.equal(parseRupees(undefined), null);
});

test('an amount is shown in Indian grouping, with decimals only when there are some', () => {
  assert.equal(rupeesInput(1234567 * RS), '12,34,567');
  assert.equal(rupeesInput(0), '0');
  assert.equal(rupeesInput(250050), '2,500.50');
  assert.equal(parseRupees(rupeesInput(98765432100)), 98765432100); // what is shown can be typed back
});

test('a good set of lines is cleaned and numbered in order', () => {
  const r = validateBudgetLines([
    { categoryId: ID(1), label: '  Groceries ', comment: ' Kitchen supplies ', annualPaise: 120000 * RS },
    { categoryId: ID(4), label: '', comment: '', annualPaise: 50000 * RS },
    { projectId: ID(21), label: 'Tank', comment: null, annualPaise: 70000 * RS },
  ], ctx);
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.lines, [
    { categoryId: ID(1), projectId: null, label: 'Groceries', comment: 'Kitchen supplies', annualPaise: 120000 * RS, sortOrder: 1 },
    { categoryId: ID(4), projectId: null, label: 'Guest stays', comment: null, annualPaise: 50000 * RS, sortOrder: 2 }, // a blank label is the category's name
    { categoryId: null, projectId: ID(21), label: 'Tank', comment: null, annualPaise: 70000 * RS, sortOrder: 3 },
  ]);
});

test('an empty draft can be saved; a line needs exactly one of a category or a project', () => {
  assert.equal(validateBudgetLines([], ctx).ok, true);
  const both = validateBudgetLines([{ categoryId: ID(1), projectId: ID(21), label: 'x', annualPaise: 1 }], ctx);
  assert.equal(both.ok, false);
  assert.match(both.errors[0].message, /category or a project/i);
  const none = validateBudgetLines([{ label: 'x', annualPaise: 1 }], ctx);
  assert.equal(none.ok, false);
  assert.equal(none.errors[0].index, 0);
});

test('an unknown category or project, or an inactive category, is refused', () => {
  assert.equal(validateBudgetLines([{ categoryId: ID(99), label: 'x', annualPaise: 1 }], ctx).ok, false);
  assert.equal(validateBudgetLines([{ projectId: ID(99), label: 'x', annualPaise: 1 }], ctx).ok, false);
  const old = validateBudgetLines([{ categoryId: ID(8), label: 'x', annualPaise: 1 }], ctx);
  assert.equal(old.ok, false);
  assert.match(old.errors[0].message, /no longer in use/i);
});

test('an event is not a budget line: only projects are', () => {
  const r = validateBudgetLines([{ projectId: ID(22), label: 'x', annualPaise: 1 }], ctx);
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /event/i);
});

test('amounts must be whole paise, not negative, and not absurd', () => {
  for (const bad of [-1, 1.5, '100', NaN, null, undefined, 1e15]) {
    assert.equal(validateBudgetLines([{ categoryId: ID(1), label: 'x', annualPaise: bad }], ctx).ok, false, String(bad));
  }
  assert.equal(validateBudgetLines([{ categoryId: ID(1), label: 'x', annualPaise: 0 }], ctx).ok, true);
});

test('labels and comments have limits', () => {
  assert.equal(validateBudgetLines([{ categoryId: ID(1), label: 'a'.repeat(121), annualPaise: 1 }], ctx).ok, false);
  assert.equal(validateBudgetLines([{ categoryId: ID(1), label: 'a'.repeat(120), annualPaise: 1 }], ctx).ok, true);
  assert.equal(validateBudgetLines([{ categoryId: ID(1), label: 'x', comment: 'c'.repeat(201), annualPaise: 1 }], ctx).ok, false);
});

test('a category or project may have one line; the second is the one that is marked', () => {
  const r = validateBudgetLines([
    { categoryId: ID(1), label: 'One', annualPaise: 1 },
    { categoryId: ID(2), label: 'Two', annualPaise: 1 },
    { categoryId: ID(1), label: 'Again', annualPaise: 1 },
    { projectId: ID(21), label: 'P', annualPaise: 1 },
    { projectId: ID(21), label: 'P again', annualPaise: 1 },
  ], ctx);
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors.map((e) => e.index), [2, 4]);
  assert.match(r.errors[0].message, /already has a line/i);
});

test('every problem is reported at once, so one save shows them all', () => {
  const r = validateBudgetLines([{ categoryId: ID(99), label: 'x', annualPaise: 1 }, { categoryId: ID(1), label: 'x', annualPaise: -5 }, { label: 'y', annualPaise: 1 }], ctx);
  assert.deepEqual(r.errors.map((e) => e.index), [0, 1, 2]);
});

test('there is a cap on the number of lines', () => {
  const many = Array.from({ length: MAX_LINES + 1 }, (_, i) => ({ categoryId: ID(1), label: `L${i}`, annualPaise: 1 }));
  const r = validateBudgetLines(many, ctx);
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /at most/i);
});

test('rows that are not objects are refused, not crashed on', () => {
  assert.equal(validateBudgetLines('nope', ctx).ok, false);
  assert.equal(validateBudgetLines([null, 5, 'x'], ctx).ok, false);
});

test('a line belongs to a head: its category\'s, or Projects for a project, or none when the category has no head', () => {
  const l = (o) => ({ categoryId: null, projectId: null, ...o });
  assert.equal(lineHead(l({ categoryId: ID(1) }), ctx), 'farm');
  assert.equal(lineHead(l({ categoryId: ID(3) }), ctx), 'company');
  assert.equal(lineHead(l({ categoryId: ID(4) }), ctx), 'income');
  assert.equal(lineHead(l({ categoryId: ID(5) }), ctx), 'maintenance');
  assert.equal(lineHead(l({ categoryId: ID(6) }), ctx), 'investment');
  assert.equal(lineHead(l({ projectId: ID(21) }), ctx), 'projects');
  assert.equal(lineHead(l({ categoryId: ID(7) }), ctx), 'none');
  assert.deepEqual(BUDGET_HEADS, ['company', 'farm', 'projects', 'investment', 'income', 'maintenance']);
});

test('totals per head, money out against money in, and a line with no head still counts as money out', () => {
  const lines = [
    { categoryId: ID(1), projectId: null, annualPaise: 100 * RS },
    { categoryId: ID(2), projectId: null, annualPaise: 600 * RS },
    { categoryId: ID(3), projectId: null, annualPaise: 50 * RS },
    { categoryId: null, projectId: ID(21), annualPaise: 200 * RS },
    { categoryId: ID(6), projectId: null, annualPaise: 40 * RS },
    { categoryId: ID(7), projectId: null, annualPaise: 7 * RS },
    { categoryId: ID(4), projectId: null, annualPaise: 80 * RS },
    { categoryId: ID(5), projectId: null, annualPaise: 900 * RS },
  ];
  const t = budgetTotals(lines, ctx);
  assert.equal(t.byHead.farm, 700 * RS);
  assert.equal(t.byHead.company, 50 * RS);
  assert.equal(t.byHead.projects, 200 * RS);
  assert.equal(t.byHead.investment, 40 * RS);
  assert.equal(t.byHead.none, 7 * RS);
  assert.equal(t.byHead.income, 80 * RS);
  assert.equal(t.byHead.maintenance, 900 * RS);
  assert.equal(t.outflowPaise, (700 + 50 + 200 + 40 + 7) * RS);
  assert.equal(t.inflowPaise, 980 * RS);
  assert.equal(t.surplusPaise, 980 * RS - 997 * RS);
});

// ---- The editor's grid: every category and project is a row under its head ----
const more = [
  ...categories,
  { id: ID(9), name: 'Transfers', type: 'transfer', head: null, active: true },
  { id: ID(10), name: 'Interest income', type: 'interest', head: null, active: true },
  { id: ID(11), name: 'Land and local taxes', type: 'tax', head: null, active: true }, // spending, no head yet
];
const rowsFor = (lines = [], extra = {}) => editorRows({ categories: more, projects, lines, actuals: { byCategory: { [ID(1)]: 450 * RS }, byProject: { [ID(21)]: 120 * RS } }, previous: { byCategory: { [ID(1)]: 400 * RS } }, ...extra });

test('every category and project is a row under its head, in the presentation\'s order', () => {
  const groups = rowsFor();
  assert.deepEqual(groups.map((g) => g.head), ['company', 'farm', 'projects', 'investment', 'income', 'maintenance', 'none']);
  const names = (head) => groups.find((g) => g.head === head).rows.map((r) => r.name);
  assert.deepEqual(names('farm'), ['Groceries', 'Salaries']); // the retired category is not offered
  assert.deepEqual(names('income'), ['Guest stays', 'Interest income']);
  assert.deepEqual(names('projects'), ['Water storage']); // a project, never an event
  assert.deepEqual(names('none'), ['Land and local taxes', 'Unplaced spending']); // spending nobody has given a head
  assert.equal(groups.some((g) => g.rows.some((r) => r.name === 'Transfers')), false); // a transfer is not budgeted
});

test('a row carries what is already planned, what has been spent and last year\'s amount', () => {
  const lines = [{ categoryId: ID(1), projectId: null, label: 'Kitchen', comment: 'Tea too', annualPaise: 500 * RS }];
  const groc = rowsFor(lines).find((g) => g.head === 'farm').rows.find((r) => r.name === 'Groceries');
  assert.deepEqual({ ...groc }, { key: `c:${ID(1)}`, kind: 'category', id: ID(1), name: 'Groceries', label: 'Kitchen', comment: 'Tea too', amountPaise: 500 * RS, actualPaise: 450 * RS, previousPaise: 400 * RS, retired: false });
  const sal = rowsFor(lines).find((g) => g.head === 'farm').rows.find((r) => r.name === 'Salaries');
  assert.equal(sal.amountPaise, null);
  assert.equal(sal.previousPaise, null);
  assert.equal(sal.actualPaise, 0);
  const water = rowsFor(lines).find((g) => g.head === 'projects').rows[0];
  assert.equal(water.key, `p:${ID(21)}`);
  assert.equal(water.actualPaise, 120 * RS);
});

test('a retired category, or a transfer, that already has a line is still shown so it can be seen and removed', () => {
  const lines = [{ categoryId: ID(8), projectId: null, label: 'Old', comment: null, annualPaise: 10 * RS }, { categoryId: ID(9), projectId: null, label: 'T', comment: null, annualPaise: 5 * RS }];
  const groups = rowsFor(lines);
  const old = groups.find((g) => g.head === 'farm').rows.find((r) => r.name === 'Old category');
  assert.equal(old.retired, true);
  assert.ok(groups.some((g) => g.rows.some((r) => r.name === 'Transfers')));
});

test('typed amounts become lines: blank rows have no line, zero is a real line, text is turned into rupees', () => {
  const r = linesFromInputs([
    { key: `c:${ID(1)}`, kind: 'category', id: ID(1), amountText: '1,20,000', label: ' Kitchen ', comment: ' tea ' },
    { key: `c:${ID(2)}`, kind: 'category', id: ID(2), amountText: '', label: '', comment: '' },
    { key: `c:${ID(3)}`, kind: 'category', id: ID(3), amountText: '   ', label: '', comment: '' },
    { key: `p:${ID(21)}`, kind: 'project', id: ID(21), amountText: '0', label: '', comment: '' },
  ]);
  assert.deepEqual(r.errors, {});
  assert.deepEqual(r.lines, [
    { categoryId: ID(1), projectId: undefined, label: 'Kitchen', comment: 'tea', annualPaise: 12000000 },
    { categoryId: undefined, projectId: ID(21), label: '', comment: '', annualPaise: 0 },
  ]);
});

test('an amount that is not an amount is marked on its row, never turned into a different number', () => {
  const r = linesFromInputs([
    { key: 'a', kind: 'category', id: ID(1), amountText: '12 lakh', label: '', comment: '' },
    { key: 'b', kind: 'category', id: ID(2), amountText: '500', label: '', comment: '' },
    { key: 'c', kind: 'project', id: ID(21), amountText: '-5', label: '', comment: '' },
  ]);
  assert.deepEqual(Object.keys(r.errors), ['a', 'c']);
  assert.match(r.errors.a, /amount in rupees/i);
  assert.equal(r.lines.length, 1); // the good one is still read
});
