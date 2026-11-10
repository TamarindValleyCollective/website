// Run with: node --test scripts/lib/finance-budget-endpoint.test.mjs
//
// Drives the real finance-admin Function (the budget editor's routes) through requireStaff with Google and Supabase stubbed. The fake
// database re-implements the rules of the three database functions (0098/0099), which are tested separately against the real
// database in a rolled-back transaction; what is tested here is the application: who may read and who may change, what a bad save
// does (nothing), that every write is audited first and the audit holds no labels or amounts, and that a database without the
// budget tables still answers. Every name and amount is invented. Needs `npm ci` (esbuild) and Node 22.18+.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { financialYearOf } from './finance-allocation.mjs';
import { todayIST } from './finance-parties.mjs';

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
const dir = mkdtempSync(join(tmpdir(), 'finance-budget-'));
const out = join(dir, 'finance-admin.mjs');
await build({ entryPoints: ['netlify/functions/finance-admin.mts'], bundle: true, platform: 'node', format: 'esm', outfile: out, plugins: [stubGoogle], logLevel: 'silent' });
const { default: handler } = await import(pathToFileURL(out).href);

const RS = 100;
const FY = financialYearOf(todayIST());
const ID = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const E = ID(1);
const C = { groc: ID(11), sal: ID(12), fees: ID(13), stay: ID(14), maint: ID(15), old: ID(16) };
const P = { water: ID(21), fair: ID(22) };
const Y = { liveThis: ID(31), livePrev: ID(32) };

const seed = () => ({
  fin_entities: [{ id: E, name: 'Test Entity', created_at: '2026-01-01' }],
  fin_categories: [
    { id: C.groc, name: 'Groceries', type: 'opex', head: 'farm', is_salary: false, active: true },
    { id: C.sal, name: 'Salaries', type: 'opex', head: 'farm', is_salary: true, active: true },
    { id: C.fees, name: 'Professional fees', type: 'opex', head: 'company', is_salary: false, active: true },
    { id: C.stay, name: 'Guest stays', type: 'revenue', head: null, is_salary: false, active: true },
    { id: C.maint, name: 'Member maintenance', type: 'member_contribution', head: null, is_salary: false, active: true },
    { id: C.old, name: 'Retired category', type: 'opex', head: 'farm', is_salary: false, active: false },
  ],
  fin_projects: [
    { id: P.water, entity_id: E, name: 'Water storage', kind: 'project', financial_year: FY, status: 'approved' },
    { id: P.fair, entity_id: E, name: 'A fair', kind: 'event', financial_year: FY, status: 'active' },
  ],
  fin_budget_years: [
    { id: Y.livePrev, entity_id: E, financial_year: FY - 1, version: 1, status: 'approved', approved_on: `${FY - 1}-04-02`, note: null, created_at: '2025-04-01' },
    { id: Y.liveThis, entity_id: E, financial_year: FY, version: 1, status: 'approved', approved_on: `${FY}-04-02`, note: 'First plan', created_at: `${FY}-04-01` },
  ],
  fin_budget_lines: [
    { id: ID(41), budget_year_id: Y.livePrev, category_id: C.groc, project_id: null, label: 'Groceries', comment: null, annual_paise: 100000 * RS, monthly_paise: null, sort_order: 1 },
    { id: ID(42), budget_year_id: Y.livePrev, category_id: C.sal, project_id: null, label: 'Salary', comment: null, annual_paise: 500000 * RS, monthly_paise: null, sort_order: 2 },
    { id: ID(43), budget_year_id: Y.liveThis, category_id: C.groc, project_id: null, label: 'Groceries', comment: 'Kitchen supplies', annual_paise: 120000 * RS, monthly_paise: null, sort_order: 1 },
    { id: ID(44), budget_year_id: Y.liveThis, category_id: C.sal, project_id: null, label: 'Salary', comment: null, annual_paise: 600000 * RS, monthly_paise: null, sort_order: 2 },
    { id: ID(45), budget_year_id: Y.liveThis, category_id: null, project_id: P.water, label: 'Water', comment: null, annual_paise: 150000 * RS, monthly_paise: null, sort_order: 3 },
  ],
  fin_bank_lines: [{ id: ID(51), direction: 'debit' }],
  fin_allocations: [{ id: ID(61), bank_line_id: ID(51), category_id: C.groc, project_id: null, amount_paise: 40000 * RS, period: `${FY}-05-01`, posted_at: '2026-06-01T00:00:00Z' }],
});

