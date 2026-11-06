// Run with: node --test scripts/lib/finance-parties.test.mjs
// Every value below is invented. No real name, account number, IFSC or UPI ID belongs in this file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  validateParty,
  validatePartyChange,
  validatePayeeDetails,
  planDetailsChange,
  sharedAccountFlags,
  accountForResponse,
  partyForResponse,
  canVerifyAccount,
  auditDetailIsSafe,
} from './finance-parties.mjs';

const ACCOUNT = '100000000001';
const OTHER_ACCOUNT = '100000000002';
const fp = (s) => createHash('sha256').update(`test:${s}`).digest('hex');

test('a party needs a name and a known kind', () => {
  assert.deepEqual(validateParty({ name: '  Test   Traders ', kind: 'vendor' }), { party: { name: 'Test Traders', kind: 'vendor' } });
  assert.ok(validateParty({ name: '', kind: 'vendor' }).error);
  assert.ok(validateParty({ name: 'X', kind: 'wizard' }).error);
  assert.ok(validateParty({ name: 'A'.repeat(200), kind: 'vendor' }).error);
});

test('bank details: account digits and IFSC are checked and squashed; last4 is what may be shown', () => {
  const ok = validatePayeeDetails({ method: 'bank', account: '1000 0000-0001', ifsc: 'abcd0123456' });
  assert.deepEqual(ok.details, { method: 'bank', account: ACCOUNT, ifsc: 'ABCD0123456' });
  assert.equal(ok.last4, '0001');
  assert.ok(validatePayeeDetails({ method: 'bank', account: '12345', ifsc: 'ABCD0123456' }).error);
  assert.ok(validatePayeeDetails({ method: 'bank', account: ACCOUNT, ifsc: 'nope' }).error);
});

test('UPI details: a VPA is checked and lower-cased', () => {
  const ok = validatePayeeDetails({ method: 'upi', upi: ' Test.Vendor@okbank ' });
  assert.deepEqual(ok.details, { method: 'upi', upi: 'test.vendor@okbank' });
  assert.equal(ok.last4, 'ndor');
  assert.ok(validatePayeeDetails({ method: 'upi', upi: 'no-at-sign' }).error);
  assert.ok(validatePayeeDetails({ method: 'cheque' }).error);
});

const row = (over) => ({ id: 'a1', party_id: 'p1', method: 'bank', status: 'verified', fingerprint: fp(ACCOUNT), ...over });

test('re-entering the same details changes nothing', () => {
  assert.deepEqual(planDetailsChange([row()], 'bank', fp(ACCOUNT)), { action: 'unchanged', accountId: 'a1' });
});

test('different details add a new unverified row and supersede the old one of the same method, keeping it', () => {
  const plan = planDetailsChange([row()], 'bank', fp(OTHER_ACCOUNT));
  assert.deepEqual(plan, { action: 'replace', supersedeIds: ['a1'] });
});

test('adding a UPI id does not supersede the bank account', () => {
  assert.deepEqual(planDetailsChange([row()], 'upi', fp('x@okbank')), { action: 'replace', supersedeIds: [] });
});

test('an already superseded row is not touched again, and does not count as unchanged', () => {
  const old = row({ status: 'superseded' });
  assert.deepEqual(planDetailsChange([old], 'bank', fp(ACCOUNT)), { action: 'replace', supersedeIds: [] });
});

test('two parties sharing one account are flagged on both; the same party twice is not; superseded rows are ignored', () => {
  const rows = [
    row({ id: 'a1', party_id: 'p1' }),
    row({ id: 'a2', party_id: 'p2', status: 'unverified' }),
    row({ id: 'a3', party_id: 'p3', fingerprint: fp(OTHER_ACCOUNT) }),
    row({ id: 'a4', party_id: 'p3', fingerprint: fp(OTHER_ACCOUNT), method: 'bank' }),
    row({ id: 'a5', party_id: 'p4', status: 'superseded' }),
  ];
  const flags = sharedAccountFlags(rows);
  assert.deepEqual(flags.get('a1'), ['p2']);
  assert.deepEqual(flags.get('a2'), ['p1']);
  assert.equal(flags.has('a3'), false);
  assert.equal(flags.has('a5'), false);
});

