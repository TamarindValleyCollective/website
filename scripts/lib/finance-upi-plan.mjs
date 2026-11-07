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
    failed: [...parsed.failed], errors: [], newLines: [], firstDate: null, lastDate: null,
  };
  if (held.fileHashes.includes(file.fileHash)) {
    result.status = 'duplicate_file';
    return result;
  }
  const byLabel = new Map(accounts.filter((a) => a.upiLabel).map((a) => [labelKey(a.upiLabel), a]));
  // If no row is on a registered account, the file is almost certainly being imported before the account (or its Paytm
  // label) was set up, and storing it would record every row as "not ours" for good. Refuse; nothing is stored.
  if (parsed.lines.length > 0 && !parsed.lines.some((l) => byLabel.has(labelKey(l.accountLabel)))) {
    result.status = 'blocked';
    result.errors = [{ type: 'no_registered_rows', labelsInFile: [...new Set(parsed.lines.map((l) => l.accountLabel))] }];
    return result;
  }
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

// Is a BHIM row a UPI Circle (delegated) payment? The export has no tag (Paytm's circle signal), so this is a reading of two
// columns, checked against the bank statement: a row paid through the circle names no bank and is marked CR, and every such row
// was a bank DEBIT. A row that names the bank is DR (a payment out, bank debits) or CR (money coming IN, bank credits).
export const bhimIsCircle = (l) => l.bankName === null && l.drcr === 'CR';

// The direction of the money on the account: a delegated payment (no bank named) is always out; a row that names the bank says so
// itself, DR out and CR in. DR/CR alone is not the direction: "no bank, CR" is a payment out.
export const bhimDirection = (l) => (l.bankName !== null && l.drcr === 'CR' ? 'credit' : 'debit');

// Plan a BHIM import (a parsed finance-bhim.mjs statement). Same result shape as planUpiImport, so the import page
// reads both. A row that names its account ("XXXX000099") is placed on the registered account with those last four
// digits. A row that names none (a UPI Circle payment) is stored with NO account: a UPI app can pay from any linked bank,
// so the file cannot say, and the account is read from the bank line the row is joined to by reference (the bank line
// always carries its account). A row naming a bank account that is not registered (a personal account) is left out and
// counted, never stored; only when the rows that name an account name none that is registered is the file blocked (add the account first), so a
// payment is never put on a wrong account.
export function planBhimImport({ file, accounts, held }) {
  const { parsed } = file;
  const result = {
    id: file.id, fileHash: file.fileHash, status: 'ok', app: 'bhim',
    period: { from: parsed.from, to: parsed.to },
    counts: { total: parsed.lines.length + parsed.failed.length + parsed.unsuccessful.count, new: 0, alreadyHeld: 0, ignored: 0, failed: 0, unsuccessful: parsed.unsuccessful.count },
    unsuccessful: parsed.unsuccessful,
    ignored: { count: 0, totalPaise: 0, byAccount: [] },
    failed: [...parsed.failed], errors: [], newLines: [], firstDate: null, lastDate: null,
  };
  if (held.fileHashes.includes(file.fileHash)) {
    result.status = 'duplicate_file';
    return result;
  }
  const byLast4 = new Map(accounts.filter((a) => a.last4).map((a) => [a.last4, a]));
  const isOurs = (l) => !l.accountLast4 || byLast4.has(l.accountLast4);
  // A file whose rows name accounts, none of them registered, belongs to an account that has not been added yet.
  const named = parsed.lines.filter((l) => l.accountLast4);
  if (named.length > 0 && !named.some((l) => byLast4.has(l.accountLast4))) {
    result.status = 'blocked';
    result.errors = [{ type: 'account_not_registered', last4: [...new Set(named.map((l) => l.accountLast4))] }];
    return result;
  }
  const leftOut = new Map();

  const seen = new Set();
  const heldRefs = new Set(held.refs);
  for (const l of parsed.lines) {
    if (!isOurs(l)) {
      const label = `${l.bankName ?? 'Bank'} ••${l.accountLast4}`;
      const g = leftOut.get(label) ?? { label, count: 0, totalPaise: 0 };
      g.count += 1;
      g.totalPaise += l.amountPaise;
      leftOut.set(label, g);
      result.ignored.count += 1;
      result.ignored.totalPaise += l.amountPaise;
      continue;
    }
    if (heldRefs.has(l.upiRef) || seen.has(l.upiRef)) {
      result.counts.alreadyHeld += 1;
      continue;
    }
    seen.add(l.upiRef);
    const account = l.accountLast4 ? byLast4.get(l.accountLast4) : null;
    result.newLines.push({
      row: l.row, paidAt: l.paidAt, time: l.time, details: null, counterparty: l.receiver.name ?? l.receiver.id,
      accountId: account?.id ?? null, accountLabel: account ? `BHIM · ${account.label}` : 'BHIM', direction: bhimDirection(l), amountPaise: l.amountPaise,
      upiRef: l.upiRef, orderId: null, remarks: null, tag: null, app: 'bhim', ignored: false, ignoredReason: null, isCircle: bhimIsCircle(l),
    });
  }
  result.ignored.byAccount = [...leftOut.values()];
  result.counts.ignored = result.ignored.count;
  result.counts.failed = result.failed.length;
  result.counts.new = result.newLines.length;
  const dates = parsed.lines.map((l) => l.paidAt).sort();
  result.firstDate = dates[0] ?? null;
  result.lastDate = dates[dates.length - 1] ?? null;
  return result;
}
