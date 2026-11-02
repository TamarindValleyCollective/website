// Step 1 of a bank statement import: turn an Axis "Statement Enquiry" workbook (rows from finance-xlsx.mjs) into plain
// normalised lines. It does not touch a database and does not judge the lines (balance chain, duplicates and
// storage are step 2, finance-import-plan.mjs), so another source with the same output could feed that step.
//
// The layout, read from a real download: a block of account details; a line "Statement of Account No - … for the
// period (From : dd/mm/yyyy To : dd/mm/yyyy )"; a heading row starting S.NO; an OPENING BALANCE row; one row per
// transaction; then a "TRANSACTION TOTAL DR/CR" row, a "CLOSING BALANCE" row and boilerplate. Dates, amounts and the
// balance are text in the real files; numbers and Excel dates are accepted too. Columns are found by their headings.
import { parseDateCell, parsePaise } from './finance-cells.mjs';

export const AXIS_FORMAT = 'axis-statement-v1';

const norm = (v) => String(v ?? '').trim().toLowerCase();

// The 12-digit reference after UPI/P2A/ or UPI/P2M/ joins a bank line to the Paytm row for the same payment.
export function upiRrnFromNarration(narration) {
  const m = /^UPI\/(?:P2A|P2M)\/(\d{12})\//.exec(String(narration ?? ''));
  return m ? m[1] : null;
}

function columnMap(header) {
  const find = (...needles) => header.findIndex((c) => needles.some((n) => norm(c).includes(n)));
  const map = {
    seq: find('s.no'),
    tranDate: find('transaction date'),
    valueDate: find('value date'),
    particulars: find('particulars'),
    amount: find('amount'),
    drcr: find('debit/credit'),
    balance: find('balance'),
  };
  const missing = Object.entries(map).filter(([, i]) => i < 0).map(([k]) => k);
  if (missing.length) throw new Error(`This does not look like an Axis statement: no heading for ${missing.join(', ')}.`);
  return map;
}

const blank = (v) => v === null || v === undefined || String(v).trim() === '';

export function parseAxisStatement(rows) {
  const headerAt = rows.findIndex((r) => norm(r[0]) === 's.no');
  if (headerAt < 0) throw new Error('This does not look like an Axis statement: no S.NO heading row.');
  const col = columnMap(rows[headerAt]);

  const periodRow = rows.slice(0, headerAt).map((r) => String(r[0] ?? '')).find((t) => /statement of account/i.test(t));
  const period = periodRow && /From\s*:\s*(\S+)\s*To\s*:\s*(\S+)/i.exec(periodRow);
  if (!period) throw new Error('This Axis statement has no period line ("From … To …"), so it cannot be placed.');
  const from = parseDateCell(period[1]);
  const to = parseDateCell(period[2]);
  if (from > to) throw new Error('This Axis statement has a period that ends before it starts.');
  const last4 = /Account No\s*-\s*\D*(\d+)/i.exec(periodRow);
  const accountLast4 = last4 ? last4[1].slice(-4) : null;

  let openingPaise = null;
  let reported = null;
  let reportedClosing = null;
  let reportedTotals = null;
  const lines = [];

  for (const row of rows.slice(headerAt + 1)) {
    const what = norm(row[col.particulars]);
    if (what === 'opening balance') {
      openingPaise = parsePaise(row[col.balance]);
      continue;
    }
    if (what === 'transaction total dr/cr') {
      const parts = String(row[col.amount] ?? '').split('/');
      try {
        if (parts.length === 2) reportedTotals = { debitPaise: parsePaise(parts[0]), creditPaise: parsePaise(parts[1]) };
      } catch { /* unreadable footer total: the lines themselves are still checked */ }
      continue;
    }
    if (what === 'closing balance') {
      try { reportedClosing = parsePaise(row[col.balance]); } catch { /* as above */ }
      continue;
    }
    if (blank(row[col.tranDate])) continue; // boilerplate and blank rows

    const seq = Number(row[col.seq]);
    const label = `Line ${Number.isFinite(seq) ? seq : lines.length + 2}`;
    try {
      const drcr = String(row[col.drcr] ?? '').trim().toUpperCase();
      if (drcr !== 'DR' && drcr !== 'CR') throw new Error(`Debit/Credit must be DR or CR, found "${row[col.drcr] ?? ''}"`);
      const amountPaise = parsePaise(row[col.amount]);
      if (amountPaise < 0) throw new Error('amount is negative; direction comes from the Debit/Credit column');
      const tranDate = parseDateCell(row[col.tranDate]);
      const narration = String(row[col.particulars] ?? '').trim();
      lines.push({
        seq,
        tranDate,
        valueDate: blank(row[col.valueDate]) ? tranDate : parseDateCell(row[col.valueDate]),
        narration,
        direction: drcr === 'DR' ? 'debit' : 'credit',
        amountPaise,
        balancePaise: parsePaise(row[col.balance]),
        upiRrn: upiRrnFromNarration(narration),
      });
    } catch (err) {
      throw new Error(`${label}: ${err.message}`);
    }
  }

  if (openingPaise === null) throw new Error('This Axis statement has no OPENING BALANCE row, so its balance chain cannot start.');
  const closingPaise = lines.length ? lines[lines.length - 1].balancePaise : openingPaise;
  if (reportedClosing !== null && reportedTotals) reported = { ...reportedTotals, closingPaise: reportedClosing };

  return { format: AXIS_FORMAT, accountLast4, from, to, openingPaise, closingPaise, reported, lines };
}
