// Run with: node --test scripts/lib/finance-upi-operators.test.mjs
//
// Whose UPI a file is: the signature of a file, and who it is suggested to. Every name, number and id here is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shortHash, signatureOf, suggestOperator, withSignature } from './finance-upi-operators.mjs';

test('a Paytm export is known by the accounts it names, in any order and case, never by their labels', () => {
  const a = signatureOf('paytm_upi', { accounts: ['Test Bank XXXX0001', 'Other Bank XXXX0002'] });
  const b = signatureOf('paytm_upi', { accounts: ['other bank xxxx0002', ' Test Bank  XXXX0001', 'Test Bank XXXX0001'] });
  assert.equal(a, b);
  assert.match(a, /^paytm:[0-9a-f]{16}$/);
  assert.ok(!a.includes('0001'));
  assert.notEqual(a, signatureOf('paytm_upi', { accounts: ['Test Bank XXXX0001'] }));
  assert.equal(signatureOf('paytm_upi', { accounts: [] }), null, 'nothing to tell it by');
});

test('a BHIM history is known by the sender that pays most of its rows, ignoring the rows with none', () => {
  const lines = (...ids) => ({ lines: ids.map((id) => ({ sender: { id } })) });
  const a = signatureOf('bhim_upi', lines('xxxxx11111@test', 'xxxxx11111@test', 'xxxxx22222@test', 'N/A'));
  assert.match(a, /^bhim:[0-9a-f]{16}$/);
  assert.equal(a, signatureOf('bhim_upi', lines('XXXXX11111@TEST', 'xxxxx11111@test')));
  assert.notEqual(a, signatureOf('bhim_upi', lines('xxxxx22222@test')));
  assert.equal(signatureOf('bhim_upi', lines('N/A', '')), null);
  assert.equal(signatureOf('axis_statement', {}), null, 'a bank statement is not a UPI file');
});

test('a file is suggested to the one operator who has had its signature, or to the only operator, and otherwise to nobody', () => {
  const sigA = signatureOf('paytm_upi', { accounts: ['Test Bank XXXX0001'] });
  const sigB = signatureOf('paytm_upi', { accounts: ['Other Bank XXXX0002'] });
  const two = [{ id: 'o1', signatures: [sigA] }, { id: 'o2', signatures: [] }];
  assert.deepEqual(suggestOperator({ signature: sigA, operators: two }), { operatorId: 'o1', reason: 'same_file_layout' });
  assert.equal(suggestOperator({ signature: sigB, operators: two }), null, 'a layout nobody has had: the import just asks');
  assert.equal(suggestOperator({ signature: null, operators: two }), null);
  assert.deepEqual(suggestOperator({ signature: sigB, operators: [{ id: 'o1', signatures: [] }] }), { operatorId: 'o1', reason: 'only_operator' });
  assert.equal(suggestOperator({ signature: sigA, operators: [{ id: 'o1', signatures: [sigA] }, { id: 'o2', signatures: [sigA] }] }), null, 'two operators share it: not guessed');
  assert.equal(suggestOperator({ signature: sigA, operators: [] }), null);
});

test('remembering a signature keeps it once, newest last, and no more than twenty', () => {
  assert.deepEqual(withSignature(['a', 'b'], 'c'), ['a', 'b', 'c']);
  assert.deepEqual(withSignature(['a', 'b'], 'a'), ['a', 'b']);
  assert.deepEqual(withSignature(undefined, 'a'), ['a']);
  assert.deepEqual(withSignature(['a'], null), ['a']);
  assert.equal(withSignature(Array.from({ length: 25 }, (_, i) => `s${i}`), 'new').length, 20);
  assert.equal(withSignature(Array.from({ length: 25 }, (_, i) => `s${i}`), 'new').at(-1), 'new');
  assert.equal(shortHash('x'), shortHash('x'));
  assert.notEqual(shortHash('x'), shortHash('y'));
});