let db;
let n = 0;
let who;
let failAudit;
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
    else if (op === 'gte') ok = String(cell) >= val;
    else if (op === 'lt') ok = String(cell) < val;
    else ok = true;
    if (negate ? ok : !ok) return false;
  }
  return true;
};
let nextId = 900;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const j = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const method = init.method ?? 'GET';
  const table = u.pathname.replace('/rest/v1/', '');
  const body = init.body ? JSON.parse(init.body) : null;
  if (table === 'staff_users') return j(db.users.filter((x) => u.searchParams.get('email') === `eq.${x.email}`));
  if (table === 'staff_module_roles') {
    const id = u.searchParams.get('staff_id')?.slice(3);
    const mod = u.searchParams.get('module')?.slice(3);
    return j(db.roles.filter((r) => r.staff_id === id && r.module === mod).map(({ role, scope, expires_at }) => ({ role, scope, expires_at })));
  }
  if (table === 'staff_mfa_factors' || table === 'staff_recovery_codes') return j([]);
  if (table === 'fin_audit_log' && method === 'POST') {
    if (failAudit) return new Response('boom', { status: 500 });
    db.audit.push(body);
    return new Response(null, { status: 201 });
  }
  if (db.noBudgetTables && table.startsWith('fin_budget')) return new Response('relation does not exist', { status: 404 });
  if (db.noEditingFunctions && (table === 'rpc/fin_start_budget_draft' || table === 'rpc/fin_save_budget_lines')) return new Response('function not found', { status: 404 });
  if (table === 'rpc/fin_start_budget_draft') {
    if (db.fin_budget_years.some((y) => y.entity_id === body.p_entity && y.financial_year === body.p_fy && y.status === 'draft')) return new Response('duplicate key', { status: 409 });
    const version = Math.max(0, ...db.fin_budget_years.filter((y) => y.entity_id === body.p_entity && y.financial_year === body.p_fy).map((y) => y.version)) + 1;
    const id = ID(++nextId);
    db.fin_budget_years.push({ id, entity_id: body.p_entity, financial_year: body.p_fy, version, status: 'draft', approved_on: null, note: null, created_at: 'now' });
    if (body.p_from) {
      const src = db.fin_budget_years.find((y) => y.id === body.p_from);
      for (const l of db.fin_budget_lines.filter((x) => x.budget_year_id === body.p_from && (src.financial_year === body.p_fy || x.project_id === null))) db.fin_budget_lines.push({ ...l, id: ID(++nextId), budget_year_id: id });
    }
    return j(id);
  }
  if (table === 'rpc/fin_save_budget_lines') {
    const yr = db.fin_budget_years.find((y) => y.id === body.p_year_id);
    if (!yr || yr.status !== 'draft') return new Response('only a draft can be edited', { status: 400 });
    db.fin_budget_lines = db.fin_budget_lines.filter((l) => l.budget_year_id !== body.p_year_id);
    for (const l of body.p_lines) db.fin_budget_lines.push({ id: ID(++nextId), budget_year_id: body.p_year_id, monthly_paise: null, ...l });
    yr.note = body.p_note;
    db.saves.push(body);
    return j(body.p_lines.length);
  }
  if (table === 'rpc/fin_approve_budget') {
    const yr = db.fin_budget_years.find((y) => y.id === body.p_year_id);
    for (const o of db.fin_budget_years.filter((y) => y.entity_id === yr.entity_id && y.financial_year === yr.financial_year && y.status === 'approved')) o.status = 'superseded';
    yr.status = 'approved';
    yr.approved_on = '2026-11-10';
    return j(null);
  }
  if (table === 'fin_budget_years' && method === 'DELETE') {
    const gone = db.fin_budget_years.filter((r) => matches(r, u.searchParams));
    db.fin_budget_years = db.fin_budget_years.filter((r) => !gone.includes(r));
    db.fin_budget_lines = db.fin_budget_lines.filter((l) => !gone.some((g) => g.id === l.budget_year_id));
    return j(gone);
  }
  if (table === 'fin_categories' && method === 'PATCH') {
    const hit = db.fin_categories.filter((r) => matches(r, u.searchParams));
    hit.forEach((r) => Object.assign(r, body));
    db.patches.push(body);
    return j(hit);
  }
  if (table.startsWith('fin_') && method === 'GET') {
    const rows = (db[table] ?? []).filter((r) => matches(r, u.searchParams));
    // Like PostgREST: order=a.desc,b.asc sorts by each key in turn.
    const keys = (u.searchParams.get('order') ?? '').split(',').filter(Boolean).map((k) => k.split('.'));
    rows.sort((x, y) => { for (const [col, dir] of keys) { if (x[col] === y[col]) continue; return (x[col] < y[col] ? -1 : 1) * (dir === 'desc' ? -1 : 1); } return 0; });
    const offset = Number(u.searchParams.get('offset') ?? 0);
    const limit = Math.min(Number(u.searchParams.get('limit') ?? 1000), 1000);
    return j(rows.slice(offset, offset + limit));
  }
  throw new Error(`unexpected fetch ${method} ${url}`);
};

