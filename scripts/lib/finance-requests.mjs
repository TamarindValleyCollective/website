// Payment requests and spend logs (docs/finance/sessions/08-payment-requests-and-bills.md). Pure and I/O-free
// (finance-requests.test.mjs). One record type, two kinds:
//   request  raised before paying, then approved by someone else (maker is not checker), then paid and matched to the bank
//   log      a spend already made (a UPI Circle or a direct UPI payment), recorded afterwards by whoever paid; no approval
// A record's purpose is what the UPI page and the ledger show for the payment it is matched to, until a person writes a payment
// note (scripts/lib/finance-notes.mjs), which stays the manual override.
import { auditDetailIsSafe } from './finance-parties.mjs';
import { makerIsNotChecker } from './finance-access.mjs';

export const KINDS = ['request', 'log'];
export const MODES = ['neft', 'upi', 'imps', 'rtgs'];
export const STATUSES = ['submitted', 'approved', 'paid', 'rejected', 'cancelled'];
export const PAID_VIA = ['direct', 'delegate'];
export const PURPOSE_MAX = 300;
export const MAX_AMOUNT_PAISE = 10_000_000_000; // Rs 10 crore: a typo guard, not a policy
export const PROPOSAL_DAYS_UPI = 3; // a UPI payment is dated within this many days of what the person typed
export const PROPOSAL_DAYS_BANK = 21; // a NEFT or IMPS payment lands after the approval, within this many days

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const realDate = (s) => typeof s === 'string' && ISO_DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/** A typed UPI reference: exactly 12 digits (spaces ignored). -> the reference, null when empty, or undefined when invalid. */
export function cleanUpiRef(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).replace(/\s+/g, '');
  if (!s) return null;
  return /^\d{12}$/.test(s) ? s : undefined;
}

/**
 * A reference as a spreadsheet stored it: it drops leading zeros (and may show "123.0" or an integer), so pad to 12 digits.
 * -> the 12-digit reference, or null when it is not a plausible one (empty, letters, more than 12 digits).
 */
export function padUpiRef(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim().replace(/\.0+$/, '');
  if (!/^\d{1,12}$/.test(s)) return null;
  s = s.padStart(12, '0');
  return /^0{12}$/.test(s) ? null : s;
}

/**
 * Check what a person typed for a request or a log. `body` is the JSON from the screen; `today` is an ISO date (India).
 * -> { value } with the normalised fields (camelCase) or { error } in words for the person.
 */
export function validateRecord(body, { kind, today }) {
  if (!body || typeof body !== 'object') return { error: 'Send the details as JSON.' };
  if (!KINDS.includes(kind)) return { error: 'Choose whether this is a request or a spend already made.' };
  const partyId = typeof body.partyId === 'string' && body.partyId ? body.partyId : null;
  if (partyId && !UUID.test(partyId)) return { error: 'Choose the payee from the list.' };
  const recipientText = typeof body.recipientText === 'string' ? body.recipientText.trim().replace(/\s+/g, ' ') : '';
  if (recipientText && (recipientText.length < 2 || recipientText.length > 120 || !auditDetailIsSafe(recipientText))) return { error: 'Type the name of who was paid, without an account number or UPI id.' };
  if (kind === 'request' && !partyId) return { error: 'Choose a payee, or add a new vendor first.' };
  if (kind === 'log' && !partyId && !recipientText) return { error: 'Say who was paid.' };
  const amountPaise = body.amountPaise;
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) return { error: 'Enter the amount.' };
  if (amountPaise > MAX_AMOUNT_PAISE) return { error: 'That amount looks too large. Check it.' };
  const purpose = typeof body.purpose === 'string' ? body.purpose.trim().replace(/\s+/g, ' ') : '';
  if (purpose.length < 2) return { error: 'Say what it was for.' };
  if (purpose.length > PURPOSE_MAX) return { error: `Keep the purpose under ${PURPOSE_MAX} characters.` };
  if (!auditDetailIsSafe(purpose)) return { error: "Don't type an account number, UPI id or IFSC code in the purpose." };
  const mode = kind === 'log' ? 'upi' : body.mode;
  if (!MODES.includes(mode)) return { error: 'Choose how it will be paid.' };
  const value = { kind, partyId, recipientText: recipientText || null, amountPaise, mode, purpose };
  if (kind === 'request') {
    const neededBy = body.neededBy === undefined || body.neededBy === null || body.neededBy === '' ? null : body.neededBy;
    if (neededBy !== null && !realDate(neededBy)) return { error: 'Enter the date it is needed by as a real date.' };
    value.neededBy = neededBy;
    value.reimbursement = body.reimbursement === true;
    value.paidOn = null;
    value.paidVia = null;
    value.upiRef = null;
  } else {
    if (!realDate(body.paidOn)) return { error: 'Enter the date it was paid.' };
    if (body.paidOn > today) return { error: 'The payment date cannot be in the future.' };
    if (!PAID_VIA.includes(body.paidVia)) return { error: 'Say whether it was paid directly or by a delegate.' };
    const ref = cleanUpiRef(body.upiRef);
    if (ref === undefined) return { error: 'A UPI reference is 12 digits.' };
    value.paidOn = body.paidOn;
    value.paidVia = body.paidVia;
    value.upiRef = ref;
    value.neededBy = null;
    value.reimbursement = false;
  }
  return { value };
}

