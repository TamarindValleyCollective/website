// Step 2 of a bank statement import, and the only step that judges anything. It takes NORMALISED statements (what
// finance-axis-statement.mjs produces, or what any other source, such as a bank API later, could produce) and what
// is already held, and returns what to store and what to report. It touches no database and no file, so every rule
// can be tested with invented numbers.
//
// What a statement is here:  { from, to, openingPaise, closingPaise, reported?, lines: [{ seq, tranDate, valueDate,
// narration, direction, amountPaise, balancePaise, upiRrn }] }. A "file" wraps one: { id, fileHash, statement }.
// What is held:  { batches: [{ fileHash, from, to, openingPaise, closingPaise }], lines: [{ tranDate, dedupeKey }] }.
//
// Each file is its own batch. Files may arrive several at once or one at a time, in any order; they are processed
// oldest period first, and each sees the earlier ones (held, or accepted a moment ago in the same upload) as held.
//
// Rules, in the order they matter:
//  * A file's own balance chain must hold from its opening balance, line by line (and agree with the bank's footer).
//    A break is reported with the line; nothing is guessed and the file is not stored.
//  * A year that follows or precedes another held year must meet it: this closing balance equals that opening balance.
//    A mismatch blocks the file being imported.
//  * A gap between held years is REPORTED (with its dates), not refused: each year is its own consistent batch, and the
//    gap closes when the missing year arrives.
//  * An overlap (a later download of a period already held) adds only the lines not held. The overlap must be exact:
//    every held line in the period appears in the file, as one unbroken run, and a line we did not hold may only be
//    new if it is dated on or after the last day we held (a late post that day), never inside the held period.
//  * A line is the same line if its dedupeKey matches: account, date, narration, direction, amount and the running
//    balance (which tells apart two identical same-day charges), plus its order among exact repeats in the file.
import { createHash } from 'node:crypto';
import { nextDay } from './finance-cells.mjs';

