// Reading the old transfer-request sheet for the one-time history load into payment requests and spend logs
// (docs/finance/sessions/08-payment-requests-and-bills.md, decision 4). Pure and I/O-free (finance-requests-history.test.mjs);
// scripts/load-fin-requests-history.mjs does the reading and writing. Nothing from the real sheet is kept in this repository:
// only the names of its columns.
//
// Two tabs:
//   "Fund Transfer Request"      NEFT-style requests: Date, Name, Amount, Account #, IFSC Code, Purpose, Status, Reference
//   "UPI Circle Transactions"    UPI payments from the app report: Date, Bank Name, Account Number, Receiver, Payment ID/Reference
//                                 Number, Amount (in Rs.), DR/CR, Status, Recipient, Comments
// Quirks handled: the sheet drops leading zeros from references; a row whose status is a failure moved no money; a row paid from a
// bank account that is not the company's is skipped; the DR/CR column is not the direction of the money (a row naming no bank is a
// delegated payment OUT; a row naming the bank and CR is money coming in).
import { padUpiRef } from './finance-requests.mjs';

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** "5 Nov 2026" or "15-May-2026" -> "2026-11-05"; null when it is neither. */
export function parseSheetDate(raw) {
  const m = /^\s*(\d{1,2})[\s-]([A-Za-z]{3})[A-Za-z]*[\s-](\d{4})\s*$/.exec(String(raw ?? ''));
  const month = m ? MONTHS[m[2].toLowerCase()] : undefined;
  if (!m || !month) return null;
  const iso = `${m[3]}-${String(month).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) === iso ? iso : null;
}

/** "₹12,500", "12,500.50" or 12500 -> paise; null when it is not a positive amount. */
export function parseSheetAmount(raw) {
  const s = String(raw ?? '').replace(/[₹,\s]|rs\.?/gi, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const paise = Math.round(parseFloat(s) * 100);
  return paise > 0 ? paise : null;
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function columns(header, wanted) {
  const idx = new Map(header.map((h, i) => [norm(h), i]));
  const out = {};
  for (const [key, names] of Object.entries(wanted)) out[key] = names.map((n) => idx.get(norm(n))).find((i) => i !== undefined);
  return out;
}
const cell = (row, i) => (i === undefined ? '' : String(row[i] ?? '').trim());
const cleanText = (s, max) => s.replace(/\s+/g, ' ').trim().slice(0, max);

const SUCCESS = /^(complete|completed|paid|success|successful)$/i;

/**
 * The NEFT-style tab. `rows[0]` is the header. -> { records, skipped: { failed, noDate, noAmount, noPurpose, noName } }
 * A record: { kind: 'request', date, name, amountPaise, account (digits or ''), ifsc, purpose, line }.
 */
export function parseTransferTab(rows) {
  const skipped = { failed: 0, noDate: 0, noAmount: 0, noPurpose: 0, noName: 0 };
  const records = [];
  if (!rows.length) return { records, skipped };
  const c = columns(rows[0], { date: ['Date'], name: ['Name'], amount: ['Amount'], account: ['Account #', 'Account Number'], ifsc: ['IFSC Code', 'IFSC'], purpose: ['Purpose'], status: ['Status'] });
  rows.slice(1).forEach((row, i) => {
    // The sheet is pre-numbered down its first column, so a row counts only when something real is in it.
    if (![c.date, c.name, c.amount, c.purpose].some((col) => cell(row, col))) return;
    const line = i + 2;
    if (!SUCCESS.test(cell(row, c.status))) return void (skipped.failed += 1);
    const date = parseSheetDate(cell(row, c.date));
    if (!date) return void (skipped.noDate += 1);
    const amountPaise = parseSheetAmount(cell(row, c.amount));
    if (!amountPaise) return void (skipped.noAmount += 1);
    const name = cleanText(cell(row, c.name), 120);
    if (name.length < 2) return void (skipped.noName += 1);
    const purpose = cleanText(cell(row, c.purpose), 300);
    if (purpose.length < 2) return void (skipped.noPurpose += 1);
    records.push({ kind: 'request', date, name, amountPaise, account: cell(row, c.account).replace(/\D/g, ''), ifsc: cell(row, c.ifsc).toUpperCase(), purpose, line });
  });
  return { records, skipped };
}

/** "someone@bank(Some Name)" -> "Some Name"; a bare handle gives null (a UPI id is never kept as a name). */
export function nameFromReceiver(receiver) {
  const m = /\(([^)]+)\)\s*$/.exec(String(receiver ?? ''));
  const name = m ? cleanText(m[1], 120) : '';
  return name.length >= 2 && !name.includes('@') ? name : null;
}

/**
 * The UPI app report tab. `ownLast4`: the last four digits of the company's registered accounts. -> { records, skipped }.
 * A record: { kind: 'log', date, name, amountPaise, upiRef, purpose, paidVia: 'delegate'|'direct', line }.
 */
export function parseCircleTab(rows, { ownLast4 }) {
  const skipped = { failed: 0, notOurs: 0, moneyIn: 0, noDate: 0, noAmount: 0, noRef: 0, noPurpose: 0 };
  const records = [];
  if (!rows.length) return { records, skipped };
  const c = columns(rows[0], { date: ['Date'], bank: ['Bank Name'], account: ['Account Number'], receiver: ['Receiver'], ref: ['Payment ID/Reference Number', 'Reference Number'], amount: ['Amount (in Rs.)', 'Amount'], drcr: ['DR/CR'], status: ['Status'], recipient: ['Recipient'], comments: ['Comments'] });
  rows.slice(1).forEach((row, i) => {
    if (!row.some((v) => String(v ?? '').trim())) return;
    const line = i + 2;
    if (!SUCCESS.test(cell(row, c.status))) return void (skipped.failed += 1);
    const bank = cell(row, c.bank);
    const named = bank !== '' && !/^n\/?a$/i.test(bank);
    if (named) {
      const last4 = cell(row, c.account).replace(/\D/g, '').slice(-4);
      if (!ownLast4.includes(last4)) return void (skipped.notOurs += 1);
      if (/^cr$/i.test(cell(row, c.drcr))) return void (skipped.moneyIn += 1);
    }
    const date = parseSheetDate(cell(row, c.date));
    if (!date) return void (skipped.noDate += 1);
    const amountPaise = parseSheetAmount(cell(row, c.amount));
    if (!amountPaise) return void (skipped.noAmount += 1);
    const upiRef = padUpiRef(cell(row, c.ref));
    if (!upiRef) return void (skipped.noRef += 1);
    const purpose = cleanText(cell(row, c.comments), 300);
    if (purpose.length < 2) return void (skipped.noPurpose += 1);
    const name = cleanText(cell(row, c.recipient), 120) || nameFromReceiver(cell(row, c.receiver));
    records.push({ kind: 'log', date, name: name || null, amountPaise, upiRef, purpose, paidVia: named ? 'direct' : 'delegate', line });
  });
  return { records, skipped };
}

/**
 * What to insert. `existing`: the history rows already loaded ({ upiRef, paidOn, amountPaise, label, purpose }) so a second run adds
 * nothing; `partyOf(record)` -> a party id or null. A reference seen twice in the sheet is loaded once.
 * -> { insert: row[], duplicates, noName }
 */
export function planHistory(records, { existing, partyOf, entityId }) {
  const seenRef = new Set(existing.filter((e) => e.upiRef).map((e) => e.upiRef));
  const seenKey = new Set(existing.filter((e) => !e.upiRef).map((e) => [e.paidOn, e.amountPaise, norm(e.label), norm(e.purpose)].join('|')));
  const insert = [];
  let duplicates = 0;
  let noName = 0;
  for (const r of records) {
    const partyId = partyOf(r);
    if (!partyId && !r.name) {
      noName += 1;
      continue;
    }
    if (r.upiRef) {
      if (seenRef.has(r.upiRef)) {
        duplicates += 1;
        continue;
      }
      seenRef.add(r.upiRef);
    } else {
      const key = [r.date, r.amountPaise, norm(r.name), norm(r.purpose)].join('|');
      if (seenKey.has(key)) {
        duplicates += 1;
        continue;
      }
      seenKey.add(key);
    }
    insert.push({
      entity_id: entityId, kind: r.kind, status: 'paid', source: 'history', requester_id: null,
      party_id: partyId, recipient_text: partyId ? null : r.name, amount_paise: r.amountPaise, mode: r.kind === 'log' ? 'upi' : 'neft',
      purpose: r.purpose, paid_on: r.date, paid_via: r.kind === 'log' ? r.paidVia : null, upi_ref: r.upiRef ?? null,
    });
  }
  return { insert, duplicates, noName };
}
