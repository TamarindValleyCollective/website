// The Finance Overview's "Needs you" summary (docs/finance/FINANCE.md): what is waiting for a person, as counts and labels
// only. Pure and I/O-free so it is tested directly (finance-attention.test.mjs); finance-admin.mts reads the rows and
// calls it. It holds no names, account numbers or fingerprints, so the summary is safe to show to anyone who can view.
import { foldMerged, reviewFlags, sharedAccountFlags } from './finance-parties.mjs';

const none = { count: 0, totalPaise: 0 };

// parties/accounts: every fin_parties / fin_party_accounts row. coverage and reconciliation: heldCoverage() and
// reconciliationOf() from the statement import. batches: import batches (created_at). today: YYYY-MM-DD in India.
export function attentionOf({ parties, accounts, coverage, reconciliation, batches, bankAccountCount = 0, today }) {
  const { visible, accountsOf, canonicalOf } = foldMerged(parties, accounts);
  const shared = sharedAccountFlags(accounts, canonicalOf);
  let toVerify = 0;
  let needsReview = 0;
  for (const party of visible) {
    const rows = accountsOf(party.id);
    const live = rows.filter((a) => a.status !== 'superseded' && !(a.retired_on && a.retired_on <= today));
    if (live.some((a) => a.status === 'unverified')) toVerify++;
    if ([...reviewFlags(rows, shared, today).values()].some((reasons) => reasons.length > 0)) needsReview++;
  }
  const newest = (batches ?? []).map((b) => b.created_at).filter(Boolean).sort().at(-1) ?? null;
  return {
    parties: visible.length,
    merged: parties.filter((p) => p.merged_into).length,
    toVerify,
    needsReview,
    statementGaps: (coverage ?? []).flatMap((c) => c.gaps.map((g) => ({ label: c.label, from: g.from, to: g.to }))),
    paytmWaiting: reconciliation?.awaitingBank ?? none,
    paytmToCheck: reconciliation?.unmatchedInStatement ?? none,
    lastImportAt: newest,
    bankAccounts: bankAccountCount,
  };
}
