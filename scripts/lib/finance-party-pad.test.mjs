// Run with: node --test scripts/lib/finance-party-pad.test.mjs
// Some older accounts are 8 digits. The import pads those with one leading zero to reach 9 (the directory form still
// requires 9 to 18 digits), notes each padded row, and pads BEFORE merging so the same account in two lists still
// matches. Invented values only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readBeneficiaries, mergeSources, planImport } from './finance-party-import.mjs';

const fingerprint = (s) => `fp:${s}`;
const HEAD = ['name', 'account', 'ifsc'];

test('an 8-digit account is padded to 9 digits when read, and marked', () => {
  const r = readBeneficiaries([HEAD, ['Test Traders', '12345678', 'ABCD0123456']]).records[0];
  assert.equal(r.account, '012345678');
  assert.equal(r.padded, true);
});

test('9 digits or more, and non-numeric values, are left exactly as they are', () => {
  const rows = readBeneficiaries([HEAD, ['A One', '123456789', ''], ['B Two', '1.2E+10', ''], ['C Three', '1234567', '']]).records;
  assert.deepEqual(rows.map((r) => r.account), ['123456789', '1.2E+10', '1234567']);
  assert.ok(rows.every((r) => !r.padded));
});

test('spaces and hyphens do not hide an 8-digit number', () => {
  assert.equal(readBeneficiaries([HEAD, ['Test Traders', '1234-5678', '']]).records[0].account, '012345678');
});

test('a padded account imports, and is noted as padded_account on its row', () => {
  const { records } = readBeneficiaries([HEAD, ['Test Traders', '12345678', 'ABCD0123456']]);
  const p = planImport(records, { households: new Map(), existing: [], fingerprint });
  assert.equal(p.parties[0].accounts[0].details.account, '012345678');
  assert.equal(p.parties[0].accounts[0].last4, '5678');
  assert.deepEqual(p.anomalies.map((a) => [a.kind, a.line]), [['padded_account', 2]]);
});

test('the same 8-digit account in two lists, one already padded, merges into one record', () => {
  const a = readBeneficiaries([HEAD, ['Test Traders', '12345678', '']]).records;
  const b = readBeneficiaries([HEAD, ['Test Traders', '012345678', 'ABCD0123456']]).records;
  const { records, stats } = mergeSources([a, b]);
  assert.equal(records.length, 1);
  assert.equal(stats.merged, 1);
  assert.equal(records[0].ifsc, 'ABCD0123456');
});
