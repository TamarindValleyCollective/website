// Run with: node --test scripts/lib/finance-import-plan.test.mjs
//
// The storing step is source-independent: it takes normalised statements (what any parser, or a future bank API,
// produces) plus what is already held, and says what to store and what to report. Every fixture here is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planBankImport, heldFromPlan } from './finance-import-plan.mjs';

// A normalised statement. txns: [date, narration, signedPaise] in file order.
function stmt(from, to, opening, txns, extra = {}) {
  let bal = opening;
  const lines = txns.map(([tranDate, narration, signed], i) => {
    bal += signed;
    return { seq: i + 2, tranDate, valueDate: tranDate, narration, direction: signed < 0 ? 'debit' : 'credit', amountPaise: Math.abs(signed), balancePaise: bal, upiRrn: null };
  });
  return { from, to, openingPaise: opening, closingPaise: bal, reported: null, lines, ...extra };
}
const file = (id, statement, fileHash = `hash-${id}`) => ({ id, fileHash, statement });
const noHeld = () => ({ batches: [], lines: [] });
const plan = (incoming, held = noHeld()) => planBankImport({ accountId: 'acct', incoming, held });
const byId = (result, id) => result.batches.find((b) => b.id === id);

// Three connected invented years: each closes where the next opens.
const y22 = () => stmt('2022-01-01', '2022-12-31', 0, [['2022-06-20', 'Deposit', 5000000], ['2022-07-01', 'UPI/P2A/400000000001/Shop', -120000]]);
const y23 = () => stmt('2023-01-01', '2023-12-31', 4880000, [['2023-01-02', 'Rent', -300000], ['2023-02-01', 'Interest', 12345]]);
const y24 = () => stmt('2024-01-01', '2024-12-31', 4592345, [['2024-01-05', 'Fees', -5900], ['2024-01-05', 'Fees', -5900]]);

test('one year imports: every line is new, with a unique key, and coverage is the period', () => {
  const r = plan([file('a', y22())]);
  const b = byId(r, 'a');
  assert.equal(b.status, 'ok');
  assert.deepEqual([b.counts.total, b.counts.new, b.counts.alreadyHeld], [2, 2, 0]);
  assert.equal(b.newLines.length, 2);
  assert.equal(new Set(b.newLines.map((l) => l.dedupeKey)).size, 2);
  assert.deepEqual([b.firstDate, b.lastDate], ['2022-06-20', '2022-07-01']);
  assert.deepEqual(r.coverage.intervals, [{ from: '2022-01-01', to: '2022-12-31' }]);
  assert.deepEqual(r.coverage.gaps, []);
  assert.equal(r.blocked, false);
});

test('the same file twice imports nothing the second time', () => {
  const first = plan([file('a', y22())]);
  const held = heldFromPlan(noHeld(), first);
  const second = plan([file('a', y22())], held);
  assert.equal(byId(second, 'a').status, 'duplicate_file');
  assert.equal(byId(second, 'a').newLines.length, 0);
});

test('the same file twice in one upload counts once', () => {
  const r = plan([file('a', y22()), file('b', y22(), 'hash-a')]);
  assert.equal(byId(r, 'a').status, 'ok');
  assert.equal(byId(r, 'b').status, 'duplicate_file');
});

test('a fresh download of the same period (different file hash) adds nothing and is not an error', () => {
  const held = heldFromPlan(noHeld(), plan([file('a', y22())]));
  const r = plan([file('again', y22(), 'other-hash')], held);
  const b = byId(r, 'again');
  assert.equal(b.status, 'ok');
  assert.deepEqual([b.counts.new, b.counts.alreadyHeld], [0, 2]);
});

test('two identical same-day lines both import', () => {
  const r = plan([file('c', y24(), 'h24')]);
  assert.equal(byId(r, 'c').counts.new, 2);
  const keys = byId(r, 'c').newLines.map((l) => l.dedupeKey);
  assert.equal(new Set(keys).size, 2);
});

test('identical lines with identical balances (zero amounts) are kept apart by their order in the file', () => {
  const s = stmt('2024-01-01', '2024-01-31', 1000, [['2024-01-02', 'Nil', 0], ['2024-01-02', 'Nil', 0]]);
  const r = plan([file('z', s)]);
  assert.equal(byId(r, 'z').counts.new, 2);
  // and a re-download of the same two is recognised as the same two, not four
  const again = plan([file('z2', s, 'other')], heldFromPlan(noHeld(), r));
  assert.deepEqual([byId(again, 'z2').counts.new, byId(again, 'z2').counts.alreadyHeld], [0, 2]);
});

