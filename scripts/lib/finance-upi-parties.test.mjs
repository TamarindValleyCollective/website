// Run with: node --test scripts/lib/finance-upi-parties.test.mjs
// The UPI table's Party column: matched by UPI ID first, the name only checking it. Every name and UPI ID is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addActionFor, partyStateFor } from './finance-upi-parties.mjs';

const VPA = 'q000111222@ybl';
const parties = [
  { id: 'P1', name: 'Test Vendor Works', kind: 'vendor' },
  { id: 'P2', name: 'Green Nursery', kind: 'vendor' },
];
// A fake keyed fingerprint: the real one is an HMAC, here the ID itself stands in.
const fingerprintOf = (v) => `fp:${v}`;
const ctx = (over = {}) => ({
  parties,
  byFingerprint: new Map(),
  fingerprintOf,
  answers: { names: {}, known: new Set() },
  ...over,
});
const named = (name, extra = {}) => ({ answers: { names: { [VPA]: name }, known: new Set([VPA]) }, ...extra });
const holding = (partyId, verifiedName = null) => new Map([[`fp:${VPA}`, { partyId, verifiedName }]]);
const row = (counterparty, direction = 'debit') => ({ counterparty, direction });

test('an ID a party holds, with a registered name that fits it, matches', () => {
  const s = partyStateFor(row(`${VPA} on PhonePe`), ctx({ byFingerprint: holding('P1'), ...named('TEST VENDOR WORKS') }));
  assert.deepEqual(s, { state: 'matches', partyId: 'P1', partyName: 'Test Vendor Works', registeredName: 'TEST VENDOR WORKS' });
});

test('an ID a party holds whose registered name does not fit is flagged to review, with both names', () => {
  const s = partyStateFor(row(VPA), ctx({ byFingerprint: holding('P1'), ...named('SOMEONE ELSE ENTIRELY') }));
  assert.deepEqual(s, { state: 'differs', partyId: 'P1', partyName: 'Test Vendor Works', registeredName: 'SOMEONE ELSE ENTIRELY' });
});

test('the name the bank showed when the account was verified also counts as fitting', () => {
  const s = partyStateFor(row(VPA), ctx({ byFingerprint: holding('P1', 'Proprietor Of Tvw'), ...named('PROPRIETOR OF TVW') }));
  assert.equal(s.state, 'matches', 'the label differs but the verified bank name is the registered name');
});

test('an ID a party holds that has not been looked up is on file, name unchecked', () => {
  const s = partyStateFor(row(VPA), ctx({ byFingerprint: holding('P2') }));
  assert.deepEqual(s, { state: 'onfile', partyId: 'P2', partyName: 'Green Nursery' });
});

test('no party holds the ID but the registered name matches one: the ID can be attached to that party', () => {
  const s = partyStateFor(row(VPA), ctx(named('Test Vendor Works')));
  assert.deepEqual(s, { state: 'attach', partyId: 'P1', partyName: 'Test Vendor Works', registeredName: 'Test Vendor Works' });
  assert.equal(addActionFor(s.state), 'attach');
});

test('nobody matches: the person can be added, as a vendor for money out and a customer for money in, in readable case', () => {
  const out = partyStateFor(row(VPA), ctx(named('NEW PERSON NAME')));
  assert.deepEqual(out, { state: 'missing', name: 'New Person Name', kind: 'vendor', registeredName: 'NEW PERSON NAME' });
  assert.equal(partyStateFor(row(VPA, 'credit'), ctx(named('NEW PERSON NAME'))).kind, 'customer');
  assert.equal(addActionFor(out.state), 'add');
});

test('a UPI ID not looked up yet, or looked up with no name, cannot be added yet', () => {
  assert.deepEqual(partyStateFor(row(VPA), ctx()), { state: 'lookup' });
  const none = partyStateFor(row(VPA), ctx({ answers: { names: {}, known: new Set([VPA]) } }));
  assert.deepEqual(none, { state: 'noname' });
  assert.equal(addActionFor('lookup'), null);
  assert.equal(addActionFor('noname'), null);
});

test('a plain name from the app is matched to the register by name, else offered as new', () => {
  assert.deepEqual(partyStateFor(row('GREEN NURSERY'), ctx()), { state: 'matches', partyId: 'P2', partyName: 'Green Nursery', by: 'name' });
  assert.deepEqual(partyStateFor(row('Brand New Farm Shop'), ctx()), { state: 'missing', name: 'Brand New Farm Shop', kind: 'vendor', by: 'name' });
});

test('a row with no name and no UPI ID is unnamed', () => {
  assert.deepEqual(partyStateFor(row(null), ctx()), { state: 'unnamed' });
  assert.deepEqual(partyStateFor(row('  '), ctx()), { state: 'unnamed' });
});

test('a party that no longer exists (merged away or retired) is not used', () => {
  const s = partyStateFor(row(VPA), ctx({ byFingerprint: holding('GONE'), ...named('NEW PERSON NAME') }));
  assert.equal(s.state, 'missing', 'the held account points at a party not in the live list, so nobody matches');
});

test('a UPI ID the keys cannot fingerprint falls back to the name', () => {
  const s = partyStateFor(row(VPA), ctx({ fingerprintOf: () => null, ...named('Test Vendor Works') }));
  assert.equal(s.state, 'attach');
});
