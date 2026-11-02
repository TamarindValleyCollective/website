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
export function planDetailsChange(existing, method, fingerprint, sameDetails = (/** @type {any} */ _row) => true) {
  const live = existing.filter((a) => a.status !== 'superseded');
  const same = live.find((a) => a.method === method && a.fingerprint === fingerprint && sameDetails(a));
  if (same) return { action: 'unchanged', accountId: same.id };
  return { action: 'replace', supersedeIds: live.filter((a) => a.method === method).map((a) => a.id) };
}

// Two different parties holding the same account are flagged on both (not blocked: a joint account or a shop with
// two owners can be intended). Returns Map(accountId -> [other partyIds]). Superseded rows are history.
export function sharedAccountFlags(accounts) {
  const byPrint = new Map();
  for (const a of accounts) {
    if (a.status === 'superseded' || !a.fingerprint) continue;
    byPrint.set(a.fingerprint, [...(byPrint.get(a.fingerprint) ?? []), a]);
  }
  const flags = new Map();
  for (const group of byPrint.values()) {
    for (const a of group) {
      const others = [...new Set(group.filter((b) => b.party_id !== a.party_id).map((b) => b.party_id))];
      if (others.length) flags.set(a.id, others);
    }
  }
  return flags;
}

// The only shape of an account that goes into a list response. Built field by field, so a new column on the row
// can never leak by accident.
export function accountForResponse(row, sharedWith = []) {
  return {
    id: row.id,
    method: row.method,
    shown: `ending ${row.last4}`,
    status: row.status,
    shared: sharedWith.length > 0,
    createdAt: row.created_at ?? null,
    verifiedAt: row.verified_at ?? null,
  };
}

export function partyForResponse(party, accounts, flags) {
  const live = accounts.filter((a) => a.status !== 'superseded');
  return {
    id: party.id,
    name: party.name,
    kind: party.kind,
    active: party.active,
    householdId: party.household_id ?? null,
    accounts: live.map((a) => accountForResponse(a, flags.get(a.id) ?? [])),
    earlierAccounts: accounts.length - live.length,
  };
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
