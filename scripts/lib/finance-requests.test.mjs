// Run with: node --test scripts/lib/finance-requests.test.mjs
// Invented data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { agingUnmatched, fulfilledVia, deriveLinks, descriptionWords, matchWords, cleanUpiRef, decide, exactMatches, padUpiRef, planMatch, proposeMatches, purposeIndex, reviewFlag, sniffVoucher, validateRecord } from './finance-requests.mjs';

const P1 = '11111111-1111-4111-8111-111111111111';
const today = '2026-11-07';
const req = (over = {}) => ({ partyId: P1, amountPaise: 250_000, mode: 'neft', purpose: 'Pump repair', ...over });
const log = (over = {}) => ({ partyId: P1, amountPaise: 12_000, purpose: 'Onions', paidOn: '2026-11-05', paidVia: 'delegate', ...over });

test('cleanUpiRef: exactly 12 digits, spaces ignored, empty is none, anything else invalid', () => {
  assert.equal(cleanUpiRef('6000 0000 0001'), '600000000001');
  assert.equal(cleanUpiRef(''), null);
  assert.equal(cleanUpiRef(null), null);
  assert.equal(cleanUpiRef('60000000001'), undefined);
  assert.equal(cleanUpiRef('60000000000a'), undefined);
});

test('padUpiRef: a spreadsheet drops leading zeros, so pad to 12; refuse what cannot be a reference', () => {
  assert.equal(padUpiRef('600000001'), '000600000001');
  assert.equal(padUpiRef(600000001), '000600000001');
  assert.equal(padUpiRef('600000000001.0'), '600000000001');
  assert.equal(padUpiRef('6000000000012'), null);
  assert.equal(padUpiRef('abc'), null);
  assert.equal(padUpiRef(''), null);
  assert.equal(padUpiRef('0'), null);
});

test('a request needs a payee, an amount, a mode and a purpose', () => {
  assert.ok(validateRecord(req(), { kind: 'request', today }).value);
  assert.match(validateRecord(req({ partyId: null }), { kind: 'request', today }).error, /payee/);
  assert.match(validateRecord(req({ partyId: 'x' }), { kind: 'request', today }).error, /list/);
  assert.match(validateRecord(req({ amountPaise: 0 }), { kind: 'request', today }).error, /amount/);
  assert.match(validateRecord(req({ amountPaise: 12.5 }), { kind: 'request', today }).error, /amount/);
  assert.match(validateRecord(req({ amountPaise: 99_000_000_000 }), { kind: 'request', today }).error, /too large/);
  assert.match(validateRecord(req({ mode: 'cash' }), { kind: 'request', today }).error, /how/);
  assert.match(validateRecord(req({ purpose: ' ' }), { kind: 'request', today }).error, /for/);
  assert.match(validateRecord(req({ purpose: 'x'.repeat(301) }), { kind: 'request', today }).error, /300/);
  assert.match(validateRecord(req({ neededBy: '2026-02-30' }), { kind: 'request', today }).error, /real date/);
});

test('a purpose may not carry an account number, UPI id or IFSC', () => {
  assert.match(validateRecord(req({ purpose: 'Pay 123456789012 now' }), { kind: 'request', today }).error, /account number/);
  assert.match(validateRecord(req({ purpose: 'pay me@bank' }), { kind: 'request', today }).error, /account number/);
  assert.match(validateRecord(req({ purpose: 'ABCD0123456 branch' }), { kind: 'request', today }).error, /account number/);
});

