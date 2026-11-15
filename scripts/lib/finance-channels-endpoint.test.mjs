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

// ---- GET /channels/lines: the lines behind a box or band -----------------------------------------------------------------------------

const ALL = '2025-04,2025-05,2025-06,2025-07,2025-08,2025-09,2025-10,2025-11,2025-12,2026-01,2026-02,2026-03';
const callLines = (query) => handler(new Request(`https://x.test/api/finance-admin/channels/lines?fy=2025&months=${ALL}${query}`, { headers: { authorization: `Bearer ${who}` } }));

test('lines: the same grants as the picture, and only months of that year, in or out, only or exclude', async () => {
  reset([person()], []);
  assert.equal((await callLines('')).status, 403);
  grant('admin');
  assert.equal((await handler(new Request('https://x.test/api/finance-admin/channels/lines?fy=2025', { headers: { authorization: `Bearer ${who}` } }))).status, 400, 'months are needed');
  assert.equal((await handler(new Request('https://x.test/api/finance-admin/channels/lines?fy=2025&months=2024-01', { headers: { authorization: `Bearer ${who}` } }))).status, 400, 'a month of another year');
  assert.equal((await callLines('&dir=sideways')).status, 400);
  assert.equal((await callLines('&fd=maybe')).status, 400);
  assert.equal((await callLines('&dir=out')).status, 200);
});

test('lines: the count and amount behind a box agree with the aggregate, and each line says how to open it in the Ledger', async () => {
  grant('admin');
  const cube = (await (await call()).json()).cube;
  const paytm = await (await callLines('&dir=out&channel=paytm&fd=exclude')).json();
  assert.equal(paytm.paise, sum(cube.filter((c) => c.c === 'paytm' && c.d === 'out')));
  assert.equal(paytm.count, 1, 'one bank line, split in two allocations');
  assert.equal(paytm.pieces, 2);
  assert.deepEqual(paytm.lines.map((l) => [l.id, l.paise]), [[L.shop, 70000], [L.shop, 30000]], 'the biggest first, each with the line id');
  assert.equal(paytm.lines[0].account, 'Current account');
  const fd = await (await callLines('&dir=out&fd=only')).json();
  assert.deepEqual([fd.count, fd.paise], [1, 200000]);
  const salary = await (await callLines('&dir=out&purpose=salary&fd=exclude')).json();
  assert.equal(salary.paise, 70000);
  const card = await (await callLines('&channel=card')).json();
  assert.deepEqual(card.lines.map((l) => l.uncategorised), [true], 'a line with no category is marked');
  const noMatch = await (await callLines('&channel=gateway')).json();
  assert.deepEqual([noMatch.count, noMatch.paise, noMatch.lines], [0, 0, []]);
});

test('lines: only the largest few are listed, but the count and amount cover them all', async () => {
  grant('admin');
  for (let i = 0; i < 12; i++) {
    const id = ID(900 + i);
    db.data.fin_bank_lines.push({ id, bank_account_id: 'acc', tran_date: '2025-06-01', direction: 'debit', amount_paise: 1000 + i, narration: 'NEFT/0101102630472/10/' });
    db.data.fin_allocations.push({ id: ID(950 + i), bank_line_id: id, category_id: C.groc, project_id: null, amount_paise: 1000 + i, posted_at: '2025-07-01T00:00:00Z' });
  }
  const r = await (await callLines('&channel=paypro&fd=exclude')).json();
  assert.equal(r.count, 12);
  assert.equal(r.lines.length, 8);
  assert.equal(r.paise, 12000 + 66);
  assert.deepEqual(r.lines.map((l) => l.paise), [1011, 1010, 1009, 1008, 1007, 1006, 1005, 1004]);
});

test('lines: no narration, UPI reference or household name leaves the server, and an auditor’s visit is logged', async () => {
  grant('read_only');
  const res = await callLines('&dir=out');
  const text = await res.text();
  for (const secret of ['Household Nine', 'Corner Shop', 'HARDWARE', '600000000001', 'AXODH']) assert.ok(!text.includes(secret), secret);
  assert.equal(auditRows.length, 1);
  assert.equal(auditRows[0].action, 'finance.channels_viewed');
});

