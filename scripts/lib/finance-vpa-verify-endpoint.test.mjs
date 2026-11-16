// Run with: node --test scripts/lib/finance-vpa-verify-endpoint.test.mjs
//
// Drives the real finance-admin Function: verifying a party's UPI details with the Razorpay lookup (method `razorpay_vpa`). The registered name
// is Razorpay's answer and nothing the page sends, it is asked once and kept, it is for a UPI ID only, the person who added the details still
// cannot verify them, and the audit row names the method but no UPI ID or name. Every UPI ID, name and key here is invented.
// Needs `npm ci` (esbuild) and Node 22.18+.
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
process.env.RAZORPAY_KEY_SECRET = 'secret';
const { signStepUp } = await import('../../netlify/functions/lib/staff-mfa-crypto.ts');

const stubGoogle = {
  name: 'stub-google',
  setup(b) {
    b.onResolve({ filter: /google-id-token\.mjs$/ }, () => ({ path: 'stub-google', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export async function verifyGoogleIdToken(t){ return { email: t, hd: t.split("@")[1] }; }', loader: 'js' }));
  },
};
const stubStorage = {
  name: 'stub-storage',
  setup(b) {
    b.onResolve({ filter: /finance-storage$/ }, () => ({ path: 'stub-storage', namespace: 'stub-r2' }));
    b.onLoad({ filter: /.*/, namespace: 'stub-r2' }, () => ({ contents: 'export async function putFinanceVoucher(){} export async function getFinanceVoucher(){ return null; } export async function deleteFinanceVoucher(){} export async function putFinanceImport(){} export async function deleteFinanceImport(){}', loader: 'js' }));
  },
};
const dir = mkdtempSync(join(tmpdir(), 'finance-vpa-verify-'));
const out = join(dir, 'finance-admin.mjs');
await build({ entryPoints: ['netlify/functions/finance-admin.mts'], bundle: true, platform: 'node', format: 'esm', outfile: out, plugins: [stubGoogle, stubStorage], logLevel: 'silent' });
const { default: handler } = await import(pathToFileURL(out).href);

const ACCOUNT = '100000000001';
const IFSC = 'ABCD0123456';
const VPA = 'q000111222@ybl';

let db;
let razorpay;
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
  const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  if (u.hostname === 'api.razorpay.com') {
    const asked = JSON.parse(init.body).vpa;
    razorpay.asked.push(asked);
    const answer = razorpay.answers[asked] ?? { vpa: asked, success: false };
    return answer.__status ? json({ error: { description: answer.description } }, answer.__status) : json(answer);
  }
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
    db.audit.push(JSON.parse(init.body));
    return new Response(null, { status: 201 });
  }
  if (table === 'fin_entities') return json([{ id: 'e1', name: 'Test Entity' }]);
  if (table === 'member_households') return json([{ id: 'h1' }]);
  if (table === 'fin_vpa_names') {
    if (method === 'POST') {
      const body = JSON.parse(init.body);
      db.fin_vpa_names = db.fin_vpa_names.filter((r) => r.vpa !== body.vpa);
      db.fin_vpa_names.push(body);
      return new Response(null, { status: 201 });
    }
    return json(db.fin_vpa_names.filter((r) => matches(r, u.searchParams)));
  }
  if (table === 'fin_parties' || table === 'fin_party_accounts' || table === 'fin_party_account_files' || table === 'fin_upi_lines') {
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

const reset = (keyId = 'rzp_live_test') => {
  process.env.RAZORPAY_KEY_ID = keyId;
  razorpay = { asked: [], answers: {} };
  db = { users: [], roles: [], fin_parties: [], fin_party_accounts: [], fin_party_account_files: [], fin_vpa_names: [], fin_upi_lines: [], audit: [] };
};
const sign = (id, role) => {
  const email = `${id}-${++n}@gmail.com`;
  db.users.push({ id, email, name: id, active: true, is_super_admin: false });
  db.roles.push({ staff_id: id, module: 'finance', role, scope: null, expires_at: null });
  return email;
};
const api = (email, path, { method = 'GET', body, stepUp = false } = {}) =>
  handler(new Request(`https://x.test/api/finance-admin${path}`, { method, headers: { authorization: `Bearer ${email}`, ...(body ? { 'content-type': 'application/json' } : {}), ...(stepUp ? { 'x-stepup-token': signStepUp(stepUp, 'totp', Date.now()) } : {}) }, body: body ? JSON.stringify(body) : undefined }));
// Someone adds a party with the UPI ID (as the ledger does on accepting a looked-up name); a second admin then verifies it.
const addUpiParty = async () => {
  const maker = sign('u1', 'admin');
  const made = await api(maker, '/parties', { method: 'POST', body: { name: 'Test Vendor Works', kind: 'vendor', payee: { method: 'upi', upi: VPA } } });
  assert.equal(made.status, 201);
  return { maker, checker: sign('u2', 'admin'), accountId: db.fin_party_accounts[0].id };
};
const verify = (email, accountId, body = { method: 'razorpay_vpa' }) => api(email, `/accounts/${accountId}/verify`, { method: 'POST', body, stepUp: email.startsWith('u1') ? 'u1' : 'u2' });

test('a second admin verifies a UPI ID with the Razorpay lookup, and the name recorded is Razorpay’s', async () => {
  reset();
  razorpay.answers[VPA] = { vpa: VPA, success: true, customer_name: 'TEST VENDOR WORKS' };
  const { checker, accountId } = await addUpiParty();
  const res = await verify(checker, accountId, { method: 'razorpay_vpa', name: 'Typed By The Page' });
  assert.equal(res.status, 200);
  const acct = db.fin_party_accounts[0];
  assert.equal(acct.status, 'verified');
  assert.equal(acct.verified_by, 'u2');
  assert.equal(acct.verification_method, 'razorpay_vpa');
  assert.equal(acct.verified_name, 'TEST VENDOR WORKS', 'the name comes from Razorpay, not from the request');
  assert.deepEqual(razorpay.asked, [VPA]);
});

test('whoever added the UPI details still cannot verify them', async () => {
  reset();
  razorpay.answers[VPA] = { vpa: VPA, success: true, customer_name: 'TEST VENDOR WORKS' };
  const { maker, accountId } = await addUpiParty();
  assert.equal((await verify(maker, accountId)).status, 403);
  assert.equal(db.fin_party_accounts[0].status, 'unverified');
});

test('an answer already kept is used, and Razorpay is not asked again', async () => {
  reset();
  db.fin_vpa_names.push({ vpa: VPA, success: true, name: 'KEPT NAME', key_mode: 'live' });
  const { checker, accountId } = await addUpiParty();
  assert.equal((await verify(checker, accountId)).status, 200);
  assert.deepEqual(razorpay.asked, []);
  assert.equal(db.fin_party_accounts[0].verified_name, 'KEPT NAME');
});

test('an ID with no registered name cannot be verified this way, and nothing changes', async () => {
  reset();
  razorpay.answers[VPA] = { vpa: VPA, success: true, customer_name: '' };
  const { checker, accountId } = await addUpiParty();
  const res = await verify(checker, accountId);
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /no registered name/i);
  assert.equal(db.fin_party_accounts[0].status, 'unverified');
});

test('a failed Razorpay call is reported in words and leaves the details unverified', async () => {
  reset();
  razorpay.answers[VPA] = { __status: 400, description: 'The requested URL was not found on the server.' };
  const { checker, accountId } = await addUpiParty();
  const res = await verify(checker, accountId);
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /not available on this account/i);
  assert.equal(db.fin_party_accounts[0].status, 'unverified');
  assert.equal(db.fin_vpa_names.length, 0);
});

test('test keys are not trusted to verify anyone', async () => {
  reset('rzp_test_abc');
  razorpay.answers[VPA] = { vpa: VPA, success: true, customer_name: 'TEST VENDOR WORKS' };
  const { checker, accountId } = await addUpiParty();
  const res = await verify(checker, accountId);
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /live keys/i);
  assert.deepEqual(razorpay.asked, [], 'no call is made with test keys');
});

