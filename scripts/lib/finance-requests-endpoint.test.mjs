// Run with: node --test scripts/lib/finance-requests-endpoint.test.mjs
//
// The payment-request routes through the real finance-admin Function and requireStaff, with Google and Supabase stubbed: that the
// farm manager's module (`finance-requests`) can raise and log but opens nothing in the ledger, that the audit entry comes before
// the record, that whoever raised a request cannot reject it, that approving needs the MFA step-up, and that a bill must be a real
// image or PDF. Needs `npm ci` (esbuild). Invented data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const stub = (filter, contents) => ({
  name: `stub-${filter}`,
  setup(b) {
    const ns = `stub-${String(filter).replace(/\W/g, '')}`;
    b.onResolve({ filter }, () => ({ path: ns, namespace: ns }));
    b.onLoad({ filter: /.*/, namespace: ns }, () => ({ contents, loader: 'js' }));
  },
});
const dir = mkdtempSync(join(tmpdir(), 'finance-requests-endpoint-'));
const out = join(dir, 'finance-admin.mjs');
await build({
  entryPoints: ['netlify/functions/finance-admin.mts'], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'silent',
  plugins: [
    stub(/google-id-token\.mjs$/, 'export async function verifyGoogleIdToken(t){ return { email: t, hd: t.split("@")[1] }; }'),
    stub(/finance-storage$/, 'export async function putFinanceImport(){} export async function deleteFinanceImport(){} export async function putFinanceVoucher(k){ globalThis.__r2.push(k); } export async function getFinanceVoucher(){ return null; } export async function deleteFinanceVoucher(){}'),
  ],
});
globalThis.__r2 = [];
process.env.SUPABASE_URL = 'https://db.test';
process.env.PUBLIC_GOOGLE_CLIENT_ID = 'client';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
const { default: handler } = await import(pathToFileURL(out).href);

const P1 = '11111111-1111-4111-8111-111111111111';
const REQ = '22222222-2222-4222-8222-222222222222';
let db, calls;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const table = u.pathname.replace('/rest/v1/', '');
  const method = init.method ?? 'GET';
  calls.push(`${method} ${table}`);
  if (table === 'staff_users') return json(db.users.filter((x) => u.searchParams.get('email') === `eq.${x.email}`));
  if (table === 'staff_module_roles') return json(db.roles.filter((r) => r.staff_id === u.searchParams.get('staff_id')?.slice(3) && r.module === u.searchParams.get('module')?.slice(3)));
  if (table === 'fin_audit_log') { db.audit.push(JSON.parse(init.body)); db.order.push('audit'); return new Response(null, { status: 201 }); }
  if (table === 'fin_entities') return json([{ id: 'ent', requester_party_id: null }]);
  if (table === 'fin_parties') return json([{ id: P1, name: 'Acme Pumps', active: true, merged_into: null }]);
  if (table === 'fin_payment_requests' && method === 'POST') { const b = JSON.parse(init.body); db.records.push(b); db.order.push('record'); return json([{ id: REQ, kind: b.kind, status: b.status }], 201); }
  if (table === 'fin_payment_requests' && method === 'GET') {
    let list = db.records.map((r) => ({ id: REQ, entity_id: 'ent', ...r }));
    for (const col of ['upi_line_id', 'bank_line_id']) { const v = u.searchParams.get(col); if (v?.startsWith('eq.')) list = list.filter((r) => r[col] === v.slice(3)); }
    const not = u.searchParams.get('id'); if (not?.startsWith('neq.')) list = list.filter((r) => r.id !== not.slice(4));
    return json(list);
  }
  if (table === 'fin_bank_lines') return json(db.bank ?? [{ id: 'bank-1', tran_date: '2026-11-08', amount_paise: 250000, direction: 'debit', narration: 'x', upi_rrn: null }]);
  if (table === 'fin_upi_lines') return json(db.upi ?? [{ id: 'upi-1', paid_at: '2026-11-08', amount_paise: 250000, direction: 'debit', bank_line_id: 'bank-1', app: 'paytm', counterparty: 'x', remarks: null, upi_ref: '1' }]);
  if (table === 'fin_payment_requests' && method === 'PATCH') { db.patched = JSON.parse(init.body); return new Response(null, { status: 204 }); }
  if (table === 'fin_vouchers') return method === 'POST' ? new Response(null, { status: 201 }) : json([]);
  throw new Error(`unexpected fetch ${method} ${url}`);
};

