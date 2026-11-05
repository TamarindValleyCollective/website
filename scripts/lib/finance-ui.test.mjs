// Run with: node --test scripts/lib/finance-ui.test.mjs
// The money-entry helper on the ledger screens: rupees typed by a person become whole paise, never through a float.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRupees, rupees } from './finance-ui.mjs';

test('rupees typed with or without paise become whole paise', () => {
  assert.equal(parseRupees('1500'), 150000);
  assert.equal(parseRupees('1,500.5'), 150050);
  assert.equal(parseRupees('₹ 99.99'), 9999);
  assert.equal(parseRupees('0.07'), 7);
  assert.equal(parseRupees('1234567.10'), 123456710);
});

test('things that are not an amount of money are refused', () => {
  for (const bad of ['', '  ', 'abc', '0', '0.00', '-5', '1.234', '1e3', '12.', '.5', '1,2,,3x', null, undefined]) assert.equal(parseRupees(bad), null, String(bad));
});

test('amounts that float arithmetic would get wrong stay exact', () => {
  assert.equal(parseRupees('0.29'), 29); // 0.29 * 100 = 28.999999999999996 as a float
  assert.equal(parseRupees('1.15'), 115);
  assert.equal(parseRupees('4.35'), 435);
});

test('paise show as rupees with two decimals', () => {
  assert.match(rupees(150050), /1,500\.50/);
});
