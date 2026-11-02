// Run with: node --test scripts/lib/finance-access.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { grantIsExpired, parseExpiry, makerIsNotChecker, payeeFieldVisibility, maskAccountNumber, maskUpiId } from './finance-access.mjs';
import { MODULES, MODULE_INFO, roleHasCapability, capabilitiesForRole } from '../../netlify/functions/lib/staff-registry.ts';

const NOW = new Date('2026-11-02T10:00:00Z');

test('a grant with no end date never expires', () => {
  assert.equal(grantIsExpired(null, NOW), false);
  assert.equal(grantIsExpired(undefined, NOW), false);
});
test('a grant expires at its end instant, and not before', () => {
  assert.equal(grantIsExpired('2026-11-02T10:00:00Z', NOW), true);
  assert.equal(grantIsExpired('2026-11-02T10:00:01Z', NOW), false);
  assert.equal(grantIsExpired('2026-10-01T00:00:00Z', NOW), true);
});
test('an unreadable end date fails closed (expired)', () => {
  assert.equal(grantIsExpired('not a date', NOW), true);
});

test('parseExpiry ends a future date at the close of that day (India time) and rejects the rest', () => {
  const ok = parseExpiry('2026-12-31', NOW);
  assert.equal(ok.ok, true);
  assert.equal(ok.value, '2026-12-31T18:29:59.000Z'); // 23:59:59 IST
  assert.equal(parseExpiry('2026-11-01', NOW).ok, false); // past
  assert.equal(parseExpiry('2026-13-40', NOW).ok, false); // not a date
  assert.equal(parseExpiry('31/12/2026', NOW).ok, false); // wrong shape
  assert.equal(parseExpiry('2030-01-01', NOW).ok, false); // too far ahead
  assert.deepEqual(parseExpiry(null, NOW), { ok: true, value: null });
});

test('maker is not checker', () => {
  assert.equal(makerIsNotChecker('a', 'b'), true);
  assert.equal(makerIsNotChecker('a', 'a'), false);
  assert.equal(makerIsNotChecker('a', ''), false);
  assert.equal(makerIsNotChecker('a', null), false);
  assert.equal(makerIsNotChecker(undefined, 'b'), false);
  assert.equal(makerIsNotChecker('a'), false);
  assert.equal(makerIsNotChecker('a', 'b', 'c'), true); // maker, confirmer, checker all different
  assert.equal(makerIsNotChecker('a', 'b', 'a'), false);
  assert.equal(makerIsNotChecker('a', 'b', 'b'), false);
});

test('payee bank details are visible only to verify-payee or export holders; names to every viewer', () => {
  assert.deepEqual(payeeFieldVisibility([]), { names: false, payeeBankDetails: false });
  assert.deepEqual(payeeFieldVisibility(['view']), { names: true, payeeBankDetails: false });
  assert.deepEqual(payeeFieldVisibility(['view', 'import', 'allocate', 'request']), { names: true, payeeBankDetails: false });
  assert.equal(payeeFieldVisibility(['view', 'verify-payee']).payeeBankDetails, true);
  assert.equal(payeeFieldVisibility(['view', 'export']).payeeBankDetails, true);
});

test('masks keep only what identifies an account to someone who knows it', () => {
  assert.equal(maskAccountNumber('1234567890123'), '•••• 0123');
  assert.equal(maskAccountNumber('12'), '••••');
  assert.equal(maskUpiId('priya@okbank'), 'p••••@okbank');
  assert.equal(maskUpiId('nonsense'), '••••');
});

// ---- the registry's finance capability matrix ----
const FIN_CAPS = ['view', 'import', 'allocate', 'request', 'approve', 'approve-payroll', 'verify-payee', 'close-period', 'configure', 'export'];
test('finance module has exactly the capabilities the design lists', () => {
  assert.deepEqual(Object.keys(MODULES.finance).sort(), [...FIN_CAPS].sort());
});
test('finance matrix: admin everything; user view/import/allocate/request; read_only view only', () => {
  assert.deepEqual(capabilitiesForRole('finance', 'admin').sort(), [...FIN_CAPS].sort());
  assert.deepEqual(capabilitiesForRole('finance', 'user').sort(), ['allocate', 'import', 'request', 'view']);
  assert.deepEqual(capabilitiesForRole('finance', 'read_only'), ['view']);
});
test('money-moving and access capabilities are admin-only', () => {
  for (const c of ['approve', 'approve-payroll', 'verify-payee', 'close-period', 'configure', 'export']) {
    assert.equal(roleHasCapability('finance', 'user', c), false, c);
    assert.equal(roleHasCapability('finance', 'read_only', c), false, c);
  }
});
test('finance-requests has no ledger capability, and an auditor cannot raise requests', () => {
  assert.equal('view' in MODULES['finance-requests'], false);
  assert.equal(roleHasCapability('finance-requests', 'user', 'raise'), true);
  assert.equal(roleHasCapability('finance-requests', 'read_only', 'raise'), false);
});
test('every finance capability has a sentence for the Access screen', () => {
  for (const m of ['finance', 'finance-requests']) {
    for (const c of Object.keys(MODULES[m])) assert.ok(MODULE_INFO[m].capabilities[c], `${m}.${c}`);
  }
});
