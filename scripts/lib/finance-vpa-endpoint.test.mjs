// Run with: node --test scripts/lib/finance-vpa-endpoint.test.mjs
//
// Drives the real finance-admin Function (the UPI ID name lookup) with Google, Supabase and Razorpay stubbed: who may ask, that only IDs
// not asked about before go to Razorpay, that the first failure stops the batch, that the audit row carries a count and no UPI ID, that a
// test-key answer is kept but never used, and that the ledger then suggests the registered name. Every UPI ID, name and key is invented.
// Needs `npm ci` (esbuild), Node 22.18+.
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
process.env.RAZORPAY_KEY_SECRET = 'secret';

const stubGoogle = {
  name: 'stub-google',
  setup(b) {
    b.onResolve({ filter: /google-id-token\.mjs$/ }, () => ({ path: 'stub-google', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export async function verifyGoogleIdToken(t){ return { email: t, hd: t.split("@")[1] }; }', loader: 'js' }));
  },
};
const dir = mkdtempSync(join(tmpdir(), 'finance-vpa-'));
const out = join(dir, 'finance-admin.mjs');
await build({ entryPoints: ['netlify/functions/finance-admin.mts'], bundle: true, platform: 'node', format: 'esm', outfile: out, plugins: [stubGoogle], logLevel: 'silent' });
const { default: handler } = await import(pathToFileURL(out).href);

const ID = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const E = ID(1);
const L_VPA = ID(31);
const VPA_A = 'q000111222@ybl';
const VPA_B = 'test.person@okaxis';

let db;
let razorpay; // what the stub answers, by UPI ID; and the IDs it was asked about
let n = 100;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const method = init.method ?? 'GET';
  const body = init.body ? JSON.parse(init.body) : null;
  if (u.host === 'api.razorpay.com') {
    assert.equal(u.pathname, '/v1/payments/validate/vpa');
    assert.ok(String(init.headers.Authorization).startsWith('Basic '), 'asked with the account keys');
    razorpay.asked.push(body.vpa);
    const answer = razorpay.answers[body.vpa] ?? { vpa: body.vpa, success: false };
    return answer.__status ? json({ error: { description: answer.description } }, answer.__status) : json(answer);
  }
  const table = u.pathname.replace('/rest/v1/', '');
  if (table === 'staff_users') return json(db.users.filter((x) => u.searchParams.get('email') === `eq.${x.email}`));
  if (table === 'staff_module_roles') {
    const id = u.searchParams.get('staff_id')?.slice(3);
    const mod = u.searchParams.get('module')?.slice(3);
    return json(db.roles.filter((r) => r.staff_id === id && r.module === mod).map(({ role, scope, expires_at }) => ({ role, scope, expires_at })));
  }
  if (table === 'staff_mfa_factors' || table === 'staff_recovery_codes') return json([]);
  if (table === 'fin_audit_log' && method === 'POST') {
    db.audit.push(body);
    return new Response(null, { status: 201 });
  }
  if (table === 'fin_vpa_names' && method === 'POST') {
    db.fin_vpa_names = db.fin_vpa_names.filter((r) => r.vpa !== body.vpa);
    db.fin_vpa_names.push(body);
    return new Response(null, { status: 201 });
  }
  // Before migration 0102 there is no answers table and PostgREST answers 404.
  if (db.noVpaTable && table === 'fin_vpa_names') return new Response(JSON.stringify({ message: 'relation does not exist' }), { status: 404, headers: { 'content-type': 'application/json' } });
  if (table.startsWith('fin_') || table === 'member_households') {
    const rows = db[table] ?? [];
    if (method === 'GET') {
      const offset = Number(u.searchParams.get('offset') ?? 0);
      const limit = Math.min(Number(u.searchParams.get('limit') ?? 1000), 1000);
      const eq = [...u.searchParams].filter(([, v]) => v.startsWith('eq.'));
      return json(rows.filter((r) => eq.every(([k, v]) => String(r[k]) === v.slice(3))).slice(offset, offset + limit));
    }
  }
  throw new Error(`unexpected fetch ${method} ${url}`);
};

const reset = (keyId = 'rzp_live_test') => {
  process.env.RAZORPAY_KEY_ID = keyId;
  razorpay = { asked: [], answers: {} };
  db = {
    users: [], roles: [], audit: [],
    fin_entities: [{ id: E, requester_party_id: null, created_at: '2026-01-01' }],
    fin_categories: [{ id: ID(11), name: 'Materials and supplies', type: 'opex', active: true }],
    fin_parties: [],
    fin_party_accounts: [],
    fin_projects: [],
    member_households: [],
    fin_rules: [],
    fin_periods: [],
    fin_bank_accounts: [{ id: ID(2), label: 'Test current' }],
    fin_upi_lines: [],
    fin_vpa_names: [],
    fin_bank_lines: [{ id: L_VPA, entity_id: E, bank_account_id: ID(2), tran_date: '2026-10-02', narration: `UPI/P2A/123456789012/${VPA_A} on PhonePe/Okbank/x`, direction: 'debit', amount_paise: 35400 }],
    fin_allocations: [],
  };
};
const sign = (role) => {
  const email = `u${++n}@gmail.com`;
  db.users.push({ id: `u${n}`, email, name: 'U', active: true, is_super_admin: false });
  db.roles.push({ staff_id: `u${n}`, module: 'finance', role, scope: null, expires_at: null });
  return email;
};
const api = (email, path, { method = 'GET', body } = {}) =>
  handler(new Request(`https://x.test/api/finance-admin${path}${method === 'GET' ? `${path.includes('?') ? '&' : '?'}fresh=1` : ''}`, { method, headers: { authorization: `Bearer ${email}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }));
const lookup = (email, texts) => api(email, '/vpa-names', { method: 'POST', body: { texts } });
const suggestedName = async (email) => (await (await api(email, '/ledger?filter=all')).json()).lines.find((l) => l.id === L_VPA).suggestion?.newPartyName;

test('an admin who allocates looks up the IDs, the names are kept, and the ledger suggests the name', async () => {
  reset();
  razorpay.answers[VPA_A] = { vpa: VPA_A, success: true, customer_name: 'TEST VENDOR WORKS' };
  const op = sign('user');
  assert.equal(await suggestedName(op), `${VPA_A} on PhonePe`, 'before a lookup the line carries the bare ID');
  const res = await lookup(op, [`${VPA_A} on PhonePe`, 'Plain Name', VPA_B]);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { asked: 2, named: 1, noName: 0, notFound: 1, stoppedBecause: null });
  assert.deepEqual(razorpay.asked, [VPA_A, VPA_B]);
  assert.equal(db.fin_vpa_names.find((r) => r.vpa === VPA_B).success, false);
  assert.equal(await suggestedName(op), 'Test Vendor Works');
});

test('a named suggestion carries the UPI ID it came from, so accepting it can attach the ID; an unnamed one does not', async () => {
  reset();
  razorpay.answers[VPA_A] = { vpa: VPA_A, success: true, customer_name: 'TEST VENDOR WORKS' };
  const op = sign('user');
  const vpaOf = async () => (await (await api(op, '/ledger?filter=all')).json()).lines.find((l) => l.id === L_VPA).suggestion.newPartyVpa;
  assert.equal(await vpaOf(), null, 'before a lookup there is no name to attach it to');
  await lookup(op, [VPA_A]);
  assert.equal(await vpaOf(), VPA_A);
});

test('a line is flagged for lookup until its ID has been asked about, even when the answer was no name', async () => {
  reset();
  const op = sign('user');
  const flag = async () => (await (await api(op, '/ledger?filter=all')).json()).lines.find((l) => l.id === L_VPA).suggestion.vpaToLookUp;
  assert.equal(await flag(), true);
  await lookup(op, [`${VPA_A} on PhonePe`]); // the stub knows nothing of it: success false
  assert.equal(await flag(), false, 'asked once, so not offered again');
  assert.equal(await suggestedName(op), `${VPA_A} on PhonePe`, 'and still the bare ID, as there is no name');
});

test('the audit row carries a count and the key mode, never a UPI ID or a name', async () => {
  reset();
  razorpay.answers[VPA_A] = { vpa: VPA_A, success: true, customer_name: 'TEST VENDOR WORKS' };
  await lookup(sign('user'), [VPA_A, VPA_B]);
  const entry = db.audit.find((a) => a.action === 'finance.vpa_names_looked_up');
  assert.deepEqual(entry.detail, { count: 2, key_mode: 'live' });
  assert.ok(!/ybl|okaxis|TEST VENDOR|person/i.test(JSON.stringify(entry)));
});

test('an ID already asked about is not asked again, whether it had a name or not', async () => {
  reset();
  razorpay.answers[VPA_A] = { vpa: VPA_A, success: true, customer_name: 'TEST VENDOR WORKS' };
  const op = sign('user');
  await lookup(op, [VPA_A, VPA_B]);
  razorpay.asked.length = 0;
  const again = await (await lookup(op, [VPA_A, VPA_B])).json();
  assert.equal(again.asked, 0);
  assert.deepEqual(razorpay.asked, []);
});

test('a read-only viewer cannot look up names, and nothing reaches Razorpay', async () => {
  reset();
  const res = await lookup(sign('read_only'), [VPA_A]);
  assert.equal(res.status, 403);
  assert.deepEqual(razorpay.asked, []);
  assert.equal(db.audit.length, 0);
});

test('the first failure stops the batch and says why; nothing is stored', async () => {
  reset();
  razorpay.answers[VPA_A] = { __status: 400, description: 'The requested URL was not found on the server.' };
  const res = await (await lookup(sign('user'), [VPA_A, VPA_B])).json();
  assert.equal(res.asked, 0);
  assert.match(res.stoppedBecause, /not available on this account/i);
  assert.deepEqual(razorpay.asked, [VPA_A], 'the second ID was never asked');
  assert.equal(db.fin_vpa_names.length, 0);
});

test('a test-key answer is kept but never used for a suggestion', async () => {
  reset('rzp_test_abc');
  razorpay.answers[VPA_A] = { vpa: VPA_A, success: true, customer_name: 'TEST VENDOR WORKS' };
  const op = sign('user');
  await lookup(op, [VPA_A]);
  assert.equal(db.fin_vpa_names[0].key_mode, 'test');
  assert.equal(await suggestedName(op), `${VPA_A} on PhonePe`);
});

test('a body without the texts is refused', async () => {
  reset();
  assert.equal((await api(sign('user'), '/vpa-names', { method: 'POST', body: { nope: 1 } })).status, 400);
});

// ---- the UPI table's Name and UPI ID columns
const upiRow = (id, counterparty) => ({ id, paid_at: '2026-10-02', paid_time: '10:00:00', app: 'bhim', counterparty, remarks: 'x', tag: null, amount_paise: 35400, direction: 'debit', is_circle: false, upi_ref: `REF${id}`, bank_account_id: ID(2), bank_line_id: null, ignored: false });
const upiRows = async (email) => (await (await api(email, '/upi-lines')).json());
const seedUpi = () => {
  db.fin_upi_lines.push(upiRow('u-named', `${VPA_A} on PhonePe`), upiRow('u-asked', `${VPA_B} on PhonePe`), upiRow('u-new', 'fresh.id@paytm'), upiRow('u-plain', 'Green Nursery'));
  db.fin_vpa_names.push({ vpa: VPA_A, success: true, name: 'TEST VENDOR WORKS', key_mode: 'live' }, { vpa: VPA_B, success: false, name: null, key_mode: 'live' });
};
const byId = (res) => Object.fromEntries(res.lines.map((l) => [l.id, l]));

test('an admin sees each row’s UPI ID in full, the registered name, and whether it was looked up', async () => {
  reset();
  seedUpi();
  const res = await upiRows(sign('admin'));
  assert.equal(res.canSeeUpiIds, true);
  const rows = byId(res);
  assert.deepEqual([rows['u-named'].upiId, rows['u-named'].vpaName, rows['u-named'].vpaState], [VPA_A, 'TEST VENDOR WORKS', 'named']);
  assert.deepEqual([rows['u-asked'].upiId, rows['u-asked'].vpaName, rows['u-asked'].vpaState], [VPA_B, null, 'asked']);
  assert.deepEqual([rows['u-new'].upiId, rows['u-new'].vpaState], ['fresh.id@paytm', 'new']);
  assert.deepEqual([rows['u-plain'].upiId, rows['u-plain'].vpaName, rows['u-plain'].vpaState], [null, null, null], 'a plain name has no UPI ID');
});

test('the masking rule: someone without payee-bank-details access sees the name but only a masked UPI ID', async () => {
  reset();
  seedUpi();
  const rows = byId(await upiRows(sign('user')));
  assert.equal(rows['u-named'].vpaName, 'TEST VENDOR WORKS', 'names are shown to anyone who can view');
  assert.equal(rows['u-named'].upiId, 'q••••@ybl');
  assert.equal(rows['u-new'].upiId, 'f••••@paytm');
  const viewer = await upiRows(sign('read_only'));
  assert.equal(viewer.canSeeUpiIds, false);
  assert.equal(viewer.canEdit, false, 'a viewer is not offered the lookup');
  assert.ok(!JSON.stringify(viewer.lines.map((l) => [l.upiId, l.vpaName, l.vpaState])).includes('q000111222'), 'the new fields never carry the full ID for them');
});

test('a database without the answers table still lists the payments, with nothing looked up', async () => {
  reset();
  seedUpi();
  db.noVpaTable = true;
  const res = await upiRows(sign('admin'));
  const rows = byId(res);
  assert.equal(rows['u-named'].vpaState, 'new', 'no answers yet, so it can be looked up');
  assert.equal(rows['u-named'].vpaName, null);
});

test('looking up from the UPI page names the ledger lines too: one lookup, two pages', async () => {
  reset();
  seedUpi();
  razorpay.answers['fresh.id@paytm'] = { vpa: 'fresh.id@paytm', success: true, customer_name: 'FRESH PERSON' };
  const op = sign('user');
  const texts = (await upiRows(op)).lines.filter((l) => l.vpaState === 'new').map((l) => l.counterparty);
  assert.deepEqual(texts, ['fresh.id@paytm']);
  const res = await lookup(op, texts);
  assert.deepEqual(await res.json(), { asked: 1, named: 1, noName: 0, notFound: 0, stoppedBecause: null });
  assert.equal(byId(await upiRows(op))['u-new'].vpaName, 'FRESH PERSON');
});
