// The rules of a payroll run (docs/finance/sessions/09-payroll.md, 09a): what a run input must look like, who may move a run
// from one state to the next, and what the farm manager is shown to confirm. Pure: lib/finance-payroll.ts reads and writes and asks
// who the caller is; this file decides. The bank file itself is finance-payroll-file.mjs.
//
// States: draft -> confirmed (the farm manager) -> file_generated (a preparer) -> approved (a different director, who approves
// in the bank's portal) -> settled (the bank debit is matched). A run can be cancelled before it is approved. A file that was not
// used goes back to confirmed ("regenerate"): the portal rejects a past payment date, so a stale file is dead.
import { defaultPaymentDate, validatePaymentDate } from './finance-payroll-file.mjs';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_RUPEES = 10_000_000;
const rupees = (v) => Number.isInteger(v) && v > 0 && v <= MAX_RUPEES;

// body -> { value } | { error }. Amounts arrive in whole rupees; the stored value is paise.
export function validateRunInput(body, { today }) {
  const month = typeof body?.month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(body.month) ? body.month : null;
  if (!month) return { error: 'Choose the salary month.' };
  const paymentMode = body.paymentMode ?? 'N';
  if (!['N', 'I'].includes(paymentMode)) return { error: 'The payment mode must be N or I.' };
  // The salary is due on the 1st of the following month; a run made after that day defaults to today, since a past date is refused.
  const due = defaultPaymentDate(month);
  const paymentDate = body.paymentDate ?? (due < today ? today : due);
  const pd = validatePaymentDate(paymentDate, today);
  if (pd.error) return { error: pd.error };
  const input = Array.isArray(body.lines) ? body.lines : [];
  if (input.length === 0) return { error: 'Add at least one person.' };
  if (input.length > 200) return { error: 'A run can hold at most 200 people.' };
  const seen = new Set();
  const lines = [];
  for (const l of input) {
    if (typeof l?.employeeId !== 'string' || !ID.test(l.employeeId)) return { error: 'Choose each person from the list.' };
    if (seen.has(l.employeeId)) return { error: 'Each person can appear once in a run.' };
    seen.add(l.employeeId);
    if (!rupees(l.netRupees)) return { error: 'Each amount must be a whole number of rupees, more than zero.' };
    const out = { employeeId: l.employeeId, netPaise: l.netRupees * 100, agreedPayPaise: null, daysWorked: null, advanceDeductedPaise: null };
    if (l.agreedPayRupees != null) {
      if (!rupees(l.agreedPayRupees)) return { error: 'The agreed pay must be a whole number of rupees, more than zero.' };
      out.agreedPayPaise = l.agreedPayRupees * 100;
    }
    if (l.daysWorked != null) {
      if (typeof l.daysWorked !== 'number' || l.daysWorked < 0 || l.daysWorked > 31 || (l.daysWorked * 2) % 1 !== 0) return { error: 'Days worked must be between 0 and 31, in halves.' };
      out.daysWorked = l.daysWorked;
    }
    if (l.advanceDeductedRupees != null) {
      if (!Number.isInteger(l.advanceDeductedRupees) || l.advanceDeductedRupees < 0 || l.advanceDeductedRupees > MAX_RUPEES) return { error: 'The advance deducted must be a whole number of rupees.' };
      out.advanceDeductedPaise = l.advanceDeductedRupees * 100;
    }
    lines.push(out);
  }
  return { value: { month: `${month}-01`, paymentDate, paymentMode, lines } };
}

const no = (error) => ({ ok: false, error });

// run: { status, lineCount, enteredBy, preparedBy, batchStatus, paymentDate }
// actor: { id, canEnter (farm manager or a finance operator), canPrepare (generate the file), canApprove (approve-payroll) }
// -> { ok: true, to, batchTo? } | { ok: false, error }. The caller still applies the step-up and writes the audit entry first.
export function decideAction(run, action, actor, { today }) {
  switch (action) {
    case 'confirm':
      if (!actor.canEnter) return no('Only the person who enters the salaries can confirm them.');
      if (run.status !== 'draft') return no('Only a draft run can be confirmed.');
      if (!run.lineCount) return no('This run has no lines.');
      return { ok: true, to: 'confirmed' };
    case 'reopen':
      if (!actor.canEnter) return no('Only the person who enters the salaries can reopen a run.');
      if (run.status !== 'confirmed') return no('Only a confirmed run can be reopened.');
      return { ok: true, to: 'draft' };
    case 'generate':
      if (!actor.canPrepare) return no('Only a director who prepares the bank file can generate it.');
      if (run.status !== 'confirmed') return no('The run must be confirmed before the file is generated.');
      if (run.paymentDate < today) return no('The payment date is in the past; the bank will reject it. Change the date first.');
      return { ok: true, to: 'file_generated' };
    case 'regenerate':
      if (!actor.canPrepare) return no('Only a director who prepares the bank file can regenerate it.');
      if (run.status !== 'file_generated') return no(run.status === 'approved' || run.status === 'settled' ? 'The file was already approved at the bank; it cannot be regenerated.' : 'There is no generated file to replace.');
      return { ok: true, to: 'confirmed' };
    case 'mark_uploaded':
      if (!actor.canPrepare) return no('Only a director who prepares the bank file can record the upload.');
      if (run.status !== 'file_generated' || run.batchStatus !== 'file_generated') return no('The file is not waiting to be uploaded.');
      return { ok: true, to: 'file_generated', batchTo: 'uploaded' };
    case 'approve':
      if (!actor.canApprove) return no('Only a director who approves payroll can approve it.');
      if (run.status !== 'file_generated') return no('There is no uploaded file to approve.');
      if (run.preparedBy && run.preparedBy === actor.id) return no('You prepared this file, so someone else has to approve it.');
      if (run.batchStatus !== 'uploaded') return no('The file has not been marked as uploaded to the bank yet.');
      return { ok: true, to: 'approved' };
    case 'cancel':
      if (!actor.canEnter && !actor.canPrepare) return no('You cannot cancel this run.');
      if (!['draft', 'confirmed', 'file_generated'].includes(run.status)) return no('A run that is approved or settled cannot be cancelled.');
      return { ok: true, to: 'cancelled' };
    default:
      return no('Unknown action.');
  }
}

// What the farm manager checks before confirming, and the preparer before generating: who, how much, which account (last four
// digits only), and the two things that need a human eye. lines: [{ name, netPaise, last4, fingerprint, previousFingerprint, payable }]
export function confirmationRows(lines) {
  const rows = lines.map((l) => ({
    name: l.name,
    netPaise: l.netPaise,
    last4: l.last4 ?? null,
    changed: Boolean(l.previousFingerprint && l.fingerprint && l.previousFingerprint !== l.fingerprint),
    problem: l.payable === false ? 'account' : null,
  }));
  return {
    rows,
    totalPaise: rows.reduce((t, r) => t + r.netPaise, 0),
    changed: rows.filter((r) => r.changed).length,
    problems: rows.filter((r) => r.problem).length,
  };
}

const NEXT = {
  draft: 'Check the amounts and confirm the run.',
  confirmed: 'A director generates the bank file.',
  settled: null,
  cancelled: null,
};

// One line of plain words: what happens next to this run.
export function runSummary(run) {
  if (run.status === 'file_generated') {
    return { next: run.batchStatus === 'uploaded' ? 'A second director approves it in the bank portal and here.' : 'Upload the file to the bank, then mark it as uploaded.' };
  }
  if (run.status === 'approved') return { next: 'Waiting for the bank debit to appear on the statement.' };
  return { next: NEXT[run.status] ?? null };
}
