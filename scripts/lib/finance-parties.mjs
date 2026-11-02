// Pure rules for finance parties and payee accounts (docs/finance/sessions/04-parties-and-payees.md). No I/O, so they
// are tested directly (finance-parties.test.mjs); finance-admin.mts does the encrypting, reading and writing.
//
// A party is anyone TVC pays or receives from. A payee account is bank or UPI details for a party. Details are never
// overwritten: a change adds a new `unverified` row and marks the old one of the same method `superseded`. Full
// numbers never leave the server except to a `verify-payee` holder behind the MFA step-up; everything else here
// returns "ending 0123" only.
import { makerIsNotChecker } from './finance-access.mjs';

export const PARTY_KINDS = ['member', 'vendor', 'employee', 'customer', 'bank', 'government', 'director', 'other'];

const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const UPI = /^[a-z0-9._-]{2,256}@[a-z][a-z0-9]{1,63}$/i;
const ACCOUNT = /^[0-9]{9,18}$/;

const squash = (v) => (typeof v === 'string' ? v.replace(/[\s-]/g, '') : '');

export function validateParty(body) {
  const name = typeof body?.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
  if (name.length < 2 || name.length > 120) return { error: 'Enter a name of 2 to 120 characters.' };
  if (!PARTY_KINDS.includes(body?.kind)) return { error: 'Choose what kind of party this is.' };
  return { party: { name, kind: body.kind } };
}

// An edit to a party's name, kind or active flag. Returns only what really changes, so the audit log can name the
// fields. A member linked to a household stays a member (the table's check would refuse it anyway).
export function validatePartyChange(party, body) {
  const patch = {};
  if (body?.name !== undefined) {
    const checked = validateParty({ name: body.name, kind: party.kind });
    if (checked.error) return { error: checked.error };
    if (checked.party.name !== party.name) patch.name = checked.party.name;
  }
  if (body?.kind !== undefined && body.kind !== party.kind) {
    if (!PARTY_KINDS.includes(body.kind)) return { error: 'Choose what kind of party this is.' };
    if (party.household_id) return { error: 'A member linked to a household stays a member.' };
    patch.kind = body.kind;
  }
  if (body?.active !== undefined) {
    if (typeof body.active !== 'boolean') return { error: 'Active must be true or false.' };
    if (body.active !== party.active) patch.active = body.active;
  }
  return { patch, changed: Object.keys(patch) };
}

// What a person enters for a payee. Returns what is to be stored (the caller encrypts `details`) and the last four
// characters, the only part ever shown without the step-up.
// `allowMissingIfsc` is for the operator import only: the existing list has no IFSC column. Such details cannot be
// verified until a person adds the IFSC (verification refuses them), and a wrong IFSC is still refused.
export function validatePayeeDetails(body, { allowMissingIfsc = false } = {}) {
  if (body?.method === 'bank') {
    const account = squash(body.account);
    const ifsc = squash(body.ifsc).toUpperCase();
    if (!ACCOUNT.test(account)) return { error: 'The account number should be 9 to 18 digits.' };
    if (!(allowMissingIfsc && ifsc === '') && !IFSC.test(ifsc)) return { error: 'The IFSC code should look like ABCD0123456.' };
    return { details: { method: 'bank', account, ifsc }, last4: account.slice(-4) };
  }
  if (body?.method === 'upi') {
    const upi = typeof body.upi === 'string' ? body.upi.trim().toLowerCase() : '';
    if (!UPI.test(upi)) return { error: 'The UPI id should look like name@bank.' };
    // The end of the handle before the @, as the member payout does: the bank's name after it says nothing.
    return { details: { method: 'upi', upi }, last4: upi.split('@')[0].padStart(4, '*').slice(-4) };
  }
  return { error: 'Choose bank transfer or UPI.' };
}

