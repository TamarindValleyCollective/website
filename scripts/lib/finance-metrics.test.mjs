// Run with: node --test scripts/lib/finance-metrics.test.mjs
// The dashboard figures (docs/finance/DESIGN.md "Dashboards", docs/finance/FINANCE.md "Dashboards"). Every amount is invented
// and in paise. "Cash view" groups by the bank date; "period view" by the allocation's period.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GROUPS, actualsByTarget, budgetVsActual, cashflow, circleMonth, completeMonths, fdBalance, fyLabel, fyMonths, groupOf, headOfCategory, healthOf, runwayOf,
} from './finance-metrics.mjs';

const RS = 100; // paise in a rupee
const cat = (id, type, extra = {}) => ({ id, type, head: null, is_salary: false, ...extra });
const categories = [
  cat('sal', 'opex', { head: 'farm', is_salary: true }),
  cat('groc', 'opex', { head: 'farm' }),
  cat('fees', 'opex', { head: 'company' }),
  cat('tank', 'capex', { head: 'projects' }),
  cat('sink', 'sinking_fund', { head: 'investment' }),
  cat('maint', 'member_contribution'),
  cat('stay', 'revenue'),
  cat('int', 'interest'),
  cat('misc', 'opex'), // a spending category with no head
];

test('financial year names and months', () => {
  assert.equal(fyLabel(2026), '2026-27');
  assert.equal(fyLabel(2099), '2099-00');
  const months = fyMonths(2026);
  assert.equal(months.length, 12);
  assert.equal(months[0], '2026-04-01');
  assert.equal(months[9], '2027-01-01');
  assert.equal(months[11], '2027-03-01');
});

test('an allocation falls in one group: sinking fund, then project, then salary, then the category head', () => {
  assert.deepEqual(GROUPS, ['salary', 'farm', 'projects', 'company', 'sinking', 'other']);
  const by = Object.fromEntries(categories.map((c) => [c.id, c]));
  assert.equal(groupOf(by.sink, null), 'sinking');
  assert.equal(groupOf(by.sink, 'p1'), 'sinking');
  assert.equal(groupOf(by.sal, 'p1'), 'projects'); // a project's pay counts under the project
  assert.equal(groupOf(by.sal, null), 'salary');
  assert.equal(groupOf(by.groc, null), 'farm');
  assert.equal(groupOf(by.fees, null), 'company');
  assert.equal(groupOf(by.tank, null), 'projects');
  assert.equal(groupOf(by.misc, null), 'other');
  assert.equal(groupOf(undefined, null), 'other');
});

test('a category is placed in a head by its head, or by its type when it is not spending', () => {
  const by = Object.fromEntries(categories.map((c) => [c.id, c]));
  assert.equal(headOfCategory(by.groc), 'farm');
  assert.equal(headOfCategory(by.sink), 'investment');
  assert.equal(headOfCategory(by.maint), 'maintenance');
  assert.equal(headOfCategory(by.stay), 'income');
  assert.equal(headOfCategory(by.int), 'income');
  assert.equal(headOfCategory(by.misc), null);
});

// April: the maintenance comes in (credit), the pay goes out; May: pay and a sinking fund deposit; June: a refund comes back.
const lines = [
  { id: 'a1', bank_account_id: 'acc', tran_date: '2026-04-02', direction: 'credit', amount_paise: 1000000 * RS, balance_paise: 6000000 * RS },
  { id: 'a2', bank_account_id: 'acc', tran_date: '2026-04-28', direction: 'debit', amount_paise: 300000 * RS, balance_paise: 5700000 * RS },
  { id: 'm1', bank_account_id: 'acc', tran_date: '2026-05-05', direction: 'debit', amount_paise: 400000 * RS, balance_paise: 5300000 * RS },
  { id: 'j1', bank_account_id: 'acc', tran_date: '2026-06-10', direction: 'credit', amount_paise: 20000 * RS, balance_paise: 5320000 * RS },
];
const allocations = [
  { bank_line_id: 'a1', category_id: 'maint', project_id: null, amount_paise: 1000000 * RS, period: '2026-04-01' },
  // The April pay is allocated 2,00,000 salary + 80,000 groceries; 20,000 is not explained yet.
  { bank_line_id: 'a2', category_id: 'sal', project_id: null, amount_paise: 200000 * RS, period: '2026-04-01' },
  { bank_line_id: 'a2', category_id: 'groc', project_id: null, amount_paise: 80000 * RS, period: '2026-05-01' }, // belongs to May, paid in April
  { bank_line_id: 'm1', category_id: 'sink', project_id: null, amount_paise: 400000 * RS, period: '2026-05-01' },
  { bank_line_id: 'j1', category_id: 'groc', project_id: null, amount_paise: 20000 * RS, period: '2026-06-01', reverses_allocation_id: 'x' },
];

