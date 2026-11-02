// Run with: node --test scripts/lib/finance-crypto.test.mjs
// Payee details are encrypted with their own derived key (not the TOTP or member-payout one), and a keyed
// fingerprint lets two parties sharing an account be found without decrypting anything. Needs Node 22.18+.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

process.env.STAFF_MFA_KEY = randomBytes(32).toString('base64');
const c = await import('../../netlify/functions/lib/staff-mfa-crypto.ts');

test('payee details round-trip and the ciphertext does not contain the plaintext', () => {
  const plain = JSON.stringify({ method: 'bank', account: '100000000001', ifsc: 'ABCD0123456' });
  const blob = c.encryptFinanceText(plain);
  assert.ok(!blob.includes('100000000001'));
  assert.equal(c.decryptFinanceText(blob), plain);
  assert.notEqual(c.encryptFinanceText(plain), blob); // fresh IV each time
});

test('a payout-key blob cannot be opened as finance details, and vice versa', () => {
  assert.throws(() => c.decryptFinanceText(c.encryptPayoutText('x')));
  assert.throws(() => c.decryptPayoutText(c.encryptFinanceText('x')));
});

test('a tampered blob is refused', () => {
  const blob = c.encryptFinanceText('hello');
  const [v, iv, tag, ct] = blob.split('.');
  assert.throws(() => c.decryptFinanceText([v, iv, tag, Buffer.from('zz').toString('base64url') + ct].join('.')));
});

test('the fingerprint is stable, keyed, and reveals nothing readable', () => {
  const a = c.fingerprintFinanceText('100000000001');
  assert.equal(a, c.fingerprintFinanceText('100000000001'));
  assert.notEqual(a, c.fingerprintFinanceText('100000000002'));
  assert.ok(!a.includes('100000000001'));
  process.env.STAFF_MFA_KEY = randomBytes(32).toString('base64');
  assert.notEqual(a, c.fingerprintFinanceText('100000000001')); // a different key gives a different print
});

test('without the key, nothing is encrypted or fingerprinted', () => {
  delete process.env.STAFF_MFA_KEY;
  assert.throws(() => c.encryptFinanceText('x'), c.MfaNotConfiguredError);
  assert.throws(() => c.fingerprintFinanceText('x'), c.MfaNotConfiguredError);
});
