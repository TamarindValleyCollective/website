// Run with: node --test scripts/lib/finance-dashboard-view.test.mjs
// The dashboard page's formatting, charts and view models. Every amount is invented (paise).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  balanceSvg, barsInOutSvg, circleBarsSvg, healthItems, lakhText, monthsText, niceAxis, percentText, ringSvg, rupeesText, signedLakh, sparkSvg, stackedSvg, tilesOf, toLakh,
} from './finance-dashboard-view.mjs';

const RS = 100;
const row = (month, extra = {}) => ({
  month, inPaise: 0, outPaise: 0, netPaise: 0, closingPaise: 0, fdPaise: 0, inMaintenancePaise: 0, inOtherPaise: 0, partial: false,
  outByGroup: { salary: 0, farm: 0, projects: 0, company: 0, sinking: 0, other: 0 }, ...extra,
});
const months = [
  row('2026-04-01', { inPaise: 1800000 * RS, inMaintenancePaise: 1700000 * RS, outPaise: 700000 * RS, netPaise: 1100000 * RS, closingPaise: 5200000 * RS, fdPaise: 1000000 * RS, outByGroup: { salary: 400000 * RS, farm: 200000 * RS, projects: 0, company: 100000 * RS, sinking: 0, other: 0 } }),
  row('2026-05-01', { inPaise: 300000 * RS, outPaise: 450000 * RS, netPaise: -150000 * RS, closingPaise: 5050000 * RS, fdPaise: 1000000 * RS, outByGroup: { salary: 400000 * RS, farm: 30000 * RS, projects: 0, company: 0, sinking: 0, other: 20000 * RS } }),
  row('2026-06-01', { partial: true, inPaise: 0, outPaise: 100000 * RS, netPaise: -100000 * RS, closingPaise: 4950000 * RS, fdPaise: 1000000 * RS, outByGroup: { salary: 100000 * RS, farm: 0, projects: 0, company: 0, sinking: 0, other: 0 } }),
];

test('money formatting: lakh with a real minus, rupees in Indian grouping', () => {
  assert.equal(toLakh(10_000_000), 1);
  assert.equal(lakhText(5_230_000_0), '₹5.2 L');
  assert.equal(lakhText(-4_000_000), '−₹0.4 L');
  assert.equal(signedLakh(21_000_000), '+₹2.1 L');
  assert.equal(signedLakh(-4_000_000), '−₹0.4 L');
  assert.equal(rupeesText(1500000), '₹15,000');
  assert.equal(rupeesText(123456700), '₹12,34,567');
  assert.equal(rupeesText(-50000), '−₹500');
  assert.equal(percentText(1, 4), '25%');
  assert.equal(percentText(1, 0), '0%');
  assert.equal(monthsText(null), '–');
  assert.equal(monthsText(13.24), '13.2');
});

test('axes run from zero to a round top and reach the largest value', () => {
  for (const max of [0, 0.4, 3.2, 7, 13, 26, 55, 130]) {
    const a = niceAxis(max);
    assert.equal(a.ticks[0], 0);
    assert.ok(a.top >= max, `top ${a.top} reaches ${max}`);
    assert.equal(a.ticks.at(-1), a.top);
    assert.ok(a.ticks.length <= 7, `${a.ticks.length} gridlines for ${max}`);
  }
});

const clean = (markup) => {
  assert.doesNotMatch(markup, /NaN|undefined|Infinity/);
  assert.match(markup, /^<svg viewBox="0 0 \d+ \d+" role="img" aria-label="[^"]+">/);
  assert.match(markup, /<\/svg>$/);
};

