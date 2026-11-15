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
const D1 = '33333333-3333-4333-8333-333333333333';
const D2 = '44444444-4444-4444-8444-444444444444';
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
  if (table === 'fin_delegates' && method === 'POST') { const b = JSON.parse(init.body); db.order.push('delegate'); db.saved = b; return json([{ id: D1, ...b }], 201); }
  if (table === 'fin_delegates' && method === 'PATCH') { const b = JSON.parse(init.body); db.order.push('delegate'); db.saved = b; return json([{ id: D1, identifier: '5550100001', ...b }]); }
  if (table === 'fin_delegates') return json(db.delegates ?? [{ id: D1 }].filter(() => u.searchParams.has('id')));
  if (table === 'fin_upi_delegate_links') { db.order.push(`links:${method}`); db.links = init.body ? JSON.parse(init.body) : u.search; return new Response(null, { status: method === 'POST' ? 201 : 204 }); }
  if (table === 'fin_parties') return json([{ id: P1, name: 'Acme Pumps', active: true, merged_into: null }]);
  if (table === 'fin_payment_requests' && method === 'POST') { const b = JSON.parse(init.body); db.records.push(b); db.order.push('record'); return json([{ id: REQ, kind: b.kind, status: b.status }], 201); }
  if (table === 'fin_payment_requests' && method === 'GET') {
    let list = db.records.map((r) => ({ id: REQ, entity_id: 'ent', ...r }));
    for (const col of ['upi_line_id', 'bank_line_id']) { const v = u.searchParams.get(col); if (v?.startsWith('eq.')) list = list.filter((r) => r[col] === v.slice(3)); }
    const not = u.searchParams.get('id'); if (not?.startsWith('neq.')) list = list.filter((r) => r.id !== not.slice(4));
    if (not?.startsWith('eq.')) list = list.filter((r) => r.id === not.slice(3));
    return json(list);
  }
  if (table === 'fin_bank_lines') return json(db.bank ?? [{ id: 'bank-1', tran_date: '2026-11-08', amount_paise: 250000, direction: 'debit', narration: 'x', upi_rrn: null }]);
  if (table === 'fin_upi_lines') return json(db.upi ?? [{ id: 'upi-1', paid_at: '2026-11-08', amount_paise: 250000, direction: 'debit', bank_line_id: 'bank-1', app: 'paytm', counterparty: 'x', remarks: null, upi_ref: '1' }]);
  if (table === 'fin_payment_requests' && method === 'PATCH') { db.patched = JSON.parse(init.body); db.order.push('patch'); return new Response(null, { status: 204 }); }
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

const delegate = (id, from, to = null) => ({ id, identifier: '5550100001', display_name: null, active_from: from, active_to: to, cap_paise: null });
const log = { kind: 'log', partyId: P1, amountPaise: 12000, purpose: 'Onions', paidOn: '2026-11-01', paidVia: 'delegate', upiRef: '600000000001' };

test('a delegated log names the one delegate who was active that day', async () => {
  const email = sign([['finance-requests', 'user']]);
  db.delegates = [delegate(D1, '2026-07-04')];
  assert.equal((await send(email, 'POST', '/requests', log)).status, 201);
  assert.equal(db.records[0].delegate_id, D1);
});

test('with two delegates active the log names the one picked, and a stranger is refused', async () => {
  const email = sign([['finance-requests', 'user']]);
  db.delegates = [delegate(D1, '2026-07-04'), delegate(D2, '2026-10-01')];
  assert.equal((await send(email, 'POST', '/requests', log)).status, 201);
  assert.equal(db.records[0].delegate_id, null); // ambiguous: left open, not guessed
  assert.equal((await send(email, 'POST', '/requests', { ...log, upiRef: '600000000002', delegateId: D2 })).status, 201);
  assert.equal(db.records[1].delegate_id, D2);
  assert.equal((await send(email, 'POST', '/requests', { ...log, upiRef: '600000000003', delegateId: '55555555-5555-4555-8555-555555555555' })).status, 400);
  assert.equal(db.records.length, 2);
});

test('a direct payment never carries a delegate', async () => {
  const email = sign([['finance-requests', 'user']]);
  db.delegates = [delegate(D1, '2026-07-04')];
  assert.equal((await send(email, 'POST', '/requests', { ...log, paidVia: 'direct', delegateId: D1 })).status, 201);
  assert.equal(db.records[0].delegate_id, null);
});

