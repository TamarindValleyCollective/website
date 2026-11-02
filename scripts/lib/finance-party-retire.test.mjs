// Run with: node --test scripts/lib/finance-party-retire.test.mjs
// Money once went to an old account that never reached the payee and never came back. These tests pin the rules that
// stop it: an account is payable only when verified, started, and not retired; a retirement can move earlier but never
// later; a payee with two live bank accounts is flagged until someone resolves it. Invented values only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  todayIST,
  accountPayableOn,
  validateRetirement,
  planDetailsChange,
  reviewFlags,
  accountForResponse,
  partyForResponse,
} from './finance-parties.mjs';

const NOW = new Date('2026-06-15T05:00:00Z');
const acct = (over = {}) => ({ id: 'a1', party_id: 'p1', method: 'bank', status: 'verified', fingerprint: 'f1', last4: '0001', created_at: '2026-01-01T00:00:00Z', valid_from: null, retired_on: null, has_ifsc: true, ...over });

test('todayIST is the date in India, not UTC', () => {
  assert.equal(todayIST(new Date('2026-06-15T20:00:00Z')), '2026-06-16'); // 01:30 the next day in India
  assert.equal(todayIST(NOW), '2026-06-15');
});

test('an account is payable only when verified, started, and not retired', () => {
  assert.deepEqual(accountPayableOn(acct(), '2026-06-15'), { payable: true, reason: null });
  assert.equal(accountPayableOn(acct({ status: 'unverified' }), '2026-06-15').reason, 'not_verified');
  assert.equal(accountPayableOn(acct({ status: 'superseded' }), '2026-06-15').reason, 'superseded');
  assert.equal(accountPayableOn(acct({ valid_from: '2026-07-01' }), '2026-06-15').reason, 'not_yet_valid');
  assert.equal(accountPayableOn(acct({ valid_from: '2026-07-01' }), '2026-07-01').payable, true); // from the day itself
});

test('a retirement date is the first day the account must NOT be paid', () => {
  const a = acct({ retired_on: '2026-07-01' });
  assert.equal(accountPayableOn(a, '2026-06-30').payable, true);
  assert.deepEqual(accountPayableOn(a, '2026-07-01'), { payable: false, reason: 'retired' });
  assert.equal(accountPayableOn(a, '2027-01-01').payable, false);
});

test('retiring needs a real date and a reason, and works on live accounts only', () => {
  assert.deepEqual(validateRetirement({ on: '2026-07-01', reason: 'Bank merged; new account from July' }, acct(), NOW), { retiredOn: '2026-07-01', reason: 'Bank merged; new account from July' });
  assert.ok(validateRetirement({ on: '2026-02-30', reason: 'xxx' }, acct(), NOW).error); // not a real date
  assert.ok(validateRetirement({ on: 'soon', reason: 'xxx' }, acct(), NOW).error);
  assert.ok(validateRetirement({ on: '2026-07-01', reason: '' }, acct(), NOW).error);
  assert.ok(validateRetirement({ on: '2026-07-01', reason: 'x'.repeat(201) }, acct(), NOW).error);
  assert.ok(validateRetirement({ on: '2030-01-01', reason: 'too far ahead' }, acct(), NOW).error);
  assert.ok(validateRetirement({ on: '2026-07-01', reason: 'xxx' }, acct({ status: 'superseded' }), NOW).error);
});

test('a past date is allowed (the account stopped working before we found out)', () => {
  assert.equal(validateRetirement({ on: '2026-03-01', reason: 'merged in March' }, acct(), NOW).retiredOn, '2026-03-01');
});

test('a retirement can be moved earlier but never later or cleared', () => {
  const a = acct({ retired_on: '2026-07-01' });
  assert.equal(validateRetirement({ on: '2026-06-20', reason: 'earlier' }, a, NOW).retiredOn, '2026-06-20');
  assert.ok(validateRetirement({ on: '2026-08-01', reason: 'later' }, a, NOW).error);
  assert.ok(validateRetirement({ on: '2026-07-01', reason: 'same' }, a, NOW).error);
});

test('a change with an effective date retires the old account on that date and starts the new one then', () => {
  const plan = planDetailsChange([acct()], 'bank', 'f2', () => true, '2026-07-01');
  assert.deepEqual(plan, { action: 'replace', supersedeIds: [], retireIds: ['a1'], validFrom: '2026-07-01' });
});

