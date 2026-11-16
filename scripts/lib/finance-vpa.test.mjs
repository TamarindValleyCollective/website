// Run with: node --test scripts/lib/finance-vpa.test.mjs
// Every UPI ID and name here is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { VPA_LOOKUP_LIMIT, isVpa, nameFromLookup, vpaIn, vpasToLookUp } from './finance-vpa.mjs';

test('finds the UPI ID inside the text a UPI app leaves, lowercased', () => {
  assert.equal(vpaIn('q000111222@ybl on PhonePe'), 'q000111222@ybl');
  assert.equal(vpaIn('Pay to Test.Vendor-1@OKAXIS now'), 'test.vendor-1@okaxis');
  assert.equal(vpaIn('9000000000@paytm'), '9000000000@paytm');
});

test('plain names, e-mail addresses and fragments are not UPI IDs', () => {
  assert.equal(vpaIn('Test Electricals'), null);
  assert.equal(vpaIn('someone@example.com'), null);
  assert.equal(vpaIn('a@ybl'), null, 'one letter before the @ is too short');
  assert.equal(vpaIn('@ybl'), null);
  assert.equal(vpaIn(''), null);
  assert.equal(vpaIn(null), null);
});

test('isVpa is true only when the whole string is the ID', () => {
  assert.equal(isVpa('q000111222@ybl'), true);
  assert.equal(isVpa(' Q000111222@YBL '), true);
  assert.equal(isVpa('q000111222@ybl on PhonePe'), false);
});

test('lookups skip known IDs, repeat none, keep first-seen order and stop at the limit', () => {
  const known = new Set(['known.one@ybl']);
  assert.deepEqual(vpasToLookUp(['a1.test@ybl on PhonePe', 'Plain Name', 'known.one@ybl', 'A1.TEST@ybl', 'b2.test@okaxis'], known), ['a1.test@ybl', 'b2.test@okaxis']);
  const many = Array.from({ length: VPA_LOOKUP_LIMIT + 10 }, (_, i) => `user${i + 10}@ybl`);
  assert.equal(vpasToLookUp(many, new Set()).length, VPA_LOOKUP_LIMIT);
  assert.equal(vpasToLookUp(many, new Set(), 3).length, 3);
});

test('a name is read only from a successful answer that carries one', () => {
  assert.equal(nameFromLookup({ vpa: 'x@ybl', success: true, customer_name: '  TEST   VENDOR ' }), 'TEST VENDOR');
  assert.equal(nameFromLookup({ vpa: 'x@ybl', success: true, customer_name: '' }), null, 'a real ID with no bank account name');
  assert.equal(nameFromLookup({ vpa: 'x@ybl', success: true }), null);
  assert.equal(nameFromLookup({ vpa: 'x@ybl', success: false, customer_name: 'Ignored' }), null);
  assert.equal(nameFromLookup(null), null);
});
