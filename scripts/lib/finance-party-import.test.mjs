// Run with: node --test scripts/lib/finance-party-import.test.mjs
// Invented parties and numbers only. The real beneficiary list is read from a file outside the repo by
// scripts/import-fin-parties.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readBeneficiaries, planImport, summarizeImport } from './finance-party-import.mjs';

const fingerprint = (s) => createHash('sha256').update(`test:${s}`).digest('hex');
const A1 = '100000000001';
const A2 = '100000000002';

// What getSheetValues returns: rows of cell text. `rows` turns a block of comma-separated test lines into that.
const parseCsv = (text) => text.split('\n').filter(Boolean).map((l) => l.split(','));

test('headers are matched by common names, in any order and case', () => {
  const { records, problems } = readBeneficiaries(
    parseCsv(`Beneficiary Name,IFSC Code,Account No,Type,Farm Unit\nTest Traders,abcd0123456,${A1},Vendor,\n`),
  );
  assert.deepEqual(problems, []);
  assert.deepEqual(records[0], { line: 2, name: 'Test Traders', kind: 'vendor', farmUnit: null, account: A1, padded: false, ifsc: 'abcd0123456', upi: '' });
});

test('a file without a name column is refused with a clear message', () => {
  const { records, problems } = readBeneficiaries(parseCsv('foo,bar\n1,2\n'));
  assert.equal(records.length, 0);
  assert.match(problems[0], /name/i);
});

const households = new Map([['F-01', 'h1']]);
const plan = (csv, existing = []) => planImport(readBeneficiaries(parseCsv(csv)).records, { households, existing, fingerprint });

test('a new vendor with bank details becomes a party with one unverified account', () => {
  const p = plan(`name,kind,account,ifsc\nTest Traders,vendor,${A1},ABCD0123456\n`);
  assert.equal(p.parties.length, 1);
  assert.equal(p.parties[0].accounts.length, 1);
  assert.equal(p.parties[0].accounts[0].last4, '0001');
  assert.equal(p.parties[0].accounts[0].fingerprint, fingerprint(A1));
});

test('rows for the same name and kind merge; the same account twice is kept once', () => {
  const p = plan(`name,kind,account,ifsc,upi\nTest Traders,vendor,${A1},ABCD0123456,\ntest  traders,Vendor,${A1},ABCD0123456,\nTest Traders,vendor,,,tt@okbank\n`);
  assert.equal(p.parties.length, 1);
  assert.equal(p.parties[0].accounts.length, 2);
});

test('a member row links to its household by farm unit; an unknown unit is reported, not guessed', () => {
  const p = plan(`name,kind,farm unit\nMember One,member,F-01\nMember Two,member,F-99\nMember Three,member,\n`);
  assert.equal(p.parties[0].householdId, 'h1');
  assert.equal(p.parties[1].householdId, null);
  const kinds = p.anomalies.map((a) => a.kind).sort();
  assert.deepEqual(kinds, ['member_without_unit', 'unknown_farm_unit']);
});

test('employees and other kind words map to the right kinds; an unknown word becomes other and is reported', () => {
  const p = plan(`name,kind\nA One,Staff\nB Two,Employee\nC Three,Supplier\nD Four,mystery\n`);
  assert.deepEqual(p.parties.map((x) => x.kind), ['employee', 'employee', 'vendor', 'other']);
  assert.deepEqual(p.anomalies.map((a) => a.kind), ['unknown_kind']);
});

test('bad details are reported by line and the party is still created without them', () => {
  const p = plan(`name,kind,account,ifsc\nTest Traders,vendor,12345,ABCD0123456\n`);
  assert.equal(p.parties[0].accounts.length, 0);
  assert.deepEqual(p.anomalies.map((a) => [a.kind, a.line]), [['bad_details', 2]]);
});

test('one account under two parties is reported as shared, by line; nothing is blocked', () => {
  const p = plan(`name,kind,account,ifsc\nTest Traders,vendor,${A1},ABCD0123456\nOther Shop,vendor,${A1},ABCD0123456\nThird Shop,vendor,${A2},ABCD0123456\n`);
  assert.equal(p.parties.length, 3);
  const shared = p.anomalies.filter((a) => a.kind === 'shared_account');
  assert.equal(shared.length, 1);
  assert.deepEqual(shared[0].lines, [2, 3]);
});

test('re-running adds nothing: existing parties and accounts are recognised', () => {
  const csv = `name,kind,account,ifsc\nTest Traders,vendor,${A1},ABCD0123456\n`;
  const existing = [{ id: 'p1', name: 'Test Traders', kind: 'vendor', fingerprints: [fingerprint(A1)] }];
  const p = plan(csv, existing);
  assert.equal(p.parties.length, 0);
  assert.equal(p.addToExisting.length, 0);
  assert.equal(p.unchanged, 1);
});

test('a known party with a new account gets it added, unverified', () => {
  const existing = [{ id: 'p1', name: 'Test Traders', kind: 'vendor', fingerprints: [fingerprint(A1)] }];
  const p = plan(`name,kind,account,ifsc\nTest Traders,vendor,${A2},ABCD0123456\n`, existing);
  assert.equal(p.addToExisting.length, 1);
  assert.equal(p.addToExisting[0].partyId, 'p1');
});

test('the summary has counts and line numbers only: no names, numbers or UPI ids', () => {
  const p = plan(`name,kind,account,ifsc,upi\nTest Traders,vendor,${A1},ABCD0123456,\nOther Shop,vendor,${A1},ABCD0123456,\nUpi Person,vendor,,,secret.person@okbank\n`);
  const text = JSON.stringify(summarizeImport(p));
  for (const secret of [A1, 'Test Traders', 'Other Shop', 'Upi Person', 'secret.person', 'ABCD0123456']) assert.ok(!text.includes(secret), `leaked ${secret}`);
  assert.match(text, /"newParties":3/);
});

test('a sheet with "Account Name" and "Account Number" and no IFSC still imports; each row is noted as missing its IFSC', () => {
  const rows = [['#', 'Account Name', 'Account Number', 'Bank Name', 'Branch Name', 'Mapping'], ['1', 'Test Traders', A1, 'Some Bank', 'Town', 'TT'], ['2', 'Other Shop', '12345', 'Some Bank', 'Town', 'OS']];
  const { records, problems } = readBeneficiaries(rows);
  assert.deepEqual(problems, []);
  const p = planImport(records, { households, existing: [], fingerprint });
  assert.equal(p.parties.length, 2);
  assert.equal(p.parties[0].accounts.length, 1);
  assert.equal(p.parties[0].accounts[0].details.ifsc, '');
  assert.deepEqual(p.anomalies.map((a) => [a.kind, a.line]), [['missing_ifsc', 2], ['bad_details', 3]]);
});