test('with an effective date, an account already retiring earlier is left alone; other methods are untouched', () => {
  const rows = [acct({ id: 'a1', retired_on: '2026-06-20' }), acct({ id: 'a2', method: 'upi', fingerprint: 'u1' })];
  const plan = planDetailsChange(rows, 'bank', 'f2', () => true, '2026-07-01');
  assert.deepEqual(plan.retireIds, []);
});

test('without an effective date the old behaviour holds: the old row is superseded at once', () => {
  assert.deepEqual(planDetailsChange([acct()], 'bank', 'f2'), { action: 'replace', supersedeIds: ['a1'] });
});

const flagsFor = (rows, shared = new Map()) => reviewFlags(rows, shared, '2026-06-15');

test('two live bank accounts for one payee are both flagged, until someone resolves it', () => {
  const rows = [acct({ id: 'a1' }), acct({ id: 'a2', fingerprint: 'f2', created_at: '2026-03-01T00:00:00Z' })];
  assert.deepEqual(flagsFor(rows).get('a1'), ['multiple_live_accounts']);
  assert.deepEqual(flagsFor(rows).get('a2'), ['multiple_live_accounts']);
});

test('keeping both is a recorded decision that holds until a NEWER account appears', () => {
  const reviewed = { reviewed_at: '2026-04-01T00:00:00Z' };
  const rows = [acct({ id: 'a1', ...reviewed }), acct({ id: 'a2', fingerprint: 'f2', created_at: '2026-03-01T00:00:00Z', ...reviewed })];
  assert.equal(flagsFor(rows).has('a1'), false);
  const withNew = [...rows, acct({ id: 'a3', fingerprint: 'f3', created_at: '2026-05-01T00:00:00Z' })];
  assert.deepEqual(flagsFor(withNew).get('a3'), ['multiple_live_accounts']);
});

test('retiring one of two clears the flag once the date has passed, not before', () => {
  const rows = (retiredOn) => [acct({ id: 'a1', retired_on: retiredOn }), acct({ id: 'a2', fingerprint: 'f2' })];
  assert.ok(flagsFor(rows('2026-07-01')).get('a2').includes('multiple_live_accounts')); // still live today
  assert.equal(flagsFor(rows('2026-06-15')).has('a2'), false); // retired from today
});

test('superseded accounts are history and never flagged', () => {
  const rows = [acct({ id: 'a1', status: 'superseded' }), acct({ id: 'a2', fingerprint: 'f2' })];
  assert.equal(flagsFor(rows).size, 0);
});

test('missing IFSC, a shared account, and a retirement with no replacement are each flagged', () => {
  assert.deepEqual(flagsFor([acct({ has_ifsc: false })]).get('a1'), ['missing_ifsc']);
  assert.deepEqual(flagsFor([acct()], new Map([['a1', ['p9']]])).get('a1'), ['shared_account']);
  assert.deepEqual(flagsFor([acct({ retired_on: '2026-07-01' })]).get('a1'), ['no_replacement']);
});

test('a UPI id is never treated as a second bank account', () => {
  const rows = [acct({ id: 'a1' }), acct({ id: 'a2', method: 'upi', fingerprint: 'u1' })];
  assert.equal(flagsFor(rows).size, 0);
});

test('the response carries dates, payability and review reasons, still no number or ciphertext', () => {
  const out = accountForResponse(acct({ retired_on: '2026-07-01', details_enc: 'v1.SECRET' }), [], { today: '2026-06-15', review: ['no_replacement'] });
  assert.equal(out.retiredOn, '2026-07-01');
  assert.equal(out.payableNow, true);
  assert.deepEqual(out.review, ['no_replacement']);
  assert.ok(!JSON.stringify(out).includes('SECRET'));
  assert.equal(accountForResponse(acct({ status: 'unverified' }), [], { today: '2026-06-15' }).payableNow, false);
});

test('a party needs review when any of its accounts does, and retired accounts stay visible', () => {
  const rows = [acct({ id: 'a1', retired_on: '2026-06-01' }), acct({ id: 'a2', fingerprint: 'f2' }), acct({ id: 'a0', status: 'superseded' })];
  const out = partyForResponse({ id: 'p1', name: 'Test Traders', kind: 'vendor', active: true }, rows, new Map(), '2026-06-15');
  assert.equal(out.accounts.length, 2);
  assert.equal(out.earlierAccounts, 1);
  assert.equal(out.needsReview, false);
  const two = partyForResponse({ id: 'p1', name: 'Test Traders', kind: 'vendor', active: true }, [acct({ id: 'a1' }), acct({ id: 'a2', fingerprint: 'f2' })], new Map(), '2026-06-15');
  assert.equal(two.needsReview, true);
});
