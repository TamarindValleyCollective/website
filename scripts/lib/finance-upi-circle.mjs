// The UPI circle view: what each UPI row (BHIM or Paytm) is doing against the bank statement, and how much of each
// calendar month's circle allowance is used. Pure and I/O-free (finance-upi-circle.test.mjs).

// The circle cap: Rs 15,000 per calendar month, counted over payments marked as circle payments. Confirmed by Sharath
// (docs/finance/DESIGN.md, decisions table). A constant, not a setting, until it needs to change.
export const CIRCLE_CAP_PAISE = 1_500_000;

/**
 * Where a UPI row stands against the bank statement:
 *   matched    joined to a bank line (it is in the ledger)
 *   waiting    dated on or after the last bank line we hold: its statement has not been imported yet
 *   unmatched  inside a statement we hold but no bank line carries its reference: worth a look
 */
export function matchState(upi, lastBankDate) {
  if (upi.bankLineId) return 'matched';
  if (!lastBankDate || upi.paidAt >= lastBankDate) return 'waiting';
  return 'unmatched';
}

/** Circle spend per calendar month, newest first: [{ month: '2026-08', paise, count, capPaise, over }]. Only circle payments out count. */
export function circleMonths(upiLines, capPaise = CIRCLE_CAP_PAISE) {
  const by = new Map();
  for (const u of upiLines) {
    if (!u.isCircle || u.direction !== 'debit') continue;
    const month = u.paidAt.slice(0, 7);
    const m = by.get(month) ?? { month, paise: 0, count: 0, capPaise, over: false };
    m.paise += u.amountPaise;
    m.count += 1;
    m.over = m.paise > capPaise;
    by.set(month, m);
  }
  return [...by.values()].sort((a, b) => (a.month < b.month ? 1 : -1));
}

/**
 * Bank UPI debits that no UPI row explains, from the first day we hold any UPI row (before it there is nothing to match).
 * `bankLines`: [{ id, tranDate, direction, amountPaise, upiRrn }]; `linkedIds`: Set of bank line ids that have a UPI row;
 * `reversedIds`: Set of bank line ids that are a payment the bank reversed (a failed payment needs no UPI record).
 */
export function bankWithoutUpiRow(bankLines, linkedIds, firstUpiDate, reversedIds = new Set()) {
  const out = { count: 0, totalPaise: 0 };
  if (!firstUpiDate) return out;
  for (const b of bankLines) {
    if (!b.upiRrn || b.direction !== 'debit' || b.tranDate < firstUpiDate || linkedIds.has(b.id) || reversedIds.has(b.id)) continue;
    out.count += 1;
    out.totalPaise += b.amountPaise;
  }
  return out;
}
