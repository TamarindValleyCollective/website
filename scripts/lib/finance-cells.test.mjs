// Run with: node --test scripts/lib/finance-cells.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePaise, parseDateCell, excelSerialToIso } from './finance-cells.mjs';

test('amounts: text with Indian or Western commas, signs, symbols; numbers; never floats', () => {
  assert.equal(parsePaise('1,23,456.78'), 12345678);
  assert.equal(parsePaise('1,234.5'), 123450);
  assert.equal(parsePaise('0.00'), 0);
  assert.equal(parsePaise('-9,999.99'), -999999);
  assert.equal(parsePaise('+2,500.00'), 250000);
  assert.equal(parsePaise(' ₹ 100 '), 10000);
  assert.equal(parsePaise(1234.56), 123456);
  assert.equal(parsePaise(0.1 + 0.2), 30); // a float that is not exactly 0.3 still lands on 30 paise
  assert.equal(parsePaise(1200), 120000);
});

test('amounts: anything else is refused, not guessed', () => {
  for (const bad of ['', null, 'abc', '1.234', '12,34.5.6', '1e5', NaN]) assert.throws(() => parsePaise(bad), /amount/i, String(bad));
  assert.throws(() => parsePaise(10.123), /amount/i);
});

test('dates: dd/mm/yyyy text, ISO text, and Excel serial numbers all give the same day', () => {
  assert.equal(parseDateCell('05/03/2026'), '2026-03-05');
  assert.equal(parseDateCell(' 5/3/2026 '), '2026-03-05');
  assert.equal(parseDateCell('2026-03-05'), '2026-03-05');
  assert.equal(parseDateCell(46086), '2026-03-05');
  assert.equal(parseDateCell(46086.75), '2026-03-05'); // a time of day is dropped
  assert.equal(excelSerialToIso(44927), '2023-01-01');
});

test('dates: impossible or unreadable dates are refused', () => {
  for (const bad of ['31/02/2026', '13/13/2026', '2026/03/05', 'yesterday', '', null, 12]) assert.throws(() => parseDateCell(bad), /date/i, String(bad));
});
