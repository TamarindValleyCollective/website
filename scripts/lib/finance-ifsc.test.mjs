// Run with: node --test scripts/lib/finance-ifsc.test.mjs
// Every value below is invented. No real IFSC belongs in this file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { branchForResponse, lookupIfsc } from './finance-ifsc.mjs';

const reply = (status, body) => async () => new Response(JSON.stringify(body), { status });

test('a known code returns the bank and branch, tidied, and nothing else from the record', async () => {
  const record = { BANK: 'Test Bank', BRANCH: 'MAIN ROAD', CITY: 'SAMPLE CITY', STATE: 'SAMPLE STATE', MICR: '123', CONTACT: '999' };
  assert.deepEqual(await lookupIfsc('abcd 0123456', reply(200, record)), { found: true, bank: 'Test Bank', branch: 'Main Road', city: 'Sample City', state: 'Sample State' });
});

test('the code is asked about as typed in capitals, and a wrong shape is not sent anywhere', async () => {
  let asked = null;
  await lookupIfsc('abcd0123456', async (url) => ((asked = url), new Response('{}', { status: 404 })));
  assert.equal(asked, 'https://ifsc.razorpay.com/ABCD0123456');
  asked = null;
  assert.deepEqual(await lookupIfsc('nope', async (url) => ((asked = url), new Response('{}'))), { found: false });
  assert.equal(asked, null);
});

test('an unknown code is not found; an outage or a bad reply is "unavailable", never "not found"', async () => {
  assert.deepEqual(await lookupIfsc('ABCD0123456', reply(404, 'Not Found')), { found: false });
  assert.deepEqual(await lookupIfsc('ABCD0123456', reply(503, {})), { unavailable: true });
  assert.deepEqual(await lookupIfsc('ABCD0123456', async () => { throw new Error('offline'); }), { unavailable: true });
  assert.equal(branchForResponse({ BRANCH: 'X' }), null);
});
