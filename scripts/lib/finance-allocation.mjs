// The ledger's posting rules (docs/finance/DESIGN.md, "Allocation and review"). Pure and I/O-free so they are tested
// directly (finance-allocation.test.mjs); the database enforces the same sum rule again in fin_post_allocations (0083),
// so a bug here cannot post a line that does not add up.
//
// Money is integer paise, never a float. An allocation's amount is always positive; its direction is its bank line's.
// A refund is an allocation on the incoming line that reverses an earlier one, so reports net by direction.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isPaise = (n) => Number.isSafeInteger(n) && n > 0;

/** First day of the month a date falls in: the accounting period. */
export function periodOf(isoDate) {
  return `${isoDate.slice(0, 7)}-01`;
}

/** The Indian financial year, named by the year it starts (April 2025 - March 2026 = 2025). */
export function financialYearOf(isoDate) {
  const year = Number(isoDate.slice(0, 4));
  return Number(isoDate.slice(5, 7)) >= 4 ? year : year - 1;
}

const sum = (rows, key) => rows.reduce((n, r) => n + r[key], 0);

/** How much of the line is still unexplained (negative = over-allocated). */
export function remainingToAllocate(line, allocations) {
  return line.amount_paise - sum(allocations, 'amount_paise');
}

/** 'unallocated' | 'partly_allocated' | 'allocated' (over-allocation cannot be stored, so it reads as allocated). */
export function lineState(line, allocations) {
  const left = remainingToAllocate(line, allocations);
  if (allocations.length === 0) return 'unallocated';
  return left > 0 ? 'partly_allocated' : 'allocated';
}

/**
 * Check a set of allocation rows for one bank line.
 * rows: [{ amountPaise, categoryId, partyId?, nature, period?, projectId?, remarks? }]
 * Posting needs the rows to add up to the line exactly; a draft (allowRemainder) may leave some of it unexplained but
 * never more than the line. Returns { ok, errors, remainderPaise, rows } with periods defaulted to the line's month.
 */
export function planPosting(line, rows, { allowRemainder = false } = {}) {
  const errors = [];
  if (!rows.length) errors.push('Add at least one allocation.');
  const out = rows.map((r, i) => {
    const n = i + 1;
    if (!isPaise(r.amountPaise)) errors.push(`Row ${n}: the amount must be more than zero, in whole paise.`);
    if (!r.categoryId) errors.push(`Row ${n}: choose a category.`);
    if (!String(r.nature ?? '').trim()) errors.push(`Row ${n}: say in plain words what it was for.`);
    const period = r.period ?? periodOf(line.tran_date);
    if (!ISO_DATE.test(period) || !period.endsWith('-01') || Number.isNaN(Date.parse(period))) {
      errors.push(`Row ${n}: the period must be the first day of a month.`);
    }
    return { ...r, period, nature: String(r.nature ?? '').trim() };
  });
  const remainderPaise = line.amount_paise - out.reduce((n, r) => n + (Number.isFinite(r.amountPaise) ? r.amountPaise : 0), 0);
  if (remainderPaise < 0) errors.push('The rows add up to more than the line.');
  else if (remainderPaise > 0 && !allowRemainder) errors.push('There is still to allocate before this can be posted.');
  return { ok: errors.length === 0, errors, remainderPaise, rows: out };
}

/**
 * A refund or correction: an allocation on `line` that reverses (part of) an earlier allocation.
 * original: the allocation being reversed; priorReversals: reversals already made against it.
 */
export function planReversal(original, priorReversals, line, { amountPaise, reason }) {
  const errors = [];
  if (original.reverses_allocation_id) errors.push('A reversal cannot itself be reversed; reverse the original instead.');
  if (line.direction === original.direction) errors.push('A reversal must be on a line that moves money the other way.');
  if (!String(reason ?? '').trim() || String(reason).trim().length < 3) errors.push('Say why it is being reversed.');
  if (!isPaise(amountPaise)) errors.push('The amount must be more than zero, in whole paise.');
  const left = original.amount_paise - sum(priorReversals, 'amount_paise');
  if (isPaise(amountPaise) && amountPaise > left) errors.push('That is more than is left to reverse.');
  if (isPaise(amountPaise) && amountPaise > line.amount_paise) errors.push('That is more than the line.');
  return {
    ok: errors.length === 0,
    errors,
    row: { amountPaise, reversesAllocationId: original.id, reason: String(reason ?? '').trim(), period: periodOf(line.tran_date) },
  };
}

/** Net money out (positive) or in (negative) of a set of {direction, amount_paise}. */
export function netEffect(items) {
  return items.reduce((n, a) => n + (a.direction === 'debit' ? a.amount_paise : -a.amount_paise), 0);
}

/**
 * Whether an allocation may be written into a period. A closed month rejects unless the person holds `close-period`,
 * and then only with a reason (the override is logged). A month with no row yet is open.
 */
export function periodWriteDecision(status, capabilities, reason) {
  if (status !== 'closed') return { ok: true, override: false };
  if (!capabilities.includes('close-period')) return { ok: false, error: 'That month is closed. Only a director can change it.' };
  if (String(reason ?? '').trim().length < 5) return { ok: false, error: 'That month is closed. Say why it is being changed.' };
  return { ok: true, override: true };
}
