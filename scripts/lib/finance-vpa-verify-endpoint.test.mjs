// Run with: node --test scripts/lib/finance-vpa-verify-endpoint.test.mjs
//
// Drives the real finance-admin Function: verifying a party's UPI details with the Razorpay lookup (method `razorpay_vpa`). The registered name
// is Razorpay's answer and nothing the page sends, it is asked once and kept, it is for a UPI ID only, the person who added the details still
// cannot verify them, and the audit row names the method but no UPI ID or name. Every UPI ID, name and key here is invented.
// Needs `npm ci` (esbuild) and Node 22.18+.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { auditDetailIsSafe } from './finance-parties.mjs';

process.env.SUPABASE_URL = 'https://db.test';
process.env.PUBLIC_GOOGLE_CLIENT_ID = 'client';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
process.env.STAFF_MFA_KEY = randomBytes(32).toString('base64');
process.env.RAZORPAY_KEY_SECRET = 'secret';
const { signStepUp } = await import('../../netlify/functions/lib/staff-mfa-crypto.ts');

const stubGoogle = {
  name: 'stub-google',
  setup(b) {
    b.onResolve({ filter: /google-id-token\.mjs$/ }, () => ({ path: 'stub-google', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export async function verifyGoogleIdToken(t){ return { email: t, hd: t.split("@")[1] }; }', loader: 'js' }));
  },
};
const stubStorage = {
  name: 'stub-storage',
  setup(b) {
    b.onResolve({ filter: /finance-storage$/ }, () => ({ path: 'stub-storage', namespace: 'stub-r2' }));
    b.onLoad({ filter: /.*/, namespace: 'stub-r2' }, () => ({ contents: 'export async function putFinanceVoucher(){} export async function getFinanceVoucher(){ return null; } export async function deleteFinanceVoucher(){} export async function putFinanceImport(){} export async function deleteFinanceImport(){}', loader: 'js' }));
  },
};
const dir = mkdtempSync(join(tmpdir(), 'finance-vpa-verify-'));
const out = join(dir, 'finance-admin.mjs');
await build({ entryPoints: ['netlify/functions/finance-admin.mts'], bundle: true, platform: 'node', format: 'esm', outfile: out, plugins: [stubGoogle, stubStorage], logLevel: 'silent' });
const { default: handler } = await import(pathToFileURL(out).href);

const ACCOUNT = '100000000001';
const IFSC = 'ABCD0123456';
const VPA = 'q000111222@ybl';

let db;
let razorpay;
let n = 0;
const matches = (row, params) => {
  for (const [k, v] of params) {
    if (['select', 'order', 'limit'].includes(k)) continue;
    const [op, ...rest] = v.split('.');
    const val = rest.join('.');
    if (op === 'eq' && String(row[k]) !== val) return false;
    if (op === 'neq' && String(row[k]) === val) return false;
    if (op === 'in' && !val.replace(/^\(|\)$/g, '').split(',').includes(String(row[k]))) return false;
    if (op === 'ilike' && !String(row[k]).toLowerCase().includes(val.replaceAll('*', '').toLowerCase())) return false;
  }
  return true;
};
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  if (u.hostname === 'api.razorpay.com') {
    const asked = JSON.parse(init.body).vpa;
    razorpay.asked.push(asked);
    const answer = razorpay.answers[asked] ?? { vpa: asked, success: false };
    return answer.__status ? json({ error: { description: answer.description } }, answer.__status) : json(answer);
  }
  const table = u.pathname.replace('/rest/v1/', '');
  const method = init.method ?? 'GET';
  if (table === 'staff_users') {
    const ids = u.searchParams.get('id');
    if (ids?.startsWith('in.')) return json(db.users.filter((x) => ids.slice(4, -1).split(',').includes(x.id)).map((x) => ({ id: x.id, name: x.name })));
    return json(db.users.filter((x) => u.searchParams.get('email') === `eq.${x.email}`));
  }
  if (table === 'staff_module_roles') {
    const id = u.searchParams.get('staff_id')?.slice(3);
    const mod = u.searchParams.get('module')?.slice(3);
    return json(db.roles.filter((r) => r.staff_id === id && r.module === mod).map(({ role, scope, expires_at }) => ({ role, scope, expires_at })));
  }
  if (table === 'staff_mfa_factors' || table === 'staff_recovery_codes') return json([]);
  if (table === 'fin_audit_log' && method === 'POST') {
    db.audit.push(JSON.parse(init.body));
    return new Response(null, { status: 201 });
  }
  if (table === 'fin_entities') return json([{ id: 'e1', name: 'Test Entity' }]);
  if (table === 'member_households') return json([{ id: 'h1' }]);
  if (table === 'fin_vpa_names') {
    if (method === 'POST') {
      const body = JSON.parse(init.body);
      db.fin_vpa_names = db.fin_vpa_names.filter((r) => r.vpa !== body.vpa);
      db.fin_vpa_names.push(body);
      return new Response(null, { status: 201 });
    }
    return json(db.fin_vpa_names.filter((r) => matches(r, u.searchParams)));
  }
  if (table === 'fin_parties' || table === 'fin_party_accounts' || table === 'fin_party_account_files') {
    const rows = db[table];
    if (method === 'GET') return json(rows.filter((r) => matches(r, u.searchParams)));
    if (method === 'POST') {
      const row = { id: `${table === 'fin_parties' ? 'p' : 'a'}${++n}`, created_at: new Date().toISOString(), status: table === 'fin_party_accounts' ? 'unverified' : undefined, active: table === 'fin_parties' ? true : undefined, ...JSON.parse(init.body) };
      rows.push(row);
      return json([row], 201);
    }
    if (method === 'PATCH') {
      const hit = rows.filter((r) => matches(r, u.searchParams));
      for (const r of hit) Object.assign(r, JSON.parse(init.body));
      return json(hit);
    }
  }
  if (table.startsWith('fin_')) return json([], 200, { 'content-range': '0-0/0' });
  throw new Error(`unexpected fetch ${method} ${url}`);
};

const reset = (keyId = 'rzp_live_test') => {
  process.env.RAZORPAY_KEY_ID = keyId;
  razorpay = { asked: [], answers: {} };
  db = { users: [], roles: [], fin_parties: [], fin_party_accounts: [], fin_party_account_files: [], fin_vpa_names: [], audit: [] };
};
const sign = (id, role) => {
  const email = `${id}-${++n}@gmail.com`;
  db.users.push({ id, email, name: id, active: true, is_super_admin: false });
  db.roles.push({ staff_id: id, module: 'finance', role, scope: null, expires_at: null });
  return email;
};
const api = (email, path, { method = 'GET', body, stepUp = false } = {}) =>
  handler(new Request(`https://x.test/api/finance-admin${path}`, { method, headers: { authorization: `Bearer ${email}`, ...(body ? { 'content-type': 'application/json' } : {}), ...(stepUp ? { 'x-stepup-token': signStepUp(stepUp, 'totp', Date.now()) } : {}) }, body: body ? JSON.stringify(body) : undefined }));
// Someone adds a party with the UPI ID (as the ledger does on accepting a looked-up name); a second admin then verifies it.
const addUpiParty = async () => {
  const maker = sign('u1', 'admin');
  const made = await api(maker, '/parties', { method: 'POST', body: { name: 'Test Vendor Works', kind: 'vendor', payee: { method: 'upi', upi: VPA } } });
  assert.equal(made.status, 201);
  return { maker, checker: sign('u2', 'admin'), accountId: db.fin_party_accounts[0].id };
};
const verify = (email, accountId, body = { method: 'razorpay_vpa' }) => api(email, `/accounts/${accountId}/verify`, { method: 'POST', body, stepUp: email.startsWith('u1') ? 'u1' : 'u2' });

test('a second admin verifies a UPI ID with the Razorpay lookup, and the name recorded is Razorpay’s', async () => {
  reset();
  razorpay.answers[VPA] = { vpa: VPA, success: true, customer_name: 'TEST VENDOR WORKS' };
  const { checker, accountId } = await addUpiParty();
  const res = await verify(checker, accountId, { method: 'razorpay_vpa', name: 'Typed By The Page' });
  assert.equal(res.status, 200);
  const acct = db.fin_party_accounts[0];
  assert.equal(acct.status, 'verified');
  assert.equal(acct.verified_by, 'u2');
  assert.equal(acct.verification_method, 'razorpay_vpa');
  assert.equal(acct.verified_name, 'TEST VENDOR WORKS', 'the name comes from Razorpay, not from the request');
  assert.deepEqual(razorpay.asked, [VPA]);
});

test('whoever added the UPI details still cannot verify them', async () => {
  reset();
  razorpay.answers[VPA] = { vpa: VPA, success: true, customer_name: 'TEST VENDOR WORKS' };
  const { maker, accountId } = await addUpiParty();
  assert.equal((await verify(maker, accountId)).status, 403);
  assert.equal(db.fin_party_accounts[0].status, 'unverified');
});

test('an answer already kept is used, and Razorpay is not asked again', async () => {
  reset();
  db.fin_vpa_names.push({ vpa: VPA, success: true, name: 'KEPT NAME', key_mode: 'live' });
  const { checker, accountId } = await addUpiParty();
  assert.equal((await verify(checker, accountId)).status, 200);
  assert.deepEqual(razorpay.asked, []);
  assert.equal(db.fin_party_accounts[0].verified_name, 'KEPT NAME');
});

test('an ID with no registered name cannot be verified this way, and nothing changes', async () => {
  reset();
  razorpay.answers[VPA] = { vpa: VPA, success: true, customer_name: '' };
  const { checker, accountId } = await addUpiParty();
  const res = await verify(checker, accountId);
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /no registered name/i);
  assert.equal(db.fin_party_accounts[0].status, 'unverified');
});

test('a failed Razorpay call is reported in words and leaves the details unverified', async () => {
  reset();
  razorpay.answers[VPA] = { __status: 400, description: 'The requested URL was not found on the server.' };
  const { checker, accountId } = await addUpiParty();
  const res = await verify(checker, accountId);
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /not available on this account/i);
  assert.equal(db.fin_party_accounts[0].status, 'unverified');
  assert.equal(db.fin_vpa_names.length, 0);
});

