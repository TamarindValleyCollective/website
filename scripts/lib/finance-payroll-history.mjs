// Allocating old salary batches from their PayPro upload files (docs/finance/sessions/09-payroll.md, the history import). Pure: no
// network, no database, no file access; scripts/import-payroll-history.mjs reads the files and the ledger and passes them in.
// A batch is the set of people paid by one bank debit. It is matched to the one unallocated debit of the same total paid shortly
// after its salary month, and split into one Salaries allocation per person for that month. Never touches a line that has allocations.
import { matchParty, normaliseName } from './finance-suggest.mjs';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// A salary is paid in the month after, or occasionally a little later; a debit this far after the month start can be its batch.
const WINDOW_DAYS = 75;

const toNumber = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v ?? '').replace(/,/g, '').trim();
  return /^\d+(\.\d+)?$/.test(s) ? Number(s) : null;
};

/** Rows of a PayPro file (no header; B amount in rupees, D name) -> [{ name, amountPaise }]. Rows without an amount are skipped. */
export function parsePayproRows(rows) {
  const out = [];
  for (const r of rows) {
    const amount = toNumber(r?.[1]);
    if (amount == null || amount <= 0) continue;
    out.push({ name: String(r[3] ?? '').trim(), amountPaise: Math.round(amount * 100) });
  }
  return out;
}

function monthIn(text) {
  const m = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s\-_.]*(?:salary[\s\-_.]*)?(\d{4})\b/i.exec(String(text ?? ''));
  if (!m) return null;
  return `${m[2]}-${String(MONTHS.findIndex((x) => x.toLowerCase() === m[1].toLowerCase()) + 1).padStart(2, '0')}`;
}

/** The salary month ("2026-10") a file is for: the narration column G, then L, else the file name ("Oct-salary-2026"); null if none say. */
export function monthOfBatch(rows, fileName = '') {
  for (const r of rows) {
    if (toNumber(r?.[1]) == null) continue;
    const found = monthIn(r[6]) ?? monthIn(r[11]);
    if (found) return found;
  }
  const byName = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*-salary-(\d{4})/i.exec(fileName);
  return byName ? monthIn(`${byName[1]} ${byName[2]}`) : null;
}

const addDays = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

/**
 * batches: [{ label, month: 'YYYY-MM', entries: [{ name, amountPaise }] }]; lines: bank lines { id, tran_date, direction, amount_paise };
 * parties: { id, name, kind } (only employees are considered); aliases: [{ name as written in the file, partyId }] the owner decided. Returns { plans: [{ label, lineId, rows }], unplaced, counts }.
 */
export function planSalaryHistory({ batches, lines, allocatedLineIds, categoryId, parties, aliases = [] }) {
  const employees = parties.filter((p) => p.kind === 'employee');
  // A name as the file spells it -> a party the owner named. Only an employee party in the register is accepted.
  const aliasOf = new Map(aliases.filter((a) => employees.some((p) => p.id === a.partyId)).map((a) => [normaliseName(a.name), a.partyId]));
  const claimed = new Set();
  const plans = [];
  const unplaced = [];
  const counts = { batches: batches.length, planned: 0, allocations: 0, withParty: 0, withoutParty: 0, noLine: 0, ambiguous: 0, alreadyAllocated: 0 };
  for (const b of batches) {
    const total = b.entries.reduce((s, e) => s + e.amountPaise, 0);
    const from = `${b.month}-01`;
    const to = addDays(from, WINDOW_DAYS);
    const fits = lines.filter((l) => l.direction === 'debit' && l.amount_paise === total && l.tran_date >= from && l.tran_date <= to && !claimed.has(l.id));
    const open = fits.filter((l) => !allocatedLineIds.has(l.id));
    if (fits.length > 0 && open.length === 0) {
      counts.alreadyAllocated++;
      continue;
    }
    if (open.length === 0) {
      counts.noLine++;
      unplaced.push({ label: b.label, reason: 'no unallocated bank debit of this total in the window' });
      continue;
    }
    if (open.length > 1) {
      counts.ambiguous++;
      unplaced.push({ label: b.label, reason: `${open.length} unallocated bank debits fit` });
      continue;
    }
    const line = open[0];
    claimed.add(line.id);
    const nature = `${MONTHS[Number(b.month.slice(5)) - 1]} Salary`;
    const rows = b.entries.map((e) => {
      const aliased = aliasOf.get(normaliseName(e.name));
      const hit = aliased ? { partyId: aliased } : e.name ? matchParty(e.name, employees) : null;
      hit ? counts.withParty++ : counts.withoutParty++;
      return { party_id: hit?.partyId ?? null, category_id: categoryId, amount_paise: e.amountPaise, period: from, nature, source: 'import', review_state: 'ok', review_reason: null };
    });
    counts.allocations += rows.length;
    counts.planned++;
    plans.push({ label: b.label, lineId: line.id, rows });
  }
  return { plans, unplaced, counts };
}
