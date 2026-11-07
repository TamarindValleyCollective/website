// A note on a payment, kept beside the wording the bank or the UPI app gave it (that wording is never changed). Pure and
// I/O-free (finance-notes.test.mjs). A UPI payment and its bank line are one payment and share one note, so the key is the
// 12-digit UPI reference when there is one ('upi:<reference>'), else the bank line ('bank:<id>').
import { auditDetailIsSafe } from './finance-parties.mjs';

export const NOTE_KEY = /^(upi:[0-9]{12}|bank:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
export const NOTE_MAX = 300;

/** The key of a payment's note. `upiRef` is the reference of a UPI row, or `upiRrn` that of a bank line's narration. */
export function noteKeyOf({ upiRef, upiRrn, bankLineId }) {
  const ref = upiRef || upiRrn;
  if (ref) return `upi:${ref}`;
  return bankLineId ? `bank:${bankLineId}` : null;
}

/** -> { note } (null clears it) or { error }. A note is a plain description: it may not carry an account number, UPI id or IFSC. */
export function validateNote(raw) {
  if (raw === null || raw === undefined) return { note: null };
  if (typeof raw !== 'string') return { error: 'The note must be text.' };
  const note = raw.trim().replace(/\s+/g, ' ');
  if (!note) return { note: null };
  if (note.length > NOTE_MAX) return { error: `Keep the note under ${NOTE_MAX} characters.` };
  if (!auditDetailIsSafe(note)) return { error: "Don't type an account number, UPI id or IFSC code in a note." };
  return { note };
}

/** What to show for a payment: the note if there is one, else the wording the app gave it (a Paytm remark), else nothing. */
export function effectiveNote(note, appRemark) {
  const own = note ?? null;
  if (own) return { text: own, from: 'note' };
  const given = appRemark ? String(appRemark).trim() : '';
  return given ? { text: given, from: 'app' } : { text: '', from: null };
}