test('an account in a response carries only last four, status and the shared flag: no ciphertext, no fingerprint, no number', () => {
  const stored = row({ account_enc: 'v1.SECRETCIPHER', fingerprint: fp(ACCOUNT), last4: '0001', ifsc: 'ABCD0123456', created_by: 'u1' });
  const out = accountForResponse(stored, ['p2']);
  const text = JSON.stringify(out);
  assert.equal(out.shown, 'ending 0001');
  assert.equal(out.shared, true);
  assert.equal(out.status, 'verified');
  for (const secret of ['SECRETCIPHER', ACCOUNT, fp(ACCOUNT), 'account_enc', 'fingerprint']) assert.ok(!text.includes(secret), `leaked ${secret}`);
});

test('a party in a response lists its non-superseded accounts and the count of earlier ones', () => {
  const out = partyForResponse(
    { id: 'p1', name: 'Test Traders', kind: 'vendor', active: true, household_id: null },
    [row(), row({ id: 'a0', status: 'superseded' })],
    new Map(),
  );
  assert.equal(out.accounts.length, 1);
  assert.equal(out.earlierAccounts, 1);
});

test('the person who entered the details cannot verify them; only unverified details can be verified', () => {
  assert.equal(canVerifyAccount({ status: 'unverified', created_by: 'u1' }, 'u2').ok, true);
  assert.equal(canVerifyAccount({ status: 'unverified', created_by: 'u1' }, 'u1').ok, false);
  assert.equal(canVerifyAccount({ status: 'unverified', created_by: null }, 'u2').ok, true); // entered by the operator script
  assert.equal(canVerifyAccount({ status: 'verified', created_by: 'u1' }, 'u2').ok, false);
  assert.equal(canVerifyAccount({ status: 'superseded', created_by: 'u1' }, 'u2').ok, false);
});

test('audit detail is ids, counts and field names: account numbers, UPI ids and IFSC codes are refused', () => {
  assert.equal(auditDetailIsSafe({ partyId: 'b3f1c2d4-0000-4000-8000-000000000001', method: 'bank', changed: ['name'], count: 3 }), true);
  assert.equal(auditDetailIsSafe({ note: ACCOUNT }), false);
  assert.equal(auditDetailIsSafe({ note: 'pay test@okbank' }), false);
  assert.equal(auditDetailIsSafe({ nested: { ifsc: 'ABCD0123456' } }), false);
  assert.equal(auditDetailIsSafe({ account: 'x' }), false); // even the key says it is the number
  assert.equal(auditDetailIsSafe(null), true);
});

test('editing a party: only fields that really change are patched and named; a member linked to a household stays a member', () => {
  const party = { name: 'Test Traders', kind: 'vendor', active: true, household_id: null };
  assert.deepEqual(validatePartyChange(party, { name: 'Test  Traders' }), { patch: {}, changed: [] });
  assert.deepEqual(validatePartyChange(party, { name: 'Test Traders Ltd', active: false }), { patch: { name: 'Test Traders Ltd', active: false }, changed: ['name', 'active'] });
  assert.ok(validatePartyChange(party, { name: 'X' }).error);
  assert.ok(validatePartyChange(party, { kind: 'wizard' }).error);
  assert.ok(validatePartyChange(party, { active: 'yes' }).error);
  assert.ok(validatePartyChange({ ...party, kind: 'member', household_id: 'h1' }, { kind: 'vendor' }).error);
  assert.ok(validatePartyChange({ ...party, kind: 'member', household_id: null, person_id: 'p1' }, { kind: 'vendor' }).error);
});

test('the import may leave the IFSC out (the sheet has none); the directory form may not', () => {
  const body = { method: 'bank', account: ACCOUNT, ifsc: '' };
  assert.ok(validatePayeeDetails(body).error);
  const ok = validatePayeeDetails(body, { allowMissingIfsc: true });
  assert.deepEqual(ok.details, { method: 'bank', account: ACCOUNT, ifsc: '' });
  assert.ok(validatePayeeDetails({ ...body, ifsc: 'nope' }, { allowMissingIfsc: true }).error); // a wrong IFSC is still refused
});

test('same account number but a different IFSC is a change, not "unchanged"', () => {
  const plan = planDetailsChange([row()], 'bank', fp(ACCOUNT), () => false);
  assert.deepEqual(plan, { action: 'replace', supersedeIds: ['a1'] });
  assert.deepEqual(planDetailsChange([row()], 'bank', fp(ACCOUNT), () => true), { action: 'unchanged', accountId: 'a1' });
});
