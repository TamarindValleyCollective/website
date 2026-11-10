// The finance dashboards' data (/internal/finance/dashboard/; docs/finance/FINANCE.md "Dashboards"). One read-only endpoint:
// GET /api/finance-admin/dashboard?fy=2026 returns every figure the screens show for one financial year, worked out by the pure
// functions in scripts/lib/finance-metrics.mjs (the one place the formulas live). Needs `finance` / `view`. It carries no names,
// narrations, account numbers or UPI ids: money by month and group, budget lines, counts and dates. An auditor's visit is logged
// like the overview's, and refused if it cannot be.
import { requireStaff } from './staff-access';
import { rest } from './staff-mfa-store';
import { capabilitiesForRole } from './staff-registry';
import { logFinanceAction } from './finance-audit';
import { rowsAll } from './finance-ledger';
import { financialYearOf, periodOf } from '../../../scripts/lib/finance-allocation.mjs';
import { todayIST } from '../../../scripts/lib/finance-parties.mjs';
import { budgetVsActual, cashflow, circleMonth, completeMonths, fdBalance, fyLabel, fyMonths, healthOf, runwayOf } from '../../../scripts/lib/finance-metrics.mjs';
import { CIRCLE_CAP_PAISE, circleMonths } from '../../../scripts/lib/finance-upi-circle.mjs';

type Json = Record<string, any>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const rows = async (path: string): Promise<Json[]> => (await (await rest(path)).json()) as Json[];

const monthRange = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let m = from; m <= to; m = Number(m.slice(5, 7)) === 12 ? `${Number(m.slice(0, 4)) + 1}-01-01` : `${m.slice(0, 4)}-${String(Number(m.slice(5, 7)) + 1).padStart(2, '0')}-01`) out.push(m);
  return out;
};

// The live budget of a year: the approved version, or, when none is approved yet, the newest draft (flagged). A database
// without migration 0098 has no budget tables: that is a year with no budget, not an error.
async function loadBudget(fy: number): Promise<{ lines: Json[]; version: number; status: string; approvedOn: string | null } | null> {
  try {
    const years = await rows(`/fin_budget_years?select=id,version,status,approved_on&financial_year=eq.${fy}&status=in.(approved,draft)&order=status.asc,version.desc&limit=2`);
    const year = years[0];
    if (!year) return null;
    const lines = await rows(`/fin_budget_lines?select=id,category_id,project_id,label,comment,annual_paise,monthly_paise,sort_order&budget_year_id=eq.${year.id}&order=sort_order.asc,id.asc&limit=500`);
    return { lines, version: year.version, status: year.status, approvedOn: year.approved_on };
  } catch {
    return null;
  }
}

