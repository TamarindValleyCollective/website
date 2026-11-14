// Reads the transfer-request sheet and adds what is new to payment requests and spend logs. Shared by the operator script
// (scripts/load-fin-requests-history.mjs) and the daily Netlify function (netlify/functions/finance-requests-sheet-sync.mts), so
// both do exactly the same thing. Insert-only and idempotent: a row already loaded (same reference, or same date, amount, name and
// purpose) is skipped, so running it any number of times adds only what appeared since. A row edited after it was loaded is NOT
// updated. Returns COUNTS only: never a name, purpose, reference or amount.
import { getSheetValues } from './google-drive.mjs';
import { restHeaders } from './supabase.mjs';
import { fingerprintText } from './finance-party-import.mjs';
import { parseCircleTab, parseTransferTab, planHistory } from './finance-requests-history.mjs';
import { fingerprintFinanceText } from '../../netlify/functions/lib/staff-mfa-crypto.ts';

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

/**
 * @param {{ sheetId: string, apply: boolean, transferTab?: string, circleTab?: string, auditAction?: string }} opts
 * @returns counts: { transfer, circle, toInsert, requests, logs, duplicates, noName, linkedByAccount, linkedByName, nameKept, fingerprintsOn, written }
 */
export async function syncRequestsSheet({ sheetId, apply, transferTab = 'Fund Transfer Request', circleTab = 'UPI Circle Transactions', auditAction = 'finance.requests_history_loaded' }) {
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
  // Without the payee key (FINANCE_PAYEE_KEY / STAFF_MFA_KEY) accounts cannot be fingerprinted: linking falls back to names only.
  let fingerprintsOn = true;
  const partyOf = (r) => {
    if (r.account && fingerprintsOn) {
      try {
        const hit = byFingerprint.get(fingerprintFinanceText(fingerprintText({ method: 'bank', account: r.account, ifsc: r.ifsc })));
        if (hit) return (linkedByAccount += 1), hit;
      } catch (err) {
        if (!String(err?.message).includes('STAFF_MFA_KEY')) throw err;
        fingerprintsOn = false;
      }
    }
    const names = r.name ? byName.get(r.name.toLowerCase()) : undefined;
    if (names?.length === 1) return (linkedByName += 1), names[0];
    return null;
  };

  // Rows without a reference cannot be told apart from rows edited since loading (a corrected date or amount looks new), so only rows
  // dated within a week of the latest loaded one are considered. Rows with a reference are matched exactly and need no cutoff.
  const latest = existing.map((e) => e.paid_on).sort().at(-1);
  const cutoff = latest ? new Date(new Date(`${latest}T00:00:00Z`).getTime() - 7 * 86_400_000).toISOString().slice(0, 10) : '';
  const considered = [...transfer.records, ...circle.records].filter((r) => r.upiRef || r.date >= cutoff);

  const plan = planHistory(considered, {
    entityId: entities[0].id,
    partyOf,
    existing: existing.map((e) => ({ upiRef: e.upi_ref, paidOn: e.paid_on, amountPaise: Number(e.amount_paise), label: e.party_id ? nameOf.get(e.party_id) ?? '' : e.recipient_text ?? '', purpose: e.purpose })),
  });

  const result = {
    transfer: { rows: Math.max(transferRows.length - 1, 0), readable: transfer.records.length, skipped: transfer.skipped },
    circle: { rows: Math.max(circleRows.length - 1, 0), readable: circle.records.length, skipped: circle.skipped },
    toInsert: plan.insert.length,
    requests: plan.insert.filter((r) => r.kind === 'request').length,
    logs: plan.insert.filter((r) => r.kind === 'log').length,
    duplicates: plan.duplicates,
    noName: plan.noName,
    linkedByAccount,
    linkedByName,
    linked: plan.insert.filter((r) => r.party_id).length,
    nameKept: plan.insert.filter((r) => !r.party_id).length,
    fingerprintsOn,
    written: 0,
  };
  if (!apply) return result;

  for (let i = 0; i < plan.insert.length; i += 100) {
    const batch = plan.insert.slice(i, i + 100);
    const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/fin_payment_requests`, { method: 'POST', headers: restHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(batch) });
    if (!res.ok) throw Object.assign(new Error(`Batch starting at ${i} failed (${res.status}); ${result.written} written so far. Running again is safe.`), { result });
    result.written += batch.length;
  }
  // Only runs that changed something are audited, so a quiet daily run leaves no noise.
  if (result.written > 0) {
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/fin_audit_log`, { method: 'POST', headers: restHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify({ action: auditAction, entity_id: entities[0].id, detail: { inserted: result.written } }) });
  }
  return result;
}
