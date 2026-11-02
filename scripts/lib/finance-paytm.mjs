// Step 1 of the Paytm UPI import: turn the export workbook (finance-xlsx.mjs rows) into plain normalised lines.
// No database here. Layout read from a real export: a "Summary" sheet (period, per-account totals) and a "Passbook
// Payment History" sheet with the columns Date, Time, Transaction Details, Other Transaction Details (UPI ID or A/c
// No), Your Account, Amount (signed text, "-1,234.00"), UPI Ref No., Order ID, Remarks, Tags, Comment.
//
// A row that cannot be read goes in `failed` with its sheet row number; it is never dropped silently and does not
// fail the whole file.
import { parseDateCell, parsePaise } from './finance-cells.mjs';

export const PAYTM_FORMAT = 'paytm-upi-v1';

const norm = (v) => String(v ?? '').trim().toLowerCase();
const blank = (v) => v === null || v === undefined || String(v).trim() === '';
const text = (v) => (blank(v) ? null : String(v).trim());
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// "1 Apr'26 - 1 Nov'26" -> { from, to }; null if it does not read as a period.
function parsePeriod(value) {
  const parts = [...String(value ?? '').matchAll(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*\W*(\d{2,4})/g)];
  if (parts.length !== 2) return null;
  const iso = ([, d, mon, y]) => {
    const month = MONTHS[mon.toLowerCase()];
    if (!month) return null;
    return parseDateCell(`${d}/${month}/${y.length === 2 ? `20${y}` : y}`);
  };
  try {
    const from = iso(parts[0]);
    const to = iso(parts[1]);
    return from && to ? { from, to } : null;
  } catch {
    return null;
  }
}

// Does an export tag ("#💰 Pocket Money") name the configured circle tag ("Pocket Money")?
export function tagMatches(rawTag, configured) {
  const clean = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const want = clean(configured);
  return want !== '' && clean(rawTag) === want;
}

export function parsePaytmExport(sheets) {
  const summary = sheets.find((s) => norm(s.name) === 'summary');
  const passbook = sheets.find((s) => norm(s.name).startsWith('passbook'));
  if (!summary || !passbook) throw new Error('This does not look like a Paytm UPI export: it needs a Summary sheet and a Passbook Payment History sheet.');

  const header = passbook.rows[0] ?? [];
  const find = (needle) => header.findIndex((c) => norm(c).includes(needle));
  const col = {
    date: find('date'), time: find('time'), details: find('transaction details'), other: find('other transaction'),
    account: find('your account'), amount: find('amount'), ref: find('upi ref'), order: find('order id'),
    remarks: find('remarks'), tag: find('tags'),
  };
  // 'transaction details' also matches the "Other Transaction Details" heading; take the first heading that is exactly it.
  col.details = header.findIndex((c) => norm(c) === 'transaction details');
  const missing = Object.entries(col).filter(([, i]) => i < 0).map(([k]) => (k === 'ref' ? 'UPI Ref No.' : k));
  if (missing.length) throw new Error(`This does not look like a Paytm UPI export: no heading for ${missing.join(', ')}. (UPI Ref No. is needed to join the bank statement.)`);

  const periodCell = summary.rows.find((r) => /statement for/i.test(String(r[0] ?? '')));
  const period = periodCell ? parsePeriod(periodCell[1]) : null;

  const accountsAt = summary.rows.findIndex((r) => norm(r[0]) === 'accounts');
  const accounts = [];
  if (accountsAt >= 0) {
    for (const r of summary.rows.slice(accountsAt + 1)) {
      if (blank(r[0]) || blank(r[1])) break;
      accounts.push(String(r[0]).trim());
    }
  }

  const lines = [];
  const failed = [];
  passbook.rows.slice(1).forEach((r, i) => {
    if (r.every(blank)) return;
    const rowNumber = i + 2;
    try {
      // Rows paid by card or from another bank's account often carry no UPI reference at all; keep them with
      // `upiRef: null` and let the import decide (ignored if the account is not ours, failed if it is). A reference
      // that is present but not 12 digits is a damaged row.
      const upiRef = blank(r[col.ref]) ? null : String(r[col.ref]).trim();
      if (upiRef !== null && !/^\d{12}$/.test(upiRef)) throw new Error('the UPI reference is not 12 digits');
      const signed = parsePaise(r[col.amount]);
      if (signed === 0) throw new Error('amount is zero');
      lines.push({
        row: rowNumber,
        paidAt: parseDateCell(r[col.date]),
        time: text(r[col.time]),
        details: text(r[col.details]),
        counterparty: text(r[col.other]),
        accountLabel: String(r[col.account] ?? '').trim(),
        direction: signed < 0 ? 'debit' : 'credit',
        amountPaise: Math.abs(signed),
        upiRef,
        orderId: text(r[col.order]),
        remarks: text(r[col.remarks]),
        tag: text(r[col.tag]),
      });
    } catch (err) {
      failed.push({ row: rowNumber, reason: err.message });
    }
  });

  return { format: PAYTM_FORMAT, from: period?.from ?? null, to: period?.to ?? null, accounts, lines, failed };
}
