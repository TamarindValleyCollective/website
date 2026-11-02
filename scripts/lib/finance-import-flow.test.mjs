// Run with: node --test scripts/lib/finance-import-flow.test.mjs
//
// The whole import flow (parse -> plan -> store -> link) against an in-memory store that enforces the same
// uniqueness the database does. Needs Node 22.18+ (it imports the .ts orchestrator directly). Invented data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runImport } from '../../netlify/functions/lib/finance-import.ts';
import { axisStatement, paytmExport } from './finance-fixtures.mjs';
import { coverageOf } from './finance-import-plan.mjs';

function fakeStore({ accounts = [{ id: 'acct', label: 'Test current', last4: '1234', upiLabel: 'Axis Bank - 99' }], failStore = false } = {}) {
  const db = { batches: [], bank: [], upi: [], raw: new Map(), audit: [] };
  return {
    db,
    async entity() { return { id: 'ent', circleTag: 'Pocket Money' }; },
    async accounts() { return accounts; },
    async heldBank(accountId, from, to) {
      const mine = db.batches.filter((b) => b.accountId === accountId && b.source === 'axis_statement');
      return {
        batches: mine.map((b) => ({ fileHash: b.fileHash, from: b.from, to: b.to, openingPaise: b.opening, closingPaise: b.closing })),
        lines: db.bank.filter((l) => l.accountId === accountId && l.tran_date >= from && l.tran_date <= to).map((l) => ({ tranDate: l.tran_date, dedupeKey: l.dedupe_key })),
      };
    },
    async heldHashes(hashes) { return db.batches.filter((b) => hashes.includes(b.fileHash)).map((b) => b.fileHash); },
    async heldUpiRefs(refs) { return db.upi.filter((u) => refs.includes(u.upi_ref)).map((u) => u.upi_ref); },
    async putRaw(key, bytes) { db.raw.set(key, bytes); },
    async deleteRaw(key) { db.raw.delete(key); },
    async storeBank(batch, lines) {
      if (failStore) throw new Error('boom');
      const keys = new Set(db.bank.map((l) => l.dedupe_key));
      if (db.batches.some((b) => b.fileHash === batch.file_hash) || lines.some((l) => keys.has(l.dedupe_key))) throw new Error('unique violation');
      db.batches.push({ id: batch.id, source: 'axis_statement', accountId: batch.bank_account_id, fileHash: batch.file_hash, from: batch.period_from, to: batch.period_to, opening: batch.opening_paise, closing: batch.closing_paise });
      lines.forEach((l, i) => db.bank.push({ ...l, id: `b${db.bank.length + 1}`, accountId: batch.bank_account_id }));
      return lines.length;
    },
    async storeUpi(batch, lines) {
      if (db.batches.some((b) => b.fileHash === batch.file_hash) || lines.some((l) => db.upi.some((u) => u.upi_ref === l.upi_ref))) throw new Error('unique violation');
      db.batches.push({ id: batch.id, source: 'paytm_upi', fileHash: batch.file_hash, counts: batch });
      lines.forEach((l) => db.upi.push({ ...l, id: `u${db.upi.length + 1}`, bank_line_id: null }));
      return lines.length;
    },
    async unlinkedUpi() { return db.upi.filter((u) => !u.bank_line_id && !u.ignored).map((u) => ({ id: u.id, upiRef: u.upi_ref, amountPaise: u.amount_paise, direction: u.direction })); },
    async bankLinesByRrn(rrns) { return db.bank.filter((l) => rrns.includes(l.upi_rrn)).map((l) => ({ id: l.id, upiRrn: l.upi_rrn, amountPaise: l.amount_paise, direction: l.direction })); },
    async link(links) { links.forEach((k) => { db.upi.find((u) => u.id === k.upiId).bank_line_id = k.bankId; }); return links.length; },
    async reconciliationData() {
      const linked = new Set(db.upi.map((u) => u.bank_line_id).filter(Boolean));
      return {
        upiLines: db.upi.filter((u) => !u.ignored).map((u) => ({ paidAt: u.paid_at, amountPaise: u.amount_paise, bankLineId: u.bank_line_id })),
        bankLines: db.bank.filter((l) => l.upi_rrn).map((l) => ({ tranDate: l.tran_date, upiRrn: l.upi_rrn, linked: linked.has(l.id) })),
        lastBankDate: db.bank.map((l) => l.tran_date).sort().pop() ?? null,
        firstUpiDate: db.upi.map((u) => u.paid_at).sort()[0] ?? null,
      };
    },
    async audit(entry) { db.audit.push(entry); },
    async heldBatchSpans() { return db.batches.filter((b) => b.source === 'axis_statement').map((b) => ({ accountId: b.accountId, from: b.from, to: b.to })); },
  };
}

