// Run with: node --test scripts/lib/finance-bhim.test.mjs
// Invented rows in the layout of a real BHIM export (public repository: no real names, numbers or amounts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { isBhimText, parseBhimStatement } from './finance-bhim.mjs';

const SENDER = 'xxxxx00001@upi(EXAMPLE FARM PRIVATE LIMITED)';
const row = (date, time, bank, acct, receiver, ref, kind, amount, drcr, status) =>
  `${date} ${time} ${bank} ${acct} ${SENDER} ${receiver} ${ref} ${kind} ${amount} ${drcr} ${status}`;
const head = 'Transaction History from 01/07/2026 to 07/11/2026Customer Mobile Number: +910000000000\nTransaction History\nDate Time Bank Name Account Number Sender Receiver Payment ID/Reference Number Pay/Collect Amount (in Rs.) DR/CR Status\n';
const text = head + [
  row('26/08/2026', '16:32:30', 'N/A', 'N/A', 'xxxxx00002@axl(xxxxxxxxshop)', '600000000001', 'PAY', '150.00', 'CR', 'SUCCESS'),
  row('15/08/2026', '08:32:21', 'AXIS BANK', 'XXXX000099', 'xxxxx00003@okicici(xxxxxxxxFARM)', '600000000002', 'PAY', '2,875.00', 'DR', 'SUCCESS'),
  row('14/08/2026', '11:13:16', 'AXIS BANK', 'XXXX000099', 'bill.desk@examplebank(xxxxxxxxDESK)', '600000000003', 'PAY', '589.00', 'DR', 'FAILURE'),
  row('13/08/2026', '09:25:06', 'N/A', 'N/A', 'xxxxx00004-2@ibl(xxxxxxxx H S)', '600000000004', 'PAY', '70.00', 'CR', 'SUCCESS'),
].join('\n');

test('recognises a BHIM history and rejects other text', () => {
  assert.equal(isBhimText(text), true);
  assert.equal(isBhimText('Date,Narration,Amount'), false);
  assert.throws(() => parseBhimStatement('hello'), /BHIM/);
});

test('reads the period and each successful payment; the failed one is counted, not stored', () => {
  const p = parseBhimStatement(text);
  assert.equal(p.from, '2026-07-01');
  assert.equal(p.to, '2026-11-07');
  assert.equal(p.lines.length, 3);
  assert.deepEqual(p.unsuccessful, { count: 1, totalPaise: 58900 });
  assert.deepEqual(p.failed, []);
  assert.deepEqual(p.lines[0], {
    row: 4, paidAt: '2026-08-26', time: '16:32:30', sender: { id: 'xxxxx00001@upi', name: 'EXAMPLE FARM PRIVATE LIMITED' },
    receiver: { id: 'xxxxx00002@axl', name: 'xxxxxxxxshop' }, accountLast4: null, bankName: null, drcr: 'CR', upiRef: '600000000001', amountPaise: 15000,
  });
});

test('a row on the account names its last four digits; thousands separators are read; spaces in a name are kept', () => {
  const p = parseBhimStatement(text);
  assert.equal(p.lines[1].accountLast4, '0099');
  assert.equal(p.lines[1].bankName, 'AXIS BANK');
  assert.equal(p.lines[1].amountPaise, 287500);
  assert.equal(p.lines[2].receiver.name, 'xxxxxxxx H S');
});

test('an unreadable row is listed as failed with its line; a COLLECT request is not a payment made', () => {
  const bad = `${text}\n13/08/2026 09:25:06 garbled\n${row('12/08/2026', '10:00:00', 'N/A', 'N/A', 'xxxxx00005@ybl(x)', '600000000005', 'COLLECT', '10.00', 'CR', 'SUCCESS')}`;
  const p = parseBhimStatement(bad);
  assert.equal(p.lines.length, 3);
  assert.equal(p.failed.length, 2);
  assert.match(p.failed[0].reason, /columns/);
  assert.match(p.failed[1].reason, /COLLECT/);
});
