// Run with: node --test scripts/lib/finance-payroll-file.test.mjs
// Every name, account number, IFSC and amount below is invented. No real payee detail belongs in this file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readWorkbook } from './finance-xlsx.mjs';
import {
  monthLabel,
  defaultPaymentDate,
  validatePaymentDate,
  fileIsStale,
  buildSalaryRows,
  salaryFileBytes,
  payrollBlockers,
} from './finance-payroll-file.mjs';

const person = (over = {}) => ({
  name: 'Test Person One',
  accountNumber: '1000000001',
  ifsc: 'TEST0000001',
  email: 'one@example.invalid',
  netPaise: 1_500_000,
  ...over,
});
const run = (over = {}) => ({ month: '2026-10', paymentDate: '2026-11-01', today: '2026-11-01', debitAccount: '9000000009', lines: [person(), person({ name: 'Test Person Two', accountNumber: '1000000002', netPaise: 2_000_000 })], ...over });

test('month label and the default payment date (the 1st of the following month, December rolls the year)', () => {
  assert.equal(monthLabel('2026-10'), 'Oct 2026');
  assert.equal(monthLabel('2026-02'), 'Feb 2026');
  assert.equal(defaultPaymentDate('2026-10'), '2026-11-01');
  assert.equal(defaultPaymentDate('2026-12'), '2027-01-01');
  assert.throws(() => monthLabel('2026-13'));
  assert.throws(() => monthLabel('October'));
});

test('rows follow the bank layout: A to L, no header, amount in whole rupees, date as dd-mm-yyyy text', () => {
  const { rows, errors } = buildSalaryRows(run());
  assert.deepEqual(errors, []);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], ['N', 15000, '01-11-2026', 'Test Person One', 1000000001, 'one@example.invalid', 'Oct 2026 Salary', 9000000009, '2026-Oct-Employee-001', 'TEST0000001', '10', 'Salary for Oct 2026']);
  assert.equal(rows[1][8], '2026-Oct-Employee-002');
  assert.equal(rows[1][1], 20000);
});

test('K is a constant setting, A is N or I only', () => {
  assert.equal(buildSalaryRows(run({ constant: '10' })).rows[0][10], '10');
  assert.equal(buildSalaryRows(run({ paymentMode: 'I' })).rows[0][0], 'I');
  assert.match(buildSalaryRows(run({ paymentMode: 'R' })).errors.join(' '), /payment mode/i);
});

test('the debit account is a server-side value; its absence or a bad shape stops the file', () => {
  assert.match(buildSalaryRows(run({ debitAccount: '' })).errors.join(' '), /debit account/i);
  assert.match(buildSalaryRows(run({ debitAccount: 'ABC' })).errors.join(' '), /debit account/i);
});

test('an amount with paise is refused: the net is whole rupees; zero and negative are refused too', () => {
  assert.match(buildSalaryRows(run({ lines: [person({ netPaise: 1_500_050 })] })).errors.join(' '), /whole rupees/i);
  assert.match(buildSalaryRows(run({ lines: [person({ netPaise: 0 })] })).errors.join(' '), /amount/i);
  assert.match(buildSalaryRows(run({ lines: [person({ netPaise: -100 })] })).errors.join(' '), /amount/i);
});

test('an account starting with 0 is written as text and flagged; others are numbers', () => {
  const { rows, warnings, errors } = buildSalaryRows(run({ lines: [person({ accountNumber: '0' + '7'.repeat(12) })] }));
  assert.deepEqual(errors, []);
  assert.equal(rows[0][4], '0' + '7'.repeat(12));
  assert.match(warnings.join(' '), /starts with 0/i);
});

test('an account too large for a spreadsheet number is written as text rather than rounded', () => {
  const { rows } = buildSalaryRows(run({ lines: [person({ accountNumber: '9'.repeat(16) })] }));
  assert.equal(rows[0][4], '9'.repeat(16));
});

test('account, IFSC and name shape errors name the row', () => {
  const e = buildSalaryRows(run({ lines: [person(), person({ name: ' ', accountNumber: '12ab', ifsc: 'bad' })] })).errors.join(' | ');
  assert.match(e, /Row 2.*name/i);
  assert.match(e, /Row 2.*account number/i);
  assert.match(e, /Row 2.*IFSC/i);
  assert.doesNotMatch(e, /Row 1/);
});

test('the IFSC is upper-cased, the email may be blank, whitespace in names is tidied', () => {
  const { rows, errors } = buildSalaryRows(run({ lines: [person({ ifsc: 'test0000001', email: '', name: '  Test   Person ' })] }));
  assert.deepEqual(errors, []);
  assert.equal(rows[0][9], 'TEST0000001');
  assert.equal(rows[0][5], '');
  assert.equal(rows[0][3], 'Test Person');
});

test('an empty run, or a duplicate person, is refused; two people on one account are allowed', () => {
  assert.match(buildSalaryRows(run({ lines: [] })).errors.join(' '), /no lines/i);
  const shared = buildSalaryRows(run({ lines: [person(), person({ name: 'Test Person Two' })] }));
  assert.deepEqual(shared.errors, []);
  const dup = buildSalaryRows(run({ lines: [person(), person()] }));
  assert.match(dup.errors.join(' '), /same name/i);
});

test('the total is the sum of the rows, in paise', () => {
  assert.equal(buildSalaryRows(run()).totalPaise, 3_500_000);
});

