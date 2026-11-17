// Payroll runs (docs/finance/sessions/09-payroll.md, 09a, migration 0105). The rules are scripts/lib/finance-payroll.mjs (who may
// move a run, what a run must look like) and finance-payroll-file.mjs (the bank file and the payee guard), both pure and tested; this
// file reads, writes and asks who the caller is.
//
// Who sees salaries: only the three people the brief names. The farm manager (`finance-requests` payroll-input) enters and
// confirms; a director with `finance` export prepares the file; a director with `finance` approve-payroll approves it, and never
// the one who prepared it. A plain `finance` view, `request` or `read_only` grant (an auditor's included) opens nothing here.
// Generating, downloading and approving need the MFA step-up, because the file holds every account number.
//
// Account numbers: stored encrypted on fin_party_accounts and decrypted only inside generate, to build the file. A run's lines keep
// the last four and a fingerprint (a snapshot of what was paid); no response carries a number, and fin_audit_log holds ids and
// counts only.
//
// The debit account (column H) is a server setting, FINANCE_PAYROLL_DEBIT_ACCOUNT: the ledger keeps only the last four digits.
import { createHash, randomUUID } from 'node:crypto';
import { requireStaff } from './staff-access';
import { stepUpIsValid } from './staff-admin-guard';
import { decryptFinanceText } from './staff-mfa-crypto';
import { rest } from './staff-mfa-store';
import { logFinanceAction } from './finance-audit';
import { getFinancePayroll, putFinancePayroll } from './finance-storage';
import { todayIST } from '../../../scripts/lib/finance-parties.mjs';
import { accountPayableOn } from '../../../scripts/lib/finance-parties.mjs';
import { confirmationRows, decideAction, runSummary, validateRunInput } from '../../../scripts/lib/finance-payroll.mjs';
import { payrollBlockers, salaryFileBytes, validatePaymentDate } from '../../../scripts/lib/finance-payroll-file.mjs';

type Json = Record<string, any>;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const PAYROLL_ID = ID;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const fail = (error: string, status = 400, code?: string) => json({ error, ...(code ? { code } : {}) }, status);
const serverError = (err: unknown, what: string) => {
  console.error(`[finance-payroll] ${what} failed`, err instanceof Error ? err.message : err);
  return json({ error: 'Server error' }, 500);
};
const rows = async (path: string): Promise<Json[]> => (await (await rest(path)).json()) as Json[];
async function entityId(): Promise<string> {
  const e = await rows('/fin_entities?select=id&order=created_at.asc&limit=1');
  if (!e[0]) throw new Error('no entity');
  return e[0].id as string;
}
async function body(req: Request): Promise<Json | null> {
  try {
    const b = await req.json();
    return b && typeof b === 'object' ? (b as Json) : null;
  } catch {
    return null;
  }
}

type Access = { staff: { id: string; name?: string | null; email: string }; canEnter: boolean; canPrepare: boolean; canApprove: boolean };

// Any one of the three payroll roles opens the pages; which actions they may take is decided per action.
export async function payrollAccess(req: Request): Promise<{ ok: true; access: Access } | { ok: false; response: Response }> {
  const [enter, prepare, approve] = await Promise.all([
    requireStaff(req, 'finance-requests', 'payroll-input'),
    requireStaff(req, 'finance', 'export'),
    requireStaff(req, 'finance', 'approve-payroll'),
  ]);
  const who = enter.ok ? enter : prepare.ok ? prepare : approve.ok ? approve : null;
  if (!who || !who.ok) {
    const failed = [enter, prepare, approve].find((a) => !a.ok && a.status !== 403) as { status: number; error: string } | undefined;
    return { ok: false, response: fail(failed?.error ?? 'Not authorized', failed?.status ?? 403) };
  }
  return { ok: true, access: { staff: who.staff, canEnter: enter.ok, canPrepare: prepare.ok, canApprove: approve.ok } };
}

const RUN_COLUMNS = 'id,month,status,payment_mode,payment_date,entered_by,confirmed_by,confirmed_at,prepared_by,batch_id,approved_by,approved_at,settled_at,cancelled_reason,created_at';

