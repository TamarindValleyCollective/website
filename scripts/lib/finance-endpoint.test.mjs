// Run with: node --test scripts/lib/finance-endpoint.test.mjs
//
// Drives the real finance-admin Function through requireStaff with Google sign-in and Supabase stubbed, to check
// the access rules end to end: a finance grant gets in; no grant, a finance-requests-only grant, a deactivated person
// and an expired auditor grant are all refused with the same 403; an auditor's visit is written to fin_audit_log
// and refused if it cannot be.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Google is replaced by a stub: the "token" is just the email.
const stubGoogle = {
  name: 'stub-google',
  setup(b) {
    b.onResolve({ filter: /google-id-token\.mjs$/ }, () => ({ path: 'stub-google', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export async function verifyGoogleIdToken(t){ return { email: t, hd: t.split("@")[1] }; }', loader: 'js' }));
  },
};
const dir = mkdtempSync(join(tmpdir(), 'finance-endpoint-'));
const out = join(dir, 'finance-admin.mjs');
await build({ entryPoints: ['netlify/functions/finance-admin.mts'], bundle: true, platform: 'node', format: 'esm', outfile: out, plugins: [stubGoogle], logLevel: 'silent' });

process.env.SUPABASE_URL = 'https://db.test';
process.env.PUBLIC_GOOGLE_CLIENT_ID = 'client';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
const { default: handler } = await import(pathToFileURL(out).href);

// A tiny fake Supabase. Each test sets `db` before calling.
let db;
let auditRows;
let failAudit;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const json = (body, headers = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
  const table = u.pathname.replace('/rest/v1/', '');
  if (table === 'staff_users') return json(db.users.filter((x) => u.searchParams.get('email') === `eq.${x.email}`));
  if (table === 'staff_module_roles') {
    const id = u.searchParams.get('staff_id')?.slice(3);
    const mod = u.searchParams.get('module')?.slice(3);
    return json(db.roles.filter((r) => r.staff_id === id && r.module === mod).map(({ role, scope, expires_at }) => ({ role, scope, expires_at })));
  }
  if (table === 'fin_audit_log' && init.method === 'POST') {
    if (failAudit) return new Response('boom', { status: 500 });
    auditRows.push(JSON.parse(init.body));
    return new Response(null, { status: 201 });
  }
  if (table === 'fin_entities') return json([{ id: 'e1', name: 'Test Entity' }]);
  if (table.startsWith('fin_')) return json([], { 'content-range': '0-0/3' });
  throw new Error(`unexpected fetch ${url}`);
};

const call = (email) => handler(new Request('https://x.test/api/finance-admin/overview', { headers: { authorization: `Bearer ${email}` } }));
// requireStaff caches lookups for 30s per email, so every test signs in as someone new.
let n = 0;
let who;
const person = (extra = {}) => ({ id: 'u1', email: who, name: 'A', active: true, is_super_admin: false, ...extra });
const FUTURE = new Date(Date.now() + 86_400_000).toISOString();
const PAST = new Date(Date.now() - 86_400_000).toISOString();
const reset = (users, roles) => {
  who = `p${++n}@gmail.com`;
  users = users.map((u) => ({ ...u, email: who }));
  db = { users, roles };
  auditRows = [];
  failAudit = false;
};

test('a finance admin gets the overview', async () => {
  reset([person()], [{ staff_id: 'u1', module: 'finance', role: 'admin', scope: null, expires_at: null }]);
  const res = await call(who);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.role, 'admin');
  assert.equal(body.visibility.payeeBankDetails, true);
  assert.equal(body.hasData, false);
  assert.equal(auditRows.length, 0); // only auditors' visits are logged
});

test('a finance user sees names but not payee bank details', async () => {
  reset([person()], [{ staff_id: 'u1', module: 'finance', role: 'user', scope: null, expires_at: null }]);
  const body = await (await call(who)).json();
  assert.deepEqual(body.visibility, { names: true, payeeBankDetails: false });
});

test('someone with no grant is refused', async () => {
  reset([person()], []);
  assert.equal((await call(who)).status, 403);
});

test('a finance-requests holder cannot reach finance endpoints', async () => {
  reset([person()], [{ staff_id: 'u1', module: 'finance-requests', role: 'user', scope: null, expires_at: null }]);
  assert.equal((await call(who)).status, 403);
});

test('a deactivated person is refused', async () => {
  reset([person({ active: false })], [{ staff_id: 'u1', module: 'finance', role: 'admin', scope: null, expires_at: null }]);
  assert.equal((await call(who)).status, 403);
});

test('an auditor within their dates gets in, and the visit is logged', async () => {
  reset([person()], [{ staff_id: 'u1', module: 'finance', role: 'read_only', scope: null, expires_at: FUTURE }]);
  const res = await call(who);
  assert.equal(res.status, 200);
  assert.equal(auditRows.length, 1);
  assert.equal(auditRows[0].action, 'finance.overview_viewed');
  assert.equal(auditRows[0].actor_id, 'u1');
});

test('an expired auditor grant is refused, like no grant at all', async () => {
  reset([person()], [{ staff_id: 'u1', module: 'finance', role: 'read_only', scope: null, expires_at: PAST }]);
  const res = await call(who);
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'Not authorized' });
});

test('an auditor visit that cannot be logged is refused rather than shown unrecorded', async () => {
  reset([person()], [{ staff_id: 'u1', module: 'finance', role: 'read_only', scope: null, expires_at: FUTURE }]);
  failAudit = true;
  const origError = console.error;
  console.error = () => {};
  const res = await call(who);
  console.error = origError;
  assert.equal(res.status, 500);
});

test('no sign-in token is a 401', async () => {
  reset([], []);
  const res = await handler(new Request('https://x.test/api/finance-admin/overview'));
  assert.equal(res.status, 401);
});