test('cashflow groups by the bank date, ties out to the bank, and carries the balance', () => {
  const cf = cashflow({ lines, allocations, categories, months: ['2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01'] });
  const apr = cf[0];
  assert.equal(apr.inPaise, 1000000 * RS);
  assert.equal(apr.outPaise, 300000 * RS);
  assert.equal(apr.netPaise, 700000 * RS);
  assert.equal(apr.closingPaise, 5700000 * RS);
  assert.equal(apr.inMaintenancePaise, 1000000 * RS);
  assert.equal(apr.inOtherPaise, 0);
  // The April payment's grocery allocation is dated May in the period view, but the cash view keeps it in April.
  assert.equal(apr.outByGroup.salary, 200000 * RS);
  assert.equal(apr.outByGroup.farm, 80000 * RS);
  assert.equal(apr.outByGroup.other, 20000 * RS); // the part nobody has explained yet
  for (const m of cf) assert.equal(GROUPS.reduce((n, g) => n + m.outByGroup[g], 0), m.outPaise);

  const may = cf[1];
  assert.equal(may.outByGroup.sinking, 400000 * RS);
  assert.equal(may.closingPaise, 5300000 * RS);
  // A refund is money in, not a negative cost, in the cash view.
  const jun = cf[2];
  assert.equal(jun.inPaise, 20000 * RS);
  assert.equal(jun.inOtherPaise, 20000 * RS);
  assert.equal(jun.outPaise, 0);
  // A month with no lines keeps the last closing balance.
  assert.equal(cf[3].closingPaise, 5320000 * RS);
  assert.equal(cf[3].inPaise, 0);
});

test('closing balances add up across two accounts and use the opening implied by the first line', () => {
  const two = [
    { id: 'x1', bank_account_id: 'one', tran_date: '2026-04-03', direction: 'debit', amount_paise: 1000 * RS, balance_paise: 9000 * RS },
    { id: 'y1', bank_account_id: 'two', tran_date: '2026-04-09', direction: 'credit', amount_paise: 500 * RS, balance_paise: 2500 * RS },
  ];
  const [apr, may] = cashflow({ lines: two, allocations: [], categories, months: ['2026-04-01', '2026-05-01'] });
  assert.equal(apr.closingPaise, 9000 * RS + 2500 * RS);
  assert.equal(may.closingPaise, apr.closingPaise);
});

test('a month before the first line has no closing balance yet', () => {
  const [mar, apr] = cashflow({ lines, allocations, categories, months: ['2026-03-01', '2026-04-01'] });
  assert.equal(mar.closingPaise, 5000000 * RS - 0); // the balance before the first line: 60,00,000 - 10,00,000
  assert.equal(apr.closingPaise, 5700000 * RS);
});

test('complete months are those whose last day has passed', () => {
  const months = fyMonths(2026);
  assert.deepEqual(completeMonths(months, '2026-07-31'), ['2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01']);
  assert.deepEqual(completeMonths(months, '2026-07-30'), ['2026-04-01', '2026-05-01', '2026-06-01']);
  assert.equal(completeMonths(months, '2027-03-31').length, 12);
});

const monthRow = (month, spend, sinking = 0) => ({ month, outPaise: spend + sinking, outByGroup: { salary: 0, farm: spend, projects: 0, company: 0, sinking, other: 0 } });

test('runway is the balance over the average spending of the last six complete months, sinking fund left out', () => {
  const rows = [
    monthRow('2026-01-01', 900 * RS), // older than the window
    monthRow('2026-02-01', 300 * RS), monthRow('2026-03-01', 300 * RS), monthRow('2026-04-01', 300 * RS, 5000 * RS),
    monthRow('2026-05-01', 300 * RS), monthRow('2026-06-01', 300 * RS), monthRow('2026-07-01', 300 * RS),
  ];
  const r = runwayOf({ months: rows, balancePaise: 1800 * RS, fdPaise: 3600 * RS });
  assert.equal(r.monthsUsed, 6);
  assert.equal(r.averageSpendPaise, 300 * RS);
  assert.equal(r.runwayMonths, 6);
  assert.equal(r.runwayWithFdMonths, 18);
});

