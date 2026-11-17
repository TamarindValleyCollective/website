// Run with: node --test scripts/lib/finance-payroll-endpoint.test.mjs
//
// The payroll routes through the real finance-admin Function and requireStaff, with Google, Supabase and R2 stubbed by a small
// in-memory database: who may see salaries (the farm manager and two directors, nobody else), the audit entry before every change,
// the step-up for generating and approving, the preparer who can never approve, a stale file regenerated, and that no account
// number appears in any response or audit entry. Needs `npm ci` (esbuild). Invented data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readWorkbook } from './finance-xlsx.mjs';

const stub = (filter, contents) => ({
  name: `stub-${filter}`,
  setup(b) {
    const ns = `stub-${String(filter).replace(/\W/g, '')}`;
    b.onResolve({ filter }, () => ({ path: ns, namespace: ns }));
    b.onLoad({ filter: /.*/, namespace: ns }, () => ({ contents, loader: 'js' }));
  },
});
const dir = mkdtempSync(join(tmpdir(), 'finance-payroll-endpoint-'));
const out = join(dir, 'finance-admin.mjs');
const outCrypto = join(dir, 'crypto.mjs');
await build({
  entryPoints: ['netlify/functions/finance-admin.mts'], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'silent',
  plugins: [
    stub(/google-id-token\.mjs$/, 'export async function verifyGoogleIdToken(t){ return { email: t, hd: t.split("@")[1] }; }'),
    stub(/finance-storage$/, `export async function putFinanceImport(){} export async function deleteFinanceImport(){}
      export async function putFinanceVoucher(){} export async function getFinanceVoucher(){ return null; } export async function deleteFinanceVoucher(){}
      export async function putFinancePayroll(k, b){ globalThis.__files.set(k, b); }
      export async function getFinancePayroll(k){ return globalThis.__files.get(k) ?? null; }`),
  ],
});
await build({ entryPoints: ['netlify/functions/lib/staff-mfa-crypto.ts'], bundle: true, platform: 'node', format: 'esm', outfile: outCrypto, logLevel: 'silent' });
globalThis.__files = new Map();
process.env.SUPABASE_URL = 'https://db.test';
process.env.PUBLIC_GOOGLE_CLIENT_ID = 'client';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
process.env.STAFF_MFA_KEY = randomBytes(32).toString('base64');
process.env.FINANCE_PAYROLL_DEBIT_ACCOUNT = '9000000009';
const { default: handler } = await import(pathToFileURL(out).href);
const crypto = await import(pathToFileURL(outCrypto).href);