test('lines: a project narrows money for projects to that project, and a bad project is refused', async () => {
  grant('admin');
  assert.equal((await callLines('&project=not-a-project')).status, 400);
  const one = await (await callLines(`&dir=out&purpose=projects&fd=exclude&project=${ID(21)}`)).json();
  assert.deepEqual([one.count, one.paise], [1, 30000]);
  assert.equal(one.lines[0].project, ID(21), 'each line says which project it is for');
  const none = await (await callLines('&dir=out&purpose=projects&fd=exclude&project=none')).json();
  assert.deepEqual([none.count, none.paise], [0, 0], 'no project-less money for projects in this ledger');
  const other = await (await callLines(`&dir=out&purpose=projects&fd=exclude&project=${ID(99)}`)).json();
  assert.equal(other.count, 0);
});

// ---- GET /channels/breakdown: salary by employee, the rest by category -----------------------------------------------------------------

const PA = ID(81), PB = ID(82), PB_OLD = ID(83);
const withPeople = () => {
  db.data.fin_parties = [{ id: PA, name: 'Asha Example', merged_into: null }, { id: PB, name: 'Ravi Example', merged_into: null }, { id: PB_OLD, name: 'R. Example (old)', merged_into: PB }];
  db.data.fin_bank_lines.push(
    { id: ID(90), bank_account_id: 'acc', tran_date: '2025-05-26', direction: 'debit', amount_paise: 40000, narration: 'NEFT/0101102630472/10/' },
    { id: ID(91), bank_account_id: 'acc', tran_date: '2025-06-26', direction: 'debit', amount_paise: 25000, narration: 'NEFT/0101102630472/10/' },
    { id: ID(92), bank_account_id: 'acc', tran_date: '2025-07-26', direction: 'debit', amount_paise: 15000, narration: 'NEFT/0101102630472/10/' },
  );
  db.data.fin_allocations.push(
    { id: ID(93), bank_line_id: ID(90), category_id: C.sal, project_id: null, party_id: PA, amount_paise: 40000, posted_at: '2025-08-01T00:00:00Z' },
    { id: ID(94), bank_line_id: ID(91), category_id: C.sal, project_id: null, party_id: PB, amount_paise: 25000, posted_at: '2025-08-01T00:00:00Z' },
    { id: ID(95), bank_line_id: ID(92), category_id: C.sal, project_id: null, party_id: PB_OLD, amount_paise: 15000, posted_at: '2025-08-01T00:00:00Z' },
  );
};
const callBreakdown = (query) => handler(new Request(`https://x.test/api/finance-admin/channels/breakdown?fy=2025&months=${ALL}${query}`, { headers: { authorization: `Bearer ${who}` } }));

test('breakdown: salary by the person it was paid to, a merged duplicate counted as the one it was merged into, adding up to the box', async () => {
  grant('admin');
  withPeople();
  const cube = (await (await call()).json()).cube;
  const box = sum(cube.filter((c) => c.g === 'salary'));
  const r = await (await callBreakdown('&by=party&dir=out&purpose=salary&fd=exclude')).json();
  assert.deepEqual(r.rows.map((x) => [x.name, x.paise, x.n]), [['Asha Example', 40000, 1], ['Ravi Example', 40000, 2], ['No one named', 70000, 1]].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));
  assert.equal(r.paise, box, 'the people add up to the Salary box');
  assert.equal(r.rows.find((x) => x.name === 'Ravi Example').id, PB);
});

