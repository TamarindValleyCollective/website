// Run with: node --test scripts/lib/finance-paytm.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePaytmExport, tagMatches } from './finance-paytm.mjs';
import { readWorkbook } from './finance-xlsx.mjs';
import { paytmExport, buildXlsx } from './finance-fixtures.mjs';

const rows = [
  { date: '2026-09-02', time: '09:15:00', amount: -25000, ref: '600000000001', remarks: 'Vegetables', tag: '#💰 Pocket Money', other: 'shop1@example' },
  { date: '2026-09-03', amount: -1234500, ref: '600000000002', tag: '#🧾 Bill Payments', orderId: '70000000001' },
  { date: '2026-09-04', amount: 5000, ref: '600000000003', details: 'Refund for Test', tag: '#↩️ Refund' },
  { date: '2026-09-05', amount: -9900, ref: '600000000004', account: 'Other Bank Credit Card', tag: null },
];
const parse = (opts = {}, shared = false) => parsePaytmExport(readWorkbook(paytmExport({ rows, shared, ...opts })));

test('reads the period, the accounts and every row with sign, paise, reference and tag', () => {
  const p = parse();
  assert.equal(p.from, '2026-04-01');
  assert.equal(p.to, '2026-11-01');
  assert.deepEqual(p.accounts, ['Axis Bank - 99']);
  assert.equal(p.lines.length, 4);
  assert.deepEqual(p.lines[0], {
    row: 2, paidAt: '2026-09-02', time: '09:15:00', details: 'Money sent to Test Payee', counterparty: 'shop1@example',
    accountLabel: 'Axis Bank - 99', direction: 'debit', amountPaise: 25000, upiRef: '600000000001', orderId: null,
    remarks: 'Vegetables', tag: '#💰 Pocket Money',
  });
  assert.equal(p.lines[1].amountPaise, 1234500);
  assert.equal(p.lines[1].orderId, '70000000001');
  assert.equal(p.lines[2].direction, 'credit');
  assert.equal(p.lines[3].tag, null);
  assert.deepEqual(p.failed, []);
});

test('works with shared strings and with references stored as numbers', () => {
  const wb = readWorkbook(paytmExport({ rows, shared: true }));
  wb[1].rows[1][6] = 600000000001;
  assert.equal(parsePaytmExport(wb).lines[0].upiRef, '600000000001');
});

test('a garbled reference is listed as failed; a blank one is kept with no reference (other accounts have none)', () => {
  const p = parse({ rows: [...rows, { date: '2026-09-06', amount: -100, ref: '' }, { date: '2026-09-07', amount: -100, ref: 'ABC' }] });
  assert.equal(p.lines.length, 5);
  assert.equal(p.lines[4].upiRef, null);
  assert.equal(p.failed.length, 1);
  assert.match(p.failed[0].reason, /reference/i);
  assert.equal(p.failed[0].row, 7); // the sheet row, so it can be found
});

test('a row with an unreadable amount or date is listed as failed', () => {
  const wb = readWorkbook(paytmExport({ rows }));
  wb[1].rows[1][5] = 'lots';
  wb[1].rows[2][0] = '31/02/2026';
  const p = parsePaytmExport(wb);
  assert.equal(p.lines.length, 2);
  assert.deepEqual(p.failed.map((f) => f.row), [2, 3]);
});

test('fully blank rows are skipped silently', () => {
  const wb = readWorkbook(paytmExport({ rows }));
  wb[1].rows.push([null, null, null], []);
  const p = parsePaytmExport(wb);
  assert.equal(p.lines.length, 4);
  assert.equal(p.failed.length, 0);
});

test('layout drift fails loudly', () => {
  assert.throws(() => parsePaytmExport(readWorkbook(buildXlsx([{ name: 'Other', rows: [['x']] }]))), /Paytm/i);
  const wb = readWorkbook(paytmExport({ rows }));
  wb[1].rows[0][6] = 'Reference';
  assert.throws(() => parsePaytmExport(wb), /UPI Ref/i);
});

test('the circle tag matches however the export dresses it (emoji, hash, case)', () => {
  assert.equal(tagMatches('#💰 Pocket Money', 'Pocket Money'), true);
  assert.equal(tagMatches('#pocket money', 'Pocket Money'), true);
  assert.equal(tagMatches('Pocket  Money ', 'pocket money'), true);
  assert.equal(tagMatches('#🧾 Bill Payments', 'Pocket Money'), false);
  assert.equal(tagMatches(null, 'Pocket Money'), false);
  assert.equal(tagMatches('#💰 Pocket Money', ''), false);
});