const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const nextMonth1 = (() => { const d = new Date(`${today}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1, 1); return d.toISOString().slice(0, 10); })();
const month = (() => { const d = new Date(`${today}T00:00:00Z`); return d.toISOString().slice(0, 7); })();
const uid = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const ENT = uid(9);
const [E1, E2] = [uid(1), uid(2)];
const [PA1, PA2] = [uid(3), uid(4)];
const ACC1 = '1000000001';
const ACC2 = '1000000002';

let db, calls;
const rowsOf = (t) => db[t];
function filterRows(list, u) {
  let r = list;
  for (const [k, v] of u.searchParams) {
    if (['select', 'order', 'limit', 'offset'].includes(k)) continue;
    const m = /^(not\.)?(eq|neq|in|is|lt)\.(.*)$/.exec(v);
    if (!m) continue;
    const [, neg, op, val] = m;
    const test = (row) => {
      const cell = row[k];
      if (op === 'eq') return String(cell) === val;
      if (op === 'neq') return String(cell) !== val;
      if (op === 'lt') return String(cell) < val;
      if (op === 'is') return val === 'null' ? cell == null : cell != null;
      if (op === 'in') return val.replace(/^\(|\)$/g, '').split(',').includes(String(cell));
      return true;
    };
    r = r.filter((row) => (neg ? !test(row) : test(row)));
  }
  return r;
}
// The database's own refusals that the Function relies on.
function dbRules(table, row, before) {
  if (table === 'fin_payment_batches' && row.approved_by && row.approved_by === (before?.prepared_by ?? row.prepared_by)) {
    throw Object.assign(new Error('check'), { check: true });
  }
}
// The column defaults the real tables have.
const DEFAULTS = { fin_payroll_runs: { run_type: 'salary', label: null, status: 'draft', confirmed_by: null, prepared_by: null, batch_id: null, approved_by: null }, fin_payment_batches: { status: 'file_generated' }, fin_employees: { active: true } };
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const table = u.pathname.replace('/rest/v1/', '');
  const method = init.method ?? 'GET';
  calls.push(`${method} ${table}`);
  if (table === 'staff_users') return json(db.users.filter((x) => u.searchParams.get('email') === `eq.${x.email}`));
  if (table === 'staff_module_roles') return json(db.roles.filter((r) => r.staff_id === u.searchParams.get('staff_id')?.slice(3) && r.module === u.searchParams.get('module')?.slice(3)));
  if (table === 'staff_mfa_factors' || table === 'staff_recovery_codes') return json([]);
  if (table === 'fin_audit_log') { db.audit.push(JSON.parse(init.body)); db.order.push(`audit:${JSON.parse(init.body).action}`); return new Response(null, { status: 201 }); }
  if (table === 'fin_entities') return json([{ id: ENT }]);
  if (!(table in db)) throw new Error(`unexpected fetch ${method} ${url}`);
  const list = rowsOf(table);
  if (method === 'GET') return json(filterRows(list, u).map((r) => ({ ...r })));
  if (method === 'POST') {
    const b = JSON.parse(init.body);
    const made = (Array.isArray(b) ? b : [b]).map((r, i) => ({ id: r.id ?? uid(5 + list.length + i), created_at: new Date().toISOString(), ...(DEFAULTS[table] ?? {}), ...r }));
    for (const r of made) {
      if (table === 'fin_employees' && r.roll_no == null) r.roll_no = String(Math.max(0, ...list.filter((x) => x.entity_id === r.entity_id).map((x) => Number(x.roll_no))) + 1);
      if (table === 'fin_employees' && list.some((x) => x.entity_id === r.entity_id && x.roll_no === r.roll_no)) return json({ code: '23505' }, 409);
      if (table === 'fin_payroll_runs' && list.some((x) => x.month === r.month && x.run_type === r.run_type && (x.label ?? '') === (r.label ?? '') && x.status !== 'cancelled')) return json({ code: '23505' }, 409);
      list.push(r);
    }
    db.order.push(`insert:${table}`);
    return init.headers?.Prefer?.includes('representation') ? json(made, 201) : new Response(null, { status: 201 });
  }
  if (method === 'PATCH') {
    const b = JSON.parse(init.body);
    const hit = filterRows(list, u);
    try {
      for (const r of hit) { dbRules(table, { ...r, ...b }, r); }
    } catch {
      return json({ code: '23514' }, 400);
    }
    for (const r of hit) Object.assign(r, b);
    db.order.push(`patch:${table}`);
    return init.headers?.Prefer?.includes('representation') ? json(hit.map((r) => ({ ...r }))) : new Response(null, { status: 204 });
  }
  if (method === 'DELETE') {
    const hit = new Set(filterRows(list, u));
    db[table] = list.filter((r) => !hit.has(r));
    db.order.push(`delete:${table}`);
    return new Response(null, { status: 204 });
  }
  throw new Error(`unexpected fetch ${method} ${url}`);
};

const enc = (account) => crypto.encryptFinanceText(JSON.stringify({ method: 'bank', account, ifsc: 'TEST0000001' }));
// who: 'farm' | 'prep' | 'second' | 'viewer' | 'auditor'
const ROLES = {
  farm: [['finance-requests', 'user']],
  prep: [['finance', 'admin']],
  second: [['finance', 'admin']],
  viewer: [['finance', 'user']],
  auditor: [['finance', 'read_only']],
};
function fresh() {
  db = {
    users: [], roles: [], audit: [], order: [],
    fin_parties: [{ id: uid(6), name: 'Test Person One', kind: 'employee', active: true, merged_into: null }, { id: uid(7), name: 'Test Person Two', kind: 'employee', active: true, merged_into: null }],
    fin_employees: [{ id: E1, entity_id: ENT, party_id: uid(6), roll_no: '1', active: true }, { id: E2, entity_id: ENT, party_id: uid(7), roll_no: '2', active: true }],
    fin_party_accounts: [
      { id: PA1, party_id: uid(6), method: 'bank', status: 'verified', valid_from: null, retired_on: null, fingerprint: 'fp1', last4: '0001', details_enc: enc(ACC1), created_at: '2026-01-01' },
      { id: PA2, party_id: uid(7), method: 'bank', status: 'verified', valid_from: null, retired_on: null, fingerprint: 'fp2', last4: '0002', details_enc: enc(ACC2), created_at: '2026-01-01' },
    ],
    fin_payroll_runs: [], fin_payroll_lines: [], fin_payment_batches: [],
  };
  calls = [];
  globalThis.__files = new Map();
}
const people = {};
const as = (who) => {
  if (!people[who]) {
    const id = `staff-${who}`;
    const email = `${who}@gmail.com`;
    people[who] = { id, email };
  }
  const p = people[who];
  if (!db.users.some((x) => x.id === p.id)) {
    db.users.push({ id: p.id, email: p.email, name: who, active: true, is_super_admin: false });
    for (const [module, role] of ROLES[who]) db.roles.push({ staff_id: p.id, module, role, scope: null, expires_at: null });
  }
  return p.email;
};
const stepUp = (who) => crypto.signStepUp(`staff-${who}`, 'totp', Date.now());
const send = (who, method, path, body, { step = false } = {}) => handler(new Request(`https://x.test/api/finance-admin${path}`, {
  method,
  headers: { authorization: `Bearer ${as(who)}`, ...(body ? { 'content-type': 'application/json' } : {}), ...(step ? { 'x-stepup-token': stepUp(who) } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}));
const lines = [{ employeeId: E1, netRupees: 15000 }, { employeeId: E2, netRupees: 20500 }];
const newRun = async (over = {}) => {
  const res = await send('farm', 'POST', '/payroll/runs', { month, lines, ...over });
  return { res, id: (await res.clone().json()).id };
};
const act = (who, id, action, extra = {}, step = true) => send(who, 'POST', `/payroll/runs/${id}/action`, { action, ...extra }, { step });
const noAccountNumbers = (...things) => {
  const text = things.map((t) => (typeof t === 'string' ? t : JSON.stringify(t))).join(' ');
  assert.ok(!text.includes(ACC1) && !text.includes(ACC2), 'an account number leaked');
};

test('only the farm manager and two directors may open payroll; a finance operator, a viewer and an auditor may not', async () => {
  fresh();
  for (const who of ['farm', 'prep']) assert.equal((await send(who, 'GET', '/payroll')).status, 200, who);
  for (const who of ['viewer', 'auditor']) assert.equal((await send(who, 'GET', '/payroll')).status, 403, who);
  assert.equal((await send('viewer', 'POST', '/payroll/runs', { month, lines })).status, 403);
});

test('a month holds a salary run and a named bonus run; the same bonus name twice is refused, a different name is not', async () => {
  fresh();
  assert.equal((await newRun()).res.status, 201);
  const bonus = { month, runType: 'bonus', label: 'Diwali Bonus', lines };
  assert.equal((await send('farm', 'POST', '/payroll/runs', bonus)).status, 201);
  const made = db.fin_payroll_runs.find((r) => r.run_type === 'bonus');
  assert.equal(made.label, 'Diwali Bonus');
  assert.equal(made.payment_date, new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10), 'a bonus defaults to paying today');
  assert.equal((await send('farm', 'POST', '/payroll/runs', bonus)).status, 409);
  assert.equal((await send('farm', 'POST', '/payroll/runs', { ...bonus, label: 'Pongal Bonus' })).status, 201);
  assert.equal((await send('farm', 'POST', '/payroll/runs', { month, runType: 'bonus', lines })).status, 400, 'a bonus needs a name');
  assert.equal(db.fin_payroll_runs.length, 3);
});

test('the farm manager starts a draft; the audit entry comes before the run; a second run for the month is refused', async () => {
  fresh();
  const { res, id } = await newRun();
  assert.equal(res.status, 201);
  assert.ok(db.order.indexOf('audit:finance.payroll_run_created') < db.order.indexOf('insert:fin_payroll_runs'));
  assert.equal(db.fin_payroll_lines.length, 2);
  assert.equal(db.fin_payroll_runs[0].entered_by, 'staff-farm');
  assert.equal((await send('farm', 'POST', '/payroll/runs', { month, lines })).status, 409);
  assert.ok(id);
});

test('a director cannot start or change a run: entering salaries is the farm manager\'s', async () => {
  fresh();
  assert.equal((await send('prep', 'POST', '/payroll/runs', { month, lines })).status, 403);
});

test('amounts with paise, a person twice, or a person not on payroll are refused', async () => {
  fresh();
  assert.equal((await send('farm', 'POST', '/payroll/runs', { month, lines: [{ employeeId: E1, netRupees: 100.5 }] })).status, 400);
  assert.equal((await send('farm', 'POST', '/payroll/runs', { month, lines: [{ employeeId: E1, netRupees: 1 }, { employeeId: E1, netRupees: 2 }] })).status, 400);
  assert.equal((await send('farm', 'POST', '/payroll/runs', { month, lines: [{ employeeId: uid(8), netRupees: 1 }] })).status, 400);
  assert.equal(db.fin_payroll_runs.length, 0);
});

test('the run detail shows each account as last four digits and never a number', async () => {
  fresh();
  const { id } = await newRun();
  const res = await send('prep', 'GET', `/payroll/runs/${id}`);
  const body = await res.json();
  assert.deepEqual(body.lines.map((l) => [l.name, l.last4, l.netPaise]), [['Test Person One', '0001', 1_500_000], ['Test Person Two', '0002', 2_050_000]]);
  assert.equal(body.totalPaise, 3_550_000);
  noAccountNumbers(body);
});

test('the farm manager confirms; only a director generates the file', async () => {
  fresh();
  const { id } = await newRun();
  assert.equal((await act('farm', id, 'generate')).status, 403);
  { const r = await act('farm', id, 'confirm', {}, false); assert.equal(r.status, 200, JSON.stringify(await r.json())); }
  assert.equal(db.fin_payroll_runs[0].status, 'confirmed');
  assert.equal((await act('farm', id, 'generate')).status, 403);
});

test('generating needs the step-up, writes the audit entry first, stores the file and a snapshot, and leaks no account number', async () => {
  fresh();
  const { id } = await newRun();
  await act('farm', id, 'confirm', {}, false);
  const noStep = await act('prep', id, 'generate', {}, false);
  assert.equal(noStep.status, 403);
  assert.equal((await noStep.json()).code, 'STEP_UP_REQUIRED');
  assert.equal(db.fin_payment_batches.length, 0);
  const res = await act('prep', id, 'generate');
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.ok(db.order.indexOf('audit:finance.payroll_generate') < db.order.indexOf('insert:fin_payment_batches'));
  const run = db.fin_payroll_runs[0];
  assert.equal(run.status, 'file_generated');
  assert.equal(run.prepared_by, 'staff-prep');
  assert.equal(db.fin_payment_batches[0].total_paise, 3_550_000);
  assert.deepEqual(db.fin_payroll_lines.map((l) => [l.account_last4, l.account_fingerprint]), [['0001', 'fp1'], ['0002', 'fp2']]);
  assert.match(db.fin_payroll_lines[0].reference, /^\d{4}-[A-Z][a-z]{2}-Employee-001$/);
  const file = readWorkbook([...globalThis.__files.values()][0])[0].rows;
  assert.equal(file.length, 2);
  assert.equal(file[0][7], 9000000009);
  assert.equal(file[0][4], Number(ACC1));
  noAccountNumbers(body, db.audit);
});

test('an unverified payee account blocks the file, names the person, and nothing is stored', async () => {
  fresh();
  db.fin_party_accounts[1].status = 'unverified';
  const { id } = await newRun();
  await act('farm', id, 'confirm', {}, false);
  const res = await act('prep', id, 'generate');
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.match(body.blockers[0], /Test Person Two.*not verified/i);
  assert.equal(db.fin_payment_batches.length, 0);
  assert.equal(db.fin_payroll_runs[0].status, 'confirmed');
  assert.equal(globalThis.__files.size, 0);
});

test('without the debit account setting the file is not made', async () => {
  fresh();
  const { id } = await newRun();
  await act('farm', id, 'confirm', {}, false);
  const keep = process.env.FINANCE_PAYROLL_DEBIT_ACCOUNT;
  delete process.env.FINANCE_PAYROLL_DEBIT_ACCOUNT;
  const res = await act('prep', id, 'generate');
  process.env.FINANCE_PAYROLL_DEBIT_ACCOUNT = keep;
  assert.equal(res.status, 500);
  assert.equal(db.fin_payment_batches.length, 0);
});

async function generated() {
  fresh();
  const { id } = await newRun();
  await act('farm', id, 'confirm', {}, false);
  await act('prep', id, 'generate');
  return id;
}

test('the preparer can never approve; another director can, after the file is marked uploaded, with the step-up', async () => {
  const id = await generated();
  assert.equal((await act('second', id, 'approve')).status, 403, 'not uploaded yet');
  assert.equal((await act('prep', id, 'mark_uploaded', {}, false)).status, 200);
  const own = await act('prep', id, 'approve');
  assert.equal(own.status, 403);
  assert.match((await own.json()).error, /prepared/i);
  assert.equal(db.fin_payroll_runs[0].status, 'file_generated');
  const noStep = await act('second', id, 'approve', {}, false);
  assert.equal((await noStep.json()).code, 'STEP_UP_REQUIRED');
  const ok = await act('second', id, 'approve');
  assert.equal(ok.status, 200, JSON.stringify(await ok.clone().json()));
  assert.equal(db.fin_payroll_runs[0].status, 'approved');
  assert.equal(db.fin_payment_batches[0].status, 'approved_at_bank');
  assert.equal(db.fin_payment_batches[0].approved_by, 'staff-second');
});

test('a file not used by its payment date goes stale and is regenerated with a new date; the old batch is cancelled', async () => {
  const id = await generated();
  db.fin_payroll_runs[0].payment_date = '2020-01-01';
  const detail = await (await send('prep', 'GET', `/payroll/runs/${id}`)).json();
  assert.equal(detail.run.stale, true);
  assert.equal((await act('prep', id, 'regenerate', {}, false)).status, 200);
  assert.equal(db.fin_payroll_runs[0].status, 'confirmed');
  assert.equal(db.fin_payment_batches[0].status, 'cancelled');
  assert.equal(db.fin_payroll_runs[0].batch_id, null);
  const past = await act('prep', id, 'generate', { paymentDate: '2020-01-02' });
  assert.equal(past.status, 400);
  const again = await act('prep', id, 'generate', { paymentDate: nextMonth1 });
  assert.equal(again.status, 200, JSON.stringify(await again.clone().json()));
  assert.equal(db.fin_payroll_runs[0].status, 'file_generated');
  assert.equal(db.fin_payroll_runs[0].payment_date, nextMonth1);
  assert.equal(db.fin_payment_batches.length, 2);
  assert.equal(db.fin_payment_batches[1].status, 'file_generated');
});

test('an account that changed since the last run is let through (verified) and reported as changed', async () => {
  fresh();
  const earlier = { id: uid(8), entity_id: ENT, month: '2020-01-01', status: 'settled' };
  db.fin_payroll_runs.push(earlier);
  db.fin_payroll_lines.push({ id: uid(7), run_id: earlier.id, employee_id: E1, net_paise: 100, account_fingerprint: 'OLD' });
  const { id } = await newRun();
  const detail = await (await send('farm', 'GET', `/payroll/runs/${id}`)).json();
  assert.deepEqual(detail.lines.map((l) => l.changed), [true, false]);
  assert.equal(detail.changed, 1);
  await act('farm', id, 'confirm', {}, false);
  const res = await act('prep', id, 'generate');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).changed.length, 1);
});