test('test keys are not trusted to verify anyone', async () => {
  reset('rzp_test_abc');
  razorpay.answers[VPA] = { vpa: VPA, success: true, customer_name: 'TEST VENDOR WORKS' };
  const { checker, accountId } = await addUpiParty();
  const res = await verify(checker, accountId);
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /live keys/i);
  assert.deepEqual(razorpay.asked, [], 'no call is made with test keys');
});

test('the lookup is for a UPI ID only: bank details refuse it', async () => {
  reset();
  const maker = sign('u1', 'admin');
  await api(maker, '/parties', { method: 'POST', body: { name: 'Test Traders', kind: 'vendor', payee: { method: 'bank', account: ACCOUNT, ifsc: IFSC } } });
  const res = await verify(sign('u2', 'admin'), db.fin_party_accounts[0].id);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /UPI/);
  assert.deepEqual(razorpay.asked, []);
});

test('the audit row names the method and carries no UPI ID or name', async () => {
  reset();
  razorpay.answers[VPA] = { vpa: VPA, success: true, customer_name: 'TEST VENDOR WORKS' };
  const { checker, accountId } = await addUpiParty();
  await verify(checker, accountId);
  const entry = db.audit.find((a) => a.action === 'finance.payee_verified');
  assert.equal(entry.detail.method, 'razorpay_vpa');
  assert.ok(auditDetailIsSafe(entry.detail));
  assert.ok(!/ybl|q000111222|TEST VENDOR/i.test(JSON.stringify(entry)));
});
