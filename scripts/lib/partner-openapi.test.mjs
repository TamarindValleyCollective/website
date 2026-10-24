// Contract tests: docs/partner-api/openapi.json is what partners build
// against, so it must describe what the API really does. These tests (1) check
// the spec is internally sound, (2) run the real request handler with fakes for
// each documented outcome and validate the response, status and headers against
// the schema the spec declares, and (3) validate the spec's own examples.
//
// No dependencies: the spec is JSON, and `validate` below is a small checker for
// the JSON Schema subset the spec uses (it throws on a keyword it does not
// understand, so the spec cannot quietly outgrow the tests).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handlePartnerRequest, BASE_PATH } from './partner-api-core.mjs';
import { generatePartnerKey, hashPartnerKey } from './partner-keys.mjs';

const spec = JSON.parse(readFileSync(new URL('../../docs/partner-api/openapi.json', import.meta.url), 'utf8'));

// ---- a minimal JSON Schema checker (the subset the spec uses) ----

const KNOWN = new Set([
  '$ref', 'type', 'enum', 'const', 'required', 'properties', 'additionalProperties', 'patternProperties',
  'items', 'minimum', 'format', 'description', 'examples', 'example', 'title',
]);

function resolveRef(ref) {
  assert.ok(ref.startsWith('#/'), `only local refs are supported: ${ref}`);
  return ref.slice(2).split('/').reduce((node, key) => {
    assert.ok(node && key in node, `unresolved $ref ${ref}`);
    return node[key];
  }, spec);
}

function validate(schema, value, path = '$') {
  const errors = [];
  if (schema.$ref) return validate(resolveRef(schema.$ref), value, path);
  for (const key of Object.keys(schema)) assert.ok(KNOWN.has(key), `schema keyword "${key}" at ${path} is not supported by the test checker`);

  if (schema.const !== undefined && value !== schema.const) errors.push(`${path}: expected ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} is not one of ${schema.enum.join(', ')}`);

  if (schema.type) {
    const ok =
      (schema.type === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value)) ||
      (schema.type === 'array' && Array.isArray(value)) ||
      (schema.type === 'string' && typeof value === 'string') ||
      (schema.type === 'integer' && Number.isInteger(value)) ||
      (schema.type === 'number' && typeof value === 'number') ||
      (schema.type === 'boolean' && typeof value === 'boolean');
    if (!ok) return [...errors, `${path}: expected ${schema.type}, got ${JSON.stringify(value)}`];
  }

  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: ${value} is below ${schema.minimum}`);

  if (typeof value === 'string' && schema.format === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) errors.push(`${path}: "${value}" is not a date`);
  }
  if (typeof value === 'string' && schema.format === 'date-time') {
    if (Number.isNaN(Date.parse(value)) || !/^\d{4}-\d{2}-\d{2}T/.test(value)) errors.push(`${path}: "${value}" is not a date-time`);
  }

  if (Array.isArray(value) && schema.items) value.forEach((item, i) => errors.push(...validate(schema.items, item, `${path}[${i}]`)));

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const req of schema.required ?? []) if (!(req in value)) errors.push(`${path}: missing required "${req}"`);
    const props = schema.properties ?? {};
    const patterns = Object.entries(schema.patternProperties ?? {}).map(([p, s]) => [new RegExp(p), s]);
    for (const [key, val] of Object.entries(value)) {
      if (key in props) {
        errors.push(...validate(props[key], val, `${path}.${key}`));
        continue;
      }
      const matched = patterns.filter(([re]) => re.test(key));
      if (matched.length) {
        for (const [, s] of matched) errors.push(...validate(s, val, `${path}.${key}`));
        continue;
      }
      if (schema.additionalProperties === false) errors.push(`${path}: unexpected property "${key}"`);
      else if (typeof schema.additionalProperties === 'object') errors.push(...validate(schema.additionalProperties, val, `${path}.${key}`));
    }
  }
  return errors;
}

const expectValid = (schema, value, label) => assert.deepEqual(validate(schema, value), [], label);

// ---- helpers to read the spec ----

const operation = (path) => spec.paths[path].get;
function declaredResponse(path, status) {
  const response = operation(path).responses[String(status)];
  assert.ok(response, `${path} documents no ${status} response`);
  return response.$ref ? resolveRef(response.$ref) : response;
}
const bodySchema = (response) => response.content['application/json'].schema;

// ---- the real handler, with fakes ----

const NOW = new Date('2026-10-24T06:00:00Z');
const { key } = generatePartnerKey();
const unit = (id, extra = {}) => ({ id, name: `Unit ${id}`, capacity: 2, active: true, group_name: null, pool_id: null, kind: 'fixed', owner_type: 'tvc', owner_farm_unit: null, ...extra });

function deps(over = {}) {
  const keyRow = { id: 'k1', partner_id: 'linger', revoked_at: null, expires_at: null, last_used_at: null };
  return {
    now: () => NOW,
    clientIp: () => '203.0.113.9',
    findKeyByHash: async (hash) => (hash === hashPartnerKey(key) ? keyRow : null),
    touchKey: async () => {},
    authFailAllowed: async () => true,
    keyRateAllowed: async () => true,
    getPartnerAccess: async () => ({
      units: [unit('Tent06', { group_name: 'Bamboo Huts' }), unit('Tent07')],
      pools: [{ id: 'tents', name: 'TVC tents', active: true, units: [unit('Tent03'), unit('Tent04', { capacity: 3 }), unit('Tent05')] }],
    }),
    listAssignments: async () => [{ tent_id: 'Tent06', stay_range: '[2026-12-13,2026-12-14)' }, { tent_id: 'Tent03', stay_range: '[2026-12-12,2026-12-15)' }],
    listBlockingBookings: async () => [],
    ...over,
  };
}

const call = (path, { method = 'GET', auth = `Bearer ${key}`, d = deps() } = {}) =>
  handlePartnerRequest(new Request(`https://tvc.farm${BASE_PATH}${path}`, { method, headers: auth ? { authorization: auth } : {} }), d);

