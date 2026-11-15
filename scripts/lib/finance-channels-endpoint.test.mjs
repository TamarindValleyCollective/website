// Run with: node --test scripts/lib/finance-channels-endpoint.test.mjs
//
// Drives the real finance-admin Function (GET /api/finance-admin/channels) through requireStaff with Google and Supabase stubbed.
// Checks who may read it, that the money ties to the bank lines and to the ledger (drafts do not count), the fixed deposits' balance,
// delegate attribution, that a database without the delegate tables still answers, and that no narration leaves the server. Financial
// year 2025 (April 2025 to March 2026) is used because it is closed whatever day this runs. Every name and amount is invented.
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
const dir = mkdtempSync(join(tmpdir(), 'finance-channels-'));
const out = join(dir, 'finance-admin.mjs');
await build({ entryPoints: ['netlify/functions/finance-admin.mts'], bundle: true, platform: 'node', format: 'esm', outfile: out, plugins: [stubGoogle], logLevel: 'silent' });
const { default: handler } = await import(pathToFileURL(out).href);

const ID = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const C = { sal: ID(11), groc: ID(12), sink: ID(13), maint: ID(14) };
const L = { maint: ID(31), shop: ID(32), sink: ID(33), card: ID(34) };
const D1 = ID(61);

const seed = () => ({
  fin_bank_accounts: [{ id: 'acc', label: 'Current account', created_at: '2025-01-01' }],
  fin_projects: [{ id: ID(21), name: 'Water tank', financial_year: 2025 }],
  fin_bank_lines: [
    { id: L.maint, bank_account_id: 'acc', tran_date: '2025-04-05', direction: 'credit', amount_paise: 300000, narration: 'INB/NEFT/AXODH1/Household Nine/Bank' },
    { id: L.shop, bank_account_id: 'acc', tran_date: '2025-04-28', direction: 'debit', amount_paise: 100000, narration: 'UPI/P2A/600000000001/Corner Shop/Bank' },
    { id: L.sink, bank_account_id: 'acc', tran_date: '2025-10-03', direction: 'debit', amount_paise: 200000, narration: 'INB/NEFT/AXODH2/Deposit/Bank' },
    { id: L.card, bank_account_id: 'acc', tran_date: '2026-03-10', direction: 'debit', amount_paise: 15000, narration: 'POS/HARDWARE SHOP' },
    { id: ID(35), bank_account_id: 'acc', tran_date: '2024-12-01', direction: 'debit', amount_paise: 999, narration: 'before the year' },
  ],
  fin_allocations: [
    { id: ID(51), bank_line_id: L.maint, category_id: C.maint, project_id: null, amount_paise: 300000, posted_at: '2025-05-01T00:00:00Z' },
    { id: ID(52), bank_line_id: L.shop, category_id: C.sal, project_id: null, amount_paise: 70000, posted_at: '2025-05-01T00:00:00Z' },
    { id: ID(53), bank_line_id: L.shop, category_id: C.groc, project_id: ID(21), amount_paise: 30000, posted_at: '2025-05-01T00:00:00Z' },
    { id: ID(54), bank_line_id: L.sink, category_id: C.sink, project_id: null, amount_paise: 200000, posted_at: '2025-11-01T00:00:00Z' },
    { id: ID(55), bank_line_id: L.card, category_id: C.groc, project_id: null, amount_paise: 5000, posted_at: null }, // a draft: not counted
  ],
  fin_categories: [
    { id: C.sal, name: 'Salaries', type: 'opex', head: 'farm', is_salary: true },
    { id: C.groc, name: 'Groceries', type: 'opex', head: 'farm', is_salary: false },
    { id: C.sink, name: 'Sinking fund deposits', type: 'sinking_fund', head: 'investment', is_salary: false },
    { id: C.maint, name: 'Member maintenance', type: 'member_contribution', head: null, is_salary: false },
  ],
  fin_upi_lines: [
    { id: ID(71), bank_line_id: L.shop, app: 'paytm', paid_at: '2025-04-28', direction: 'debit', amount_paise: 100000, is_circle: true, ignored: false, upi_ref: '600000000001' },
    { id: ID(72), bank_line_id: null, app: 'paytm', paid_at: '2025-09-12', direction: 'debit', amount_paise: 12000, is_circle: true, ignored: false, upi_ref: '600000000002' },
    { id: ID(73), bank_line_id: null, app: 'paytm', paid_at: '2025-09-13', direction: 'debit', amount_paise: 999999, is_circle: false, ignored: false, upi_ref: '600000000003' },
  ],
  fin_delegates: [{ id: D1, identifier: '5550100001', display_name: null, active_from: '2025-07-01', active_to: null, cap_paise: null }],
  fin_upi_delegate_links: [],
});