// Three connected invented years. Each year's closing is the next year's opening.
const years = () => {
  const a = axisStatement({ from: '2022-01-01', to: '2022-12-31', openingPaise: 0, txns: [{ date: '2022-06-20', narration: 'Deposit', cr: 5000000 }, { date: '2022-07-01', narration: 'UPI/P2A/400000000001/Test Payee/Axis Bank/x', dr: 120000 }] });
  const b = axisStatement({ from: '2023-01-01', to: '2023-12-31', openingPaise: a.closing, txns: [{ date: '2023-01-02', narration: 'Rent', dr: 300000 }] });
  const c = axisStatement({ from: '2024-01-01', to: '2024-12-31', openingPaise: b.closing, txns: [{ date: '2024-01-05', narration: 'Fees', dr: 5900 }, { date: '2024-01-05', narration: 'Fees', dr: 5900 }] });
  return { y22: a, y23: b, y24: c };
};
const up = (name, bytes) => ({ name, bytes });
const run = (store, files, commit = true) => runImport({ store, files, commit, actorId: 'actor' });

test('preview writes nothing; commit stores every year once, with the raw files and one audit entry', async () => {
  const s = fakeStore();
  const { y22, y23, y24 } = years();
  const files = [up('2024.xlsx', y24.bytes), up('2022.xlsx', y22.bytes), up('2023.xlsx', y23.bytes)];
  const p = await run(s, files, false);
  assert.equal(p.mode, 'preview');
  assert.deepEqual(p.files.map((f) => f.status), ['ok', 'ok', 'ok']);
  assert.deepEqual(p.files.map((f) => f.counts.new), [2, 2, 1]);
  assert.equal(s.db.bank.length + s.db.batches.length + s.db.raw.size + s.db.audit.length, 0);

  const c = await run(s, files);
  assert.equal(c.mode, 'commit');
  assert.deepEqual(c.files.map((f) => f.stored), [true, true, true]);
  assert.equal(s.db.bank.length, 5);
  assert.equal(s.db.batches.length, 3);
  assert.equal(s.db.raw.size, 3);
  assert.equal(s.db.audit.length, 1);
  assert.deepEqual(JSON.stringify(s.db.audit[0].detail).includes('Rent'), false); // counts only, never narrations
  assert.deepEqual(c.coverage[0].intervals, [{ from: '2022-01-01', to: '2024-12-31' }]);
  assert.deepEqual(c.coverage[0].gaps, []);
});

test('uploading the same files again stores nothing and logs nothing', async () => {
  const s = fakeStore();
  const { y22, y23 } = years();
  const files = [up('a.xlsx', y22.bytes), up('b.xlsx', y23.bytes)];
  await run(s, files);
  const again = await run(s, files);
  assert.deepEqual(again.files.map((f) => f.status), ['duplicate_file', 'duplicate_file']);
  assert.equal(s.db.bank.length, 3);
  assert.equal(s.db.audit.length, 1);
});

test('one year at a time in any order ends in the same place as all at once', async () => {
  const s = fakeStore();
  const { y22, y23, y24 } = years();
  const r1 = await run(s, [up('2024.xlsx', y24.bytes)]);
  assert.equal(r1.files[0].status, 'ok');
  const r2 = await run(s, [up('2022.xlsx', y22.bytes)]);
  assert.deepEqual(r2.coverage[0].gaps, [{ from: '2023-01-01', to: '2023-12-31' }]);
  const r3 = await run(s, [up('2023.xlsx', y23.bytes)]);
  assert.deepEqual(r3.coverage[0].gaps, []);
  assert.equal(s.db.bank.length, 5);
  assert.deepEqual(coverageOf(await s.heldBatchSpans()).intervals, [{ from: '2022-01-01', to: '2024-12-31' }]);
});