// `existing` are this party's account rows. Same details again: nothing to do. Otherwise a new unverified row is
// added and the party's live rows of the same method are superseded (kept, never edited), so a changed account
// cannot be paid until someone verifies it.
// The fingerprint covers the account number or UPI id only, so `sameDetails(row)` decides whether a row with that
// fingerprint is truly identical (the IFSC too); without it a corrected IFSC would be dropped as "unchanged".
export function planDetailsChange(existing, method, fingerprint, sameDetails = (/** @type {any} */ _row) => true, effectiveOn = /** @type {string | null} */ (null)) {
  const live = existing.filter((a) => a.status !== 'superseded');
  const same = live.find((a) => a.method === method && a.fingerprint === fingerprint && sameDetails(a));
  if (same) return { action: 'unchanged', accountId: same.id };
  const ofMethod = live.filter((a) => a.method === method);
  // With an effective date the old account stays payable until that day and the new one starts on it (a bank merger on
  // a known date). A retirement already set for an earlier day is left alone; a later one is pulled forward.
  if (effectiveOn) {
    return { action: 'replace', supersedeIds: [], retireIds: ofMethod.filter((a) => !a.retired_on || a.retired_on > effectiveOn).map((a) => a.id), validFrom: effectiveOn };
  }
  return { action: 'replace', supersedeIds: ofMethod.map((a) => a.id) };
}

// Two different parties holding the same account are flagged on both (not blocked: a joint account or a shop with
// two owners can be intended). Returns Map(accountId -> [other partyIds]). Superseded rows are history.
export function sharedAccountFlags(accounts, canonicalOf = new Map()) {
  const canon = (/** @type {string} */ id) => canonicalOf.get(id) ?? id;
  const byPrint = new Map();
  for (const a of accounts) {
    if (a.status === 'superseded' || !a.fingerprint) continue;
    byPrint.set(a.fingerprint, [...(byPrint.get(a.fingerprint) ?? []), a]);
  }
  const flags = new Map();
  for (const group of byPrint.values()) {
    for (const a of group) {
      const others = [...new Set(group.filter((b) => canon(b.party_id) !== canon(a.party_id)).map((b) => canon(b.party_id)))];
      if (others.length) flags.set(a.id, others);
    }
  }
  return flags;
}