const prevDay = (iso) => new Date(Date.parse(`${iso}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);

export function lineKeys(accountId, lines) {
  const seen = new Map();
  return lines.map((l) => {
    const hash = createHash('sha256').update([accountId, l.tranDate, l.narration, l.direction, l.amountPaise, l.balancePaise].join('|')).digest('hex');
    const n = seen.get(hash) ?? 0;
    seen.set(hash, n + 1);
    return n === 0 ? hash : `${hash}:${n}`;
  });
}

function checkOwnConsistency(s) {
  const errors = [];
  let prev = s.openingPaise;
  let lastDate = null;
  let debit = 0;
  let credit = 0;
  let chainBroken = false;
  let orderBroken = false;
  let periodBroken = false;
  for (const l of s.lines) {
    if (!periodBroken && (l.tranDate < s.from || l.tranDate > s.to)) {
      periodBroken = true;
      errors.push({ type: 'out_of_period', seq: l.seq, date: l.tranDate, from: s.from, to: s.to });
    }
    if (!orderBroken && lastDate && l.tranDate < lastDate) {
      orderBroken = true;
      errors.push({ type: 'not_in_date_order', seq: l.seq, date: l.tranDate });
    }
    lastDate = l.tranDate;
    const expected = prev + (l.direction === 'credit' ? l.amountPaise : -l.amountPaise);
    if (!chainBroken && expected !== l.balancePaise) {
      chainBroken = true;
      errors.push({ type: 'chain_break', seq: l.seq, date: l.tranDate, expectedPaise: expected, foundPaise: l.balancePaise });
    }
    prev = l.balancePaise;
    if (l.direction === 'credit') credit += l.amountPaise; else debit += l.amountPaise;
  }
  if (s.reported && !chainBroken) {
    const r = s.reported;
    if (r.closingPaise !== prev || r.debitPaise !== debit || r.creditPaise !== credit) {
      errors.push({ type: 'footer_mismatch', reported: r, computed: { debitPaise: debit, creditPaise: credit, closingPaise: prev } });
    }
  }
  return errors;
}

function mergeIntervals(spans) {
  const sorted = [...spans].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  const out = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.from <= nextDay(last.to)) {
      if (s.to > last.to) last.to = s.to;
    } else out.push({ from: s.from, to: s.to });
  }
  return out;
}

const coverageOf = (spans) => {
  const intervals = mergeIntervals(spans);
  const gaps = intervals.slice(1).map((iv, i) => ({ from: nextDay(intervals[i].to), to: prevDay(iv.from) }));
  return { intervals, gaps };
};

export function planBankImport({ accountId, incoming, held }) {
  const spans = held.batches.map((b) => ({ from: b.from, to: b.to, openingPaise: b.openingPaise, closingPaise: b.closingPaise }));
  const heldLines = [...held.lines];
  const heldKeys = new Set(heldLines.map((l) => l.dedupeKey));
  const hashes = new Set(held.batches.map((b) => b.fileHash));

  const order = [...incoming].sort((a, b) => (a.statement.from < b.statement.from ? -1 : a.statement.from > b.statement.from ? 1 : a.statement.to < b.statement.to ? -1 : a.statement.to > b.statement.to ? 1 : 0));
  const results = new Map();

  for (const f of order) {
    const s = f.statement;
    const result = {
      id: f.id, fileHash: f.fileHash, status: 'ok',
      period: { from: s.from, to: s.to, openingPaise: s.openingPaise, closingPaise: s.closingPaise },
      counts: { total: s.lines.length, new: 0, alreadyHeld: 0 },
      firstDate: s.lines[0]?.tranDate ?? null, lastDate: s.lines[s.lines.length - 1]?.tranDate ?? null,
      errors: [], boundaries: [], newLines: [],
    };
    results.set(f.id, result);

    if (hashes.has(f.fileHash)) {
      result.status = 'duplicate_file';
      continue;
    }

    result.errors.push(...checkOwnConsistency(s));

    const keys = lineKeys(accountId, s.lines);
    const incomingHeld = keys.map((k) => heldKeys.has(k));
    result.counts.alreadyHeld = incomingHeld.filter(Boolean).length;

    // Overlap with periods already held: the file must agree with everything we hold inside its period.
    const touching = spans.filter((h) => h.from <= s.to && h.to >= s.from);
    if (touching.length) {
      const windowKeys = heldLines.filter((l) => l.tranDate >= s.from && l.tranDate <= s.to).map((l) => l.dedupeKey);
      const inFile = new Set(keys);
      const missingHeld = windowKeys.filter((k) => !inFile.has(k)).length;
      const matchedAt = incomingHeld.flatMap((h, i) => (h ? [i] : []));
      const contiguous = matchedAt.length === 0 || matchedAt[matchedAt.length - 1] - matchedAt[0] + 1 === matchedAt.length;
      const backdated = s.lines.filter((l, i) => !incomingHeld[i] && touching.some((h) => l.tranDate < h.to)).length;
      result.boundaries.push({
        type: 'overlap',
        from: touching.reduce((m, h) => (h.from < m ? h.from : m), touching[0].from) > s.from ? touching.reduce((m, h) => (h.from < m ? h.from : m), touching[0].from) : s.from,
        to: touching.reduce((m, h) => (h.to > m ? h.to : m), touching[0].to) < s.to ? touching.reduce((m, h) => (h.to > m ? h.to : m), touching[0].to) : s.to,
        alreadyHeld: result.counts.alreadyHeld,
      });
      if (missingHeld || !contiguous || backdated) result.errors.push({ type: 'overlap_conflict', missingHeld, nonContiguous: !contiguous, backdated });
    }

    // The neighbours on each side: adjacent periods must meet on the same balance; a hole is reported.
    const before = spans.filter((h) => h.to < s.from).sort((a, b) => (a.to < b.to ? 1 : -1))[0];
    if (before) {
      if (nextDay(before.to) === s.from) {
        if (before.closingPaise === s.openingPaise) result.boundaries.push({ type: 'chain_ok', side: 'before', with: { from: before.from, to: before.to }, balancePaise: s.openingPaise });
        else result.errors.push({ type: 'boundary_mismatch', side: 'before', with: { from: before.from, to: before.to }, expectedPaise: before.closingPaise, foundPaise: s.openingPaise });
      } else result.boundaries.push({ type: 'gap', side: 'before', between: [before.to, s.from], from: nextDay(before.to), to: prevDay(s.from) });
    }
    const after = spans.filter((h) => h.from > s.to).sort((a, b) => (a.from < b.from ? -1 : 1))[0];
    if (after) {
      if (nextDay(s.to) === after.from) {
        if (after.openingPaise === s.closingPaise) result.boundaries.push({ type: 'chain_ok', side: 'after', with: { from: after.from, to: after.to }, balancePaise: s.closingPaise });
        else result.errors.push({ type: 'boundary_mismatch', side: 'after', with: { from: after.from, to: after.to }, expectedPaise: after.openingPaise, foundPaise: s.closingPaise });
      } else result.boundaries.push({ type: 'gap', side: 'after', between: [s.to, after.from], from: nextDay(s.to), to: prevDay(after.from) });
    }

    if (result.errors.length) {
      result.status = 'blocked';
      continue;
    }

    s.lines.forEach((l, i) => {
      if (!incomingHeld[i]) result.newLines.push({ ...l, dedupeKey: keys[i] });
    });
    result.counts.new = result.newLines.length;
    hashes.add(f.fileHash);
    spans.push({ from: s.from, to: s.to, openingPaise: s.openingPaise, closingPaise: s.closingPaise });
    for (const l of result.newLines) {
      heldLines.push({ tranDate: l.tranDate, dedupeKey: l.dedupeKey });
      heldKeys.add(l.dedupeKey);
    }
  }

  const batches = incoming.map((f) => results.get(f.id));
  return { batches, order: order.map((f) => f.id), coverage: coverageOf(spans), blocked: batches.some((b) => b.status === 'blocked') };
}

// What is held after a plan has been stored (used by tests and by the page-less callers); blocked and duplicate
// files add nothing.
export function heldFromPlan(held, plan) {
  const ok = plan.batches.filter((b) => b.status === 'ok');
  return {
    batches: [...held.batches, ...ok.map((b) => ({ fileHash: b.fileHash, ...b.period }))],
    lines: [...held.lines, ...ok.flatMap((b) => b.newLines.map((l) => ({ tranDate: l.tranDate, dedupeKey: l.dedupeKey })))],
  };
}

export { coverageOf };