// ---- 1. the spec itself ----

test('the spec is OpenAPI 3.1 with the metadata partners need', () => {
  assert.equal(spec.openapi, '3.1.0');
  assert.match(spec.info.version, /^\d+\.\d+\.\d+$/);
  assert.ok(spec.info.description.includes('Authentication'));
  assert.deepEqual(spec.servers.map((s) => s.url), ['https://tvc.farm/api/partner/v1', 'https://sandbox.tvc.farm/api/partner/v1']);
  assert.deepEqual(spec.security, [{ bearerAuth: [] }]);
  assert.equal(spec.components.securitySchemes.bearerAuth.scheme, 'bearer');
});

test('the spec documents exactly the paths the handler serves, all GET', () => {
  assert.deepEqual(Object.keys(spec.paths).sort(), ['/availability', '/units']);
  for (const [path, item] of Object.entries(spec.paths)) assert.deepEqual(Object.keys(item), ['get'], `${path} should only define GET in phase 1`);
});

test('every $ref in the spec resolves', () => {
  const refs = [];
  JSON.stringify(spec, (k, v) => (k === '$ref' ? (refs.push(v), v) : v));
  assert.ok(refs.length > 5);
  for (const ref of refs) assert.doesNotThrow(() => resolveRef(ref), ref);
});

test('every operation documents auth, rate-limit and upstream failures, and has an id', () => {
  const ids = new Set();
  for (const path of Object.keys(spec.paths)) {
    const op = operation(path);
    assert.ok(op.operationId && !ids.has(op.operationId), `${path} needs a unique operationId`);
    ids.add(op.operationId);
    for (const status of [200, 401, 429, 502]) declaredResponse(path, status);
  }
  declaredResponse('/availability', 422);
});

test('every error code the handler can return is in the spec enum', () => {
  const codes = spec.components.schemas.Error.properties.error.properties.code.enum;
  for (const code of ['invalid_key', 'not_found', 'method_not_allowed', 'invalid_window', 'rate_limited', 'upstream_error']) assert.ok(codes.includes(code), code);
});

test('the spec examples validate against their own schemas', () => {
  for (const path of Object.keys(spec.paths)) {
    for (const [status, r] of Object.entries(operation(path).responses)) {
      const response = r.$ref ? resolveRef(r.$ref) : r;
      const json = response.content?.['application/json'];
      if (json?.example) expectValid(json.schema, json.example, `${path} ${status} example`);
    }
  }
});

// ---- 2. the real handler against the spec ----