test('the lookup is for a UPI ID only: bank details refuse it', async () => {
  reset();
  const maker = sign('u1', 'admin');
  await api(maker, '/parties', { method: 'POST', body: { name: 'Test Traders', kind: 'vendor', payee: { method: 'bank', account: ACCOUNT, ifsc: IFSC } } });
  const res = await verify(sign('u2', 'admin'), db.fin_party_accounts[0].id);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /UPI/);
  assert.deepEqual(razorpay.asked, []);
});

test('the audit row names the method and carries no UPI ID or name', async () => {
  reset();
  razorpay.answers[VPA] = { vpa: VPA, success: true, customer_name: 'TEST VENDOR WORKS' };
  const { checker, accountId } = await addUpiParty();
  await verify(checker, accountId);
  const entry = db.audit.find((a) => a.action === 'finance.payee_verified');
  assert.equal(entry.detail.method, 'razorpay_vpa');
  assert.ok(auditDetailIsSafe(entry.detail));
  assert.ok(!/ybl|q000111222|TEST VENDOR/i.test(JSON.stringify(entry)));
});

// ---- the UPI table's Party column and the reviewed add
const upiRow = (id, counterparty, direction = 'debit') => ({ id, paid_at: '2026-10-02', paid_time: '10:00:00', app: 'paytm', counterparty, remarks: 'x', tag: null, amount_paise: 35400, direction, is_circle: false, upi_ref: `REF${id}`, bank_account_id: null, bank_line_id: null, ignored: false });
const partyOf = async (email, rowId) => (await (await api(email, '/upi-lines')).json()).lines.find((l) => l.id === rowId).party;
const addParties = (email, items) => api(email, '/upi-lines/add-parties', { method: 'POST', body: { items } });
const kept = (vpa, name) => db.fin_vpa_names.push({ vpa, success: Boolean(name), name, key_mode: 'live' });

