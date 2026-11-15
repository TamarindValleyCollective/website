// The UPI circle view: what each UPI row (BHIM or Paytm) is doing against the bank statement, and how much of each
// calendar month's circle allowance is used. Pure and I/O-free (finance-upi-circle.test.mjs).
import { delegateLabel } from './finance-delegates.mjs';

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

/**
 * Circle spend per calendar month, newest first: [{ month: '2026-08', paise, count, capPaise, over }]. Only circle payments out count.
 * With `delegates` (and each line's `delegateId`), every month also carries `byDelegate`: one bucket per delegate, each against
 * its own limit (the delegate's, else `capPaise`), plus a bucket with `delegateId: null` for payments not tied to one; the month
 * is `over` when any bucket is. Without `delegates` the result is the single total it always was.
 * @param {any[]} upiLines
 * @param {number} [capPaise]
 * @param {any[] | null} [delegates]
 * @returns {any[]}
 */
export function circleMonths(upiLines, capPaise = CIRCLE_CAP_PAISE, delegates = null) {
  const by = new Map();
  const byId = new Map((delegates ?? []).map((d) => [d.id, d]));
  for (const u of upiLines) {
    if (!u.isCircle || u.direction !== 'debit') continue;
    const month = u.paidAt.slice(0, 7);
    const m = by.get(month) ?? { month, paise: 0, count: 0, capPaise, over: false, buckets: new Map() };
    m.paise += u.amountPaise;
    m.count += 1;
    if (delegates) {
      const id = byId.has(u.delegateId) ? u.delegateId : null;
      const b = m.buckets.get(id) ?? { delegateId: id, label: id ? delegateLabel(byId.get(id)) : null, paise: 0, count: 0, capPaise: byId.get(id)?.capPaise ?? capPaise, over: false };
      b.paise += u.amountPaise;
      b.count += 1;
      b.over = b.paise > b.capPaise;
      m.buckets.set(id, b);
      m.over = [...m.buckets.values()].some((x) => x.over);
    } else m.over = m.paise > capPaise;
    by.set(month, m);
  }
  return [...by.values()]
    .map(({ buckets, ...m }) => (delegates ? { ...m, byDelegate: [...buckets.values()].sort((a, b) => b.paise - a.paise) } : m))
    .sort((a, b) => (a.month < b.month ? 1 : -1));
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
