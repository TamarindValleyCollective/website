// Operator script: loads the old transfer-request sheet into payment requests and spend logs, once
// (docs/finance/sessions/08-payment-requests-and-bills.md, decision 4; migration 0092). The two tabs become already-paid historical
// records (source "history"): the NEFT-style tab as requests, the UPI Circle tab as logs. The UPI page and the ledger then pull their
// purposes from here; nothing is read from the sheet at run time.
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
import { getSheetValues } from './lib/google-drive.mjs';
import { restHeaders } from './lib/supabase.mjs';
import { fingerprintText } from './lib/finance-party-import.mjs';
import { parseCircleTab, parseTransferTab, planHistory } from './lib/finance-requests-history.mjs';
import { fingerprintFinanceText } from '../netlify/functions/lib/staff-mfa-crypto.ts';

const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const sheetId = arg('--sheet') ?? process.env.FIN_REQUESTS_SHEET_ID;
const transferTab = arg('--transfer-tab') ?? 'Fund Transfer Request';
const circleTab = arg('--circle-tab') ?? 'UPI Circle Transactions';
const apply = args.includes('--apply');
if (!sheetId) {
  console.error('Usage: netlify dev:exec -- node scripts/load-fin-requests-history.mjs --sheet <spreadsheetId> [--apply]');
  process.exit(2);
}

async function pages(path) {
  const all = [];
  for (let offset = 0; ; offset += 1000) {
    const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1${path}&limit=1000&offset=${offset}`, { headers: restHeaders() });
    if (!res.ok) throw new Error(`Supabase GET ${path.split('?')[0]} failed: ${res.status}`);
    const page = await res.json();
    all.push(...page);
    if (page.length < 1000) return all;
  }
}

const [transferRows, circleRows, accounts, entities, parties, partyAccounts, existing] = await Promise.all([
  getSheetValues(sheetId, `'${transferTab}'!A:Z`),
  getSheetValues(sheetId, `'${circleTab}'!A:Z`),
  pages('/fin_bank_accounts?select=last4&kind=eq.bank&order=id.asc'),
  pages('/fin_entities?select=id&order=created_at.asc'),
  pages('/fin_parties?select=id,name,active,merged_into&order=id.asc'),
  pages('/fin_party_accounts?select=party_id,fingerprint&order=id.asc'),
  pages('/fin_payment_requests?select=upi_ref,paid_on,amount_paise,party_id,recipient_text,purpose&source=eq.history&order=id.asc'),
]);
if (!entities[0]) throw new Error('no entity');

const ownLast4 = accounts.map((a) => a.last4).filter(Boolean);
const transfer = parseTransferTab(transferRows);
const circle = parseCircleTab(circleRows, { ownLast4 });

// A saved party for a row: the account number's fingerprint, else a name that belongs to exactly one live party.
const byFingerprint = new Map(partyAccounts.map((a) => [a.fingerprint, a.party_id]));
const live = parties.filter((p) => p.active && !p.merged_into);
const byName = new Map();
for (const p of live) byName.set(p.name.toLowerCase(), [...(byName.get(p.name.toLowerCase()) ?? []), p.id]);
const nameOf = new Map(parties.map((p) => [p.id, p.name]));
let linkedByAccount = 0;
let linkedByName = 0;
const partyOf = (r) => {
  if (r.account) {
    const hit = byFingerprint.get(fingerprintFinanceText(fingerprintText({ method: 'bank', account: r.account, ifsc: r.ifsc })));
    if (hit) return (linkedByAccount += 1), hit;
  }
  const names = r.name ? byName.get(r.name.toLowerCase()) : undefined;
  if (names?.length === 1) return (linkedByName += 1), names[0];
  return null;
};

const plan = planHistory([...transfer.records, ...circle.records], {
  entityId: entities[0].id,
  partyOf,
  existing: existing.map((e) => ({ upiRef: e.upi_ref, paidOn: e.paid_on, amountPaise: Number(e.amount_paise), label: e.party_id ? nameOf.get(e.party_id) ?? '' : e.recipient_text ?? '', purpose: e.purpose })),
});

const count = (rows, f) => rows.filter(f).length;
console.log(`${apply ? 'APPLY' : 'DRY RUN'}`);
console.log(`transfer tab: ${transferRows.length > 0 ? transferRows.length - 1 : 0} rows, ${transfer.records.length} readable; skipped`, JSON.stringify(transfer.skipped));
console.log(`circle tab:   ${circleRows.length > 0 ? circleRows.length - 1 : 0} rows, ${circle.records.length} readable; skipped`, JSON.stringify(circle.skipped));
console.log(`to insert: ${plan.insert.length} (${count(plan.insert, (r) => r.kind === 'request')} requests, ${count(plan.insert, (r) => r.kind === 'log')} logs); already loaded or repeated: ${plan.duplicates}; no name: ${plan.noName}`);
console.log(`linked to a saved party: ${count(plan.insert, (r) => r.party_id)} (${linkedByAccount} by account, ${linkedByName} by name); name kept as typed: ${count(plan.insert, (r) => !r.party_id)}`);

if (!apply) {
  console.log('Nothing written. Add --apply to write.');
  process.exit(0);
}
let written = 0;
for (let i = 0; i < plan.insert.length; i += 100) {
  const batch = plan.insert.slice(i, i + 100);
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/fin_payment_requests`, { method: 'POST', headers: restHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(batch) });
  if (!res.ok) {
    console.error(`Batch starting at ${i} failed (${res.status}); ${written} written so far. Running again is safe.`);
    process.exit(1);
  }
  written += batch.length;
}
await fetch(`${process.env.SUPABASE_URL}/rest/v1/fin_audit_log`, { method: 'POST', headers: restHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify({ action: 'finance.requests_history_loaded', entity_id: entities[0].id, detail: { inserted: written } }) });
console.log(`Wrote ${written}.`);
