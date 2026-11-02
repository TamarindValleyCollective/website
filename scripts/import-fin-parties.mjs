// Operator script: loads the existing beneficiary / account list from a Google Sheet into the finance directory
// (fin_parties, fin_party_accounts; docs/finance/sessions/04-parties-and-payees.md).
//
//   node scripts/import-fin-parties.mjs --source <sheetId>::<range> [--source ...]           # dry run (default)
//   node scripts/import-fin-parties.mjs --source <sheetId>::<range> [--source ...] --apply   # write
//
// Each --source is a spreadsheet id and a range, e.g. --source abc123::"'Registered'!A:F". The existing payees are
// spread over several partial lists, so give them all: records are merged by account number (the first source's name
// wins; blanks such as the IFSC are filled from later ones). --sheet-id/--range remain as shorthand for one source.
//
// The sheet's id and range are passed in (or FIN_PARTIES_SHEET_ID / FIN_PARTIES_RANGE), never kept in this public repo,
// and the sheet must be shared with the Drive service account (GDRIVE_SERVICE_ACCOUNT_EMAIL / _PRIVATE_KEY, as for
// scripts/export-member-sheet.mjs). Row 0 is the header; "Name" is required, and Kind, Account Number, IFSC, UPI id and
// Farm Unit are used when present (see scripts/lib/finance-party-import.mjs).
//
// Everything lands UNVERIFIED with no creator, so a director must verify each payee in the app before it can be paid.
// The dry run and the apply summary print counts and line numbers only: never a name, account number or UPI id. Re-running
// is safe: parties are matched on name + kind and accounts on their keyed fingerprint, so nothing is added twice.
//
// --apply needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and STAFF_MFA_KEY (the payee encryption key), and migration
// 0079 applied. Needs Node 22.18+ (it imports the TypeScript crypto helper directly).
import { getSheetValues } from './lib/google-drive.mjs';
import { readBeneficiaries, mergeSources, planImport, summarizeImport } from './lib/finance-party-import.mjs';
import { restHeaders } from './lib/supabase.mjs';
import { encryptFinanceText, fingerprintFinanceText } from '../netlify/functions/lib/staff-mfa-crypto.ts';

const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const sources = args
  .flatMap((a, i) => (a === '--source' ? [args[i + 1] ?? ''] : []))
  .map((s) => {
    const at = s.indexOf('::');
    return at > 0 ? { sheetId: s.slice(0, at), range: s.slice(at + 2) } : null;
  });
const single = arg('--sheet-id') ?? process.env.FIN_PARTIES_SHEET_ID;
const singleRange = arg('--range') ?? process.env.FIN_PARTIES_RANGE;
if (single && singleRange) sources.push({ sheetId: single, range: singleRange });
const apply = args.includes('--apply');
if (!sources.length || sources.includes(null)) {
  console.error('Usage: node scripts/import-fin-parties.mjs --source <sheetId>::<range> [--source ...] [--apply]');
  process.exit(2);
}

async function rest(path, init = {}) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1${path}`, { ...init, headers: restHeaders(init.headers) });
  if (!res.ok) throw new Error(`Supabase ${init.method ?? 'GET'} ${path.split('?')[0]} failed: ${res.status}`);
  return res;
}

const lists = [];
for (const [i, { sheetId, range }] of sources.entries()) {
  const read = readBeneficiaries(await getSheetValues(sheetId, range));
  if (read.problems.length) {
    console.error(`Source ${i + 1}: ${read.problems.join(' ')}`);
    process.exit(1);
  }
  lists.push(read.records);
}
const { records, stats } = mergeSources(lists);
console.log(`Read ${stats.records} rows from ${stats.sources} source(s); ${stats.merged} matched an earlier source by account number (${stats.nameDiffers} under a different name).`);

// Keys are needed even for the dry run: the shared-account check compares fingerprints.
if (!process.env.STAFF_MFA_KEY) {
  console.error('Set STAFF_MFA_KEY (the payee encryption key) so accounts can be fingerprinted.');
  process.exit(2);
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY so existing parties can be recognised.');
  process.exit(2);
}

const households = new Map(((await (await rest('/member_households?select=id,farm_unit')).json())).map((h) => [h.farm_unit, h.id]));
const existingParties = await (await rest('/fin_parties?select=id,name,kind')).json();
const existingAccounts = await (await rest('/fin_party_accounts?select=party_id,fingerprint&status=neq.superseded')).json();
const existing = existingParties.map((p) => ({ ...p, fingerprints: existingAccounts.filter((a) => a.party_id === p.id).map((a) => a.fingerprint) }));

const plan = planImport(records, { households, existing, fingerprint: fingerprintFinanceText });
console.log(JSON.stringify(summarizeImport(plan), null, 2));

if (!apply) {
  console.log('\nDry run: nothing written. Add --apply to write.');
  process.exit(0);
}

const entity = (await (await rest('/fin_entities?select=id&order=created_at.asc&limit=1')).json())[0]?.id;
if (!entity) throw new Error('No finance entity found; is migration 0077 applied?');

const insertAccount = (partyId, account) =>
  rest('/fin_party_accounts', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      entity_id: entity,
      party_id: partyId,
      method: account.details.method,
      details_enc: encryptFinanceText(JSON.stringify(account.details)),
      last4: account.last4,
      fingerprint: account.fingerprint,
    }),
  });

let partiesWritten = 0;
let accountsWritten = 0;
let failed = 0;
for (const party of plan.parties) {
  try {
    const res = await rest('/fin_parties', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ entity_id: entity, kind: party.kind, name: party.name, household_id: party.householdId }),
    });
    const [created] = await res.json();
    partiesWritten++;
    for (const account of party.accounts) {
      await insertAccount(created.id, account);
      accountsWritten++;
    }
  } catch {
    failed++; // e.g. a second party for a household that already has one; counted, never named
  }
}
for (const { partyId, account } of plan.addToExisting) {
  try {
    await insertAccount(partyId, account);
    accountsWritten++;
  } catch {
    failed++;
  }
}

// actor_id stays null: the operator script has no signed-in person.
await rest('/fin_audit_log', {
  method: 'POST',
  headers: { Prefer: 'return=minimal' },
  body: JSON.stringify({ entity_id: entity, action: 'finance.parties_imported', detail: { parties: partiesWritten, accounts: accountsWritten, failed, anomalies: plan.anomalies.length } }),
});
console.log(`\nWrote ${partiesWritten} parties and ${accountsWritten} accounts (all unverified); ${failed} failed.`);