test('payment date: a real date; today or a future date is accepted; a past date is refused', () => {
  assert.deepEqual(validatePaymentDate('2026-11-01', '2026-11-01'), {});
  assert.deepEqual(validatePaymentDate('2026-11-03', '2026-11-01'), {});
  assert.match(validatePaymentDate('2026-10-31', '2026-11-01').error, /past/i);
  assert.match(validatePaymentDate('2026-02-30', '2026-01-01').error, /real date/i);
  assert.match(validatePaymentDate('01-11-2026', '2026-11-01').error, /real date/i);
  const future = buildSalaryRows(run({ paymentDate: '2026-11-03', today: '2026-11-01' }));
  assert.deepEqual(future.errors, []);
  assert.deepEqual(future.warnings, []);
  assert.equal(future.rows[0][2], '03-11-2026');
  assert.match(buildSalaryRows(run({ paymentDate: '2026-10-31', today: '2026-11-01' })).errors.join(' '), /past/i);
});

test('a generated file goes stale once its payment date is behind today, and is then regenerated', () => {
  assert.equal(fileIsStale('2026-11-01', '2026-11-01'), false);
  assert.equal(fileIsStale('2026-11-01', '2026-11-02'), true);
  assert.equal(fileIsStale('2026-11-05', '2026-11-02'), false);
});

test('the file is an xlsx that reads back with the same cells; C stays text, B and E stay numbers', () => {
  const { bytes } = salaryFileBytes(run());
  const sheet = readWorkbook(bytes)[0];
  assert.equal(sheet.rows.length, 2);
  assert.equal(sheet.rows[0].length, 12);
  assert.equal(sheet.rows[0][1], 15000);
  assert.equal(sheet.rows[0][2], '01-11-2026');
  assert.equal(sheet.rows[0][4], 1000000001);
  assert.equal(sheet.rows[0][10], '10');
  assert.equal(sheet.rows[0][11], 'Salary for Oct 2026');
});

test('xml-special characters in a name survive the round trip', () => {
  const { bytes } = salaryFileBytes(run({ lines: [person({ name: 'A & B <Test>' })] }));
  assert.equal(readWorkbook(bytes)[0].rows[0][3], 'A & B <Test>');
});

test('a file is not produced when there are errors', () => {
  assert.throws(() => salaryFileBytes(run({ lines: [] })), /no lines/i);
});

// ---- the guard: only verified, started, unretired accounts; a changed account blocks until verified and is always shown ----
const acct = (over = {}) => ({ id: 'a1', status: 'verified', valid_from: null, retired_on: null, fingerprint: 'fp1', ...over });
const gline = (over = {}) => ({ name: 'Test Person One', account: acct(), previousFingerprint: 'fp1', ...over });

test('guard: a verified, unchanged account passes with nothing to show', () => {
  assert.deepEqual(payrollBlockers([gline()], '2026-11-01'), { blockers: [], changed: [] });
});

test('guard: an unverified, retired or not-yet-valid account blocks, naming the person and the reason', () => {
  const b = (account) => payrollBlockers([gline({ account })], '2026-11-01').blockers[0];
  assert.match(b(acct({ status: 'unverified' })), /Test Person One.*not verified/i);
  assert.match(b(acct({ retired_on: '2026-10-01' })), /retired/i);
  assert.match(b(acct({ valid_from: '2026-12-01' })), /not yet/i);
  assert.match(b(acct({ status: 'superseded' })), /replaced/i);
  assert.match(b(null), /no bank account/i);
});

test('guard: a verified account that changed since the last run is let through but listed as changed', () => {
  const r = payrollBlockers([gline({ account: acct({ fingerprint: 'fp2' }) })], '2026-11-01');
  assert.deepEqual(r.blockers, []);
  assert.match(r.changed[0], /Test Person One.*changed since the last run/i);
});

test('guard: a changed account that is unverified both blocks and is listed as changed', () => {
  const r = payrollBlockers([gline({ account: acct({ fingerprint: 'fp2', status: 'unverified' }) })], '2026-11-01');
  assert.equal(r.blockers.length, 1);
  assert.equal(r.changed.length, 1);
});

test('guard: a first run for a person (no previous account) is not a change', () => {
  assert.deepEqual(payrollBlockers([gline({ previousFingerprint: null })], '2026-11-01').changed, []);
});

test('a bonus run is worded and referenced as the files uploaded since 2023 are', async () => {
  const { buildSalaryRows, lineReference, runWording } = await import('./finance-payroll-file.mjs');
  assert.deepEqual(runWording('2026-10', 'bonus', 'Diwali Bonus'), { narration: 'Oct 2026 Diwali Bonus', summary: 'Diwali Bonus for Oct 2026' });
  assert.deepEqual(runWording('2026-10'), { narration: 'Oct 2026 Salary', summary: 'Salary for Oct 2026' });
  assert.equal(lineReference('2026-10', 'salary', 1), '2026-Oct-Employee-001');
  assert.equal(lineReference('2026-10', 'bonus', 12), '2026-Oct-Bonus-Employee-012');
  const { rows, errors } = buildSalaryRows(run({ runType: 'bonus', label: 'Diwali Bonus', paymentDate: '2026-11-01' }));
  assert.deepEqual(errors, []);
  assert.deepEqual([rows[0][6], rows[0][8], rows[0][11]], ['Oct 2026 Diwali Bonus', '2026-Oct-Bonus-Employee-001', 'Diwali Bonus for Oct 2026']);
  assert.match(buildSalaryRows(run({ runType: 'bonus' })).errors.join(' '), /needs a name/);
  assert.match(buildSalaryRows(run({ runType: 'gift' })).errors.join(' '), /salary or bonus/);
});
