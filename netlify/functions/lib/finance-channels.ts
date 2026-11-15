// The Channels view's data (/internal/finance/dashboard/#channels; docs/finance/FINANCE.md "Channels"). One read-only endpoint:
// GET /api/finance-admin/channels?fy=2026 returns the year's money summed by month, account, channel, direction and purpose
// (scripts/lib/finance-channels.mjs: the one place the rules live), plus the delegates, what each paid through which UPI app, and the
// fixed deposits' balance at each month end. The browser draws any slice of it. Needs `finance` / `view`, the same as the dashboard,
// and an auditor's visit is logged the same way. It carries no narrations or UPI ids: account labels, delegate labels and numbers
// (as on the UPI page), counts and amounts.
import { requireStaff } from './staff-access';
import { rest } from './staff-mfa-store';
import { capabilitiesForRole } from './staff-registry';
import { logFinanceAction } from './finance-audit';
import { rowsAll } from './finance-ledger';
import { loadDelegateLinks, loadDelegates } from './finance-delegates';
import { financialYearOf } from '../../../scripts/lib/finance-allocation.mjs';
import { todayIST } from '../../../scripts/lib/finance-parties.mjs';
import { attribute, delegateLabel } from '../../../scripts/lib/finance-delegates.mjs';
import { fdBalance } from '../../../scripts/lib/finance-metrics.mjs';
import { channelCube, monthsOfPeriod } from '../../../scripts/lib/finance-channels.mjs';
import { CIRCLE_CAP_PAISE } from '../../../scripts/lib/finance-upi-circle.mjs';

type Json = Record<string, any>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const rows = async (path: string): Promise<Json[]> => (await (await rest(path)).json()) as Json[];

export async function getChannels(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'view');
  if (!auth.ok) return json({ error: auth.error }, auth.status);
  const { staff } = auth;
  const today = todayIST();
  const wanted = new URL(req.url).searchParams.get('fy');
  if (wanted !== null && !/^20\d\d$/.test(wanted)) return json({ error: 'Choose a financial year.' }, 400);
  const fy = wanted ? Number(wanted) : financialYearOf(today);
  if (fy > financialYearOf(today)) return json({ error: 'That year has not started.' }, 400);

  try {
    if (staff.role === 'read_only') await logFinanceAction({ actorId: staff.id, action: 'finance.channels_viewed', detail: { fy } });

    const [lines, allocRows, categories, accounts, projects, upiJoined, upiCircle, delegates, picks] = await Promise.all([
      rowsAll('/fin_bank_lines?select=id,bank_account_id,tran_date,direction,amount_paise,narration&order=tran_date.asc,id.asc'),
      rowsAll('/fin_allocations?select=bank_line_id,category_id,project_id,amount_paise&posted_at=not.is.null&order=id.asc'),
      rows('/fin_categories?select=id,name,type,head,is_salary&order=id.asc&limit=500').catch(() => rows('/fin_categories?select=id,name,type&order=id.asc&limit=500')),
      rows('/fin_bank_accounts?select=id,label&order=created_at.asc&limit=50'),
      rows('/fin_projects?select=id,name,financial_year&order=name.asc&limit=500').catch(() => [] as Json[]),
      rowsAll('/fin_upi_lines?select=bank_line_id,app&bank_line_id=not.is.null&order=id.asc'),
      rowsAll('/fin_upi_lines?select=paid_at,app,amount_paise,upi_ref&is_circle=eq.true&direction=eq.debit&ignored=eq.false&order=paid_at.asc,id.asc'),
      loadDelegates().catch(() => []),
      loadDelegateLinks().catch(() => new Map<string, string>()),
    ]);

    const from = `${fy}-04-01`;
    const to = `${fy + 1}-03-31`;
    const inYear = lines.filter((l) => l.tran_date >= from && l.tran_date <= to);
    const upiAppByLine = new Map<string, 'bhim' | 'paytm'>(upiJoined.map((u) => [u.bank_line_id as string, u.app as 'bhim' | 'paytm']));
    const cube = channelCube({ lines: inYear, upiAppByLine, allocations: allocRows, categories });

    // The fixed deposits' balance at the end of each month of the year (what has been put in, less what came back).
    const balances: Record<string, number> = {};
    for (const month of monthsOfPeriod({ fy, today, period: 'ytd' })) {
      const [y, m] = month.split('-').map(Number);
      const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      balances[month] = fdBalance({ lines, allocations: allocRows, categories, asOf: last > today ? today : last });
    }

    // Who paid through which UPI app: a delegated payment belongs to the delegate active that day, or the one an admin picked.
    const payments = new Map<string, { m: string; d: string | null; app: string; paise: number; n: number }>();
    for (const u of upiCircle) {
      const day = String(u.paid_at);
      if (day < from || day > to) continue;
      const who = attribute({ isCircle: true, paidAt: day, upiRef: u.upi_ref }, delegates, picks) as { delegateId: string | null };
      const key = `${day.slice(0, 7)}|${who.delegateId}|${u.app}`;
      const e = payments.get(key) ?? payments.set(key, { m: day.slice(0, 7), d: who.delegateId, app: u.app as string, paise: 0, n: 0 }).get(key)!;
      e.paise += Number(u.amount_paise);
      e.n += 1;
    }

    const firstDate = lines[0]?.tran_date ?? today;
    const fyOptions: number[] = [];
    for (let y = financialYearOf(today); y >= Math.min(financialYearOf(firstDate), financialYearOf(today)); y--) fyOptions.push(y);

    return json({
      fy, fyOptions, today, hasData: lines.length > 0,
      capabilities: capabilitiesForRole('finance', staff.role),
      accounts: accounts.map((a) => ({ id: a.id, label: a.label })),
      projects: projects.filter((p) => p.financial_year === fy || cube.some((c: Json) => c.p === p.id)).map((p) => ({ id: p.id, name: p.name })),
      cube,
      delegates: delegates.map((d) => ({ id: d.id, label: delegateLabel(d), number: d.identifier, capPaise: d.capPaise ?? CIRCLE_CAP_PAISE })),
      delegatePayments: [...payments.values()],
      fd: { balances },
    });
  } catch (err) {
    console.error('[finance-channels] failed', err);
    return json({ error: 'Server error' }, 500);
  }
}
