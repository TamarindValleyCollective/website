// Operator script: copies the IFSC out of each bank payee account's encrypted details into the plain `ifsc` column (migration 0111).
//
//   netlify dev:exec -- node scripts/backfill-fin-ifsc.mjs            (dry run: counts only, writes nothing)
//   netlify dev:exec -- node scripts/backfill-fin-ifsc.mjs --apply    (writes, through fin_backfill_party_account_ifsc)
//
// It needs the payee key in the shell (FINANCE_PAYEE_KEY, or STAFF_MFA_KEY if that is what the key is stored as), because the IFSC is read by
// decrypting details_enc: Netlify keeps that secret unreadable, so paste it from Bitwarden first (for example `read -s FINANCE_PAYEE_KEY;
// export FINANCE_PAYEE_KEY`). `netlify dev:exec` injects SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. It prints COUNTS ONLY: never an IFSC,
// an account number or an id. Only bank rows whose ifsc is still empty are touched, only an empty ifsc is ever filled (the database refuses
// anything else), and running it twice changes nothing the second time. Needs Node 22.18+ (it imports the TypeScript crypto helper).
import { restHeaders } from './lib/supabase.mjs';
import { decryptFinanceText } from '../netlify/functions/lib/staff-mfa-crypto.ts';

const apply = process.argv.includes('--apply');
if (!process.env.FINANCE_PAYEE_KEY && !process.env.STAFF_MFA_KEY) {
  console.error('Set FINANCE_PAYEE_KEY (the payee encryption key) first.');
  process.exit(2);
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are missing: run this through `netlify dev:exec --`.');
  process.exit(2);
}

const base = `${process.env.SUPABASE_URL}/rest/v1`;
const read = await fetch(`${base}/fin_party_accounts?method=eq.bank&ifsc=is.null&select=id,details_enc&order=created_at.asc&limit=5000`, { headers: restHeaders() });
if (!read.ok) {
  console.error(`Could not read fin_party_accounts (${read.status}). Has migration 0111 been applied?`);
  process.exit(2);
}
const rows = await read.json();

const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ids = [];
const ifscs = [];
let noIfsc = 0;
let cannotOpen = 0;
for (const row of rows) {
  try {
    const raw = JSON.parse(decryptFinanceText(row.details_enc)).ifsc;
    const ifsc = typeof raw === 'string' ? raw.replace(/\s+/g, '').toUpperCase() : '';
    if (IFSC.test(ifsc)) {
      ids.push(row.id);
      ifscs.push(ifsc);
    } else {
      noIfsc++;
    }
  } catch {
    cannotOpen++; // the reason is deliberately not printed
  }
}

console.log(`Bank accounts with no plain IFSC yet: ${rows.length}`);
console.log(`  IFSC found in the encrypted details: ${ids.length}`);
console.log(`  no IFSC in the details:              ${noIfsc}`);
console.log(`  could not be opened with this key:   ${cannotOpen}`);
if (cannotOpen) {
  console.error('\nSome rows could not be opened: this key is not the one the data was encrypted with. Nothing was written.');
  process.exit(1);
}
if (!apply) {
  console.log('\nDry run: nothing written. Add --apply to fill the column.');
  process.exit(0);
}

let changed = 0;
for (let i = 0; i < ids.length; i += 200) {
  const res = await fetch(`${base}/rpc/fin_backfill_party_account_ifsc`, {
    method: 'POST',
    headers: { ...restHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ p_ids: ids.slice(i, i + 200), p_ifscs: ifscs.slice(i, i + 200) }),
  });
  if (!res.ok) {
    console.error(`The write failed at row ${i} (${res.status}). Rows before it were saved; run again to finish.`);
    process.exit(1);
  }
  changed += Number(await res.json());
}
console.log(`\nFilled ${changed} rows.`);
