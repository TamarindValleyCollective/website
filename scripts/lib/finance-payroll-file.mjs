// The monthly salary bulk-payment file (docs/finance/sessions/09-payroll.md, "The upload file's layout"). Pure: no network, no
// database. The page and function pass in the run and the decrypted payee details; this module decides what the file holds and
// refuses to build one that the bank's portal would reject or that would pay the wrong account.
//
// Layout (no header row, one row per person, columns A to L):
//   A mode (N or I)  B amount, whole rupees, a number  C payment date, text dd-mm-yyyy  D beneficiary name
//   E account number, a number (text when it starts with 0)  F e-mail  G "<Mon YYYY> Salary"  H the company's debit account
//   I "<YYYY>-<Mon>-Employee-<nnn>"  J IFSC  K a constant ("10")  L "Salary for <Mon YYYY>"
// G, I and L come from the month, never typed: the month used to be typed in three places and they disagreed.
import { strToU8, zipSync } from 'fflate';
import { accountPayableOn, todayIST } from './finance-parties.mjs';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const PAYMENT_MODES = ['N', 'I'];
// A month can hold a salary run and, besides it, named one-off runs of the same kind of file (a festival bonus, say).
export const RUN_TYPES = ['salary', 'bonus'];
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;

function parseMonth(month) {
  const m = typeof month === 'string' ? /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month) : null;
  if (!m) throw new Error('The salary month must look like 2026-10.');
  return { year: Number(m[1]), index: Number(m[2]) - 1 };
}

// "2026-10" -> "Oct 2026"
export function monthLabel(month) {
  const { year, index } = parseMonth(month);
  return `${MONTHS[index]} ${year}`;
}

// The salary is paid on the 1st of the following month.
export function defaultPaymentDate(month) {
  const { year, index } = parseMonth(month);
  const [y, m] = index === 11 ? [year + 1, 1] : [year, index + 2];
  return `${y}-${String(m).padStart(2, '0')}-01`;
}

const isRealDate = (s) => {
  const m = typeof s === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(s) : null;
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
};
const ddmmyyyy = (s) => `${s.slice(8, 10)}-${s.slice(5, 7)}-${s.slice(0, 4)}`;

// The portal rejects a past payment date and accepts today or a future one (confirmed by the owner, 2026-11-17). So a file
// generated for a date that then passes without being uploaded can no longer be used: it has to be regenerated, with a new date.
export function validatePaymentDate(date, today) {
  if (!isRealDate(date)) return { error: 'Enter the payment date as a real date.' };
  if (date < today) return { error: 'The payment date is in the past; the bank will reject it.' };
  return {};
}

// A generated file that has not been uploaded is stale once its payment date is behind today.
export const fileIsStale = (paymentDate, today) => paymentDate < today;

const tidy = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');

// The wording the bank file carries for a run, as the files uploaded since 2023 have it: salary is "<Mon YYYY> Salary" and
// "Salary for <Mon YYYY>", a bonus run is "<Mon YYYY> <name>" and "<name> for <Mon YYYY>" (the name is typed once, e.g. "Diwali Bonus").
export function runWording(month, runType = 'salary', name = '') {
  const label = monthLabel(month);
  return runType === 'bonus'
    ? { narration: `${label} ${tidy(name)}`, summary: `${tidy(name)} for ${label}` }
    : { narration: `${label} Salary`, summary: `Salary for ${label}` };
}

// Column I, the per-line reference that ties a line to the file: "2026-Oct-Employee-001", and "2026-Oct-Bonus-Employee-001" for a bonus run.
export function lineReference(month, runType, n) {
  const { year, index } = parseMonth(month);
  return `${year}-${MONTHS[index]}-${runType === 'bonus' ? 'Bonus-' : ''}Employee-${String(n).padStart(3, '0')}`;
}

