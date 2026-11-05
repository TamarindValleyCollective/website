// Run with: node --test scripts/lib/finance-history.test.mjs
// Loading the Google Sheet's history (docs/finance/sessions/06-history-load.md): reading the funds transfer tracker and matching
// its rows to the bank lines already imported. Every name, narration and amount here is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchTracker, parseTracker, referenceOf, similarity } from './finance-history.mjs';

const HEADER = ['#', 'Date', 'To', 'From', 'Mode', 'Amount', 'Bank Charges', 'Total Amount', 'Screenshot', 'Transaction Particulars', 'FreeCharge Reference', 'DR/CR', 'Payment Gateway Reference', 'UPI ID', 'Details', 'Type', 'Remarks', 'Link', 'Year', 'Month', 'Financial Year', 'To Entity', 'From Entity'];
const sheetRow = (o) => {
  const r = new Array(HEADER.length).fill('');
  for (const [k, v] of Object.entries(o)) r[HEADER.indexOf(k)] = v;
  return r;
};

test('the tracker is read by its heading names: dates as day/month/year, amounts in rupees, DR and CR as direction', () => {
  const grid = [
    HEADER,
    sheetRow({ '#': '1', Date: '31/10/2026', To: 'Green Nursery', Amount: '2,500.00', 'Transaction Particulars': 'UPI/P2A/123456789012/Green Nursery/x', 'DR/CR': 'DR', Details: 'Farm Expenses', Type: 'Opex', Remarks: 'Mango saplings', Year: '2026', Month: '10', 'Financial Year': '2026-2027' }),
    sheetRow({ '#': '2', Date: '5/4/2025', Amount: '1500', 'Transaction Particulars': 'NEFT/x', 'DR/CR': 'cr', Details: 'Maintenance (25-26)', Type: 'Member Contribution', Year: '2025', Month: '3' }),
  ];
  const { rows, problems } = parseTracker(grid);
  assert.equal(problems.length, 0);
  assert.deepEqual(rows.map((r) => [r.sheetRow, r.date, r.amountPaise, r.direction]), [[2, '2026-10-31', 250000, 'debit'], [3, '2025-04-05', 150000, 'credit']]);
  assert.equal(rows[0].details, 'Farm Expenses');
  assert.equal(rows[0].type, 'Opex');
  assert.equal(rows[0].remarks, 'Mango saplings');
  assert.equal(rows[0].toName, 'Green Nursery');
  assert.equal(rows[0].financialYear, '2026-2027');
});

test('the period is the sheet\'s own Year and Month when they are there (a March cost paid in April stays March), else the month of the date', () => {
  const { rows } = parseTracker([HEADER, sheetRow({ Date: '5/4/2025', Amount: '1', 'Transaction Particulars': 'x', 'DR/CR': 'DR', Year: '2025', Month: '3' }), sheetRow({ Date: '7/6/2025', Amount: '1', 'Transaction Particulars': 'x', 'DR/CR': 'DR' })]);
  assert.deepEqual(rows.map((r) => r.period), ['2025-03-01', '2025-06-01']);
});