test('the party column follows the UPI ID: on file, matches, differs, and not looked up', async () => {
  reset();
  const op = sign('u1', 'user');
  db.fin_upi_lines.push(upiRow('r1', `${VPA} on PhonePe`));
  await api(op, '/parties', { method: 'POST', body: { name: 'Test Vendor Works', kind: 'vendor', payee: { method: 'upi', upi: VPA } } });
  assert.equal((await partyOf(op, 'r1')).state, 'onfile', 'the ID is on a party but has not been looked up');
  kept(VPA, 'TEST VENDOR WORKS');
  assert.deepEqual(await partyOf(op, 'r1'), { state: 'matches', partyId: db.fin_parties[0].id, partyName: 'Test Vendor Works', partyKind: 'vendor', accountStatus: 'unverified', verifiedName: null, registeredName: 'TEST VENDOR WORKS' });
  db.fin_vpa_names.length = 0;
  kept(VPA, 'SOMEONE ELSE ENTIRELY');
  const differs = await partyOf(op, 'r1');
  assert.equal(differs.state, 'differs');
  assert.equal(differs.registeredName, 'SOMEONE ELSE ENTIRELY');
});

test('a reviewed add puts the person in Parties with the UPI ID unverified, once, and the row then matches', async () => {
  reset();
  const op = sign('u1', 'user');
  db.fin_upi_lines.push(upiRow('r1', `${VPA} on PhonePe`), upiRow('r2', `${VPA} on PhonePe`));
  kept(VPA, 'NEW PERSON NAME');
  assert.equal((await partyOf(op, 'r1')).state, 'missing');
  const res = await addParties(op, [{ rowId: 'r1' }, { rowId: 'r2' }]);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { added: 1, attached: 0, skipped: 0, reasons: [] });
  assert.equal(db.fin_parties.length, 1, 'two rows for the same ID make one party');
  assert.equal(db.fin_parties[0].name, 'New Person Name');
  assert.equal(db.fin_parties[0].kind, 'vendor');
  assert.equal(db.fin_party_accounts[0].status, 'unverified', 'a second admin verifies it');
  assert.equal(db.fin_party_accounts[0].method, 'upi');
  assert.equal((await partyOf(op, 'r1')).state, 'matches');
});