test('a broken balance chain is reported with the line, not guessed, and nothing is stored', () => {
  const s = y22();
  s.lines[1].balancePaise += 100;
  s.closingPaise = s.lines[1].balancePaise;
  const r = plan([file('a', s)]);
  const b = byId(r, 'a');
  assert.equal(b.status, 'blocked');
  assert.equal(b.newLines.length, 0);
  assert.equal(b.errors[0].type, 'chain_break');
  assert.equal(b.errors[0].seq, 3);
  assert.equal(b.errors[0].expectedPaise, 4880000);
  assert.equal(b.errors[0].foundPaise, 4880100);
  assert.equal(r.blocked, true);
});

test("the bank's own footer is checked: closing balance and DR/CR totals must agree with the lines", () => {
  const ok = y22();
  ok.reported = { debitPaise: 120000, creditPaise: 5000000, closingPaise: ok.closingPaise };
  assert.equal(byId(plan([file('a', ok)]), 'a').status, 'ok');
  const bad = y22();
  bad.reported = { debitPaise: 120001, creditPaise: 5000000, closingPaise: bad.closingPaise };
  assert.equal(byId(plan([file('b', bad)]), 'b').errors[0].type, 'footer_mismatch');
});

test('a line dated outside the statement period, or out of date order, is refused', () => {
  const out = y22();
  out.lines[0].tranDate = '2023-01-02';
  assert.equal(byId(plan([file('o', out)]), 'o').errors[0].type, 'out_of_period');
  const unordered = stmt('2022-01-01', '2022-12-31', 0, [['2022-07-01', 'B', 100], ['2022-06-20', 'A', 100]]);
  assert.equal(byId(plan([file('u', unordered)]), 'u').errors[0].type, 'not_in_date_order');
});

test('several yearly files in one upload, in any order, chain across the boundaries', () => {
  const r = plan([file('y24', y24()), file('y22', y22()), file('y23', y23())]);
  assert.deepEqual(r.batches.map((b) => b.status), ['ok', 'ok', 'ok']);
  assert.deepEqual(r.order, ['y22', 'y23', 'y24']);
  assert.deepEqual(r.coverage.intervals, [{ from: '2022-01-01', to: '2024-12-31' }]);
  assert.deepEqual(r.coverage.gaps, []);
  // each boundary is checked once, when the later year is processed
  assert.deepEqual(byId(r, 'y22').boundaries.map((x) => x.type), []);
  assert.deepEqual(byId(r, 'y23').boundaries.map((x) => [x.type, x.side]), [['chain_ok', 'before']]);
  assert.deepEqual(byId(r, 'y24').boundaries.map((x) => [x.type, x.side]), [['chain_ok', 'before']]);
});

test('one year at a time in any order: gaps are reported until the missing year arrives', () => {
  let held = noHeld();
  let r = plan([file('y24', y24())], held);
  held = heldFromPlan(held, r);
  r = plan([file('y22', y22())], held);
  assert.deepEqual(r.coverage.gaps, [{ from: '2023-01-01', to: '2023-12-31' }]);
  assert.equal(byId(r, 'y22').status, 'ok'); // a gap is reported, not a reason to refuse a year that is itself consistent
  assert.equal(byId(r, 'y22').boundaries.find((x) => x.type === 'gap').between.length, 2);
  held = heldFromPlan(held, r);
  r = plan([file('y23', y23())], held);
  assert.equal(byId(r, 'y23').status, 'ok');
  assert.deepEqual(r.coverage.gaps, []);
  assert.deepEqual(r.coverage.intervals, [{ from: '2022-01-01', to: '2024-12-31' }]);
});

test("one year's closing balance must equal the next year's opening balance (either order, one file or two)", () => {
  const wrong23 = stmt('2023-01-01', '2023-12-31', 4880001, [['2023-01-02', 'Rent', -300000]]);
  // together in one upload
  let r = plan([file('y22', y22()), file('y23', wrong23)]);
  assert.equal(byId(r, 'y22').status, 'ok');
  const b = byId(r, 'y23');
  assert.equal(b.status, 'blocked');
  assert.deepEqual(
    { type: b.errors[0].type, expectedPaise: b.errors[0].expectedPaise, foundPaise: b.errors[0].foundPaise },
    { type: 'boundary_mismatch', expectedPaise: 4880000, foundPaise: 4880001 },
  );
  // the later year first, then the earlier one: the mismatch is found when the second arrives
  const held = heldFromPlan(noHeld(), plan([file('y23', wrong23)]));
  r = plan([file('y22', y22())], held);
  assert.equal(byId(r, 'y22').status, 'blocked');
  assert.equal(byId(r, 'y22').errors[0].type, 'boundary_mismatch');
});

