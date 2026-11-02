// Run with: node --test scripts/lib/finance-party-merge.test.mjs
// The existing payee details are spread over several partial lists (a registered-accounts tab, an accounts tab, the
// funds-transfer requests, the bank's own export). These tests cover reading each layout's headers and merging the
// lists by account number. Invented values only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readBeneficiaries, mergeSources } from './finance-party-import.mjs';

const A1 = '100000000001';
const A2 = '100000000002';
const rows = (text) => text.split('\n').filter(Boolean).map((l) => l.split(','));

test('headers from the other lists are recognised: "Account #", "IFSC Code", "UPI ID", "Beneficiary ..." names', () => {
  const a = readBeneficiaries([['Entity', 'Account #', 'Name', 'Bank', 'IFSC Code', 'UPI ID'], ['x', A1, 'Test Traders', 'B', 'ABCD0123456', 'tt@okbank']]).records[0];
  assert.deepEqual([a.name, a.account, a.ifsc, a.upi], ['Test Traders', A1, 'ABCD0123456', 'tt@okbank']);
  const b = readBeneficiaries([['Beneficiary Account Name', 'Beneficiary Account Number', 'Beneficiary IFSC code'], ['Other Shop', A2, 'ABCD0123456']]).records[0];
  assert.deepEqual([b.name, b.account, b.ifsc], ['Other Shop', A2, 'ABCD0123456']);
});

test('the same account in several lists becomes one record: IFSC and UPI id come from whichever list has them', () => {
  const noIfsc = readBeneficiaries(rows(`name,account\nTest Traders,${A1}\nSolo Shop,${A2}\n`)).records;
  const withIfsc = readBeneficiaries(rows(`name,account,ifsc,upi\nTest Traders Pvt,${A1},ABCD0123456,tt@okbank\n`)).records;
  const { records, stats } = mergeSources([noIfsc, withIfsc]);
  assert.equal(records.length, 2);
  const merged = records.find((r) => r.account === A1);
  assert.equal(merged.name, 'Test Traders'); // the first list's name wins
  assert.equal(merged.ifsc, 'ABCD0123456');
  assert.equal(merged.upi, 'tt@okbank');
  assert.deepEqual(stats, { sources: 2, records: 3, merged: 1, nameDiffers: 1 });
});

test('an account number formatted differently (spaces, hyphens) still merges', () => {
  const a = readBeneficiaries(rows(`name,account\nTest Traders,1000 0000-0001\n`)).records;
  const b = readBeneficiaries(rows(`name,account,ifsc\nTest Traders,${A1},ABCD0123456\n`)).records;
  const { records, stats } = mergeSources([a, b]);
  assert.equal(records.length, 1);
  assert.equal(stats.nameDiffers, 0);
});

test('rows with no usable account number are never merged together', () => {
  const r = readBeneficiaries(rows(`name,upi\nAaa Bbb,a@okbank\nCcc Ddd,c@okbank\n`)).records;
  assert.equal(mergeSources([r]).records.length, 2);
});

test('two different names on one account in the SAME list stay separate, so the shared-account flag can still catch them', () => {
  const r = readBeneficiaries(rows(`name,account\nTest Traders,${A1}\nOther Shop,${A1}\n`)).records;
  assert.equal(mergeSources([r]).records.length, 2);
});
