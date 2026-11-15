// Run with: node --test scripts/lib/finance-upi-operators-endpoint.test.mjs
//
// UPI operators through the real finance-admin Function (Google and Supabase stubbed): who may add or rename one, duplicates, that a delegate belongs
// to one operator's circle (filled in when there is only one operator, chosen when there are several), that the UPI page's answer lists the
// operators, and that a database without the operators table still answers. Every name and number is invented.
// Needs `npm ci` (esbuild) and Node 22.18+.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.SUPABASE_URL = 'https://db.test';
process.env.PUBLIC_GOOGLE_CLIENT_ID = 'client';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';

const stubGoogle = {
  name: 'stub-google',
  setup(b) {
    b.onResolve({ filter: /google-id-token\.mjs$/ }, () => ({ path: 'stub-google', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export async function verifyGoogleIdToken(t){ return { email: t, hd: t.split("@")[1] }; }', loader: 'js' }));
  },
};
const dir = mkdtempSync(join(tmpdir(), 'finance-operators-'));
const out = join(dir, 'finance-admin.mjs');
await build({ entryPoints: ['netlify/functions/finance-admin.mts'], bundle: true, platform: 'node', format: 'esm', outfile: out, plugins: [stubGoogle], logLevel: 'silent' });
const { default: handler } = await import(pathToFileURL(out).href);

const ID = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const OP1 = ID(71), OP2 = ID(72);

let db, auditRows, who, n = 0, seq = 100;
const matches = (row, params) => {
  for (const [k, v] of params) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(k)) continue;
    const dot = v.indexOf('.');
    const op = v.slice(0, dot), val = v.slice(dot + 1);
    if (op === 'eq' && String(row[k]) !== val) return false;
  }
  return true;
};
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const j = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const table = u.pathname.replace('/rest/v1/', '');
  const method = init.method ?? 'GET';
  if (table === 'staff_users') return j(db.users.filter((x) => u.searchParams.get('email') === `eq.${x.email}`));
  if (table === 'staff_module_roles') return j(db.roles.filter((r) => r.staff_id === u.searchParams.get('staff_id')?.slice(3) && r.module === u.searchParams.get('module')?.slice(3)).map(({ role, scope, expires_at }) => ({ role, scope, expires_at })));
  if (table === 'staff_mfa_factors' || table === 'staff_recovery_codes') return j([]);
  if (table === 'fin_audit_log' && method === 'POST') { auditRows.push(JSON.parse(init.body)); return new Response(null, { status: 201 }); }
  if (db.noOperators && (table === 'fin_upi_operators' || u.searchParams.get('select')?.includes('operator_id'))) return new Response('column or relation does not exist', { status: 400 });
  if (table.startsWith('fin_')) {
    const rows = db.data[table] ?? [];
    if (method === 'POST') {
      const body = JSON.parse(init.body);
      const row = { id: ID(++seq), created_at: '2026-11-15', ...(table === 'fin_delegates' ? { display_name: null } : {}), ...body };
      if (table === 'fin_upi_operators' && rows.some((r) => r.display_name === body.display_name)) return new Response('duplicate key 23505', { status: 409 });
      rows.push(row); db.data[table] = rows;
      return j([row], 201);
    }
    if (method === 'PATCH') {
      const hit = rows.filter((r) => matches(r, u.searchParams));
      hit.forEach((r) => Object.assign(r, JSON.parse(init.body)));
      return j(hit);
    }
    return j(rows.filter((r) => matches(r, u.searchParams)));
  }
  throw new Error(`unexpected fetch ${url}`);
};

