// Run with: node --test scripts/lib/finance-axis-statement.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAxisStatement, upiRrnFromNarration } from './finance-axis-statement.mjs';
import { readWorkbook } from './finance-xlsx.mjs';
import { axisStatement, buildXlsx } from './finance-fixtures.mjs';

const txns = [
  { date: '2024-01-02', narration: 'UPI/P2A/400000000001/Test Payee/Axis Bank/Lunch', dr: 125050 },
  { date: '2024-01-02', narration: 'NEFT/AXISP00000000001/Test Sender', cr: 1000000 },
  { date: '2024-01-03', narration: 'Chrg: Test service charge', dr: 5900 },
  { date: '2024-01-03', narration: 'Chrg: Test service charge', dr: 5900 },
];
const sheet = (opts = {}) => readWorkbook(axisStatement({ from: '2024-01-01', to: '2024-12-31', openingPaise: 2500000, txns, ...opts }).bytes)[0].rows;

test('reads the period, account tail, opening, closing and every line', () => {
  const s = parseAxisStatement(sheet());
  assert.equal(s.from, '2024-01-01');
  assert.equal(s.to, '2024-12-31');
  assert.equal(s.accountLast4, '1234');
  assert.equal(s.openingPaise, 2500000);
  assert.equal(s.closingPaise, 2500000 - 125050 + 1000000 - 5900 - 5900);
  assert.equal(s.lines.length, 4);
  assert.deepEqual(s.lines[0], {
    seq: 2, tranDate: '2024-01-02', valueDate: '2024-01-02', narration: 'UPI/P2A/400000000001/Test Payee/Axis Bank/Lunch',
    direction: 'debit', amountPaise: 125050, balancePaise: 2500000 - 125050, upiRrn: '400000000001',
  });
  assert.equal(s.lines[1].direction, 'credit');
  assert.equal(s.lines[1].upiRrn, null);
});

test('the footer is not a line; the bank\'s own totals and closing balance are kept for the integrity check', () => {
  const s = parseAxisStatement(sheet());
  assert.equal(s.lines.some((l) => /TOTAL|CLOSING/.test(l.narration)), false);
  assert.deepEqual(s.reported, { debitPaise: 125050 + 5900 + 5900, creditPaise: 1000000, closingPaise: s.closingPaise });
});

test('works without a footer (a download cut short) and with shared strings', () => {
  const s = parseAxisStatement(sheet({ footer: false, shared: true }));
  assert.equal(s.lines.length, 4);
  assert.equal(s.reported, null);
  assert.equal(s.closingPaise, s.lines[3].balancePaise);
});

test('a statement with no transactions closes at its opening balance', () => {
  const s = parseAxisStatement(sheet({ txns: [] }));
  assert.equal(s.lines.length, 0);
  assert.equal(s.closingPaise, s.openingPaise);
});

test('amounts and dates stored as real numbers and Excel dates are read the same way', () => {
  const rows = sheet();
  const at = rows.findIndex((r) => r[0] === 'S.NO') + 2;
  rows[at][1] = 45293; // 02/01/2024
  rows[at][2] = 45293;
  rows[at][4] = 1250.5;
  rows[at][6] = 23749.5;
  const s = parseAxisStatement(rows);
  assert.equal(s.lines[0].tranDate, '2024-01-02');
  assert.equal(s.lines[0].amountPaise, 125050);
  assert.equal(s.lines[0].balancePaise, 2374950);
});

test('columns are found by their headings, so a moved column still parses', () => {
  const rows = sheet();
  const swap = (r) => { const c = [...r]; [c[4], c[6]] = [c[6], c[4]]; return c; };
  const h = rows.findIndex((r) => r[0] === 'S.NO');
  const moved = rows.map((r, i) => (i >= h && r[0] !== null && !/TOTAL|CLOSING|Unless/.test(String(r[3] ?? r[0])) && r.length > 6 ? swap(r) : r));
  assert.equal(parseAxisStatement(moved).lines[0].amountPaise, 125050);
});

test('layout drift fails loudly instead of guessing', () => {
  assert.throws(() => parseAxisStatement([['Date', 'Amount'], ['1', '2']]), /Axis statement/i);
  const noPeriod = sheet().filter((r) => !String(r[0] ?? '').startsWith('Statement of Account'));
  assert.throws(() => parseAxisStatement(noPeriod), /period/i);
  const rows = sheet();
  const at = rows.findIndex((r) => r[0] === 'S.NO') + 2;
  rows[at][5] = 'XX';
  assert.throws(() => parseAxisStatement(rows), /debit\/credit/i);
  const rows2 = sheet();
  rows2[at][4] = 'lots';
  assert.throws(() => parseAxisStatement(rows2), /line 2.*amount/i);
});

test('UPI reference: the 12 digits after UPI/P2A or UPI/P2M, otherwise none', () => {
  assert.equal(upiRrnFromNarration('UPI/P2A/400000000001/Name/Bank/x'), '400000000001');
  assert.equal(upiRrnFromNarration('UPI/P2M/500000000002/Shop'), '500000000002');
  assert.equal(upiRrnFromNarration('UPI/P2A/12345/Name'), null);
  assert.equal(upiRrnFromNarration('NEFT/UPI/P2A/400000000001/'), null);
  assert.equal(upiRrnFromNarration('Chrg: x'), null);
});

test('a workbook with no recognisable sheet is refused', () => {
  const wb = readWorkbook(buildXlsx([{ name: 'Other', rows: [['x']] }]));
  assert.throws(() => parseAxisStatement(wb[0].rows), /Axis statement/i);
});