test('the file downloads for a preparer behind the step-up, is logged, and is the file that was made', async () => {
  const id = await generated();
  assert.equal((await send('prep', 'GET', `/payroll/runs/${id}/file`)).status, 403);
  assert.equal((await send('farm', 'GET', `/payroll/runs/${id}/file`, null, { step: true })).status, 403);
  const res = await send('prep', 'GET', `/payroll/runs/${id}/file`, null, { step: true });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /salary-\d{4}-\d{2}\.xlsx/);
  assert.equal(readWorkbook(new Uint8Array(await res.arrayBuffer()))[0].rows.length, 2);
  assert.ok(db.audit.some((a) => a.action === 'finance.payroll_file_downloaded'));
});

test('a draft can be edited by the farm manager, but not once confirmed', async () => {
  fresh();
  const { id } = await newRun();
  assert.equal((await send('farm', 'PUT', `/payroll/runs/${id}`, { lines: [{ employeeId: E1, netRupees: 16000 }] })).status, 200);
  assert.deepEqual(db.fin_payroll_lines.map((l) => l.net_paise), [1_600_000]);
  await act('farm', id, 'confirm', {}, false);
  assert.equal((await send('farm', 'PUT', `/payroll/runs/${id}`, { lines })).status, 400);
});

test('cancelling needs a reason and is refused once approved', async () => {
  fresh();
  const { id } = await newRun();
  assert.equal((await act('farm', id, 'cancel', {}, false)).status, 400);
  assert.equal((await act('farm', id, 'cancel', { reason: 'Wrong month' }, false)).status, 200);
  assert.equal(db.fin_payroll_runs[0].status, 'cancelled');
  const id2 = await generated();
  await act('prep', id2, 'mark_uploaded', {}, false);
  await act('second', id2, 'approve');
  assert.equal((await act('prep', id2, 'cancel', { reason: 'Changed my mind' }, false)).status, 403);
});

