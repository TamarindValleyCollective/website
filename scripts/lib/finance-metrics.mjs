// The finance dashboards' figures, defined once (docs/finance/DESIGN.md "Dashboards"; docs/finance/FINANCE.md "Dashboards").
// Pure and I/O-free so each metric is tested directly (finance-metrics.test.mjs); finance-dashboard.ts reads the rows and
// calls these. Money is integer paise.
//
// Two views, never mixed on one screen: the CASH view groups by the bank line's date (what hit the account, when);
// the PERIOD view groups by the allocation's period (the month the cost belongs to, so a March salary paid in April is
// March's). Cashflow is the cash view; budget vs actual is the period view.
import { financialYearOf, lineState, periodOf } from './finance-allocation.mjs';
import { CIRCLE_CAP_PAISE, circleMonths } from './finance-upi-circle.mjs';

/** The groups money out is split into, in the order they are stacked. `other` is money nobody has explained yet. */
export const GROUPS = ['salary', 'farm', 'projects', 'company', 'sinking', 'other'];
const HEADS = ['company', 'farm', 'projects', 'investment'];
const SPEND_HEADS = new Set(HEADS);

const sum = (rows, f) => rows.reduce((n, r) => n + f(r), 0);
const signed = (line) => (line.direction === 'credit' ? line.amount_paise : -line.amount_paise);
const pad = (n) => String(n).padStart(2, '0');

/** '2026-27': a financial year named by the year it starts. */
export const fyLabel = (fy) => `${fy}-${pad((fy + 1) % 100)}`;

/** The twelve first-of-month dates of a financial year, April first. */
export function fyMonths(fy) {
  return Array.from({ length: 12 }, (_, i) => {
    const m = 4 + i;
    return m <= 12 ? `${fy}-${pad(m)}-01` : `${fy + 1}-${pad(m - 12)}-01`;
  });
}

const nextMonth = (month) => {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;
};

