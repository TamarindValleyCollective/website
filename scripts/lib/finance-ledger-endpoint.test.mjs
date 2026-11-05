// Run with: node --test scripts/lib/finance-ledger-endpoint.test.mjs
//
// Drives the real finance-admin Function (ledger routes) through requireStaff with Google and Supabase stubbed. Checks
// the money rules end to end: a line posts only when its allocations add up, a split posts, a closed month needs
// close-period and a reason, the audit row is written before anything is saved, review flags fire and the person who
// entered a row does not clear its review, a refund reverses at most what is left, a month closes only when ready, and
// categories merge only within a type. Every name, narration and amount is invented. Needs `npm ci` (esbuild), Node 22.18+.
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
const dir = mkdtempSync(join(tmpdir(), 'finance-ledger-'));
const out = join(dir, 'finance-admin.mjs');
await build({ entryPoints: ['netlify/functions/finance-admin.mts'], bundle: true, platform: 'node', format: 'esm', outfile: out, plugins: [stubGoogle], logLevel: 'silent' });
const { default: handler } = await import(pathToFileURL(out).href);

const ID = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const E = ID(1);
const CAT_OPEX = ID(11);
const CAT_OPEX_2 = ID(12);
const CAT_CAPEX = ID(13);
const CAT_REIMB = ID(14);
const P_NURSERY = ID(21);
const P_MANAGER = ID(22);
const L_DEBIT = ID(31); // 1,000.00 debit, 31 Oct 2026
const L_CIRCLE = ID(32); // 400.00 debit to the manager, a circle payment
const L_REFUND = ID(33); // 300.00 credit
const L_SEP = ID(34); // 200.00 debit in a closed month

// ---- a tiny fake PostgREST over arrays
let db;
let failAudit;
let n = 100;
const matches = (row, params) => {
  for (const [k, v] of params) {
    if (['select', 'order', 'limit'].includes(k)) continue;
    const dot = v.indexOf('.');
    let op = v.slice(0, dot);
    let val = v.slice(dot + 1);
    let negate = false;
    if (op === 'not') {
      negate = true;
      const d2 = val.indexOf('.');
      op = val.slice(0, d2);
      val = val.slice(d2 + 1);
    }
    const cell = row[k];
    let ok;
    if (op === 'eq') ok = String(cell) === val;
    else if (op === 'neq') ok = String(cell) !== val;
    else if (op === 'in') ok = val.replace(/^\(|\)$/g, '').split(',').includes(String(cell));
    else if (op === 'is') ok = val === 'null' ? cell == null : cell != null;
    else if (op === 'gte') ok = String(cell) >= val;
    else if (op === 'lt') ok = String(cell) < val;
    else ok = true;
    if (negate ? ok : !ok) return false;
  }
  return true;
};
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const method = init.method ?? 'GET';
  const table = u.pathname.replace('/rest/v1/', '');
  const body = init.body ? JSON.parse(init.body) : null;
  if (table === 'staff_users') return json(db.users.filter((x) => u.searchParams.get('email') === `eq.${x.email}`));
  if (table === 'staff_module_roles') {
    const id = u.searchParams.get('staff_id')?.slice(3);
    const mod = u.searchParams.get('module')?.slice(3);
    return json(db.roles.filter((r) => r.staff_id === id && r.module === mod).map(({ role, scope, expires_at }) => ({ role, scope, expires_at })));
  }
  if (table === 'staff_mfa_factors' || table === 'staff_recovery_codes') return json([]);
  if (table === 'fin_audit_log' && method === 'POST') {
    if (failAudit) return new Response('boom', { status: 500 });
    db.audit.push(body);
    return new Response(null, { status: 201 });
  }
  if (table === 'rpc/fin_save_allocations') {
    db.rpc.push({ name: 'save', body });
    const closedMonths = db.fin_periods.filter((p) => p.status === 'closed').map((p) => p.month);
    if (!body.p_override && body.p_rows.some((r) => closedMonths.includes(r.period))) return new Response('closed', { status: 400 });
    const line = db.fin_bank_lines.find((l) => l.id === body.p_line_id);
    const total = body.p_rows.reduce((s, r) => s + r.amount_paise, 0);
    if (total > line.amount_paise || (body.p_post && total !== line.amount_paise)) return new Response('sum', { status: 400 });
    db.fin_allocations = db.fin_allocations.filter((a) => a.bank_line_id !== body.p_line_id || a.posted_at);
    for (const r of body.p_rows) {
      db.fin_allocations.push({ id: ID(++n), entity_id: E, bank_line_id: body.p_line_id, created_by: body.p_actor, posted_at: body.p_post ? '2026-11-04T00:00:00Z' : null, ...r });
    }
    return json(body.p_rows.length);
  }
  if (table === 'rpc/fin_close_period') {
    db.rpc.push({ name: 'close', body });
    db.fin_periods.push({ month: body.p_month, status: 'closed' });
    return json(null);
  }
  if (table === 'rpc/fin_merge_category') {
    db.rpc.push({ name: 'merge', body });
    return json(7);
  }
  if (table.startsWith('fin_')) {
    const rows = db[table] ?? [];
    if (method === 'GET') {
      db.calls[table] = (db.calls[table] ?? 0) + 1;
      // Like Supabase's API: offset and limit are honoured, but a request never returns more than 1,000 rows.
      const offset = Number(u.searchParams.get('offset') ?? 0);
      const limit = Math.min(Number(u.searchParams.get('limit') ?? 1000), 1000);
      return json(rows.filter((r) => matches(r, u.searchParams)).slice(offset, offset + limit));
    }
    if (method === 'POST') {
      const row = { id: ID(++n), active: true, hit_count: 0, ...body };
      rows.push(row);
      db[table] = rows;
      return json([row], 201);
    }
    if (method === 'PATCH') {
      const hit = rows.filter((r) => matches(r, u.searchParams));
      for (const r of hit) Object.assign(r, body);
      return json(hit);
    }
  }
  throw new Error(`unexpected fetch ${method} ${url}`);
};

