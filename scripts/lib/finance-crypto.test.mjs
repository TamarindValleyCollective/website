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

// ---- a dedicated key for payee details (FINANCE_PAYEE_KEY), falling back to STAFF_MFA_KEY
const newKey = () => randomBytes(32).toString('base64');
const withKeys = (staff, finance) => {
  if (staff === undefined) delete process.env.STAFF_MFA_KEY;
  else process.env.STAFF_MFA_KEY = staff;
  if (finance === undefined) delete process.env.FINANCE_PAYEE_KEY;
  else process.env.FINANCE_PAYEE_KEY = finance;
};

test('payee details use FINANCE_PAYEE_KEY when it is set, independent of STAFF_MFA_KEY', () => {
  const finance = newKey();
  withKeys(newKey(), finance);
  const blob = c.encryptFinanceText('secret');
  const print = c.fingerprintFinanceText('100000000001');
  withKeys(newKey(), finance); // the MFA key changes; the finance key does not
  assert.equal(c.decryptFinanceText(blob), 'secret');
  assert.equal(c.fingerprintFinanceText('100000000001'), print);
});

test('FINANCE_PAYEE_KEY alone is enough: finance works without STAFF_MFA_KEY', () => {
  withKeys(undefined, newKey());
  assert.equal(c.decryptFinanceText(c.encryptFinanceText('x')), 'x');
});

test('with no FINANCE_PAYEE_KEY the old behaviour holds: STAFF_MFA_KEY is used', () => {
  const staff = newKey();
  withKeys(staff, undefined);
  const blob = c.encryptFinanceText('x');
  withKeys(staff, undefined);
  assert.equal(c.decryptFinanceText(blob), 'x');
});

test('a FINANCE_PAYEE_KEY that is set but too short is refused, never silently replaced by the other key', () => {
  withKeys(newKey(), Buffer.from('too-short').toString('base64'));
  assert.throws(() => c.encryptFinanceText('x'), c.MfaNotConfiguredError);
  assert.throws(() => c.fingerprintFinanceText('x'), c.MfaNotConfiguredError);
});

test('the finance key touches only finance: TOTP and member-payout encryption still use STAFF_MFA_KEY', () => {
  const staff = newKey();
  withKeys(staff, newKey());
  const totp = c.encryptSecret(Buffer.from('totp'));
  const payout = c.encryptPayoutText('payout');
  withKeys(staff, newKey()); // a different finance key
  assert.equal(c.decryptSecret(totp).toString(), 'totp');
  assert.equal(c.decryptPayoutText(payout), 'payout');
  assert.throws(() => c.decryptFinanceText(c.encryptFinanceText('x') + 'zz')); // sanity: tampering still fails
});