/**
 * Decide a request: approve, reject or cancel. `record` is { kind, status, requesterId }. Maker is not checker: whoever raised a
 * request cannot approve or reject it (they can cancel their own while it is still submitted or approved). A log is never decided.
 * -> { patch } (the fields to write) or { error }.
 */
export function decide({ record, action, actorId, reason, now }) {
  if (record.kind !== 'request') return { error: 'A spend already made needs no approval.' };
  if (action === 'cancel') {
    if (!['submitted', 'approved'].includes(record.status)) return { error: 'Only a request that has not been paid can be cancelled.' };
    return { patch: { status: 'cancelled', decided_by: actorId, decided_at: now, decision_reason: cleanReason(reason) } };
  }
  if (action !== 'approve' && action !== 'reject') return { error: 'Choose approve or reject.' };
  if (record.status !== 'submitted') return { error: 'This request has already been decided.' };
  if (!makerIsNotChecker(record.requesterId, actorId)) return { error: 'Someone else must approve a request you raised.' };
  if (action === 'approve') return { patch: { status: 'approved', decided_by: actorId, decided_at: now, decision_reason: cleanReason(reason) } };
  const why = cleanReason(reason);
  if (!why || why.length < 3) return { error: 'Say why it is rejected.' };
  return { patch: { status: 'rejected', decided_by: actorId, decided_at: now, decision_reason: why } };
}
function cleanReason(raw) {
  const s = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ').slice(0, 200) : '';
  return s && auditDetailIsSafe(s) ? s : null;
}

/** Why a record needs a person to look at it: a payment to the requester's own party (as a circle payment to them already does). */
export function reviewFlag({ partyId }, requesterPartyIds) {
  return partyId && requesterPartyIds.includes(partyId) ? 'own_party' : null;
}

const tokens = (s) => String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
function nameScore(name, text) {
  const have = new Set(tokens(text));
  const want = tokens(name);
  if (!want.length) return 0;
  return want.filter((t) => have.has(t)).length / want.length;
}

/** The date a record is anchored to for matching: when it was paid, else when it was approved, else when it was raised. */
function anchorOf(r) {
  return r.paidOn ?? r.decidedOn ?? r.createdOn ?? null;
}

/**
 * Exact matches by the 12-digit UPI reference. `records`: { id, status, amountPaise, upiRef }; `upiLines`: { id, upiRef, amountPaise,
 * direction, bankLineId }; `bankLines`: { id, upiRrn, amountPaise, direction }. A record with a reference is joined to the UPI row
 * and/or the bank debit that carry it, but only when the amount agrees: a reference that finds a different amount is reported in
 * `mismatches` and never linked. A reversal credit under the same reference is not the payment.
 * -> { links: Map<recordId, { upiLineId, bankLineId }>, mismatches: recordId[] }
 */
export function exactMatches(records, upiLines, bankLines) {
  const upiBy = new Map();
  for (const u of upiLines) if (u.direction === 'debit') upiBy.set(u.upiRef, u);
  const bankBy = new Map();
  for (const b of bankLines) if (b.upiRrn && b.direction === 'debit' && !bankBy.has(b.upiRrn)) bankBy.set(b.upiRrn, b);
  const links = new Map();
  const mismatches = [];
  for (const r of records) {
    if (!r.upiRef || r.status === 'rejected' || r.status === 'cancelled') continue;
    const u = upiBy.get(r.upiRef);
    const b = bankBy.get(r.upiRef);
    if (!u && !b) continue;
    if ((u && u.amountPaise !== r.amountPaise) || (b && b.amountPaise !== r.amountPaise)) {
      mismatches.push(r.id);
      continue;
    }
    links.set(r.id, { upiLineId: u?.id ?? null, bankLineId: b?.id ?? u?.bankLineId ?? null });
  }
  return { links, mismatches };
}

/**
 * Suggested matches for records that have no link yet; a person accepts one, nothing is linked on a guess. A UPI-mode record is
 * offered UPI rows, any record is offered bank debits. A target needs the same amount and to be a debit, and to fall in the
 * date window; one already linked to another record is not offered. A payee name that appears in the row or narration raises the
 * score. -> [{ recordId, type: 'upi'|'bank', targetId, score, reasons[] }] best first per record.
 * `records`: { id, mode, amountPaise, partyName, recipientText, paidOn, decidedOn, createdOn }.
 */
