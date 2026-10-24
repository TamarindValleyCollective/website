import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePartnerKey, hashPartnerKey, parseBearerKey, isKeyUsable } from './partner-keys.mjs';

test('a generated key has the expected shape, and its hash matches', () => {
  const { key, prefix, hash } = generatePartnerKey();
  assert.match(key, /^tvcp_[A-Za-z0-9_-]{43}$/);
  assert.equal(prefix, key.slice(0, 9));
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, hashPartnerKey(key));
});

test('keys are unique and the hash does not contain the key', () => {
  const a = generatePartnerKey();
  const b = generatePartnerKey();
  assert.notEqual(a.key, b.key);
  assert.notEqual(a.hash, b.hash);
  assert.ok(!a.hash.includes(a.key.slice(5)));
});

test('parseBearerKey accepts only a well-formed bearer key', () => {
  const { key } = generatePartnerKey();
  assert.equal(parseBearerKey(`Bearer ${key}`), key);
  assert.equal(parseBearerKey(`bearer ${key}`), key);
  assert.equal(parseBearerKey(key), null);
  assert.equal(parseBearerKey(`Basic ${key}`), null);
  assert.equal(parseBearerKey('Bearer tvcp_short'), null);
  assert.equal(parseBearerKey(`Bearer ${key}x`), null);
  assert.equal(parseBearerKey(`Bearer ${key} extra`), null);
  assert.equal(parseBearerKey(null), null);
  assert.equal(parseBearerKey(undefined), null);
});

test('isKeyUsable rejects missing, revoked and expired keys', () => {
  const now = new Date('2026-11-01T00:00:00Z');
  assert.equal(isKeyUsable(null, now), false);
  assert.equal(isKeyUsable({ revoked_at: null, expires_at: null }, now), true);
  assert.equal(isKeyUsable({ revoked_at: '2026-10-01T00:00:00Z', expires_at: null }, now), false);
  assert.equal(isKeyUsable({ revoked_at: null, expires_at: '2026-10-31T00:00:00Z' }, now), false);
  assert.equal(isKeyUsable({ revoked_at: null, expires_at: '2026-11-02T00:00:00Z' }, now), true);
});