test('a year that does not meet its neighbour is refused and the others still go in', async () => {
  const s = fakeStore();
  const { y22, y24 } = years();
  const wrong23 = axisStatement({ from: '2023-01-01', to: '2023-12-31', openingPaise: 1, txns: [{ date: '2023-01-02', narration: 'Rent', dr: 1 }] });
  const r = await run(s, [up('2022.xlsx', y22.bytes), up('2023.xlsx', wrong23.bytes), up('2024.xlsx', y24.bytes)]);
  assert.deepEqual(r.files.map((f) => f.status), ['ok', 'blocked', 'ok']);
  assert.equal(r.files[1].errors[0].type, 'boundary_mismatch');
  assert.equal(r.files[1].stored, undefined);
  assert.equal(s.db.batches.length, 2);
  assert.deepEqual(r.coverage[0].gaps, [{ from: '2023-01-01', to: '2023-12-31' }]);
});

test('a statement for an account nobody registered is refused with a clear message', async () => {
  const s = fakeStore({ accounts: [] });
  const r = await run(s, [up('x.xlsx', years().y22.bytes)]);
  assert.equal(r.files[0].status, 'blocked');
  assert.equal(r.files[0].errors[0].type, 'account_not_registered');
  assert.equal(s.db.bank.length, 0);
});

test('a file that is not a statement is reported on its own and does not stop the others', async () => {
  const s = fakeStore();
  const r = await run(s, [up('notes.csv', new TextEncoder().encode('a,b\n1,2')), up('2022.xlsx', years().y22.bytes)]);
  assert.deepEqual(r.files.map((f) => f.status), ['unreadable', 'ok']);
  assert.match(r.files[0].message, /Excel/);
});

test('if saving a file fails, its raw copy is removed and nothing of it is reported as stored', async () => {
  const s = fakeStore({ failStore: true });
  const r = await run(s, [up('2022.xlsx', years().y22.bytes)]);
  assert.equal(r.files[0].status, 'blocked');
  assert.equal(s.db.raw.size, 0);
});

test('Paytm: rows are kept or ignored, linked to the bank by reference, and a later bank import links the rest', async () => {
  const s = fakeStore();
  const { y22 } = years();
  const paytm = paytmExport({
    rows: [
      { date: '2022-07-01', amount: -120000, ref: '400000000001', tag: '#💰 Pocket Money' }, // matches the bank line above
      { date: '2022-07-02', amount: -50000, ref: '400000000002', tag: '#💰 Pocket Money' }, // after the bank's last line: awaiting
      { date: '2022-07-03', amount: -777, ref: '400000000003', account: 'Other Bank Credit Card' }, // ignored
    ],
    accounts: ['Axis Bank - 99', 'Other Bank Credit Card'],
  });
  // Paytm first: nothing to link yet
  const first = await run(s, [up('paytm.xlsx', paytm)]);
  assert.equal(first.files[0].counts.new, 2);
  assert.deepEqual(first.files[0].ignored.count, 1);
  assert.equal(first.reconciliation.linkedNow, 0);
  assert.equal(s.db.upi.find((u) => u.upi_ref === '400000000001').is_circle, true);
  // the bank statement arrives later and the first row links; the second stays awaiting (dated after the last bank line)
  const second = await run(s, [up('2022.xlsx', y22.bytes)]);
  assert.equal(second.reconciliation.linkedNow, 1);
  assert.equal(s.db.upi.filter((u) => u.bank_line_id).length, 1);
  assert.deepEqual(second.reconciliation.awaitingBank, { count: 1, totalPaise: 50000 });
  // uploading the Paytm file again stores nothing
  const again = await run(s, [up('paytm.xlsx', paytm)]);
  assert.equal(again.files[0].status, 'duplicate_file');
});

test('Paytm with no registered account is refused and stores nothing, so it can be redone once the account exists', async () => {
  const s = fakeStore({ accounts: [] });
  const paytm = paytmExport({ rows: [{ date: '2022-07-01', amount: -120000, ref: '400000000001' }] });
  const r = await run(s, [up('paytm.xlsx', paytm)]);
  assert.equal(r.files[0].status, 'blocked');
  assert.equal(r.files[0].errors[0].type, 'no_registered_rows');
  assert.equal(s.db.upi.length + s.db.batches.length + s.db.raw.size + s.db.audit.length, 0);
});

test('Paytm preview says how many rows would link right now', async () => {
  const s = fakeStore();
  await run(s, [up('2022.xlsx', years().y22.bytes)]);
  const p = await run(s, [up('paytm.xlsx', paytmExport({ rows: [{ date: '2022-07-01', amount: -120000, ref: '400000000001' }] }))], false);
  assert.equal(p.files[0].wouldLink, 1);
});