test('adding a person to payroll is a director\'s act, and only for a party of kind employee', async () => {
  fresh();
  db.fin_parties.push({ id: uid(8), name: 'Test Vendor', kind: 'vendor', active: true, merged_into: null });
  db.fin_parties.push({ id: uid(5), name: 'Test Person Three', kind: 'employee', active: true, merged_into: null });
  assert.equal((await send('farm', 'POST', '/payroll/employees', { partyId: uid(5) })).status, 403);
  assert.equal((await send('prep', 'POST', '/payroll/employees', { partyId: uid(8) })).status, 400);
  const added = await send('prep', 'POST', '/payroll/employees', { partyId: uid(5) });
  assert.equal(added.status, 201);
  assert.equal((await added.json()).rollNo, '3', 'the next number up is assigned');
  const list = await (await send('prep', 'GET', '/payroll')).json();
  assert.equal(list.employees.length, 3);
  assert.deepEqual(list.candidates, []);
});

test('employee numbers are given once and never reused: the next is above the highest, an old number can be carried over, a taken one cannot', async () => {
  fresh();
  db.fin_employees.find((e) => e.roll_no === '2').active = false;
  db.fin_parties.push({ id: uid(5), name: 'Test Person Three', kind: 'employee', active: true, merged_into: null });
  db.fin_parties.push({ id: uid(8), name: 'Test Person Four', kind: 'employee', active: true, merged_into: null });
  db.fin_parties.push({ id: uid(9), name: 'Test Person Five', kind: 'employee', active: true, merged_into: null });
  assert.equal((await send('prep', 'POST', '/payroll/employees', { partyId: uid(5), rollNo: '12' })).status, 201, 'a number carried over from an old file');
  assert.equal((await (await send('prep', 'POST', '/payroll/employees', { partyId: uid(8) })).json()).rollNo, '13', 'the next is above the highest');
  assert.equal((await send('prep', 'POST', '/payroll/employees', { partyId: uid(9), rollNo: '12' })).status, 409, 'a taken number is refused');
  assert.equal((await send('prep', 'POST', '/payroll/employees', { partyId: uid(9), rollNo: 'x1' })).status, 400);
});