async function loadRun(id: string): Promise<Json | null> {
  const [run] = await rows(`/fin_payroll_runs?id=eq.${id}&select=${RUN_COLUMNS}`);
  if (!run) return null;
  const batch = run.batch_id ? (await rows(`/fin_payment_batches?id=eq.${run.batch_id}&select=id,status,total_paise,line_count,payment_date,prepared_by,prepared_at,approved_by,approved_at`))[0] : null;
  return { ...run, batch: batch ?? null };
}

// The payee account a person would be paid to today: a payable one if there is one, otherwise the newest that is not replaced.
async function liveAccounts(partyIds: string[]): Promise<Map<string, Json | null>> {
  const out = new Map<string, Json | null>();
  if (!partyIds.length) return out;
  const accounts = await rows(`/fin_party_accounts?party_id=in.(${partyIds.join(',')})&method=eq.bank&status=neq.superseded&select=id,party_id,status,valid_from,retired_on,fingerprint,last4,details_enc,created_at&order=created_at.desc`);
  const today = todayIST();
  for (const pid of partyIds) {
    const mine = accounts.filter((a) => a.party_id === pid);
    out.set(pid, mine.find((a) => accountPayableOn(a, today).payable) ?? mine[0] ?? null);
  }
  return out;
}

// The fingerprint each person was last paid to, from earlier runs whose file was generated.
async function previousFingerprints(employeeIds: string[], beforeMonth: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!employeeIds.length) return out;
  const lines = await rows(`/fin_payroll_lines?employee_id=in.(${employeeIds.join(',')})&account_fingerprint=not.is.null&select=employee_id,run_id,account_fingerprint`);
  if (!lines.length) return out;
  const runs = await rows(`/fin_payroll_runs?id=in.(${[...new Set(lines.map((l) => l.run_id))].join(',')})&status=in.(file_generated,approved,settled)&month=lt.${beforeMonth}&select=id,month`);
  const monthOf = new Map(runs.map((r) => [r.id as string, r.month as string]));
  const best = new Map<string, string>();
  for (const l of lines) {
    const m = monthOf.get(l.run_id);
    if (!m) continue;
    if (!best.has(l.employee_id) || m > (best.get(l.employee_id) as string)) {
      best.set(l.employee_id, m);
      out.set(l.employee_id, l.account_fingerprint);
    }
  }
  return out;
}

async function runLines(runId: string): Promise<Json[]> {
  const lines = await rows(`/fin_payroll_lines?run_id=eq.${runId}&select=id,employee_id,net_paise,agreed_pay_paise,days_worked,advance_deducted_paise,party_account_id,account_last4,account_fingerprint,reference,returned_at`);
  if (!lines.length) return [];
  const emps = await rows(`/fin_employees?id=in.(${lines.map((l) => l.employee_id).join(',')})&select=id,party_id,roll_no`);
  const parties = await rows(`/fin_parties?id=in.(${emps.map((e) => e.party_id).join(',')})&select=id,name,merged_into`);
  const empById = new Map(emps.map((e) => [e.id, e]));
  const nameOf = new Map(parties.map((p) => [p.id, p.name]));
  return lines
    .map((l) => ({ ...l, partyId: empById.get(l.employee_id)?.party_id, rollNo: empById.get(l.employee_id)?.roll_no ?? null, name: nameOf.get(empById.get(l.employee_id)?.party_id) ?? 'Unknown' }))
    .sort((a, b) => String(a.rollNo ?? '~').localeCompare(String(b.rollNo ?? '~'), 'en', { numeric: true }) || a.name.localeCompare(b.name));
}