test('a log is a UPI payment already made: a date not in the future, direct or delegate, who was paid', () => {
  const ok = validateRecord(log(), { kind: 'log', today });
  assert.equal(ok.value.mode, 'upi');
  assert.equal(ok.value.paidVia, 'delegate');
  assert.match(validateRecord(log({ paidOn: '2026-11-08' }), { kind: 'log', today }).error, /future/);
  assert.match(validateRecord(log({ paidOn: undefined }), { kind: 'log', today }).error, /date/);
  assert.match(validateRecord(log({ paidVia: 'cash' }), { kind: 'log', today }).error, /directly or by a delegate/);
  assert.match(validateRecord(log({ upiRef: '123' }), { kind: 'log', today }).error, /12 digits/);
  assert.equal(validateRecord(log({ upiRef: '600000000001' }), { kind: 'log', today }).value.upiRef, '600000000001');
  // a log may name a recipient in words when no saved party fits, but needs one or the other
  assert.ok(validateRecord(log({ partyId: null, recipientText: 'Corner shop' }), { kind: 'log', today }).value);
  assert.match(validateRecord(log({ partyId: null }), { kind: 'log', today }).error, /who was paid/);
  assert.match(validateRecord(log({ partyId: null, recipientText: 'pay me@bank' }), { kind: 'log', today }).error, /name of who/);
});

test('a log ignores a mode sent with it: it is always UPI', () => {
  assert.equal(validateRecord(log({ mode: 'neft' }), { kind: 'log', today }).value.mode, 'upi');
});

test('maker is not checker: whoever raised a request cannot approve or reject it', () => {
  const record = { kind: 'request', status: 'submitted', requesterId: 'a' };
  assert.match(decide({ record, action: 'approve', actorId: 'a', now: 'n' }).error, /Someone else/);
  assert.match(decide({ record, action: 'reject', actorId: 'a', reason: 'no', now: 'n' }).error, /Someone else/);
  const ok = decide({ record, action: 'approve', actorId: 'b', now: 'n' });
  assert.equal(ok.patch.status, 'approved');
  assert.equal(ok.patch.decided_by, 'b');
});

test('rejecting needs a reason; a decided request is not decided again; a log is never decided', () => {
  const record = { kind: 'request', status: 'submitted', requesterId: 'a' };
  assert.match(decide({ record, action: 'reject', actorId: 'b', now: 'n' }).error, /why/);
  assert.equal(decide({ record, action: 'reject', actorId: 'b', reason: 'Duplicate of an earlier one', now: 'n' }).patch.status, 'rejected');
  assert.match(decide({ record: { ...record, status: 'approved' }, action: 'approve', actorId: 'b', now: 'n' }).error, /already/);
  assert.match(decide({ record: { ...record, kind: 'log', status: 'paid' }, action: 'approve', actorId: 'b', now: 'n' }).error, /no approval/);
  assert.match(decide({ record, action: 'pay', actorId: 'b', now: 'n' }).error, /approve or reject/);
});

test('the requester may cancel their own request until it is paid, nobody after', () => {
  const record = { kind: 'request', status: 'submitted', requesterId: 'a' };
  assert.equal(decide({ record, action: 'cancel', actorId: 'a', now: 'n' }).patch.status, 'cancelled');
  assert.equal(decide({ record: { ...record, status: 'approved' }, action: 'cancel', actorId: 'a', now: 'n' }).patch.status, 'cancelled');
  assert.match(decide({ record: { ...record, status: 'paid' }, action: 'cancel', actorId: 'a', now: 'n' }).error, /not been paid/);
  assert.match(decide({ record: { ...record, status: 'rejected' }, action: 'cancel', actorId: 'a', now: 'n' }).error, /not been paid/);
});

test('a payment to the requester\'s own party is flagged for review', () => {
  assert.equal(reviewFlag({ partyId: P1 }, [P1]), 'own_party');
  assert.equal(reviewFlag({ partyId: P1 }, []), null);
  assert.equal(reviewFlag({ partyId: null }, [P1]), null);
});

