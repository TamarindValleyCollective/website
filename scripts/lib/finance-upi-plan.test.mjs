// Run with: node --test scripts/lib/finance-upi-plan.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { planUpiImport, linkUpiToBank, reconciliationSummary } from './finance-upi-plan.mjs';

const accounts = [{ id: 'axis', upiLabel: 'Axis Bank - 99' }];
let row = 1;
const line = (o) => ({ row: ++row, paidAt: '2026-09-02', time: '10:00:00', details: 'Money sent to Test', counterparty: 'p@example', accountLabel: 'Axis Bank - 99', direction: 'debit', amountPaise: 10000, upiRef: '600000000001', orderId: null, remarks: null, tag: null, ...o });
const parsed = (lines, failed = []) => ({ from: '2026-04-01', to: '2026-11-01', accounts: ['Axis Bank - 99'], lines, failed });
const file = (lines, hash = 'ph1') => ({ id: 'p', fileHash: hash, parsed: parsed(lines) });
const noHeld = { fileHashes: [], refs: [] };
const plan = (lines, extra = {}) => planUpiImport({ file: file(lines), accounts, circleTag: 'Pocket Money', held: noHeld, ...extra });

test('rows of the registered account are kept; other banks and cards are ignored but counted with their total', () => {
  const r = plan([
    line({ upiRef: '600000000001', amountPaise: 25000 }),
    line({ upiRef: '600000000002', accountLabel: 'Other Bank Credit Card', amountPaise: 9900 }),
    line({ upiRef: '600000000003', accountLabel: 'Other Bank Credit Card', amountPaise: 100 }),
    line({ upiRef: null, accountLabel: 'Other Bank', amountPaise: 777 }),
  ]);
  assert.equal(r.status, 'ok');
  assert.deepEqual([r.counts.total, r.counts.new, r.counts.ignored, r.counts.failed], [4, 1, 3, 0]);
  assert.deepEqual(r.ignored, { count: 3, totalPaise: 10777, byAccount: [{ label: 'Other Bank Credit Card', count: 2, totalPaise: 10000 }, { label: 'Other Bank', count: 1, totalPaise: 777 }] });
  const kept = r.newLines.find((l) => !l.ignored);
  assert.equal(kept.accountId, 'axis');
  // the ignored rows that have a reference are stored, flagged, so the same file never re-counts them; the one with none is only counted
  assert.deepEqual(r.newLines.filter((l) => l.ignored).map((l) => [l.upiRef, l.ignoredReason, l.accountId]), [['600000000002', 'account_not_registered', null], ['600000000003', 'account_not_registered', null]]);
});

test('a file where no row is on a registered account is blocked, not quietly ignored (no account, or a wrong label)', () => {
  const lines = [line({ upiRef: '600000000001' }), line({ upiRef: '600000000002' })];
  for (const accts of [[], [{ id: 'axis', upiLabel: 'Some Other Label' }], [{ id: 'axis', upiLabel: null }]]) {
    const r = plan(lines, { accounts: accts });
    assert.equal(r.status, 'blocked');
    assert.equal(r.errors[0].type, 'no_registered_rows');
    assert.deepEqual(r.errors[0].labelsInFile, ['Axis Bank - 99']);
    assert.equal(r.newLines.length, 0);
  }
});

test('a file whose rows are all already held is still fine (the account matched)', () => {
  const r = plan([line({ upiRef: '600000000001' })], { held: { fileHashes: [], refs: ['600000000001'] } });
  assert.equal(r.status, 'ok');
});

test('account labels match ignoring case and spacing', () => {
  const r = plan([line({ accountLabel: '  axis  BANK - 99 ' })]);
  assert.equal(r.counts.ignored, 0);
  assert.equal(r.newLines[0].accountId, 'axis');
});

test('a registered-account row with no UPI reference cannot be joined: it is failed, not dropped', () => {
  const noRef = line({ upiRef: null });
  const r = plan([noRef, line({ upiRef: '600000000009' })]);
  assert.equal(r.counts.failed, 1);
  assert.equal(r.failed[0].row, noRef.row);
  assert.match(r.failed[0].reason, /reference/i);
  assert.equal(r.counts.new, 1);
});

test('parser failures are carried through to the summary', () => {
  const r = planUpiImport({ file: { id: 'p', fileHash: 'h', parsed: parsed([line({})], [{ row: 9, reason: 'bad amount' }]) }, accounts, circleTag: 'Pocket Money', held: noHeld });
  assert.deepEqual(r.failed, [{ row: 9, reason: 'bad amount' }]);
  assert.equal(r.counts.failed, 1);
});

test('the circle flag comes from the configured tag, on payments out only', () => {
  const r = plan([
    line({ upiRef: '600000000001', tag: '#💰 Pocket Money' }),
    line({ upiRef: '600000000002', tag: '#🧾 Bill Payments' }),
    line({ upiRef: '600000000003', tag: '#💰 Pocket Money', direction: 'credit' }),
  ]);
  assert.deepEqual(r.newLines.map((l) => l.isCircle), [true, false, false]);
  assert.equal(plan([line({ tag: '#💰 Pocket Money' })], { circleTag: '' }).newLines[0].isCircle, false);
});

