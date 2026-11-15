// The Channels view's data (/internal/finance/dashboard/#channels; docs/finance/FINANCE.md "Channels"). Two read-only endpoints:
//   GET /api/finance-admin/channels?fy=2026
//     the year's money summed by month, account, channel, direction and purpose (scripts/lib/finance-channels.mjs: the one place the
//     rules live), plus the delegates, what each paid through which UPI app, and the fixed deposits' balance at each month end. The
//     browser draws any period and grouping of it.
//   GET /api/finance-admin/channels/lines?fy=2026&months=2026-04,2026-05&dir=out&channel=paytm&purpose=farm&account=<id>&fd=exclude
//     the lines behind one box or band of the picture: how many, how much, and the largest few (date, account, channel, purpose,
//     project, amount, and the line's id so the Ledger can open it). `&project=<id>` (or `none`) narrows money for projects to one project.
// Both need `finance` / `view`, the same as the dashboard, and an auditor's visit is logged the same way. Neither carries narrations,
// UPI ids or party names: account labels, delegate labels and numbers (as on the UPI page), counts and amounts.
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
import { UPI_APPS, cellMatches, channelCube, channelPieces, fyMonths, groupPieces, monthsSoFar } from '../../../scripts/lib/finance-channels.mjs';
import { CIRCLE_CAP_PAISE } from '../../../scripts/lib/finance-upi-circle.mjs';
import { loadOperators } from './finance-upi-operators';

type Json = Record<string, any>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const rows = async (path: string): Promise<Json[]> => (await (await rest(path)).json()) as Json[];
const LINES_SHOWN = 8;

async function loadLedger() {
  const [lines, allocRows, categories, accounts, upiJoined, parties] = await Promise.all([
    rowsAll('/fin_bank_lines?select=id,bank_account_id,tran_date,direction,amount_paise,narration&order=tran_date.asc,id.asc'),
    rowsAll('/fin_allocations?select=bank_line_id,category_id,project_id,party_id,amount_paise&posted_at=not.is.null&order=id.asc'),
    rows('/fin_categories?select=id,name,type,head,is_salary&order=id.asc&limit=500').catch(() => rows('/fin_categories?select=id,name,type&order=id.asc&limit=500')),
    rows('/fin_bank_accounts?select=id,label&order=created_at.asc&limit=50'),
    rowsAll('/fin_upi_lines?select=bank_line_id,app,paid_at,upi_ref,is_circle,operator_id&bank_line_id=not.is.null&order=id.asc').catch(() => rowsAll('/fin_upi_lines?select=bank_line_id,app,paid_at,upi_ref,is_circle&bank_line_id=not.is.null&order=id.asc')),
    rowsAll('/fin_parties?select=id,name,merged_into&order=id.asc').catch(() => rowsAll('/fin_parties?select=id,name&order=id.asc')).catch(() => [] as Json[]),
  ]);
  const upiAppByLine = new Map<string, 'bhim' | 'paytm'>(upiJoined.map((u) => [u.bank_line_id as string, u.app as 'bhim' | 'paytm']));
  return { lines, allocRows, categories, accounts, parties, upiAppByLine, upiJoined };
}

/** Signs in, checks the year, and records an auditor's visit. Returns the answer to send back, or what to carry on with. */
async function open(req: Request, what: string) {
  const auth = await requireStaff(req, 'finance', 'view');
  if (!auth.ok) return { fail: json({ error: auth.error }, auth.status) };
  const { staff } = auth;
  const today = todayIST();
  const wanted = new URL(req.url).searchParams.get('fy');
  if (wanted !== null && !/^20\d\d$/.test(wanted)) return { fail: json({ error: 'Choose a financial year.' }, 400) };
  const fy = wanted ? Number(wanted) : financialYearOf(today);
  if (fy > financialYearOf(today)) return { fail: json({ error: 'That year has not started.' }, 400) };
  if (staff.role === 'read_only') await logFinanceAction({ actorId: staff.id, action: 'finance.channels_viewed', detail: { fy, what } });
  return { staff, today, fy };
}