// What a person sees of a run: lines with the account as last four digits only, what changed, what blocks.
async function runView(run: Json, access: Access) {
  const lines = await runLines(run.id);
  const frozen = ['file_generated', 'approved', 'settled'].includes(run.status);
  const live = frozen ? new Map<string, Json | null>() : await liveAccounts([...new Set(lines.map((l) => l.partyId))]);
  const previous = await previousFingerprints(lines.map((l) => l.employee_id), run.month);
  const today = todayIST();
  const conf = confirmationRows(
    lines.map((l) => {
      const acct = frozen ? { last4: l.account_last4, fingerprint: l.account_fingerprint, status: 'verified' } : live.get(l.partyId);
      return {
        name: l.name,
        netPaise: Number(l.net_paise),
        last4: acct?.last4 ?? null,
        fingerprint: acct?.fingerprint ?? null,
        previousFingerprint: previous.get(l.employee_id) ?? null,
        payable: frozen ? true : acct ? accountPayableOn(acct, today).payable : false,
      };
    }),
  );
  return {
    run: {
      id: run.id, month: String(run.month).slice(0, 7), status: run.status, paymentMode: run.payment_mode, paymentDate: run.payment_date,
      confirmedAt: run.confirmed_at, approvedAt: run.approved_at, cancelledReason: run.cancelled_reason,
      preparedByMe: run.prepared_by === access.staff.id, batch: run.batch ? { status: run.batch.status, totalPaise: Number(run.batch.total_paise), lineCount: run.batch.line_count } : null,
      stale: run.status === 'file_generated' && run.batch?.status !== 'approved_at_bank' && String(run.payment_date) < today,
      ...runSummary({ status: run.status, batchStatus: run.batch?.status ?? null }),
    },
    lines: lines.map((l, i) => ({
      id: l.id, employeeId: l.employee_id, name: l.name, rollNo: l.rollNo, netPaise: Number(l.net_paise),
      agreedPayPaise: l.agreed_pay_paise == null ? null : Number(l.agreed_pay_paise), daysWorked: l.days_worked == null ? null : Number(l.days_worked),
      advanceDeductedPaise: l.advance_deducted_paise == null ? null : Number(l.advance_deducted_paise),
      last4: conf.rows[i].last4, changed: conf.rows[i].changed, problem: conf.rows[i].problem, reference: l.reference, returned: Boolean(l.returned_at),
    })),
    totalPaise: conf.totalPaise,
    changed: conf.changed,
    problems: conf.problems,
  };
}

// GET /payroll: the runs, the people who can be paid, and what the caller may do.
export async function listPayroll(req: Request): Promise<Response> {
  const gate = await payrollAccess(req);
  if (!gate.ok) return gate.response;
  const { access } = gate;
  try {
    const [runs, employees, lines] = await Promise.all([
      rows(`/fin_payroll_runs?select=${RUN_COLUMNS}&order=month.desc,created_at.desc&limit=36`),
      rows('/fin_employees?select=id,party_id,roll_no,active&order=roll_no.asc'),
      rows('/fin_payroll_lines?select=run_id,net_paise&limit=5000'),
    ]);
    const batches = runs.some((r) => r.batch_id) ? await rows(`/fin_payment_batches?id=in.(${runs.filter((r) => r.batch_id).map((r) => r.batch_id).join(',')})&select=id,status`) : [];
    const batchStatus = new Map(batches.map((b) => [b.id, b.status]));
    const parties = employees.length ? await rows(`/fin_parties?id=in.(${employees.map((e) => e.party_id).join(',')})&select=id,name`) : [];
    const nameOf = new Map(parties.map((p) => [p.id, p.name]));
    const totals = new Map<string, { count: number; total: number }>();
    for (const l of lines) {
      const t = totals.get(l.run_id) ?? { count: 0, total: 0 };
      t.count += 1;
      t.total += Number(l.net_paise);
      totals.set(l.run_id, t);
    }
    // People whose party is of kind 'employee' but who are not employees yet: the director adds them here, not on Parties.
    const known = new Set(employees.map((e) => e.party_id));
    const candidates = (await rows("/fin_parties?kind=eq.employee&active=eq.true&merged_into=is.null&select=id,name&order=name.asc")).filter((p) => !known.has(p.id));
    return json({
      me: { id: access.staff.id, canEnter: access.canEnter, canPrepare: access.canPrepare, canApprove: access.canApprove, stepUpValid: stepUpIsValid(req, access.staff.id) },
      today: todayIST(),
      runs: runs.map((r) => ({
        id: r.id, month: String(r.month).slice(0, 7), status: r.status, paymentDate: r.payment_date, count: totals.get(r.id)?.count ?? 0, totalPaise: totals.get(r.id)?.total ?? 0,
        ...runSummary({ status: r.status, batchStatus: batchStatus.get(r.batch_id) ?? null }),
      })),
      employees: employees.map((e) => ({ id: e.id, name: nameOf.get(e.party_id) ?? 'Unknown', rollNo: e.roll_no, active: e.active })),
      candidates,
    });
  } catch (err) {
    return serverError(err, 'list');
  }
}

