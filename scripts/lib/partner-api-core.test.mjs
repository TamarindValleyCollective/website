import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePartnerRequest, BASE_PATH } from './partner-api-core.mjs';
import { generatePartnerKey, hashPartnerKey } from './partner-keys.mjs';

const NOW = new Date('2026-10-24T06:00:00Z');
const { key } = generatePartnerKey();

const unit = (id, extra = {}) => ({ id, name: `Unit ${id}`, capacity: 2, active: true, group_name: null, pool_id: null, kind: 'fixed', owner_type: 'tvc', owner_farm_unit: null, ...extra });

function makeDeps(over = {}) {
  const calls = { touch: [], authFail: [], keyRate: [], assignments: [], blocks: [] };
  const keyRow = { id: 'key-1', partner_id: 'linger', revoked_at: null, expires_at: null, last_used_at: null };
  const deps = {
    now: () => NOW,
    clientIp: () => '203.0.113.9',
    findKeyByHash: async (hash) => (hash === hashPartnerKey(key) ? keyRow : null),
    touchKey: async (id) => void calls.touch.push(id),
    authFailAllowed: async (ip) => void calls.authFail.push(ip) || true,
    keyRateAllowed: async (id) => void calls.keyRate.push(id) || true,
    getPartnerAccess: async () => ({
      units: [unit('Tent01', { group_name: 'Malabar Hut' }), unit('M1', { kind: 'member-home', owner_type: 'member', owner_farm_unit: 'F-12', name: 'Garden Home' })],
      pools: [{ id: 'tents', name: 'Tents', active: true, units: [unit('Tent03'), unit('Tent04')] }],
    }),
    listAssignments: async (ids, from, to) => {
      calls.assignments.push({ ids, from, to });
      return [{ tent_id: 'Tent01', stay_range: '[2026-12-13,2026-12-14)' }, { tent_id: 'Tent03', stay_range: '[2026-12-12,2026-12-15)' }];
    },
    listBlockingBookings: async (from, to) => (calls.blocks.push({ from, to }), []),
    ...over,
  };
  return { deps, calls, keyRow };
}

const get = (path, { auth = `Bearer ${key}`, method = 'GET' } = {}) =>
  new Request(`https://tvc.farm${BASE_PATH}${path}`, { method, headers: auth ? { authorization: auth } : {} });

async function body(res) {
  return res.json();
}

test('unknown paths are 404 and wrong methods 405, before any auth', async () => {
  const { deps } = makeDeps();
  assert.equal((await handlePartnerRequest(get('/nope', { auth: null }), deps)).status, 404);
  const res = await handlePartnerRequest(get('/units', { auth: null, method: 'POST' }), deps);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'GET');
});

test('every key failure looks identical and is counted per IP', async () => {
  const { deps, calls, keyRow } = makeDeps();
  keyRow.revoked_at = '2026-10-01T00:00:00Z';
  const revoked = await handlePartnerRequest(get('/units'), deps);
  const missing = await handlePartnerRequest(get('/units', { auth: null }), deps);
  const garbage = await handlePartnerRequest(get('/units', { auth: 'Bearer nonsense' }), deps);
  const unknown = await handlePartnerRequest(get('/units', { auth: `Bearer ${generatePartnerKey().key}` }), deps);
  const bodies = await Promise.all([revoked, missing, garbage, unknown].map(body));
  for (const res of [revoked, missing, garbage, unknown]) {
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('www-authenticate'), 'Bearer');
  }
  assert.equal(new Set(bodies.map((b) => JSON.stringify(b))).size, 1);
  assert.equal(calls.authFail.length, 4);
});

test('an expired key is rejected', async () => {
  const { deps, keyRow } = makeDeps();
  keyRow.expires_at = '2026-10-01T00:00:00Z';
  assert.equal((await handlePartnerRequest(get('/units'), deps)).status, 401);
});

test('repeated failures from one IP are cut off with 429', async () => {
  const { deps } = makeDeps({ authFailAllowed: async () => false });
  const res = await handlePartnerRequest(get('/units', { auth: 'Bearer nope' }), deps);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '300');
});

test('a good key over its request limit gets 429 and no database work', async () => {
  const { deps, calls } = makeDeps({ keyRateAllowed: async () => false });
  let touched = false;
  deps.getPartnerAccess = async () => {
    touched = true;
    return { units: [], pools: [] };
  };
  const res = await handlePartnerRequest(get('/units'), deps);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '60');
  assert.equal(touched, false);
  assert.deepEqual(calls.touch, []);
});