test('a gap between years is reported even when a neighbouring year is also in the upload', () => {
  const r = plan([file('y22', y22()), file('y24', y24())]);
  assert.deepEqual(r.batches.map((b) => b.status), ['ok', 'ok']);
  assert.deepEqual(r.coverage.gaps, [{ from: '2023-01-01', to: '2023-12-31' }]);
});

test('a blocked year does not count as held: the next year sees a gap, and the rest of the upload goes through', () => {
  const broken = y23();
  broken.lines[0].balancePaise += 1;
  const r = plan([file('y22', y22()), file('y23', broken), file('y24', y24())]);
  assert.deepEqual(r.batches.map((b) => b.status), ['ok', 'blocked', 'ok']);
  assert.deepEqual(r.coverage.gaps, [{ from: '2023-01-01', to: '2023-12-31' }]);
});

test('a later overlapping download adds only the new lines and says how many were there already', () => {
  const jan = stmt('2026-01-01', '2026-10-31', 100000, [['2026-01-05', 'A', -1000], ['2026-10-30', 'B', -2000]]);
  const held = heldFromPlan(noHeld(), plan([file('first', jan)]));
  const more = stmt('2026-01-01', '2026-11-30', 100000, [['2026-01-05', 'A', -1000], ['2026-10-30', 'B', -2000], ['2026-11-02', 'C', -3000], ['2026-11-20', 'D', 500]]);
  const r = plan([file('second', more)], held);
  const b = byId(r, 'second');
  assert.equal(b.status, 'ok');
  assert.deepEqual([b.counts.total, b.counts.new, b.counts.alreadyHeld], [4, 2, 2]);
  assert.deepEqual(b.newLines.map((l) => l.narration), ['C', 'D']);
  const overlap = b.boundaries.find((x) => x.type === 'overlap');
  assert.deepEqual([overlap.from, overlap.to], ['2026-01-01', '2026-10-31']);
  assert.deepEqual(r.coverage.intervals, [{ from: '2026-01-01', to: '2026-11-30' }]);
});

test('a line posted late on the last day already held is accepted; a backdated one is not', () => {
  const held = heldFromPlan(noHeld(), plan([file('first', stmt('2026-11-01', '2026-11-02', 1000, [['2026-11-02', 'A', -100]]))]));
  const late = stmt('2026-11-01', '2026-11-03', 1000, [['2026-11-02', 'A', -100], ['2026-11-02', 'LATE', -50], ['2026-11-03', 'B', 10]]);
  assert.equal(byId(plan([file('late', late)], held), 'late').counts.new, 2);
  const backdated = stmt('2026-11-01', '2026-11-03', 1000, [['2026-11-01', 'BACK', -50], ['2026-11-02', 'A', -150]]);
  const b = byId(plan([file('back', backdated)], held), 'back');
  assert.equal(b.status, 'blocked');
  assert.equal(b.errors[0].type, 'overlap_conflict');
});

test('an overlapping file that lacks a line we hold is a conflict, not a silent merge', () => {
  const held = heldFromPlan(noHeld(), plan([file('first', y22())]));
  const missing = stmt('2022-01-01', '2022-12-31', 0, [['2022-06-20', 'Deposit', 5000000]]);
  const b = byId(plan([file('m', missing)], held), 'm');
  assert.equal(b.status, 'blocked');
  assert.equal(b.errors[0].type, 'overlap_conflict');
  assert.equal(b.errors[0].missingHeld, 1);
});

test('an empty year (no transactions) chains through', () => {
  const quiet = stmt('2023-01-01', '2023-12-31', 4880000, []);
  const r = plan([file('y22', y22()), file('q', quiet), file('y24', stmt('2024-01-01', '2024-12-31', 4880000, [['2024-02-01', 'X', 1]]))]);
  assert.deepEqual(r.batches.map((b) => b.status), ['ok', 'ok', 'ok']);
});

test('lines of different accounts never collide: the account is part of the key', () => {
  const a = planBankImport({ accountId: 'A', incoming: [file('x', y22())], held: noHeld() });
  const b = planBankImport({ accountId: 'B', incoming: [file('x', y22())], held: noHeld() });
  assert.notEqual(a.batches[0].newLines[0].dedupeKey, b.batches[0].newLines[0].dedupeKey);
});
