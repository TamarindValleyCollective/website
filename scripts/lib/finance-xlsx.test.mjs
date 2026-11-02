// Run with: node --test scripts/lib/finance-xlsx.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readWorkbook } from './finance-xlsx.mjs';
import { buildXlsx } from './finance-fixtures.mjs';

const sheets = [
  { name: 'First', rows: [['a', 'b & <c>'], [null, 'x'], [12.5, 'y']] },
  { name: 'Second', rows: [['only']] },
];

test('reads inline strings, numbers, blanks and sheet names in order', () => {
  const wb = readWorkbook(buildXlsx(sheets));
  assert.deepEqual(wb.map((s) => s.name), ['First', 'Second']);
  assert.deepEqual(wb[0].rows, [['a', 'b & <c>'], [null, 'x'], [12.5, 'y']]);
});

test('reads shared strings the way Excel writes them', () => {
  const wb = readWorkbook(buildXlsx(sheets, { shared: true }));
  assert.deepEqual(wb[0].rows[0], ['a', 'b & <c>']);
  assert.equal(wb[1].rows[0][0], 'only');
});

test('rows are padded so a column index is stable', () => {
  const wb = readWorkbook(buildXlsx([{ name: 'S', rows: [[null, null, 'third'], ['x']] }]));
  assert.equal(wb[0].rows[0][2], 'third');
  assert.equal(wb[0].rows[1][0], 'x');
});

test('a file that is not an Excel workbook is refused with a plain message', () => {
  assert.throws(() => readWorkbook(new Uint8Array([1, 2, 3, 4])), /not an Excel/i);
  assert.throws(() => readWorkbook(new TextEncoder().encode('Date,Amount\n1,2')), /not an Excel/i);
});