let n = 0;
const sign = (roles) => {
  const email = `p${++n}@gmail.com`;
  db = { users: [{ id: 'u1', email, name: 'A', active: true, is_super_admin: false }], roles: roles.map(([module, role]) => ({ staff_id: 'u1', module, role, scope: null, expires_at: null })), audit: [], records: [], order: [], patched: null };
  calls = [];
  return email;
};
const send = (email, method, path, body, headers = {}) => handler(new Request(`https://x.test/api/finance-admin${path}`, { method, headers: { authorization: `Bearer ${email}`, ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...headers }, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined }));
const request = { kind: 'request', partyId: P1, amountPaise: 250000, mode: 'neft', purpose: 'Pump repair' };

test('the farm manager (finance-requests) can raise a request; the audit entry comes before the record', async () => {
  const email = sign([['finance-requests', 'user']]);
  const res = await send(email, 'POST', '/requests', request);
  assert.equal(res.status, 201);
  assert.deepEqual(db.order, ['audit', 'record']);
  assert.equal(db.records[0].status, 'submitted');
  assert.equal(db.records[0].requester_id, 'u1');
  assert.ok(!JSON.stringify(db.audit).includes('Pump'), 'the audit entry carries no purpose text');
});

test('a log is stored as already paid, with the delegate and reference', async () => {
  const email = sign([['finance-requests', 'user']]);
  const res = await send(email, 'POST', '/requests', { kind: 'log', partyId: P1, amountPaise: 12000, purpose: 'Onions', paidOn: '2026-11-01', paidVia: 'delegate', upiRef: '600000000001' });
  assert.equal(res.status, 201);
  assert.equal(db.records[0].status, 'paid');
  assert.equal(db.records[0].paid_via, 'delegate');
  assert.equal(db.records[0].mode, 'upi');
});

test('nothing is written for a bad request, or for someone with no grant', async () => {
  const email = sign([['finance-requests', 'user']]);
  assert.equal((await send(email, 'POST', '/requests', { ...request, amountPaise: 0 })).status, 400);
  assert.equal(db.records.length, 0);
  const nobody = sign([]);
  assert.equal((await send(nobody, 'POST', '/requests', request)).status, 403);
  assert.equal(db.records.length, 0);
});

test('holding finance-requests opens nothing in finance: not the list, not the ledger, not matching', async () => {
  const email = sign([['finance-requests', 'user']]);
  assert.equal((await send(email, 'GET', '/requests')).status, 403);
  assert.equal((await send(email, 'GET', '/ledger/all')).status, 403);
  assert.equal((await send(email, 'POST', `/requests/${REQ}/match`, { type: 'bank', targetId: P1 })).status, 403);
  assert.equal((await send(email, 'POST', `/requests/${REQ}/decide`, { action: 'approve' })).status, 403);
});

test('approving needs the MFA step-up', async () => {
  const email = sign([['finance', 'admin']]);
  db.records.push({ kind: 'request', status: 'submitted', requester_id: 'someone-else', amount_paise: 1000, reimbursement: false });
  const res = await send(email, 'POST', `/requests/${REQ}/decide`, { action: 'approve' });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, 'STEP_UP_REQUIRED');
  assert.equal(db.patched, null);
});

