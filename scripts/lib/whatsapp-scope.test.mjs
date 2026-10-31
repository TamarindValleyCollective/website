// Run with: node --test scripts/lib/whatsapp-scope.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScope, waPhoneFromMobile, phoneSet, filterToScope } from './whatsapp-scope.mjs';

test('no scope means the whole inbox, an unknown one is refused', () => {
  assert.equal(parseScope(null), 'all');
  assert.equal(parseScope(''), 'all');
  assert.equal(parseScope('stays'), 'stays');
  assert.equal(parseScope('everything'), null);
  assert.equal(parseScope('__proto__'), null);
});

test('a mobile number becomes the digits conversations are stored under', () => {
  assert.equal(waPhoneFromMobile('+91 98450 12345'), '919845012345');
  assert.equal(waPhoneFromMobile('98450 12345'), '919845012345');
  assert.equal(waPhoneFromMobile('not a number'), null);
  assert.equal(waPhoneFromMobile(undefined), null);
});

test('a scope only lets through conversations whose number is in its set', () => {
  const phones = phoneSet(['+91 98450 12345', '98450 67890', null, 'junk']);
  assert.equal(phones.size, 2);
  const convs = [{ id: 'a', wa_phone: '919845012345' }, { id: 'b', wa_phone: '919000000000' }, { id: 'c', wa_phone: '919845067890' }];
  assert.deepEqual(filterToScope(convs, phones).map((c) => c.id), ['a', 'c']);
});

test('no phone set means no restriction (the full inbox)', () => {
  const convs = [{ id: 'a', wa_phone: '1' }, { id: 'b', wa_phone: '2' }];
  assert.equal(filterToScope(convs, null).length, 2);
});

test('an empty phone set shows nothing rather than everything', () => {
  assert.equal(filterToScope([{ id: 'a', wa_phone: '1' }], new Set()).length, 0);
});