export async function getRun(req: Request, id: string): Promise<Response> {
  const gate = await payrollAccess(req);
  if (!gate.ok) return gate.response;
  try {
    const run = await loadRun(id);
    if (!run) return fail('Not found', 404);
    return json(await runView(run, gate.access));
  } catch (err) {
    return serverError(err, 'get run');
  }
}

// POST /payroll/employees: make a party of kind employee payable by payroll.
export async function addEmployee(req: Request): Promise<Response> {
  const gate = await payrollAccess(req);
  if (!gate.ok) return gate.response;
  const { access } = gate;
  if (!access.canPrepare) return fail('Only a director can add a person to payroll.', 403);
  const b = await body(req);
  if (!b || typeof b.partyId !== 'string' || !ID.test(b.partyId)) return fail('Choose the person from the list.');
  const rollNo = typeof b.rollNo === 'string' && b.rollNo.trim() ? b.rollNo.trim() : null;
  if (rollNo && rollNo.length > 20) return fail('The roll number is too long.');
  try {
    const [party] = await rows(`/fin_parties?id=eq.${b.partyId}&select=id,kind,active,merged_into`);
    if (!party || !party.active || party.merged_into || party.kind !== 'employee') return fail('Choose a person whose party is of kind employee.');
    const entity = await entityId();
    await logFinanceAction({ actorId: access.staff.id, entityId: entity, action: 'finance.payroll_employee_added', target: party.id });
    const res = await rest('/fin_employees', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ entity_id: entity, party_id: party.id, roll_no: rollNo, created_by: access.staff.id }) });
    if (res.status === 409) return fail('That person, or that roll number, is already on payroll.', 409);
    const [created] = (await res.json()) as Json[];
    return json({ id: created.id }, 201);
  } catch (err) {
    if (err instanceof Error && /duplicate key|23505|409/.test(err.message)) return fail('That person, or that roll number, is already on payroll.', 409);
    return serverError(err, 'add employee');
  }
}

async function writeLines(runId: string, lines: Json[]) {
  await rest(`/fin_payroll_lines?run_id=eq.${runId}`, { method: 'DELETE' });
  await rest('/fin_payroll_lines', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(lines.map((l) => ({ run_id: runId, employee_id: l.employeeId, net_paise: l.netPaise, agreed_pay_paise: l.agreedPayPaise, days_worked: l.daysWorked, advance_deducted_paise: l.advanceDeductedPaise }))),
  });
}

async function checkEmployees(lines: Json[]): Promise<string | null> {
  const emps = await rows(`/fin_employees?id=in.(${lines.map((l) => l.employeeId).join(',')})&select=id,active`);
  if (emps.length !== lines.length) return 'Choose each person from the list.';
  if (emps.some((e) => !e.active)) return 'One of these people is no longer on payroll.';
  return null;
}

