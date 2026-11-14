// Operator script: loads the transfer-request sheet into payment requests and spend logs (the daily Netlify function does the same each day)
// (docs/finance/sessions/08-payment-requests-and-bills.md, decision 4; migration 0092). The two tabs become already-paid historical
// records (source "history"): the NEFT-style tab as requests, the UPI Circle tab as logs. The UPI page and the ledger then pull their
// purposes from here; the daily function netlify/functions/finance-requests-sheet-sync.mts keeps adding new rows.
//
//   netlify dev:exec -- node scripts/load-fin-requests-history.mjs --sheet <spreadsheetId>            # dry run (default)
//   netlify dev:exec -- node scripts/load-fin-requests-history.mjs --sheet <spreadsheetId> --apply    # write
//
// Options: --transfer-tab "<name>" (default "Fund Transfer Request"), --circle-tab "<name>" (default "UPI Circle Transactions").
//
// The sheet id is passed in (or FIN_REQUESTS_SHEET_ID), and the sheet must be shared with the Drive service account. It prints COUNTS
// only: never a name, purpose, reference or amount. Running it again adds nothing (a reference or an identical row already loaded is
// skipped). A row is linked to a saved party by the account number's keyed fingerprint first, then by an exact name that belongs to
// exactly one party; otherwise the name is kept as typed. The account numbers are only fingerprinted here, never stored or printed
// (the encrypted payee accounts are session 04's import). Matching to UPI rows and bank lines is not done here: an exact reference is
// matched when the page is read, and the rest are suggestions a person accepts.
//
// --apply needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and FINANCE_PAYEE_KEY (or STAFF_MFA_KEY), and migration 0092 applied.
// Needs Node 22.18+ (it imports the TypeScript crypto helper directly).
import { syncRequestsSheet } from './lib/finance-requests-sheet-sync.mjs';

const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const sheetId = arg('--sheet') ?? process.env.FIN_REQUESTS_SHEET_ID;
const apply = args.includes('--apply');
if (!sheetId) {
  console.error('Usage: netlify dev:exec -- node scripts/load-fin-requests-history.mjs --sheet <spreadsheetId> [--apply]');
  process.exit(2);
}

let r;
try {
  r = await syncRequestsSheet({ sheetId, apply, transferTab: arg('--transfer-tab'), circleTab: arg('--circle-tab') });
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
console.log(`${apply ? 'APPLY' : 'DRY RUN'}`);
console.log(`transfer tab: ${r.transfer.rows} rows, ${r.transfer.readable} readable; skipped`, JSON.stringify(r.transfer.skipped));
console.log(`circle tab:   ${r.circle.rows} rows, ${r.circle.readable} readable; skipped`, JSON.stringify(r.circle.skipped));
console.log(`to insert: ${r.toInsert} (${r.requests} requests, ${r.logs} logs); already loaded or repeated: ${r.duplicates}; no name: ${r.noName}`);
if (!r.fingerprintsOn) console.log('NOTE: the payee key is not set here, so rows were linked by name only. Run with the key set to link by account number as well.');
console.log(`linked to a saved party: ${r.linked} (${r.linkedByAccount} by account, ${r.linkedByName} by name); name kept as typed: ${r.nameKept}`);
console.log(apply ? `Wrote ${r.written}.` : 'Nothing written. Add --apply to write.');
