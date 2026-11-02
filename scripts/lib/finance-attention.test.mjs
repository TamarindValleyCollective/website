// Run with: node --test scripts/lib/finance-attention.test.mjs
// Two pure pieces behind the Finance redesign: the evidence a verifier gives ("how did you check these details?"), and
// the "Needs you" summary on the Overview. Invented values only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { VERIFY_METHODS, validateVerification, verificationForResponse } from './finance-parties.mjs';
import { attentionOf } from './finance-attention.mjs';

// ---- how it was checked
test('a verification names how the details were checked, from a short fixed list', () => {
  assert.deepEqual(VERIFY_METHODS.map((m) => m.id), ['cancelled_cheque', 'test_transfer', 'invoice', 'other']);
  assert.deepEqual(validateVerification({ method: 'cancelled_cheque' }), { method: 'cancelled_cheque', note: null });
  assert.ok(validateVerification({}).error);
  assert.ok(validateVerification({ method: 'ask-the-vendor' }).error);
});

test('"Other" needs a note saying what was done; the other methods may have one', () => {
  assert.ok(validateVerification({ method: 'other' }).error);
  assert.ok(validateVerification({ method: 'other', note: 'ok' }).error); // too short to mean anything
  assert.deepEqual(validateVerification({ method: 'other', note: ' Called the vendor  back ' }), { method: 'other', note: 'Called the vendor back' });
  assert.deepEqual(validateVerification({ method: 'test_transfer', note: 'Rs 1, arrived' }), { method: 'test_transfer', note: 'Rs 1, arrived' });
});

test('the note is kept short and may not carry an account number, a UPI id or an IFSC', () => {
  assert.ok(validateVerification({ method: 'invoice', note: 'x'.repeat(201) }).error);
  assert.match(validateVerification({ method: 'invoice', note: 'acct 100000000001' }).error, /account/i);
  assert.ok(validateVerification({ method: 'invoice', note: 'pay test@okbank' }).error);
  assert.ok(validateVerification({ method: 'invoice', note: 'IFSC ABCD0123456' }).error);
});

test('what is shown of a verification: who, when, how, and the note; nothing for unverified details', () => {
  const row = { status: 'verified', verified_at: '2026-11-02T10:00:00Z', verified_by: 'u1', verification_method: 'cancelled_cheque', verification_note: 'photo in Drive' };
  assert.deepEqual(verificationForResponse(row, new Map([['u1', 'Test Director']])), { at: '2026-11-02T10:00:00Z', by: 'Test Director', method: 'cancelled_cheque', methodLabel: 'Cancelled cheque or bank letter', note: 'photo in Drive' });
  assert.equal(verificationForResponse({ status: 'unverified' }, new Map()), null);
});

test('a verification from before evidence was recorded shows who and when, and says the method was not recorded', () => {
  const legacy = { status: 'verified', verified_at: '2026-11-02T10:00:00Z', verified_by: 'u1', verification_method: null, verification_note: null };
  const v = verificationForResponse(legacy, new Map([['u1', 'Test Director']]));
  assert.equal(v.method, null);
  assert.equal(v.methodLabel, 'Method not recorded');
});

// ---- the Overview's "Needs you"
const party = (id, over = {}) => ({ id, name: `P${id}`, kind: 'vendor', active: true, household_id: null, merged_into: null, ...over });
const acct = (id, partyId, over = {}) => ({ id, party_id: partyId, method: 'bank', status: 'unverified', fingerprint: `f${id}`, last4: '0001', created_at: '2026-01-01T00:00:00Z', retired_on: null, valid_from: null, has_ifsc: true, ...over });
const base = { parties: [], accounts: [], coverage: [], reconciliation: null, batches: [], bankAccountCount: 0, today: '2026-06-15' };

test('payees to verify are PARTIES with an unverified live account, counted once however many accounts', () => {
  const a = attentionOf({
    ...base,
    parties: [party('1'), party('2'), party('3')],
    accounts: [acct('a', '1'), acct('b', '1', { fingerprint: 'fb', method: 'upi' }), acct('c', '2'), acct('d', '3', { status: 'verified' })],
  });
  assert.equal(a.toVerify, 2);
  assert.equal(a.parties, 3);
});

test('superseded and retired accounts do not count as needing verification', () => {
  const a = attentionOf({ ...base, parties: [party('1'), party('2')], accounts: [acct('a', '1', { status: 'superseded' }), acct('b', '2', { retired_on: '2026-06-01' })] });
  assert.equal(a.toVerify, 0);
});

test('a party merged into another is not counted twice; its accounts count under the main party', () => {
  const a = attentionOf({ ...base, parties: [party('1'), party('2', { merged_into: '1' })], accounts: [acct('a', '1', { status: 'verified' }), acct('b', '2')] });
  assert.equal(a.parties, 1);
  assert.equal(a.merged, 1);
  assert.equal(a.toVerify, 1);
});

test('payees needing review: two live bank accounts, a missing IFSC, or a shared account', () => {
  const a = attentionOf({
    ...base,
    parties: [party('1'), party('2'), party('3'), party('4')],
    accounts: [acct('a', '1'), acct('b', '1', { fingerprint: 'fb' }), acct('c', '2', { has_ifsc: false }), acct('d', '3', { fingerprint: 'same' }), acct('e', '4', { fingerprint: 'same' })],
  });
  assert.equal(a.needsReview, 4);
});

test('statement gaps are listed by account, and Paytm waiting and to-check come from the reconciliation', () => {
  const a = attentionOf({
    ...base,
    coverage: [
      { label: 'Operating account', intervals: [{ from: '2022-04-01', to: '2026-10-31' }], gaps: [] },
      { label: 'Savings account', intervals: [{ from: '2024-04-01', to: '2025-03-31' }], gaps: [{ from: '2025-04-01', to: '2026-10-31' }] },
    ],
    reconciliation: { awaitingBank: { count: 3, totalPaise: 1250000 }, unmatchedInStatement: { count: 1, totalPaise: 50000 }, bankWithoutUpi: { predatesExport: 120, inExportPeriod: 4 } },
  });
  assert.deepEqual(a.statementGaps, [{ label: 'Savings account', from: '2025-04-01', to: '2026-10-31' }]);
  assert.deepEqual(a.paytmWaiting, { count: 3, totalPaise: 1250000 });
  assert.deepEqual(a.paytmToCheck, { count: 1, totalPaise: 50000 });
});

test('the last import is the newest batch; nothing imported leaves it null', () => {
  assert.equal(attentionOf(base).lastImportAt, null);
  const a = attentionOf({ ...base, batches: [{ created_at: '2026-11-01T00:00:00Z' }, { created_at: '2026-11-02T11:00:00Z' }] });
  assert.equal(a.lastImportAt, '2026-11-02T11:00:00Z');
});

test('with nothing at all, everything is zero and nothing needs anyone', () => {
  const a = attentionOf(base);
  assert.deepEqual([a.parties, a.toVerify, a.needsReview, a.statementGaps.length, a.paytmWaiting.count, a.paytmToCheck.count], [0, 0, 0, 0, 0, 0]);
});

test('the summary holds counts and labels only: no account numbers, fingerprints or party names', () => {
  const a = attentionOf({ ...base, parties: [party('1', { name: 'Secret Vendor' })], accounts: [acct('a', '1')] });
  const text = JSON.stringify(a);
  assert.ok(!text.includes('Secret Vendor') && !text.includes('fa'));
});
