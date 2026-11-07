// Run with: node --test scripts/lib/finance-notes-endpoint.test.mjs
//
// POST /api/finance-admin/payment-note through the real finance-admin Function and requireStaff, with Google and Supabase
// stubbed: who may write a note (`allocate`), that a bad key or a note that looks like an account is refused before anything
// is written, that the audit entry comes first and carries the length, never the text, and that a note is saved or cleared.
// Needs `npm ci` (esbuild). Invented data only.
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
const dir = mkdtempSync(join(tmpdir(), 'finance-notes-endpoint-'));
const out = join(dir, 'finance-admin.mjs');
await build({
  entryPoints: ['netlify/functions/finance-admin.mts'], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'silent',
  plugins: [stub(/google-id-token\.mjs$/, 'export async function verifyGoogleIdToken(t){ return { email: t, hd: t.split("@")[1] }; }')],
});
process.env.SUPABASE_URL = 'https://db.test';
process.env.PUBLIC_GOOGLE_CLIENT_ID = 'client';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
const { default: handler } = await import(pathToFileURL(out).href);

let db, calls;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const table = u.pathname.replace('/rest/v1/', '');
  calls.push(`${init.method ?? 'GET'} ${table}`);
  if (table === 'staff_users') return json(db.users.filter((x) => u.searchParams.get('email') === `eq.${x.email}`));
  if (table === 'staff_module_roles') return json(db.roles.filter((r) => r.staff_id === u.searchParams.get('staff_id')?.slice(3) && r.module === u.searchParams.get('module')?.slice(3)));
  if (table === 'fin_audit_log') { db.audit.push(JSON.parse(init.body)); return new Response(null, { status: 201 }); }
  if (table === 'fin_entities') return json([{ id: 'ent' }]);
  if (table === 'fin_payment_notes') {
    if (init.method === 'POST') { const b = JSON.parse(init.body); db.notes.set(b.key, b); return new Response(null, { status: 201 }); }
    if (init.method === 'DELETE') { db.notes.delete(decodeURIComponent(u.searchParams.get('key').slice(3))); return new Response(null, { status: 204 }); }
  }
  throw new Error(`unexpected fetch ${init.method ?? 'GET'} ${url}`);
};

let n = 0;
const sign = (role, module = 'finance') => {
  const email = `p${++n}@gmail.com`;
  db = { users: [{ id: 'u1', email, name: 'A', active: true, is_super_admin: false }], roles: role ? [{ staff_id: 'u1', module, role, scope: null, expires_at: null }] : [], audit: [], notes: new Map() };
  calls = [];
  return email;
};
const post = (email, body) => handler(new Request('https://x.test/api/finance-admin/payment-note', { method: 'POST', headers: { authorization: `Bearer ${email}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
const KEY = 'upi:600000000001';

test('a finance user saves a note: the audit entry comes first and holds the length, not the text; the note is stored', async () => {
  const email = sign('user');
  const res = await post(email, { key: KEY, note: '  Gas   refill ' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, note: 'Gas refill' });
  assert.deepEqual(db.audit[0].detail, { cleared: false, length: 10 });
  assert.equal(db.audit[0].action, 'finance.payment_note_set');
  assert.equal(JSON.stringify(db.audit).includes('Gas'), false);
  assert.ok(calls.indexOf('POST fin_audit_log') < calls.indexOf('POST fin_payment_notes'));
  assert.equal(db.notes.get(KEY).note, 'Gas refill');
});

test('an empty note clears it (the row is deleted)', async () => {
  const email = sign('user');
  await post(email, { key: KEY, note: 'x' });
  const res = await post(email, { key: KEY, note: '' });
  assert.deepEqual(await res.json(), { ok: true, note: null });
  assert.equal(db.notes.has(KEY), false);
  assert.equal(db.audit[1].detail.cleared, true);
});

test('a bad key, a note that looks like an account, or no finance access writes nothing', async () => {
  const email = sign('user');
  assert.equal((await post(email, { key: 'nope', note: 'x' })).status, 400);
  const acct = await post(email, { key: KEY, note: 'paid to 123456789012' });
  assert.equal(acct.status, 400);
  assert.match((await acct.json()).error, /account number/);
  assert.equal(db.audit.length, 0);
  assert.equal(db.notes.size, 0);
  const stranger = sign(null);
  assert.equal((await post(stranger, { key: KEY, note: 'x' })).status, 403);
  assert.equal(db.notes.size, 0);
});

test('a read-only auditor and a finance-requests person cannot write a note', async () => {
  assert.equal((await post(sign('read_only'), { key: KEY, note: 'x' })).status, 403);
  assert.equal((await post(sign('user', 'finance-requests'), { key: KEY, note: 'x' })).status, 403);
  assert.equal(db.notes.size, 0);
});
