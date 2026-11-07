// Run with: node --test scripts/lib/finance-requests-history.test.mjs
// Invented rows only: nothing here is from the real sheet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { nameFromReceiver, parseCircleTab, parseSheetAmount, parseSheetDate, parseTransferTab, planHistory } from './finance-requests-history.mjs';

test('dates in both of the sheet\'s styles', () => {
  assert.equal(parseSheetDate('5 Nov 2026'), '2026-11-05');
  assert.equal(parseSheetDate('15-May-2026'), '2026-05-15');
  assert.equal(parseSheetDate('31 Feb 2026'), null);
  assert.equal(parseSheetDate('soon'), null);
});

test('amounts with the rupee sign and Indian grouping', () => {
  assert.equal(parseSheetAmount('₹12,500'), 1_250_000);
  assert.equal(parseSheetAmount('750.5'), 75_050);
  assert.equal(parseSheetAmount('0'), null);
  assert.equal(parseSheetAmount(''), null);
});

const TRANSFER_HEADER = ['Column 1', 'Date', 'Name', 'Amount', 'Account #', 'IFSC Code', 'Purpose', 'Status', 'Reference', 'Match'];
test('the transfer tab keeps completed rows and counts the rest by reason', () => {
  const { records, skipped } = parseTransferTab([
    TRANSFER_HEADER,
    ['1', '5 Nov 2026', 'Acme Pumps', '₹12,500', '000111222333', 'TEST0000001', 'Pump repair', 'Complete', '', ''],
    ['2', '6 Nov 2026', 'Acme Pumps', '₹500', '000111222333', 'TEST0000001', 'Pump repair', 'Failed', '', ''],
    ['3', 'not a date', 'Acme Pumps', '₹500', '', '', 'Pump repair', 'Complete', '', ''],
    ['4', '7 Nov 2026', 'Acme Pumps', 'free', '', '', 'Pump repair', 'Complete', '', ''],
    ['5', '7 Nov 2026', 'Acme Pumps', '₹500', '', '', '', 'Complete', '', ''],
    ['', '', '', '', '', '', '', '', '', ''],
    ['6', '', '', '', '', '', '', '', '', ''], // pre-numbered, nothing in it
  ]);
  assert.equal(records.length, 1);
  assert.deepEqual({ ...records[0], line: undefined }, { kind: 'request', date: '2026-11-05', name: 'Acme Pumps', amountPaise: 1_250_000, account: '000111222333', ifsc: 'TEST0000001', purpose: 'Pump repair', line: undefined });
  assert.deepEqual(skipped, { failed: 1, noDate: 1, noAmount: 1, noPurpose: 1, noName: 0 });
});

test('columns are found by name, whatever their order', () => {
  const { records } = parseTransferTab([['Purpose', 'Status', 'Amount', 'Name', 'Date'], ['Diesel', 'Complete', '₹900', 'Fuel Stop', '5 Nov 2026']]);
  assert.equal(records[0].name, 'Fuel Stop');
  assert.equal(records[0].purpose, 'Diesel');
});

test('a receiver\'s name comes from the brackets, never a UPI id', () => {
  assert.equal(nameFromReceiver('shop1@bank(Corner Shop)'), 'Corner Shop');
  assert.equal(nameFromReceiver('shop1@bank'), null);
  assert.equal(nameFromReceiver('x(a@b)'), null);
});