export async function getChannels(req: Request): Promise<Response> {
  try {
    const o = await open(req, 'map');
    if ('fail' in o) return o.fail!;
    const { staff, today, fy } = o;
    const [ledger, projects, upiCircle, delegates, picks] = await Promise.all([
      loadLedger(),
      rows('/fin_projects?select=id,name,financial_year&order=name.asc&limit=500').catch(() => [] as Json[]),
      rowsAll('/fin_upi_lines?select=paid_at,app,amount_paise,upi_ref,operator_id&is_circle=eq.true&direction=eq.debit&ignored=eq.false&order=paid_at.asc,id.asc').catch(() => rowsAll('/fin_upi_lines?select=paid_at,app,amount_paise,upi_ref&is_circle=eq.true&direction=eq.debit&ignored=eq.false&order=paid_at.asc,id.asc')),
      loadDelegates().catch(() => []),
      loadDelegateLinks().catch(() => new Map<string, string>()),
    ]);
    const { lines, allocRows, categories, accounts, upiAppByLine } = ledger;

    const from = `${fy}-04-01`;
    const to = `${fy + 1}-03-31`;
    const inYear = lines.filter((l) => l.tran_date >= from && l.tran_date <= to);
    const cube = channelCube({ lines: inYear, upiAppByLine, allocations: allocRows, categories });

    // The fixed deposits' balance at the end of each month of the year (what has been put in, less what came back).
    const balances: Record<string, number> = {};
    for (const month of monthsSoFar({ fy, today })) {
      const [y, m] = month.split('-').map(Number);
      const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      balances[month] = fdBalance({ lines, allocations: allocRows, categories, asOf: last > today ? today : last });
    }

    // Who paid through which UPI app: a delegated payment belongs to the delegate active that day, or the one an admin picked.
    const payments = new Map<string, { m: string; d: string | null; app: string; paise: number; n: number }>();
    for (const u of upiCircle) {
      const day = String(u.paid_at);
      if (day < from || day > to) continue;
      const who = attribute({ isCircle: true, paidAt: day, upiRef: u.upi_ref, operatorId: u.operator_id ?? null }, delegates, picks) as { delegateId: string | null };
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
      operators: await loadOperators(),
      fd: { balances },
    });
  } catch (err) {
    console.error('[finance-channels] failed', err);
    return json({ error: 'Server error' }, 500);
  }
}

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * The pieces (lines, split by allocation) behind a box or band, from the query: the same pieces the picture is summed from, so counts and
 * amounts agree with it. Returns { fail } with the answer to send, or the pieces and the names to put on them.
 */
