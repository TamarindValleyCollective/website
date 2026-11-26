// Run with: node --test scripts/lib/finance-payroll-history.test.mjs
// Allocating old salary batches from their PayPro files (docs/finance/sessions/09-payroll.md, the history import). Every name and amount is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { monthOfBatch, parsePayproRows, planSalaryHistory } from './finance-payroll-history.mjs';

const row = (amount, name, extra = {}) => ['N', amount, '03-11-2026', name, '1234567890', 'a@b.c', extra.g ?? 'Oct 2026 Salary', '000111222', '2026-Oct-Employee-001', 'ABCD0123456', '10', 'Salary for Oct 2026'];

test('a file is read by column: amount in B, name in D; rows with no number are ignored', () => {
  const rows = [row(12000, 'Asha Rao'), row('15,500', 'Bala K'), ['', '', '', '', ''], ['Total', 'x']];
  assert.deepEqual(parsePayproRows(rows), [{ name: 'Asha Rao', amountPaise: 1200000 }, { name: 'Bala K', amountPaise: 1550000 }]);
});

test('the salary month comes from the narration column, in either "Oct 2026 Salary" or "Oct-2026" style, else from the file name', () => {
  assert.equal(monthOfBatch([row(1, 'A')], 'x.xlsx'), '2026-10');
  assert.equal(monthOfBatch([row(1, 'A', { g: 'Nov-2023 Salary' })], 'x.xls'), '2023-11');
  assert.equal(monthOfBatch([row(1, 'A', { g: '' })].map((r) => r.map((c, i) => (i === 11 ? '' : c))), '07-TVC-PAYPRO Oct-salary-2026.xlsx'), '2026-10');
  assert.equal(monthOfBatch([['x']], 'nothing.xlsx'), null);
});

const parties = [{ id: 'p1', name: 'Asha Rao', kind: 'employee' }, { id: 'p2', name: 'Bala K', kind: 'employee' }];
const batch = { label: 'Oct 2026', month: '2026-10', entries: [{ name: 'Asha Rao', amountPaise: 1200000 }, { name: 'Bala K', amountPaise: 1550000 }, { name: 'Unknown Person', amountPaise: 500000 }] };
const line = { id: 'L1', tran_date: '2026-11-03', direction: 'debit', amount_paise: 3250000 };

test('a batch matches the one unallocated debit of its total; each person becomes a Salaries allocation for the salary month', () => {
  const plan = planSalaryHistory({ batches: [batch], lines: [line], allocatedLineIds: new Set(), categoryId: 'cat', parties });
  assert.equal(plan.plans.length, 1);
  const { lineId, rows } = plan.plans[0];
  assert.equal(lineId, 'L1');
  assert.deepEqual(rows.map((r) => [r.party_id, r.amount_paise, r.period, r.nature, r.source, r.category_id]), [
    ['p1', 1200000, '2026-10-01', 'Oct Salary', 'import', 'cat'],
    ['p2', 1550000, '2026-10-01', 'Oct Salary', 'import', 'cat'],
    [null, 500000, '2026-10-01', 'Oct Salary', 'import', 'cat'],
  ]);
  assert.equal(rows.reduce((s, r) => s + r.amount_paise, 0), line.amount_paise);
  assert.deepEqual(plan.counts, { batches: 1, planned: 1, allocations: 3, withParty: 2, withoutParty: 1, noLine: 0, ambiguous: 0, alreadyAllocated: 0 });
});

test('a line that already has allocations is never touched; a batch with no line, or two equally good lines, is reported and not planned', () => {
  const done = planSalaryHistory({ batches: [batch], lines: [line], allocatedLineIds: new Set(['L1']), categoryId: 'cat', parties });
  assert.equal(done.plans.length, 0);
  assert.equal(done.counts.alreadyAllocated, 1);
  const none = planSalaryHistory({ batches: [batch], lines: [{ ...line, amount_paise: 1 }], allocatedLineIds: new Set(), categoryId: 'cat', parties });
  assert.equal(none.counts.noLine, 1);
  const two = planSalaryHistory({ batches: [batch], lines: [line, { ...line, id: 'L2' }], allocatedLineIds: new Set(), categoryId: 'cat', parties });
  assert.equal(two.plans.length, 0);
  assert.equal(two.counts.ambiguous, 1);
});

test('only a debit paid after the salary month starts, within 75 days, counts; a credit of the same amount does not', () => {
  const far = planSalaryHistory({ batches: [batch], lines: [{ ...line, tran_date: '2027-03-01' }, { ...line, id: 'L3', direction: 'credit' }, { ...line, id: 'L4', tran_date: '2026-09-30' }], allocatedLineIds: new Set(), categoryId: 'cat', parties });
  assert.equal(far.counts.noLine, 1);
});

test('a name must match one employee party exactly enough: two employees with the same name leave the row with no party', () => {
  const dup = [...parties, { id: 'p3', name: 'Asha Rao', kind: 'employee' }];
  const plan = planSalaryHistory({ batches: [batch], lines: [line], allocatedLineIds: new Set(), categoryId: 'cat', parties: dup });
  assert.equal(plan.plans[0].rows[0].party_id, null);
});

test('two batches never claim the same line', () => {
  const plan = planSalaryHistory({ batches: [batch, { ...batch, label: 'Oct 2026 copy' }], lines: [line], allocatedLineIds: new Set(), categoryId: 'cat', parties });
  assert.equal(plan.plans.length, 1);
  assert.equal(plan.counts.noLine, 1);
});

test('an alias maps a spelling in the file to a named party; it wins over name matching, and a person sharing an account is not merged', () => {
  const withAlias = [...parties, { id: 'p9', name: 'Ramadhas Ramaboi', kind: 'employee' }];
  const b = { label: 'x', month: '2026-10', entries: [{ name: 'Ramdas', amountPaise: 100 }, { name: 'Asha Rao', amountPaise: 200 }] };
  const l = { id: 'L9', tran_date: '2026-11-03', direction: 'debit', amount_paise: 300 };
  const plan = planSalaryHistory({ batches: [b], lines: [l], allocatedLineIds: new Set(), categoryId: 'cat', parties: withAlias, aliases: [{ name: 'RAMDAS', partyId: 'p9' }, { name: 'Asha Rao', partyId: 'p2' }] });
  assert.deepEqual(plan.plans[0].rows.map((r) => r.party_id), ['p9', 'p2']);
  // an alias to a party that is not an employee in the register is ignored, not trusted
  const bad = planSalaryHistory({ batches: [b], lines: [l], allocatedLineIds: new Set(), categoryId: 'cat', parties: withAlias, aliases: [{ name: 'Ramdas', partyId: 'nobody' }] });
  assert.equal(bad.plans[0].rows[0].party_id, null);
});