// POST /payroll/runs: a new draft for a month.
export async function createRun(req: Request): Promise<Response> {
  const gate = await payrollAccess(req);
  if (!gate.ok) return gate.response;
  const { access } = gate;
  if (!access.canEnter) return fail('Only the person who enters the salaries can start a run.', 403);
  const b = await body(req);
  if (!b) return fail('Send the details as JSON.');
  const checked = validateRunInput(b, { today: todayIST() });
  if (checked.error || !checked.value) return fail(checked.error ?? 'Check the details.');
  const v = checked.value as Json;
  try {
    const problem = await checkEmployees(v.lines);
    if (problem) return fail(problem);
    const entity = await entityId();
    const existing = await rows(`/fin_payroll_runs?entity_id=eq.${entity}&month=eq.${v.month}&status=neq.cancelled&select=id`);
    if (existing[0]) return fail('There is already a run for that month.', 409);
    await logFinanceAction({ actorId: access.staff.id, entityId: entity, action: 'finance.payroll_run_created', detail: { month: v.month, lines: v.lines.length } });
    const res = await rest('/fin_payroll_runs', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ entity_id: entity, month: v.month, payment_mode: v.paymentMode, payment_date: v.paymentDate, entered_by: access.staff.id }) });
    if (res.status === 409) return fail('There is already a run for that month.', 409);
    const [created] = (await res.json()) as Json[];
    await writeLines(created.id, v.lines);
    return json({ id: created.id }, 201);
  } catch (err) {
    if (err instanceof Error && /duplicate key|23505|409/.test(err.message)) return fail('There is already a run for that month.', 409);
    return serverError(err, 'create run');
  }
}

// PUT /payroll/runs/:id: replace a draft's amounts, date and mode.
export async function updateRun(req: Request, id: string): Promise<Response> {
  const gate = await payrollAccess(req);
  if (!gate.ok) return gate.response;
  const { access } = gate;
  if (!access.canEnter) return fail('Only the person who enters the salaries can change them.', 403);
  const b = await body(req);
  if (!b) return fail('Send the details as JSON.');
  try {
    const run = await loadRun(id);
    if (!run) return fail('Not found', 404);
    if (run.status !== 'draft') return fail('Only a draft run can be changed. Reopen it first.');
    const checked = validateRunInput({ ...b, month: String(run.month).slice(0, 7) }, { today: todayIST() });
    if (checked.error || !checked.value) return fail(checked.error ?? 'Check the details.');
    const v = checked.value as Json;
    const problem = await checkEmployees(v.lines);
    if (problem) return fail(problem);
    await logFinanceAction({ actorId: access.staff.id, entityId: await entityId(), action: 'finance.payroll_run_edited', target: id, detail: { lines: v.lines.length } });
    await rest(`/fin_payroll_runs?id=eq.${id}&status=eq.draft`, { method: 'PATCH', body: JSON.stringify({ payment_mode: v.paymentMode, payment_date: v.paymentDate, updated_at: new Date().toISOString() }) });
    await writeLines(id, v.lines);
    return json({ ok: true });
  } catch (err) {
    return serverError(err, 'update run');
  }
}