test('runway with fewer than six months uses what exists, and is null when nothing was spent', () => {
  const two = runwayOf({ months: [monthRow('2026-05-01', 400 * RS), monthRow('2026-06-01', 200 * RS)], balancePaise: 1500 * RS, fdPaise: 0 });
  assert.equal(two.monthsUsed, 2);
  assert.equal(two.averageSpendPaise, 300 * RS);
  assert.equal(two.runwayMonths, 5);
  assert.equal(runwayOf({ months: [], balancePaise: 1500 * RS, fdPaise: 0 }).runwayMonths, null);
  assert.equal(runwayOf({ months: [monthRow('2026-05-01', 0)], balancePaise: 1500 * RS, fdPaise: 0 }).runwayMonths, null);
});

test('the sinking fund is what was put in, less what came back, up to the date', () => {
  const l = [
    { id: 's1', tran_date: '2026-05-05', direction: 'debit' },
    { id: 's2', tran_date: '2026-09-05', direction: 'credit' },
    { id: 's3', tran_date: '2026-12-05', direction: 'debit' },
  ];
  const a = [
    { bank_line_id: 's1', category_id: 'sink', amount_paise: 500 * RS },
    { bank_line_id: 's2', category_id: 'sink', amount_paise: 100 * RS },
    { bank_line_id: 's3', category_id: 'sink', amount_paise: 999 * RS },
    { bank_line_id: 's1', category_id: 'groc', amount_paise: 7 * RS },
  ];
  assert.equal(fdBalance({ lines: l, allocations: a, categories, asOf: '2026-11-10' }), 400 * RS);
});

// ---- Budget vs actual (period view) ----
const budget = {
  lines: [
    { id: 'b1', category_id: 'groc', project_id: null, label: 'Groceries', comment: 'Kitchen supplies', annual_paise: 1200 * RS },
    { id: 'b2', category_id: 'sal', project_id: null, label: 'Salary', comment: null, annual_paise: 6000 * RS },
    { id: 'b3', category_id: null, project_id: 'p1', label: 'Water storage', comment: null, annual_paise: 1000 * RS },
    { id: 'b4', category_id: 'fees', project_id: null, label: 'Accounts', comment: null, annual_paise: 500 * RS },
    { id: 'b5', category_id: 'stay', project_id: null, label: 'Guest stays', comment: null, annual_paise: 800 * RS },
    { id: 'b6', category_id: 'maint', project_id: null, label: 'Maintenance', comment: null, annual_paise: 9000 * RS },
  ],
};
const alloc = (category_id, amount, period, direction = 'debit', project_id = null) => ({ category_id, project_id, amount_paise: amount * RS, period, direction });
const spent = [
  alloc('groc', 400, '2026-04-01'), alloc('groc', 100, '2026-06-01'), alloc('groc', 50, '2026-06-01', 'credit'), // a refund nets
  alloc('groc', 999, '2025-03-01'), // last year: outside
  alloc('sal', 3000, '2026-07-01'),
  alloc('groc', 120, '2026-08-01', 'debit', 'p1'), // names a project: counts under it, not under groceries
  alloc('tank', 200, '2026-08-01', 'debit', 'p1'),
  alloc('misc', 70, '2026-08-01'), // no budget line
  alloc('stay', 300, '2026-09-01', 'credit'),
  alloc('maint', 4500, '2026-04-01', 'credit'),
];

test('budget vs actual nets refunds, keeps project money under its project, and finds spending that has no line', () => {
  const r = budgetVsActual({ budget, allocations: spent, categories, fy: 2026, today: '2026-11-10', committedPaise: 150 * RS });
  const line = (id) => r.lines.find((l) => l.id === id);
  assert.equal(line('b1').actualPaise, 450 * RS); // 400 + 100 - 50
  assert.equal(line('b1').budgetPaise, 1200 * RS);
  assert.equal(line('b1').remainingPaise, 750 * RS);
  assert.equal(line('b2').actualPaise, 3000 * RS);
  assert.equal(line('b3').actualPaise, 320 * RS); // 120 + 200
  assert.equal(line('b3').head, 'projects');
  assert.equal(line('b5').actualPaise, 300 * RS); // income counts credits
  assert.equal(line('b6').head, 'maintenance');
  assert.deepEqual(r.notBudgeted, [{ head: null, actualPaise: 70 * RS }]);
  assert.equal(r.committedPaise, 150 * RS);
});

