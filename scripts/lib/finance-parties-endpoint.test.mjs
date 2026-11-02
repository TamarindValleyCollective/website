// Run with: node --test scripts/lib/finance-parties-endpoint.test.mjs
//
// Drives the real finance-admin Function (parties routes) through requireStaff with Google and Supabase stubbed.
// Checks the money-adjacent rules end to end: a changed account is a new unverified row and the old one is kept;
// account numbers are encrypted at rest and never appear in list responses, in the audit log, or to anyone without
// verify-payee; revealing and verifying need the MFA step-up; whoever entered details cannot verify them; a shared
// account is flagged. Every value is invented. Needs `npm ci` (esbuild) and Node 22.18+.
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
const { signStepUp } = await import('../../netlify/functions/lib/staff-mfa-crypto.ts');

const stubGoogle = {
  name: 'stub-google',
  setup(b) {
    b.onResolve({ filter: /google-id-token\.mjs$/ }, () => ({ path: 'stub-google', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export async function verifyGoogleIdToken(t){ return { email: t, hd: t.split("@")[1] }; }', loader: 'js' }));
  },
};
const dir = mkdtempSync(join(tmpdir(), 'finance-parties-'));
const out = join(dir, 'finance-admin.mjs');
await build({ entryPoints: ['netlify/functions/finance-admin.mts'], bundle: true, platform: 'node', format: 'esm', outfile: out, plugins: [stubGoogle], logLevel: 'silent' });
const { default: handler } = await import(pathToFileURL(out).href);

const ACCOUNT = '100000000001';
const ACCOUNT_2 = '100000000002';
const IFSC = 'ABCD0123456';

// ---- a tiny fake PostgREST: eq./neq./in./ilike filters, inserts with generated ids, patches
let db;
let failAudit;
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
  const table = u.pathname.replace('/rest/v1/', '');
  const method = init.method ?? 'GET';
  if (table === 'staff_users') return json(db.users.filter((x) => u.searchParams.get('email') === `eq.${x.email}`));
  if (table === 'staff_module_roles') {
    const id = u.searchParams.get('staff_id')?.slice(3);
    const mod = u.searchParams.get('module')?.slice(3);
    return json(db.roles.filter((r) => r.staff_id === id && r.module === mod).map(({ role, scope, expires_at }) => ({ role, scope, expires_at })));
  }
  if (table === 'staff_mfa_factors' || table === 'staff_recovery_codes') return json([]);
  if (table === 'fin_audit_log' && method === 'POST') {
    if (failAudit) return new Response('boom', { status: 500 });
    db.audit.push(JSON.parse(init.body));
    return new Response(null, { status: 201 });
  }
  if (table === 'fin_entities') return json([{ id: 'e1', name: 'Test Entity' }]);
  if (table === 'member_households') return json([{ id: 'h1' }]);
  if (table === 'fin_parties' || table === 'fin_party_accounts') {
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
  throw new Error(`unexpected fetch ${method} ${url}`);
};

const reset = () => {
  db = { users: [], roles: [], fin_parties: [], fin_party_accounts: [], audit: [] };
  failAudit = false;
};
// requireStaff caches lookups per email for 30s, so each test signs in as someone new.
const sign = (id, role, extra = {}) => {
  const email = `${id}-${++n}@gmail.com`;
  db.users.push({ id, email, name: id, active: true, is_super_admin: false });
  db.roles.push({ staff_id: id, module: 'finance', role, scope: null, expires_at: null, ...extra });
  return email;
};
const api = (email, path, { method = 'GET', body, stepUp = false } = {}) =>
  handler(
    new Request(`https://x.test/api/finance-admin${path}`, {
      method,
      headers: { authorization: `Bearer ${email}`, ...(body ? { 'content-type': 'application/json' } : {}), ...(stepUp ? { 'x-stepup-token': signStepUp(stepUp, 'totp', Date.now()) } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
const newVendor = (over = {}) => ({ name: 'Test Traders', kind: 'vendor', payee: { method: 'bank', account: ACCOUNT, ifsc: IFSC }, ...over });
const quiet = async (fn) => {
  const orig = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = orig;
  }
};

test('a finance user adds a vendor with bank details: stored encrypted and unverified, answered without the number', async () => {
  reset();
  const op = sign('u1', 'user');
  const res = await api(op, '/parties', { method: 'POST', body: newVendor() });
  assert.equal(res.status, 201);
  const text = JSON.stringify(await res.json());
  assert.ok(!text.includes(ACCOUNT) && !text.includes(IFSC));
  const [acct] = db.fin_party_accounts;
  assert.equal(acct.status, 'unverified');
  assert.equal(acct.last4, '0001');
  assert.equal(acct.created_by, 'u1');
  assert.ok(!JSON.stringify(acct).includes(ACCOUNT), 'the number must not be stored in the clear');
  assert.match(acct.details_enc, /^v1\./);
});

test('every audit row is ids, counts and field names: no account number, IFSC or UPI id', async () => {
  reset();
  const op = sign('u1', 'user');
  await api(op, '/parties', { method: 'POST', body: newVendor() });
  const id = db.fin_parties[0].id;
  await api(op, `/parties/${id}/accounts`, { method: 'POST', body: { method: 'upi', upi: 'test.vendor@okbank' } });
  await api(op, `/parties/${id}`, { method: 'PATCH', body: { name: 'Test Traders Ltd' } });
  assert.ok(db.audit.length >= 3);
  for (const row of db.audit) {
    assert.ok(auditDetailIsSafe(row.detail), JSON.stringify(row));
    const text = JSON.stringify(row);
    for (const s of [ACCOUNT, IFSC, 'test.vendor', 'Test Traders']) assert.ok(!text.includes(s), `audit leaked ${s}`);
  }
});

test('a read-only viewer sees the directory (names, last four) but cannot add', async () => {
  reset();
  const op = sign('u1', 'user');
  await api(op, '/parties', { method: 'POST', body: newVendor() });
  const viewer = sign('u2', 'read_only');
  const list = await api(viewer, '/parties');
  assert.equal(list.status, 200);
  const body = await list.json();
  assert.equal(body.parties[0].name, 'Test Traders');
  assert.equal(body.parties[0].accounts[0].shown, 'ending 0001');
  assert.equal(body.canEdit, false);
  assert.equal((await api(viewer, '/parties', { method: 'POST', body: newVendor({ name: 'Another Shop' }) })).status, 403);
});

test('even a payee verifier gets only last four from the list', async () => {
  reset();
  const op = sign('u1', 'user');
  await api(op, '/parties', { method: 'POST', body: newVendor() });
  const director = sign('u2', 'admin');
  const text = JSON.stringify(await (await api(director, '/parties')).json());
  assert.ok(!text.includes(ACCOUNT) && !text.includes(IFSC));
  assert.ok(!text.includes('fingerprint') && !text.includes('details_enc'));
});

test('changing the account adds a new unverified row and supersedes the old one, which is kept', async () => {
  reset();
  const op = sign('u1', 'user');
  await api(op, '/parties', { method: 'POST', body: newVendor() });
  const id = db.fin_parties[0].id;
  const res = await api(op, `/parties/${id}/accounts`, { method: 'POST', body: { method: 'bank', account: ACCOUNT_2, ifsc: IFSC } });
  assert.equal(res.status, 201);
  assert.equal(db.fin_party_accounts.length, 2);
  assert.deepEqual(db.fin_party_accounts.map((a) => a.status), ['superseded', 'unverified']);
  assert.ok(db.fin_party_accounts[0].superseded_at);
  assert.match(db.fin_party_accounts[0].details_enc, /^v1\./); // the old details are still there
});

test('entering the same details again adds nothing', async () => {
  reset();
  const op = sign('u1', 'user');
  await api(op, '/parties', { method: 'POST', body: newVendor() });
  const id = db.fin_parties[0].id;
  const res = await api(op, `/parties/${id}/accounts`, { method: 'POST', body: { method: 'bank', account: ACCOUNT, ifsc: IFSC } });
  assert.equal(res.status, 200);
  assert.equal(db.fin_party_accounts.length, 1);
});

test('two parties with one account are flagged on both, and both are still allowed', async () => {
  reset();
  const op = sign('u1', 'user');
  assert.equal((await api(op, '/parties', { method: 'POST', body: newVendor() })).status, 201);
  assert.equal((await api(op, '/parties', { method: 'POST', body: newVendor({ name: 'Other Shop' }) })).status, 201);
  const body = await (await api(op, '/parties')).json();
  assert.deepEqual(body.parties.map((p) => p.accounts[0].shared), [true, true]);
});

test('bad details are refused with a message and nothing is stored', async () => {
  reset();
  const op = sign('u1', 'user');
  const res = await api(op, '/parties', { method: 'POST', body: newVendor({ payee: { method: 'bank', account: '123', ifsc: IFSC } }) });
  assert.equal(res.status, 400);
  assert.equal(db.fin_parties.length, 0);
});

test('revealing needs verify-payee and the step-up; the reveal is logged before the number is returned', async () => {
  reset();
  const op = sign('u1', 'user');
  await api(op, '/parties', { method: 'POST', body: newVendor() });
  const acctId = db.fin_party_accounts[0].id;
  const director = sign('u2', 'admin');

  assert.equal((await api(op, `/accounts/${acctId}/reveal`, { method: 'POST', stepUp: 'u1' })).status, 403); // no verify-payee
  const noStep = await api(director, `/accounts/${acctId}/reveal`, { method: 'POST' });
  assert.equal(noStep.status, 403);
  assert.equal((await noStep.json()).code, 'STEP_UP_REQUIRED');
  assert.equal((await api(director, `/accounts/${acctId}/reveal`, { method: 'POST', stepUp: 'someone-else' })).status, 403); // token for another person

  const ok = await api(director, `/accounts/${acctId}/reveal`, { method: 'POST', stepUp: 'u2' });
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).details, { method: 'bank', account: ACCOUNT, ifsc: IFSC });
  assert.equal(db.audit.at(-1).action, 'finance.payee_revealed');
  assert.equal(db.audit.at(-1).target, acctId);
});

test('if the reveal cannot be logged, the number is not returned', async () => {
  reset();
  const op = sign('u1', 'user');
  await api(op, '/parties', { method: 'POST', body: newVendor() });
  const acctId = db.fin_party_accounts[0].id;
  const director = sign('u2', 'admin');
  failAudit = true;
  const res = await quiet(() => api(director, `/accounts/${acctId}/reveal`, { method: 'POST', stepUp: 'u2' }));
  assert.equal(res.status, 500);
  assert.ok(!(await res.text()).includes(ACCOUNT));
});

test('verifying needs the step-up, and not by whoever entered the details', async () => {
  reset();
  const director1 = sign('u1', 'admin');
  await api(director1, '/parties', { method: 'POST', body: newVendor() });
  const acctId = db.fin_party_accounts[0].id;
  const director2 = sign('u2', 'admin');

  assert.equal((await (await api(director2, `/accounts/${acctId}/verify`, { method: 'POST' })).json()).code, 'STEP_UP_REQUIRED');
  const self = await api(director1, `/accounts/${acctId}/verify`, { method: 'POST', stepUp: 'u1' });
  assert.equal(self.status, 403);
  assert.equal(db.fin_party_accounts[0].status, 'unverified');

  const ok = await api(director2, `/accounts/${acctId}/verify`, { method: 'POST', stepUp: 'u2' });
  assert.equal(ok.status, 200);
  assert.equal(db.fin_party_accounts[0].status, 'verified');
  assert.equal(db.fin_party_accounts[0].verified_by, 'u2');
  assert.equal(db.audit.at(-1).action, 'finance.payee_verified');
  assert.equal((await api(director2, `/accounts/${acctId}/verify`, { method: 'POST', stepUp: 'u2' })).status, 400); // already verified
});

test('a finance-requests holder cannot read the directory', async () => {
  reset();
  const email = `fr-${++n}@gmail.com`;
  db.users.push({ id: 'u9', email, name: 'x', active: true, is_super_admin: false });
  db.roles.push({ staff_id: 'u9', module: 'finance-requests', role: 'user', scope: null, expires_at: null });
  assert.equal((await api(email, '/parties')).status, 403);
});

test('a member party links to a household; a vendor cannot', async () => {
  reset();
  const op = sign('u1', 'user');
  assert.equal((await api(op, '/parties', { method: 'POST', body: { name: 'Member One', kind: 'member', householdId: 'h1' } })).status, 201);
  assert.equal(db.fin_parties[0].household_id, 'h1');
  assert.equal((await api(op, '/parties', { method: 'POST', body: { name: 'Shop Two', kind: 'vendor', householdId: 'h1' } })).status, 400);
});
