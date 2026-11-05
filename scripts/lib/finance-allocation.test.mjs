// Run with: node --test scripts/lib/finance-allocation.test.mjs
// The ledger's posting rules (docs/finance/DESIGN.md, "Allocation and review"). Every amount is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { financialYearOf, lineState, netEffect, periodOf, periodWriteDecision, planPosting, planReversal, remainingToAllocate } from './finance-allocation.mjs';

const debit = { id: 'L1', direction: 'debit', amount_paise: 100000, tran_date: '2026-10-31' };
const row = (amountPaise, extra = {}) => ({ amountPaise, categoryId: 'c1', partyId: 'p1', nature: 'Vegetable seedlings', period: '2026-10-01', ...extra });

test('period is the first day of the month, financial year starts in April', () => {
  assert.equal(periodOf('2026-10-31'), '2026-10-01');
  assert.equal(periodOf('2027-01-05'), '2027-01-01');
  assert.equal(financialYearOf('2026-03-31'), 2025);
  assert.equal(financialYearOf('2026-04-01'), 2026);
  assert.equal(financialYearOf('2026-10-01'), 2026);
});

test('a single allocation for the whole line posts', () => {
  const plan = planPosting(debit, [row(100000)]);
  assert.equal(plan.ok, true);
  assert.equal(plan.remainderPaise, 0);
});

test('posting refuses a sum that does not match the line', () => {
  const short = planPosting(debit, [row(60000)]);
  assert.equal(short.ok, false);
  assert.equal(short.remainderPaise, 40000);
  assert.match(short.errors.join(' '), /still to allocate/i);
  const over = planPosting(debit, [row(60000), row(50000)]);
  assert.equal(over.ok, false);
  assert.equal(over.remainderPaise, -10000);
  assert.match(over.errors.join(' '), /more than the line/i);
});

test('a split of one debit into many posts when the parts add up', () => {
  const plan = planPosting(debit, [row(25000), row(25000, { partyId: 'p2' }), row(50000, { categoryId: 'c2' })]);
  assert.equal(plan.ok, true);
  assert.equal(plan.remainderPaise, 0);
});

test('a draft may leave a remainder; only posting insists on zero', () => {
  const draft = planPosting(debit, [row(60000)], { allowRemainder: true });
  assert.equal(draft.ok, true);
  assert.equal(draft.remainderPaise, 40000);
});

test('every row needs a positive whole-paise amount, a category and a nature', () => {
  for (const bad of [row(0), row(-5), row(10.5), row(100000, { categoryId: '' }), row(100000, { nature: '  ' })]) {
    assert.equal(planPosting(debit, [bad]).ok, false, JSON.stringify(bad));
  }
  assert.equal(planPosting(debit, []).ok, false);
});

test('a row must name a real period (first of a month) and defaults to the line date', () => {
  assert.equal(planPosting(debit, [row(100000, { period: '2026-10-15' })]).ok, false);
  const plan = planPosting(debit, [row(100000, { period: undefined })]);
  assert.equal(plan.ok, true);
  assert.equal(plan.rows[0].period, '2026-10-01');
});

test('a salary line can sit in an earlier month than it was paid', () => {
  const april = { ...debit, tran_date: '2026-05-02' };
  const plan = planPosting(april, [row(100000, { period: '2026-04-01' })]);
  assert.equal(plan.ok, true);
  assert.equal(plan.rows[0].period, '2026-04-01');
});

test('line state is unallocated, partly allocated or allocated', () => {
  assert.equal(lineState(debit, []), 'unallocated');
  assert.equal(lineState(debit, [{ amount_paise: 40000 }]), 'partly_allocated');
  assert.equal(lineState(debit, [{ amount_paise: 40000 }, { amount_paise: 60000 }]), 'allocated');
  assert.equal(remainingToAllocate(debit, [{ amount_paise: 40000 }]), 60000);
});

test('a refund (credit) reverses an earlier debit allocation and nets to zero', () => {
  const original = { id: 'A1', amount_paise: 30000, direction: 'debit' };
  const refundLine = { id: 'L2', direction: 'credit', amount_paise: 30000, tran_date: '2026-11-03' };
  const plan = planReversal(original, [], refundLine, { amountPaise: 30000, reason: 'Order cancelled' });
  assert.equal(plan.ok, true);
  assert.equal(plan.row.reversesAllocationId, 'A1');
  assert.equal(netEffect([{ direction: 'debit', amount_paise: 30000 }, { direction: 'credit', amount_paise: plan.row.amountPaise }]), 0);
});

test('a reversal needs the opposite direction, a reason, and never exceeds what is left', () => {
  const original = { id: 'A1', amount_paise: 30000, direction: 'debit' };
  const credit = { id: 'L2', direction: 'credit', amount_paise: 30000, tran_date: '2026-11-03' };
  const sameWay = { id: 'L3', direction: 'debit', amount_paise: 30000, tran_date: '2026-11-03' };
  assert.equal(planReversal(original, [], sameWay, { amountPaise: 30000, reason: 'x ok' }).ok, false);
  assert.equal(planReversal(original, [], credit, { amountPaise: 30000, reason: '' }).ok, false);
  assert.equal(planReversal(original, [], credit, { amountPaise: 40000, reason: 'too much' }).ok, false);
  // Part already reversed leaves less to reverse.
  const half = planReversal(original, [{ amount_paise: 20000 }], credit, { amountPaise: 15000, reason: 'second part' });
  assert.equal(half.ok, false);
  assert.equal(planReversal(original, [{ amount_paise: 20000 }], credit, { amountPaise: 10000, reason: 'second part' }).ok, true);
  // A reversal cannot itself be reversed.
  assert.equal(planReversal({ ...original, reverses_allocation_id: 'A0' }, [], credit, { amountPaise: 1000, reason: 'again' }).ok, false);
});

test('a closed period rejects without close-period, and an override needs a reason', () => {
  assert.deepEqual(periodWriteDecision('open', [], ''), { ok: true, override: false });
  assert.equal(periodWriteDecision('closed', ['allocate'], '').ok, false);
  assert.equal(periodWriteDecision('closed', ['allocate'], 'Late bill').ok, false);
  assert.equal(periodWriteDecision('closed', ['close-period'], '').ok, false);
  assert.deepEqual(periodWriteDecision('closed', ['close-period'], 'Late bill found in the audit'), { ok: true, override: true });
  // A month nobody has opened yet is open.
  assert.equal(periodWriteDecision(undefined, ['allocate'], '').ok, true);
});