/** The months whose last day is on or before `asOf` (an ISO date): the day after the last day is the next month's first. */
export function completeMonths(months, asOf) {
  const dayAfter = new Date(Date.parse(`${asOf}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  return months.filter((m) => nextMonth(m) <= dayAfter);
}

/**
 * Which group an allocation's money falls in: the sinking fund first, then anything that names a project (a project's
 * pay and materials count under the project), then salary, then the category's head. Anything else is `other`.
 */
export function groupOf(category, projectId) {
  if (!category) return 'other';
  if (category.type === 'sinking_fund') return 'sinking';
  if (projectId) return 'projects';
  if (category.is_salary) return 'salary';
  if (category.head === 'company') return 'company';
  if (category.head === 'farm') return 'farm';
  if (category.head === 'projects') return 'projects';
  if (category.head === 'investment') return 'sinking';
  return 'other';
}

/**
 * The budget head a category's money is reported under: its own head when it is spending, `income` for revenue and
 * interest, `maintenance` for member contributions, otherwise null (a spending category nobody has given a head).
 */
export function headOfCategory(category) {
  if (!category) return null;
  if (category.type === 'member_contribution') return 'maintenance';
  if (category.type === 'revenue' || category.type === 'interest') return 'income';
  if (category.type === 'sinking_fund') return 'investment';
  return HEADS.includes(category.head) ? category.head : null;
}

const byId = (rows) => new Map(rows.map((r) => [r.id, r]));
const emptyGroups = () => Object.fromEntries(GROUPS.map((g) => [g, 0]));

/**
 * Month by month, in the cash view: what came in and went out of the bank, how the out splits by group, maintenance
 * against other money in, and the closing balance. Out splits by the allocations on the debit lines of that month; the
 * part of a line nobody has allocated yet is `other`, so the groups always add up to the bank's figure. A refund is money
 * in here, not a negative cost (the period view nets it). The closing balance is the opening implied by each account's
 * first line plus every movement to the end of the month, summed over accounts.
 */
export function cashflow({ lines, allocations, categories, months }) {
  const cats = byId(categories);
  const lineById = byId(lines);
  const accounts = new Map();
  lines.forEach((l, i) => {
    const list = accounts.get(l.bank_account_id) ?? [];
    list.push({ ...l, order: i });
    accounts.set(l.bank_account_id, list);
  });
  const chains = [...accounts.values()].map((list) => {
    list.sort((a, b) => (a.tran_date < b.tran_date ? -1 : a.tran_date > b.tran_date ? 1 : a.order - b.order));
    return { list, opening: list[0].balance_paise - signed(list[0]) };
  });
  const allocByLine = new Map();
  for (const a of allocations) {
    const list = allocByLine.get(a.bank_line_id) ?? [];
    list.push(a);
    allocByLine.set(a.bank_line_id, list);
  }

  return months.map((month) => {
    const end = nextMonth(month);
    const inMonth = lines.filter((l) => l.tran_date >= month && l.tran_date < end);
    const credits = inMonth.filter((l) => l.direction === 'credit');
    const debits = inMonth.filter((l) => l.direction === 'debit');
    const outByGroup = emptyGroups();
    for (const line of debits) {
      let left = line.amount_paise;
      for (const a of allocByLine.get(line.id) ?? []) {
        outByGroup[groupOf(cats.get(a.category_id), a.project_id)] += a.amount_paise;
        left -= a.amount_paise;
      }
      if (left > 0) outByGroup.other += left;
    }
    let inMaintenancePaise = 0;
    for (const line of credits) {
      for (const a of allocByLine.get(line.id) ?? []) {
        if (cats.get(a.category_id)?.type === 'member_contribution') inMaintenancePaise += a.amount_paise;
      }
    }
    const inPaise = sum(credits, (l) => l.amount_paise);
    const outPaise = sum(debits, (l) => l.amount_paise);
    const closingPaise = sum(chains, (c) => c.opening + sum(c.list.filter((l) => l.tran_date < end), signed));
    return { month, inPaise, outPaise, netPaise: inPaise - outPaise, closingPaise, inMaintenancePaise, inOtherPaise: inPaise - inMaintenancePaise, outByGroup };
  });
}

/** Spending of one cashflow month: everything out except the sinking fund (saved, not spent). */
export const spendingOf = (row) => row.outPaise - row.outByGroup.sinking;

/**
 * Runway: the bank balance divided by the average monthly spending of the last six complete months, with the sinking
 * fund left out of the spending. It ignores money still to come, because maintenance arrives in lumps and a net figure
 * would swing with every collection. Fewer than six months uses what exists; no spending gives null.
 * `months` are cashflow rows already limited to complete months, oldest first.
 */
export function runwayOf({ months, balancePaise, fdPaise }) {
  const window = months.slice(-6);
  const spend = sum(window, spendingOf);
  const averageSpendPaise = window.length ? Math.round(spend / window.length) : 0;
  const ok = window.length > 0 && averageSpendPaise > 0;
  return {
    monthsUsed: window.length,
    averageSpendPaise,
    balancePaise,
    fdPaise,
    runwayMonths: ok ? balancePaise / averageSpendPaise : null,
    runwayWithFdMonths: ok ? (balancePaise + fdPaise) / averageSpendPaise : null,
  };
}

/** What has been put into the sinking fund, less what came back, up to and including `asOf`. */
export function fdBalance({ lines, allocations, categories, asOf }) {
  const cats = byId(categories);
  const lineById = byId(lines);
  let total = 0;
  for (const a of allocations) {
    if (cats.get(a.category_id)?.type !== 'sinking_fund') continue;
    const line = lineById.get(a.bank_line_id);
    if (!line || line.tran_date > asOf) continue;
    total += line.direction === 'debit' ? a.amount_paise : -a.amount_paise;
  }
  return total;
}

const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/**
 * Budget against actual for one financial year, in the period view. `budget` is { lines: [{ id, category_id, project_id,
 * label, comment, annual_paise }] } (the live version) or null. Actuals net refunds: a debit counts as spending and a
 * credit against the same line reduces it (income and maintenance count credits). A category line counts only
 * allocations that name no project; a project line counts the ones that name it. Spending with no line is reported under
 * `notBudgeted`, so the totals always cover everything that was spent. Only the farm's running costs get a year-end
 * estimate (actual over the share of the year gone); everything else arrives in lumps.
 * allocations: [{ category_id, project_id, amount_paise, direction, period }]
 */
export function budgetVsActual({ budget, allocations, categories, fy, today, committedPaise = 0 }) {
  const cats = byId(categories);
  const months = new Set(fyMonths(fy));
  const yearEnd = `${fy + 1}-03-31`;
  const closed = today > yearEnd;
  const daysInYear = daysBetween(`${fy}-04-01`, `${fy + 1}-04-01`);
  const yearFraction = closed ? 1 : Math.min(1, Math.max(0, (daysBetween(`${fy}-04-01`, today) + 1) / daysInYear));

  const budgetLines = budget?.lines ?? [];
  const inYear = allocations.filter((a) => months.has(a.period));
  const actualOf = (head, rows) => sum(rows, (a) => {
    const isIncome = head === 'income' || head === 'maintenance';
    return (a.direction === (isIncome ? 'credit' : 'debit') ? 1 : -1) * a.amount_paise;
  });

  const claimed = new Set();
  const lines = budgetLines.map((l) => {
    const rows = l.project_id
      ? inYear.filter((a) => a.project_id === l.project_id)
      : inYear.filter((a) => a.category_id === l.category_id && !a.project_id);
    rows.forEach((a) => claimed.add(a));
    const head = l.project_id ? 'projects' : headOfCategory(cats.get(l.category_id));
    const actualPaise = actualOf(head, rows);
    const budgetPaise = l.annual_paise;
    const running = head === 'farm' && !closed;
    const estimatePaise = running && yearFraction > 0 ? Math.round(actualPaise / yearFraction) : null;
    let status;
    if (closed) status = actualPaise <= budgetPaise ? 'within' : actualPaise <= budgetPaise * 1.1 ? 'over_slight' : 'over';
    else if (!running || !SPEND_HEADS.has(head)) status = 'not_projected';
    else status = estimatePaise <= budgetPaise ? 'on_track' : estimatePaise <= budgetPaise * 1.1 ? 'watch' : 'over_pace';
    return { id: l.id, head, label: l.label, comment: l.comment ?? null, budgetPaise, actualPaise, remainingPaise: budgetPaise - actualPaise, estimatePaise, status };
  });

  // Whatever no line claimed: spending (by head, or none) is "not budgeted"; unclaimed income is simply not listed.
  const notBudgeted = [];
  const loose = inYear.filter((a) => !claimed.has(a));
  const heads = new Set(loose.map((a) => (a.project_id ? 'projects' : headOfCategory(cats.get(a.category_id)))));
  for (const head of heads) {
    if (head === 'income' || head === 'maintenance') continue;
    const rows = loose.filter((a) => (a.project_id ? 'projects' : headOfCategory(cats.get(a.category_id))) === head);
    const actualPaise = actualOf(head, rows);
    if (actualPaise !== 0) notBudgeted.push({ head, actualPaise });
  }

  const headTotals = Object.fromEntries([...HEADS, 'income', 'maintenance'].map((h) => [h, { budgetPaise: 0, actualPaise: 0 }]));
  for (const l of lines) {
    if (!headTotals[l.head]) continue;
    headTotals[l.head].budgetPaise += l.budgetPaise;
    headTotals[l.head].actualPaise += l.actualPaise;
  }
  for (const n of notBudgeted) if (n.head && headTotals[n.head]) headTotals[n.head].actualPaise += n.actualPaise;
  const outflowBudgetPaise = sum(HEADS, (h) => headTotals[h].budgetPaise);
  const outflowActualPaise = sum(HEADS, (h) => headTotals[h].actualPaise) + sum(notBudgeted.filter((n) => !n.head), (n) => n.actualPaise);
  const inflowBudgetPaise = headTotals.income.budgetPaise + headTotals.maintenance.budgetPaise;
  const inflowActualPaise = headTotals.income.actualPaise + headTotals.maintenance.actualPaise;
  return {
    fy, hasBudget: budgetLines.length > 0, closed, yearFraction, committedPaise,
    lines, notBudgeted, heads: headTotals,
    totals: { outflowBudgetPaise, outflowActualPaise, inflowBudgetPaise, inflowActualPaise, surplusPaise: inflowActualPaise - outflowActualPaise },
  };
}

/**
 * The circle's month: debit rows tagged for the circle, not ignored, dated in the calendar month, against the monthly cap.
 * `day` is today's day for the current month, the whole month once it is over. `runsOutOnDay` is an estimate from this
 * month's pace (null when the cap lasts the month); it is the day itself when the cap is already used.
 */
export function circleMonth({ upiLines, month, capPaise = CIRCLE_CAP_PAISE, today }) {
  const end = nextMonth(month);
  const daysInMonth = daysBetween(month, end);
  const day = today >= end ? daysInMonth : today < month ? 0 : Number(today.slice(8, 10));
  // The rule for what counts (a circle payment out, in a calendar month) lives in finance-upi-circle.mjs; this adds the pace.
  const rows = upiLines.filter((r) => !r.ignored && r.paid_at >= month && r.paid_at < end)
    .map((r) => ({ isCircle: r.is_circle, direction: r.direction, paidAt: r.paid_at, amountPaise: r.amount_paise }));
  const spentPaise = circleMonths(rows, capPaise).find((m) => m.month === month.slice(0, 7))?.paise ?? 0;
  const evenPacePaise = Math.round((capPaise * day) / daysInMonth);
  let runsOutOnDay = null;
  if (spentPaise >= capPaise) runsOutOnDay = day;
  else if (spentPaise > 0 && day > 0 && day < daysInMonth) {
    const reach = Math.floor(day + (capPaise - spentPaise) / (spentPaise / day));
    runsOutOnDay = reach <= daysInMonth ? reach : null;
  }
  return { month, capPaise, spentPaise, leftPaise: capPaise - spentPaise, pct: capPaise ? spentPaise / capPaise : 0, day, daysInMonth, evenPacePaise, aheadOfPace: spentPaise > evenPacePaise, runsOutOnDay };
}

/**
 * What the books still owe a person: bank lines not fully explained, approved requests the bank statement has not shown
 * yet (which are also what is "committed"), with the oldest of each. Counts and dates only.
 */
export function healthOf({ lines, allocations, requests, today }) {
  const allocByLine = new Map();
  for (const a of allocations) allocByLine.set(a.bank_line_id, [...(allocByLine.get(a.bank_line_id) ?? []), a]);
  const open = lines.filter((l) => lineState(l, allocByLine.get(l.id) ?? []) !== 'allocated');
  const oldestDate = open.map((l) => l.tran_date).sort()[0] ?? null;
  const waiting = requests.filter((r) => r.status === 'approved' && !r.bank_line_id);
  const oldestDecided = waiting.map((r) => (r.decided_at ?? '').slice(0, 10)).filter(Boolean).sort()[0];
  const totalPaise = sum(waiting, (r) => r.amount_paise);
  return {
    unallocated: { count: open.length, oldestDate },
    awaitingBank: { count: waiting.length, oldestDays: oldestDecided ? daysBetween(oldestDecided, today) : 0, totalPaise },
    committedPaise: totalPaise,
  };
}

export { financialYearOf, periodOf, addDays };
