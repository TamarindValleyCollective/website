// Run with: node --test scripts/lib/finance-delegates.test.mjs
//
// Delegates of the UPI circle: who a delegated payment belongs to, by date, with an explicit pick for the ambiguous ones.
// Every number and name here is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { activeOn, attribute, delegateLabel, validateDelegate } from './finance-delegates.mjs';
import { circleMonths } from './finance-upi-circle.mjs';

const d = (id, identifier, from, to = null, extra = {}) => ({ id, identifier, displayName: null, activeFrom: from, activeTo: to, capPaise: null, ...extra });
const circle = (paidAt, amountPaise, upiRef = '100000000001', extra = {}) => ({ isCircle: true, direction: 'debit', paidAt, amountPaise, upiRef, ...extra });

test('a delegate shows as its number until it has a name, then as the name', () => {
  assert.equal(delegateLabel(d('a', '5550100001', '2026-07-04')), '5550100001');
  assert.equal(delegateLabel(d('a', '5550100001', '2026-07-04', null, { displayName: 'Test Person' })), 'Test Person');
});

test('activeOn: from and to are both inclusive, no end means still active', () => {
  const ds = [d('a', '5550100001', '2026-07-04', '2026-09-30'), d('b', '5550100002', '2026-10-01')];
  assert.deepEqual(activeOn(ds, '2026-07-03').map((x) => x.id), []);
  assert.deepEqual(activeOn(ds, '2026-07-04').map((x) => x.id), ['a']);
  assert.deepEqual(activeOn(ds, '2026-09-30').map((x) => x.id), ['a']);
  assert.deepEqual(activeOn(ds, '2026-10-01').map((x) => x.id), ['b']);
});

test('one delegate active: the payment is theirs automatically', () => {
  const r = attribute(circle('2026-08-01', 5000), [d('a', '5550100001', '2026-07-04')], new Map());
  assert.deepEqual(r, { delegateId: 'a', how: 'auto' });
});

test('two delegates active: the payment is ambiguous until someone picks', () => {
  const ds = [d('a', '5550100001', '2026-07-04'), d('b', '5550100002', '2026-10-01')];
  assert.deepEqual(attribute(circle('2026-10-05', 5000), ds, new Map()), { delegateId: null, how: 'ambiguous' });
  assert.deepEqual(attribute(circle('2026-09-05', 5000), ds, new Map()), { delegateId: 'a', how: 'auto' });
});

test('an explicit pick wins over the dates, even for a day when nobody was active', () => {
  const ds = [d('a', '5550100001', '2026-07-04'), d('b', '5550100002', '2026-10-01')];
  const picked = new Map([['100000000001', 'b']]);
  assert.deepEqual(attribute(circle('2026-10-05', 5000), ds, picked), { delegateId: 'b', how: 'assigned' });
  assert.deepEqual(attribute(circle('2026-01-05', 5000), ds, picked), { delegateId: 'b', how: 'assigned' });
});

test('a pick for a delegate that no longer exists is ignored', () => {
  const r = attribute(circle('2026-08-01', 5000), [d('a', '5550100001', '2026-07-04')], new Map([['100000000001', 'gone']]));
  assert.deepEqual(r, { delegateId: 'a', how: 'auto' });
});

test('nobody active on the day: not identified, and a direct payment is no delegate at all', () => {
  assert.deepEqual(attribute(circle('2026-06-01', 5000), [d('a', '5550100001', '2026-07-04')], new Map()), { delegateId: null, how: 'none' });
  assert.deepEqual(attribute(circle('2026-06-01', 5000), [], new Map()), { delegateId: null, how: 'none' });
  assert.deepEqual(attribute({ isCircle: false, direction: 'debit', paidAt: '2026-08-01', amountPaise: 5000, upiRef: '100000000009' }, [d('a', '5550100001', '2026-07-04')], new Map()), { delegateId: null, how: null });
});

test('validateDelegate: a number is required once, the rest is optional and checked', () => {
  const ok = validateDelegate({ identifier: ' 5550100001 ', displayName: '  Test Person ', activeFrom: '2026-07-04', activeTo: '', capPaise: '' }, { create: true });
  assert.deepEqual(ok.value, { identifier: '5550100001', displayName: 'Test Person', activeFrom: '2026-07-04', activeTo: null, capPaise: null });
  assert.match(validateDelegate({ identifier: 'abc', activeFrom: '2026-07-04' }, { create: true }).error, /number/i);
  assert.match(validateDelegate({ identifier: '5550100001' }, { create: true }).error, /start/i);
  assert.match(validateDelegate({ identifier: '5550100001', activeFrom: '2026-02-30' }, { create: true }).error, /start/i);
  assert.match(validateDelegate({ identifier: '5550100001', activeFrom: '2026-07-04', activeTo: '2026-07-01' }, { create: true }).error, /end/i);
  assert.match(validateDelegate({ identifier: '5550100001', activeFrom: '2026-07-04', capPaise: 0 }, { create: true }).error, /limit/i);
  assert.match(validateDelegate({ identifier: '5550100001', activeFrom: '2026-07-04', displayName: 'x' }, { create: true }).error, /name/i);
});

