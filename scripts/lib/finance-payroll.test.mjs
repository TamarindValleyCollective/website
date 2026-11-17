// Run with: node --test scripts/lib/finance-payroll.test.mjs
// Every id, name and amount below is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRunInput, decideAction, confirmationRows, runSummary } from './finance-payroll.mjs';

const E1 = '11111111-1111-4111-8111-11111111111a';
const E2 = '22222222-2222-4222-8222-22222222222b';
const today = '2026-11-17';
const input = (over = {}) => ({ month: '2026-10', lines: [{ employeeId: E1, netRupees: 15000 }, { employeeId: E2, netRupees: 20500 }], ...over });

test('a run input becomes paise and defaults the payment date and mode', () => {
  const { value, error } = validateRunInput(input(), { today: '2026-10-30' });
  assert.equal(error, undefined);
  assert.equal(value.month, '2026-10-01');
  assert.equal(value.paymentDate, '2026-11-01');
  assert.equal(value.paymentMode, 'N');
  assert.deepEqual(value.lines.map((l) => l.netPaise), [1_500_000, 2_050_000]);
});

test('a run made after the 1st defaults to today, never to a past date', () => {
  assert.equal(validateRunInput(input(), { today }).value.paymentDate, today);
});

test('whole rupees only; zero, negative, text and absurd amounts are refused', () => {
  for (const bad of [0, -5, 100.5, '15000', null, 100_000_000]) {
    assert.match(validateRunInput(input({ lines: [{ employeeId: E1, netRupees: bad }] }), { today }).error, /amount/i, String(bad));
  }
});

test('the month must be a real month; the employee ids must be ids; a person appears once; there must be lines', () => {
  assert.ok(validateRunInput(input({ month: '2026-13' }), { today }).error);
  assert.ok(validateRunInput(input({ lines: [{ employeeId: 'x', netRupees: 1 }] }), { today }).error);
  assert.match(validateRunInput(input({ lines: [{ employeeId: E1, netRupees: 1 }, { employeeId: E1, netRupees: 2 }] }), { today }).error, /once/i);
  assert.match(validateRunInput(input({ lines: [] }), { today }).error, /at least one/i);
});

test('optional inputs are kept when given and validated: agreed pay in rupees, days worked in halves, advance in rupees', () => {
  const l = { employeeId: E1, netRupees: 15000, agreedPayRupees: 18000, daysWorked: 24.5, advanceDeductedRupees: 1000 };
  const { value } = validateRunInput(input({ lines: [l] }), { today });
  assert.deepEqual([value.lines[0].agreedPayPaise, value.lines[0].daysWorked, value.lines[0].advanceDeductedPaise], [1_800_000, 24.5, 100_000]);
  assert.ok(validateRunInput(input({ lines: [{ ...l, daysWorked: 24.3 }] }), { today }).error);
  assert.ok(validateRunInput(input({ lines: [{ ...l, daysWorked: 32 }] }), { today }).error);
  assert.ok(validateRunInput(input({ lines: [{ ...l, agreedPayRupees: -1 }] }), { today }).error);
});

test('the payment mode is N or I; a past payment date is refused when typed', () => {
  assert.equal(validateRunInput(input({ paymentMode: 'I' }), { today }).value.paymentMode, 'I');
  assert.ok(validateRunInput(input({ paymentMode: 'X' }), { today }).error);
  assert.match(validateRunInput(input({ paymentDate: '2026-11-16' }), { today }).error, /past/i);
  assert.equal(validateRunInput(input({ paymentDate: '2026-11-20' }), { today }).value.paymentDate, '2026-11-20');
});

// ---- who may move a run, and where ----
const farm = { id: 'fm', canEnter: true, canPrepare: false, canApprove: false };
const prep = { id: 'p1', canEnter: false, canPrepare: true, canApprove: true };
const second = { id: 'p2', canEnter: false, canPrepare: true, canApprove: true };
const run = (status, over = {}) => ({ status, lineCount: 2, enteredBy: 'fm', preparedBy: null, batchStatus: null, paymentDate: '2026-11-20', ...over });

test('the farm manager confirms a draft with lines, and may reopen a confirmed run', () => {
  assert.deepEqual(decideAction(run('draft'), 'confirm', farm, { today }), { ok: true, to: 'confirmed' });
  assert.match(decideAction(run('draft', { lineCount: 0 }), 'confirm', farm, { today }).error, /no lines/i);
  assert.deepEqual(decideAction(run('confirmed'), 'reopen', farm, { today }), { ok: true, to: 'draft' });
  assert.equal(decideAction(run('draft'), 'confirm', prep, { today }).ok, false);
});

