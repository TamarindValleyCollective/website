// Where a bank line came from: the channel the money moved through. A line has two independent facts: the bank ACCOUNT it
// hit and the CHANNEL it came through (a UPI app can pay from any linked account; a gateway settles into one). Derived at
// read time, never stored, so a corrected rule applies to every line at once. Pure and I/O-free (finance-origin.test.mjs).
//
// To add a channel (a POS terminal, a second gateway): one entry in CHANNELS, and, if the bank's narration identifies it,
// one rule in RULES. A channel that has a statement of its own (like BHIM and Paytm) is instead identified by the row
// joined to the bank line (`upiApp`); a later gateway-settlement import would do the same.
//
//   kind  upi_app | bulk | gateway | card | bank   what sort of channel it is (for grouping and future rules)
//   flows ['in'] | ['out'] | ['in','out']          which way money moves through it (documentation, and for filters later)

export const CHANNELS = {
  bhim: { label: 'BHIM', kind: 'upi_app', flows: ['out'], hint: 'Paid in the BHIM UPI app' },
  paytm: { label: 'Paytm', kind: 'upi_app', flows: ['out'], hint: 'Paid in the Paytm UPI app' },
  paypro: { label: 'Paypro', kind: 'bulk', flows: ['out'], hint: 'Bulk payment through the Paypro module of the bank' },
  gateway: { label: 'Payment gateway', kind: 'gateway', flows: ['in'], hint: 'Settlement from the online payment gateway (Razorpay)' },
  card: { label: 'Debit card', kind: 'card', flows: ['out', 'in'], hint: 'A debit-card payment at a shop or online, or its refund' },
  bank: { label: 'Bank direct', kind: 'bank', flows: ['in', 'out'], hint: 'Internet banking, NEFT, IMPS, cheque or bank charges' },
  upi_unknown: { label: 'UPI (app unknown)', kind: 'upi_app', flows: ['in', 'out'], hint: 'A UPI payment with no BHIM or Paytm record' },
};
// Kept under its first name too: the ledger and the search chips call these "origins".
export const ORIGINS = CHANNELS;

// Narration rules, first match wins. `test(narration, direction)`. Each is a reading of what the bank writes, not a label
// the bank gives; say so in FINANCE.md when one is added.
const RULES = [
  // Bank-side bulk file: NEFT/<number>/<number>/ with no payee name (agreed with Sharath 2026-11-07).
  ['paypro', (n, d) => d === 'debit' && /^NEFT\/\d+\/\d+\//i.test(n)],
  // The gateway pays out to the account in its own name (the one credit seen so far: "Razorpay Software Pvt Ltd Fu…").
  ['gateway', (n, d) => d === 'credit' && /^razorpay\b/i.test(n)],
  // Card: shop (POS/), online (ECOM PUR/) and the refunds of those (VISA MERCH Refund).
  ['card', (n) => /^(POS|ECOM PUR)\//i.test(n) || /^VISA MERCH Refund/i.test(n)],
];

/** @param {{ narration: string, direction: 'debit'|'credit' }} line  @param {'bhim'|'paytm'|null|undefined} upiApp the app of the joined UPI row, if any */
export function originOf(line, upiApp) {
  if (upiApp === 'bhim' || upiApp === 'paytm') return upiApp;
  const narration = String(line.narration ?? '').trim();
  for (const [id, test] of RULES) if (test(narration, line.direction)) return id;
  if (/^UPI\//i.test(narration)) return 'upi_unknown';
  return 'bank';
}

export const originLabel = (origin) => CHANNELS[origin]?.label ?? origin;

/**
 * The badges for a ledger line: which records vouch for it. The bank statement is always one (the bank badge of the account the
 * line is on, or the generic 'bank' badge when the account has none); a joined BHIM or Paytm row adds that app; a Paypro or
 * gateway narration adds Paypro or Razorpay. Keys into fin_source_badges (migration 0090), in the order they are shown.
 * `origin` is originOf()'s answer for the line.
 */
export function sourcesOf({ bankBadge, origin }) {
  const out = [bankBadge || 'bank'];
  if (origin === 'bhim' || origin === 'paytm') out.push(origin);
  else if (origin === 'paypro') out.push('paypro');
  else if (origin === 'gateway') out.push('razorpay');
  return out;
}