test('the in and out chart has two bars and a tooltip per month, and marks a part month', () => {
  const s = barsInOutSvg(months, 600);
  clean(s);
  assert.equal((s.match(/class="bar-in/g) ?? []).length, 3);
  assert.equal((s.match(/class="bar-out/g) ?? []).length, 3);
  assert.equal((s.match(/class="hit"/g) ?? []).length, 3);
  assert.match(s, /Jun\*/);
  assert.match(s, /partial/);
  assert.match(s, /Jun \(so far\)/);
  assert.match(s, /maintenance ₹17\.0 L/);
});

test('the stacked chart draws each group once per month, with unexplained money as its own group', () => {
  const s = stackedSvg(months, 600);
  clean(s);
  assert.equal((s.match(/class="g-salary/g) ?? []).length, 3);
  assert.equal((s.match(/class="g-farm/g) ?? []).length, 2);
  assert.equal((s.match(/class="g-other/g) ?? []).length, 1);
  assert.equal((s.match(/class="g-saved/g) ?? []).length, 0);
  assert.match(s, /Not yet explained ₹0\.2 L/);
  assert.match(s, /Total ₹7\.0 L/);
});

test('the balance chart draws one line, or two with the sinking fund, and labels the last point', () => {
  const one = balanceSvg(months, 600);
  clean(one);
  assert.equal((one.match(/class="line-balance"/g) ?? []).length, 1);
  assert.equal((one.match(/class="line-fd"/g) ?? []).length, 0);
  assert.match(one, /₹49\.5 L/);
  const two = balanceSvg(months, 600, { withFd: true });
  clean(two);
  assert.equal((two.match(/class="line-fd"/g) ?? []).length, 1);
  assert.match(two, /₹59\.5 L/);
  clean(balanceSvg([], 600)); // an empty year still draws
});

test('the circle bars mark a month over the cap, and the ring says how much is used', () => {
  const history = [{ month: '2026-08', paise: 1200000 }, { month: '2026-09', paise: 1600000 }];
  const s = circleBarsSvg(history, 1500000, 500);
  clean(s);
  assert.equal((s.match(/ over"/g) ?? []).length, 1);
  assert.match(s, /Cap ₹15,000/);
  const r = ringSvg({ spentPaise: 945000, capPaise: 1500000, pct: 0.63, day: 10, daysInMonth: 30 });
  clean(r);
  assert.match(r, /ring-warn/);
  assert.match(r, /₹9,450/);
  assert.match(r, /63 percent/);
  assert.match(ringSvg({ spentPaise: 100, capPaise: 1500000, pct: 0.01, day: 1, daysInMonth: 30 }), /ring-ok/);
  assert.match(ringSvg({ spentPaise: 1600000, capPaise: 1500000, pct: 1.07, day: 12, daysInMonth: 30 }), /ring-crit/);
});

test('a spark needs at least two points', () => {
  assert.equal(sparkSvg([1]), '');
  assert.doesNotMatch(sparkSvg([3, 2, 5, 5]), /NaN/);
});

const payload = (extra = {}) => ({
  closed: false,
  cashflow: months,
  runway: { runwayMonths: 5.6, runwayWithFdMonths: 11.3, averageSpendPaise: 300000 * RS, balancePaise: 4950000 * RS },
  budget: {
    hasBudget: true, yearFraction: 0.6,
    lines: [
      { head: 'farm', budgetPaise: 1000 * RS, actualPaise: 400 * RS },
      { head: 'company', budgetPaise: 500 * RS, actualPaise: 100 * RS },
      { head: 'income', budgetPaise: 9999 * RS, actualPaise: 9999 * RS }, // income is not spending
    ],
    notBudgeted: [{ head: null, actualPaise: 50 * RS }],
  },
  health: { unallocated: { count: 14, oldestDate: '2026-10-28' }, awaitingBank: { count: 6, oldestDays: 12, totalPaise: 80000 * RS }, committedPaise: 80000 * RS },
  ...extra,
});

test('the tiles: runway, budget used (spending only, with what is not budgeted), balance and what needs attention', () => {
  const t = tilesOf(payload(), { toVerify: 3, toReview: 4, statementGaps: [] });
  assert.equal(t.runway.months, 5.6);
  assert.equal(t.budget.spentPaise, 550 * RS);
  assert.equal(t.budget.budgetPaise, 1500 * RS);
  assert.ok(Math.abs(t.budget.usedPct - 550 / 1500) < 1e-9);
  assert.equal(t.balance.paise, 4950000 * RS);
  assert.equal(t.balance.netPaise, -100000 * RS); // the month so far
  assert.equal(t.balance.series.length, 3);
  assert.equal(t.attention.count, 14 + 6 + 3 + 4);
});

test('a closed year: net for the whole year, nothing "needs attention", and no budget gives no percentage', () => {
  const t = tilesOf(payload({ closed: true, budget: { hasBudget: false, yearFraction: 1, lines: [], notBudgeted: [] } }), { toVerify: 3 });
  assert.equal(t.balance.netPaise, 1100000 * RS - 150000 * RS - 100000 * RS);
  assert.equal(t.attention.count, 0);
  assert.equal(t.budget.usedPct, null);
});

test('health items list only what is waiting, worst first, with where to fix it', () => {
  const items = healthItems(payload(), { toVerify: 2, toReview: 0, statementGaps: [{ label: 'A' }] });
  assert.deepEqual(items.map((i) => [i.count, i.tone]), [[2, 'crit'], [14, 'warn'], [6, 'warn'], [1, 'warn']]);
  assert.ok(items.every((i) => i.href.startsWith('/internal/finance/')));
  assert.match(items[1].detail, /2026-10-28/);
  assert.deepEqual(healthItems(payload({ health: { unallocated: { count: 0, oldestDate: null }, awaitingBank: { count: 0, oldestDays: 0, totalPaise: 0 }, committedPaise: 0 } }), null), []);
});
