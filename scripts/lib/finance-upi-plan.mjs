// Step 2 of the Paytm UPI import, and the joining of UPI rows to bank lines. Pure functions: no database, no file.
//
//  * planUpiImport: which parsed rows to keep, which to ignore (not our account) and which failed. Only rows whose
//    account label is a registered bank account's `upi_label` are kept; the rest (another bank, a credit card) are
//    ignored but COUNTED with their total, never silently dropped. An ignored row with a reference is stored flagged
//    `ignored` so the same row is not counted twice; one with no reference is only counted.
//  * linkUpiToBank: UPI row <-> bank line by the 12-digit reference. Linked only if the amount and direction agree;
//    a disagreement is reported, and an ambiguous reference (two bank lines) links nothing.
//  * reconciliationSummary: what is still unlinked and why. A payment after the last bank line is simply awaiting
//    the next statement; one inside the statement is unmatched; and a bank UPI debit older than the first UPI row
//    (the company account joined Paytm late) is expected to have no UPI row, forever, and is said so.
import { tagMatches } from './finance-paytm.mjs';

const labelKey = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

export function planUpiImport({ file, accounts, circleTag, held }) {
  const { parsed } = file;
  const result = {
    id: file.id, fileHash: file.fileHash, status: 'ok',
    period: { from: parsed.from, to: parsed.to },
    counts: { total: parsed.lines.length + parsed.failed.length, new: 0, alreadyHeld: 0, ignored: 0, failed: 0 },
    ignored: { count: 0, totalPaise: 0, byAccount: [] },
    failed: [...parsed.failed], newLines: [], firstDate: null, lastDate: null,
  };
  if (held.fileHashes.includes(file.fileHash)) {
    result.status = 'duplicate_file';
    return result;
  }
  const byLabel = new Map(accounts.map((a) => [labelKey(a.upiLabel), a]));
  const heldRefs = new Set(held.refs);
  const seen = new Set();
  const groups = new Map();

  for (const l of parsed.lines) {
    const account = byLabel.get(labelKey(l.accountLabel));
    if (!account) {
      result.ignored.count += 1;
      result.ignored.totalPaise += l.amountPaise;
      const g = groups.get(labelKey(l.accountLabel)) ?? { label: l.accountLabel, count: 0, totalPaise: 0 };
      g.count += 1;
      g.totalPaise += l.amountPaise;
      groups.set(labelKey(l.accountLabel), g);
      if (l.upiRef && !heldRefs.has(l.upiRef) && !seen.has(l.upiRef)) {
        seen.add(l.upiRef);
        result.newLines.push({ ...l, accountId: null, ignored: true, ignoredReason: 'account_not_registered', isCircle: false });
      }
      continue;
    }
    if (!l.upiRef) {
      result.failed.push({ row: l.row, reason: 'This row is on a registered account but has no UPI reference, so it cannot be joined to the bank statement.' });
      continue;
    }
    if (heldRefs.has(l.upiRef) || seen.has(l.upiRef)) {
      result.counts.alreadyHeld += 1;
      continue;
    }
    seen.add(l.upiRef);
    result.newLines.push({ ...l, accountId: account.id, ignored: false, ignoredReason: null, isCircle: l.direction === 'debit' && tagMatches(l.tag, circleTag) });
  }

  result.ignored.byAccount = [...groups.values()];
  result.counts.ignored = result.ignored.count;
  result.counts.failed = result.failed.length;
  result.counts.new = result.newLines.filter((l) => !l.ignored).length;
  const dates = parsed.lines.map((l) => l.paidAt).sort();
  result.firstDate = dates[0] ?? null;
  result.lastDate = dates[dates.length - 1] ?? null;
  return result;
}

export function linkUpiToBank({ upiLines, bankLines }) {
  const byRrn = new Map();
  for (const b of bankLines) {
    if (!b.upiRrn) continue;
    byRrn.set(b.upiRrn, [...(byRrn.get(b.upiRrn) ?? []), b]);
  }
  const out = { links: [], mismatches: [], ambiguous: [], awaiting: [] };
  for (const u of upiLines) {
    const candidates = byRrn.get(u.upiRef);
    if (!candidates) out.awaiting.push(u.id);
    else if (candidates.length > 1) out.ambiguous.push({ upiId: u.id, bankIds: candidates.map((c) => c.id) });
    else if (candidates[0].amountPaise !== u.amountPaise) out.mismatches.push({ upiId: u.id, bankId: candidates[0].id, reason: 'amount' });
    else if (candidates[0].direction !== u.direction) out.mismatches.push({ upiId: u.id, bankId: candidates[0].id, reason: 'direction' });
    else out.links.push({ upiId: u.id, bankId: candidates[0].id });
  }
  return out;
}

export function reconciliationSummary({ upiLines, bankLines, lastBankDate, firstUpiDate }) {
  const awaitingBank = { count: 0, totalPaise: 0 };
  const unmatchedInStatement = { count: 0, totalPaise: 0 };
  for (const u of upiLines) {
    if (u.bankLineId) continue;
    const bucket = !lastBankDate || u.paidAt >= lastBankDate ? awaitingBank : unmatchedInStatement;
    bucket.count += 1;
    bucket.totalPaise += u.amountPaise;
  }
  const bankWithoutUpi = { predatesExport: 0, inExportPeriod: 0 };
  for (const b of bankLines) {
    if (!b.upiRrn || b.linked) continue;
    if (!firstUpiDate || b.tranDate < firstUpiDate) bankWithoutUpi.predatesExport += 1;
    else bankWithoutUpi.inExportPeriod += 1;
  }
  return { awaitingBank, unmatchedInStatement, bankWithoutUpi };
}