// run: { month, runType?='salary', label?, paymentDate?, paymentMode?='N', constant?='10', debitAccount, today?, lines: [{ rollNo, name, accountNumber, ifsc, email?, netPaise }] }
// -> { rows, totalPaise, errors, warnings }. `rows` is empty when there are errors.
export function buildSalaryRows(run) {
  const errors = [];
  const warnings = [];
  let label = '';
  let year = 0;
  let mon = '';
  try {
    label = monthLabel(run.month);
    year = parseMonth(run.month).year;
    mon = MONTHS[parseMonth(run.month).index];
  } catch (e) {
    return { rows: [], totalPaise: 0, errors: [e.message], warnings };
  }
  const runType = run.runType ?? 'salary';
  const bonusName = tidy(run.label);
  if (!RUN_TYPES.includes(runType)) errors.push('The run type must be salary or bonus.');
  else if (runType === 'bonus' && (bonusName.length < 2 || bonusName.length > 40)) errors.push('A bonus run needs a name of 2 to 40 characters, such as Diwali Bonus.');
  const mode = run.paymentMode ?? 'N';
  if (!PAYMENT_MODES.includes(mode)) errors.push('The payment mode must be N or I.');
  const constant = String(run.constant ?? '10');
  if (!/^\d{1,4}$/.test(constant)) errors.push('The constant in column K must be a short number.');
  const debit = typeof run.debitAccount === 'string' ? run.debitAccount.trim() : '';
  if (!/^\d{9,18}$/.test(debit)) errors.push('The debit account is missing or not a plain account number.');
  const paymentDate = run.paymentDate ?? defaultPaymentDate(run.month);
  const today = run.today ?? todayIST();
  const pd = validatePaymentDate(paymentDate, today);
  if (pd.error) errors.push(pd.error);
  const lines = Array.isArray(run.lines) ? run.lines : [];
  if (lines.length === 0) errors.push('The run has no lines.');

  const wording = errors.length ? { narration: '', summary: '' } : runWording(run.month, runType, bonusName);
  const seen = new Set();
  const rolls = new Set();
  let totalPaise = 0;
  const rows = [];
  lines.forEach((l, i) => {
    const at = `Row ${i + 1}`;
    const roll = typeof l.rollNo === 'string' || typeof l.rollNo === 'number' ? Number(l.rollNo) : NaN;
    if (!Number.isInteger(roll) || roll < 1) errors.push(`${at}: the person has no employee number.`);
    else if (rolls.has(roll)) errors.push(`${at}: another row has the same employee number (${roll}).`);
    rolls.add(roll);
    const name = tidy(l.name);
    if (name.length < 2 || name.length > 100) errors.push(`${at}: the beneficiary name is missing or too long.`);
    if (seen.has(name.toLowerCase())) errors.push(`${at}: another row has the same name (${name}).`);
    seen.add(name.toLowerCase());
    const account = typeof l.accountNumber === 'string' ? l.accountNumber.trim() : '';
    if (!/^\d{9,18}$/.test(account)) errors.push(`${at}: the account number must be 9 to 18 digits.`);
    const ifsc = typeof l.ifsc === 'string' ? l.ifsc.replace(/\s+/g, '').toUpperCase() : '';
    if (!IFSC.test(ifsc)) errors.push(`${at}: the IFSC is not valid.`);
    if (!Number.isInteger(l.netPaise) || l.netPaise <= 0) errors.push(`${at}: the amount must be more than zero.`);
    else if (l.netPaise % 100 !== 0) errors.push(`${at}: the amount must be in whole rupees.`);
    // A spreadsheet number keeps about 15 digits and drops a leading 0, so either case is written as text.
    const asText = account.startsWith('0') || account.length > 15;
    if (account.startsWith('0')) warnings.push(`${at}: the account number starts with 0, so it is written as text. Check it in the portal.`);
    rows.push([
      mode,
      l.netPaise / 100,
      ddmmyyyy(paymentDate),
      name,
      asText ? account : Number(account),
      tidy(l.email),
      wording.narration,
      Number(debit),
      lineReference(run.month, runType, roll),
      ifsc,
      constant,
      wording.summary,
    ]);
    if (Number.isInteger(l.netPaise) && l.netPaise > 0) totalPaise += l.netPaise;
  });
  return { rows: errors.length ? [] : rows, totalPaise, errors, warnings };
}

const colName = (i) => String.fromCharCode(65 + i);
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// A one-sheet .xlsx with numbers as numbers and everything else as text. Strings are inline, so nothing is guessed back into a
// number or a date.
export function xlsxBytes(sheetName, rows) {
  const body = rows
    .map((row, ri) => {
      const cells = row.map((v, ci) => {
        if (v === null || v === undefined || v === '') return '';
        const ref = `${colName(ci)}${ri + 1}`;
        return typeof v === 'number'
          ? `<c r="${ref}"><v>${v}</v></c>`
          : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(String(v))}</t></is></c>`;
      });
      return `<row r="${ri + 1}">${cells.join('')}</row>`;
    })
    .join('');
  const NS = 'http://schemas.openxmlformats.org/officeDocument/2006';
  return zipSync({
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    ),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${NS}/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${NS}/relationships"><sheets><sheet name="${esc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${NS}/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`),
    'xl/worksheets/sheet1.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`),
  });
}

// -> { bytes, rows, totalPaise, warnings }. Throws, with every problem in the message, when the file must not be made.
export function salaryFileBytes(run) {
  const built = buildSalaryRows(run);
  if (built.errors.length) throw new Error(built.errors.join(' '));
  return { bytes: xlsxBytes('Sheet1', built.rows), rows: built.rows, totalPaise: built.totalPaise, warnings: built.warnings };
}

// The guard before a file is generated. lines: [{ name, account, previousFingerprint }] where `account` is the payee account the
// line would use (status, valid_from, retired_on, fingerprint) or null, and `previousFingerprint` is the fingerprint the
// same person was paid to in the last run (null for a first run).
// -> { blockers, changed }. Any blocker stops the file. `changed` lists people whose account differs from last month: allowed
// when verified, but shown loudly, because a bank merger once changed an account while the old number stayed in the file.
export function payrollBlockers(lines, onDate) {
  const blockers = [];
  const changed = [];
  const reasons = {
    not_verified: 'the bank account is not verified',
    retired: 'the bank account is retired',
    not_yet_valid: 'the bank account is not yet valid',
    superseded: 'the bank account was replaced',
  };
  for (const l of lines) {
    if (!l.account) {
      blockers.push(`${l.name}: no bank account on file.`);
      continue;
    }
    const check = accountPayableOn(l.account, onDate);
    if (!check.payable) blockers.push(`${l.name}: ${reasons[check.reason] ?? 'the bank account cannot be paid'}.`);
    if (l.previousFingerprint && l.previousFingerprint !== l.account.fingerprint) changed.push(`${l.name}: the bank account changed since the last run.`);
  }
  return { blockers, changed };
}
