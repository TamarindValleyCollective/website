// Run with: node --test scripts/lib/finance-notes.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { NOTE_KEY, effectiveNote, noteKeyOf, validateNote } from './finance-notes.mjs';

const ID = '123e4567-e89b-12d3-a456-426614174000';

test('a UPI payment and its bank line share one key; a bank line with no UPI reference keys on itself', () => {
  assert.equal(noteKeyOf({ upiRef: '600000000001' }), 'upi:600000000001');
  assert.equal(noteKeyOf({ upiRrn: '600000000001', bankLineId: ID }), 'upi:600000000001');
  assert.equal(noteKeyOf({ bankLineId: ID }), `bank:${ID}`);
  assert.equal(noteKeyOf({}), null);
  assert.ok(NOTE_KEY.test('upi:600000000001') && NOTE_KEY.test(`bank:${ID}`));
  assert.ok(!NOTE_KEY.test('upi:6000') && !NOTE_KEY.test('bank:nope') && !NOTE_KEY.test('x'));
});

test('a note is trimmed and tidied; empty or missing clears it; too long or text that looks like an account is refused', () => {
  assert.deepEqual(validateNote('  Gas   cylinder\n refill '), { note: 'Gas cylinder refill' });
  assert.deepEqual(validateNote('   '), { note: null });
  assert.deepEqual(validateNote(null), { note: null });
  assert.match(validateNote('x'.repeat(301)).error, /300/);
  assert.match(validateNote('paid to 123456789012').error, /account number/);
  assert.match(validateNote('send to someone@examplebank').error, /UPI id/);
  assert.match(validateNote(42).error, /text/);
});

test('the note wins over the app wording; the app wording shows when there is no note', () => {
  assert.deepEqual(effectiveNote('Onions for the kitchen', 'Onion'), { text: 'Onions for the kitchen', from: 'note' });
  assert.deepEqual(effectiveNote(null, ' Onion '), { text: 'Onion', from: 'app' });
  assert.deepEqual(effectiveNote(null, null), { text: '', from: null });
});