const upiLines = [
  { id: 'u1', upiRef: '600000000001', amountPaise: 12_000, direction: 'debit', paidAt: '2026-11-05', counterparty: 'Corner Shop', bankLineId: 'b1' },
  { id: 'u2', upiRef: '600000000002', amountPaise: 50_000, direction: 'debit', paidAt: '2026-11-04', counterparty: 'Someone Else', bankLineId: null },
];
const bankLines = [
  { id: 'b1', upiRrn: '600000000001', amountPaise: 12_000, direction: 'debit', tranDate: '2026-11-05', narration: 'UPI/P2M/600000000001/Corner Shop' },
  { id: 'b2', upiRrn: null, amountPaise: 250_000, direction: 'debit', tranDate: '2026-11-10', narration: 'NEFT/ACME PUMPS/ref' },
  { id: 'b3', upiRrn: '600000000009', amountPaise: 7_000, direction: 'debit', tranDate: '2026-11-01', narration: 'UPI/x' },
  { id: 'b3r', upiRrn: '600000000009', amountPaise: 7_000, direction: 'credit', tranDate: '2026-11-01', narration: 'UPI/reversal' },
];

test('exact match by reference joins the UPI row and its bank line', () => {
  const { links, mismatches } = exactMatches([{ id: 'r1', status: 'paid', amountPaise: 12_000, upiRef: '600000000001' }], upiLines, bankLines);
  assert.deepEqual(links.get('r1'), { upiLineId: 'u1', bankLineId: 'b1' });
  assert.deepEqual(mismatches, []);
});

test('a reference that finds a different amount is reported, never linked', () => {
  const { links, mismatches } = exactMatches([{ id: 'r1', status: 'paid', amountPaise: 99_000, upiRef: '600000000001' }], upiLines, bankLines);
  assert.equal(links.size, 0);
  assert.deepEqual(mismatches, ['r1']);
});

test('an exact match uses the debit, never the reversal credit under the same reference', () => {
  const { links } = exactMatches([{ id: 'r1', status: 'paid', amountPaise: 7_000, upiRef: '600000000009' }], upiLines, bankLines);
  assert.deepEqual(links.get('r1'), { upiLineId: null, bankLineId: 'b3' });
});

test('records with no reference, or rejected or cancelled, are not exact-matched', () => {
  const rs = [
    { id: 'a', status: 'paid', amountPaise: 12_000, upiRef: null },
    { id: 'b', status: 'cancelled', amountPaise: 12_000, upiRef: '600000000001' },
  ];
  assert.equal(exactMatches(rs, upiLines, bankLines).links.size, 0);
});

test('a NEFT request is proposed the bank debit of the same amount that lands after approval, with the payee name raising it', () => {
  const r = { id: 'r1', mode: 'neft', amountPaise: 250_000, partyName: 'Acme Pumps', recipientText: null, decidedOn: '2026-11-07', paidOn: null, createdOn: '2026-11-06' };
  const out = proposeMatches([r], upiLines, bankLines);
  assert.equal(out.length, 1);
  assert.deepEqual([out[0].type, out[0].targetId], ['bank', 'b2']);
  assert.ok(out[0].reasons.includes('payee name in the narration'));
});

test('no proposal when the amount differs, the bank line is before the approval, or it is outside the window', () => {
  const base = { id: 'r1', mode: 'neft', amountPaise: 250_000, partyName: 'Acme Pumps', decidedOn: '2026-11-07', paidOn: null, createdOn: '2026-11-06' };
  assert.equal(proposeMatches([{ ...base, amountPaise: 250_001 }], upiLines, bankLines).length, 0);
  assert.equal(proposeMatches([{ ...base, decidedOn: '2026-11-11' }], upiLines, bankLines).length, 0);
  assert.equal(proposeMatches([{ ...base, decidedOn: '2026-10-01' }], upiLines, bankLines).length, 0);
});

test('a UPI log without a reference is proposed the UPI row and bank line of the same amount within three days', () => {
  const r = { id: 'r2', mode: 'upi', amountPaise: 50_000, partyName: null, recipientText: 'Someone Else', decidedOn: null, paidOn: '2026-11-05', createdOn: '2026-11-06' };
  const out = proposeMatches([r], upiLines, bankLines);
  assert.deepEqual(out.map((p) => [p.type, p.targetId]), [['upi', 'u2']]);
  assert.ok(out[0].reasons.includes('payee name matches'));
});

