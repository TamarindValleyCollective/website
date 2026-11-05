// Loading the Google Sheet's history into the ledger (docs/finance/sessions/06-history-load.md). Pure and I/O-free so it is tested
// directly (finance-history.test.mjs); scripts/load-fin-history.mjs reads the sheet and the database and calls these.
//
// The bank lines are already in the database (statement import, session 03), so nothing here creates a bank line. The funds
// transfer tracker carries what the statements do not: what each payment was for. So the job is to find, for every tracker row, the
// bank line it describes, and only then to turn the row's labels into an allocation on that line.
import { parsePaise } from './finance-cells.mjs';

const REQUIRED = ['date', 'amount', 'transaction particulars', 'dr/cr'];
const text = (v) => String(v ?? '').trim();

// ---- reading the tracker
function parseDate(raw) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text(raw));
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d ? `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
}

/**
 * Read the tracker's grid (row 1 is the heading) by heading name, not by position. Returns { rows, problems }: rows that can be used,
 * and the sheet row number and reason for every row that cannot (never guessed). A wholly blank row is skipped silently.
 */
export function parseTracker(grid) {
  const header = (grid[0] ?? []).map((h) => text(h).toLowerCase());
  const missing = REQUIRED.filter((h) => !header.includes(h));
  const shown = { date: 'Date', amount: 'Amount', 'transaction particulars': 'Transaction Particulars', 'dr/cr': 'DR/CR' };
  if (missing.length) throw new Error(`The tracker is missing the heading(s): ${missing.map((h) => shown[h]).join(', ')}.`);
  const col = (name) => header.indexOf(name);
  const get = (r, name) => (col(name) >= 0 ? text(r[col(name)]) : '');
  const rows = [];
  const problems = [];
  grid.slice(1).forEach((r, i) => {
    const sheetRow = i + 2;
    if (!r.some((c) => text(c))) return;
    const fail = (reason) => problems.push({ sheetRow, reason });
    const date = parseDate(get(r, 'date'));
    if (!date) return fail(get(r, 'date') ? 'The date is not day/month/year.' : 'No date.');
    if (!get(r, 'amount')) return fail('No amount.');
    let amountPaise;
    try {
      amountPaise = parsePaise(get(r, 'amount'));
    } catch {
      return fail('Amount cannot be read as rupees and paise.');
    }
    if (!(amountPaise > 0)) return fail('Amount is not more than zero.');
    const dir = get(r, 'dr/cr').toUpperCase();
    if (dir !== 'DR' && dir !== 'CR') return fail('DR/CR is neither DR nor CR.');
    const year = Number(get(r, 'year'));
    const month = Number(get(r, 'month'));
    const period = year >= 2000 && year <= 2100 && month >= 1 && month <= 12 ? `${year}-${String(month).padStart(2, '0')}-01` : `${date.slice(0, 7)}-01`;
    rows.push({
      sheetRow, date, amountPaise, direction: dir === 'DR' ? 'debit' : 'credit', particulars: get(r, 'transaction particulars'), period,
      details: get(r, 'details'), type: get(r, 'type'), remarks: get(r, 'remarks'), toName: get(r, 'to'), fromName: get(r, 'from'), mode: get(r, 'mode'),
      financialYear: get(r, 'financial year'),
    });
  });
  return { rows, problems };
}

// ---- matching rows to bank lines
/** The 12-digit UPI/IMPS reference inside a narration, and only that (a longer run of digits is something else). */
export const referenceOf = (s) => /(?<!\d)(\d{12})(?!\d)/.exec(String(s ?? ''))?.[1] ?? null;

const squash = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
/** How alike two narrations are, 0 to 1 (Dice coefficient on letter pairs, ignoring case and punctuation). */
export function similarity(a, b) {
  const [x, y] = [squash(a), squash(b)];
  if (x.length < 2 || y.length < 2) return x && x === y ? 1 : 0;
  const grams = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1);
    return m;
  };
  const [gx, gy] = [grams(x), grams(y)];
  let shared = 0;
  for (const [g, n] of gx) shared += Math.min(n, gy.get(g) ?? 0);
  return (2 * shared) / (x.length - 1 + (y.length - 1));
}

const dayDiff = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;

/**
 * Pair tracker rows with bank lines. Four passes, strongest first, each only over what the earlier ones left:
 *   1. the same date, direction and amount (several identical candidates are paired by how alike their narrations are);
 *   2. rows split by hand: all of a day's remaining rows in one direction add up exactly to one remaining line (a salary batch);
 *   3. the same 12-digit reference, direction and amount, on another date;
 *   4. the same direction and amount within `nearDays` days.
 * A line is never used twice. Returns { pairs: [{ row, line, how }], groups: [{ rows, line }], unmatchedRows, unmatchedLines, counts }.
 */
export function matchTracker(trackerRows, bankLines, { nearDays = 5 } = {}) {
  const rows = [...trackerRows].sort((a, b) => a.sheetRow - b.sheetRow);
  const lines = [...bankLines].sort((a, b) => (a.tran_date < b.tran_date ? -1 : a.tran_date > b.tran_date ? 1 : a.id < b.id ? -1 : 1));
  const claimed = new Set();
  const usedRows = new Set();
  const pairs = [];
  const groups = [];
  let ambiguous = 0;

  // 1. exact
  const key = (date, dir, paise) => `${date}|${dir}|${paise}`;
  const rowsByKey = new Map();
  for (const r of rows) rowsByKey.set(key(r.date, r.direction, r.amountPaise), [...(rowsByKey.get(key(r.date, r.direction, r.amountPaise)) ?? []), r]);
  const linesByKey = new Map();
  for (const l of lines) linesByKey.set(key(l.tran_date, l.direction, l.amount_paise), [...(linesByKey.get(key(l.tran_date, l.direction, l.amount_paise)) ?? []), l]);
  for (const [k, rs] of rowsByKey) {
    const ls = linesByKey.get(k) ?? [];
    if (!ls.length) continue;
    const choice = rs.length > 1 || ls.length > 1;
    const scored = rs.flatMap((r) => ls.map((l) => ({ r, l, s: similarity(r.particulars, l.narration) }))).sort((a, b) => b.s - a.s || a.r.sheetRow - b.r.sheetRow);
    for (const { r, l } of scored) {
      if (usedRows.has(r.sheetRow) || claimed.has(l.id)) continue;
      usedRows.add(r.sheetRow);
      claimed.add(l.id);
      pairs.push({ row: r, line: l, how: 'exact' });
      if (choice) ambiguous++;
    }
  }

  // 2. a day's rows that add up to one line
  const leftover = () => rows.filter((r) => !usedRows.has(r.sheetRow));
  const byDay = new Map();
  for (const r of leftover()) byDay.set(`${r.date}|${r.direction}`, [...(byDay.get(`${r.date}|${r.direction}`) ?? []), r]);
  for (const l of lines) {
    if (claimed.has(l.id)) continue;
    const day = byDay.get(`${l.tran_date}|${l.direction}`) ?? [];
    if (day.length > 1 && day.every((r) => !usedRows.has(r.sheetRow)) && day.reduce((n, r) => n + r.amountPaise, 0) === l.amount_paise) {
      claimed.add(l.id);
      for (const r of day) usedRows.add(r.sheetRow);
      groups.push({ rows: day, line: l });
    }
  }

  // 3. the bank's reference, then 4. the nearest date with the same amount
  for (const how of ['reference', 'near date']) {
    for (const r of leftover()) {
      const ref = how === 'reference' ? referenceOf(r.particulars) : null;
      if (how === 'reference' && !ref) continue;
      const candidates = lines.filter((l) => !claimed.has(l.id) && l.direction === r.direction && l.amount_paise === r.amountPaise && (how === 'reference' ? (l.upi_rrn ?? referenceOf(l.narration)) === ref : dayDiff(l.tran_date, r.date) <= nearDays));
      candidates.sort((a, b) => dayDiff(a.tran_date, r.date) - dayDiff(b.tran_date, r.date));
      if (!candidates.length) continue;
      claimed.add(candidates[0].id);
      usedRows.add(r.sheetRow);
      pairs.push({ row: r, line: candidates[0], how });
    }
  }

  const unmatchedRows = leftover();
  const unmatchedLines = lines.filter((l) => !claimed.has(l.id));
  const howCount = (h) => pairs.filter((p) => p.how === h).length;
  return {
    pairs,
    groups,
    unmatchedRows,
    unmatchedLines,
    counts: { exact: howCount('exact'), grouped: groups.length, groupedRows: groups.reduce((n, g) => n + g.rows.length, 0), reference: howCount('reference'), nearDate: howCount('near date'), ambiguous, unmatchedRows: unmatchedRows.length, unmatchedLines: unmatchedLines.length },
  };
}
