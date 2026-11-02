// Run with: node --test scripts/lib/finance-party-dedupe.test.mjs
// Banks have merged, so one payee can appear with an old and a new account number; matching on account number alone
// cannot find them. Exact-after-normalising names merge automatically; looser matches become review candidates that a
// person decides. Invented names and numbers only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readBeneficiaries, normalizeName, planImport, findDuplicateCandidates, duplicateReviewCsv, summarizeImport } from './finance-party-import.mjs';

const fingerprint = (s) => `fp:${s}`;
const plan = (rows) => planImport(readBeneficiaries(rows).records, { households: new Map(), existing: [], fingerprint });
const HEAD = ['name', 'account', 'ifsc'];

test('names are compared ignoring case, punctuation, honorifics, "&", and company suffix spelling', () => {
  assert.equal(normalizeName('Ms. Divya  Tiwari'), normalizeName('DIVYA TIWARI'));
  assert.equal(normalizeName('Foo Traders Pvt. Ltd.'), normalizeName('foo traders private limited'));
  assert.equal(normalizeName('A & B Traders'), normalizeName('A and B Traders'));
  assert.equal(normalizeName('Shri Rama Stores'), normalizeName('Rama Stores'));
  assert.notEqual(normalizeName('Rama Stores'), normalizeName('Rama Traders'));
});

test('a company suffix is a real difference: the plain and the "Pvt Ltd" names stay two parties (a review candidate)', () => {
  const p = plan([HEAD, ['Test Traders', '100000000001', 'ABCD0123456'], ['TEST TRADERS PVT. LTD', '200000000002', 'WXYZ0123456']]);
  assert.equal(p.parties.length, 2);
  assert.equal(findDuplicateCandidates(p.parties)[0].reason, 'name_contained');
});

test('names that normalise equal merge, and a party with several bank accounts is noted for review', () => {
  const p = plan([HEAD, ['Ms. Test Traders', '100000000001', 'ABCD0123456'], ['TEST  TRADERS', '200000000002', 'WXYZ0123456']]);
  assert.equal(p.parties.length, 1);
  assert.equal(p.parties[0].accounts.length, 2);
  assert.deepEqual(p.anomalies.map((a) => a.kind), ['multiple_accounts']);
});

test('looser matches are candidates, never merged: reordered words, contained names, one-letter spelling slips', () => {
  const p = plan([
    HEAD,
    ['Pandian D', '100000000001', ''], ['D Pandian', '100000000002', ''],
    ['Rama Krishna Stores', '100000000003', ''], ['Rama Krishna', '100000000004', ''],
    ['Madevamma Putta', '100000000005', ''], ['Mahadevamma Putta', '100000000006', ''],
    ['Unrelated Shop', '100000000007', ''],
  ]);
  assert.equal(p.parties.length, 7);
  const found = findDuplicateCandidates(p.parties).map((c) => [p.parties[c.a].name, p.parties[c.b].name, c.reason]);
  assert.deepEqual(found, [
    ['Pandian D', 'D Pandian', 'same_words'],
    ['Rama Krishna Stores', 'Rama Krishna', 'name_contained'],
    ['Madevamma Putta', 'Mahadevamma Putta', 'close_spelling'],
  ]);
});

test('a single common word is not a candidate on its own', () => {
  const p = plan([HEAD, ['Putta', '100000000001', ''], ['Madevamma Putta Kumar', '100000000002', '']]);
  assert.deepEqual(findDuplicateCandidates(p.parties), []);
});

test('the summary counts candidates by reason and contains no names', () => {
  const p = plan([HEAD, ['Pandian D', '100000000001', ''], ['D Pandian', '100000000002', '']]);
  const text = JSON.stringify(summarizeImport(p));
  assert.match(text, /"duplicateCandidates":\{"same_words":1\}/);
  assert.ok(!text.includes('Pandian'));
});

test('the review file lists names, bank code and last four per account, never a full number', () => {
  const p = plan([HEAD, ['Pandian D', '100000000001', 'ABCD0123456'], ['D Pandian', '100000000002', 'ABCD0123999']]);
  const csv = duplicateReviewCsv(p.parties, findDuplicateCandidates(p.parties));
  assert.match(csv, /Pandian D/);
  assert.match(csv, /ABCD ending 0001/);
  assert.match(csv, /same_words/);
  assert.ok(!csv.includes('100000000001') && !csv.includes('ABCD0123456'));
});