test('a target already claimed by another record is not proposed again', () => {
  const r = { id: 'r2', mode: 'upi', amountPaise: 50_000, partyName: null, recipientText: 'Someone Else', paidOn: '2026-11-05', createdOn: '2026-11-06' };
  assert.equal(proposeMatches([r], upiLines, bankLines, { claimedUpi: new Set(['u2']) }).length, 0);
});

test('a credit is never proposed for a payment', () => {
  const r = { id: 'r3', mode: 'upi', amountPaise: 7_000, partyName: null, recipientText: null, paidOn: '2026-11-01', createdOn: '2026-11-01' };
  const out = proposeMatches([r], [], bankLines);
  assert.deepEqual(out.map((p) => p.targetId), ['b3']);
});

test('purpose is pulled by reference, UPI row or bank line; rejected and cancelled records explain nothing', () => {
  const find = purposeIndex([
    { status: 'paid', purpose: 'Onions', upiRef: '600000000001', upiLineId: null, bankLineId: null },
    { status: 'paid', purpose: 'Pump repair', upiRef: null, upiLineId: 'u2', bankLineId: 'b2' },
    { status: 'cancelled', purpose: 'Not this', upiRef: '600000000003', upiLineId: null, bankLineId: null },
  ]);
  assert.equal(find({ upiRef: '600000000001' }), 'Onions');
  assert.equal(find({ upiLineId: 'u2' }), 'Pump repair');
  assert.equal(find({ bankLineId: 'b2' }), 'Pump repair');
  assert.equal(find({ upiRef: '600000000003' }), null);
  assert.equal(find({}), null);
  assert.equal(find(), null);
});

test('an approved request unmatched for more than 14 days ages onto data health', () => {
  const rs = [
    { id: 'a', kind: 'request', status: 'approved', decidedOn: '2026-10-20', bankLineId: null, upiLineId: null },
    { id: 'b', kind: 'request', status: 'approved', decidedOn: '2026-11-01', bankLineId: null, upiLineId: null },
    { id: 'c', kind: 'request', status: 'approved', decidedOn: '2026-10-01', bankLineId: 'x', upiLineId: null },
    { id: 'd', kind: 'request', status: 'paid', decidedOn: '2026-10-01', bankLineId: null, upiLineId: null },
  ];
  assert.deepEqual(agingUnmatched(rs, '2026-11-07').map((r) => r.id), ['a']);
});

const target = { id: 'b2', direction: 'debit', amountPaise: 250_000, date: '2026-11-10' };
test('accepting a match on an approved request marks it paid on the statement date', () => {
  const r = planMatch({ record: { kind: 'request', status: 'approved', amountPaise: 250_000 }, type: 'bank', target, now: 'n', actorId: 'a' });
  assert.deepEqual(r.patch, { bank_line_id: 'b2', upi_line_id: null, matched_by: 'a', matched_at: 'n', status: 'paid', paid_on: '2026-11-10' });
});

test('a match on a UPI row also takes the bank line that row is joined to, and the other way round', () => {
  const rec = { kind: 'log', status: 'paid', amountPaise: 12_000 };
  const viaUpi = planMatch({ record: rec, type: 'upi', target: { id: 'u1', direction: 'debit', amountPaise: 12_000, date: 'd', bankLineId: 'b1' }, now: 'n', actorId: 'a' });
  assert.equal(viaUpi.patch.bank_line_id, 'b1');
  assert.equal(viaUpi.patch.status, undefined);
  const viaBank = planMatch({ record: rec, type: 'bank', target: { id: 'b1', direction: 'debit', amountPaise: 12_000, date: 'd', upiLineId: 'u1' }, now: 'n', actorId: 'a' });
  assert.equal(viaBank.patch.upi_line_id, 'u1');
});

