// Run with: node --test scripts/lib/finance-party-ifsc.test.mjs
// A wrong IFSC in the source list must not stop the account importing: the IFSC is dropped, the account is noted
// (invalid_ifsc), and it stays unverifiable until someone enters the right one. Invented values only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readBeneficiaries, planImport } from './finance-party-import.mjs';

const fingerprint = (s) => `fp:${s}`;
const plan = (rows) => planImport(readBeneficiaries(rows).records, { households: new Map(), existing: [], fingerprint });
const HEAD = ['name', 'account', 'ifsc'];

test('an account with a wrong IFSC imports without it, and is noted as invalid_ifsc', () => {
  const p = plan([HEAD, ['Test Traders', '100000000001', 'NOT-AN-IFSC']]);
  assert.equal(p.parties[0].accounts.length, 1);
  assert.equal(p.parties[0].accounts[0].details.ifsc, '');
  assert.deepEqual(p.anomalies.map((a) => [a.kind, a.line]).sort(), [['invalid_ifsc', 2], ['missing_ifsc', 2]]);
});

test('a wrong account number is still refused, even if the IFSC is also wrong', () => {
  const p = plan([HEAD, ['Test Traders', '12345', 'NOT-AN-IFSC']]);
  assert.equal(p.parties[0].accounts.length, 0);
  assert.deepEqual(p.anomalies.map((a) => a.kind), ['bad_details']);
});

test('a correct IFSC is kept and nothing is noted', () => {
  const p = plan([HEAD, ['Test Traders', '100000000001', 'ABCD0123456']]);
  assert.equal(p.parties[0].accounts[0].details.ifsc, 'ABCD0123456');
  assert.deepEqual(p.anomalies, []);
});
