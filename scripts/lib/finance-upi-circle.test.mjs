// Run with: node --test scripts/lib/finance-upi-circle.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { CIRCLE_CAP_PAISE, bankWithoutUpiRow, circleMonths, matchState } from './finance-upi-circle.mjs';

test('a row joined to a bank line is matched; after the last bank line it waits; inside the statement it is unmatched', () => {
  assert.equal(matchState({ bankLineId: 'b1', paidAt: '2026-08-01' }, '2026-10-01'), 'matched');
  assert.equal(matchState({ bankLineId: null, paidAt: '2026-10-01' }, '2026-10-01'), 'waiting');
  assert.equal(matchState({ bankLineId: null, paidAt: '2026-08-01' }, '2026-10-01'), 'unmatched');
  assert.equal(matchState({ bankLineId: null, paidAt: '2026-08-01' }, null), 'waiting');
});

test('circle months add only circle payments out, per calendar month, newest first, and flag going over the cap', () => {
  const u = (paidAt, amountPaise, o = {}) => ({ paidAt, amountPaise, isCircle: true, direction: 'debit', ...o });
  const months = circleMonths([
    u('2026-08-31', 1_000_000), u('2026-08-02', 500_000), u('2026-08-03', 1), u('2026-09-01', 200_000),
    u('2026-09-02', 900_000, { isCircle: false }), u('2026-09-03', 50_000, { direction: 'credit' }),
  ]);
  assert.deepEqual(months.map((m) => [m.month, m.paise, m.count, m.over]), [['2026-09', 200_000, 1, false], ['2026-08', 1_500_001, 3, true]]);
  assert.equal(months[0].capPaise, CIRCLE_CAP_PAISE);
  assert.equal(circleMonths([u('2026-08-01', 1_500_000)])[0].over, false); // exactly the cap is within it
});

test('bank UPI debits with no UPI row count only from the first UPI row onwards', () => {
  const bank = [
    { id: 'a', tranDate: '2026-06-01', direction: 'debit', amountPaise: 100, upiRrn: '1' },
    { id: 'b', tranDate: '2026-07-01', direction: 'debit', amountPaise: 200, upiRrn: '2' },
    { id: 'c', tranDate: '2026-07-02', direction: 'debit', amountPaise: 300, upiRrn: '3' },
    { id: 'd', tranDate: '2026-07-03', direction: 'credit', amountPaise: 400, upiRrn: '4' },
    { id: 'e', tranDate: '2026-07-04', direction: 'debit', amountPaise: 500, upiRrn: null },
  ];
  assert.deepEqual(bankWithoutUpiRow(bank, new Set(['c']), '2026-06-15'), { count: 1, totalPaise: 200 });
  assert.deepEqual(bankWithoutUpiRow(bank, new Set(), null), { count: 0, totalPaise: 0 });
});
