// Test-only helpers: build INVENTED .xlsx workbooks in the layouts of the Axis "Statement Enquiry" download and the
// Paytm UPI export. Nothing here is a real name, number or amount (this is a public repository). The layouts were
// read from real files; only the shape was kept.
import { zipSync, strToU8 } from 'fflate';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = (i) => {
  let n = i + 1, s = '';
  while (n > 0) { s = String.fromCharCode(65 + ((n - 1) % 26)) + s; n = Math.floor((n - 1) / 26); }
  return s;
};

// sheets: [{ name, rows: (string|number|null)[][] }]. `shared: true` writes strings to sharedStrings.xml (what Excel
// does); otherwise they are inline strings.
export function buildXlsx(sheets, { shared = false } = {}) {
  const sst = [];
  const sstIndex = new Map();
  const files = {
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
  };
  const sheetTags = [];
  const relTags = [];
  sheets.forEach((sheet, si) => {
    const rows = sheet.rows.map((row, ri) => {
      const cells = row.map((v, ci) => {
        if (v === null || v === undefined) return '';
        const ref = `${colName(ci)}${ri + 1}`;
        if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
        if (shared) {
          if (!sstIndex.has(v)) { sstIndex.set(v, sst.length); sst.push(v); }
          return `<c r="${ref}" t="s"><v>${sstIndex.get(v)}</v></c>`;
        }
        return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
      });
      return `<row r="${ri + 1}">${cells.join('')}</row>`;
    });
    files[`xl/worksheets/sheet${si + 1}.xml`] = strToU8(`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join('')}</sheetData></worksheet>`);
    sheetTags.push(`<sheet name="${esc(sheet.name)}" sheetId="${si + 1}" r:id="rId${si + 1}"/>`);
    relTags.push(`<Relationship Id="rId${si + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${si + 1}.xml"/>`);
  });
  if (shared) {
    files['xl/sharedStrings.xml'] = strToU8(`<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${sst.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>`);
    relTags.push(`<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>`);
  }
  files['xl/workbook.xml'] = strToU8(`<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetTags.join('')}</sheets></workbook>`);
  files['xl/_rels/workbook.xml.rels'] = strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relTags.join('')}</Relationships>`);
  return zipSync(files);
}

// "1234567.5" paise-free formatting in the bank's Indian grouping: 12,34,567.50
export function indian(paise) {
  const neg = paise < 0;
  const abs = Math.abs(paise);
  const rupees = String(Math.floor(abs / 100));
  const frac = String(abs % 100).padStart(2, '0');
  const last3 = rupees.slice(-3);
  const rest = rupees.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `${neg ? '-' : ''}${grouped}.${frac}`;
}

const ddmmyyyy = (iso) => iso.split('-').reverse().join('/');

// One Axis statement workbook. txns: [{ date: 'YYYY-MM-DD', narration, dr?: paise, cr?: paise }] in file order.
// Returns { bytes, closing } so a test can chain the next year's opening from it.
export function axisStatement({ from, to, openingPaise, txns, accountNumber = '900000000001234', footer = true, shared = false }) {
  let bal = openingPaise;
  let drTotal = 0, crTotal = 0;
  const body = [['1', '', '', 'OPENING BALANCE', '', '', indian(openingPaise), '', 'TEST BRANCH,CITY [KT]', null, null]];
  txns.forEach((t, i) => {
    const amount = t.dr ?? t.cr;
    bal += t.cr ? t.cr : -t.dr;
    if (t.cr) crTotal += t.cr; else drTotal += t.dr;
    body.push([String(i + 2), ddmmyyyy(t.date), ddmmyyyy(t.valueDate ?? t.date), t.narration, indian(amount), t.cr ? 'CR' : 'DR', indian(bal), '', 'TEST BRANCH,CITY [KT] (123) ', null, null]);
  });
  if (footer) {
    body.push([String(txns.length + 2), '', '', 'TRANSACTION TOTAL DR/CR', `${indian(drTotal)}/${indian(crTotal)}`, '', '', '', 'TEST BRANCH,CITY [KT]', null, null]);
    body.push([String(txns.length + 3), '', '', 'CLOSING BALANCE', '', '', indian(bal), '', 'TEST BRANCH,CITY [KT]', null, null]);
    body.push([' ']);
    body.push(['Unless the constituent notifies the bank immediately of any discrepancy, this statement is taken as correct.']);
  }
  const rows = [
    ['Name :- TEST ENTITY PRIVATE LIMITED'], ['Joint Holder :-- '], ['1 TEST ROAD'], ['TEST TOWN'], ['TEST AREA'], ['TEST CITY'], ['TEST STATE'], ['000000'],
    ['Customer ID', null, '900000001'], ['IFSC Code', null, 'TEST0000001'], ['MICR Code', null, '000000000'], ['Nominee Registered', null, ''],
    ['Registered Mobile No', null, ''], ['Registered Email ID', null, ''], ['PAN', null, ''], ['Scheme', null, 'CA - TEST'], ['Currency', null, 'INR'],
    ['CKYC Number: ', null, '**********0000'],
    [`Statement of Account No - ${accountNumber} for the period (From : ${ddmmyyyy(from)} To : ${ddmmyyyy(to)} )`],
    [null],
    ['S.NO', 'Transaction Date (dd/mm/yyyy)', 'Value Date (dd/mm/yyyy)', 'Particulars', 'Amount(INR)', 'Debit/Credit', 'Balance(INR)', 'Cheque Number', 'Branch Name(SOL)', null, null],
    ...body,
  ];
  return { bytes: buildXlsx([{ name: 'Statement Enquiry', rows }], { shared }), closing: bal };
}

// One Paytm export. rows: [{ date:'YYYY-MM-DD', time, details, other, account, amount (signed paise), ref, orderId?, remarks?, tag? }]
export function paytmExport({ periodText = "1 Apr'26 - 1 Nov'26", accounts = ['Axis Bank - 99'], rows, shared = false }) {
  const summary = [
    [''], [''], [''], [''], ['TEST ENTITY PRIVATE LIMITED'], ['******0000'], ['test@example.invalid'], [''],
    ['Paytm Statement for :', periodText],
    ['Money Paid (Amount in Rs.)', '-0.00'], ['Money Paid (No. of Payments)', '0'], ['Money Received (Amount in Rs.)', '+0.00'], ['Money Received (No. of Payments)', '0'],
    [''],
    ['Accounts', 'Money Paid\n(Amount in Rs.)', 'Money Paid\n(No. of Pmt.)', 'Money Received\n(Amount in Rs.)', 'Money Received\n(No. of Pmt.)'],
    ...accounts.map((a) => [a, '0.00', '0', '0.00', '0']),
    [''], ['All payments done by you on Paytm are listed here.'], ['Notes:'], ['- Self transfer payments are not included.'],
  ];
  const sign = (p) => `${p < 0 ? '-' : '+'}${indian(Math.abs(p))}`;
  const passbook = [
    ['Date', 'Time', 'Transaction Details', 'Other Transaction Details (UPI ID or A/c No)', 'Your Account', 'Amount', 'UPI Ref No.', 'Order ID', 'Remarks', 'Tags', 'Comment'],
    ...rows.map((r) => [ddmmyyyy(r.date), r.time ?? '10:00:00', r.details ?? 'Money sent to Test Payee', r.other ?? 'test@example', r.account ?? accounts[0], sign(r.amount), r.ref, r.orderId ?? null, r.remarks ?? null, r.tag ?? null, null]),
  ];
  return buildXlsx([{ name: 'Summary', rows: summary }, { name: 'Passbook Payment History', rows: passbook }], { shared });
}
