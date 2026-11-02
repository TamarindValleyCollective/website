// Run with: node --test scripts/lib/finance-diff.test.mjs
// Comparing the accounts of one payee (a bank merger leaves an old and a new number): which characters differ?
// Values are compared from the RIGHT, since account numbers of different lengths line up at the end. Invented values only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { markDiff, groupFromRight } from './finance-diff.mjs';

const flags = (marked) => marked.map((chars) => chars.map((c) => (c.differs ? 'x' : '.')).join(''));

test('two values: every position that differs is marked, on both', () => {
  const m = markDiff(['0808', '8008']);
  assert.deepEqual(flags(m), ['xx..', 'xx..']);
  assert.equal(m[0].map((c) => c.ch).join(''), '0808'); // the characters themselves are kept
});

test('identical values mark nothing', () => {
  assert.deepEqual(flags(markDiff(['1234', '1234'])), ['....', '....']);
});

test('a single value has nothing to compare against', () => {
  assert.deepEqual(flags(markDiff(['1234'])), ['....']);
});

test('different lengths line up at the right: the extra leading digit counts as a difference', () => {
  assert.deepEqual(flags(markDiff(['1234567890', '234567890'])), ['x.........', '.........']);
  // a shifted copy is NOT "the same digits": 1234 vs 4123 differ at every position
  assert.deepEqual(flags(markDiff(['1234', '4123'])), ['xxxx', 'xxxx']);
});

test('three values: a position is marked when they are not all the same there', () => {
  assert.deepEqual(flags(markDiff(['1111', '1121', '1111'])), ['..x.', '..x.', '..x.']);
});

test('letters compare exactly (an IFSC that differs in one character)', () => {
  assert.deepEqual(flags(markDiff(['ABCD0123456', 'ABCD0123459'])), ['..........x', '..........x']);
});

test('digits are shown in groups of four counted from the right, without changing the characters', () => {
  assert.deepEqual(groupFromRight('1607155000056580'), ['1607', '1550', '0005', '6580']);
  assert.deepEqual(groupFromRight('12345678901'), ['123', '4567', '8901']);
  assert.deepEqual(groupFromRight('1234'), ['1234']);
  assert.deepEqual(groupFromRight(''), []);
});