export function proposeMatches(records, upiLines, bankLines, { claimedUpi = new Set(), claimedBank = new Set() } = {}) {
  const out = [];
  for (const r of records) {
    const anchor = anchorOf(r);
    if (!anchor) continue;
    const who = r.partyName ?? r.recipientText ?? '';
    const found = [];
    if (r.mode === 'upi') {
      for (const u of upiLines) {
        if (u.direction !== 'debit' || claimedUpi.has(u.id) || u.amountPaise !== r.amountPaise) continue;
        const gap = Math.abs(daysBetween(anchor, u.paidAt));
        if (gap > PROPOSAL_DAYS_UPI) continue;
        const nm = nameScore(who, u.counterparty);
        found.push({ recordId: r.id, type: 'upi', targetId: u.id, score: 10 - gap + nm * 5, reasons: ['same amount', gap === 0 ? 'same day' : `${gap} day${gap === 1 ? '' : 's'} apart`, ...(nm > 0 ? ['payee name matches'] : [])] });
      }
    }
    for (const b of bankLines) {
      if (b.direction !== 'debit' || claimedBank.has(b.id) || b.amountPaise !== r.amountPaise) continue;
      const after = daysBetween(anchor, b.tranDate);
      const ok = r.mode === 'upi' ? Math.abs(after) <= PROPOSAL_DAYS_UPI : after >= 0 && after <= PROPOSAL_DAYS_BANK;
      if (!ok) continue;
      const nm = nameScore(who, b.narration);
      found.push({ recordId: r.id, type: 'bank', targetId: b.id, score: 8 - Math.abs(after) / 3 + nm * 5, reasons: ['same amount', after === 0 ? 'same day' : `${Math.abs(after)} day${Math.abs(after) === 1 ? '' : 's'} apart`, ...(nm > 0 ? ['payee name in the narration'] : [])] });
    }
    found.sort((x, y) => y.score - x.score);
    out.push(...found.slice(0, 5));
  }
  return out;
}

/**
 * The purposes the UPI page and the ledger pull in. `records`: { status, purpose, upiRef, upiLineId, bankLineId }. A rejected or
 * cancelled record explains nothing. -> a lookup that takes any of a payment's identifiers ({ upiRef, upiLineId, bankLineId }).
 */
export function purposeIndex(records) {
  const byRef = new Map();
  const byUpi = new Map();
  const byBank = new Map();
  for (const r of records) {
    if (r.status === 'rejected' || r.status === 'cancelled' || !r.purpose) continue;
    if (r.upiRef) byRef.set(r.upiRef, r.purpose);
    if (r.upiLineId) byUpi.set(r.upiLineId, r.purpose);
    if (r.bankLineId) byBank.set(r.bankLineId, r.purpose);
  }
  return ({ upiRef, upiLineId, bankLineId } = {}) => (upiRef && byRef.get(upiRef)) || (upiLineId && byUpi.get(upiLineId)) || (bankLineId && byBank.get(bankLineId)) || null;
}

/** Approved requests still unmatched after this many days appear on data health. */
export const UNMATCHED_AGE_DAYS = 14;
export function agingUnmatched(records, today) {
  return records.filter((r) => r.kind === 'request' && r.status === 'approved' && !r.bankLineId && !r.upiLineId && r.decidedOn && daysBetween(r.decidedOn, today) > UNMATCHED_AGE_DAYS);
}

/**
 * Accepting a suggested match (or matching by hand): what to write. The server re-checks against the statement row itself, never
 * against what the screen sent. `target`: { id, direction, amountPaise, date, bankLineId?, upiLineId? } (a UPI row carries the bank
 * line it is joined to; a bank line carries the UPI row joined to it). A request must be approved first; a match marks it paid.
 * -> { patch } or { error }.
 */
export function planMatch({ record, type, target, now, actorId }) {
  if (record.status === 'rejected' || record.status === 'cancelled') return { error: 'This record was rejected or cancelled.' };
  if (record.kind === 'request' && record.status !== 'approved' && record.status !== 'paid') return { error: 'Approve the request before matching a payment to it.' };
  if (type !== 'upi' && type !== 'bank') return { error: 'Choose a payment to match.' };
  if (!target || target.direction !== 'debit') return { error: 'Only a payment out can be matched.' };
  if (target.amountPaise !== record.amountPaise) return { error: 'The amount is different, so this is not the same payment.' };
  const patch = type === 'upi'
    ? { upi_line_id: target.id, bank_line_id: target.bankLineId ?? record.bankLineId ?? null }
    : { bank_line_id: target.id, upi_line_id: target.upiLineId ?? record.upiLineId ?? null };
  patch.matched_by = actorId;
  patch.matched_at = now;
  if (record.kind === 'request') {
    patch.status = 'paid';
    patch.paid_on = target.date;
  }
  return { patch };
}

/** What a file is, from its first bytes (the browser's label is not trusted). -> { mime, ext } or null. */
export function sniffVoucher(bytes) {
  const b = bytes;
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { mime: 'image/png', ext: 'png' };
  if (b.length > 12 && String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (b.length > 5 && String.fromCharCode(...b.slice(0, 5)) === '%PDF-') return { mime: 'application/pdf', ext: 'pdf' };
  return null;
}
export const VOUCHER_MAX_BYTES = 4 * 1024 * 1024; // a Netlify Function request is capped near 6 MB
