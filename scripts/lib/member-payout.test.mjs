// Run with: node --test scripts/lib/member-payout.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePayout, validateVerification, payoutForMember, payoutForAdmin, needsPayout, payableProblem } from './member-payout.mjs';

const bank = { payeeName: 'Asha  Rao', method: 'bank', account: '1234 5678 9012', ifsc: 'hdfc0001234', pan: 'abcde1234f' };

test('a bank account: digits, IFSC and PAN are normalised and the last four kept', () => {
  const { payout } = validatePayout(bank);
  assert.deepEqual(payout.details, { account: '123456789012', ifsc: 'HDFC0001234' });
  assert.equal(payout.payeeName, 'Asha Rao');
  assert.equal(payout.pan, 'ABCDE1234F');
  assert.equal(payout.detailsLast4, '9012');
  assert.equal(payout.panLast4, '234F');
});

test('a UPI id is lower-cased and checked; the last four are of the part before @', () => {
  const { payout } = validatePayout({ payeeName: 'Asha Rao', method: 'upi', upi: ' Asha.Rao@OKBank ', pan: 'ABCDE1234F' });
  assert.deepEqual(payout.details, { upi: 'asha.rao@okbank' });
  assert.equal(payout.detailsLast4, '.rao');
});

test('bad input is refused with a plain message', () => {
  assert.match(validatePayout({ ...bank, account: '12345' }).error, /9 to 18 digits/);
  assert.match(validatePayout({ ...bank, ifsc: 'HDFC1234567' }).error, /IFSC/);
  assert.match(validatePayout({ ...bank, pan: 'ABCDE12345' }).error, /PAN/);
  assert.match(validatePayout({ ...bank, pan: '' }).error, /PAN/);
  assert.match(validatePayout({ ...bank, payeeName: '' }).error, /name as it appears/);
  assert.match(validatePayout({ ...bank, payeeName: '<b>x</b>' }).error, /name as it appears/);
  assert.match(validatePayout({ payeeName: 'Asha Rao', method: 'upi', upi: 'nobank', pan: 'ABCDE1234F' }).error, /UPI id/);
  assert.match(validatePayout({ ...bank, method: 'cash' }).error, /bank transfer or UPI/);
  assert.match(validatePayout(null).error, /name as it appears/);
});

test('verification says whether TDS is deducted, and at what rate if so', () => {
  assert.deepEqual(validateVerification({ tdsApplies: false }).verification, { tds_applies: false, tds_rate: null });
  assert.deepEqual(validateVerification({ tdsApplies: true, tdsRate: '10' }).verification, { tds_applies: true, tds_rate: 10 });
  assert.match(validateVerification({ tdsApplies: true }).error, /TDS rate/);
  assert.match(validateVerification({ tdsApplies: true, tdsRate: 0 }).error, /TDS rate/);
  assert.match(validateVerification({}).error, /whether TDS/);
});

test('nobody but a revealing super admin sees a full value', () => {
  const row = { household_id: 'h', payee_name: 'Asha Rao', method: 'bank', details_last4: '9012', pan_last4: '234F', details_enc: 'SECRET', pan_enc: 'SECRET', status: 'submitted', tds_applies: null, tds_rate: null, updated_at: 'x', verified_at: null };
  for (const seen of [payoutForMember(row), payoutForAdmin(row)]) {
    assert.ok(!JSON.stringify(seen).includes('SECRET'));
    assert.equal(seen.shown, 'ending 9012');
  }
  assert.equal(payoutForMember(null), null);
  assert.equal(payoutForAdmin(row).householdId, 'h');
});

test('a member is asked for details only when their contract pays them; a payout needs a verified account and a TDS decision', () => {
  assert.equal(needsPayout({ member_payout: 'bank_transfer', status: 'shared' }), true);
  assert.equal(needsPayout({ member_payout: 'maintenance_adjustment', status: 'active' }), false);
  assert.equal(needsPayout({ member_payout: 'bank_transfer', status: 'cancelled' }), false);
  assert.equal(needsPayout(null), false);
  assert.match(payableProblem(null), /not entered/);
  assert.match(payableProblem({ status: 'submitted' }), /not verified/);
  assert.match(payableProblem({ status: 'verified', tds_applies: null }), /TDS/);
  assert.equal(payableProblem({ status: 'verified', tds_applies: false }), null);
});
