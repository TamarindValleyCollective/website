// Run with: node --test scripts/lib/finance-upi-operator-import.test.mjs
//
// Whose UPI a UPI file is: the import asks for every UPI file once there are operators, suggests one from what the file looks like, refuses to store
// a file with no operator chosen (the other files still go in), stores the choice on every row and remembers the file's signature for that operator.
// A database without operators imports exactly as before. Needs Node 22.18+ (it imports the .ts orchestrator directly). Invented data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runImport } from '../../netlify/functions/lib/finance-import.ts';
import { paytmExport } from './finance-fixtures.mjs';
import { signatureOf } from './finance-upi-operators.mjs';

function store({ operators = [{ id: 'op1', name: 'Test operator one', signatures: [] }, { id: 'op2', name: 'Test operator two', signatures: [] }], withOperators = true } = {}) {
  const db = { upi: [], batches: [], raw: new Map(), remembered: [] };
  const s = {
    db,
    async entity() { return { id: 'ent', circleTag: 'Pocket Money' }; },
    async accounts() { return [{ id: 'acct', label: 'Test current', last4: '1234', upiLabel: 'Axis Bank - 99' }]; },
    async heldBank() { return { batches: [], lines: [] }; },
    async heldHashes(h) { return db.batches.filter((b) => h.includes(b.fileHash)).map((b) => b.fileHash); },
    async heldUpiRefs(r) { return db.upi.filter((u) => r.includes(u.upi_ref)).map((u) => u.upi_ref); },
    async putRaw(k, b) { db.raw.set(k, b); },
    async deleteRaw(k) { db.raw.delete(k); },
    async storeBank() { return 0; },
    async storeUpi(batch, lines) { db.batches.push({ fileHash: batch.file_hash, operatorId: batch.operator_id }); lines.forEach((l) => db.upi.push({ ...l, operator_id: batch.operator_id })); return lines.length; },
    async unlinkedUpi() { return []; },
    async bankLinesByRrn() { return []; },
    async link() { return 0; },
    async reconciliationData() { return { upiLines: [], bankLines: [], lastBankDate: null, firstUpiDate: null }; },
    async audit() {},
    async heldBatchSpans() { return []; },
  };
  if (withOperators) {
    s.operators = async () => operators;
    s.rememberSignature = async (id, sig) => { db.remembered.push([id, sig]); };
  }
  return s;
}
const file = (ref, accounts) => paytmExport({ rows: [{ date: '2022-07-01', amount: -120000, ref, tag: '#💰 Pocket Money' }], accounts });
const up = (name, bytes) => ({ name, bytes });

test('the preview asks whose UPI a UPI file is and lists the operators to choose from', async () => {
  const s = store();
  const r = await runImport({ store: s, files: [up('a.xlsx', file('400000000001', ['Axis Bank - 99']))], commit: false, actorId: 'a' });
  assert.deepEqual(r.operators, [{ id: 'op1', name: 'Test operator one' }, { id: 'op2', name: 'Test operator two' }]);
  assert.deepEqual(r.files[0].operator, { needed: true, suggestedId: null, reason: null, chosenId: null }, 'two operators and nothing to tell the file by: just ask');
  assert.equal(s.db.upi.length, 0, 'a preview writes nothing');
});

test('a file that looks like one an operator has had before is suggested to them', async () => {
  const bytes = file('400000000001', ['Axis Bank - 99']);
  const sig = signatureOf('paytm_upi', { accounts: ['Axis Bank - 99'] });
  const s = store({ operators: [{ id: 'op1', name: 'One', signatures: [] }, { id: 'op2', name: 'Two', signatures: [sig] }] });
  const r = await runImport({ store: s, files: [up('a.xlsx', bytes)], commit: false, actorId: 'a' });
  assert.deepEqual(r.files[0].operator, { needed: true, suggestedId: 'op2', reason: 'same_file_layout', chosenId: null });
});

test('with one operator only, that operator is suggested', async () => {
  const s = store({ operators: [{ id: 'op1', name: 'One', signatures: [] }] });
  const r = await runImport({ store: s, files: [up('a.xlsx', file('400000000001', ['Axis Bank - 99']))], commit: false, actorId: 'a' });
  assert.equal(r.files[0].operator.suggestedId, 'op1');
  assert.equal(r.files[0].operator.reason, 'only_operator');
});

test('a commit with the choice stores it on every row, and remembers what the file looked like for that operator', async () => {
  const s = store();
  const r = await runImport({ store: s, files: [up('a.xlsx', file('400000000001', ['Axis Bank - 99']))], commit: true, actorId: 'a', operatorChoices: { 0: 'op2' } });
  assert.equal(r.files[0].status, 'ok');
  assert.equal(r.files[0].stored, true);
  assert.deepEqual(s.db.upi.map((u) => u.operator_id), ['op2']);
  assert.deepEqual(s.db.batches.map((b) => b.operatorId), ['op2']);
  assert.deepEqual(s.db.remembered, [['op2', signatureOf('paytm_upi', { accounts: ['Axis Bank - 99'] })]]);
});

test('a commit with no operator chosen, or a choice that is not an operator, stores nothing of that file and says why', async () => {
  const s = store();
  const none = await runImport({ store: s, files: [up('a.xlsx', file('400000000001', ['Axis Bank - 99']))], commit: true, actorId: 'a' });
  assert.equal(none.files[0].status, 'blocked');
  assert.match(none.files[0].message, /whose UPI/);
  assert.equal(none.files[0].stored, undefined);
  const bad = await runImport({ store: s, files: [up('b.xlsx', file('400000000002', ['Axis Bank - 99']))], commit: true, actorId: 'a', operatorChoices: { 0: 'nobody' } });
  assert.equal(bad.files[0].status, 'blocked');
  assert.equal(s.db.upi.length + s.db.batches.length + s.db.raw.size, 0);
});

test('each file has its own operator, and a file with none chosen does not stop the other', async () => {
  const s = store();
  const r = await runImport({
    store: s, commit: true, actorId: 'a',
    files: [up('a.xlsx', file('400000000001', ['Axis Bank - 99'])), up('b.xlsx', file('400000000002', ['Axis Bank - 99', 'Other Bank - 7'])), up('c.xlsx', file('400000000003', ['Axis Bank - 99', 'Third - 3']))],
    operatorChoices: { 0: 'op1', 2: 'op2' },
  });
  assert.deepEqual(r.files.map((f) => f.status), ['ok', 'blocked', 'ok']);
  assert.deepEqual(s.db.upi.map((u) => [u.upi_ref, u.operator_id]).sort(), [['400000000001', 'op1'], ['400000000003', 'op2']]);
});

test('a database without operators yet imports as before: nothing is asked and no operator is stored', async () => {
  const s = store({ withOperators: false });
  const p = await runImport({ store: s, files: [up('a.xlsx', file('400000000001', ['Axis Bank - 99']))], commit: false, actorId: 'a' });
  assert.equal(p.files[0].operator, undefined);
  assert.deepEqual(p.operators, []);
  const r = await runImport({ store: s, files: [up('a.xlsx', file('400000000001', ['Axis Bank - 99']))], commit: true, actorId: 'a' });
  assert.equal(r.files[0].status, 'ok');
  assert.equal(s.db.upi[0].operator_id, undefined);
});
