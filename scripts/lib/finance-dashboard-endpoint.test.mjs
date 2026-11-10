// Run with: node --test scripts/lib/finance-dashboard-endpoint.test.mjs
//
// Drives the real finance-admin Function (GET /api/finance-admin/dashboard) through requireStaff with Google and Supabase
// stubbed. Checks who may read it, that the figures tie to the bank and to the ledger (drafts do not count), that a year with
// no budget, or a database without migration 0098, still answers, and that an auditor's visit is logged and refused if it
// cannot be. Financial year 2025 (April 2025 to March 2026) is used because it is closed whatever day this runs. Every amount is
// invented. Needs `npm ci` (esbuild) and Node 22.18+.
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
const dir = mkdtempSync(join(tmpdir(), 'finance-dashboard-'));
const out = join(dir, 'finance-admin.mjs');
await build({ entryPoints: ['netlify/functions/finance-admin.mts'], bundle: true, platform: 'node', format: 'esm', outfile: out, plugins: [stubGoogle], logLevel: 'silent' });
const { default: handler } = await import(pathToFileURL(out).href);

const RS = 100;
const ID = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const C = { sal: ID(11), groc: ID(12), sink: ID(13), maint: ID(14) };
const L = { in1: ID(31), out1: ID(32), sink1: ID(33), out2: ID(34) };