test('rows already held (by reference) and repeats within the file are not added twice', () => {
  const r = plan([line({ upiRef: '600000000001' }), line({ upiRef: '600000000001' }), line({ upiRef: '600000000002' })], { held: { fileHashes: [], refs: ['600000000002'] } });
  assert.deepEqual([r.counts.new, r.counts.alreadyHeld], [1, 2]);
});

test('the same file twice imports nothing the second time', () => {
  const r = plan([line({})], { held: { fileHashes: ['ph1'], refs: [] } });
  assert.equal(r.status, 'duplicate_file');
  assert.equal(r.newLines.length, 0);
});

test('first and last date and the amount/direction are normalised', () => {
  const r = plan([line({ paidAt: '2026-09-05', upiRef: '600000000002' }), line({ paidAt: '2026-09-02' })]);
  assert.deepEqual([r.firstDate, r.lastDate], ['2026-09-02', '2026-09-05']);
});

test('linking by reference: same amount and direction links; a different amount is reported, not linked', () => {
  const bank = [
    { id: 'b1', upiRrn: '600000000001', amountPaise: 25000, direction: 'debit' },
    { id: 'b2', upiRrn: '600000000002', amountPaise: 999, direction: 'debit' },
    { id: 'b3', upiRrn: '600000000003', amountPaise: 500, direction: 'credit' },
  ];
  const upi = [
    { id: 'u1', upiRef: '600000000001', amountPaise: 25000, direction: 'debit' },
    { id: 'u2', upiRef: '600000000002', amountPaise: 1000, direction: 'debit' },
    { id: 'u3', upiRef: '600000000003', amountPaise: 500, direction: 'debit' },
    { id: 'u4', upiRef: '600000000004', amountPaise: 500, direction: 'debit' },
  ];
  const r = linkUpiToBank({ upiLines: upi, bankLines: bank });
  assert.deepEqual(r.links, [{ upiId: 'u1', bankId: 'b1' }]);
  assert.deepEqual(r.mismatches.map((m) => m.upiId).sort(), ['u2', 'u3']);
  assert.equal(r.awaiting.length, 1); // u4 has no bank line yet
});

test('two bank lines with one reference are ambiguous: nothing is linked', () => {
  const r = linkUpiToBank({
    upiLines: [{ id: 'u1', upiRef: '600000000001', amountPaise: 100, direction: 'debit' }],
    bankLines: [{ id: 'b1', upiRrn: '600000000001', amountPaise: 100, direction: 'debit' }, { id: 'b2', upiRrn: '600000000001', amountPaise: 100, direction: 'debit' }],
  });
  assert.deepEqual(r.links, []);
  assert.equal(r.ambiguous.length, 1);
});

test('summary: a payment after the last bank line is awaiting; one inside the statement is unmatched; older bank debits predate the export', () => {
  const s = reconciliationSummary({
    lastBankDate: '2026-10-31',
    firstUpiDate: '2026-08-31',
    upiLines: [
      { paidAt: '2026-10-31', amountPaise: 100, bankLineId: null }, // on the last statement day: awaiting
      { paidAt: '2026-11-01', amountPaise: 200, bankLineId: null }, // after it: awaiting
      { paidAt: '2026-09-10', amountPaise: 1, bankLineId: null }, // inside the statement, no bank line: attention
      { paidAt: '2026-09-11', amountPaise: 500, bankLineId: 'b9' },
    ],
    bankLines: [
      { tranDate: '2026-05-01', upiRrn: '500000000001', linked: false }, // before the export began: no UPI line will ever exist
      { tranDate: '2026-09-12', upiRrn: '500000000002', linked: false }, // inside the export period: attention
      { tranDate: '2026-09-11', upiRrn: '500000000003', linked: true },
      { tranDate: '2026-09-13', upiRrn: null, linked: false },
    ],
  });
  assert.deepEqual(s.awaitingBank, { count: 2, totalPaise: 300 });
  assert.deepEqual(s.unmatchedInStatement, { count: 1, totalPaise: 1 });
  assert.deepEqual(s.bankWithoutUpi, { predatesExport: 1, inExportPeriod: 1 });
});

// ---- BHIM -----------------------------------------------------------------------------------------------------------
import { planBhimImport, bhimIsCircle } from './finance-upi-plan.mjs';

const bhimLine = (o) => ({ row: 4, paidAt: '2026-08-26', time: '10:00:00', sender: { id: 's@upi', name: 'S' }, receiver: { id: 'r@ybl', name: 'Shop' }, accountLast4: null, bankName: null, drcr: 'CR', upiRef: '600000000001', amountPaise: 15000, ...o });
const bhimFile = (lines, extra = {}) => ({ id: '0', fileHash: 'h1', parsed: { from: '2026-07-01', to: '2026-11-07', lines, failed: [], unsuccessful: { count: 0, totalPaise: 0 }, ...extra } });
const axis = { id: 'a1', label: 'Axis current', last4: '0099', upiLabel: null };
const other = { id: 'a2', label: 'Second bank', last4: '0123', upiLabel: null };
const none = { fileHashes: [], refs: [] };