test('outflow and inflow totals include spending that has no budget line, and the surplus is inflow less outflow', () => {
  const r = budgetVsActual({ budget, allocations: spent, categories, fy: 2026, today: '2026-11-10', committedPaise: 0 });
  assert.equal(r.totals.outflowBudgetPaise, (1200 + 6000 + 1000 + 500) * RS);
  assert.equal(r.totals.outflowActualPaise, (450 + 3000 + 320 + 0 + 70) * RS);
  assert.equal(r.totals.inflowBudgetPaise, (800 + 9000) * RS);
  assert.equal(r.totals.inflowActualPaise, (300 + 4500) * RS);
  assert.equal(r.totals.surplusPaise, r.totals.inflowActualPaise - r.totals.outflowActualPaise);
  assert.equal(r.heads.farm.actualPaise, 3450 * RS);
  assert.equal(r.heads.company.actualPaise, 0);
});

test('only the farm head gets a year-end estimate, from the share of the year gone, and a status', () => {
  const r = budgetVsActual({ budget, allocations: spent, categories, fy: 2026, today: '2026-10-01', committedPaise: 0 });
  // 1 Apr to 1 Oct inclusive is 184 days of 365.
  assert.equal(r.closed, false);
  assert.ok(Math.abs(r.yearFraction - 184 / 365) < 1e-9);
  const groc = r.lines.find((l) => l.id === 'b1');
  assert.equal(groc.estimatePaise, Math.round((450 * RS) / (184 / 365)));
  assert.equal(groc.status, 'on_track'); // an estimate of about 893 against a budget of 1,200
  assert.equal(r.lines.find((l) => l.id === 'b3').estimatePaise, null);
  assert.equal(r.lines.find((l) => l.id === 'b3').status, 'not_projected');
  assert.equal(r.lines.find((l) => l.id === 'b4').status, 'not_projected');
});

test('status thresholds: on track up to the budget, watch to 110%, over pace beyond', () => {
  const mk = (actual) => budgetVsActual({
    budget: { lines: [{ id: 'g', category_id: 'groc', project_id: null, label: 'G', comment: null, annual_paise: 1000 * RS }] },
    allocations: [alloc('groc', actual, '2026-04-01')], categories, fy: 2026, today: '2026-09-30', // 183 days: about half
  }).lines[0];
  assert.equal(mk(400).status, 'on_track');
  assert.equal(mk(520).status, 'watch');
  assert.equal(mk(700).status, 'over_pace');
});

test('a closed year has final figures, no estimate and within or over', () => {
  const closed = budgetVsActual({
    budget: { lines: [
      { id: 'u', category_id: 'groc', project_id: null, label: 'U', comment: null, annual_paise: 1000 * RS },
      { id: 'o', category_id: 'sal', project_id: null, label: 'O', comment: null, annual_paise: 1000 * RS },
      { id: 'w', category_id: 'fees', project_id: null, label: 'W', comment: null, annual_paise: 1000 * RS },
    ] },
    allocations: [alloc('groc', 900, '2025-05-01'), alloc('sal', 1050, '2025-05-01'), alloc('fees', 1500, '2025-05-01')],
    categories, fy: 2025, today: '2026-11-10',
  });
  assert.equal(closed.closed, true);
  assert.equal(closed.yearFraction, 1);
  assert.deepEqual(closed.lines.map((l) => l.status), ['within', 'over_slight', 'over']);
  assert.ok(closed.lines.every((l) => l.estimatePaise === null));
});

test('a year with no budget still reports what was spent', () => {
  const r = budgetVsActual({ budget: null, allocations: spent, categories, fy: 2026, today: '2026-11-10' });
  assert.equal(r.hasBudget, false);
  assert.equal(r.lines.length, 0);
  assert.equal(r.totals.outflowBudgetPaise, 0);
  assert.equal(r.totals.outflowActualPaise, (450 + 3000 + 320 + 70) * RS);
});

// ---- UPI circle ----
const upi = (day, amount, extra = {}) => ({ paid_at: `2026-11-${String(day).padStart(2, '0')}`, direction: 'debit', amount_paise: amount * RS, is_circle: true, ignored: false, ...extra });