const seed = () => ({
  fin_bank_lines: [
    { id: L.in1, bank_account_id: 'acc', tran_date: '2025-04-05', direction: 'credit', amount_paise: 2000000 * RS, balance_paise: 3000000 * RS },
    { id: L.out1, bank_account_id: 'acc', tran_date: '2025-04-28', direction: 'debit', amount_paise: 300000 * RS, balance_paise: 2700000 * RS },
    { id: L.sink1, bank_account_id: 'acc', tran_date: '2025-10-03', direction: 'debit', amount_paise: 200000 * RS, balance_paise: 2500000 * RS },
    { id: L.out2, bank_account_id: 'acc', tran_date: '2026-03-10', direction: 'debit', amount_paise: 150000 * RS, balance_paise: 2350000 * RS },
  ],
  fin_allocations: [
    { id: ID(51), bank_line_id: L.in1, category_id: C.maint, project_id: null, amount_paise: 2000000 * RS, period: '2025-04-01', posted_at: '2025-05-01T00:00:00Z' },
    { id: ID(52), bank_line_id: L.out1, category_id: C.sal, project_id: null, amount_paise: 200000 * RS, period: '2025-04-01', posted_at: '2025-05-01T00:00:00Z' },
    { id: ID(53), bank_line_id: L.out1, category_id: C.groc, project_id: null, amount_paise: 100000 * RS, period: '2025-04-01', posted_at: '2025-05-01T00:00:00Z' },
    { id: ID(54), bank_line_id: L.sink1, category_id: C.sink, project_id: null, amount_paise: 200000 * RS, period: '2025-10-01', posted_at: '2025-11-01T00:00:00Z' },
    { id: ID(55), bank_line_id: L.out2, category_id: C.groc, project_id: null, amount_paise: 100000 * RS, period: '2026-03-01', posted_at: '2026-04-01T00:00:00Z' },
    { id: ID(56), bank_line_id: L.out2, category_id: C.groc, project_id: null, amount_paise: 50000 * RS, period: '2026-03-01', posted_at: null }, // a draft: not counted
  ],
  fin_categories: [
    { id: C.sal, name: 'Salaries', type: 'opex', head: 'farm', is_salary: true },
    { id: C.groc, name: 'Groceries', type: 'opex', head: 'farm', is_salary: false },
    { id: C.sink, name: 'Sinking fund deposits', type: 'sinking_fund', head: 'investment', is_salary: false },
    { id: C.maint, name: 'Member maintenance', type: 'member_contribution', head: null, is_salary: false },
  ],
  fin_payment_requests: [{ status: 'approved', bank_line_id: null, amount_paise: 40000 * RS, decided_at: '2026-02-20T05:00:00Z' }],
  fin_upi_lines: [
    { id: ID(71), paid_at: '2025-09-12', direction: 'debit', amount_paise: 1200000, is_circle: true, ignored: false },
    { id: ID(72), paid_at: '2026-02-03', direction: 'debit', amount_paise: 1600000, is_circle: true, ignored: false },
    { id: ID(73), paid_at: '2026-02-04', direction: 'debit', amount_paise: 999999, is_circle: false, ignored: false },
  ],
  fin_budget_years: [{ id: ID(81), financial_year: 2025, version: 1, status: 'approved', approved_on: '2025-04-02' }],
  fin_budget_lines: [
    { id: ID(91), budget_year_id: ID(81), category_id: C.groc, project_id: null, label: 'Groceries', comment: 'Kitchen supplies', annual_paise: 200000 * RS, monthly_paise: null, sort_order: 1 },
    { id: ID(92), budget_year_id: ID(81), category_id: C.sal, project_id: null, label: 'Salary', comment: null, annual_paise: 500000 * RS, monthly_paise: null, sort_order: 2 },
    { id: ID(93), budget_year_id: ID(81), category_id: C.maint, project_id: null, label: 'Maintenance', comment: null, annual_paise: 2000000 * RS, monthly_paise: null, sort_order: 3 },
  ],
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
  if (db.noBudgetTables && table.startsWith('fin_budget')) return new Response('relation does not exist', { status: 404 });
  if (db.noHeadColumn && table === 'fin_categories' && u.searchParams.get('select').includes('head')) return new Response('column does not exist', { status: 400 });
  if (table.startsWith('fin_')) {
    let rows = (db.data[table] ?? []).filter((r) => matches(r, u.searchParams));
    if (db.noHeadColumn && table === 'fin_categories') rows = rows.map(({ head, is_salary, ...rest }) => rest);
    const offset = Number(u.searchParams.get('offset') ?? 0);
    const limit = Math.min(Number(u.searchParams.get('limit') ?? 1000), 1000);
    return json(rows.slice(offset, offset + limit));
  }
  throw new Error(`unexpected fetch ${url}`);
};

const person = (extra = {}) => ({ id: 'u1', email: who, name: 'A', active: true, is_super_admin: false, ...extra });
const reset = (users, roles, extra = {}) => {
  who = `d${++n}@gmail.com`;
  db = { users: users.map((u) => ({ ...u, email: who })), roles, data: seed(), ...extra };
  auditRows = [];
  failAudit = false;
};
const admin = () => reset([person()], [{ staff_id: 'u1', module: 'finance', role: 'admin', scope: null, expires_at: null }]);
const call = (query = '?fy=2025') => handler(new Request(`https://x.test/api/finance-admin/dashboard${query}`, { headers: { authorization: `Bearer ${who}` } }));

test('no finance grant, or only finance-requests, is refused', async () => {
  reset([person()], []);
  assert.equal((await call()).status, 403);
  reset([person()], [{ staff_id: 'u1', module: 'finance-requests', role: 'user', scope: null, expires_at: null }]);
  assert.equal((await call()).status, 403);
});

test('a closed year: cashflow ties to the bank, groups split the money out, drafts are not counted', async () => {
  admin();
  const res = await call();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.fy, 2025);
  assert.equal(body.fyLabel, '2025-26');
  assert.equal(body.closed, true);
  assert.equal(body.asOf, '2026-03-31');
  assert.equal(body.cashflow.length, 12);
  const apr = body.cashflow[0];
  assert.equal(apr.month, '2025-04-01');
  assert.equal(apr.inPaise, 2000000 * RS);
  assert.equal(apr.inMaintenancePaise, 2000000 * RS);
  assert.equal(apr.outByGroup.salary, 200000 * RS);
  assert.equal(apr.outByGroup.farm, 100000 * RS);
  assert.equal(apr.closingPaise, 2700000 * RS);
  assert.equal(body.cashflow[6].outByGroup.sinking, 200000 * RS); // October
  assert.equal(body.cashflow[5].fdPaise, 0); // September, before the deposit
  assert.equal(body.cashflow[6].fdPaise, 200000 * RS); // October: the deposit is in
  assert.equal(body.cashflow[11].fdPaise, 200000 * RS);
  const mar = body.cashflow[11];
  assert.equal(mar.outByGroup.farm, 100000 * RS);
  assert.equal(mar.outByGroup.other, 50000 * RS); // the draft explains nothing yet
  assert.equal(mar.closingPaise, 2350000 * RS);
  for (const m of body.cashflow) assert.equal(Object.values(m.outByGroup).reduce((a, b) => a + b, 0), m.outPaise);
  assert.equal(body.circle, null); // a closed year has no month in progress
});