test('a match is refused for a different amount, a credit, an unapproved request, or a rejected record', () => {
  const ok = { kind: 'request', status: 'approved', amountPaise: 250_000 };
  assert.match(planMatch({ record: ok, type: 'bank', target: { ...target, amountPaise: 1 }, now: 'n', actorId: 'a' }).error, /amount/);
  assert.match(planMatch({ record: ok, type: 'bank', target: { ...target, direction: 'credit' }, now: 'n', actorId: 'a' }).error, /payment out/);
  assert.match(planMatch({ record: { ...ok, status: 'submitted' }, type: 'bank', target, now: 'n', actorId: 'a' }).error, /Approve/);
  assert.match(planMatch({ record: { ...ok, status: 'rejected' }, type: 'bank', target, now: 'n', actorId: 'a' }).error, /rejected/);
  assert.match(planMatch({ record: ok, type: 'x', target, now: 'n', actorId: 'a' }).error, /Choose/);
});

test('a voucher is recognised by its first bytes, not its name', () => {
  assert.deepEqual(sniffVoucher(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0])), { mime: 'image/jpeg', ext: 'jpg' });
  assert.deepEqual(sniffVoucher(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), { mime: 'image/png', ext: 'png' });
  assert.equal(sniffVoucher(new TextEncoder().encode('%PDF-1.7 ...')).mime, 'application/pdf');
  assert.equal(sniffVoucher(new TextEncoder().encode('RIFF....WEBPVP8 ')).mime, 'image/webp');
  assert.equal(sniffVoucher(new TextEncoder().encode('<html>')), null);
  assert.equal(sniffVoucher(new Uint8Array([])), null);
});

test('the description is looked for too: a purpose word in a UPI remark or a narration raises a suggestion and says so', () => {
  const upi = [
    { id: 'u1', upiRef: '1', amountPaise: 50_000, direction: 'debit', paidAt: '2026-11-05', counterparty: 'Seed Store', remark: 'Tomato seeds', bankLineId: null },
    { id: 'u2', upiRef: '2', amountPaise: 50_000, direction: 'debit', paidAt: '2026-11-05', counterparty: 'Seed Store', remark: 'misc', bankLineId: null },
  ];
  const r = { id: 'r', mode: 'upi', amountPaise: 50_000, partyName: 'Seed Store', purpose: 'Tomato seeds for the nursery', paidOn: '2026-11-05', createdOn: '2026-11-05' };
  const out = proposeMatches([r], upi, []);
  assert.equal(out[0].targetId, 'u1');
  assert.ok(out[0].reasons.includes('description matches'));
  assert.ok(!out[1].reasons.includes('description matches'));
  const bank = [{ id: 'b', direction: 'debit', amountPaise: 90_000, tranDate: '2026-11-10', narration: 'NEFT/DIESEL SUPPLY/ref', upiRrn: null }];
  const n = proposeMatches([{ id: 'q', mode: 'neft', amountPaise: 90_000, partyName: 'Fuel Corner', purpose: 'Diesel for tractor', decidedOn: '2026-11-07', createdOn: '2026-11-06' }], [], bank);
  assert.ok(n[0].reasons.includes('description in the narration'));
});

test('description words skip short and common words; match words add the payee name', () => {
  assert.deepEqual(descriptionWords('Payment for the tractor repair'), ['tractor', 'repair']);
  assert.deepEqual(matchWords('Corner Shop', 'Onions for payment'), ['corner', 'shop', 'onions']);
  assert.deepEqual(matchWords(null, null), []);
});

test('one link is enough: the other side of the same payment is derived from the UPI row\'s join to its bank line', () => {
  const upi = [{ id: 'u1', bankLineId: 'b1' }, { id: 'u2', bankLineId: null }];
  assert.deepEqual(deriveLinks({ upiLineId: 'u1' }, upi), { upiLineId: 'u1', bankLineId: 'b1' });
  assert.deepEqual(deriveLinks({ bankLineId: 'b1' }, upi), { upiLineId: 'u1', bankLineId: 'b1' });
  assert.deepEqual(deriveLinks({ upiLineId: 'u2' }, upi), { upiLineId: 'u2', bankLineId: null });
  assert.deepEqual(deriveLinks({ bankLineId: 'b9' }, upi), { upiLineId: null, bankLineId: 'b9' });
  assert.deepEqual(deriveLinks({}, upi), { upiLineId: null, bankLineId: null });
  assert.deepEqual(deriveLinks({ upiLineId: 'u1', bankLineId: 'bx' }, upi), { upiLineId: 'u1', bankLineId: 'bx' }, 'a stored pair is left as it is');
});