test('only a preparer generates the file, only from a confirmed run, and not for a past payment date', () => {
  assert.deepEqual(decideAction(run('confirmed'), 'generate', prep, { today }), { ok: true, to: 'file_generated' });
  assert.equal(decideAction(run('confirmed'), 'generate', farm, { today }).ok, false);
  assert.equal(decideAction(run('draft'), 'generate', prep, { today }).ok, false);
  assert.match(decideAction(run('confirmed', { paymentDate: '2026-11-16' }), 'generate', prep, { today }).error, /past/i);
});

test('a generated file that was not used can be taken back to confirmed, until it is approved at the bank', () => {
  assert.deepEqual(decideAction(run('file_generated', { preparedBy: 'p1', batchStatus: 'file_generated' }), 'regenerate', prep, { today }), { ok: true, to: 'confirmed' });
  assert.deepEqual(decideAction(run('file_generated', { preparedBy: 'p1', batchStatus: 'uploaded' }), 'regenerate', prep, { today }), { ok: true, to: 'confirmed' });
  assert.match(decideAction(run('approved', { preparedBy: 'p1', batchStatus: 'approved_at_bank' }), 'regenerate', prep, { today }).error, /approved/i);
});

test('the second director approves; the preparer never does; the farm manager cannot', () => {
  const generated = run('file_generated', { preparedBy: 'p1', batchStatus: 'uploaded' });
  assert.deepEqual(decideAction(generated, 'approve', second, { today }), { ok: true, to: 'approved' });
  assert.match(decideAction(generated, 'approve', prep, { today }).error, /prepared/i);
  assert.equal(decideAction(generated, 'approve', farm, { today }).ok, false);
});

test('approval needs the file to have been uploaded to the bank first', () => {
  const generated = run('file_generated', { preparedBy: 'p1', batchStatus: 'file_generated' });
  assert.match(decideAction(generated, 'approve', second, { today }).error, /uploaded/i);
  assert.deepEqual(decideAction(generated, 'mark_uploaded', prep, { today }), { ok: true, to: 'file_generated', batchTo: 'uploaded' });
  assert.equal(decideAction(generated, 'mark_uploaded', farm, { today }).ok, false);
});

test('cancelling is allowed before approval by an entrant or a preparer, never after, and needs no extra state', () => {
  assert.deepEqual(decideAction(run('draft'), 'cancel', farm, { today }), { ok: true, to: 'cancelled' });
  assert.deepEqual(decideAction(run('confirmed'), 'cancel', prep, { today }), { ok: true, to: 'cancelled' });
  assert.equal(decideAction(run('approved', { preparedBy: 'p1' }), 'cancel', prep, { today }).ok, false);
  assert.equal(decideAction(run('settled'), 'cancel', prep, { today }).ok, false);
});

test('an unknown action is refused', () => {
  assert.equal(decideAction(run('draft'), 'delete', farm, { today }).ok, false);
});

// ---- what the farm manager confirms ----
const line = (over = {}) => ({ name: 'Test Person One', netPaise: 1_500_000, last4: '0001', fingerprint: 'f1', previousFingerprint: 'f1', payable: true, ...over });

test('the confirmation lists every person with the account as last four digits only, and the total', () => {
  const s = confirmationRows([line(), line({ name: 'Test Person Two', netPaise: 2_050_000, last4: '0002' })]);
  assert.deepEqual(s.rows.map((r) => [r.name, r.last4, r.netPaise]), [['Test Person One', '0001', 1_500_000], ['Test Person Two', '0002', 2_050_000]]);
  assert.equal(s.totalPaise, 3_550_000);
  for (const r of s.rows) assert.equal(Object.keys(r).some((k) => /account$|number|ifsc/i.test(k)), false);
});

test('an account changed since the last run is marked, a first run is not, and an unpayable account is marked', () => {
  const s = confirmationRows([line({ fingerprint: 'f2' }), line({ name: 'B', previousFingerprint: null }), line({ name: 'C', payable: false })]);
  assert.deepEqual(s.rows.map((r) => [r.changed, r.problem]), [[true, null], [false, null], [false, 'account']]);
  assert.equal(s.changed, 1);
  assert.equal(s.problems, 1);
});

test('the run summary says what to do next for each state', () => {
  assert.match(runSummary({ status: 'draft' }).next, /confirm/i);
  assert.match(runSummary({ status: 'confirmed' }).next, /generate/i);
  assert.match(runSummary({ status: 'file_generated', batchStatus: 'file_generated' }).next, /upload/i);
  assert.match(runSummary({ status: 'file_generated', batchStatus: 'uploaded' }).next, /approve/i);
  assert.match(runSummary({ status: 'approved' }).next, /debit|statement/i);
  assert.equal(runSummary({ status: 'settled' }).next, null);
});