const CIRCLE_HEADER = ['Date', 'Time', 'Bank Name', 'Account Number', 'Sender', 'Receiver', 'Payment ID/Reference Number', 'Pay/ Collect', 'Amount (in Rs.)', 'DR/CR', 'Status', 'Recipient', 'Comments'];
test('the circle tab: no bank named is a delegated payment out; the company\'s account is direct; others are skipped', () => {
  const { records, skipped } = parseCircleTab([
    CIRCLE_HEADER,
    ['15-May-2026', '10:00:00', 'N/A', 'N/A', 'a@bank(A)', 'shop1@bank(Corner Shop)', '600000001', 'Pay', '120', 'CR', 'SUCCESS', '', 'Onions'],
    ['15-May-2026', '10:05:00', 'Test Bank', '********1234', 'a@bank(A)', 'shop2@bank(Seed Store)', '600000000002', 'Pay', '300', 'DR', 'SUCCESS', 'Seed Store Ltd', 'Seeds'],
    ['15-May-2026', '10:06:00', 'Test Bank', '********1234', 'x@bank(X)', 'a@bank(A)', '600000000003', 'Pay', '50', 'CR', 'SUCCESS', '', 'Refund'],
    ['15-May-2026', '10:07:00', 'Other Bank', '********9999', 'b@bank(B)', 'shop3@bank(Tea)', '600000000004', 'Pay', '40', 'DR', 'SUCCESS', '', 'Tea'],
    ['15-May-2026', '10:08:00', 'N/A', 'N/A', 'a@bank(A)', 'shop1@bank(Corner Shop)', '600000000005', 'Pay', '40', 'CR', 'FAILURE', '', 'Tea'],
    ['15-May-2026', '10:09:00', 'N/A', 'N/A', 'a@bank(A)', 'shop1@bank(Corner Shop)', '600000000006', 'Pay', '40', 'CR', 'EXPIRED', '', 'Tea'],
    ['15-May-2026', '10:10:00', 'N/A', 'N/A', 'a@bank(A)', 'shop1@bank(Corner Shop)', '', 'Pay', '40', 'CR', 'SUCCESS', '', 'Tea'],
    ['15-May-2026', '10:11:00', 'N/A', 'N/A', 'a@bank(A)', 'shop1@bank(Corner Shop)', '600000000007', 'Pay', '40', 'CR', 'SUCCESS', '', ''],
  ], { ownLast4: ['1234'] });
  assert.deepEqual(records.map((r) => [r.upiRef, r.paidVia, r.name, r.amountPaise, r.purpose]), [
    ['000600000001', 'delegate', 'Corner Shop', 12_000, 'Onions'],
    ['600000000002', 'direct', 'Seed Store Ltd', 30_000, 'Seeds'],
  ]);
  assert.deepEqual(skipped, { failed: 2, notOurs: 1, moneyIn: 1, noDate: 0, noAmount: 0, noRef: 1, noPurpose: 1 });
});

test('planning: a second run adds nothing, a repeated reference loads once, a party link replaces the typed name', () => {
  const records = [
    { kind: 'log', date: '2026-05-15', name: 'Corner Shop', amountPaise: 12_000, upiRef: '000600000001', purpose: 'Onions', paidVia: 'delegate' },
    { kind: 'log', date: '2026-05-15', name: 'Corner Shop', amountPaise: 12_000, upiRef: '000600000001', purpose: 'Onions', paidVia: 'delegate' },
    { kind: 'request', date: '2026-11-05', name: 'Acme Pumps', amountPaise: 1_250_000, purpose: 'Pump repair' },
    { kind: 'request', date: '2026-11-06', name: null, amountPaise: 100, purpose: 'Unnamed' },
  ];
  const partyOf = (r) => (r.name === 'Acme Pumps' ? 'party-1' : null);
  const first = planHistory(records, { existing: [], partyOf, entityId: 'ent' });
  assert.equal(first.insert.length, 2);
  assert.equal(first.duplicates, 1);
  assert.equal(first.noName, 1);
  const neft = first.insert.find((r) => r.kind === 'request');
  assert.equal(neft.party_id, 'party-1');
  assert.equal(neft.recipient_text, null);
  assert.equal(neft.mode, null, 'the old sheet never said how a request was to be paid');
  assert.equal(first.insert.find((r) => r.kind === 'log').mode, 'upi');
  assert.equal(neft.source, 'history');
  assert.equal(neft.status, 'paid');
  assert.equal(neft.requester_id, null);
  const again = planHistory(records, { existing: [{ upiRef: '000600000001' }, { upiRef: null, paidOn: '2026-11-05', amountPaise: 1_250_000, label: 'Acme Pumps', purpose: 'Pump repair' }], partyOf: () => null, entityId: 'ent' });
  assert.equal(again.insert.length, 0);
});
