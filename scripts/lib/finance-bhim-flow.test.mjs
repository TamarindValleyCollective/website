// Run with: node --test scripts/lib/finance-bhim-flow.test.mjs
//
// A BHIM history (PDF) through the whole import flow, against an in-memory store: classify -> plan -> store -> link to a
// bank line already held. Needs Node 22.18+ (it imports the .ts orchestrator directly). Invented data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runImport } from '../../netlify/functions/lib/finance-import.ts';
import { axisStatement, bhimPdf } from './finance-fixtures.mjs';

function fakeStore(accounts = [{ id: 'acct', label: 'Test current', last4: '0099', upiLabel: null }]) {
  const db = { batches: [], bank: [], upi: [], raw: new Map() };
  return {
    db,
    async entity() { return { id: 'ent', circleTag: 'Pocket Money' }; },
    async accounts() { return accounts; },
    async heldBank(accountId) { return { batches: db.batches.filter((b) => b.source === 'axis_statement' && b.accountId === accountId), lines: [] }; },
    async heldHashes(hashes) { return db.batches.filter((b) => hashes.includes(b.fileHash)).map((b) => b.fileHash); },
    async heldUpiRefs(refs) { return db.upi.filter((u) => refs.includes(u.upi_ref)).map((u) => u.upi_ref); },
    async putRaw(key, bytes) { db.raw.set(key, bytes); },
    async deleteRaw(key) { db.raw.delete(key); },
    async storeBank(batch, lines) {
      db.batches.push({ source: 'axis_statement', accountId: batch.bank_account_id, fileHash: batch.file_hash });
      lines.forEach((l) => db.bank.push({ ...l, id: `b${db.bank.length + 1}`, accountId: batch.bank_account_id }));
      return lines.length;
    },
    async storeUpi(batch, lines) {
      db.batches.push({ source: batch.source, fileHash: batch.file_hash, key: batch.r2_key });
      lines.forEach((l) => db.upi.push({ ...l, id: `u${db.upi.length + 1}`, bank_line_id: null }));
      return lines.length;
    },
    async unlinkedUpi() { return db.upi.filter((u) => !u.bank_line_id && !u.ignored).map((u) => ({ id: u.id, upiRef: u.upi_ref, amountPaise: u.amount_paise, direction: u.direction })); },
    async bankLinesByRrn(rrns) { return db.bank.filter((l) => rrns.includes(l.upi_rrn)).map((l) => ({ id: l.id, upiRrn: l.upi_rrn, amountPaise: l.amount_paise, direction: l.direction })); },
    async link(links) { links.forEach((k) => { db.upi.find((u) => u.id === k.upiId).bank_line_id = k.bankId; }); return links.length; },
    async reconciliationData() {
      const linked = new Set(db.upi.map((u) => u.bank_line_id).filter(Boolean));
      return {
        upiLines: db.upi.map((u) => ({ paidAt: u.paid_at, amountPaise: u.amount_paise, bankLineId: u.bank_line_id })),
        bankLines: db.bank.filter((l) => l.upi_rrn).map((l) => ({ tranDate: l.tran_date, upiRrn: l.upi_rrn, linked: linked.has(l.id) })),
        lastBankDate: db.bank.map((l) => l.tran_date).sort().pop() ?? null,
        firstUpiDate: db.upi.map((u) => u.paid_at).sort()[0] ?? null,
      };
    },
    async audit() {},
    async heldBatchSpans() { return []; },
  };
}

const rows = [
  { date: '26/08/2026', ref: '600000000001', amount: '150.00', drcr: 'CR' }, // circle payment: no bank named
  { date: '15/08/2026', ref: '600000000002', amount: '2,875.00', drcr: 'DR', bank: 'AXIS BANK', acct: 'XXXX000099' },
  { date: '14/08/2026', ref: '600000000003', amount: '589.00', drcr: 'DR', bank: 'AXIS BANK', acct: 'XXXX000099', status: 'FAILURE' },
];
const bankFile = () => axisStatement({ from: '2026-08-01', to: '2026-08-31', openingPaise: 5000000, accountNumber: '900000000000099', txns: [
  { date: '2026-08-15', narration: 'UPI/P2A/600000000002/Test Payee/Test Bank/', dr: 287500 },
  { date: '2026-08-26', narration: 'UPI/P2A/600000000001/Test Shop/Test Bank/', dr: 15000 },
] });
const pdf = () => ({ name: 'history.pdf', bytes: bhimPdf({ rows }) });

test('a BHIM PDF is read, previewed without writing, then stored as a pdf with its app, and the failed payment is counted not stored', async () => {
  const s = fakeStore();
  const p = await runImport({ store: s, files: [pdf()], commit: false, actorId: 'a' });
  assert.equal(p.files[0].kind, 'bhim_upi');
  assert.equal(p.files[0].status, 'ok');
  assert.deepEqual([p.files[0].counts.new, p.files[0].unsuccessful.count], [2, 1]);
  assert.equal(s.db.upi.length, 0);
  const c = await runImport({ store: s, files: [pdf()], commit: true, actorId: 'a' });
  assert.equal(c.files[0].stored, true);
  assert.deepEqual(s.db.upi.map((u) => [u.app, u.is_circle, u.direction, u.bank_account_id]), [['bhim', true, 'debit', null], ['bhim', false, 'debit', 'acct']]);
  assert.match(s.db.batches[0].key, /^finance\/imports\/[0-9a-f-]{36}\.pdf$/);
  assert.equal(s.db.batches[0].source, 'bhim_upi');
});

test('the same history again is a duplicate; rows are joined to the bank statement whichever arrives last', async () => {
  const s = fakeStore();
  await runImport({ store: s, files: [pdf()], commit: true, actorId: 'a' });
  const again = await runImport({ store: s, files: [pdf()], commit: true, actorId: 'a' });
  assert.equal(again.files[0].status, 'duplicate_file');
  const bank = bankFile();
  const done = await runImport({ store: s, files: [{ name: 'bank.xlsx', bytes: bank.bytes }], commit: true, actorId: 'a' });
  assert.equal(done.reconciliation.linkedNow, 2);
  assert.ok(s.db.upi.every((u) => u.bank_line_id));
});

test('a PDF that is not a BHIM history is unreadable with a plain message; a history for an unregistered account is blocked', async () => {
  const s = fakeStore();
  const not = bhimPdf({ rows: [] });
  const plain = new Uint8Array(Buffer.from(Buffer.from(not).toString('latin1').replace('Payment ID/Reference Number', 'Something else'), 'latin1'));
  const r = await runImport({ store: s, files: [{ name: 'x.pdf', bytes: plain }], commit: false, actorId: 'a' });
  assert.equal(r.files[0].status, 'unreadable');
  assert.match(r.files[0].message, /BHIM/);
  const other = fakeStore([{ id: 'a2', label: 'Other', last4: '7777', upiLabel: null }]);
  const b = await runImport({ store: other, files: [pdf()], commit: false, actorId: 'a' });
  assert.equal(b.files[0].status, 'blocked');
  assert.equal(b.files[0].errors[0].type, 'account_not_registered');
});