test('GET /units returns the partner catalogue with no ownership details', async () => {
  const { deps } = makeDeps();
  const res = await handlePartnerRequest(get('/units'), deps);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const data = await body(res);
  assert.deepEqual(data.units.map((u) => u.id), ['Tent01', 'M1']);
  assert.deepEqual(data.pools, [{ id: 'tents', name: 'Tents', size: 2, capacity: { min: 2, max: 2 } }]);
  const text = JSON.stringify(data);
  for (const leak of ['owner', 'kind', 'F-12', 'member']) assert.ok(!text.includes(leak), `leaks ${leak}`);
});

test('GET /availability computes per-night answers for units and pools', async () => {
  const { deps, calls } = makeDeps();
  const res = await handlePartnerRequest(get('/availability?from=2026-12-12&to=2026-12-15'), deps);
  assert.equal(res.status, 200);
  const data = await body(res);
  assert.equal(data.from, '2026-12-12');
  assert.equal(data.to, '2026-12-15');
  assert.deepEqual(data.units.find((u) => u.id === 'Tent01').nights, { '2026-12-12': 'free', '2026-12-13': 'unavailable', '2026-12-14': 'free' });
  assert.deepEqual(data.pools[0].nights['2026-12-13'], { free: 1, total: 2 });
  assert.equal(data.generatedAt, NOW.toISOString());
  // Only the partner's own units are queried, plus its pool members.
  assert.deepEqual(calls.assignments[0], { ids: ['Tent01', 'M1', 'Tent03', 'Tent04'], from: '2026-12-12', to: '2026-12-15' });
  assert.deepEqual(calls.blocks[0], { from: '2026-12-12', to: '2026-12-15' });
});

test('an invalid availability window is 422 and does no database work', async () => {
  const { deps, calls } = makeDeps();
  for (const q of ['', '?from=2026-12-12', '?from=2026-12-15&to=2026-12-12', '?from=2026-01-01&to=2026-01-03', '?from=2026-11-01&to=2027-03-01']) {
    const res = await handlePartnerRequest(get(`/availability${q}`), deps);
    assert.equal(res.status, 422, q);
    assert.equal((await body(res)).error.code, 'invalid_window');
  }
  assert.equal(calls.assignments.length, 0);
});

test('a partner with no grants sees an empty catalogue and no availability', async () => {
  const { deps } = makeDeps({ getPartnerAccess: async () => ({ units: [], pools: [] }) });
  assert.deepEqual(await body(await handlePartnerRequest(get('/units'), deps)), { units: [], pools: [] });
  const data = await body(await handlePartnerRequest(get('/availability?from=2026-12-12&to=2026-12-13'), deps));
  assert.deepEqual(data.units, []);
  assert.deepEqual(data.pools, []);
});

test('last_used_at is touched at most every ten minutes', async () => {
  const first = makeDeps();
  await handlePartnerRequest(get('/units'), first.deps);
  assert.deepEqual(first.calls.touch, ['key-1']);

  const recent = makeDeps();
  recent.keyRow.last_used_at = new Date(NOW.getTime() - 60_000).toISOString();
  await handlePartnerRequest(get('/units'), recent.deps);
  assert.deepEqual(recent.calls.touch, []);

  const stale = makeDeps();
  stale.keyRow.last_used_at = new Date(NOW.getTime() - 11 * 60_000).toISOString();
  await handlePartnerRequest(get('/units'), stale.deps);
  assert.deepEqual(stale.calls.touch, ['key-1']);
});

test('a failing touch never fails the request', async () => {
  const { deps } = makeDeps({ touchKey: async () => Promise.reject(new Error('db down')) });
  assert.equal((await handlePartnerRequest(get('/units'), deps)).status, 200);
});

test('database failures become a generic 502 with no detail', async () => {
  const lookup = makeDeps({ findKeyByHash: async () => Promise.reject(new Error('connection refused to db.internal')) });
  const a = await handlePartnerRequest(get('/units'), lookup.deps);
  assert.equal(a.status, 502);
  assert.ok(!JSON.stringify(await body(a)).includes('internal'));

  const read = makeDeps({ getPartnerAccess: async () => Promise.reject(new Error('relation does not exist')) });
  const b = await handlePartnerRequest(get('/units'), read.deps);
  assert.equal(b.status, 502);
  assert.ok(!JSON.stringify(await body(b)).includes('relation'));
});
