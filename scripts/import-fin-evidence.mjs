// Operator script: loads the payment screenshots that sit in the old transfer sheet as evidence against payee accounts, once
// (docs/finance/FINANCE.md, "Evidence"; migration 0094). Each screenshot is a floating picture over the row it belongs to; the row's
// account number is matched to a saved account by the keyed fingerprint the payee import uses, so a picture lands on the exact
// account it paid. They are filed as `payment` evidence (the transfer's success screen) and NOTHING is verified: an account stays
// unverified until a director marks it, who can then open the evidence from its row.
//
//   netlify dev:exec -- node scripts/import-fin-evidence.mjs --sheet <spreadsheetId>            # dry run (default)
//   netlify dev:exec -- node scripts/import-fin-evidence.mjs --sheet <spreadsheetId> --apply    # write
//
// Option: --tab "<name>" (default "Fund Transfer Request"). The sheet id is passed in (or FIN_REQUESTS_SHEET_ID), never kept in this
// public repo, and the sheet must be shared with the Drive service account. The pictures are not in the cell values, so the sheet
// is read once as an .xlsx export (it is held in memory, never written to disk). It prints COUNTS only: never a name, account
// number or picture. A picture is stored under an id taken from its content, so running it again adds nothing; a picture whose row
// matches no single saved account is skipped and counted (never guessed).
//
// Needs, by name: FINANCE_PAYEE_KEY (or STAFF_MFA_KEY) to fingerprint account numbers, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY,
// GDRIVE_SERVICE_ACCOUNT_EMAIL and GDRIVE_SERVICE_ACCOUNT_PRIVATE_KEY; for --apply also R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
// R2_SECRET_ACCESS_KEY and R2_BUCKET, and migration 0094 applied. Needs Node 22.18+ (it imports the TypeScript crypto helper directly).
import { AwsClient } from 'aws4fetch';
import { unzipSync } from 'fflate';
import { exportSpreadsheetXlsx, getSheetValues } from './lib/google-drive.mjs';
import { restHeaders } from './lib/supabase.mjs';
import { fingerprintText } from './lib/finance-party-import.mjs';
import { parseTransferTab } from './lib/finance-requests-history.mjs';
import { planEvidence, readPictures } from './lib/finance-evidence-import.mjs';
import { todayIST } from './lib/finance-parties.mjs';
import { fingerprintFinanceText } from '../netlify/functions/lib/staff-mfa-crypto.ts';

const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const sheetId = arg('--sheet') ?? process.env.FIN_REQUESTS_SHEET_ID;
const tab = arg('--tab') ?? 'Fund Transfer Request';
const apply = args.includes('--apply');
if (!sheetId) {
  console.error('Usage: netlify dev:exec -- node scripts/import-fin-evidence.mjs --sheet <spreadsheetId> [--apply]');
  process.exit(2);
}
const need = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'GDRIVE_SERVICE_ACCOUNT_EMAIL', 'GDRIVE_SERVICE_ACCOUNT_PRIVATE_KEY', ...(apply ? ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'] : [])];
const missing = need.filter((n) => !process.env[n]);
if (!process.env.FINANCE_PAYEE_KEY && !process.env.STAFF_MFA_KEY) missing.push('FINANCE_PAYEE_KEY (or STAFF_MFA_KEY)');
if (missing.length) {
  console.error(`Missing from the environment: ${missing.join(', ')}.`);
  process.exit(2);
}

const rest = (path, init = {}) => fetch(`${process.env.SUPABASE_URL}/rest/v1${path}`, { ...init, headers: restHeaders(init.headers) });
async function pages(path) {
  const all = [];
  for (let offset = 0; ; offset += 1000) {
    const res = await rest(`${path}&limit=1000&offset=${offset}`);
    if (!res.ok) throw new Error(`Supabase GET ${path.split('?')[0]} failed: ${res.status}`);
    const page = await res.json();
    all.push(...page);
    if (page.length < 1000) return all;
  }
}

const rows = await getSheetValues(sheetId, `'${tab}'!A:Z`);
const { records } = parseTransferTab(rows);
const pictures = readPictures(unzipSync(await exportSpreadsheetXlsx(sheetId)), tab);
if (pictures === null) throw new Error('That tab was not found in the sheet.');

// Saved accounts that can still be paid: not replaced, and not retired already. Several accounts with one number (a shared account, or
// the same number saved under two parties) make a picture ambiguous, and it is skipped.
const today = todayIST();
const accounts = (await pages('/fin_party_accounts?select=id,fingerprint,status,retired_on&status=neq.superseded&order=id.asc')).filter((a) => !a.retired_on || a.retired_on > today);
const idsByFingerprint = new Map();
for (const a of accounts) idsByFingerprint.set(a.fingerprint, [...(idsByFingerprint.get(a.fingerprint) ?? []), a.id]);
const existingIds = new Set((await pages('/fin_party_account_files?select=id&order=id.asc')).map((f) => f.id));

const { items, skipped } = planEvidence({
  records,
  pictures,
  byFingerprint: (number) => idsByFingerprint.get(fingerprintFinanceText(fingerprintText({ method: 'bank', account: number }))) ?? [],
  existingIds,
});
const megabytes = items.reduce((n, i) => n + i.bytes.length, 0) / 1_000_000;
console.log(`Sheet: ${records.length} completed transfers, ${pictures.length} pictures (on ${new Set(pictures.map((p) => p.row)).size} rows).`);
console.log(`To file: ${items.length} pictures (${megabytes.toFixed(1)} MB) on ${new Set(items.map((i) => i.accountId)).size} accounts.`);
console.log('Skipped:', JSON.stringify(skipped));

if (!apply) {
  console.log('\nDry run: nothing written. Add --apply to write.');
  process.exit(0);
}

const entity = (await (await rest('/fin_entities?select=id&order=created_at.asc&limit=1')).json())[0]?.id;
if (!entity) throw new Error('No finance entity found; is migration 0077 applied?');
const r2 = new AwsClient({ accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY, service: 's3', region: 'auto' });
const base = `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${process.env.R2_BUCKET}`;

let written = 0;
let failed = 0;
for (const item of items) {
  const key = `finance/vouchers/${item.id}.${item.ext}`;
  try {
    // The object first, then the row, as in the app: a row never points at nothing. The key comes from the content, so a
    // re-run overwrites the same bytes.
    const put = await r2.fetch(`${base}/${key}`, { method: 'PUT', headers: { 'content-type': item.mime }, body: item.bytes });
    if (!put.ok) throw new Error(`R2 put failed: ${put.status}`);
    const res = await rest('/fin_party_account_files', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ id: item.id, entity_id: entity, account_id: item.accountId, kind: 'payment', r2_key: key, mime: item.mime, bytes: item.bytes.length, uploaded_by: null }),
    });
    if (!res.ok) throw new Error(`insert failed: ${res.status}`);
    written += 1;
  } catch (err) {
    failed += 1;
    console.error(`Failed on sheet row ${item.line}: ${err.message}`);
  }
}

// actor_id stays null: the operator script has no signed-in person. Counts only.
await rest('/fin_audit_log', {
  method: 'POST',
  headers: { Prefer: 'return=minimal' },
  body: JSON.stringify({ entity_id: entity, action: 'finance.evidence_imported', detail: { files: written, accounts: new Set(items.map((i) => i.accountId)).size, failed, skipped } }),
});
console.log(`\nFiled ${written} pictures as payment evidence (no account was verified); ${failed} failed.`);
