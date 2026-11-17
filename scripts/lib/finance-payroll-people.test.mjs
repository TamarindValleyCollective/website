// Run with: node --test scripts/lib/finance-payroll-people.test.mjs
// Every id, name and amount below is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePersonRequest, decidePersonRequest, eligibleForMonth, requestSummary } from './finance-payroll-people.mjs';

const E1 = '11111111-1111-4111-8111-11111111111a';
const today = '2026-11-17';

test('a joining request needs a name and a start month; the role and agreed pay are optional and the pay is whole rupees', () => {
  const ok = validatePersonRequest({ kind: 'join', name: '  Test   Person ', startMonth: '2026-12', role: 'Helper', agreedPayRupees: 15000 }, { today });
  assert.deepEqual(ok.value, { kind: 'join', personName: 'Test Person', roleTitle: 'Helper', startMonth: '2026-12-01', agreedPayPaise: 1_500_000 });
  assert.deepEqual(validatePersonRequest({ kind: 'join', name: 'Test Person', startMonth: '2026-12' }, { today }).value, { kind: 'join', personName: 'Test Person', roleTitle: null, startMonth: '2026-12-01', agreedPayPaise: null });
  assert.match(validatePersonRequest({ kind: 'join', name: 'x', startMonth: '2026-12' }, { today }).error, /name/i);
  assert.match(validatePersonRequest({ kind: 'join', name: 'Test Person', startMonth: '2026-13' }, { today }).error, /month/i);
  assert.match(validatePersonRequest({ kind: 'join', name: 'Test Person', startMonth: '2026-12', agreedPayRupees: 1500.5 }, { today }).error, /whole/i);
  assert.match(validatePersonRequest({ kind: 'join', name: 'Test Person', startMonth: '2026-12', agreedPayRupees: 0 }, { today }).error, /whole/i);
});

test('a leaving request needs the person and the last month to pay, which may be this month or a past one but is a real month', () => {
  const ok = validatePersonRequest({ kind: 'leave', employeeId: E1, lastMonth: '2026-11', reason: ' moved away ' }, { today });
  assert.deepEqual(ok.value, { kind: 'leave', employeeId: E1, lastMonth: '2026-11-01', reason: 'moved away' });
  assert.equal(validatePersonRequest({ kind: 'leave', employeeId: E1, lastMonth: '2026-09' }, { today }).value.reason, null);
  assert.match(validatePersonRequest({ kind: 'leave', employeeId: 'nope', lastMonth: '2026-11' }, { today }).error, /person/i);
  assert.match(validatePersonRequest({ kind: 'leave', employeeId: E1, lastMonth: 'soon' }, { today }).error, /month/i);
  assert.match(validatePersonRequest({ kind: 'leave', employeeId: E1, lastMonth: '2026-11', reason: 'x'.repeat(201) }, { today }).error, /reason/i);
});

test('an unknown kind is refused', () => {
  assert.match(validatePersonRequest({ kind: 'promote' }, { today }).error, /joining or leaving/i);
  assert.match(validatePersonRequest(null, { today }).error, /joining or leaving/i);
});

const req = (over = {}) => ({ kind: 'join', status: 'requested', requestedBy: 'farm', ...over });
const farm = { id: 'farm', canEnter: true, canPrepare: false };
const director = { id: 'dir', canEnter: false, canPrepare: true };

test('a director approves or declines an open request, never the person who raised it, and the requester cannot approve their own', () => {
  assert.deepEqual(decidePersonRequest(req(), 'approve', director), { ok: true, to: 'approved' });
  assert.deepEqual(decidePersonRequest(req(), 'reject', director), { ok: true, to: 'rejected' });
  assert.match(decidePersonRequest(req(), 'approve', farm).error, /director/i);
  assert.match(decidePersonRequest(req(), 'reject', farm).error, /director/i);
  const both = { id: 'farm', canEnter: true, canPrepare: true };
  assert.match(decidePersonRequest(req(), 'approve', both).error, /you raised this request/i);
  assert.match(decidePersonRequest(req(), 'reject', both).error, /you raised this request/i);
});

test('the person who raised a request, or a director, may withdraw it while it is open; nobody else', () => {
  assert.deepEqual(decidePersonRequest(req(), 'cancel', farm), { ok: true, to: 'cancelled' });
  assert.deepEqual(decidePersonRequest(req(), 'cancel', director), { ok: true, to: 'cancelled' });
  assert.match(decidePersonRequest(req(), 'cancel', { id: 'other', canEnter: true, canPrepare: false }).error, /raised/i);
});

test('only an open request can be moved, and an unknown action is refused', () => {
  for (const status of ['approved', 'rejected', 'cancelled']) {
    assert.match(decidePersonRequest(req({ status }), 'approve', director).error, /already/i, status);
    assert.match(decidePersonRequest(req({ status }), 'cancel', farm).error, /already/i, status);
  }
  assert.match(decidePersonRequest(req(), 'archive', director).error, /action/i);
});

test('a person is paid for a month from their start month to their last month, either end being open', () => {
  assert.equal(eligibleForMonth({ startMonth: null, lastMonth: null }, '2026-10'), true);
  assert.equal(eligibleForMonth({ startMonth: '2026-11-01', lastMonth: null }, '2026-10'), false);
  assert.equal(eligibleForMonth({ startMonth: '2026-11-01', lastMonth: null }, '2026-11'), true);
  assert.equal(eligibleForMonth({ startMonth: null, lastMonth: '2026-10-01' }, '2026-10'), true);
  assert.equal(eligibleForMonth({ startMonth: null, lastMonth: '2026-10-01' }, '2026-11'), false);
  assert.equal(eligibleForMonth({ startMonth: '2026-01-01', lastMonth: '2026-10-01' }, '2026-06'), true);
});

test('a request says in plain words where it stands and what happens next', () => {
  assert.match(requestSummary({ kind: 'join', status: 'requested' }).next, /director/i);
  assert.equal(requestSummary({ kind: 'join', status: 'approved' }).next, null);
  assert.equal(requestSummary({ kind: 'join', status: 'rejected' }).next, null);
  assert.equal(requestSummary({ kind: 'leave', status: 'cancelled' }).next, null);
  assert.equal(requestSummary({ kind: 'leave', status: 'approved' }).next, null);
});