export async function getDashboard(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'view');
  if (!auth.ok) return json({ error: auth.error }, auth.status);
  const { staff } = auth;
  const today = todayIST();
  const wanted = new URL(req.url).searchParams.get('fy');
  if (wanted !== null && !/^20\d\d$/.test(wanted)) return json({ error: 'Choose a financial year.' }, 400);
  const fy = wanted ? Number(wanted) : financialYearOf(today);
  if (fy > financialYearOf(today)) return json({ error: 'That year has not started.' }, 400);

  try {
    if (staff.role === 'read_only') await logFinanceAction({ actorId: staff.id, action: 'finance.dashboard_viewed', detail: { fy } });

    const [lines, allocRows, categories, requests, upi, budget] = await Promise.all([
      rowsAll('/fin_bank_lines?select=id,bank_account_id,tran_date,direction,amount_paise,balance_paise&order=tran_date.asc,id.asc'),
      rowsAll('/fin_allocations?select=id,bank_line_id,category_id,project_id,amount_paise,period&posted_at=not.is.null&order=id.asc'),
      rows('/fin_categories?select=id,name,type,head,is_salary&order=id.asc&limit=500').catch(() => rows('/fin_categories?select=id,name,type&order=id.asc&limit=500')),
      rows('/fin_payment_requests?select=status,bank_line_id,amount_paise,decided_at&status=eq.approved&limit=1000'),
      rowsAll('/fin_upi_lines?select=id,paid_at,direction,amount_paise,is_circle,ignored&ignored=eq.false&order=paid_at.asc,id.asc'),
      loadBudget(fy),
    ]);

    const lineById = new Map(lines.map((l) => [l.id, l]));
    const allocations = allocRows.map((a) => ({ ...a, direction: lineById.get(a.bank_line_id)?.direction ?? 'debit' }));
    const yearEnd = `${fy + 1}-03-31`;
    const asOf = today > yearEnd ? yearEnd : today;
    const firstDate = lines[0]?.tran_date ?? today;
    const fyOptions: number[] = [];
    for (let y = financialYearOf(today); y >= Math.min(financialYearOf(firstDate), financialYearOf(today)); y--) fyOptions.push(y);

    // Cash view, month by month, from the first statement line to the date being looked at; the year's own months are
    // a slice of it, and the runway window may reach back into the previous year.
    const months = monthRange(periodOf(firstDate), periodOf(asOf));
    const cf = lines.length ? cashflow({ lines, allocations, categories, months }) : [];
    const yearMonths = new Set(fyMonths(fy));
    // The sinking fund at each month's end (what has been put in, less what came back), for the "with the sinking fund" line.
    const monthEnd = (m: string) => {
      const next = Number(m.slice(5, 7)) === 12 ? `${Number(m.slice(0, 4)) + 1}-01-01` : `${m.slice(0, 4)}-${String(Number(m.slice(5, 7)) + 1).padStart(2, '0')}-01`;
      const last = new Date(Date.parse(`${next}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
      return last > asOf ? asOf : last;
    };
    const cashflowYear = cf.filter((r: Json) => yearMonths.has(r.month)).map((r: Json) => ({
      ...r,
      partial: r.month === periodOf(today) && fy === financialYearOf(today),
      fdPaise: fdBalance({ lines, allocations, categories, asOf: monthEnd(r.month) }),
    }));
    const complete = new Set(completeMonths(months, asOf));
    const balancePaise = cf.length ? cf[cf.length - 1].closingPaise : 0;
    const fdPaise = fdBalance({ lines, allocations, categories, asOf });
    const runway = runwayOf({ months: cf.filter((r: Json) => complete.has(r.month)), balancePaise, fdPaise });

    const bva = budgetVsActual({ budget: budget ? { lines: budget.lines } : null, allocations, categories, fy, today, committedPaise: healthOf({ lines, allocations, requests, today }).committedPaise });
    const health = healthOf({ lines, allocations, requests, today });

    const upiLines = upi.map((u) => ({ ...u }));
    const circleHistory = circleMonths(upiLines.map((u) => ({ isCircle: u.is_circle, direction: u.direction, paidAt: u.paid_at, amountPaise: u.amount_paise })), CIRCLE_CAP_PAISE)
      .filter((m: Json) => m.month >= `${fy}-04` && m.month <= `${fy + 1}-03`)
      .sort((a: Json, b: Json) => (a.month < b.month ? -1 : 1));
    const circle = fy === financialYearOf(today) ? circleMonth({ upiLines, month: periodOf(today), today }) : null;

    return json({
      fy, fyLabel: fyLabel(fy), fyOptions, asOf, today, closed: today > yearEnd,
      capabilities: capabilitiesForRole('finance', staff.role),
      hasData: lines.length > 0,
      lastLineDate: lines.length ? lines[lines.length - 1].tran_date : null,
      cashflow: cashflowYear,
      runway,
      budget: { ...bva, version: budget?.version ?? null, status: budget?.status ?? null, approvedOn: budget?.approvedOn ?? null },
      circle, circleHistory, circleCapPaise: CIRCLE_CAP_PAISE,
      health,
    });
  } catch (err) {
    console.error('[finance-admin] dashboard failed', err);
    return json({ error: 'Server error' }, 500);
  }
}