test('adding a delegate needs an admin, is audited before it is written, and the audit never carries the number or name', async () => {
  const body = { identifier: '5550100001', displayName: 'Test Person', activeFrom: '2026-07-04' };
  assert.equal((await send(sign([['finance', 'user']]), 'POST', '/delegates', body)).status, 403);
  assert.equal(db.saved, undefined);
  const res = await send(sign([['finance', 'admin']]), 'POST', '/delegates', body);
  assert.equal(res.status, 201);
  assert.deepEqual(db.order, ['audit', 'delegate']);
  assert.equal(db.saved.identifier, '5550100001');
  assert.ok(!JSON.stringify(db.audit).includes('5550100001') && !JSON.stringify(db.audit).includes('Test Person'));
  assert.equal((await send(sign([['finance', 'admin']]), 'POST', '/delegates', { ...body, identifier: 'abc' })).status, 400);
  assert.equal(db.saved, undefined);
});

test('editing a delegate cannot change its number', async () => {
  const email = sign([['finance', 'admin']]);
  const res = await send(email, 'PATCH', `/delegates/${D1}`, { identifier: '5550100009', displayName: 'Test Person', activeFrom: '2026-07-04', activeTo: '2026-12-31' });
  assert.equal(res.status, 200);
  assert.equal(db.saved.identifier, undefined);
  assert.equal(db.saved.active_to, '2026-12-31');
});

test('picking a delegate for payments needs allocate, is audited first, and a null delegate takes the picks back', async () => {
  const refs = ['600000000001', '600000000002'];
  assert.equal((await send(sign([['finance', 'read_only']]), 'POST', '/delegates/assign', { delegateId: D1, upiRefs: refs })).status, 403);
  const email = sign([['finance', 'user']]);
  const res = await send(email, 'POST', '/delegates/assign', { delegateId: D1, upiRefs: refs });
  assert.equal(res.status, 200);
  assert.deepEqual(db.order, ['audit', 'links:POST']);
  assert.deepEqual(db.links.map((l) => [l.upi_ref, l.delegate_id]), [[refs[0], D1], [refs[1], D1]]);
  assert.equal(db.audit[0].detail.payments, 2);
  assert.equal((await send(sign([['finance', 'user']]), 'POST', '/delegates/assign', { delegateId: D1, upiRefs: ['12'] })).status, 400);
  assert.equal((await send(sign([['finance', 'user']]), 'POST', '/delegates/assign', { delegateId: 'nope', upiRefs: refs })).status, 400);
  const back = await send(sign([['finance', 'user']]), 'POST', '/delegates/assign', { delegateId: null, upiRefs: refs });
  assert.equal(back.status, 200);
  assert.ok(db.order.includes('links:DELETE'));
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
  assert.deepEqual(byId[ID2].linked, { upi: true, bank: true, upiRef: '600000000001', bankLineId: 'bank-2' }, 'where it is tied, so the page can link to each place');
  assert.deepEqual(byId[REQ].linked, { upi: false, bank: true, upiRef: null, bankLineId: 'bank-1' });
});

// ---- automatic matching: a record with one candidate payment that no other record wants is matched without asking
const UNIQUE = { id: REQ, kind: 'request', status: 'approved', source: 'app', requester_id: 'u9', party_id: P1, amount_paise: 250000, mode: 'upi', purpose: 'Pump repair', decided_at: '2026-11-08T05:00:00Z', created_at: '2026-11-08T04:00:00Z' };
const ONE_UPI = [{ id: 'upi-1', paid_at: '2026-11-08', amount_paise: 250000, direction: 'debit', bank_line_id: 'bank-1', app: 'paytm', counterparty: 'Acme Pumps', remarks: null, upi_ref: '600000000009' }];

