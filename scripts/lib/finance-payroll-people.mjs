// People-change requests for payroll (docs/finance/sessions/09-payroll.md, "Plan for the next slices"): the farm manager decides who
// joins and who leaves, so a change starts with a request from him and a director signs it off; adding the person as a Party stays a
// separate step done by someone else. Pure: lib/finance-payroll-people.ts reads and writes and asks who the caller is.
//
// A request is open ('requested') until a director approves or declines it, or the person who raised it (or a director) withdraws it.
// Approving a joining request puts the person on payroll from the start month; approving a leaving request sets the last month to pay.
// Whoever raised a request never decides it, even when they hold both roles.
import { validatePayeeDetails } from './finance-parties.mjs';
import { defaultPaymentDate } from './finance-payroll-file.mjs';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_RUPEES = 10_000_000;
const tidy = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');

// Bank details the farm manager was given by the employee. The number is asked twice (the page shows only the last four digits
// afterwards) and an IFSC is required: an account without one cannot be paid, so it is not accepted here.
// -> { details: { method, account, ifsc }, last4 } | { error }
function checkBank(bank) {
  if (!bank || typeof bank !== 'object') return { error: 'Enter the bank details.' };
  const squash = (v) => (typeof v === 'string' ? v.replace(/\s+/g, '') : '');
  if (squash(bank.account) !== squash(bank.accountConfirm)) return { error: 'The two account numbers do not match.' };
  const checked = validatePayeeDetails({ method: 'bank', account: bank.account, ifsc: bank.ifsc });
  if (checked.error || !checked.details) return { error: checked.error ?? 'Check the bank details.' };
  return { details: checked.details, last4: checked.last4 };
}

// body -> { value } | { error }. Months arrive as "2026-12" and are stored as the first day.
export function validatePersonRequest(body, { today }) {
  void today;
  if (body?.kind === 'join') {
    const personName = tidy(body.name);
    if (personName.length < 2 || personName.length > 100) return { error: 'Give the person\'s name.' };
    if (typeof body.startMonth !== 'string' || !MONTH.test(body.startMonth)) return { error: 'Choose the month they start.' };
    const roleTitle = body.role == null || tidy(body.role) === '' ? null : tidy(body.role);
    if (roleTitle && (roleTitle.length < 2 || roleTitle.length > 60)) return { error: 'The role must be 2 to 60 characters.' };
    let agreedPayPaise = null;
    if (body.agreedPayRupees != null) {
      if (!Number.isInteger(body.agreedPayRupees) || body.agreedPayRupees <= 0 || body.agreedPayRupees > MAX_RUPEES) return { error: 'The agreed monthly pay must be a whole number of rupees, more than zero.' };
      agreedPayPaise = body.agreedPayRupees * 100;
    }
    let bank = null;
    if (body.bank != null) {
      const checked = checkBank(body.bank);
      if (checked.error || !checked.details) return { error: checked.error };
      bank = { details: checked.details, last4: checked.last4 };
    }
    return { value: { kind: 'join', personName, roleTitle, startMonth: `${body.startMonth}-01`, agreedPayPaise, bank } };
  }
  if (body?.kind === 'bank_change') {
    if (typeof body.employeeId !== 'string' || !ID.test(body.employeeId)) return { error: 'Choose the person whose bank details are changing.' };
    if (typeof body.fromMonth !== 'string' || !MONTH.test(body.fromMonth)) return { error: 'Choose the first salary month the new account is for.' };
    const checked = checkBank(body.bank ?? null);
    if (checked.error || !checked.details) return { error: checked.error?.startsWith('Enter') ? 'Enter the new bank details.' : checked.error };
    // The salary for a month is paid on the 1st of the next, so the new account starts then and the old one stops being paid then.
    return { value: { kind: 'bank_change', employeeId: body.employeeId, effectiveOn: defaultPaymentDate(body.fromMonth), bank: { details: checked.details, last4: checked.last4 } } };
  }
  if (body?.kind === 'leave') {
    if (typeof body.employeeId !== 'string' || !ID.test(body.employeeId)) return { error: 'Choose the person who is leaving.' };
    if (typeof body.lastMonth !== 'string' || !MONTH.test(body.lastMonth)) return { error: 'Choose the last month they are paid.' };
    const reason = body.reason == null || tidy(body.reason) === '' ? null : tidy(body.reason);
    if (reason && reason.length > 200) return { error: 'The reason is too long (200 characters at most).' };
    return { value: { kind: 'leave', employeeId: body.employeeId, lastMonth: `${body.lastMonth}-01`, reason } };
  }
  return { error: 'Say whether someone is joining, leaving or changing their bank details.' };
}

const no = (error) => ({ ok: false, error });

// request: { status, requestedBy }; actor: { id, canEnter, canPrepare } -> { ok: true, to } | { ok: false, error }.
// The caller still asks for the step-up on an approval, and writes the audit entry first.
export function decidePersonRequest(request, action, actor) {
  if (!['approve', 'reject', 'cancel'].includes(action)) return no('Choose an action.');
  if (request.status !== 'requested') return no(`This request is already ${request.status}.`);
  if (action === 'cancel') {
    if (actor.id === request.requestedBy || actor.canPrepare) return { ok: true, to: 'cancelled' };
    return no('Only the person who raised this request, or a director, can withdraw it.');
  }
  if (!actor.canPrepare) return no('Only a director can approve or decline a change of people.');
  if (actor.id === request.requestedBy) return no('You raised this request, so another director has to decide it.');
  return { ok: true, to: action === 'approve' ? 'approved' : 'rejected' };
}

// A request with bank details needs the photo of the passbook or cancelled cheque (the proof the details are the employee's own) before a
// director can approve it. request: { hasBank, hasProof } -> true when the proof is still missing.
export function proofMissing(request) {
  return Boolean(request.hasBank) && !request.hasProof;
}

// A person is paid for a month from their start month to their last month; either end may be open (null).
// person: { startMonth, lastMonth } as "YYYY-MM-01" or null; month: "YYYY-MM".
export function eligibleForMonth(person, month) {
  const m = `${month}-01`;
  if (person.startMonth && person.startMonth > m) return false;
  if (person.lastMonth && person.lastMonth < m) return false;
  return true;
}

// One line of plain words: what happens next to this request.
export function requestSummary(request) {
  if (request.status === 'requested') return { next: proofMissing(request) ? "Attach the photo of the passbook or cheque, then a director can approve it." : 'Waiting for a director to approve it.' };
  return { next: null };
}