test('the reviewer’s edited name and kind are used, and a credit is a customer by default', async () => {
  reset();
  const op = sign('u1', 'user');
  db.fin_upi_lines.push(upiRow('r1', `${VPA} on PhonePe`, 'credit'));
  kept(VPA, 'NEW PERSON NAME');
  await addParties(op, [{ rowId: 'r1' }]);
  assert.equal(db.fin_parties[0].kind, 'customer');
  reset();
  const op2 = sign('u1', 'user');
  db.fin_upi_lines.push(upiRow('r1', `${VPA} on PhonePe`));
  kept(VPA, 'NEW PERSON NAME');
  await addParties(op2, [{ rowId: 'r1', name: 'Fixed Name Co', kind: 'other' }]);
  assert.deepEqual([db.fin_parties[0].name, db.fin_parties[0].kind], ['Fixed Name Co', 'other']);
});

test('an ID whose registered name matches a party is attached to that party, not added again', async () => {
  reset();
  const op = sign('u1', 'user');
  await api(op, '/parties', { method: 'POST', body: { name: 'Test Vendor Works', kind: 'vendor' } });
  db.fin_upi_lines.push(upiRow('r1', `${VPA} on PhonePe`));
  kept(VPA, 'TEST VENDOR WORKS');
  const before = await partyOf(op, 'r1');
  assert.equal(before.state, 'attach');
  const res = await addParties(op, [{ rowId: 'r1' }]);
  assert.deepEqual(await res.json(), { added: 0, attached: 1, skipped: 0, reasons: [] });
  assert.equal(db.fin_parties.length, 1);
  assert.equal(db.fin_party_accounts[0].party_id, db.fin_parties[0].id);
  assert.equal(db.fin_party_accounts[0].status, 'unverified');
  assert.equal((await partyOf(op, 'r1')).state, 'matches');
});

test('the server decides from its own data: rows that need nothing, are not looked up, or are gone are skipped, not forced in', async () => {
  reset();
  const op = sign('u1', 'user');
  db.fin_upi_lines.push(upiRow('r-lookup', VPA));
  const res = await (await addParties(op, [{ rowId: 'r-lookup', name: 'Forced Name', kind: 'vendor' }, { rowId: 'nope' }])).json();
  assert.equal(res.added, 0);
  assert.equal(res.skipped, 2);
  assert.equal(db.fin_parties.length, 0, 'a typed name cannot add someone the lookup has not named');
});

test('a plain name from the app is added by name alone, with no UPI ID to attach', async () => {
  reset();
  const op = sign('u1', 'user');
  db.fin_upi_lines.push(upiRow('r1', 'Brand New Farm Shop'));
  assert.equal((await partyOf(op, 'r1')).state, 'missing');
  await addParties(op, [{ rowId: 'r1' }]);
  assert.equal(db.fin_parties[0].name, 'Brand New Farm Shop');
  assert.equal(db.fin_party_accounts.length, 0);
});

// ---- a payment gateway's UPI ID names the gateway, not the payee
const GATEWAY = 'RAZORPAY SOFTWARE PRIVATE LIMITED';

