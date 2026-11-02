// Turns the beneficiary / account list (rows read from a Google Sheet) into parties and unverified payee accounts
// (docs/finance/sessions/04-parties-and-payees.md). Pure: the operator script scripts/import-fin-parties.mjs reads the
// sheet (shared with the service account; its id is passed in, never stored here), calls these, and writes through the same encrypting code the directory uses.
//
// Input is the sheet's rows as arrays of cell text (one row per party/account; row 0 is the header). Headers are matched loosely (case, spaces
// and punctuation ignored): a name column is required; kind, account number, IFSC, UPI id and farm unit are optional.
// Nothing here is a real value; the summary it produces holds counts and line numbers only, so it can be printed or
// pasted without exposing a name or a number.
import { PARTY_KINDS, validatePayeeDetails } from './finance-parties.mjs';

const HEADERS = {
  name: ['name', 'beneficiaryname', 'payeename', 'payee', 'party', 'partyname', 'accountholder'],
  kind: ['kind', 'type', 'partytype', 'category'],
  account: ['account', 'accountno', 'accountnumber', 'acno', 'beneficiaryaccount', 'beneficiaryaccountnumber'],
  ifsc: ['ifsc', 'ifsccode'],
  upi: ['upi', 'upiid', 'vpa'],
  farmUnit: ['farmunit', 'unit', 'plot', 'farm'],
};
const squashHeader = (h) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

export function normalizeFarmUnit(value) {
  const m = /^F-?(\d{1,2})$/i.exec(String(value ?? '').trim());
  return m ? `F-${m[1].padStart(2, '0')}` : null;
}

// rows[0] is the header. Returns { records, problems }; a record keeps its 1-based file line for reporting.
export function readBeneficiaries(rows) {
  if (!rows.length) return { records: [], problems: ['The file is empty.'] };
  const header = rows[0].map(squashHeader);
  const at = Object.fromEntries(Object.entries(HEADERS).map(([field, names]) => [field, header.findIndex((h) => names.includes(h))]));
  if (at.name < 0) return { records: [], problems: ['No name column found (expected a header such as "Beneficiary Name" or "Name").'] };
  const cell = (r, field) => (at[field] >= 0 ? (r[at[field]] ?? '').trim() : '');
  const records = rows.slice(1).map((r, i) => ({
    line: i + 2,
    name: cell(r, 'name').replace(/\s+/g, ' '),
    kind: cell(r, 'kind').toLowerCase() || null,
    farmUnit: cell(r, 'farmUnit') || null,
    account: cell(r, 'account'),
    ifsc: cell(r, 'ifsc'),
    upi: cell(r, 'upi'),
  }));
  return { records: records.filter((r) => r.name), problems: [] };
}

const KIND_WORDS = {
  member: 'member', owner: 'member', resident: 'member',
  vendor: 'vendor', supplier: 'vendor', shop: 'vendor', contractor: 'vendor',
  employee: 'employee', staff: 'employee', worker: 'employee',
  customer: 'customer', guest: 'customer',
  bank: 'bank',
  government: 'government', govt: 'government', tax: 'government',
  director: 'director',
  other: 'other',
};

const partyKey = (name, kind) => `${name.toLowerCase()}|${kind}`;

// What goes into the shared-account check and the stored fingerprint: the account number alone (an IFSC difference
// should not hide a shared account) or the UPI id.
export const fingerprintText = (details) => (details.method === 'bank' ? details.account : details.upi);

// `households`: Map(farm_unit -> household id). `existing`: [{ id, name, kind, fingerprints }] already in the
// directory. `fingerprint`: a keyed hash of fingerprintText(), the same one the directory stores.
// Returns the plan: parties to create (with their accounts), accounts to add to existing parties, how many rows were
// already there, and anomalies for the operator to review. The plan itself holds real details in memory; use
// summarizeImport() for anything printed.
export function planImport(records, { households, existing, fingerprint }) {
  const anomalies = [];
  const existingByKey = new Map(existing.map((p) => [partyKey(p.name, p.kind), p]));
  const parties = new Map();
  const addToExisting = new Map();
  let unchanged = 0;
  const seenFingerprints = new Map(); // fingerprint -> { keys:Set, lines:Set }

  for (const rec of records) {
    let kind = rec.kind ? KIND_WORDS[rec.kind] : rec.farmUnit ? 'member' : 'other';
    if (!kind) {
      anomalies.push({ kind: 'unknown_kind', line: rec.line });
      kind = 'other';
    }
    if (!PARTY_KINDS.includes(kind)) kind = 'other';

    let householdId = null;
    if (kind === 'member') {
      const unit = normalizeFarmUnit(rec.farmUnit);
      if (!rec.farmUnit) anomalies.push({ kind: 'member_without_unit', line: rec.line });
      else if (!unit || !households.has(unit)) anomalies.push({ kind: 'unknown_farm_unit', line: rec.line });
      else householdId = households.get(unit);
    }

    const key = partyKey(rec.name, kind);
    const known = existingByKey.get(key);
    let party = parties.get(key);
    if (!known && !party) {
      party = { key, name: rec.name, kind, householdId, accounts: [] };
      parties.set(key, party);
    }

    const entered = [];
    if (rec.account || rec.ifsc) entered.push({ method: 'bank', account: rec.account, ifsc: rec.ifsc });
    if (rec.upi) entered.push({ method: 'upi', upi: rec.upi });
    for (const input of entered) {
      const checked = validatePayeeDetails(input);
      if (checked.error) {
        anomalies.push({ kind: 'bad_details', line: rec.line });
        continue;
      }
      const fp = fingerprint(fingerprintText(checked.details));
      const seen = seenFingerprints.get(fp) ?? { keys: new Set(), lines: new Set() };
      seen.keys.add(key);
      seen.lines.add(rec.line);
      seenFingerprints.set(fp, seen);

      const account = { details: checked.details, last4: checked.last4, fingerprint: fp, line: rec.line };
      if (known) {
        if (known.fingerprints.includes(fp) || addToExisting.get(known.id)?.some((a) => a.fingerprint === fp)) unchanged++;
        else addToExisting.set(known.id, [...(addToExisting.get(known.id) ?? []), account]);
      } else if (party.accounts.some((a) => a.fingerprint === fp)) unchanged++;
      else party.accounts.push(account);
    }
  }

  // Existing accounts count towards "shared" too, but only when this file touches the same account.
  for (const p of existing) for (const fp of p.fingerprints) seenFingerprints.get(fp)?.keys.add(partyKey(p.name, p.kind));
  for (const { keys, lines } of seenFingerprints.values()) {
    if (keys.size > 1) anomalies.push({ kind: 'shared_account', lines: [...lines].sort((a, b) => a - b) });
  }

  return {
    parties: [...parties.values()],
    addToExisting: [...addToExisting].flatMap(([partyId, accounts]) => accounts.map((account) => ({ partyId, account }))),
    unchanged,
    anomalies,
  };
}

// Safe to print: counts and line numbers, never a name, number or UPI id.
export function summarizeImport(plan) {
  const byKind = {};
  for (const a of plan.anomalies) byKind[a.kind] = (byKind[a.kind] ?? 0) + 1;
  return {
    newParties: plan.parties.length,
    newAccounts: plan.parties.reduce((n, p) => n + p.accounts.length, 0),
    accountsForExistingParties: plan.addToExisting.length,
    unchanged: plan.unchanged,
    anomalies: byKind,
    anomalyLines: plan.anomalies.map((a) => ({ kind: a.kind, ...(a.line ? { line: a.line } : { lines: a.lines }) })),
  };
}