// Moves a run only if it is still in the state we read (two people cannot both move it).
async function moveRun(id: string, from: string, patch: Json): Promise<boolean> {
  const res = await rest(`/fin_payroll_runs?id=eq.${id}&status=eq.${from}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }) });
  return ((await res.json()) as Json[]).length === 1;
}

const STEP_UP_ACTIONS = new Set(['generate', 'approve']);

// POST /payroll/runs/:id/action { action, paymentDate?, reason? }
export async function runAction(req: Request, id: string): Promise<Response> {
  const gate = await payrollAccess(req);
  if (!gate.ok) return gate.response;
  const { access } = gate;
  const b = await body(req);
  if (!b || typeof b.action !== 'string') return fail('Choose an action.');
  try {
    const run = await loadRun(id);
    if (!run) return fail('Not found', 404);
    const today = todayIST();
    const lineCount = (await rows(`/fin_payroll_lines?run_id=eq.${id}&select=id`)).length;
    let paymentDate: string = run.payment_date;
    if (b.action === 'generate' && b.paymentDate != null) {
      const pd = validatePaymentDate(b.paymentDate, today);
      if (pd.error) return fail(pd.error);
      paymentDate = b.paymentDate;
    }
    const verdict = decideAction(
      { status: run.status, lineCount, enteredBy: run.entered_by, preparedBy: run.prepared_by, batchStatus: run.batch?.status ?? null, paymentDate },
      b.action,
      { id: access.staff.id, canEnter: access.canEnter, canPrepare: access.canPrepare, canApprove: access.canApprove },
      { today },
    ) as { ok: boolean; to?: string; batchTo?: string; error?: string };
    if (!verdict.ok || !verdict.to) return fail(verdict.error ?? 'Not allowed.', 403);
    if (STEP_UP_ACTIONS.has(b.action) && !stepUpIsValid(req, access.staff.id)) return fail('Verify a second factor first.', 403, 'STEP_UP_REQUIRED');
    const entity = await entityId();
    const audit = (extra: Json = {}) => logFinanceAction({ actorId: access.staff.id, entityId: entity, action: `finance.payroll_${b.action}`, target: id, detail: { month: String(run.month).slice(0, 7), ...extra } });
    const now = new Date().toISOString();

    if (b.action === 'confirm') {
      await audit();
      if (!(await moveRun(id, 'draft', { status: 'confirmed', confirmed_by: access.staff.id, confirmed_at: now }))) return fail('The run changed while you were looking at it. Reload.', 409);
    } else if (b.action === 'reopen') {
      await audit();
      if (!(await moveRun(id, 'confirmed', { status: 'draft', confirmed_by: null, confirmed_at: null }))) return fail('The run changed while you were looking at it. Reload.', 409);
    } else if (b.action === 'cancel') {
      const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
      if (reason.length < 3 || reason.length > 200) return fail('Say why, in a few words.');
      await audit();
      if (run.batch_id && run.batch?.status !== 'approved_at_bank') await rest(`/fin_payment_batches?id=eq.${run.batch_id}`, { method: 'PATCH', body: JSON.stringify({ status: 'cancelled' }) });
      if (!(await moveRun(id, run.status, { status: 'cancelled', cancelled_reason: reason }))) return fail('The run changed while you were looking at it. Reload.', 409);
    } else if (b.action === 'regenerate') {
      await audit();
      if (run.batch_id) await rest(`/fin_payment_batches?id=eq.${run.batch_id}`, { method: 'PATCH', body: JSON.stringify({ status: 'cancelled' }) });
      if (!(await moveRun(id, 'file_generated', { status: 'confirmed', prepared_by: null, batch_id: null }))) return fail('The run changed while you were looking at it. Reload.', 409);
    } else if (b.action === 'mark_uploaded') {
      await audit();
      await rest(`/fin_payment_batches?id=eq.${run.batch_id}&status=eq.file_generated`, { method: 'PATCH', body: JSON.stringify({ status: 'uploaded', uploaded_at: now }) });
    } else if (b.action === 'approve') {
      await audit();
      // The batch first: the database refuses an approver who is also the preparer, so a refusal leaves the run untouched.
      const res = await rest(`/fin_payment_batches?id=eq.${run.batch_id}&status=eq.uploaded`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ status: 'approved_at_bank', approved_by: access.staff.id, approved_at: now }) });
      if (!res.ok || ((await res.json()) as Json[]).length !== 1) return fail('Could not approve: the file is no longer waiting for approval.', 409);
      if (!(await moveRun(id, 'file_generated', { status: 'approved', approved_by: access.staff.id, approved_at: now }))) return fail('The run changed while you were looking at it. Reload.', 409);
    } else if (b.action === 'generate') {
      return await generate(req, run, access, entity, paymentDate, today);
    }
    return json({ ok: true, status: verdict.to });
  } catch (err) {
    return serverError(err, `action ${b.action}`);
  }
}

async function generate(req: Request, run: Json, access: Access, entity: string, paymentDate: string, today: string): Promise<Response> {
  const debitAccount = process.env.FINANCE_PAYROLL_DEBIT_ACCOUNT ?? '';
  if (!debitAccount) return fail('The company debit account is not configured yet (FINANCE_PAYROLL_DEBIT_ACCOUNT).', 500);
  const lines = await runLines(run.id);
  const accounts = await liveAccounts([...new Set(lines.map((l) => l.partyId))]);
  const previous = await previousFingerprints(lines.map((l) => l.employee_id), run.month);
  const { blockers, changed } = payrollBlockers(lines.map((l) => ({ name: l.name, account: accounts.get(l.partyId) ?? null, previousFingerprint: previous.get(l.employee_id) ?? null })), today);
  if (blockers.length) return json({ error: 'The file cannot be generated yet.', blockers, changed }, 409);
  // Decrypted here and nowhere else; the numbers go into the file and are not kept or logged.
  const people = lines.map((l) => {
    const d = JSON.parse(decryptFinanceText((accounts.get(l.partyId) as Json).details_enc));
    return { name: l.name, accountNumber: String(d.account ?? ''), ifsc: String(d.ifsc ?? ''), email: '', netPaise: Number(l.net_paise) };
  });
  let file;
  try {
    file = salaryFileBytes({ month: String(run.month).slice(0, 7), paymentDate, paymentMode: run.payment_mode, debitAccount, today, lines: people });
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'The file cannot be generated.', 409);
  }
  const batchId = randomUUID();
  const key = `finance/payroll/${batchId}.xlsx`;
  const hash = createHash('sha256').update(file.bytes).digest('hex');
  await logFinanceAction({ actorId: access.staff.id, entityId: entity, action: 'finance.payroll_generate', target: run.id, detail: { month: String(run.month).slice(0, 7), lines: lines.length, changedAccounts: changed.length, batch: batchId } });
  await putFinancePayroll(key, file.bytes);
  await rest('/fin_payment_batches', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ id: batchId, entity_id: entity, kind: 'salary', payment_mode: run.payment_mode, payment_date: paymentDate, total_paise: file.totalPaise, line_count: lines.length, file_hash: hash, r2_key: key, prepared_by: access.staff.id }) });
  // The snapshot of what is being paid, and the reference that ties each line to column I of the file.
  const year = String(run.month).slice(0, 4);
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(String(run.month).slice(5, 7)) - 1];
  for (const [i, l] of lines.entries()) {
    const a = accounts.get(l.partyId) as Json;
    await rest(`/fin_payroll_lines?id=eq.${l.id}`, { method: 'PATCH', body: JSON.stringify({ party_account_id: a.id, account_last4: a.last4, account_fingerprint: a.fingerprint, reference: `${year}-${mon}-Employee-${String(i + 1).padStart(3, '0')}` }) });
  }
  if (paymentDate !== run.payment_date) await rest(`/fin_payroll_runs?id=eq.${run.id}&status=eq.confirmed`, { method: 'PATCH', body: JSON.stringify({ payment_date: paymentDate }) });
  if (!(await moveRun(run.id, 'confirmed', { status: 'file_generated', prepared_by: access.staff.id, batch_id: batchId }))) return fail('The run changed while the file was being made. Reload.', 409);
  return json({ ok: true, status: 'file_generated', changed, warnings: file.warnings });
}

// GET /payroll/runs/:id/file: the generated file, for a preparer behind the step-up. Every download is logged.
export async function downloadFile(req: Request, id: string): Promise<Response> {
  const gate = await payrollAccess(req);
  if (!gate.ok) return gate.response;
  const { access } = gate;
  if (!access.canPrepare) return fail('Only a director who prepares the bank file can download it.', 403);
  if (!stepUpIsValid(req, access.staff.id)) return fail('Verify a second factor first.', 403, 'STEP_UP_REQUIRED');
  try {
    const run = await loadRun(id);
    if (!run?.batch_id) return fail('There is no file for this run.', 404);
    const [batch] = await rows(`/fin_payment_batches?id=eq.${run.batch_id}&select=id,r2_key,status`);
    if (!batch || batch.status === 'cancelled') return fail('There is no file for this run.', 404);
    await logFinanceAction({ actorId: access.staff.id, entityId: await entityId(), action: 'finance.payroll_file_downloaded', target: id, detail: { batch: batch.id } });
    const bytes = await getFinancePayroll(batch.r2_key);
    if (!bytes) return fail('The file is missing from storage.', 404);
    const name = `salary-${String(run.month).slice(0, 7)}.xlsx`;
    return new Response(bytes as BodyInit, { status: 200, headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store' } });
  } catch (err) {
    return serverError(err, 'download');
  }
}