async function piecesFor(req: Request, what: string) {
  const o = await open(req, what);
  if ('fail' in o) return { fail: o.fail! };
  const { fy } = o;
  const q = new URL(req.url).searchParams;
  const valid = new Set(fyMonths(fy));
  const months = (q.get('months') ?? '').split(',').filter(Boolean);
  if (!months.length || months.length > 12 || months.some((m) => !valid.has(m))) return { fail: json({ error: 'Choose months of that year.' }, 400) };
  const dir = q.get('dir');
  if (dir !== null && dir !== 'in' && dir !== 'out') return { fail: json({ error: 'Choose in or out.' }, 400) };
  const fd = q.get('fd');
  if (fd !== null && fd !== 'only' && fd !== 'exclude') return { fail: json({ error: 'Choose only or exclude.' }, 400) };
  const ids: Record<string, string | undefined> = {};
  for (const key of ['project', 'party', 'category', 'delegate', 'operator']) {
    const v = q.get(key);
    if (v !== null && v !== 'none' && !(key === 'delegate' && v === 'own') && !UUID.test(v)) return { fail: json({ error: `Choose a ${key}.` }, 400) };
    ids[key] = v ?? undefined;
  }
  const spec = { dir: dir ?? undefined, channel: q.get('channel') ?? undefined, purpose: q.get('purpose') ?? undefined, account: q.get('account') ?? undefined, fd: fd ?? undefined, ...ids };

  const { lines, allocRows, categories, accounts, parties, upiAppByLine, upiJoined } = await loadLedger();
  // The person behind a UPI payment: the delegate active that day, or the one an admin picked (the rule the UPI page uses). 'own' is the accounts' own
  // UPI (not a delegated payment); 'none' a delegated payment with no delegate chosen yet.
  const [delegates, picks] = await Promise.all([loadDelegates().catch(() => []), loadDelegateLinks().catch(() => new Map<string, string>())]);
  const delegateOf = new Map<string, string>(), operatorOf = new Map<string, string>();
  for (const u of upiJoined) {
    if (u.operator_id) operatorOf.set(u.bank_line_id as string, u.operator_id as string);
    if (!u.is_circle) { delegateOf.set(u.bank_line_id as string, 'own'); continue; }
    const who = attribute({ isCircle: true, paidAt: String(u.paid_at), upiRef: u.upi_ref, operatorId: (u.operator_id as string | null) ?? null }, delegates, picks) as { delegateId: string | null };
    delegateOf.set(u.bank_line_id as string, who.delegateId ?? 'none');
  }
  const operators = await loadOperators();
  // A party that was merged into another is that other one.
  const mergedInto = new Map<string, string>(parties.filter((p) => p.merged_into).map((p) => [p.id as string, p.merged_into as string]));
  const canon = (id: string) => { let at = id, hops = 0; while (at && mergedInto.has(at) && hops++ < 8) at = mergedInto.get(at)!; return at; };
  const from = `${fy}-04-01`;
  const to = `${fy + 1}-03-31`;
  const pieces = channelPieces({ lines: lines.filter((l) => l.tran_date >= from && l.tran_date <= to), upiAppByLine, allocations: allocRows, categories })
    .map((p: Json) => ({ ...p, party: canon(p.party), delegate: UPI_APPS.includes(p.c) ? delegateOf.get(p.lineId) ?? 'own' : '', operator: UPI_APPS.includes(p.c) ? operatorOf.get(p.lineId) ?? '' : '' }))
    .filter((p: Json) => cellMatches(p, spec, months));
  return {
    pieces: pieces as Json[],
    accounts: new Map(accounts.map((a) => [a.id as string, a.label as string])),
    partyNames: new Map(parties.map((p) => [p.id as string, p.name as string])),
    operatorNames: new Map(operators.map((o) => [o.id, o.name])),
    delegateNames: new Map(delegates.map((d) => [d.id as string, `UPI circle · ${((l: string) => (/^\d+$/.test(l) ? `Number ${l}` : l))(delegateLabel(d))}`])),
    categoryNames: new Map(categories.map((c) => [c.id as string, c.name as string])),
  };
}

/** The lines behind a box or band: how many, how much, and the largest few. */
export async function getChannelLines(req: Request): Promise<Response> {
  try {
    const r = await piecesFor(req, 'lines');
    if ('fail' in r) return r.fail!;
    const { pieces, accounts, partyNames, categoryNames } = r;
    const shown = pieces.slice().sort((a, b) => b.paise - a.paise || (a.date < b.date ? 1 : -1)).slice(0, LINES_SHOWN);
    return json({
      count: new Set(pieces.map((p) => p.lineId)).size,
      pieces: pieces.length,
      paise: pieces.reduce((t, p) => t + p.paise, 0),
      lines: shown.map((p) => ({
        id: p.lineId, date: p.date, account: accounts.get(p.a) ?? '', channel: p.c, purpose: p.g, dir: p.d, paise: p.paise, project: p.p,
        party: p.party ? partyNames.get(p.party) ?? '' : '', category: p.cat ? categoryNames.get(p.cat) ?? '' : '', uncategorised: Boolean(p.u),
      })),
    });
  } catch (err) {
    console.error('[finance-channels] lines failed', err);
    return json({ error: 'Server error' }, 500);
  }
}

/** A box or band broken down by who it was paid to or by (`by=party`) or by category (`by=category`): the rows add up to the box. */
export async function getChannelBreakdown(req: Request): Promise<Response> {
  try {
    const by = new URL(req.url).searchParams.get('by');
    if (by !== 'party' && by !== 'category' && by !== 'delegate' && by !== 'operator') return json({ error: 'Choose party, category, delegate or operator.' }, 400);
    const r = await piecesFor(req, 'breakdown');
    if ('fail' in r) return r.fail!;
    const rowsOut = groupPieces(r.pieces, by, by === 'party' ? r.partyNames : by === 'delegate' ? r.delegateNames : by === 'operator' ? r.operatorNames : r.categoryNames);
    return json({ by, rows: rowsOut, paise: rowsOut.reduce((t: number, x: Json) => t + x.paise, 0) });
  } catch (err) {
    console.error('[finance-channels] breakdown failed', err);
    return json({ error: 'Server error' }, 500);
  }
}