test('auto-match: one candidate payment nobody else wants is matched with no person on it, audited first, and the request becomes paid', async () => {
  const email = sign([['finance', 'user']]);
  db.upi = ONE_UPI;
  db.records.push({ ...UNIQUE });
  const before = await (await send(email, 'GET', '/requests')).json();
  assert.equal(before.autoPending, 1, 'the list says one could be matched, and wrote nothing');
  assert.equal(db.patched, null);
  const res = await send(email, 'POST', '/requests/auto-match', {});
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, matched: 1, skipped: 0 });
  assert.equal(db.patched.upi_line_id, 'upi-1');
  assert.equal(db.patched.matched_by, null, 'an automatic match carries no person: that is how the page tells it from a manual one');
  assert.equal(db.patched.status, 'paid');
  assert.ok(db.audit.some((a) => a.action === 'finance.request_auto_matched'), 'its own audit action');
  assert.ok(db.order.indexOf('audit') >= 0 && db.order.indexOf('audit') < db.order.indexOf('patch'), 'the audit entry is written before the record is changed');
});

test('auto-match: two records that want the same payment are both left as suggestions', async () => {
  const email = sign([['finance', 'user']]);
  db.upi = ONE_UPI;
  db.records.push({ ...UNIQUE });
  db.records.push({ ...UNIQUE, id: '55555555-5555-4555-8555-555555555555' });
  assert.equal((await (await send(email, 'GET', '/requests')).json()).autoPending, 0);
  const res = await send(email, 'POST', '/requests/auto-match', {});
  assert.deepEqual(await res.json(), { ok: true, matched: 0, skipped: 0 });
  assert.equal(db.patched, null, 'nothing written');
});

test('auto-match: a record with two candidate payments is left for a person', async () => {
  const email = sign([['finance', 'user']]);
  db.upi = [...ONE_UPI, { ...ONE_UPI[0], id: 'upi-2', bank_line_id: null, upi_ref: '600000000010' }];
  db.bank = [{ id: 'bank-1', tran_date: '2026-11-08', amount_paise: 250000, direction: 'debit', narration: 'x', upi_rrn: null }];
  db.records.push({ ...UNIQUE });
  assert.equal((await (await send(email, 'GET', '/requests')).json()).autoPending, 0);
  assert.equal((await (await send(email, 'POST', '/requests/auto-match', {})).json()).matched, 0);
  assert.equal(db.patched, null);
});

test('unmatching by hand keeps the person on the record, and that record is never matched automatically again', async () => {
  const email = sign([['finance', 'user']]);
  db.upi = ONE_UPI;
  db.records.push({ ...UNIQUE, status: 'paid', upi_line_id: 'upi-1', bank_line_id: 'bank-1', matched_by: null, matched_at: '2026-11-08T06:00:00Z' });
  const res = await send(email, 'POST', `/requests/${REQ}/unmatch`, {});
  assert.equal(res.status, 200);
  assert.equal(db.patched.upi_line_id, null);
  assert.equal(db.patched.status, 'approved');
  assert.equal(db.patched.matched_by, 'u1', 'who unmatched it stays on the record');
  // the same record now: no link, a person on it, and a perfect candidate: still not matched automatically
  db.records.length = 0;
  db.records.push({ ...UNIQUE, matched_by: 'u1', matched_at: '2026-11-08T07:00:00Z' });
  db.patched = null;
  assert.equal((await (await send(email, 'GET', '/requests')).json()).autoPending, 0);
  assert.equal((await (await send(email, 'POST', '/requests/auto-match', {})).json()).matched, 0);
  assert.equal(db.patched, null);
  // it is still offered as a suggestion, and a person can match it by hand
  const list = (await (await send(email, 'GET', '/requests')).json()).records;
  assert.equal(list[0].proposals.length, 1);
});

test('auto-match needs allocate: a read-only viewer sees no pending count and is refused', async () => {
  const email = sign([['finance', 'read_only']]);
  db.upi = ONE_UPI;
  db.records.push({ ...UNIQUE });
  assert.equal((await (await send(email, 'GET', '/requests')).json()).autoPending, 0);
  assert.equal((await send(email, 'POST', '/requests/auto-match', {})).status, 403);
  assert.equal(db.patched, null);
});

test('the list tells an automatic match from one a person made', async () => {
  const email = sign([['finance', 'user']]);
  db.upi = ONE_UPI;
  db.records.push({ ...UNIQUE, status: 'paid', upi_line_id: 'upi-1', bank_line_id: 'bank-1', matched_by: null });
  assert.equal((await (await send(email, 'GET', '/requests')).json()).records[0].matched, 'auto');
  db.records[0].matched_by = 'u1';
  assert.equal((await (await send(email, 'GET', '/requests')).json()).records[0].matched, 'accepted');
});
