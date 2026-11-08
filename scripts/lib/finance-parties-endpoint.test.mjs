// Run with: node --test scripts/lib/finance-parties-endpoint.test.mjs
//
// Drives the real finance-admin Function (parties routes) through requireStaff with Google and Supabase stubbed.
// Checks the money-adjacent rules end to end: a changed account is a new unverified row and the old one is kept;
// account numbers are encrypted at rest and never appear in list responses, in the audit log, or to anyone without
// verify-payee; revealing and verifying need the MFA step-up; whoever entered details cannot verify them; a shared
// account is flagged. Every value is invented. Needs `npm ci` (esbuild) and Node 22.18+.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { auditDetailIsSafe } from './finance-parties.mjs';

process.env.SUPABASE_URL = 'https://db.test';
process.env.PUBLIC_GOOGLE_CLIENT_ID = 'client';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
process.env.STAFF_MFA_KEY = randomBytes(32).toString('base64');
const { signStepUp, encryptFinanceText, fingerprintFinanceText } = await import('../../netlify/functions/lib/staff-mfa-crypto.ts');

const stubGoogle = {
  name: 'stub-google',
  setup(b) {
    b.onResolve({ filter: /google-id-token\.mjs$/ }, () => ({ path: 'stub-google', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export async function verifyGoogleIdToken(t){ return { email: t, hd: t.split("@")[1] }; }', loader: 'js' }));
  },
};
const dir = mkdtempSync(join(tmpdir(), 'finance-parties-'));
const out = join(dir, 'finance-admin.mjs');
await build({ entryPoints: ['netlify/functions/finance-admin.mts'], bundle: true, platform: 'node', format: 'esm', outfile: out, plugins: [stubGoogle], logLevel: 'silent' });
const { default: handler } = await import(pathToFileURL(out).href);

const ACCOUNT = '100000000001';
const ACCOUNT_2 = '100000000002';
const IFSC = 'ABCD0123456';

// ---- a tiny fake PostgREST: eq./neq./in./ilike filters, inserts with generated ids, patches
let db;
let failAudit;
const ifscAsked = [];
let n = 0;
const matches = (row, params) => {
  for (const [k, v] of params) {
    if (['select', 'order', 'limit'].includes(k)) continue;
    const [op, ...rest] = v.split('.');
    const val = rest.join('.');
    if (op === 'eq' && String(row[k]) !== val) return false;
    if (op === 'neq' && String(row[k]) === val) return false;
    if (op === 'in' && !val.replace(/^\(|\)$/g, '').split(',').includes(String(row[k]))) return false;
    if (op === 'ilike' && !String(row[k]).toLowerCase().includes(val.replaceAll('*', '').toLowerCase())) return false;
  }
  return true;
};
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  if (u.hostname === 'ifsc.razorpay.com') {
    ifscAsked.push(u.pathname.slice(1));
    return u.pathname === `/${IFSC}` ? new Response(JSON.stringify({ BANK: 'Test Bank', BRANCH: 'MAIN ROAD', CITY: 'SAMPLE CITY', STATE: 'SAMPLE STATE' })) : new Response('"Not Found"', { status: 404 });
  }
  const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const table = u.pathname.replace('/rest/v1/', '');
  const method = init.method ?? 'GET';
  if (table === 'staff_users') {
    const ids = u.searchParams.get('id');
    if (ids?.startsWith('in.')) return json(db.users.filter((x) => ids.slice(4, -1).split(',').includes(x.id)).map((x) => ({ id: x.id, name: x.name })));
    return json(db.users.filter((x) => u.searchParams.get('email') === `eq.${x.email}`));
  }
  if (table === 'staff_module_roles') {
    const id = u.searchParams.get('staff_id')?.slice(3);
    const mod = u.searchParams.get('module')?.slice(3);
    return json(db.roles.filter((r) => r.staff_id === id && r.module === mod).map(({ role, scope, expires_at }) => ({ role, scope, expires_at })));
  }
  if (table === 'staff_mfa_factors' || table === 'staff_recovery_codes') return json([]);
  if (table === 'fin_audit_log' && method === 'POST') {
    if (failAudit) return new Response('boom', { status: 500 });
    db.audit.push(JSON.parse(init.body));
    return new Response(null, { status: 201 });
  }
  if (table === 'fin_entities') return json([{ id: 'e1', name: 'Test Entity' }]);
  if (table === 'member_households') return json([{ id: 'h1' }]);
  if (table === 'fin_parties' || table === 'fin_party_accounts') {
    const rows = db[table];
    if (method === 'GET') return json(rows.filter((r) => matches(r, u.searchParams)));
    if (method === 'POST') {
      const row = { id: `${table === 'fin_parties' ? 'p' : 'a'}${++n}`, created_at: new Date().toISOString(), status: table === 'fin_party_accounts' ? 'unverified' : undefined, active: table === 'fin_parties' ? true : undefined, ...JSON.parse(init.body) };
      rows.push(row);
      return json([row], 201);
    }
    if (method === 'PATCH') {
      const hit = rows.filter((r) => matches(r, u.searchParams));
      for (const r of hit) Object.assign(r, JSON.parse(init.body));
      return json(hit);
    }
  }
  if (table.startsWith('fin_')) return json([], 200, { 'content-range': '0-0/0' });
  throw new Error(`unexpected fetch ${method} ${url}`);
};

const reset = () => {
  db = { users: [], roles: [], fin_parties: [], fin_party_accounts: [], audit: [] };
  failAudit = false;
};
// requireStaff caches lookups per email for 30s, so each test signs in as someone new.
const sign = (id, role, extra = {}) => {
  const email = `${id}-${++n}@gmail.com`;
  db.users.push({ id, email, name: id, active: true, is_super_admin: false });
  db.roles.push({ staff_id: id, module: 'finance', role, scope: null, expires_at: null, ...extra });
  return email;
};
const api = (email, path, { method = 'GET', body, stepUp = false } = {}) =>
  handler(
    new Request(`https://x.test/api/finance-admin${path}`, {
      method,
      headers: { authorization: `Bearer ${email}`, ...(body ? { 'content-type': 'application/json' } : {}), ...(stepUp ? { 'x-stepup-token': signStepUp(stepUp, 'totp', Date.now()) } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
const newVendor = (over = {}) => ({ name: 'Test Traders', kind: 'vendor', payee: { method: 'bank', account: ACCOUNT, ifsc: IFSC }, ...over });
const quiet = async (fn) => {
  const orig = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = orig;
  }
};

test('a finance user adds a vendor with bank details: stored encrypted and unverified, answered without the number', async () => {
  reset();
  const op = sign('u1', 'user');
  const res = await api(op, '/parties', { method: 'POST', body: newVendor() });
  assert.equal(res.status, 201);
  const text = JSON.stringify(await res.json());
  assert.ok(!text.includes(ACCOUNT) && !text.includes(IFSC));
  const [acct] = db.fin_party_accounts;
  assert.equal(acct.status, 'unverified');
  assert.equal(acct.last4, '0001');
  assert.equal(acct.created_by, 'u1');
  assert.ok(!JSON.stringify(acct).includes(ACCOUNT), 'the number must not be stored in the clear');
  assert.match(acct.details_enc, /^v1\./);
});

test('every audit row is ids, counts and field names: no account number, IFSC or UPI id', async () => {
  reset();
  const op = sign('u1', 'user');
  await api(op, '/parties', { method: 'POST', body: newVendor() });
  const id = db.fin_parties[0].id;
  await api(op, `/parties/${id}/accounts`, { method: 'POST', body: { method: 'upi', upi: 'test.vendor@okbank' } });
  await api(op, `/parties/${id}`, { method: 'PATCH', body: { name: 'Test Traders Ltd' } });
  assert.ok(db.audit.length >= 3);
  for (const row of db.audit) {
    assert.ok(auditDetailIsSafe(row.detail), JSON.stringify(row));
    const text = JSON.stringify(row);
    for (const s of [ACCOUNT, IFSC, 'test.vendor', 'Test Traders']) assert.ok(!text.includes(s), `audit leaked ${s}`);
  }
});

test('a read-only viewer sees the directory (names, last four) but cannot add', async () => {
  reset();
  const op = sign('u1', 'user');
  await api(op, '/parties', { method: 'POST', body: newVendor() });
  const viewer = sign('u2', 'read_only');
  const list = await api(viewer, '/parties');
  assert.equal(list.status, 200);
  const body = await list.json();
  assert.equal(body.parties[0].name, 'Test Traders');
  assert.equal(body.parties[0].accounts[0].shown, 'ending 0001');
  assert.equal(body.canEdit, false);
  assert.equal((await api(viewer, '/parties', { method: 'POST', body: newVendor({ name: 'Another Shop' }) })).status, 403);
});

test('the IFSC lookup names the bank for finance users, says when no branch exists, and sends nothing but the IFSC', async () => {
  reset();
  const viewer = sign('u2', 'read_only');
  const found = await (await api(viewer, `/ifsc/${IFSC}`)).json();
  assert.deepEqual(found, { found: true, bank: 'Test Bank', branch: 'Main Road', city: 'Sample City', state: 'Sample State' });
  assert.deepEqual(await (await api(viewer, '/ifsc/ZZZZ0000000')).json(), { found: false });
  assert.deepEqual(ifscAsked.slice(-2), [IFSC, 'ZZZZ0000000']);
  const nobody = await handler(new Request(`https://x.test/api/finance-admin/ifsc/${IFSC}`));
  assert.equal(nobody.status, 401);
});

test('even a payee verifier gets only last four from the list', async () => {
  reset();
  const op = sign('u1', 'user');
  await api(op, '/parties', { method: 'POST', body: newVendor() });
  const director = sign('u2', 'admin');
  const text = JSON.stringify(await (await api(director, '/parties')).json());
  assert.ok(!text.includes(ACCOUNT) && !text.includes(IFSC));
  assert.ok(!text.includes('fingerprint') && !text.includes('details_enc'));
});

test('changing the account adds a new unverified row and supersedes the old one, which is kept', async () => {
  reset();
  const op = sign('u1', 'user');
  await api(op, '/parties', { method: 'POST', body: newVendor() });
  const id = db.fin_parties[0].id;
  const res = await api(op, `/parties/${id}/accounts`, { method: 'POST', body: { method: 'bank', account: ACCOUNT_2, ifsc: IFSC } });
  assert.equal(res.status, 201);
  assert.equal(db.fin_party_accounts.length, 2);
  assert.deepEqual(db.fin_party_accounts.map((a) => a.status), ['superseded', 'unverified']);
  assert.ok(db.fin_party_accounts[0].superseded_at);
  assert.match(db.fin_party_accounts[0].details_enc, /^v1\./); // the old details are still there
});

test('entering the same details again adds nothing', async () => {
  reset();
  const op = sign('u1', 'user');
  await api(op, '/parties', { method: 'POST', body: newVendor() });
  const id = db.fin_parties[0].id;
  const res = await api(op, `/parties/${id}/accounts`, { method: 'POST', body: { method: 'bank', account: ACCOUNT, ifsc: IFSC } });
  assert.equal(res.status, 200);
  assert.equal(db.fin_party_accounts.length, 1);
});

test('two parties with one account are flagged on both, and both are still allowed', async () => {
  reset();
  const op = sign('u1', 'user');
  assert.equal((await api(op, '/parties', { method: 'POST', body: newVendor() })).status, 201);
  assert.equal((await api(op, '/parties', { method: 'POST', body: newVendor({ name: 'Other Shop' }) })).status, 201);
  const body = await (await api(op, '/parties')).json();
  assert.deepEqual(body.parties.map((p) => p.accounts[0].shared), [true, true]);
});

test('bad details are refused with a message and nothing is stored', async () => {
  reset();
  const op = sign('u1', 'user');
  const res = await api(op, '/parties', { method: 'POST', body: newVendor({ payee: { method: 'bank', account: '123', ifsc: IFSC } }) });
  assert.equal(res.status, 400);
  assert.equal(db.fin_parties.length, 0);
});

test('revealing needs verify-payee and the step-up; the reveal is logged before the number is returned', async () => {
  reset();
  const op = sign('u1', 'user');
  await api(op, '/parties', { method: 'POST', body: newVendor() });
  const acctId = db.fin_party_accounts[0].id;
  const director = sign('u2', 'admin');

  assert.equal((await api(op, `/accounts/${acctId}/reveal`, { method: 'POST', stepUp: 'u1' })).status, 403); // no verify-payee
  const noStep = await api(director, `/accounts/${acctId}/reveal`, { method: 'POST' });
  assert.equal(noStep.status, 403);
  assert.equal((await noStep.json()).code, 'STEP_UP_REQUIRED');
  assert.equal((await api(director, `/accounts/${acctId}/reveal`, { method: 'POST', stepUp: 'someone-else' })).status, 403); // token for another person

  const ok = await api(director, `/accounts/${acctId}/reveal`, { method: 'POST', stepUp: 'u2' });
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).details, { method: 'bank', account: ACCOUNT, ifsc: IFSC });
  assert.equal(db.audit.at(-1).action, 'finance.payee_revealed');
  assert.equal(db.audit.at(-1).target, acctId);
});

test('if the reveal cannot be logged, the number is not returned', async () => {
  reset();
  const op = sign('u1', 'user');
  await api(op, '/parties', { method: 'POST', body: newVendor() });
  const acctId = db.fin_party_accounts[0].id;
  const director = sign('u2', 'admin');
  failAudit = true;
  const res = await quiet(() => api(director, `/accounts/${acctId}/reveal`, { method: 'POST', stepUp: 'u2' }));
  assert.equal(res.status, 500);
  assert.ok(!(await res.text()).includes(ACCOUNT));
});

test('verifying needs the step-up, and not by whoever entered the details', async () => {
  reset();
  const director1 = sign('u1', 'admin');
  await api(director1, '/parties', { method: 'POST', body: newVendor() });
  const acctId = db.fin_party_accounts[0].id;
  const director2 = sign('u2', 'admin');

  assert.equal((await (await api(director2, `/accounts/${acctId}/verify`, { method: 'POST', body: { method: 'cancelled_cheque' } })).json()).code, 'STEP_UP_REQUIRED');
  const self = await api(director1, `/accounts/${acctId}/verify`, { method: 'POST', body: { method: 'cancelled_cheque' }, stepUp: 'u1' });
  assert.equal(self.status, 403);
  assert.equal(db.fin_party_accounts[0].status, 'unverified');

  const ok = await api(director2, `/accounts/${acctId}/verify`, { method: 'POST', body: { method: 'cancelled_cheque' }, stepUp: 'u2' });
  assert.equal(ok.status, 200);
  assert.equal(db.fin_party_accounts[0].status, 'verified');
  assert.equal(db.fin_party_accounts[0].verified_by, 'u2');
  assert.equal(db.audit.at(-1).action, 'finance.payee_verified');
  assert.equal((await api(director2, `/accounts/${acctId}/verify`, { method: 'POST', body: { method: 'cancelled_cheque' }, stepUp: 'u2' })).status, 400); // already verified
});

test('a finance-requests holder cannot read the directory', async () => {
  reset();
  const email = `fr-${++n}@gmail.com`;
  db.users.push({ id: 'u9', email, name: 'x', active: true, is_super_admin: false });
  db.roles.push({ staff_id: 'u9', module: 'finance-requests', role: 'user', scope: null, expires_at: null });
  assert.equal((await api(email, '/parties')).status, 403);
});

test('a member party links to a household; a vendor cannot', async () => {
  reset();
  const op = sign('u1', 'user');
  assert.equal((await api(op, '/parties', { method: 'POST', body: { name: 'Member One', kind: 'member', householdId: 'h1' } })).status, 201);
  assert.equal(db.fin_parties[0].household_id, 'h1');
  assert.equal((await api(op, '/parties', { method: 'POST', body: { name: 'Shop Two', kind: 'vendor', householdId: 'h1' } })).status, 400);
});

test('bank details loaded without an IFSC cannot be verified until one is added', async () => {
  reset();
  const director = sign('u2', 'admin');
  db.fin_parties.push({ id: 'p100', name: 'Test Traders', kind: 'vendor', active: true, household_id: null });
  db.fin_party_accounts.push({ id: 'a100', party_id: 'p100', entity_id: 'e1', method: 'bank', last4: '0001', fingerprint: 'x', status: 'unverified', created_by: null, details_enc: encryptFinanceText(JSON.stringify({ method: 'bank', account: ACCOUNT, ifsc: '' })) });
  const res = await api(director, '/accounts/a100/verify', { method: 'POST', body: { method: 'cancelled_cheque' }, stepUp: 'u2' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /IFSC/);
  assert.equal(db.fin_party_accounts[0].status, 'unverified');
  // adding the IFSC (new details) replaces the row, and that one can be verified by someone else
  const op = sign('u1', 'user');
  assert.equal((await api(op, '/parties/p100/accounts', { method: 'POST', body: { method: 'bank', account: ACCOUNT, ifsc: IFSC } })).status, 201);
  assert.deepEqual(db.fin_party_accounts.map((a) => a.status), ['superseded', 'unverified']);
});

// ---- retiring accounts, review flags, and dated changes
const day = (offset) => new Date(Date.now() + offset * 86_400_000 + 5.5 * 3_600_000).toISOString().slice(0, 10);
const seedParty = () => db.fin_parties.push({ id: 'p200', name: 'Test Traders', kind: 'vendor', active: true, household_id: null });
const seedAccount = (over = {}) => {
  const row = { id: `a${++n}`, party_id: 'p200', entity_id: 'e1', method: 'bank', last4: '0001', fingerprint: `fp${n}`, status: 'verified', created_by: 'u1', created_at: '2026-01-01T00:00:00Z', verified_by: 'u9', verified_at: '2026-01-02T00:00:00Z', has_ifsc: true, valid_from: null, retired_on: null, details_enc: encryptFinanceText(JSON.stringify({ method: 'bank', account: ACCOUNT, ifsc: IFSC })), ...over };
  db.fin_party_accounts.push(row);
  return row;
};

test('retiring an account needs verify-payee and the step-up, records who and why, and logs only the date', async () => {
  reset();
  seedParty();
  const acct = seedAccount();
  const op = sign('u1', 'user');
  const director = sign('u2', 'admin');
  const body = { on: day(-1), reason: 'Bank merged; the old number no longer works' };

  assert.equal((await api(op, `/accounts/${acct.id}/retire`, { method: 'POST', body, stepUp: 'u1' })).status, 403); // no verify-payee
  const noStep = await api(director, `/accounts/${acct.id}/retire`, { method: 'POST', body });
  assert.equal((await noStep.json()).code, 'STEP_UP_REQUIRED');
  assert.equal(acct.retired_on, null);

  const ok = await api(director, `/accounts/${acct.id}/retire`, { method: 'POST', body, stepUp: 'u2' });
  assert.equal(ok.status, 200);
  assert.equal(acct.retired_on, body.on);
  assert.equal(acct.retired_by, 'u2');
  assert.equal(acct.retire_reason, body.reason);
  const row = db.audit.at(-1);
  assert.equal(row.action, 'finance.payee_retired');
  assert.deepEqual(row.detail, { partyId: 'p200', on: body.on });
  assert.ok(!JSON.stringify(row).includes('merged'), 'the free-text reason stays out of the audit log');
  assert.ok(auditDetailIsSafe(row.detail));

  // From the retirement day the list shows it as retired and not payable.
  const list = await (await api(director, '/parties')).json();
  const shown = list.parties[0].accounts[0];
  assert.equal(shown.retiredOn, body.on);
  assert.equal(shown.payableNow, false);
});

test('a retirement can be moved earlier but not later, and a replaced account cannot be retired', async () => {
  reset();
  seedParty();
  const acct = seedAccount({ retired_on: day(10), retired_at: 'x', retired_by: 'u2', retire_reason: 'merger' });
  const gone = seedAccount({ status: 'superseded', superseded_at: '2026-02-01T00:00:00Z' });
  const director = sign('u2', 'admin');
  const retire = (id, on) => api(director, `/accounts/${id}/retire`, { method: 'POST', body: { on, reason: 'merger date moved' }, stepUp: 'u2' });
  assert.equal((await retire(acct.id, day(20))).status, 400);
  assert.equal(acct.retired_on, day(10));
  assert.equal((await retire(acct.id, day(5))).status, 200);
  assert.equal(acct.retired_on, day(5));
  assert.equal((await retire(gone.id, day(5))).status, 400);
});

test('a payee with two live bank accounts is flagged for review; confirming "keep both" clears it and is logged', async () => {
  reset();
  seedParty();
  seedAccount({ created_at: '2026-01-01T00:00:00Z' });
  seedAccount({ created_at: '2026-03-01T00:00:00Z' });
  const director = sign('u2', 'admin');
  const before = await (await api(director, '/parties')).json();
  assert.equal(before.parties[0].needsReview, true);
  assert.equal(before.needsReviewCount, 1);
  assert.deepEqual(before.parties[0].accounts.map((a) => a.review), [['multiple_live_accounts'], ['multiple_live_accounts']]);

  assert.equal((await (await api(director, '/parties/p200/review', { method: 'POST' })).json()).code, 'STEP_UP_REQUIRED');
  const res = await api(director, '/parties/p200/review', { method: 'POST', stepUp: 'u2' });
  assert.equal(res.status, 200);
  assert.equal(db.audit.at(-1).action, 'finance.party_reviewed');
  const after = await (await api(director, '/parties')).json();
  assert.equal(after.parties[0].needsReview, false);
});

test('retiring one of two live accounts, from today, clears the flag on the other', async () => {
  reset();
  seedParty();
  const old = seedAccount({ created_at: '2026-01-01T00:00:00Z' });
  seedAccount({ created_at: '2026-03-01T00:00:00Z' });
  const director = sign('u2', 'admin');
  await api(director, `/accounts/${old.id}/retire`, { method: 'POST', body: { on: day(0), reason: 'old number closed' }, stepUp: 'u2' });
  const list = await (await api(director, '/parties')).json();
  assert.equal(list.parties[0].needsReview, false);
});

test('a change with an effective date keeps the old account payable until then and starts the new one on that day', async () => {
  reset();
  seedParty();
  const old = seedAccount();
  const director = sign('u2', 'admin');
  const on = day(30);
  const res = await api(director, '/parties/p200/accounts', { method: 'POST', body: { method: 'bank', account: ACCOUNT_2, ifsc: IFSC, effectiveOn: on }, stepUp: 'u2' });
  assert.equal(res.status, 201);
  assert.equal(old.status, 'verified'); // not superseded
  assert.equal(old.retired_on, on);
  const fresh = db.fin_party_accounts.at(-1);
  assert.equal(fresh.status, 'unverified');
  assert.equal(fresh.valid_from, on);
  assert.equal(fresh.has_ifsc, true);
  const list = await (await api(director, '/parties')).json();
  const [oldShown, freshShown] = list.parties[0].accounts;
  assert.equal(oldShown.payableNow, true); // still fine today
  assert.equal(freshShown.payableNow, false); // unverified, and not started
});

test('entering details with an effective date needs verify-payee and the step-up', async () => {
  reset();
  seedParty();
  seedAccount();
  const op = sign('u1', 'user');
  const director = sign('u2', 'admin');
  const body = { method: 'bank', account: ACCOUNT_2, ifsc: IFSC, effectiveOn: day(30) };
  assert.equal((await api(op, '/parties/p200/accounts', { method: 'POST', body })).status, 403);
  assert.equal((await (await api(director, '/parties/p200/accounts', { method: 'POST', body })).json()).code, 'STEP_UP_REQUIRED');
  assert.equal(db.fin_party_accounts.length, 1);
});

test('details entered without an IFSC-less import flag are marked has_ifsc, and an already retired account cannot be verified', async () => {
  reset();
  seedParty();
  const director = sign('u2', 'admin');
  const op = sign('u1', 'user');
  await api(op, '/parties/p200/accounts', { method: 'POST', body: { method: 'upi', upi: 'test.vendor@okbank' } });
  assert.equal(db.fin_party_accounts.at(-1).has_ifsc, true); // UPI has no IFSC to miss
  const stale = seedAccount({ status: 'unverified', created_by: 'u1', verified_by: null, verified_at: null, retired_on: day(-3), retired_at: 'x', retired_by: 'u2', retire_reason: 'closed' });
  const res = await api(director, `/accounts/${stale.id}/verify`, { method: 'POST', body: { method: 'cancelled_cheque' }, stepUp: 'u2' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /retired/i);
  assert.equal(stale.status, 'unverified');
});

// ---- merging duplicate parties
const seedTwoParties = () => {
  db.fin_parties.push({ id: 'pa', name: 'Test Traders', kind: 'vendor', active: true, household_id: null, merged_into: null });
  db.fin_parties.push({ id: 'pb', name: 'Test Traders Old', kind: 'vendor', active: true, household_id: null, merged_into: null });
  const mainAcct = seedAccount({ party_id: 'pa', created_at: '2026-03-01T00:00:00Z' });
  const oldAcct = seedAccount({ party_id: 'pb', created_at: '2026-01-01T00:00:00Z' });
  return { mainAcct, oldAcct };
};

test('merging two parties needs verify-payee and the step-up, hides the duplicate, and logs ids only', async () => {
  reset();
  seedTwoParties();
  const op = sign('u1', 'user');
  const director = sign('u2', 'admin');
  assert.equal((await api(op, '/parties/pb/merge', { method: 'POST', body: { into: 'pa' }, stepUp: 'u1' })).status, 403);
  assert.equal((await (await api(director, '/parties/pb/merge', { method: 'POST', body: { into: 'pa' } })).json()).code, 'STEP_UP_REQUIRED');
  assert.equal(db.fin_parties[1].merged_into, null);

  const ok = await api(director, '/parties/pb/merge', { method: 'POST', body: { into: 'pa' }, stepUp: 'u2' });
  assert.equal(ok.status, 200);
  assert.equal(db.fin_parties[1].merged_into, 'pa');
  const row = db.audit.at(-1);
  assert.equal(row.action, 'finance.party_merged');
  assert.deepEqual(row.detail, { into: 'pa', accounts: 1 });
  assert.equal(db.fin_party_accounts.length, 2); // nothing moved or deleted
});

test('after a merge the list shows one party holding both sets of accounts, flagged for review', async () => {
  reset();
  seedTwoParties();
  const director = sign('u2', 'admin');
  await api(director, '/parties/pb/merge', { method: 'POST', body: { into: 'pa' }, stepUp: 'u2' });
  const list = await (await api(director, '/parties')).json();
  assert.equal(list.parties.length, 1);
  assert.equal(list.parties[0].name, 'Test Traders');
  assert.equal(list.parties[0].mergedCount, 1);
  assert.equal(list.parties[0].accounts.length, 2);
  assert.equal(list.parties[0].needsReview, true); // the old and the new bank account
});

test('merge is refused into itself, into an already merged party, and for a party others were merged into', async () => {
  reset();
  seedTwoParties();
  db.fin_parties.push({ id: 'pc', name: 'Third Party', kind: 'vendor', active: true, household_id: null, merged_into: null });
  const director = sign('u2', 'admin');
  const merge = (from, into) => api(director, `/parties/${from}/merge`, { method: 'POST', body: { into }, stepUp: 'u2' });
  assert.equal((await merge('pa', 'pa')).status, 400);
  assert.equal((await merge('pb', 'pa')).status, 200);
  assert.equal((await merge('pc', 'pb')).status, 400); // pb is itself merged
  assert.equal((await merge('pa', 'pc')).status, 400); // pb was merged into pa
  assert.equal((await merge('pb', 'pc')).status, 400); // already merged
  assert.equal((await merge('pa', 'missing')).status, 404);
});

test('undoing a merge brings the duplicate back, with its own accounts', async () => {
  reset();
  seedTwoParties();
  const director = sign('u2', 'admin');
  await api(director, '/parties/pb/merge', { method: 'POST', body: { into: 'pa' }, stepUp: 'u2' });
  assert.equal((await api(director, '/parties/pb/unmerge', { method: 'POST' })).status, 403); // needs the step-up too
  assert.equal((await api(director, '/parties/pb/unmerge', { method: 'POST', stepUp: 'u2' })).status, 200);
  assert.equal(db.audit.at(-1).action, 'finance.party_unmerged');
  const list = await (await api(director, '/parties')).json();
  assert.equal(list.parties.length, 2);
});

test('changing details on the main party replaces the live bank accounts of both; the new row belongs to the main party', async () => {
  reset();
  seedTwoParties();
  const director = sign('u2', 'admin');
  const op = sign('u1', 'user');
  await api(director, '/parties/pb/merge', { method: 'POST', body: { into: 'pa' }, stepUp: 'u2' });
  const before = db.fin_party_accounts.length;
  const res = await api(op, '/parties/pa/accounts', { method: 'POST', body: { method: 'bank', account: ACCOUNT_2, ifsc: IFSC } });
  assert.equal(res.status, 201);
  // the new row belongs to the main party and the main party's existing bank accounts (both of them) were superseded
  assert.equal(db.fin_party_accounts.length, before + 1);
  assert.equal(db.fin_party_accounts.at(-1).party_id, 'pa');
  assert.deepEqual(db.fin_party_accounts.slice(0, 2).map((a) => a.status), ['superseded', 'superseded']);
});

test('entering details the merged-in party already holds adds nothing', async () => {
  reset();
  seedTwoParties();
  db.fin_party_accounts[1].fingerprint = fingerprintFinanceText(ACCOUNT); // the old party really holds ACCOUNT + IFSC
  const director = sign('u2', 'admin');
  const op = sign('u1', 'user');
  await api(director, '/parties/pb/merge', { method: 'POST', body: { into: 'pa' }, stepUp: 'u2' });
  const res = await api(op, '/parties/pa/accounts', { method: 'POST', body: { method: 'bank', account: ACCOUNT, ifsc: IFSC } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { unchanged: true });
  assert.equal(db.fin_party_accounts.length, 2);
});

// ---- how the details were checked, and the Overview's summary
const verifyBody = (over = {}) => ({ method: 'cancelled_cheque', ...over });

test('verifying needs a method; "Other" needs a note; the note may not carry an account number', async () => {
  reset();
  seedParty();
  const acct = seedAccount({ status: 'unverified', created_by: 'u1', verified_by: null, verified_at: null });
  const director = sign('u2', 'admin');
  const verify = (body) => api(director, `/accounts/${acct.id}/verify`, { method: 'POST', body, stepUp: 'u2' });
  assert.equal((await verify({})).status, 400);
  assert.equal((await verify({ method: 'guess' })).status, 400);
  assert.equal((await verify(verifyBody({ method: 'other' }))).status, 400);
  assert.equal((await verify(verifyBody({ note: 'acct 100000000001' }))).status, 400);
  assert.equal(acct.status, 'unverified');
});

test('a verification records how, with the note kept on the row and only the method in the audit log', async () => {
  reset();
  seedParty();
  const acct = seedAccount({ status: 'unverified', created_by: 'u1', verified_by: null, verified_at: null });
  const director = sign('u2', 'admin');
  const res = await api(director, `/accounts/${acct.id}/verify`, { method: 'POST', body: verifyBody({ method: 'test_transfer', note: 'Rs 1 arrived on 2 Nov' }), stepUp: 'u2' });
  assert.equal(res.status, 200);
  assert.equal(acct.verification_method, 'test_transfer');
  assert.equal(acct.verification_note, 'Rs 1 arrived on 2 Nov');
  const row = db.audit.at(-1);
  assert.deepEqual(row.detail, { partyId: 'p200', method: 'test_transfer' });
  assert.ok(!JSON.stringify(row).includes('arrived'));
  const list = await (await api(director, '/parties')).json();
  assert.deepEqual(list.parties[0].accounts[0].verification.method, 'test_transfer');
  assert.equal(list.parties[0].accounts[0].verification.by, 'u2'); // the verifier's name
  assert.equal(list.parties[0].accounts[0].verification.note, 'Rs 1 arrived on 2 Nov');
});

test('the overview carries a "needs you" summary: payees to verify, those needing review, and no names or numbers', async () => {
  reset();
  seedParty();
  seedAccount({ status: 'unverified', created_by: 'u1', verified_by: null, verified_at: null });
  db.fin_parties.push({ id: 'p201', name: 'Second Vendor', kind: 'vendor', active: true, household_id: null, merged_into: null });
  seedAccount({ party_id: 'p201', status: 'unverified', created_by: 'u1', verified_by: null, verified_at: null, has_ifsc: false });
  const viewer = sign('u3', 'read_only');
  const res = await handler(new Request('https://x.test/api/finance-admin/overview', { headers: { authorization: `Bearer ${viewer}` } }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.attention.parties, 2);
  assert.equal(body.attention.toVerify, 2);
  assert.equal(body.attention.needsReview, 1); // the one missing an IFSC
  assert.equal(body.hasData, true);
  const text = JSON.stringify(body.attention);
  assert.ok(!text.includes('Second Vendor') && !text.includes(ACCOUNT));
});