test('whoever raised a request cannot reject it', async () => {
  const email = sign([['finance', 'admin']]);
  db.records.push({ kind: 'request', status: 'submitted', requester_id: 'u1', amount_paise: 1000, reimbursement: false });
  const res = await send(email, 'POST', `/requests/${REQ}/decide`, { action: 'reject', reason: 'Not needed' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Someone else/);
  assert.equal(db.patched, null);
  assert.equal(db.audit.length, 0);
});

test('someone else can reject it, with a reason', async () => {
  const email = sign([['finance', 'admin']]);
  db.records.push({ kind: 'request', status: 'submitted', requester_id: 'other', amount_paise: 1000, reimbursement: false });
  const res = await send(email, 'POST', `/requests/${REQ}/decide`, { action: 'reject', reason: 'Duplicate of an earlier one' });
  assert.equal(res.status, 200);
  assert.equal(db.patched.status, 'rejected');
  assert.equal(db.audit[0].action, 'finance.request_rejected');
});

test('a bill must be a real photo or PDF, whatever its name says', async () => {
  const email = sign([['finance-requests', 'user']]);
  db.records.push({ kind: 'request', status: 'submitted', requester_id: 'u1', amount_paise: 1000 });
  const bad = new FormData();
  bad.set('file', new File(['<html>not an image</html>'], 'bill.jpg', { type: 'image/jpeg' }));
  assert.equal((await send(email, 'POST', `/requests/${REQ}/vouchers`, bad)).status, 400);
  assert.equal(globalThis.__r2.length, 0);
  const good = new FormData();
  good.set('file', new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], 'bill.jpg', { type: 'image/jpeg' }));
  assert.equal((await send(email, 'POST', `/requests/${REQ}/vouchers`, good)).status, 201);
  assert.match(globalThis.__r2[0], /^finance\/vouchers\/[0-9a-f-]{36}\.jpg$/);
});

test("a requester cannot attach a file to someone else's request", async () => {
  const email = sign([['finance-requests', 'user']]);
  db.records.push({ kind: 'request', status: 'submitted', requester_id: 'other', amount_paise: 1000 });
  const form = new FormData();
  form.set('file', new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], 'bill.jpg'));
  assert.equal((await send(email, 'POST', `/requests/${REQ}/vouchers`, form)).status, 403);
});

test('a payment is one payment: matching a bank line is refused when its UPI row already belongs to another record', async () => {
  const email = sign([['finance', 'user']]);
  db.records.push({ kind: 'request', status: 'approved', requester_id: 'other', amount_paise: 250000, party_id: P1 });
  db.records.push({ id: '33333333-3333-4333-8333-333333333333', kind: 'log', status: 'paid', requester_id: 'other', amount_paise: 250000, upi_line_id: 'upi-1' });
  const res = await send(email, 'POST', `/requests/${REQ}/match`, { type: 'bank', targetId: P1 });
  assert.equal(res.status, 409);
  assert.equal(db.patched, null);
});

test('the list says how a matched request was actually paid: from the bank narration, or the UPI app', async () => {
  const email = sign([['finance', 'user']]);
  const ID2 = '44444444-4444-4444-8444-444444444444';
  db.bank = [{ id: 'bank-1', tran_date: '2026-11-08', amount_paise: 250000, direction: 'debit', narration: 'INB/NEFT/123/ACME PUMPS', upi_rrn: null }, { id: 'bank-2', tran_date: '2026-11-09', amount_paise: 12000, direction: 'debit', narration: 'UPI/P2A/600000000001/SHOP', upi_rrn: '600000000001' }];
  db.upi = [{ id: 'upi-2', paid_at: '2026-11-09', amount_paise: 12000, direction: 'debit', bank_line_id: 'bank-2', app: 'paytm', counterparty: 'Shop', remarks: null, upi_ref: '600000000001' }];
  db.records.push({ id: REQ, kind: 'request', status: 'paid', source: 'app', requester_id: 'u9', party_id: P1, amount_paise: 250000, mode: 'upi', purpose: 'Pump repair', bank_line_id: 'bank-1', created_at: '2026-11-01T00:00:00Z' });
  db.records.push({ id: ID2, kind: 'log', status: 'paid', source: 'app', requester_id: 'u9', recipient_text: 'Shop', amount_paise: 12000, mode: 'upi', purpose: 'Onions', paid_on: '2026-11-09', upi_ref: '600000000001', created_at: '2026-11-09T00:00:00Z' });
  const res = await send(email, 'GET', '/requests');
  assert.equal(res.status, 200);
  const list = (await res.json()).records;
  const byId = Object.fromEntries(list.map((r) => [r.id, r]));
  assert.deepEqual(byId[REQ].fulfilled, { method: 'neft', label: 'NEFT' }, 'a bank line alone: read from "INB/NEFT/..."');
  assert.equal(byId[REQ].mode, 'upi', 'what was asked stays what was asked');
  assert.deepEqual(byId[ID2].fulfilled, { method: 'upi', label: 'UPI, Paytm' }, 'matched by reference: the UPI row names its app');
  assert.deepEqual(byId[ID2].linked, { upi: true, bank: true });
});