const reset = () => {
  db = {
    users: [], roles: [], audit: [], rpc: [], calls: {},
    fin_entities: [{ id: E, requester_party_id: P_MANAGER, created_at: '2026-01-01' }],
    fin_categories: [
      { id: CAT_OPEX, name: 'Materials and supplies', type: 'opex', active: true },
      { id: CAT_OPEX_2, name: 'Tools and small equipment', type: 'opex', active: true },
      { id: CAT_CAPEX, name: 'Equipment and machinery', type: 'capex', active: true },
      { id: CAT_REIMB, name: 'Reimbursements', type: 'reimbursement', active: true },
    ],
    fin_parties: [{ id: P_NURSERY, name: 'Green Nursery', kind: 'vendor', active: true, merged_into: null }, { id: P_MANAGER, name: 'Test Manager', kind: 'employee', active: true, merged_into: null }],
    fin_party_accounts: [{ party_id: P_NURSERY, status: 'verified', retired_on: null }, { party_id: P_MANAGER, status: 'unverified', retired_on: null }],
    fin_projects: [],
    fin_rules: [],
    fin_periods: [{ month: '2026-09-01', status: 'closed' }],
    fin_bank_accounts: [{ id: ID(2), label: 'Test current' }],
    fin_upi_lines: [{ bank_line_id: L_CIRCLE, counterparty: 'Test Manager', remarks: 'Onion', is_circle: true }],
    fin_bank_lines: [
      { id: L_DEBIT, entity_id: E, bank_account_id: ID(2), tran_date: '2026-10-31', narration: 'UPI/P2A/123456789012/Green Nursery/Okbank/Plants', direction: 'debit', amount_paise: 100000 },
      { id: L_CIRCLE, entity_id: E, bank_account_id: ID(2), tran_date: '2026-10-30', narration: 'UPI/P2A/123456789013/Test Manager/Okbank/Onion', direction: 'debit', amount_paise: 40000 },
      { id: L_REFUND, entity_id: E, bank_account_id: ID(2), tran_date: '2026-11-02', narration: 'UPI/P2A/123456789014/Green Nursery/Okbank/Refund', direction: 'credit', amount_paise: 30000 },
      { id: L_SEP, entity_id: E, bank_account_id: ID(2), tran_date: '2026-09-15', narration: 'NEFT/Some payment', direction: 'debit', amount_paise: 20000 },
    ],
    fin_allocations: [],
  };
  failAudit = false;
};
const sign = (id, role) => {
  const email = `${id}-${++n}@gmail.com`;
  db.users.push({ id, email, name: id, active: true, is_super_admin: false });
  db.roles.push({ staff_id: id, module: 'finance', role, scope: null, expires_at: null });
  return email;
};
const api = (email, path, { method = 'GET', body } = {}) =>
  handler(new Request(`https://x.test/api/finance-admin${path}`, { method, headers: { authorization: `Bearer ${email}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }));
const quiet = async (fn) => {
  const orig = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = orig;
  }
};
const row = (amountPaise, extra = {}) => ({ amountPaise, categoryId: CAT_OPEX, partyId: P_NURSERY, nature: 'Seedlings', ...extra });
const save = (email, lineId, rows, extra = {}) => api(email, `/ledger/${lineId}/allocations`, { method: 'POST', body: { rows, post: true, ...extra } });

test('a viewer sees the ledger but cannot allocate', async () => {
  reset();
  const viewer = sign('v1', 'read_only');
  const list = await api(viewer, '/ledger');
  assert.equal(list.status, 200);
  const body = await list.json();
  assert.equal(body.canAllocate, false);
  assert.equal(body.counts.unallocated, 4);
  assert.equal((await save(viewer, L_DEBIT, [row(100000)])).status, 403);
  assert.equal(db.rpc.length, 0);
});

test('a line with a UPI remark shows it, and the detail proposes party and nature from a rule', async () => {
  reset();
  db.fin_rules.push({ id: ID(51), priority: 10, matcher: { narrationContains: 'green nursery' }, party_id: null, category_id: CAT_OPEX, nature_template: 'Plants from {counterparty}', needs_review: false, active: true });
  db.fin_upi_lines.push({ bank_line_id: L_DEBIT, counterparty: 'Green Nursery', remarks: 'Mango saplings', is_circle: false });
  const op = sign('u1', 'user');
  const list = await (await api(op, '/ledger?filter=all')).json();
  assert.equal(list.lines.find((l) => l.id === L_DEBIT).remark, 'Mango saplings');
  const detail = await (await api(op, `/ledger/${L_DEBIT}`)).json();
  assert.equal(detail.proposal.source, 'rule');
  assert.equal(detail.proposal.partyId, P_NURSERY);
  assert.equal(detail.proposal.categoryId, CAT_OPEX);
  assert.equal(detail.proposal.nature, 'Plants from Green Nursery');
  assert.deepEqual(detail.reasons, []);
});

test('a short or over-long set of rows is refused before anything is audited or saved', async () => {
  reset();
  const op = sign('u1', 'user');
  const short = await save(op, L_DEBIT, [row(60000)]);
  assert.equal(short.status, 400);
  assert.match((await short.json()).error, /still to allocate/i);
  assert.equal((await save(op, L_DEBIT, [row(60000), row(50000)])).status, 400);
  assert.equal(db.rpc.length, 0);
  assert.equal(db.audit.length, 0);
});

test('a split of one debit posts, the audit row carries counts and no narration, name or amount', async () => {
  reset();
  const op = sign('u1', 'user');
  const res = await save(op, L_DEBIT, [row(25000), row(25000, { partyId: null, nature: 'Pots' }), row(50000, { categoryId: CAT_OPEX_2, nature: 'Spade' })]);
  assert.equal(res.status, 200);
  assert.equal(db.rpc[0].body.p_rows.length, 3);
  assert.equal(db.rpc[0].body.p_post, true);
  assert.equal(db.fin_allocations.filter((a) => a.posted_at).length, 3);
  const entry = db.audit.find((a) => a.action === 'finance.allocations_posted');
  assert.equal(entry.detail.rows, 3);
  const text = JSON.stringify(entry);
  assert.ok(!/Nursery|Seedlings|Spade|Pots|100000|25000|50000/.test(text), 'no name, nature or amount in the audit row');
});

test('nothing is saved when the audit row cannot be written', async () => {
  reset();
  const op = sign('u1', 'user');
  failAudit = true;
  const res = await quiet(() => save(op, L_DEBIT, [row(100000)]));
  assert.equal(res.status, 500);
  assert.equal(db.rpc.length, 0);
  assert.equal(db.fin_allocations.length, 0);
});

test('a posted line cannot be saved again', async () => {
  reset();
  const op = sign('u1', 'user');
  assert.equal((await save(op, L_DEBIT, [row(100000)])).status, 200);
  const again = await save(op, L_DEBIT, [row(100000)]);
  assert.equal(again.status, 409);
});

test('a draft can be saved with a remainder, then replaced and posted', async () => {
  reset();
  const op = sign('u1', 'user');
  const draft = await api(op, `/ledger/${L_DEBIT}/allocations`, { method: 'POST', body: { rows: [row(60000)], post: false } });
  assert.equal(draft.status, 200);
  assert.equal(db.fin_allocations[0].posted_at, null);
  assert.equal((await save(op, L_DEBIT, [row(100000)])).status, 200);
  assert.equal(db.fin_allocations.length, 1);
  assert.ok(db.fin_allocations[0].posted_at);
});

test('a closed month is refused without close-period, and a director needs a reason to override it', async () => {
  reset();
  const op = sign('u1', 'user');
  const director = sign('d1', 'admin');
  const sep = { period: '2026-09-01' };
  assert.equal((await save(op, L_SEP, [row(20000, sep)])).status, 403);
  assert.equal((await save(director, L_SEP, [row(20000, sep)])).status, 403); // no reason
  assert.equal(db.rpc.length, 0);
  const ok = await save(director, L_SEP, [row(20000, sep)], { overrideReason: 'Late bill found by the auditor' });
  assert.equal(ok.status, 200);
  assert.equal(db.rpc[0].body.p_override, true);
  assert.equal(db.audit.find((a) => a.action === 'finance.allocations_posted').detail.override, true);
});

test('a circle payment to the requester goes to review, and the person who entered it cannot clear it', async () => {
  reset();
  const op = sign('u1', 'user');
  const other = sign('u2', 'user');
  const res = await save(op, L_CIRCLE, [row(40000, { partyId: P_MANAGER, categoryId: CAT_REIMB, nature: 'Onion' })]);
  assert.equal(res.status, 200);
  const stored = db.fin_allocations[0];
  assert.equal(stored.review_state, 'needs_review');
  assert.match(stored.review_reason, /circle_to_requester/);
  assert.match(stored.review_reason, /new_payee_account/); // the manager's account is unverified
  assert.match(stored.review_reason, /reimbursement_without_bill/);
  const queue = await (await api(op, '/ledger?filter=review')).json();
  assert.equal(queue.counts.review, 1);
  assert.equal((await api(op, `/allocations/${stored.id}/review`, { method: 'POST', body: { action: 'resolve' } })).status, 403);
  assert.equal(stored.review_state, 'needs_review');
  assert.equal((await api(other, `/allocations/${stored.id}/review`, { method: 'POST', body: { action: 'resolve' } })).status, 200);
  assert.equal(stored.review_state, 'ok');
  assert.equal(stored.reviewed_by, 'u2');
});

test('a clean payment to a verified party is not flagged', async () => {
  reset();
  const op = sign('u1', 'user');
  await save(op, L_DEBIT, [row(100000)]);
  assert.equal(db.fin_allocations[0].review_state, 'ok');
  assert.equal(db.fin_allocations[0].review_reason, null);
});

test('a refund reverses an earlier allocation, never more than is left, and takes its category and party from it', async () => {
  reset();
  const op = sign('u1', 'user');
  await save(op, L_DEBIT, [row(100000)]);
  const original = db.fin_allocations[0].id;
  const tooMuch = await save(op, L_REFUND, [{ amountPaise: 30000, reversesAllocationId: original, reversalReason: 'x' }]);
  assert.equal(tooMuch.status, 400); // a reason of one letter
  const ok = await save(op, L_REFUND, [{ amountPaise: 30000, reversesAllocationId: original, reversalReason: 'Order cancelled' }]);
  assert.equal(ok.status, 200);
  const reversal = db.fin_allocations.find((a) => a.reverses_allocation_id === original);
  assert.equal(reversal.category_id, CAT_OPEX);
  assert.equal(reversal.party_id, P_NURSERY);
  assert.equal(reversal.reversal_reason, 'Order cancelled');
  assert.match(reversal.nature, /Reversal/);
  // The debit cannot be reversed by another debit.
  assert.equal((await save(op, L_CIRCLE, [{ amountPaise: 40000, reversesAllocationId: original, reversalReason: 'Wrong way' }])).status, 400);
});

test('a month closes only when every line is posted and nothing waits for review', async () => {
  reset();
  const op = sign('u1', 'user');
  const director = sign('d1', 'admin');
  assert.equal((await api(op, '/periods/2026-10-01/close', { method: 'POST' })).status, 403);
  const blocked = await api(director, '/periods/2026-10-01/close', { method: 'POST' });
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).unallocated, 2);
  await save(op, L_DEBIT, [row(100000)]);
  await save(op, L_CIRCLE, [row(40000, { partyId: P_NURSERY, categoryId: CAT_OPEX, nature: 'Onion' })]);
  assert.equal((await api(director, '/periods/2026-10-01/close', { method: 'POST' })).status, 200);
  assert.equal(db.rpc.at(-1).name, 'close');
  assert.ok(db.audit.some((a) => a.action === 'finance.period_closed'));
  const periods = await (await api(director, '/periods')).json();
  assert.equal(periods.months.find((m) => m.month === '2026-10-01').status, 'closed');
});

test('rules need configure; an invalid rule is refused; a director adds one', async () => {
  reset();
  const op = sign('u1', 'user');
  const director = sign('d1', 'admin');
  const good = { matcher: { narrationContains: 'gas agency' }, categoryId: CAT_OPEX, natureTemplate: 'Cooking gas', priority: 20 };
  assert.equal((await api(op, '/rules', { method: 'POST', body: good })).status, 403);
  assert.equal((await api(director, '/rules', { method: 'POST', body: { ...good, matcher: {} } })).status, 400);
  assert.equal((await api(director, '/rules', { method: 'POST', body: good })).status, 201);
  assert.equal(db.fin_rules.length, 1);
  assert.equal(db.fin_rules[0].created_by, 'd1');
  const list = await (await api(op, '/rules')).json();
  assert.equal(list.rules.length, 1);
  assert.equal(list.canConfigure, false);
  const id = db.fin_rules[0].id;
  assert.equal((await api(director, `/rules/${id}`, { method: 'PATCH', body: { active: false } })).status, 200);
  assert.equal(db.fin_rules[0].active, false);
});

test('categories merge only within a type, and only a director can', async () => {
  reset();
  const op = sign('u1', 'user');
  const director = sign('d1', 'admin');
  assert.equal((await api(op, `/categories/${CAT_OPEX_2}/merge`, { method: 'POST', body: { into: CAT_OPEX } })).status, 403);
  const cross = await api(director, `/categories/${CAT_OPEX_2}/merge`, { method: 'POST', body: { into: CAT_CAPEX } });
  assert.equal(cross.status, 409);
  assert.equal(db.rpc.length, 0);
  const ok = await api(director, `/categories/${CAT_OPEX_2}/merge`, { method: 'POST', body: { into: CAT_OPEX } });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).moved, 7);
  assert.ok(db.audit.some((a) => a.action === 'finance.category_merged'));
  // A new category, and a rename.
  assert.equal((await api(director, '/categories', { method: 'POST', body: { name: 'Fencing', type: 'capex' } })).status, 201);
  assert.equal((await api(director, '/categories', { method: 'POST', body: { name: 'Fencing', type: 'nonsense' } })).status, 400);
  assert.equal((await api(director, `/categories/${CAT_CAPEX}`, { method: 'PATCH', body: { name: 'Machinery' } })).status, 200);
});

test('the requester is set by a director and is the person whose circle payments are flagged', async () => {
  reset();
  const op = sign('u1', 'user');
  const director = sign('d1', 'admin');
  assert.equal((await api(op, '/settings/requester', { method: 'POST', body: { partyId: P_NURSERY } })).status, 403);
  assert.equal((await api(director, '/settings/requester', { method: 'POST', body: { partyId: ID(999) } })).status, 400);
  assert.equal((await api(director, '/settings/requester', { method: 'POST', body: { partyId: P_NURSERY } })).status, 200);
  assert.equal(db.fin_entities[0].requester_party_id, P_NURSERY);
});

// ---- more than 1,000 rows: Supabase's API returns at most 1,000 per request, whatever limit is asked
const bulkLines = (count, month, firstId) =>
  Array.from({ length: count }, (_, i) => ({ id: ID(firstId + i), entity_id: E, bank_account_id: ID(2), tran_date: `${month}-${String((i % 28) + 1).padStart(2, '0')}`, narration: `UPI/P2A/${String(100000000000 + firstId + i)}/Test Vendor/Okbank/x`, direction: 'debit', amount_paise: 1000 }));
const postedFor = (lines) => lines.map((l) => ({ id: ID(900000 + Number(l.id.slice(-8))), entity_id: E, bank_line_id: l.id, party_id: null, category_id: CAT_OPEX, amount_paise: l.amount_paise, period: `${l.tran_date.slice(0, 7)}-01`, nature: 'Supplies', source: 'manual', review_state: 'ok', review_reason: null, reverses_allocation_id: null, posted_at: '2026-11-04T00:00:00Z', created_by: 'u0' }));

test('the ledger counts every line, not just the first 1,000 the database returns', async () => {
  reset();
  db.fin_bank_lines = bulkLines(1376, '2026-07', 1000);
  const op = sign('u1', 'user');
  const all = await (await api(op, '/ledger?filter=all')).json();
  assert.equal(all.total, 1376);
  assert.equal(all.counts.all, 1376);
  assert.equal(all.counts.unallocated, 1376);
  // The oldest lines (beyond the first 1,000 by date) are reachable too.
  const last = await (await api(op, '/ledger?filter=all&offset=1300')).json();
  assert.equal(last.lines.length, 76);
});

test('a line posted beyond the first 1,000 allocations is still seen as allocated', async () => {
  reset();
  db.fin_bank_lines = bulkLines(1200, '2026-07', 1000);
  db.fin_allocations = postedFor(db.fin_bank_lines);
  const op = sign('u1', 'user');
  const counts = (await (await api(op, '/ledger?filter=all')).json()).counts;
  assert.equal(counts.unallocated, 0, 'all 1,200 are posted');
  assert.equal(counts.review, 0);
  const overview = await (await api(op, '/overview')).json();
  assert.equal(overview.attention.toAllocate, 0);
});

test('a month with more than 1,000 lines closes when they are all posted, and a flagged one past 1,000 still blocks it', async () => {
  reset();
  db.fin_bank_lines = bulkLines(1100, '2026-07', 1000);
  db.fin_allocations = postedFor(db.fin_bank_lines);
  const director = sign('d1', 'admin');
  // Flag the very last allocation, which sits beyond the first 1,000.
  db.fin_allocations[1099].review_state = 'needs_review';
  const blocked = await api(director, '/periods/2026-07-01/close', { method: 'POST' });
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).needsReview, 1);
  db.fin_allocations[1099].review_state = 'ok';
  assert.equal((await api(director, '/periods/2026-07-01/close', { method: 'POST' })).status, 200);
});

// ---- suggestions (docs/finance/FINANCE.md, "Suggestions")
const CAT_BANK = ID(15);
const L_CHRG = ID(61);
const L_STRANGER = ID(62);
const addBankCategory = () => db.fin_categories.push({ id: CAT_BANK, name: 'Bank charges', type: 'opex', active: true });
const addLines = () =>
  db.fin_bank_lines.push(
    { id: L_CHRG, entity_id: E, bank_account_id: ID(2), tran_date: '2026-10-05', narration: 'Monthly Service Chrgs', direction: 'debit', amount_paise: 29500 },
    { id: L_STRANGER, entity_id: E, bank_account_id: ID(2), tran_date: '2026-10-06', narration: 'INB/NEFT/AXIC123456789012/Brand New Supplier/Fertiliser', direction: 'debit', amount_paise: 80000 },
  );
const suggestionOf = async (email, lineId) => (await (await api(email, '/ledger?filter=all')).json()).lines.find((l) => l.id === lineId).suggestion;

test('the list suggests a category for the bank\'s own entries, a party from the register, and a new party for a stranger', async () => {
  reset();
  addBankCategory();
  addLines();
  const op = sign('u1', 'user');
  const charges = await suggestionOf(op, L_CHRG);
  assert.equal(charges.categoryId, CAT_BANK);
  assert.equal(charges.confidence, 'high');
  assert.equal(charges.nature, 'Bank charges');
  const named = await suggestionOf(op, L_DEBIT); // UPI to a party in the register
  assert.equal(named.partyId, P_NURSERY);
  assert.equal(named.categoryId, null);
  const stranger = await suggestionOf(op, L_STRANGER);
  assert.equal(stranger.partyId, null);
  assert.equal(stranger.newPartyName, 'Brand New Supplier');
  assert.equal(stranger.nature, 'Fertiliser');
});

test('the line\'s detail explains the suggestion in words', async () => {
  reset();
  addBankCategory();
  addLines();
  const op = sign('u1', 'user');
  const detail = await (await api(op, `/ledger/${L_STRANGER}`)).json();
  assert.equal(detail.suggestion.newParty.kind, 'vendor');
  assert.ok(detail.suggestion.reasons.some((r) => /not in the register/i.test(r)));
  assert.equal(detail.proposal.nature, 'Fertiliser');
});

test('it learns: after a party has been posted to a few times the next payment is suggested the same way', async () => {
  reset();
  addBankCategory();
  const op = sign('u1', 'user');
  // Three earlier, already posted payments to the nursery, all Materials and supplies.
  const earlier = [ID(71), ID(72), ID(73)].map((id, i) => ({ id, entity_id: E, bank_account_id: ID(2), tran_date: `2026-09-0${i + 1}`, narration: `UPI/P2A/12345678900${i}/Green Nursery/Okbank/Seedlings`, direction: 'debit', amount_paise: 50000 }));
  db.fin_bank_lines.push(...earlier);
  db.fin_allocations = earlier.map((l, i) => ({ id: ID(80 + i), entity_id: E, bank_line_id: l.id, party_id: P_NURSERY, category_id: CAT_OPEX, amount_paise: 50000, period: '2026-09-01', nature: 'Seedlings', source: 'manual', review_state: 'ok', reverses_allocation_id: null, posted_at: '2026-11-04T00:00:00Z' }));
  const s = await suggestionOf(op, L_DEBIT);
  assert.equal(s.partyId, P_NURSERY);
  assert.equal(s.categoryId, CAT_OPEX);
  assert.equal(s.confidence, 'high');
});

test('a party that is not in the register can be added from the ledger by anyone who may allocate, and is then recognised', async () => {
  reset();
  addLines();
  const op = sign('u1', 'user');
  const viewer = sign('v1', 'read_only');
  assert.equal((await api(viewer, '/parties', { method: 'POST', body: { name: 'Brand New Supplier', kind: 'vendor' } })).status, 403);
  const created = await api(op, '/parties', { method: 'POST', body: { name: 'Brand New Supplier', kind: 'vendor' } });
  assert.equal(created.status, 201);
  const s = await suggestionOf(op, L_STRANGER);
  assert.equal(s.newPartyName, null, 'no longer a stranger');
  assert.ok(s.partyId);
  const lookups = (await (await api(op, '/ledger')).json()).lookups;
  assert.ok(lookups.parties.some((p) => p.name === 'Brand New Supplier'));
});

// ---- posting many lines at once: what the table's "Post N ready" sends
const batchItem = (lineId, extra = {}) => ({ lineId, categoryId: CAT_OPEX, partyId: P_NURSERY, nature: 'Supplies', ...extra });
const postBatch = (email, items, extra = {}) => api(email, '/ledger/post', { method: 'POST', body: { items, ...extra } });

test('a batch posts several different lines, each with its own values, and the amount is always the line\'s', async () => {
  reset();
  addBankCategory();
  addLines();
  const op = sign('u1', 'user');
  const res = await postBatch(op, [
    batchItem(L_DEBIT, { amountPaise: 1, nature: 'Seedlings' }), // a client-sent amount is ignored
    batchItem(L_CHRG, { categoryId: CAT_BANK, partyId: null, nature: 'Bank charges' }),
  ]);
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.posted, 2);
  assert.equal(out.failed.length, 0);
  const a = db.fin_allocations.find((x) => x.bank_line_id === L_DEBIT);
  assert.equal(a.amount_paise, 100000);
  assert.equal(a.nature, 'Seedlings');
  assert.equal(a.party_id, P_NURSERY);
  const b = db.fin_allocations.find((x) => x.bank_line_id === L_CHRG);
  assert.equal(b.category_id, CAT_BANK);
  assert.equal(b.amount_paise, 29500);
  assert.ok(db.fin_allocations.every((x) => x.posted_at));
  assert.equal(db.audit.filter((x) => x.action === 'finance.allocations_posted').length, 2, 'one audit row per line, written before its save');
});

test('a line that cannot be posted is reported with its reason and does not stop the others', async () => {
  reset();
  addBankCategory();
  addLines();
  const op = sign('u1', 'user');
  await postBatch(op, [batchItem(L_CHRG, { categoryId: CAT_BANK, partyId: null })]); // already posted
  db.fin_categories.push({ id: ID(16), name: 'Old head', type: 'opex', active: false });
  const res = await postBatch(op, [
    batchItem(L_CHRG), // already posted
    batchItem(L_SEP), // 15 Sep: a closed month
    batchItem(L_STRANGER, { categoryId: ID(16) }), // a retired category
    batchItem(L_REFUND, { partyId: ID(999) }), // a party that is not in the register
    batchItem(L_DEBIT), // fine
  ]);
  const out = await res.json();
  assert.equal(out.posted, 1);
  assert.equal(out.failed.length, 4);
  const why = Object.fromEntries(out.failed.map((f) => [f.lineId, f.error]));
  assert.match(why[L_CHRG], /already posted/i);
  assert.match(why[L_SEP], /closed/i);
  assert.match(why[L_STRANGER], /active category/i);
  assert.match(why[L_REFUND], /register/i);
  assert.ok(db.fin_allocations.some((x) => x.bank_line_id === L_DEBIT));
});

test('a batch needs allocate rights, between one and fifteen distinct lines, and real line ids', async () => {
  reset();
  addLines();
  const viewer = sign('v1', 'read_only');
  const op = sign('u1', 'user');
  assert.equal((await postBatch(viewer, [batchItem(L_DEBIT)])).status, 403);
  assert.equal((await postBatch(op, [])).status, 400);
  assert.equal((await postBatch(op, [batchItem('not-an-id')])).status, 400);
  assert.equal((await postBatch(op, [batchItem(L_DEBIT), batchItem(L_DEBIT)])).status, 400);
  const sixteen = Array.from({ length: 16 }, (_, i) => batchItem(ID(5000 + i)));
  assert.equal((await postBatch(op, sixteen)).status, 400);
  assert.equal(db.fin_allocations.length, 0);
});

test('a batch counts the rows it sent to review', async () => {
  reset();
  const op = sign('u1', 'user');
  const out = await (await postBatch(op, [batchItem(L_CIRCLE, { partyId: P_MANAGER, categoryId: CAT_REIMB, nature: 'Onion' }), batchItem(L_DEBIT)])).json();
  assert.equal(out.posted, 2);
  assert.equal(out.flagged, 1, 'the circle payment to the requester');
});

test('a batch reads the lookups once, not once per line', async () => {
  reset();
  db.fin_bank_lines.push(...bulkLines(12, '2026-07', 3000));
  const op = sign('u1', 'user');
  db.calls = {};
  const out = await (await postBatch(op, db.fin_bank_lines.slice(-12).map((l) => batchItem(l.id)))).json();
  assert.equal(out.posted, 12);
  assert.equal(db.calls.fin_categories, 1);
  assert.ok((db.calls.fin_rules ?? 0) <= 1);
  assert.ok((db.calls.fin_party_accounts ?? 0) <= 1);
});
