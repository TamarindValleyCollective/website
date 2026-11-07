// Run with: node --test scripts/lib/finance-reversals.test.mjs
// Invented lines in the shape of a real statement's failed-then-reversed UPI payments.
import test from 'node:test';
import assert from 'node:assert/strict';
import { REVERSAL_DAYS, pairReversals } from './finance-reversals.mjs';

const line = (id, direction, date, amountPaise, upiRrn) => ({ id, direction, date, amountPaise, upiRrn });

test('a debit and a credit with the same reference and amount on the same day are an original and its reversal', () => {
  const { pairs, byLine } = pairReversals([line('d1', 'debit', '2026-07-27', 305500, '600000000001'), line('c1', 'credit', '2026-07-27', 305500, '600000000001')]);
  assert.deepEqual(pairs, [{ debitId: 'd1', creditId: 'c1' }]);
  assert.deepEqual(byLine.get('d1'), { role: 'original', otherId: 'c1' });
  assert.deepEqual(byLine.get('c1'), { role: 'reversal', otherId: 'd1' });
});

test('three failed payments of the same amount each pair with their own reversal, by reference, whatever the order', () => {
  const lines = [
    line('c3', 'credit', '2026-07-27', 305500, '600000000003'), line('d1', 'debit', '2026-07-27', 305500, '600000000001'),
    line('c1', 'credit', '2026-07-27', 305500, '600000000001'), line('d3', 'debit', '2026-07-27', 305500, '600000000003'),
    line('d2', 'debit', '2026-07-27', 305500, '600000000002'), line('c2', 'credit', '2026-07-27', 305500, '600000000002'),
  ];
  const { pairs } = pairReversals(lines);
  assert.deepEqual(pairs.map((p) => `${p.debitId}-${p.creditId}`).sort(), ['d1-c1', 'd2-c2', 'd3-c3']);
});

test('a refund under a different reference, a different amount, or a credit before the debit is not a reversal', () => {
  assert.deepEqual(pairReversals([line('d', 'debit', '2026-07-27', 100, '600000000001'), line('c', 'credit', '2026-07-28', 100, '600000000002')]).pairs, []);
  assert.deepEqual(pairReversals([line('d', 'debit', '2026-07-27', 100, '600000000001'), line('c', 'credit', '2026-07-27', 90, '600000000001')]).pairs, []);
  assert.deepEqual(pairReversals([line('d', 'debit', '2026-07-27', 100, '600000000001'), line('c', 'credit', '2026-07-26', 100, '600000000001')]).pairs, []);
});

test('a reversal may land a few days later, but not after the allowed days', () => {
  assert.equal(pairReversals([line('d', 'debit', '2026-07-27', 100, '6'), line('c', 'credit', '2026-07-29', 100, '6')]).pairs.length, 1);
  assert.equal(pairReversals([line('d', 'debit', '2026-07-01', 100, '6'), line('c', 'credit', `2026-07-0${1 + REVERSAL_DAYS}`, 100, '6')]).pairs.length, 1);
  assert.equal(pairReversals([line('d', 'debit', '2026-07-01', 100, '6'), line('c', 'credit', '2026-07-10', 100, '6')]).pairs.length, 0);
});

test('lines with no reference, and a credit that is nobody’s reversal, are left alone; each line is used once', () => {
  const { pairs, byLine } = pairReversals([
    line('d', 'debit', '2026-07-27', 100, null), line('c', 'credit', '2026-07-27', 100, null),
    line('d1', 'debit', '2026-07-27', 100, '6'), line('c1', 'credit', '2026-07-27', 100, '6'), line('c2', 'credit', '2026-07-27', 100, '6'),
  ]);
  assert.deepEqual(pairs, [{ debitId: 'd1', creditId: 'c1' }]);
  assert.equal(byLine.has('c2'), false);
  assert.equal(byLine.has('d'), false);
});