test('a gateway ID shows as a payment gateway, offers no name, and each payment is added by hand with no ID attached', async () => {
  reset();
  const op = sign('u1', 'user');
  db.fin_upi_lines.push(upiRow('g1', `${VPA} on PhonePe`), upiRow('g2', `${VPA} on PhonePe`));
  kept(VPA, GATEWAY);
  assert.deepEqual(await partyOf(op, 'g1'), { state: 'gateway', registeredName: GATEWAY, kind: 'vendor' });
  // No name typed: nothing is made up from the gateway.
  const none = await (await addParties(op, [{ rowId: 'g1' }])).json();
  assert.deepEqual([none.added, none.skipped], [0, 1]);
  assert.match(none.reasons[0], /Type the name/);
  assert.equal(db.fin_parties.length, 0);
  // The gateway's own name is refused as the payee.
  assert.equal((await (await addParties(op, [{ rowId: 'g1', name: 'Razorpay Software' }])).json()).added, 0);
  // Two payments through the same gateway ID are two different payees: not merged.
  const res = await (await addParties(op, [{ rowId: 'g1', name: 'First Real Payee' }, { rowId: 'g2', name: 'Second Real Payee', kind: 'other' }])).json();
  assert.deepEqual([res.added, res.skipped], [2, 0]);
  assert.deepEqual(db.fin_parties.map((p) => p.name), ['First Real Payee', 'Second Real Payee']);
  assert.equal(db.fin_party_accounts.length, 0, 'the gateway’s UPI ID is attached to nobody');
});

test('a gateway ID is recognised by its own name before any lookup, so no billed call is wasted on it', async () => {
  reset();
  const op = sign('u1', 'user');
  db.fin_upi_lines.push(upiRow('g1', 'razorpay.shop@icici on PhonePe'));
  assert.equal((await partyOf(op, 'g1')).state, 'gateway');
});

test('a gateway ID cannot verify anyone, whether it was given to a party earlier or not', async () => {
  reset();
  const maker = sign('u1', 'admin');
  await api(maker, '/parties', { method: 'POST', body: { name: 'Some Payee', kind: 'vendor', payee: { method: 'upi', upi: VPA } } });
  kept(VPA, GATEWAY);
  const res = await verify(sign('u2', 'admin'), db.fin_party_accounts[0].id);
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /payment gateway/i);
  assert.equal(db.fin_party_accounts[0].status, 'unverified');
  reset();
  const maker2 = sign('u1', 'admin');
  await api(maker2, '/parties', { method: 'POST', body: { name: 'Some Payee', kind: 'vendor', payee: { method: 'upi', upi: 'razorpay.shop@icici' } } });
  const byId = await verify(sign('u2', 'admin'), db.fin_party_accounts[0].id);
  assert.equal(byId.status, 409);
  assert.deepEqual(razorpay.asked, [], 'recognised by the ID alone: Razorpay is not asked');
});

test('the reviewer can add someone without attaching their UPI ID', async () => {
  reset();
  const op = sign('u1', 'user');
  db.fin_upi_lines.push(upiRow('r1', `${VPA} on PhonePe`));
  kept(VPA, 'NEW PERSON NAME');
  await addParties(op, [{ rowId: 'r1', attachId: false }]);
  assert.equal(db.fin_parties[0].name, 'New Person Name');
  assert.equal(db.fin_party_accounts.length, 0);
});

test('only someone who may allocate can add, nothing is sent without items, and the audit has counts only', async () => {
  reset();
  db.fin_upi_lines.push(upiRow('r1', `${VPA} on PhonePe`));
  kept(VPA, 'NEW PERSON NAME');
  assert.equal((await addParties(sign('u9', 'read_only'), [{ rowId: 'r1' }])).status, 403);
  const op = sign('u1', 'user');
  assert.equal((await addParties(op, [])).status, 400);
  await addParties(op, [{ rowId: 'r1' }]);
  const entry = db.audit.find((a) => a.action === 'finance.upi_parties_added');
  assert.deepEqual(entry.detail, { added: 1, attached: 0, skipped: 0 });
  assert.ok(!/ybl|q000111222|NEW PERSON|New Person/i.test(JSON.stringify(entry)));
});