const person = (extra = {}) => ({ id: 'u1', email: who, name: 'A', active: true, is_super_admin: false, ...extra });
const reset = (role = 'admin') => {
  who = `b${++n}@gmail.com`;
  db = { users: [person()], roles: [{ staff_id: 'u1', module: 'finance', role, scope: null, expires_at: role === 'read_only' ? new Date(Date.now() + 86_400_000).toISOString() : null }], audit: [], saves: [], patches: [], ...seed() };
  failAudit = false;
};
const call = (path, { method = 'GET', body } = {}) => handler(new Request(`https://x.test/api/finance-admin${path}`, {
  method, headers: { authorization: `Bearer ${who}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
}));
const lines = (...rows) => rows.map(([categoryId, projectId, label, annualPaise, comment = null]) => ({ categoryId, projectId, label, annualPaise, comment }));
const draftId = () => db.fin_budget_years.find((y) => y.status === 'draft')?.id;

test('no finance grant is refused; an auditor and a finance user can read but not change', async () => {
  who = `b${++n}@gmail.com`;
  db = { users: [person()], roles: [], audit: [], saves: [], patches: [], ...seed() };
  assert.equal((await call('/budget')).status, 403);
  for (const role of ['read_only', 'user']) {
    reset(role);
    const res = await call(`/budget?fy=${FY}`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).canConfigure, false);
    assert.equal((await call('/budget/versions', { method: 'POST', body: { fy: FY, from: 'empty' } })).status, 403);
    assert.equal((await call(`/budget/versions/${Y.liveThis}/approve`, { method: 'POST' })).status, 403);
    assert.equal((await call(`/budget/versions/${Y.liveThis}/lines`, { method: 'POST', body: { lines: [] } })).status, 403);
    assert.equal((await call(`/budget/versions/${Y.liveThis}/discard`, { method: 'POST' })).status, 403);
  }
  assert.equal(db.audit.length, 0); // reading the editor is not audited; nothing was written
});

test('reading a year: versions, the lines of the live one, what to choose from, what has been spent, last year\'s amounts', async () => {
  reset();
  const body = await (await call(`/budget?fy=${FY}`)).json();
  assert.equal(body.available, true);
  assert.equal(body.canConfigure, true);
  assert.equal(body.fy, FY);
  assert.deepEqual(body.versions.map((v) => [v.version, v.status]), [[1, 'approved']]);
  assert.equal(body.selected.id, Y.liveThis);
  assert.equal(body.lines.length, 3);
  assert.equal(body.lines[0].comment, 'Kitchen supplies');
  assert.equal(body.categories.length, 6);
  assert.deepEqual(body.projects.map((p) => p.name), ['A fair', 'Water storage']); // by name, like the real API
  assert.equal(body.actuals.byCategory[C.groc], 40000 * RS);
  assert.deepEqual(body.previous, { fy: FY - 1, version: 1, byCategory: { [C.groc]: 100000 * RS, [C.sal]: 500000 * RS } });
});

test('a draft is the one shown first, and another version can be asked for', async () => {
  reset();
  const id = await (await call('/budget/versions', { method: 'POST', body: { fy: FY, from: 'live' } })).json().then((b) => b.id);
  let body = await (await call(`/budget?fy=${FY}`)).json();
  assert.equal(body.selected.id, id);
  assert.equal(body.selected.status, 'draft');
  assert.deepEqual(body.versions.map((v) => v.version), [2, 1]);
  body = await (await call(`/budget?fy=${FY}&v=${Y.liveThis}`)).json();
  assert.equal(body.selected.id, Y.liveThis);
});

test('a year with no budget is an empty answer; a bad year is refused', async () => {
  reset();
  const body = await (await call(`/budget?fy=${FY + 1}`)).json();
  assert.equal(body.selected, null);
  assert.deepEqual(body.lines, []);
  assert.equal((await call('/budget?fy=abc')).status, 400);
  assert.equal((await call(`/budget?fy=${FY + 2}`)).status, 400);
  assert.equal((await call('/budget?fy=2010')).status, 400);
});

test('without the budget tables the editor says it is not available instead of failing', async () => {
  reset();
  db.noBudgetTables = true;
  const res = await call('/budget');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).available, false);
});

test('starting a draft from the live budget, last year, or nothing; one draft at a time', async () => {
  reset();
  let res = await call('/budget/versions', { method: 'POST', body: { fy: FY, from: 'live' } });
  assert.equal(res.status, 201);
  assert.equal(db.fin_budget_lines.filter((l) => l.budget_year_id === draftId()).length, 3);
  res = await call('/budget/versions', { method: 'POST', body: { fy: FY, from: 'empty' } });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).id, draftId());
  assert.deepEqual(db.audit.map((a) => a.action), ['finance.budget_draft_started']);

  reset();
  res = await call('/budget/versions', { method: 'POST', body: { fy: FY, from: 'previous' } });
  assert.equal(res.status, 201);
  assert.equal(db.fin_budget_lines.filter((l) => l.budget_year_id === draftId()).length, 2); // last year's two category lines

  reset();
  res = await call('/budget/versions', { method: 'POST', body: { fy: FY + 1, from: 'empty' } });
  assert.equal(res.status, 201);
  assert.equal(db.fin_budget_lines.filter((l) => l.budget_year_id === draftId()).length, 0);
});

test('starting from a live budget that does not exist is refused and writes nothing; last year\'s can start next year\'s', async () => {
  reset();
  const res = await call('/budget/versions', { method: 'POST', body: { fy: FY + 1, from: 'live' } }); // next year has no approved budget yet
  assert.equal(res.status, 409);
  assert.equal(db.fin_budget_years.filter((y) => y.status === 'draft').length, 0);
  assert.equal(db.audit.length, 0);
  const next = await call('/budget/versions', { method: 'POST', body: { fy: FY + 1, from: 'previous' } }); // this year's live budget is next year's "last year"
  assert.equal(next.status, 201);
  assert.equal(db.fin_budget_lines.filter((l) => l.budget_year_id === draftId()).length, 2); // its two category lines; the project line is this year's only
});

test('bad start requests', async () => {
  reset();
  for (const bad of [{}, { fy: 'x', from: 'empty' }, { fy: FY, from: 'nothing' }, { fy: FY + 5, from: 'empty' }, { fy: 2001, from: 'empty' }]) {
    assert.equal((await call('/budget/versions', { method: 'POST', body: bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal(db.audit.length, 0);
  assert.equal(db.fin_budget_years.filter((y) => y.status === 'draft').length, 0);
});

test('saving replaces the lines, trims the text, and writes an audit entry that holds no label or amount', async () => {
  reset();
  await call('/budget/versions', { method: 'POST', body: { fy: FY, from: 'live' } });
  const id = draftId();
  const res = await call(`/budget/versions/${id}/lines`, { method: 'POST', body: { lines: lines([C.groc, null, '  Groceries and tea ', 130000 * RS, ' Kitchen '], [C.stay, null, '', 80000 * RS], [null, P.water, 'Tank', 150000 * RS]), note: ' Revised ' } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).saved, 3);
  const saved = db.fin_budget_lines.filter((l) => l.budget_year_id === id);
  assert.deepEqual(saved.map((l) => [l.label, l.comment, l.annual_paise, l.sort_order]), [['Groceries and tea', 'Kitchen', 130000 * RS, 1], ['Guest stays', null, 80000 * RS, 2], ['Tank', null, 150000 * RS, 3]]);
  assert.equal(db.fin_budget_years.find((y) => y.id === id).note, 'Revised');
  const entry = db.audit.find((a) => a.action === 'finance.budget_saved');
  assert.deepEqual(entry.detail, { fy: FY, version: 2, lines: 3 });
  const text = JSON.stringify(db.audit);
  for (const secret of ['Groceries and tea', 'Kitchen', 'Tank', '13000000', 'Revised']) assert.equal(text.includes(secret), false, secret);
});

test('a bad save changes nothing and says which lines to fix', async () => {
  reset();
  await call('/budget/versions', { method: 'POST', body: { fy: FY, from: 'live' } });
  const id = draftId();
  const before = JSON.stringify(db.fin_budget_lines.filter((l) => l.budget_year_id === id));
  const res = await call(`/budget/versions/${id}/lines`, { method: 'POST', body: { lines: lines([C.groc, null, 'a', 1], [C.groc, null, 'dup', 1], [ID(99), null, 'unknown', 1], [C.old, null, 'retired', 1], [null, P.fair, 'event', 1], [C.fees, null, 'neg', -5]) } });
  assert.equal(res.status, 400);
  const { errors } = await res.json();
  assert.deepEqual(errors.map((e) => e.index), [1, 2, 3, 4, 5]);
  assert.equal(JSON.stringify(db.fin_budget_lines.filter((l) => l.budget_year_id === id)), before);
  assert.equal(db.saves.length, 0);
  assert.equal(db.audit.some((a) => a.action === 'finance.budget_saved'), false);
});

test('if the audit entry cannot be written nothing is saved', async () => {
  reset();
  await call('/budget/versions', { method: 'POST', body: { fy: FY, from: 'live' } });
  failAudit = true;
  const res = await call(`/budget/versions/${draftId()}/lines`, { method: 'POST', body: { lines: lines([C.groc, null, 'x', 5]) } });
  assert.equal(res.status, 500);
  assert.equal(db.saves.length, 0);
});

test('an approved version cannot be saved, approved again or discarded; an unknown one is a 404', async () => {
  reset();
  assert.equal((await call(`/budget/versions/${Y.liveThis}/lines`, { method: 'POST', body: { lines: [] } })).status, 409);
  assert.equal((await call(`/budget/versions/${Y.liveThis}/approve`, { method: 'POST' })).status, 409);
  assert.equal((await call(`/budget/versions/${Y.liveThis}/discard`, { method: 'POST' })).status, 409);
  assert.equal((await call(`/budget/versions/${ID(999)}/approve`, { method: 'POST' })).status, 404);
  assert.equal((await call('/budget/versions/not-an-id/approve', { method: 'POST' })).status, 404);
  assert.equal(db.fin_budget_years.find((y) => y.id === Y.liveThis).status, 'approved');
});

test('too long a note is refused', async () => {
  reset();
  await call('/budget/versions', { method: 'POST', body: { fy: FY, from: 'empty' } });
  assert.equal((await call(`/budget/versions/${draftId()}/lines`, { method: 'POST', body: { lines: [], note: 'n'.repeat(301) } })).status, 400);
});

test('approving: an empty draft is refused; a draft with lines becomes the live budget and the old one is superseded', async () => {
  reset();
  await call('/budget/versions', { method: 'POST', body: { fy: FY, from: 'empty' } });
  assert.equal((await call(`/budget/versions/${draftId()}/approve`, { method: 'POST' })).status, 409);
  await call(`/budget/versions/${draftId()}/lines`, { method: 'POST', body: { lines: lines([C.groc, null, 'G', 5000 * RS]) } });
  const id = draftId();
  const res = await call(`/budget/versions/${id}/approve`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(db.fin_budget_years.find((y) => y.id === id).status, 'approved');
  assert.equal(db.fin_budget_years.find((y) => y.id === Y.liveThis).status, 'superseded');
  const entry = db.audit.find((a) => a.action === 'finance.budget_approved');
  assert.deepEqual(entry.detail, { fy: FY, version: 2 });
  const after = await (await call(`/budget?fy=${FY}`)).json();
  assert.equal(after.selected.id, id);
  assert.equal(after.lines.length, 1);
});

test('discarding removes a draft and its lines and leaves the live budget alone', async () => {
  reset();
  await call('/budget/versions', { method: 'POST', body: { fy: FY, from: 'live' } });
  const id = draftId();
  const res = await call(`/budget/versions/${id}/discard`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(draftId(), undefined);
  assert.equal(db.fin_budget_lines.some((l) => l.budget_year_id === id), false);
  assert.equal(db.fin_budget_years.find((y) => y.id === Y.liveThis).status, 'approved');
  assert.ok(db.audit.some((a) => a.action === 'finance.budget_discarded'));
});

test('a category\'s head and salary flag are set where categories are edited, by someone who may configure', async () => {
  reset();
  let res = await call(`/categories/${C.fees}`, { method: 'PATCH', body: { head: 'farm', isSalary: false } });
  assert.equal(res.status, 200);
  assert.deepEqual(db.patches.at(-1), { head: 'farm', is_salary: false });
  res = await call(`/categories/${C.fees}`, { method: 'PATCH', body: { head: null } });
  assert.equal(res.status, 200);
  assert.equal(db.fin_categories.find((c) => c.id === C.fees).head, null);
  assert.equal((await call(`/categories/${C.fees}`, { method: 'PATCH', body: { head: 'sinking' } })).status, 400);
  assert.equal((await call(`/categories/${C.fees}`, { method: 'PATCH', body: {} })).status, 400);
  assert.equal(db.audit.filter((a) => a.action === 'finance.category_changed').length, 2);
  reset('user');
  assert.equal((await call(`/categories/${C.fees}`, { method: 'PATCH', body: { head: 'farm' } })).status, 403);
});

test('when migration 0099 is not applied, starting or saving says so instead of "Server error", and changes nothing', async () => {
  reset();
  db.noEditingFunctions = true;
  let res = await call('/budget/versions', { method: 'POST', body: { fy: FY, from: 'empty' } });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /migration 0099/);
  assert.equal(db.fin_budget_years.filter((y) => y.status === 'draft').length, 0);
  // a save to an existing draft is told the same
  reset();
  db.fin_budget_years.push({ id: ID(77), entity_id: E, financial_year: FY + 1, version: 1, status: 'draft', approved_on: null, note: null, created_at: 'now' });
  db.noEditingFunctions = true;
  res = await call(`/budget/versions/${ID(77)}/lines`, { method: 'POST', body: { lines: lines([C.groc, null, 'x', 5]) } });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /migration 0099/);
  // reading still works without it
  assert.equal((await call(`/budget?fy=${FY}`)).status, 200);
});