test('validateDelegate on an update: the number cannot be changed, a blank name clears it', () => {
  const r = validateDelegate({ identifier: '5550100009', displayName: '', activeFrom: '2026-07-04', activeTo: '2026-12-31', capPaise: 1000000 }, { create: false });
  assert.deepEqual(r.value, { displayName: null, activeFrom: '2026-07-04', activeTo: '2026-12-31', capPaise: 1000000 });
});

test('circleMonths without delegates behaves exactly as before', () => {
  const m = circleMonths([circle('2026-09-03', 1_000_000), circle('2026-09-20', 600_000), { ...circle('2026-09-21', 99), direction: 'credit' }]);
  assert.deepEqual(m, [{ month: '2026-09', paise: 1_600_000, count: 2, capPaise: 1_500_000, over: true }]);
});

test('circleMonths per delegate: each has its own limit, and the unidentified are their own bucket', () => {
  const ds = [d('a', '5550100001', '2026-07-04', null, { displayName: 'Test Person', capPaise: 500_000 }), d('b', '5550100002', '2026-07-04')];
  const lines = [circle('2026-09-03', 400_000, '1', { delegateId: 'a' }), circle('2026-09-04', 200_000, '2', { delegateId: 'a' }), circle('2026-09-05', 900_000, '3', { delegateId: 'b' }), circle('2026-09-06', 50_000, '4', { delegateId: null })];
  const [m] = circleMonths(lines, 1_500_000, ds);
  assert.equal(m.paise, 1_550_000);
  assert.equal(m.over, true); // 'a' used 600,000 of 500,000
  assert.deepEqual(m.byDelegate.map((x) => [x.delegateId, x.label, x.paise, x.capPaise, x.over]), [
    ['b', '5550100002', 900_000, 1_500_000, false],
    ['a', 'Test Person', 600_000, 500_000, true],
    [null, null, 50_000, 1_500_000, false],
  ]);
});

test('with operators, a payment can only belong to a delegate of its own operator’s circle', () => {
  const ds = [d('a', '5550100001', '2026-07-04', null, { operatorId: 'op1' }), d('b', '5550100002', '2026-07-04', null, { operatorId: 'op2' })];
  assert.deepEqual(attribute(circle('2026-08-01', 100, '100000000001', { operatorId: 'op1' }), ds, new Map()), { delegateId: 'a', how: 'auto' });
  assert.deepEqual(attribute(circle('2026-08-01', 100, '100000000002', { operatorId: 'op2' }), ds, new Map()), { delegateId: 'b', how: 'auto' }, 'each operator’s circle on its own: not ambiguous');
  assert.equal(attribute(circle('2026-08-01', 100, '100000000003', { operatorId: 'op3' }), ds, new Map()).how, 'none', 'an operator with no delegate active that day');
  // before operators were recorded, nothing is held back
  assert.equal(attribute(circle('2026-08-01', 100), ds, new Map()).how, 'ambiguous');
  assert.equal(attribute(circle('2026-08-01', 100, '100000000004', { operatorId: 'op1' }), [d('x', '5550100003', '2026-07-04'), d('y', '5550100004', '2026-07-04')], new Map()).how, 'ambiguous', 'delegates with no operator are everyone’s');
  // an explicit pick is still the pick
  assert.deepEqual(attribute(circle('2026-08-01', 100, '100000000005', { operatorId: 'op1' }), ds, new Map([['100000000005', 'b']])), { delegateId: 'b', how: 'assigned' });
});

test('validateDelegate: the operator, if given, is an id', () => {
  const ok = { identifier: '5550100001', activeFrom: '2026-07-04', operatorId: '00000000-0000-0000-0000-000000000001' };
  assert.equal(validateDelegate(ok, { create: true }).value.operatorId, '00000000-0000-0000-0000-000000000001');
  assert.equal(validateDelegate({ ...ok, operatorId: '' }, { create: true }).value.operatorId, undefined);
  assert.match(validateDelegate({ ...ok, operatorId: 'someone' }, { create: true }).error, /operator/);
});
