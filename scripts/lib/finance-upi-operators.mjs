// Whose UPI a file is (docs/finance/FINANCE.md, "UPI operators"). All UPI payments go out through the UPI setup of one of the account's
// operators; the Paytm and BHIM exports are in that operator's name but never say which, so the import asks, and this gives it an idea.
// Pure and I/O-free (finance-upi-operators.test.mjs).
//
// A file has a SIGNATURE: what it looks like, independent of the period, as a short hash (never the account labels or the id itself): for a
// Paytm export, the list of accounts its Summary sheet names; for a BHIM history, the sender id that pays most of its rows. Once an operator
// has confirmed a file, its signature is remembered for them, so the next file with the same signature is suggested to the same operator.
// A suggestion is only that: the import always asks, with the suggestion chosen, and an operator is never assigned without a choice.

const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/** A short stable hash of a string (FNV-1a, two 32-bit passes), as 16 hex digits. Not a secret: it only keeps the labels out of the database. */
export function shortHash(text) {
  let a = 0x811c9dc5, b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ (c + i), 0x85ebca6b) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/**
 * What this file looks like, or null when nothing in it identifies the operator. `parsed`: the parser's result (parsePaytmExport / parseBhimStatement).
 */
export function signatureOf(kind, parsed) {
  if (kind === 'paytm_upi') {
    const accounts = [...new Set((parsed?.accounts ?? []).map(norm).filter(Boolean))].sort();
    return accounts.length ? `paytm:${shortHash(accounts.join('|'))}` : null;
  }
  if (kind === 'bhim_upi') {
    const count = new Map();
    for (const l of parsed?.lines ?? []) {
      const id = norm(l.sender?.id);
      if (id && id !== 'n/a') count.set(id, (count.get(id) ?? 0) + 1);
    }
    const top = [...count].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0];
    return top ? `bhim:${shortHash(top[0])}` : null;
  }
  return null;
}

/**
 * Who this file is probably from: the one operator who has had a file with the same signature before ('same_file_layout'), or, when there is
 * only one operator, that operator ('only_operator'). null when it cannot be told (nobody matches, or two operators do).
 * @param {{ signature: string | null, operators: { id: string, signatures?: string[] }[] }} a
 * @returns {{ operatorId: string, reason: 'same_file_layout' | 'only_operator' } | null}
 */
export function suggestOperator({ signature, operators }) {
  const matches = signature ? operators.filter((o) => (o.signatures ?? []).includes(signature)) : [];
  if (matches.length === 1) return { operatorId: matches[0].id, reason: 'same_file_layout' };
  if (matches.length === 0 && operators.length === 1) return { operatorId: operators[0].id, reason: 'only_operator' };
  return null;
}

/** An operator's remembered signatures with one more (newest last, no repeats, at most 20). */
export function withSignature(signatures, signature) {
  if (!signature) return signatures ?? [];
  return [...new Set([...(signatures ?? []), signature])].slice(-20);
}

/** An operator's name as typed, checked: { value } trimmed, or { error } in plain words. */
export function validateOperatorName(name) {
  const v = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
  if (v.length < 2 || v.length > 60) return { error: 'An operator’s name is 2 to 60 characters.' };
  return { value: v };
}