const IST_OFFSET_MS = 5.5 * 3_600_000;
// Today's date in India (YYYY-MM-DD). Dates on accounts are calendar days, compared as text.
export function todayIST(now = new Date()) {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

// THE rule for whether money may go to an account on a day. Every payment path (requests, payroll, bulk files) must use
// it: an account is payable only when verified, started, and not retired. A retirement date is the first day the account
// must NOT be paid. (An old account once received money that never reached the payee and never came back.)
export function accountPayableOn(account, onDate) {
  if (account.status === 'superseded') return { payable: false, reason: 'superseded' };
  if (account.status !== 'verified') return { payable: false, reason: 'not_verified' };
  if (account.valid_from && onDate < account.valid_from) return { payable: false, reason: 'not_yet_valid' };
  if (account.retired_on && onDate >= account.retired_on) return { payable: false, reason: 'retired' };
  return { payable: true, reason: null };
}

// The date a changed account takes effect: a real calendar day, within about 13 months either side of today (a bank
// merger can be announced ahead of time, or discovered after the fact).
export function validateEffectiveOn(on, now = new Date()) {
  const m = typeof on === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(on) : null;
  const probe = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
  if (!probe || probe.getUTCFullYear() !== +m[1] || probe.getUTCMonth() !== +m[2] - 1 || probe.getUTCDate() !== +m[3]) return { error: 'Enter the date as a real date.' };
  if (Math.abs(probe.getTime() - Date.parse(`${todayIST(now)}T00:00:00Z`)) > 400 * 86_400_000) return { error: 'Choose a date within 13 months of today.' };
  return { effectiveOn: on };
}

// Retiring an account from a date, with a reason. A past date is allowed (it stopped working before we found out); a
// retirement can be moved earlier but never later or cleared, so a retired account cannot quietly come back.
export function validateRetirement(body, account, now = new Date()) {
  const on = typeof body?.on === 'string' ? body.on : '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(on);
  const probe = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
  if (!probe || probe.getUTCFullYear() !== +m[1] || probe.getUTCMonth() !== +m[2] - 1 || probe.getUTCDate() !== +m[3]) return { error: 'Enter the date as a real date.' };
  const reason = typeof body?.reason === 'string' ? body.reason.trim().replace(/\s+/g, ' ') : '';
  if (reason.length < 3 || reason.length > 200) return { error: 'Give a short reason (3 to 200 characters).' };
  if (account.status === 'superseded') return { error: 'These details were already replaced.' };
  if (probe.getTime() - Date.parse(`${todayIST(now)}T00:00:00Z`) > 400 * 86_400_000) return { error: 'Choose a date within the next 13 months.' };
  if (account.retired_on && on >= account.retired_on) return { error: 'A retirement can only be moved earlier, never later.' };
  return { retiredOn: on, reason };
}

// Why an account needs a person to look at it. `accounts` are ONE party's rows; `shared` is sharedAccountFlags().
//  multiple_live_accounts  the payee has two or more bank accounts in use (a bank merger looks like this): retire the old
//                          one, or record that keeping both is intended (that holds until a newer account is added)
//  missing_ifsc            bank details without an IFSC cannot be verified
//  shared_account          another party holds the same account
//  no_replacement          a retirement is set but no other account of that kind is left to pay
export function reviewFlags(accounts, shared, today) {
  const flags = new Map();
  const add = (id, reason) => flags.set(id, [...(flags.get(id) ?? []), reason]);
  const history = accounts.filter((a) => a.status !== 'superseded');
  const isLive = (a) => !(a.retired_on && a.retired_on <= today);
  const liveBank = history.filter((a) => isLive(a) && a.method === 'bank');
  if (liveBank.length >= 2) {
    const newest = liveBank.map((a) => a.created_at).sort().at(-1);
    const reviewed = liveBank.map((a) => a.reviewed_at).filter(Boolean).sort().at(-1);
    if (!(reviewed && reviewed >= newest)) for (const a of liveBank) add(a.id, 'multiple_live_accounts');
  }
  for (const a of history) {
    if (isLive(a) && a.method === 'bank' && a.has_ifsc === false) add(a.id, 'missing_ifsc');
    if (isLive(a) && (shared.get(a.id) ?? []).length) add(a.id, 'shared_account');
    if (a.retired_on && !history.some((b) => b.id !== a.id && b.method === a.method && !b.retired_on)) add(a.id, 'no_replacement');
  }
  return flags;
}

// The only shape of an account that goes into a list response. Built field by field, so a new column on the row
// can never leak by accident.
export function accountForResponse(row, sharedWith = [], extra = {}) {
  const today = extra.today ?? todayIST();
  return {
    id: row.id,
    method: row.method,
    shown: `ending ${row.last4}`,
    status: row.status,
    shared: sharedWith.length > 0,
    validFrom: row.valid_from ?? null,
    retiredOn: row.retired_on ?? null,
    payableNow: accountPayableOn(row, today).payable,
    review: extra.review ?? [],
    createdAt: row.created_at ?? null,
    verifiedAt: row.verified_at ?? null,
    verification: verificationForResponse(row, extra.names ?? new Map()),
  };
}

export function partyForResponse(party, accounts, flags, today = todayIST(), mergedCount = 0, names = new Map()) {
  const live = accounts.filter((a) => a.status !== 'superseded');
  const review = reviewFlags(accounts, flags, today);
  return {
    id: party.id,
    name: party.name,
    kind: party.kind,
    active: party.active,
    householdId: party.household_id ?? null,
    accounts: live.map((a) => accountForResponse(a, flags.get(a.id) ?? [], { today, review: review.get(a.id) ?? [], names })),
    earlierAccounts: accounts.length - live.length,
    needsReview: [...review.values()].some((r) => r.length > 0),
    mergedCount,
  };
}

// Two parties that are really one payee. Account rows are immutable and keep the party they were entered under, so a
// merge marks the duplicate as `merged_into` the main party instead of moving anything: the main party then shows (and is
// reviewed over) both sets of accounts, and nothing is deleted. No chains, and a member linked to a household stays put.
export function validateMerge(source, target, { sourceHasMergedIn = false } = {}) {
  if (source.id === target.id) return { error: 'Choose a different party to merge into.' };
  if (source.merged_into) return { error: 'This party is already merged.' };
  if (target.merged_into) return { error: 'That party was itself merged into another; choose the main one.' };
  if (sourceHasMergedIn) return { error: 'Other parties were merged into this one. Merge it the other way round, or undo those first.' };
  if (source.household_id) return { error: 'A member linked to a household cannot be merged into another party.' };
  return { ok: true };
}

// Hides merged parties and gives each main party the accounts of itself and of the parties merged into it.
export function foldMerged(parties, accounts) {
  const canonicalOf = new Map(parties.filter((p) => p.merged_into).map((p) => [p.id, p.merged_into]));
  const byParty = new Map();
  for (const a of accounts) {
    const id = canonicalOf.get(a.party_id) ?? a.party_id;
    byParty.set(id, [...(byParty.get(id) ?? []), a]);
  }
  const merged = new Map();
  for (const target of canonicalOf.values()) merged.set(target, (merged.get(target) ?? 0) + 1);
  return {
    visible: parties.filter((p) => !p.merged_into),
    accountsOf: (/** @type {string} */ id) => byParty.get(id) ?? [],
    mergedCount: (/** @type {string} */ id) => merged.get(id) ?? 0,
    canonicalOf,
  };
}

// How a verifier checked the details. Recorded with who and when, so an auditor can see what "verified" rests on. The
// note is free text, so it may not carry the very thing this module keeps out of logs: no account number, UPI id or IFSC.
export const VERIFY_METHODS = [
  { id: 'cancelled_cheque', label: 'Cancelled cheque or bank letter' },
  { id: 'test_transfer', label: 'Small test transfer that arrived' },
  { id: 'invoice', label: 'Invoice or bill from the payee' },
  { id: 'other', label: 'Other, with a note' },
];

export function validateVerification(body) {
  const method = VERIFY_METHODS.find((m) => m.id === body?.method);
  if (!method) return { error: 'Say how you checked these details.' };
  const note = typeof body?.note === 'string' ? body.note.trim().replace(/\s+/g, ' ') : '';
  if (note.length > 200) return { error: 'Keep the note under 200 characters.' };
  if (note && !auditDetailIsSafe(note)) return { error: "Don't type an account number, UPI id or IFSC code in the note." };
  if (method.id === 'other' && note.length < 3) return { error: 'Say what you did to check them.' };
  return { method: method.id, note: note || null };
}

// What is shown of a verification: who, when, how, and the note. `names` maps staff ids to names.
export function verificationForResponse(row, names) {
  if (row.status !== 'verified') return null;
  const m = VERIFY_METHODS.find((x) => x.id === row.verification_method);
  return { at: row.verified_at ?? null, by: names.get(row.verified_by) ?? null, method: m?.id ?? null, methodLabel: m?.label ?? 'Method not recorded', note: row.verification_note ?? null };
}

// Verification rules the server enforces: only unverified details, and not by whoever entered them. A row entered by
// the operator script has no creator (null), which anyone with verify-payee may confirm.
export function canVerifyAccount(account, verifierId) {
  if (account.status !== 'unverified') return { ok: false, error: 'Only unverified details can be verified.' };
  if (account.created_by && !makerIsNotChecker(account.created_by, verifierId)) {
    return { ok: false, error: 'Someone else must verify details you entered.' };
  }
  return { ok: true };
}

// fin_audit_log.detail is ids, counts and field names. This refuses anything shaped like what must not be there:
// a long run of digits (account number), a UPI id, an IFSC, or a key that names such a field. Ids (uuids) are fine.
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const BAD_KEY = /^(account|account_?number|upi|vpa|ifsc|details)$/i;
export function auditDetailIsSafe(detail) {
  if (detail === null || detail === undefined) return true;
  if (typeof detail === 'string') {
    const text = detail.replace(UUID, '');
    return !(/\d{9,}/.test(text.replace(/[\s-]/g, '')) || /[^\s@]+@[a-z]/i.test(text) || /\b[A-Z]{4}0[A-Z0-9]{6}\b/.test(text));
  }
  if (Array.isArray(detail)) return detail.every(auditDetailIsSafe);
  if (typeof detail === 'object') return Object.entries(detail).every(([k, v]) => !BAD_KEY.test(k) && auditDetailIsSafe(v));
  return true;
}
