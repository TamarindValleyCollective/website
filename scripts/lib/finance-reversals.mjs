// A UPI payment that fails after the bank has taken the money is reversed: the bank adds a credit for the same amount that
// carries the SAME 12-digit UPI reference as the debit it undoes. Seen on a real statement: three failed payments, each followed
// by a credit with the debit's reference, the same amount, the same day. This pairs them so both lines can be shown as
// reversed and left out of "no UPI record" counts. Pure and I/O-free (finance-reversals.test.mjs).
//
// A line here is { id, date (ISO), direction ('debit'|'credit'), amountPaise, upiRrn }. A pair is a debit and a credit with the
// same reference and amount, the credit dated the same day as the debit or up to REVERSAL_DAYS later. It never invents a pair
// across different references: a refund from the payee arrives under a new reference and is not a reversal.

export const REVERSAL_DAYS = 7;

const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/**
 * @returns {{ pairs: { debitId: string, creditId: string }[], byLine: Map<string, { role: 'original'|'reversal', otherId: string }> }}
 * Within one reference the debits and credits are matched oldest first, each line used at most once.
 */
export function pairReversals(lines) {
  const groups = new Map();
  for (const l of lines) {
    if (!l.upiRrn) continue;
    groups.set(l.upiRrn, [...(groups.get(l.upiRrn) ?? []), l]);
  }
  const pairs = [];
  const byLine = new Map();
  for (const group of groups.values()) {
    const byDate = (x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.id < y.id ? -1 : 1);
    const debits = group.filter((l) => l.direction === 'debit').sort(byDate);
    const credits = group.filter((l) => l.direction === 'credit').sort(byDate);
    for (const d of debits) {
      const i = credits.findIndex((c) => c.amountPaise === d.amountPaise && daysBetween(d.date, c.date) >= 0 && daysBetween(d.date, c.date) <= REVERSAL_DAYS);
      if (i < 0) continue;
      const [c] = credits.splice(i, 1);
      pairs.push({ debitId: d.id, creditId: c.id });
      byLine.set(d.id, { role: 'original', otherId: c.id });
      byLine.set(c.id, { role: 'reversal', otherId: d.id });
    }
  }
  return { pairs, byLine };
}
