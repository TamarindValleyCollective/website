// Run with: node --test scripts/lib/finance-import-endpoint.test.mjs
//
// The import routes of the real finance-admin Function, through requireStaff, with Google, Supabase and R2 stubbed:
// who may import (the `import` capability: finance user and admin, not a read-only auditor, not finance-requests),
// preview writes nothing, commit stores through the database functions and logs first, and obvious bad uploads are
// refused. Needs `npm ci` (esbuild) and Node 22.18+. Invented data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { axisStatement } from './finance-fixtures.mjs';

const stub = (filter, contents) => ({
  name: `stub-${filter}`,
  setup(b) {
    const ns = `stub-${String(filter).replace(/\W/g, '')}`;
    b.onResolve({ filter }, () => ({ path: ns, namespace: ns }));
    b.onLoad({ filter: /.*/, namespace: ns }, () => ({ contents, loader: 'js' }));
  },
});
const dir = mkdtempSync(join(tmpdir(), 'finance-import-endpoint-'));
const out = join(dir, 'finance-admin.mjs');
await build({
  entryPoints: ['netlify/functions/finance-admin.mts'], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'silent',
  plugins: [
    stub(/google-id-token\.mjs$/, 'export async function verifyGoogleIdToken(t){ return { email: t, hd: t.split("@")[1] }; }'),
    stub(/finance-storage$/, 'export async function putFinanceImport(k){ globalThis.__r2.push(["put", k]); } export async function deleteFinanceImport(k){ globalThis.__r2.push(["delete", k]); }'),
  ],
});
process.env.SUPABASE_URL = 'https://db.test';
process.env.PUBLIC_GOOGLE_CLIENT_ID = 'client';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
const { default: handler } = await import(pathToFileURL(out).href);

let db, calls;
globalThis.__r2 = [];
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const table = u.pathname.replace('/rest/v1/', '');
  calls.push(`${init.method ?? 'GET'} ${table}`);
  if (table === 'staff_users') return json(db.users.filter((x) => u.searchParams.get('email') === `eq.${x.email}`));
  if (table === 'staff_module_roles') return json(db.roles.filter((r) => r.staff_id === u.searchParams.get('staff_id')?.slice(3) && r.module === u.searchParams.get('module')?.slice(3)));
  if (table === 'fin_audit_log') { db.audit.push(JSON.parse(init.body)); return new Response(null, { status: 201 }); }
  if (table === 'fin_entities') return json([{ id: 'ent', circle_tag: 'Pocket Money', paytm_since: null }]);
  if (table === 'fin_bank_accounts' && init.method === 'POST') return json([{ id: 'new-acct' }], 201);
  if (table === 'fin_bank_accounts') return json([{ id: 'acct', label: 'Test current', last4: '1234', upi_label: 'Axis Bank - 99' }]);
  if (table === 'rpc/fin_store_bank_batch') { db.rpc.push(JSON.parse(init.body)); return json(JSON.parse(init.body).p_lines.length); }
  if (['fin_import_batches', 'fin_bank_lines', 'fin_upi_lines'].includes(table)) return json([]);
  throw new Error(`unexpected fetch ${init.method ?? 'GET'} ${url}`);
};

let n = 0;
const sign = (role) => {
  const email = `p${++n}@gmail.com`;
  db = { users: [{ id: 'u1', email, name: 'A', active: true, is_super_admin: false }], roles: role ? [{ staff_id: 'u1', module: role.module ?? 'finance', role: role.role, scope: null, expires_at: null }] : [], audit: [], rpc: [] };
  calls = [];
  globalThis.__r2 = [];
  return email;
};
const upload = (email, mode, files) => {
  const form = new FormData();
  for (const f of files) form.append('files', new File([f.bytes], f.name));
  return handler(new Request(`https://x.test/api/finance-admin/imports/${mode}`, { method: 'POST', headers: { authorization: `Bearer ${email}` }, body: form }));
};
const year = () => ({ name: 'year.xlsx', bytes: axisStatement({ from: '2022-01-01', to: '2022-12-31', openingPaise: 0, txns: [{ date: '2022-06-20', narration: 'Deposit', cr: 5000000 }] }).bytes });

test('a finance user may preview; the preview writes nothing', async () => {
  const email = sign({ role: 'user' });
  const res = await upload(email, 'preview', [year()]);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.mode, 'preview');
  assert.equal(body.files[0].status, 'ok');
  assert.equal(body.files[0].counts.new, 1);
  assert.equal(calls.some((c) => c.startsWith('POST') || c.includes('rpc/')), false);
  assert.deepEqual(globalThis.__r2, []);
  assert.equal(db.audit.length, 0);
});

test('commit logs first, keeps the raw file, and stores through the database function', async () => {
  const email = sign({ role: 'admin' });
  const res = await upload(email, 'commit', [year()]);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.files[0].stored, true);
  assert.equal(db.audit[0].action, 'finance.import_committed');
  assert.equal(db.audit[0].actor_id, 'u1');
  assert.ok(calls.indexOf('POST fin_audit_log') < calls.indexOf('POST rpc/fin_store_bank_batch'), 'the audit entry is written before the ledger tables change');
  assert.equal(db.rpc[0].p_lines.length, 1);
  assert.match(db.rpc[0].p_batch.r2_key, /^finance\/imports\/[0-9a-f-]{36}\.xlsx$/);
  assert.equal(globalThis.__r2[0][0], 'put');
});

test('a read-only auditor, a finance-requests holder and someone with no grant cannot import', async () => {
  for (const grant of [{ role: 'read_only' }, { module: 'finance-requests', role: 'user' }, null]) {
    const email = sign(grant);
    for (const mode of ['preview', 'commit']) assert.equal((await upload(email, mode, [year()])).status, 403, `${JSON.stringify(grant)} ${mode}`);
  }
  assert.deepEqual(globalThis.__r2, []);
});

test('no files, too many files and oversized files are refused before any parsing', async () => {
  const email = sign({ role: 'user' });
  assert.equal((await upload(email, 'preview', [])).status, 400);
  const email2 = sign({ role: 'user' });
  assert.equal((await upload(email2, 'preview', Array.from({ length: 13 }, year))).status, 400);
  const email3 = sign({ role: 'user' });
  assert.equal((await upload(email3, 'preview', [{ name: 'big.xlsx', bytes: new Uint8Array(3 * 1024 * 1024 + 1) }])).status, 413);
});

test('only a director (configure) may register a bank account, and only four digits are accepted', async () => {
  const post = (email, body) => handler(new Request('https://x.test/api/finance-admin/bank-accounts', { method: 'POST', headers: { authorization: `Bearer ${email}` }, body: JSON.stringify(body) }));
  assert.equal((await post(sign({ role: 'user' }), { label: 'A', last4: '1234' })).status, 403);
  const email = sign({ role: 'admin' });
  assert.equal((await post(email, { label: 'A', last4: '123456789' })).status, 400);
  assert.equal((await post(sign({ role: 'admin' }), { label: 'A', last4: '1234', upiLabel: 'Axis Bank - 99' })).status, 201);
  assert.equal(db.audit[0].action, 'finance.bank_account_added');
  assert.equal(JSON.stringify(db.audit[0]).includes('1234'), false); // the digits are not copied into the audit log
});
