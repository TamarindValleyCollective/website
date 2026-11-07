// Run with: node --test scripts/lib/finance-origin.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { CHANNELS, ORIGINS, originLabel, originOf, sourcesOf } from './finance-origin.mjs';

const debit = (narration) => ({ narration, direction: 'debit' });

test('a joined UPI row names the app, whatever the narration says', () => {
  assert.equal(originOf(debit('UPI/P2A/600000000001/Shop/Bank'), 'bhim'), 'bhim');
  assert.equal(originOf(debit('UPI/P2M/600000000002/Shop/Bank'), 'paytm'), 'paytm');
});

test('a UPI narration with no joined row is UPI with the app unknown', () => {
  assert.equal(originOf(debit('UPI/P2A/600000000003/Shop/Bank'), null), 'upi_unknown');
  assert.equal(originOf({ narration: 'UPI/P2A/600000000004/Someone/Bank', direction: 'credit' }, undefined), 'upi_unknown');
});

test('a NEFT debit with a reference and a batch number but no payee is Paypro; a named NEFT or an incoming one is not', () => {
  assert.equal(originOf(debit('NEFT/0101102630472/10/'), null), 'paypro');
  assert.equal(originOf(debit('NEFT/260001334897/10/AW0002460169/'), null), 'paypro');
  assert.equal(originOf(debit('INB/NEFT/AXODH28201632867/Some Payee/EXAMPLE BANK//////'), null), 'bank');
  assert.equal(originOf({ narration: 'NEFT/0101102630472/10/', direction: 'credit' }, null), 'bank');
});

test('everything else is the bank directly', () => {
  for (const n of ['IMPS/P2A/123/Payee', 'Monthly Service Chrgs/x', 'INB/IFT/x', 'NEFT/HDFCH123/Someone', '']) assert.equal(originOf(debit(n), null), 'bank');
});

test('every origin has a label', () => {
  for (const k of Object.keys(ORIGINS)) assert.ok(originLabel(k).length > 0);
  assert.equal(originLabel('nope'), 'nope');
});

test('the payment gateway is money in under its own name; a UPI payment to the gateway is not a settlement', () => {
  assert.equal(originOf({ narration: 'Razorpay Software Pvt  Ltd  Fu 12345', direction: 'credit' }, null), 'gateway');
  assert.equal(originOf({ narration: 'UPI/P2M/600000000009/Razorpay /Update/EXAMPLE PAY', direction: 'debit' }, null), 'upi_unknown');
  assert.equal(originOf({ narration: 'Razorpay Software Pvt Ltd refund', direction: 'debit' }, null), 'bank');
});

test('card payments and their refunds are the debit card, whichever way the money moved', () => {
  assert.equal(originOf(debit('POS/EXAMPLE WORKSPACE/CITY/123'), null), 'card');
  assert.equal(originOf(debit('ECOM PUR/EXAMPLE/CITY/123'), null), 'card');
  assert.equal(originOf({ narration: 'VISA MERCH Refund/25/APR/25/EXAMPLE', direction: 'credit' }, null), 'card');
});

test('every channel says what sort it is and which way money moves; ORIGINS is the same list', () => {
  assert.equal(ORIGINS, CHANNELS);
  for (const c of Object.values(CHANNELS)) {
    assert.ok(['upi_app', 'bulk', 'gateway', 'card', 'bank'].includes(c.kind));
    assert.ok(c.flows.length > 0 && c.flows.every((f) => f === 'in' || f === 'out'));
  }
});

test('a line is vouched for by its bank, plus the app, bulk file or gateway it came through', () => {
  assert.deepEqual(sourcesOf({ bankBadge: 'axis', origin: 'bank' }), ['axis']);
  assert.deepEqual(sourcesOf({ bankBadge: 'axis', origin: 'bhim' }), ['axis', 'bhim']);
  assert.deepEqual(sourcesOf({ bankBadge: 'axis', origin: 'paytm' }), ['axis', 'paytm']);
  assert.deepEqual(sourcesOf({ bankBadge: 'axis', origin: 'paypro' }), ['axis', 'paypro']);
  assert.deepEqual(sourcesOf({ bankBadge: 'axis', origin: 'gateway' }), ['axis', 'razorpay']);
  assert.deepEqual(sourcesOf({ bankBadge: 'other_bank', origin: 'card' }), ['other_bank']);
  assert.deepEqual(sourcesOf({ bankBadge: null, origin: 'upi_unknown' }), ['bank']);
});