test('rows that cannot be used are reported with their sheet row number, never guessed', () => {
  const { rows, problems } = parseTracker([
    HEADER,
    sheetRow({ Date: '', Amount: '10', 'DR/CR': 'DR' }),
    sheetRow({ Date: '1/1/2026', Amount: '', 'Transaction Particulars': 'x', 'DR/CR': 'DR' }),
    sheetRow({ Date: '1/1/2026', Amount: '12.345', 'Transaction Particulars': 'x', 'DR/CR': 'DR' }),
    sheetRow({ Date: '1/1/2026', Amount: '10', 'Transaction Particulars': 'x', 'DR/CR': '?' }),
    sheetRow({ Date: '1/1/2026', Amount: '10', 'Transaction Particulars': 'x', 'DR/CR': 'DR' }),
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual(problems.map((p) => p.sheetRow), [2, 3, 4, 5]);
  assert.match(problems[0].reason, /date/i);
  assert.match(problems[1].reason, /amount/i);
  assert.match(problems[2].reason, /amount/i);
  assert.match(problems[3].reason, /DR\/CR/);
  assert.equal(rows[0].sheetRow, 6);
});

test('a tracker without the headings it needs is refused outright', () => {
  assert.throws(() => parseTracker([['Date', 'Amount'], ['1/1/2026', '5']]), /DR\/CR|Transaction Particulars/);
});

const line = (id, date, dir, paise, narration) => ({ id, tran_date: date, direction: dir, amount_paise: paise, narration, upi_rrn: referenceOf(narration) });
const row = (n, date, dir, paise, particulars, extra = {}) => ({ sheetRow: n, date, direction: dir, amountPaise: paise, particulars, ...extra });

test('a row and a line with the same date, direction and amount are paired', () => {
  const m = matchTracker([row(2, '2026-10-31', 'debit', 250000, 'UPI/P2A/123456789012/Green Nursery/x')], [line('L1', '2026-10-31', 'debit', 250000, 'UPI/P2A/123456789012/Green Nursery/x')]);
  assert.deepEqual(m.pairs.map((p) => [p.row.sheetRow, p.line.id, p.how]), [[2, 'L1', 'exact']]);
  assert.equal(m.unmatchedRows.length + m.unmatchedLines.length, 0);
});

test('two identical-looking lines on one day are paired by narration, whatever order the sheet has them in', () => {
  const lines = [line('A', '2026-10-31', 'debit', 50000, 'UPI/P2A/111111111111/Alpha Traders/x'), line('B', '2026-10-31', 'debit', 50000, 'UPI/P2A/222222222222/Beta Stores/x')];
  const rows = [row(2, '2026-10-31', 'debit', 50000, 'UPI/P2A/222222222222/Beta Stores/x'), row(3, '2026-10-31', 'debit', 50000, 'UPI/P2A/111111111111/Alpha Traders/x')];
  const m = matchTracker(rows, lines);
  assert.deepEqual(m.pairs.map((p) => [p.row.sheetRow, p.line.id]).sort(), [[2, 'B'], [3, 'A']].sort());
  assert.equal(m.counts.ambiguous, 2, 'it says how many were a choice between identical amounts');
});

test('a line is never claimed twice', () => {
  const m = matchTracker([row(2, '2026-10-31', 'debit', 100, 'x'), row(3, '2026-10-31', 'debit', 100, 'x')], [line('A', '2026-10-31', 'debit', 100, 'x')]);
  assert.equal(m.pairs.length, 1);
  assert.equal(m.unmatchedRows.length, 1);
});

test('rows split by hand (a salary batch) are grouped when together they equal one bank line', () => {
  const rows = [row(2, '2026-10-31', 'debit', 30000, 'NEFT/BATCH/1'), row(3, '2026-10-31', 'debit', 45000, 'NEFT/BATCH/1'), row(4, '2026-10-31', 'debit', 25000, 'NEFT/BATCH/1'), row(5, '2026-10-30', 'debit', 999, 'something else')];
  const m = matchTracker(rows, [line('S', '2026-10-31', 'debit', 100000, 'NEFT/BATCH/1')]);
  assert.equal(m.groups.length, 1);
  assert.deepEqual(m.groups[0].rows.map((r) => r.sheetRow), [2, 3, 4]);
  assert.equal(m.groups[0].line.id, 'S');
  assert.deepEqual(m.unmatchedRows.map((r) => r.sheetRow), [5]);
});

test('a group must add up exactly; near misses are left for a person', () => {
  const rows = [row(2, '2026-10-31', 'debit', 30000, 'x'), row(3, '2026-10-31', 'debit', 45000, 'x')];
  const m = matchTracker(rows, [line('S', '2026-10-31', 'debit', 100000, 'x')]);
  assert.equal(m.groups.length, 0);
  assert.equal(m.unmatchedRows.length, 2);
  assert.equal(m.unmatchedLines.length, 1);
});

test("a row whose date is a little off is matched by the bank's reference, or by amount within five days, and flagged as approximate", () => {
  const byRef = matchTracker([row(2, '2026-10-29', 'debit', 777700, 'UPI/P2A/123456789012/Gamma/x')], [line('R', '2026-11-02', 'debit', 777700, 'UPI/P2A/123456789012/Gamma/x')]);
  assert.deepEqual(byRef.pairs.map((p) => p.how), ['reference']);
  const near = matchTracker([row(2, '2026-10-29', 'debit', 4200, 'plain')], [line('N', '2026-11-01', 'debit', 4200, 'plain')]);
  assert.deepEqual(near.pairs.map((p) => p.how), ['near date']);
  const far = matchTracker([row(2, '2026-10-01', 'debit', 4200, 'plain')], [line('N', '2026-11-01', 'debit', 4200, 'plain')]);
  assert.equal(far.pairs.length, 0);
});

test('direction must agree: a credit is never paired with a debit of the same size', () => {
  const m = matchTracker([row(2, '2026-10-31', 'credit', 500, 'x')], [line('D', '2026-10-31', 'debit', 500, 'x')]);
  assert.equal(m.pairs.length, 0);
});

test('the counts add up: every row and every line is in exactly one place', () => {
  const rows = [row(2, '2026-10-31', 'debit', 100, 'a'), row(3, '2026-10-30', 'debit', 200, 'b'), row(4, '2026-10-29', 'debit', 300, 'c'), row(5, '2026-10-29', 'debit', 400, 'd')];
  const lines = [line('1', '2026-10-31', 'debit', 100, 'a'), line('2', '2026-10-29', 'debit', 700, 'cd'), line('3', '2026-09-01', 'debit', 5, 'z')];
  const m = matchTracker(rows, lines);
  assert.equal(m.pairs.length + m.groups.reduce((n, g) => n + g.rows.length, 0) + m.unmatchedRows.length, rows.length);
  assert.equal(m.pairs.length + m.groups.length + m.unmatchedLines.length, lines.length);
});

test('similarity is highest for the same narration and low for different ones, ignoring case and punctuation', () => {
  assert.ok(similarity('UPI/P2A/1/Green Nursery', 'upi p2a 1 green nursery') > 0.95);
  assert.ok(similarity('UPI/P2A/1/Green Nursery', 'NEFT/Salary batch') < 0.4);
  assert.equal(similarity('', 'x'), 0);
});

test('the 12-digit reference is found in a narration, and only that', () => {
  assert.equal(referenceOf('UPI/P2A/123456789012/Name/bank'), '123456789012');
  assert.equal(referenceOf('NEFT/AXOIC1234567890123/Name'), null, 'a 13+ digit run is not a UPI reference');
  assert.equal(referenceOf('no digits'), null);
});