test('BHIM: a row naming its account is placed on it; a circle row names none and is stored with no account (its bank line says which)', () => {
  const plan = planBhimImport({ file: bhimFile([bhimLine({}), bhimLine({ upiRef: '600000000002', bankName: 'AXIS BANK', accountLast4: '0099', drcr: 'DR' })]), accounts: [axis, other], held: none });
  assert.equal(plan.status, 'ok');
  assert.deepEqual(plan.newLines.map((l) => [l.accountId, l.isCircle, l.direction, l.app]), [[null, true, 'debit', 'bhim'], ['a1', false, 'debit', 'bhim']]);
  assert.deepEqual(plan.newLines.map((l) => l.accountLabel), ['BHIM', 'BHIM · Axis current']);
  assert.equal(bhimIsCircle(bhimLine({ bankName: 'AXIS BANK', drcr: 'DR' })), false);
});

test('BHIM: a file of circle rows alone, or naming two accounts, is accepted (the account is not read from the file); only an unregistered account blocks', () => {
  assert.equal(planBhimImport({ file: bhimFile([bhimLine({})]), accounts: [axis, other], held: none }).status, 'ok');
  const two = planBhimImport({ file: bhimFile([bhimLine({}), bhimLine({ upiRef: '600000000002', bankName: 'AXIS BANK', accountLast4: '0099', drcr: 'DR' }), bhimLine({ upiRef: '600000000003', bankName: 'X', accountLast4: '0123', drcr: 'DR' })]), accounts: [axis, other], held: none });
  assert.deepEqual(two.newLines.map((l) => l.accountId), [null, 'a1', 'a2']);
  const unreg = planBhimImport({ file: bhimFile([bhimLine({ bankName: 'AXIS BANK', accountLast4: '7777', drcr: 'DR' })]), accounts: [axis], held: none });
  assert.deepEqual(unreg.errors, [{ type: 'account_not_registered', last4: ['7777'] }]);
});

test('BHIM: references already held (from Paytm or an earlier BHIM file) and repeats in one file are counted, not stored twice; the same file is a duplicate', () => {
  const lines = [bhimLine({ bankName: 'AXIS BANK', accountLast4: '0099', drcr: 'DR' }), bhimLine({ bankName: 'AXIS BANK', accountLast4: '0099', drcr: 'DR' }), bhimLine({ upiRef: '600000000009', bankName: 'AXIS BANK', accountLast4: '0099', drcr: 'DR' })];
  const plan = planBhimImport({ file: bhimFile(lines), accounts: [axis], held: { fileHashes: [], refs: ['600000000009'] } });
  assert.equal(plan.counts.new, 1);
  assert.equal(plan.counts.alreadyHeld, 2);
  assert.equal(planBhimImport({ file: bhimFile(lines), accounts: [axis], held: { fileHashes: ['h1'], refs: [] } }).status, 'duplicate_file');
});

test('BHIM: a row that names the bank and is marked CR is money coming in; no bank named is a delegated payment out', () => {
  const plan = planBhimImport({
    file: bhimFile([
      bhimLine({ upiRef: '600000000010', bankName: 'AXIS BANK', accountLast4: '0099', drcr: 'CR', amountPaise: 900000 }), // received into the account
      bhimLine({ upiRef: '600000000011', bankName: 'AXIS BANK', accountLast4: '0099', drcr: 'DR' }), // paid from the account
      bhimLine({ upiRef: '600000000012' }), // no bank named, CR: a delegate paid out of the account
    ]),
    accounts: [axis], held: none,
  });
  assert.deepEqual(plan.newLines.map((l) => [l.direction, l.isCircle]), [['credit', false], ['debit', false], ['debit', true]]);
});

test('BHIM: a payment from a bank that is not registered (a personal account) is left out and counted, not stored; the rest of the file imports', () => {
  const plan = planBhimImport({
    file: bhimFile([
      bhimLine({ upiRef: '600000000020', bankName: 'AXIS BANK', accountLast4: '0099', drcr: 'DR', amountPaise: 20000 }),
      bhimLine({ upiRef: '600000000021', bankName: 'ICICI Bank', accountLast4: '8505', drcr: 'DR', amountPaise: 169700 }),
      bhimLine({ upiRef: '600000000022', bankName: 'ICICI Bank', accountLast4: '8505', drcr: 'DR', amountPaise: 3000 }),
    ]),
    accounts: [axis], held: none,
  });
  assert.equal(plan.status, 'ok');
  assert.deepEqual(plan.newLines.map((l) => l.upiRef), ['600000000020']);
  assert.equal(plan.counts.ignored, 2);
  assert.deepEqual(plan.ignored, { count: 2, totalPaise: 172700, byAccount: [{ label: 'ICICI Bank ••8505', count: 2, totalPaise: 172700 }] });
});
