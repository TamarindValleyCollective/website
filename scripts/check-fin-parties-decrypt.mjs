// Operator check: can the payee key open what is stored? (docs/finance/FINANCE.md, "Keys".)
//
//   netlify dev:exec -- node scripts/check-fin-parties-decrypt.mjs
//
// For every row in fin_party_accounts it decrypts the details with the key in the environment (FINANCE_PAYEE_KEY, or
// STAFF_MFA_KEY if that is not set), then checks that the result agrees with what is stored in the clear: the last four
// characters and the keyed fingerprint. It prints COUNTS ONLY: never an account number, UPI id, name or id. Exit code 1 if
// any row fails, so a wrong or mistyped key is caught before anyone relies on the data.
//
// Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (netlify dev:exec injects them) and the payee key in the shell.
// Needs Node 22.18+ (it imports the TypeScript crypto helper directly).
import { restHeaders } from './lib/supabase.mjs';
import { validatePayeeDetails } from './lib/finance-parties.mjs';
import { fingerprintText } from './lib/finance-party-import.mjs';
import { decryptFinanceText, fingerprintFinanceText } from '../netlify/functions/lib/staff-mfa-crypto.ts';

if (!process.env.FINANCE_PAYEE_KEY && !process.env.STAFF_MFA_KEY) {
  console.error('Set FINANCE_PAYEE_KEY (the payee encryption key) first.');
  process.exit(2);
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are missing: run this through `netlify dev:exec --`.');
  process.exit(2);
}

const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/fin_party_accounts?select=method,last4,fingerprint,details_enc&order=created_at.asc`, { headers: restHeaders() });
if (!res.ok) {
  console.error(`Could not read fin_party_accounts: ${res.status}`);
  process.exit(2);
}
const rows = await res.json();

let opened = 0;
let last4Matches = 0;
let fingerprintMatches = 0;
for (const row of rows) {
  try {
    const details = JSON.parse(decryptFinanceText(row.details_enc));
    opened++;
    if (validatePayeeDetails(details, { allowMissingIfsc: true }).last4 === row.last4) last4Matches++;
    if (fingerprintFinanceText(fingerprintText(details)) === row.fingerprint) fingerprintMatches++;
  } catch {
    // counted as a failure below; the reason is deliberately not printed
  }
}

console.log(`Accounts checked:           ${rows.length}`);
console.log(`Opened with this key:       ${opened}`);
console.log(`Last four agree:            ${last4Matches}`);
console.log(`Fingerprint agrees:         ${fingerprintMatches}`);
const ok = rows.length > 0 && opened === rows.length && last4Matches === rows.length && fingerprintMatches === rows.length;
console.log(ok ? '\nOK: this key opens every stored payee detail.' : '\nPROBLEM: this key does not match what is stored. Do not rely on it; tell the team.');
process.exit(ok ? 0 : 1);