test('the circle counts calendar-month spend against the cap and ignores other rows', () => {
  const rows = [
    upi(1, 800), upi(3, 1250), upi(5, 2100),
    upi(6, 5000, { is_circle: false }), upi(7, 700, { ignored: true }), upi(8, 300, { direction: 'credit' }),
    { ...upi(30, 4000), paid_at: '2026-10-30' }, // last month
  ];
  const c = circleMonth({ upiLines: rows, month: '2026-11-01', capPaise: 15000 * RS, today: '2026-11-10' });
  assert.equal(c.spentPaise, 4150 * RS);
  assert.equal(c.leftPaise, 10850 * RS);
  assert.equal(c.day, 10);
  assert.equal(c.daysInMonth, 30);
  assert.equal(c.evenPacePaise, 5000 * RS);
  assert.equal(c.aheadOfPace, false);
  assert.equal(c.runsOutOnDay, null); // at 415 a day the cap lasts past the month
});

test('the circle says when the cap runs out at this month\'s pace, and caps at the month end', () => {
  const fast = circleMonth({ upiLines: [upi(2, 9450)], month: '2026-11-01', capPaise: 15000 * RS, today: '2026-11-10' });
  assert.equal(fast.aheadOfPace, true);
  assert.equal(fast.runsOutOnDay, 15); // 945 a day: 5,550 left lasts 5.87 days after the 10th
  const over = circleMonth({ upiLines: [upi(2, 16000)], month: '2026-11-01', capPaise: 15000 * RS, today: '2026-11-10' });
  assert.equal(over.leftPaise, -1000 * RS);
  assert.equal(over.runsOutOnDay, 10);
  const past = circleMonth({ upiLines: [upi(2, 1000)], month: '2026-10-01', capPaise: 15000 * RS, today: '2026-11-10' });
  assert.equal(past.day, 31); // a finished month is judged on all its days
  assert.equal(past.spentPaise, 0);
});

// ---- Data health ----
test('health counts lines nobody has fully explained, approved requests waiting for the bank, and what is committed', () => {
  const l = [
    { id: 'h1', tran_date: '2026-10-01', amount_paise: 1000 * RS },
    { id: 'h2', tran_date: '2026-10-20', amount_paise: 1000 * RS },
    { id: 'h3', tran_date: '2026-11-02', amount_paise: 1000 * RS },
    { id: 'h4', tran_date: '2026-11-03', amount_paise: 1000 * RS },
  ];
  const a = [
    { bank_line_id: 'h2', amount_paise: 400 * RS }, // part explained
    { bank_line_id: 'h3', amount_paise: 1000 * RS }, // fully explained
  ];
  const requests = [
    { status: 'approved', bank_line_id: null, amount_paise: 300 * RS, decided_at: '2026-10-25T08:00:00Z' },
    { status: 'approved', bank_line_id: 'h4', amount_paise: 999 * RS, decided_at: '2026-10-26T08:00:00Z' }, // already matched
    { status: 'submitted', bank_line_id: null, amount_paise: 888 * RS, decided_at: null },
    { status: 'approved', bank_line_id: null, amount_paise: 200 * RS, decided_at: '2026-11-08T08:00:00Z' },
  ];
  const h = healthOf({ lines: l, allocations: a, requests, today: '2026-11-10' });
  assert.deepEqual(h.unallocated, { count: 3, oldestDate: '2026-10-01' });
  assert.deepEqual(h.awaitingBank, { count: 2, oldestDays: 16, totalPaise: 500 * RS });
  assert.equal(h.committedPaise, 500 * RS);
});

// ---- What each category and project has cost so far (the budget editor's "actual" column) ----
test('actuals by category and by project, in the period view: refunds net, income counts credits, project money stays with the project', () => {
  const a = actualsByTarget({ allocations: spent, categories, fy: 2026 });
  assert.equal(a.byCategory.groc, 450 * RS); // 400 + 100 - 50; the 120 that names a project is not here; last year's 999 is out
  assert.equal(a.byCategory.sal, 3000 * RS);
  assert.equal(a.byCategory.stay, 300 * RS); // income: credits count
  assert.equal(a.byCategory.maint, 4500 * RS);
  assert.equal(a.byCategory.misc, 70 * RS);
  assert.equal(a.byCategory.tank, undefined); // its only allocation names a project
  assert.equal(a.byProject.p1, 320 * RS); // 120 + 200
});

test('actuals of a year with nothing in it are empty, not an error', () => {
  const a = actualsByTarget({ allocations: [], categories, fy: 2026 });
  assert.deepEqual(a, { byCategory: {}, byProject: {} });
});