test('GET /units matches the documented 200', async () => {
  const res = await call('/units');
  assert.equal(res.status, 200);
  const body = await res.json();
  expectValid(bodySchema(declaredResponse('/units', 200)), body, 'GET /units');
  assert.equal(body.units.length, 2);
  assert.equal(body.pools[0].size, 3);
  assert.deepEqual(body.pools[0].capacity, { min: 2, max: 3 });
});

test('GET /availability matches the documented 200', async () => {
  const res = await call('/availability?from=2026-12-12&to=2026-12-15');
  assert.equal(res.status, 200);
  const body = await res.json();
  expectValid(bodySchema(declaredResponse('/availability', 200)), body, 'GET /availability');
  assert.deepEqual(Object.keys(body.units[0].nights), ['2026-12-12', '2026-12-13', '2026-12-14']);
  assert.equal(body.to, '2026-12-15', 'to is the exclusive end the caller asked for');
});

test('a catalogue with no grants still matches the schema', async () => {
  const res = await call('/units', { d: deps({ getPartnerAccess: async () => ({ units: [], pools: [] }) }) });
  expectValid(bodySchema(declaredResponse('/units', 200)), await res.json(), 'empty catalogue');
});

test('401 matches the documented response, with WWW-Authenticate', async () => {
  for (const auth of [null, 'Bearer nonsense', `Bearer ${generatePartnerKey().key}`]) {
    const res = await call('/units', { auth });
    assert.equal(res.status, 401);
    expectValid(bodySchema(declaredResponse('/units', 401)), await res.json(), 'GET /units 401');
    assert.equal(res.headers.get('www-authenticate'), declaredResponse('/units', 401).headers['WWW-Authenticate'].schema.const);
  }
});

test('422 matches the documented response', async () => {
  const res = await call('/availability?from=2026-12-15&to=2026-12-12');
  assert.equal(res.status, 422);
  const body = await res.json();
  expectValid(bodySchema(declaredResponse('/availability', 422)), body, 'GET /availability 422');
  assert.equal(body.error.code, 'invalid_window');
});

test('429 (key limit and failed-key limit) matches the documented response, with Retry-After', async () => {
  const perKey = await call('/units', { d: deps({ keyRateAllowed: async () => false }) });
  const failed = await call('/units', { auth: 'Bearer nonsense', d: deps({ authFailAllowed: async () => false }) });
  for (const res of [perKey, failed]) {
    assert.equal(res.status, 429);
    expectValid(bodySchema(declaredResponse('/units', 429)), await res.json(), '429');
    assert.ok(Number.isInteger(Number(res.headers.get('retry-after'))) && Number(res.headers.get('retry-after')) >= 1, 'Retry-After is a whole number of seconds');
  }
});

test('502 matches the documented response', async () => {
  const res = await call('/units', { d: deps({ getPartnerAccess: async () => Promise.reject(new Error('boom')) }) });
  assert.equal(res.status, 502);
  expectValid(bodySchema(declaredResponse('/units', 502)), await res.json(), '502');
});

test('404 and 405 use the documented error shape', async () => {
  const notFound = await call('/nope', { auth: null });
  assert.equal(notFound.status, 404);
  expectValid(spec.components.schemas.Error, await notFound.json(), '404');
  const wrongMethod = await call('/units', { method: 'POST', auth: null });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'GET');
  expectValid(spec.components.schemas.Error, await wrongMethod.json(), '405');
});

// ---- 3. the checker itself ----

test('the schema checker catches real mistakes', () => {
  const schema = bodySchema(declaredResponse('/availability', 200));
  const good = {
    from: '2026-12-12', to: '2026-12-13', generatedAt: '2026-10-24T08:15:00.000Z',
    units: [{ id: 'Tent06', nights: { '2026-12-12': 'free' } }], pools: [],
  };
  assert.deepEqual(validate(schema, good), []);
  assert.ok(validate(schema, { ...good, from: 'soon' }).length > 0, 'bad date');
  assert.ok(validate(schema, { ...good, units: [{ id: 'T', nights: { '2026-12-12': 'maybe' } }] }).length > 0, 'bad enum');
  assert.ok(validate(schema, { ...good, units: [{ id: 'T', nights: { tomorrow: 'free' } }] }).length > 0, 'bad night key');
  assert.ok(validate(schema, { from: good.from }).length > 0, 'missing fields');
  assert.ok(validate(schema, { ...good, pools: [{ id: 'p', nights: { '2026-12-12': { free: -1, total: 2 } } }] }).length > 0, 'negative count');
});
