// The daily sheet sync end to end, with Google and Supabase both mocked and every row invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { syncRequestsSheet } from './finance-requests-sheet-sync.mjs';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
Object.assign(process.env, { GDRIVE_SERVICE_ACCOUNT_EMAIL: 'sync@example.test', GDRIVE_SERVICE_ACCOUNT_PRIVATE_KEY: privateKey, SUPABASE_URL: 'https://db.example.test', SUPABASE_SERVICE_ROLE_KEY: 'x', STAFF_MFA_KEY: Buffer.alloc(32, 7).toString('base64') });

const TRANSFER = [
  ['#', 'Date', 'Name', 'Amount', 'Account #', 'IFSC Code', 'Purpose', 'Status'],
  [1, '5 Nov 2026', 'Asha Vendor', '₹1,200', '', '', 'Seedlings', 'Completed'],
  [2, '6 Nov 2026', 'Ravi Vendor', '2,000', '', '', 'Fencing', 'Completed'],
  [3, '7 Nov 2026', 'Failed Vendor', '500', '', '', 'Nothing', 'Failed'],
];
const CIRCLE = [['Date', 'Bank Name', 'Account Number', 'Receiver', 'Payment ID/Reference Number', 'Amount (in Rs.)', 'DR/CR', 'Status', 'Recipient', 'Comments']];

function mock({ existing = [] } = {}) {
  const posts = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
    if (u.includes('oauth2.googleapis.com')) return json({ access_token: 't', expires_in: 3600 });
    if (u.includes('sheets.googleapis.com')) return json({ values: decodeURIComponent(u).includes('Fund Transfer Request') ? TRANSFER : CIRCLE });
    if (init.method === 'POST') return posts.push({ u, body: JSON.parse(init.body) }), new Response(null, { status: 201 });
    if (u.includes('/fin_entities')) return json([{ id: 'ent-1' }]);
    if (u.includes('/fin_payment_requests')) return json(existing);
    return json([]);
  };
  return posts;
}

test('a dry run reports what is new and writes nothing', async () => {
  const posts = mock();
  const r = await syncRequestsSheet({ sheetId: 's', apply: false });
  assert.equal(r.toInsert, 2);
  assert.equal(r.written, 0);
  assert.equal(posts.length, 0);
});

test('apply inserts the new rows and audits; rows already loaded are skipped', async () => {
  let posts = mock();
  const r = await syncRequestsSheet({ sheetId: 's', apply: true });
  assert.equal(r.written, 2);
  assert.equal(posts[0].body.length, 2);
  assert.ok(posts[0].body.every((row) => row.source === 'history' && row.status === 'paid'));
  assert.equal(posts[1].body.action, 'finance.requests_history_loaded');

  posts = mock({ existing: posts[0].body.map((row) => ({ upi_ref: null, paid_on: row.paid_on, amount_paise: row.amount_paise, party_id: null, recipient_text: row.recipient_text, purpose: row.purpose })) });
  const again = await syncRequestsSheet({ sheetId: 's', apply: true });
  assert.equal(again.written, 0);
  assert.equal(again.duplicates, 2);
  assert.equal(posts.length, 0, 'a quiet run writes and audits nothing');
});