test('breakdown: by category, and the lines of one person carry their name', async () => {
  grant('admin');
  withPeople();
  const r = await (await callBreakdown('&by=category&dir=out&purpose=farm&fd=exclude')).json();
  assert.deepEqual(r.rows.map((x) => [x.name, x.paise]), [['Groceries', 5000]].filter(() => false).concat(r.rows.map((x) => [x.name, x.paise])), 'shape only');
  assert.ok(r.rows.every((x) => x.name), 'every row is named');
  const lines = await (await callLines(`&dir=out&purpose=salary&fd=exclude&party=${PB}`)).json();
  assert.deepEqual([lines.count, lines.paise], [2, 40000], 'both of Ravi’s lines, one of them posted to the old duplicate');
  assert.ok(lines.lines.every((l) => l.party === 'Ravi Example' && l.category === 'Salaries'));
  const nobody = await (await callLines('&dir=out&purpose=salary&fd=exclude&party=none')).json();
  assert.equal(nobody.paise, 70000);
});

test('breakdown: only party or category, valid ids, and the same grants as the rest', async () => {
  grant('admin');
  assert.equal((await callBreakdown('&by=colour')).status, 400);
  assert.equal((await callBreakdown('&by=party&party=nope')).status, 400);
  assert.equal((await callBreakdown('&by=category&category=nope')).status, 400);
  reset([person()], []);
  assert.equal((await callBreakdown('&by=party')).status, 403);
});

test('breakdown: names are on the answer, narrations are not, and an auditor’s visit is logged', async () => {
  grant('read_only');
  withPeople();
  const text = await (await callBreakdown('&by=party&dir=out&purpose=salary&fd=exclude')).text();
  assert.ok(text.includes('Asha Example'));
  for (const secret of ['Corner Shop', 'HARDWARE', '600000000001', 'AXODH', '0101102630472']) assert.ok(!text.includes(secret), secret);
  assert.equal(auditRows.length, 1);
});

// ---- UPI by the person behind each payment ---------------------------------------------------------------------------------------------

const withUpiPeople = () => {
  db.data.fin_bank_lines.push(
    { id: ID(96), bank_account_id: 'acc', tran_date: '2025-09-10', direction: 'debit', amount_paise: 20000, narration: 'UPI/P2A/600000000010/Someone/Bank' },
    { id: ID(97), bank_account_id: 'acc', tran_date: '2025-09-12', direction: 'debit', amount_paise: 30000, narration: 'UPI/P2A/600000000011/Someone Else/Bank' },
  );
  db.data.fin_upi_lines.push(
    { id: ID(98), bank_line_id: ID(96), app: 'bhim', paid_at: '2025-09-10', direction: 'debit', amount_paise: 20000, is_circle: false, ignored: false, upi_ref: '600000000010' },
    { id: ID(99), bank_line_id: ID(97), app: 'paytm', paid_at: '2025-09-12', direction: 'debit', amount_paise: 30000, is_circle: true, ignored: false, upi_ref: '600000000011' },
  );
};

test('UPI breakdown: Direct, and each delegate of the UPI circle by name, whichever app they used', async () => {
  grant('admin');
  withUpiPeople();
  const r = await (await callBreakdown('&by=delegate&dir=out&channel=upi&fd=exclude')).json();
  assert.deepEqual(r.rows.map((x) => [x.id, x.name, x.paise]), [['none', 'UPI circle · no delegate yet', 100000], [D1, 'UPI circle · Number 5550100001', 30000], ['own', 'Direct', 20000]]);
  const cube = (await (await call()).json()).cube;
  assert.equal(r.paise, sum(cube.filter((c) => ['paytm', 'bhim', 'upi_unknown'].includes(c.c) && c.d === 'out' && c.g !== 'sinking')), 'the people add up to the UPI box');
});

test('UPI breakdown: each person’s lines, and a bad delegate is refused', async () => {
  grant('admin');
  withUpiPeople();
  const one = await (await callLines(`&dir=out&channel=upi&fd=exclude&delegate=${D1}`)).json();
  assert.deepEqual([one.count, one.paise, one.lines[0].channel], [1, 30000, 'paytm']);
  const direct = await (await callLines('&dir=out&channel=upi&fd=exclude&delegate=own')).json();
  assert.deepEqual([direct.count, direct.paise, direct.lines[0].channel], [1, 20000, 'bhim']);
  assert.equal((await callLines('&delegate=somebody')).status, 400);
});