test('runway: the last six complete months, sinking fund left out, deposits counted separately', async () => {
  admin();
  const { runway } = await (await call()).json();
  assert.equal(runway.monthsUsed, 6);
  assert.equal(runway.averageSpendPaise, 25000 * RS); // 1,50,000 in March over six months
  assert.equal(runway.balancePaise, 2350000 * RS);
  assert.equal(runway.fdPaise, 200000 * RS);
  assert.equal(runway.runwayMonths, 94);
  assert.equal(runway.runwayWithFdMonths, 102);
});

test('budget vs actual: lines, within or over for a closed year, spending with no line, the surplus', async () => {
  admin();
  const { budget } = await (await call()).json();
  assert.equal(budget.hasBudget, true);
  assert.equal(budget.status, 'approved');
  assert.equal(budget.version, 1);
  const byLabel = Object.fromEntries(budget.lines.map((l) => [l.label, l]));
  assert.equal(byLabel.Groceries.actualPaise, 200000 * RS); // 1,00,000 in April and 1,00,000 in March; the draft is out
  assert.equal(byLabel.Groceries.status, 'within');
  assert.equal(byLabel.Salary.actualPaise, 200000 * RS);
  assert.equal(byLabel.Maintenance.actualPaise, 2000000 * RS);
  assert.deepEqual(budget.notBudgeted, [{ head: 'investment', actualPaise: 200000 * RS }]);
  assert.equal(budget.totals.outflowActualPaise, 600000 * RS);
  assert.equal(budget.totals.surplusPaise, 1400000 * RS);
});

test('health and the circle history', async () => {
  admin();
  const body = await (await call()).json();
  assert.deepEqual(body.health.unallocated, { count: 1, oldestDate: '2026-03-10' }); // March's line is only partly explained
  assert.equal(body.health.awaitingBank.count, 1);
  assert.equal(body.health.committedPaise, 40000 * RS);
  assert.deepEqual(body.circleHistory.map((m) => [m.month, m.paise, m.over]), [['2025-09', 1200000, false], ['2026-02', 1600000, true]]);
  assert.equal(body.circleCapPaise, 1500000);
});

test('the year choices run from the first statement year to the current year', async () => {
  admin();
  const { fyOptions } = await (await call()).json();
  assert.ok(fyOptions.length >= 2);
  assert.equal(fyOptions.at(-1), 2025);
  assert.deepEqual([...fyOptions].sort((a, b) => b - a), fyOptions);
});

test('a year with no budget, or a database without the budget tables or head column, still answers', async () => {
  admin();
  db.data.fin_budget_years = [];
  let body = await (await call()).json();
  assert.equal(body.budget.hasBudget, false);
  assert.equal(body.budget.totals.outflowActualPaise, 600000 * RS);

  admin();
  db.noBudgetTables = true;
  db.noHeadColumn = true;
  const res = await call();
  assert.equal(res.status, 200);
  body = await res.json();
  assert.equal(body.budget.hasBudget, false);
  assert.ok(body.cashflow.length === 12); // without heads everything is "other", but it still adds up
  assert.equal(body.cashflow[0].outPaise, 300000 * RS);
});

test('the current year with no statement lines yet is an empty answer, not an error', async () => {
  admin();
  db.data.fin_bank_lines = [];
  db.data.fin_allocations = [];
  const res = await call('');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.hasData, false);
  assert.deepEqual(body.cashflow.filter((m) => m.inPaise || m.outPaise), []);
  assert.equal(body.runway.runwayMonths, null);
});

test('a bad or future year is refused', async () => {
  admin();
  assert.equal((await call('?fy=abc')).status, 400);
  assert.equal((await call('?fy=2999')).status, 400);
});

test('an auditor can read it and the visit is logged; if the log fails the page is refused', async () => {
  reset([person()], [{ staff_id: 'u1', module: 'finance', role: 'read_only', scope: null, expires_at: new Date(Date.now() + 86_400_000).toISOString() }]);
  assert.equal((await call()).status, 200);
  assert.equal(auditRows.length, 1);
  assert.equal(auditRows[0].action, 'finance.dashboard_viewed');
  reset([person()], [{ staff_id: 'u1', module: 'finance', role: 'read_only', scope: null, expires_at: new Date(Date.now() + 86_400_000).toISOString() }]);
  failAudit = true;
  assert.equal((await call()).status, 500);
});

test('the response carries no names, narrations or account details', async () => {
  admin();
  const text = JSON.stringify(await (await call()).json());
  for (const word of ['narration', 'party', 'fingerprint', 'account_number', 'upi_ref']) assert.equal(text.includes(word), false, word);
});