test('a NEFT request is also offered a UPI payment of the same amount: it may have been paid another way', () => {
  const r = { id: 'r', mode: 'neft', amountPaise: 50_000, partyName: 'Seed Store', purpose: 'Seeds', decidedOn: '2026-11-04', createdOn: '2026-11-03' };
  const upi = [{ id: 'u1', upiRef: '1', amountPaise: 50_000, direction: 'debit', paidAt: '2026-11-05', counterparty: 'Seed Store', remark: 'Seeds', bankLineId: null }];
  const out = proposeMatches([r], upi, []);
  assert.deepEqual(out.map((p) => [p.type, p.targetId]), [['upi', 'u1']]);
  // before the approval is too early for a request that was not paid yet
  assert.equal(proposeMatches([{ ...r, decidedOn: '2026-11-09' }], upi, []).length, 0);
});

test('how a payment was made: the UPI app, else the method its narration starts with', () => {
  assert.deepEqual(fulfilledVia({ upiApp: 'paytm' }), { method: 'upi', label: 'UPI, Paytm' });
  assert.deepEqual(fulfilledVia({ narration: 'NEFT/ACME/ref' }), { method: 'neft', label: 'NEFT' });
  assert.deepEqual(fulfilledVia({ narration: 'imps/123/x' }), { method: 'imps', label: 'IMPS' });
  assert.deepEqual(fulfilledVia({ narration: 'UPI/P2A/123/x' }), { method: 'upi', label: 'UPI' });
  assert.deepEqual(fulfilledVia({ narration: 'INB/NEFT/123456/ACME' }), { method: 'neft', label: 'NEFT' }, 'internet banking says NEFT in its second segment');
  assert.deepEqual(fulfilledVia({ narration: 'INB/IFT/123/ACME' }), { method: 'ift', label: 'Internal transfer' });
  assert.deepEqual(fulfilledVia({ narration: 'MMT/IMPS/123/ACME' }), { method: 'imps', label: 'IMPS' });
  assert.deepEqual(fulfilledVia({ narration: 'POS/SHOP/123' }), { method: 'card', label: 'Card' });
  assert.deepEqual(fulfilledVia({ narration: 'CHQ PAID 0001' }), { method: 'bank', label: 'Bank transfer' });
  assert.equal(fulfilledVia({ narration: 'GST/ACME/INBOUND' }).method, 'bank', 'a method word beyond the second segment is not read');
  assert.equal(fulfilledVia({}), null);
});

test('a UPI row and the bank line it is joined to are one payment: offered once, not twice', () => {
  const r = { id: 'r', mode: 'upi', amountPaise: 50_000, partyName: 'Seed Store', purpose: 'Seeds', paidOn: '2026-11-05', createdOn: '2026-11-05' };
  const upi = [{ id: 'u1', upiRef: '1', amountPaise: 50_000, direction: 'debit', paidAt: '2026-11-05', counterparty: 'Seed Store', remark: null, bankLineId: 'b1' }];
  const bank = [{ id: 'b1', direction: 'debit', amountPaise: 50_000, tranDate: '2026-11-05', narration: 'UPI/P2A/1/SEED STORE', upiRrn: '1' }, { id: 'b2', direction: 'debit', amountPaise: 50_000, tranDate: '2026-11-06', narration: 'NEFT/OTHER', upiRrn: null }];
  const out = proposeMatches([r], upi, bank);
  assert.deepEqual(out.map((p) => [p.type, p.targetId]).sort(), [['bank', 'b2'], ['upi', 'u1']], 'the joined bank line is not offered separately; an unrelated one still is');
});
