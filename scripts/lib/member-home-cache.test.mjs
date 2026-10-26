import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOME_CACHE_KEY, HOME_CACHE_MAX_AGE_MS, cacheable, clearHomeCache, emailFromToken, readHomeCache, writeHomeCache } from './member-home-cache.mjs';

const token = (email) => `h.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.s`;
const memory = () => {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k), map };
};
const home = (extra = {}) => ({ privacyNoticeVersion: 1, me: { personId: 'p1', name: 'A' }, households: [{ id: 'h1' }], ...extra });

test('reads the email from a token, lower-cased, and null from anything unreadable', () => {
  assert.equal(emailFromToken(token('Test@Gmail.com')), 'test@gmail.com');
  for (const bad of [null, '', 'abc', 'a.b.c', 'a..c', undefined]) assert.equal(emailFromToken(bad), null);
});

test('a written answer comes back for the same member', () => {
  const storage = memory();
  writeHomeCache(token('a@gmail.com'), home(), { storage, now: 1000 });
  assert.deepEqual(readHomeCache(token('A@gmail.com'), { storage, now: 2000 }), home());
});

test('a token that has already expired draws nothing from the cache', () => {
  const storage = memory();
  const withExp = (email, exp) => `h.${Buffer.from(JSON.stringify({ email, exp })).toString('base64url')}.s`;
  writeHomeCache(token('a@gmail.com'), home(), { storage, now: 1_000_000 });
  assert.notEqual(readHomeCache(withExp('a@gmail.com', 2000), { storage, now: 1_500_000 }), null); // exp 2000s = 2,000,000ms
  assert.equal(readHomeCache(withExp('a@gmail.com', 1000), { storage, now: 1_500_000 }), null); // exp 1000s = 1,000,000ms, passed
});

test('another member on the same browser gets nothing', () => {
  const storage = memory();
  writeHomeCache(token('a@gmail.com'), home(), { storage, now: 1000 });
  assert.equal(readHomeCache(token('b@gmail.com'), { storage, now: 2000 }), null);
});

test('it expires after a day, and a clock that went backwards is not trusted', () => {
  const storage = memory();
  writeHomeCache(token('a@gmail.com'), home(), { storage, now: 10_000 });
  assert.notEqual(readHomeCache(token('a@gmail.com'), { storage, now: 10_000 + HOME_CACHE_MAX_AGE_MS }), null);
  assert.equal(readHomeCache(token('a@gmail.com'), { storage, now: 10_001 + HOME_CACHE_MAX_AGE_MS }), null);
  assert.equal(readHomeCache(token('a@gmail.com'), { storage, now: 5_000 }), null);
});

test('the privacy-notice stub and incomplete answers are never stored', () => {
  const storage = memory();
  for (const data of [home({ privacyNoticeRequired: true }), { me: { name: 'A' } }, { households: [] }, null, undefined, home({ households: 'x' })]) {
    writeHomeCache(token('a@gmail.com'), data, { storage });
    assert.equal(storage.map.size, 0);
    assert.equal(cacheable(data), false);
  }
});

test('no readable token, no storage and corrupt storage all mean no cache, never an error', () => {
  const storage = memory();
  writeHomeCache('nonsense', home(), { storage });
  assert.equal(storage.map.size, 0);
  assert.equal(readHomeCache(token('a@gmail.com'), { storage: undefined }), null);
  storage.setItem(HOME_CACHE_KEY, '{not json');
  assert.equal(readHomeCache(token('a@gmail.com'), { storage }), null);
  storage.setItem(HOME_CACHE_KEY, JSON.stringify({ v: 99, email: 'a@gmail.com', at: Date.now(), data: home() }));
  assert.equal(readHomeCache(token('a@gmail.com'), { storage }), null);
  const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('full'); }, removeItem() { throw new Error('blocked'); } };
  assert.equal(readHomeCache(token('a@gmail.com'), { storage: throwing }), null);
  assert.doesNotThrow(() => writeHomeCache(token('a@gmail.com'), home(), { storage: throwing }));
  assert.doesNotThrow(() => clearHomeCache({ storage: throwing }));
});

test('clearing removes it', () => {
  const storage = memory();
  writeHomeCache(token('a@gmail.com'), home(), { storage, now: 1000 });
  clearHomeCache({ storage });
  assert.equal(readHomeCache(token('a@gmail.com'), { storage, now: 1500 }), null);
});