const person = () => ({ id: 'u1', email: who, name: 'A', active: true, is_super_admin: false });
const reset = (role, extra = {}) => {
  who = `c${++n}@gmail.com`;
  db = { users: [{ ...person() }], roles: role ? [{ staff_id: 'u1', module: 'finance', role, scope: null, expires_at: null }] : [], data: { fin_entities: [{ id: ID(1), created_at: '2022-01-01' }], fin_upi_operators: [{ id: OP1, display_name: 'Test operator one' }], fin_delegates: [], fin_upi_delegate_links: [], fin_upi_lines: [], fin_bank_lines: [], fin_bank_accounts: [], fin_payment_requests: [], fin_notes: [] }, ...extra };
  auditRows = [];
};
const call = (path, method, body) => handler(new Request(`https://x.test/api/finance-admin${path}`, { method, headers: { authorization: `Bearer ${who}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }));

test('an admin adds an operator and renames one; the audit has no name in it', async () => {
  reset('admin');
  const add = await call('/upi-operators', 'POST', { name: '  Test operator   two ' });
  assert.equal(add.status, 201);
  const op = (await add.json()).operator;
  assert.equal(op.name, 'Test operator two', 'trimmed and tidied');
  const rename = await call(`/upi-operators/${op.id}`, 'PATCH', { name: 'Renamed operator' });
  assert.equal(rename.status, 200);
  assert.equal((await rename.json()).operator.name, 'Renamed operator');
  assert.deepEqual(auditRows.map((a) => a.action), ['finance.upi_operator_added', 'finance.upi_operator_renamed']);
  assert.ok(!JSON.stringify(auditRows).includes('Renamed'), 'no name in the audit');
});

test('a name is checked, a duplicate is refused, and an unknown operator is not found', async () => {
  reset('admin');
  assert.equal((await call('/upi-operators', 'POST', { name: 'x' })).status, 400);
  assert.equal((await call('/upi-operators', 'POST', { name: 'test OPERATOR one' })).status, 409, 'the same name in another case');
  assert.equal((await call(`/upi-operators/${ID(99)}`, 'PATCH', { name: 'Someone else' })).status, 404);
  assert.equal((await call('/upi-operators', 'POST', undefined)).status, 400);
});

test('only someone who may configure adds or renames; a viewer cannot', async () => {
  reset('read_only');
  assert.equal((await call('/upi-operators', 'POST', { name: 'Test operator two' })).status, 403);
  reset(null);
  assert.equal((await call('/upi-operators', 'POST', { name: 'Test operator two' })).status, 403);
});

test('a delegate belongs to one operator’s circle: filled in when there is one operator, chosen when there are several', async () => {
  reset('admin');
  const only = await call('/delegates', 'POST', { identifier: '5550100001', activeFrom: '2026-07-04' });
  assert.equal(only.status, 201);
  assert.equal(db.data.fin_delegates[0].operator_id, OP1, 'the only operator');
  db.data.fin_upi_operators.push({ id: OP2, display_name: 'Test operator two' });
  const none = await call('/delegates', 'POST', { identifier: '5550100002', activeFrom: '2026-07-04' });
  assert.equal(none.status, 400);
  assert.match((await none.json()).error, /whose UPI circle/);
  const bad = await call('/delegates', 'POST', { identifier: '5550100002', activeFrom: '2026-07-04', operatorId: ID(98) });
  assert.equal(bad.status, 400);
  const second = await call('/delegates', 'POST', { identifier: '5550100002', activeFrom: '2026-07-04', operatorId: OP2 });
  assert.equal(second.status, 201);
  assert.equal(db.data.fin_delegates[1].operator_id, OP2);
});

test('the UPI page lists the operators, and each row says whose UPI it went through', async () => {
  reset('admin');
  db.data.fin_upi_lines = [{ id: ID(50), paid_at: '2026-10-01', paid_time: null, app: 'paytm', counterparty: 'Shop', remarks: null, tag: null, amount_paise: 1000, direction: 'debit', is_circle: false, upi_ref: '600000000001', bank_account_id: null, bank_line_id: null, operator_id: OP1, ignored: false }];
  const r = await call('/upi-lines', 'GET');
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.deepEqual(d.operators, [{ id: OP1, name: 'Test operator one' }]);
  assert.equal(d.lines[0].operatorId, OP1);
});

test('a database without the operators table still answers, with no operators', async () => {
  reset('admin', { noOperators: true });
  db.data.fin_upi_lines = [{ id: ID(50), paid_at: '2026-10-01', paid_time: null, app: 'paytm', counterparty: 'Shop', remarks: null, tag: null, amount_paise: 1000, direction: 'debit', is_circle: false, upi_ref: '600000000001', bank_account_id: null, bank_line_id: null, ignored: false }];
  const r = await call('/upi-lines', 'GET');
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.deepEqual(d.operators, []);
  assert.equal(d.lines[0].operatorId, null);
  const dg = await call('/delegates', 'POST', { identifier: '5550100001', activeFrom: '2026-07-04' });
  assert.equal(dg.status, 201, 'a delegate can still be added');
  assert.equal(db.data.fin_delegates[0].operator_id, undefined);
});
