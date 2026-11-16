// UPI IDs (VPAs) in a ledger line and what Razorpay's lookup says about them. Pure and I/O-free (finance-vpa.test.mjs).
//
// A UPI payment to a person often carries no name, only their UPI ID ("q000111222@ybl on PhonePe"). Razorpay can say whose ID it is, so a
// line can be suggested under that person's name instead of the bare ID. The lookup itself lives in netlify/functions/lib/finance-vpa.ts;
// the suggestion engine reads the answers through `vpaNames` (finance-suggest.mjs).

import { maskUpiId } from './finance-access.mjs';

/** How many IDs one lookup request may carry: the lookup is a billed call at Razorpay, so it is asked for in small, deliberate batches. */
export const VPA_LOOKUP_LIMIT = 25;

// name@handle: the part before the @ is letters, digits, dot, dash, underscore; the handle is letters and digits. Not followed by more handle
// characters or a dot, so an e-mail address ("name@example.com") is not taken for one.
const VPA = /(?<![\w.@-])([a-z0-9][a-z0-9._-]{1,255})@([a-z][a-z0-9]{1,63})(?![\w.-])/i;

/** The UPI ID inside `text`, lowercased, or null. */
export function vpaIn(text) {
  const m = VPA.exec(String(text ?? ''));
  return m ? `${m[1]}@${m[2]}`.toLowerCase() : null;
}

/** True when the whole string is one UPI ID (nothing else around it). */
export function isVpa(text) {
  const s = String(text ?? '').trim();
  return Boolean(s) && vpaIn(s) === s.toLowerCase();
}

/**
 * The IDs worth looking up: those in `texts`, once each, that are not in `known` (a Set of lowercase IDs already looked up), and never more than
 * `limit`. Order is the order first seen, so the lines at the top of the ledger come first.
 * @param {Array<string | null | undefined>} texts @param {Set<string>} known @param {number} [limit]
 */
export function vpasToLookUp(texts, known, limit = VPA_LOOKUP_LIMIT) {
  const out = [];
  const seen = new Set();
  for (const t of texts) {
    const v = vpaIn(t);
    if (!v || known.has(v) || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * The UPI table's two derived columns for one row, from its "Paid to" text and the answers kept so far (`answers.names` by lowercase ID,
 * `answers.known` every ID already asked about). `upiId` follows the masking rule for payee UPI IDs: the whole ID only for someone who may see
 * payee bank details (`canSeeIds`), otherwise "p••••@bank". `vpaState`: 'named' (Razorpay gave a name), 'asked' (looked up, no name on file),
 * 'new' (not looked up yet), or null (no UPI ID in the text). Nothing here is stored on the UPI row.
 * @param {string | null | undefined} text @param {{ names: Record<string, string>, known: Set<string> }} answers @param {boolean} canSeeIds
 */
export function vpaFieldsFor(text, answers, canSeeIds) {
  const vpa = vpaIn(text);
  if (!vpa) return { upiId: null, vpaName: null, vpaState: null };
  const vpaName = answers.names[vpa] ?? null;
  return { upiId: canSeeIds ? vpa : maskUpiId(vpa), vpaName, vpaState: vpaName ? 'named' : answers.known.has(vpa) ? 'asked' : 'new' };
}

/** The registered name in a Razorpay validate-VPA response, or null when the ID does not exist or came back without a name. */
export function nameFromLookup(body) {
  if (!body || body.success !== true) return null;
  const name = String(body.customer_name ?? '').replace(/\s+/g, ' ').trim();
  return name || null;
}
