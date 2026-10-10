// Run with: node --test scripts/check-domain-expiry.test.mjs (tests scripts/lib/domain-expiry.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRdap, daysUntil, shouldAlert, rdapBaseFromBootstrap } from './lib/domain-expiry.mjs';

test('parseRdap reads expiry, registrar and status', () => {
  const r = parseRdap({
    status: ['client transfer prohibited'],
    events: [
      { eventAction: 'registration', eventDate: '2020-11-19T10:00:00Z' },
      { eventAction: 'expiration', eventDate: '2026-11-19T10:00:00Z' },
    ],
    entities: [
      { roles: ['abuse'], vcardArray: ['vcard', [['fn', {}, 'text', 'Not this one']]] },
      { roles: ['registrar'], vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', 'Cloudflare, Inc.']]] },
    ],
  });
  assert.equal(r.expiresAt.toISOString(), '2026-11-19T10:00:00.000Z');
  assert.equal(r.registrar, 'Cloudflare, Inc.');
  assert.deepEqual(r.statuses, ['client transfer prohibited']);
});

test('parseRdap tolerates a response with no expiry or entities', () => {
  const r = parseRdap({});
  assert.equal(r.expiresAt, null);
  assert.equal(r.registrar, null);
  assert.deepEqual(r.statuses, []);
});

test('parseRdap treats an unparseable date as missing', () => {
  assert.equal(parseRdap({ events: [{ eventAction: 'expiration', eventDate: 'not a date' }] }).expiresAt, null);
});

test('daysUntil rounds down and goes negative once expired', () => {
  const now = new Date('2026-10-05T00:00:00Z');
  assert.equal(daysUntil(new Date('2026-10-19T23:00:00Z'), now), 14);
  assert.equal(daysUntil(new Date('2026-10-19T00:00:00Z'), now), 14);
  assert.equal(daysUntil(new Date('2026-10-18T23:59:59Z'), now), 13);
  assert.equal(daysUntil(new Date('2026-10-04T00:00:00Z'), now), -1);
});

test('shouldAlert: 60 and 30 days, then daily from 14, including after expiry', () => {
  for (const d of [60, 30, 14, 13, 7, 1, 0, -3]) assert.equal(shouldAlert(d), true, `${d} days`);
  for (const d of [365, 90, 61, 59, 45, 31, 29, 20, 15]) assert.equal(shouldAlert(d), false, `${d} days`);
});

test('rdapBaseFromBootstrap finds a TLD, prefers https, adds a trailing slash', () => {
  const bootstrap = { services: [[['farm', 'app'], ['http://rdap.example/', 'https://rdap.example/farm']], [['com'], ['https://rdap.verisign.com/com/v1/']]] };
  assert.equal(rdapBaseFromBootstrap(bootstrap, 'tvc.farm'), 'https://rdap.example/farm/');
  assert.equal(rdapBaseFromBootstrap(bootstrap, 'example.com'), 'https://rdap.verisign.com/com/v1/');
  assert.equal(rdapBaseFromBootstrap(bootstrap, 'syntropic.in'), null);
  assert.equal(rdapBaseFromBootstrap(undefined, 'x.in'), null);
});