let db;
let auditRows;
let failAudit;
let n = 0;
let who;
const matches = (row, params) => {
  for (const [k, v] of params) {
    if (['select', 'order', 'limit', 'offset'].includes(k)) continue;
    const dot = v.indexOf('.');
    let op = v.slice(0, dot);
    let val = v.slice(dot + 1);
    let negate = false;
    if (op === 'not') { negate = true; const d2 = val.indexOf('.'); op = val.slice(0, d2); val = val.slice(d2 + 1); }
    const cell = row[k];
    let ok;
    if (op === 'eq') ok = String(cell) === val;
    else if (op === 'in') ok = val.replace(/^\(|\)$/g, '').split(',').includes(String(cell));
    else if (op === 'is') ok = val === 'null' ? cell == null : cell != null;
    else ok = true;
    if (negate ? ok : !ok) return false;
  }
  return true;
};
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const table = u.pathname.replace('/rest/v1/', '');
  if (table === 'staff_users') return json(db.users.filter((x) => u.searchParams.get('email') === `eq.${x.email}`));
  if (table === 'staff_module_roles') {
    const id = u.searchParams.get('staff_id')?.slice(3);
    const mod = u.searchParams.get('module')?.slice(3);
    return json(db.roles.filter((r) => r.staff_id === id && r.module === mod).map(({ role, scope, expires_at }) => ({ role, scope, expires_at })));
  }
  if (table === 'staff_mfa_factors' || table === 'staff_recovery_codes') return json([]);
  if (table === 'fin_audit_log' && init.method === 'POST') {
    if (failAudit) return new Response('boom', { status: 500 });
    auditRows.push(JSON.parse(init.body));
    return new Response(null, { status: 201 });
  }
  if (db.noDelegateTables && (table === 'fin_delegates' || table === 'fin_upi_delegate_links')) return new Response('relation does not exist', { status: 404 });
  if (table.startsWith('fin_')) {
    const rows = (db.data[table] ?? []).filter((r) => matches(r, u.searchParams));
    const offset = Number(u.searchParams.get('offset') ?? 0);
    const limit = Math.min(Number(u.searchParams.get('limit') ?? 1000), 1000);
    return json(rows.slice(offset, offset + limit));
  }
  throw new Error(`unexpected fetch ${url}`);
};

const person = (extra = {}) => ({ id: 'u1', email: who, name: 'A', active: true, is_super_admin: false, ...extra });
const reset = (users, roles, extra = {}) => {
  who = `c${++n}@gmail.com`;
  db = { users: users.map((u) => ({ ...u, email: who })), roles, data: seed(), ...extra };
  auditRows = [];
  failAudit = false;
};
const grant = (role) => reset([person()], [{ staff_id: 'u1', module: 'finance', role, scope: null, expires_at: null }]);
const call = (query = '?fy=2025') => handler(new Request(`https://x.test/api/finance-admin/channels${query}`, { headers: { authorization: `Bearer ${who}` } }));
const sum = (cells) => cells.reduce((t, c) => t + c.paise, 0);

test('no finance grant, or only finance-requests, is refused', async () => {
  reset([person()], []);
  assert.equal((await call()).status, 403);
  reset([person()], [{ staff_id: 'u1', module: 'finance-requests', role: 'user', scope: null, expires_at: null }]);
  assert.equal((await call()).status, 403);
});

test('a year is chosen as 20xx and cannot be one that has not started', async () => {
  grant('admin');
  assert.equal((await call('?fy=banana')).status, 400);
  assert.equal((await call('?fy=2099')).status, 400);
});

test('the money in the aggregate ties to the bank lines of the year, whatever is or is not categorised yet', async () => {
  grant('admin');
  const d = await (await call()).json();
  assert.equal(sum(d.cube.filter((c) => c.d === 'out')), 100000 + 200000 + 15000, 'a line from before the year is not counted');
  assert.equal(sum(d.cube.filter((c) => c.d === 'in')), 300000);
  assert.equal(sum(d.cube.filter((c) => c.c === 'paytm')), 100000, 'the UPI row joined to the line names the channel');
  assert.equal(sum(d.cube.filter((c) => c.g === 'salary')), 70000);
  assert.equal(sum(d.cube.filter((c) => c.g === 'projects' && c.p === ID(21))), 30000, 'a project line carries the project');
  const card = d.cube.filter((c) => c.c === 'card');
  assert.deepEqual(card.map((c) => [c.g, c.u, c.paise]), [['other', 1, 15000]], 'the draft allocation does not count, so the card line has no category yet');
  assert.deepEqual(d.accounts, [{ id: 'acc', label: 'Current account' }]);
  assert.deepEqual(d.projects, [{ id: ID(21), name: 'Water tank' }]);
});

test('the fixed deposits: the balance at the end of each month of the year', async () => {
  grant('admin');
  const d = await (await call()).json();
  assert.equal(d.fd.balances['2025-09'], 0);
  assert.equal(d.fd.balances['2025-10'], 200000);
  assert.equal(d.fd.balances['2026-03'], 200000);
});

test('delegates: each delegated payment belongs to the delegate active that day, or to nobody yet', async () => {
  grant('admin');
  const d = await (await call()).json();
  assert.deepEqual(d.delegates, [{ id: D1, label: '5550100001', number: '5550100001', capPaise: 1500000 }]);
  const by = (m) => d.delegatePayments.find((p) => p.m === m);
  assert.deepEqual(by('2025-04'), { m: '2025-04', d: null, app: 'paytm', paise: 100000, n: 1 }, 'before their start date');
  assert.deepEqual(by('2025-09'), { m: '2025-09', d: D1, app: 'paytm', paise: 12000, n: 1 });
});

test('a database without the delegate tables still answers, with nobody to attribute to', async () => {
  grant('admin');
  db.noDelegateTables = true;
  const res = await call();
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.deepEqual(d.delegates, []);
  assert.ok(d.delegatePayments.every((p) => p.d === null));
});

test('no narration, UPI reference or household name leaves the server', async () => {
  grant('admin');
  const text = await (await call()).text();
  for (const secret of ['Household Nine', 'Corner Shop', 'HARDWARE', '600000000001', 'AXODH']) assert.ok(!text.includes(secret), secret);
});

test('an auditor’s visit is logged, and refused if it cannot be', async () => {
  grant('read_only');
  assert.equal((await call()).status, 200);
  assert.equal(auditRows.length, 1);
  assert.equal(auditRows[0].action, 'finance.channels_viewed');
  grant('read_only');
  failAudit = true;
  assert.equal((await call()).status, 500);
  grant('admin');
  assert.equal((await call()).status, 200);
  assert.equal(auditRows.length, 0, 'ordinary views are not logged');
});
