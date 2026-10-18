// Exports the three register tabs of the "TVC Spend Summary" workbook to the
// JSON file scripts/import-members.mjs reads:
//
//   node scripts/export-member-sheet.mjs --out /path/outside/the/repo/tabs.json
//
// Member Master's email column (I) holds Google people chips: the cell shows a
// name but carries the person's email. The chip's email is used when there is
// one, otherwise the cell's text (a few cells just have an address typed in).
//
// Needs MEMBER_SHEET_ID and GDRIVE_SERVICE_ACCOUNT_EMAIL /
// GDRIVE_SERVICE_ACCOUNT_PRIVATE_KEY in the environment, and the workbook shared
// with that service account. The
// output contains personal data (emails): write it OUTSIDE the repo. This
// prints counts only, never an address.
import { writeFileSync } from 'node:fs';
import { getSheetCells, getSheetValues } from './lib/google-drive.mjs';

// The workbook's id comes from the environment, not this (public) repo.
const SPREADSHEET_ID = process.env.MEMBER_SHEET_ID;
if (!SPREADSHEET_ID) {
  console.error('Set MEMBER_SHEET_ID to the id of the "TVC Spend Summary" workbook.');
  process.exit(2);
}
const EMAIL_COLUMN = 8; // column I

const args = process.argv.slice(2);
const out = args[args.indexOf('--out') + 1];
if (!args.includes('--out') || !out) {
  console.error('Usage: node scripts/export-member-sheet.mjs --out tabs.json');
  process.exit(2);
}

const masterCells = await getSheetCells(SPREADSHEET_ID, "'Member Master'");
let chipEmails = 0;
const master = masterCells.map((row) =>
  row.map((cell, i) => {
    if (i === EMAIL_COLUMN && cell.emails.length) {
      chipEmails++;
      return cell.emails[0].toLowerCase();
    }
    return cell.text;
  }),
);

const tabs = {
  'Member Master': master,
  'Farm Patta Details': await getSheetValues(SPREADSHEET_ID, "'Farm Patta Details'"),
  'House Patta Details': await getSheetValues(SPREADSHEET_ID, "'House Patta Details'"),
};
writeFileSync(out, JSON.stringify(tabs), { mode: 0o600 });
console.log(`Wrote ${out}: Member Master ${master.length} rows (${chipEmails} emails taken from people chips), ` + `Farm Patta ${tabs['Farm Patta Details'].length} rows, House Patta ${tabs['House Patta Details'].length} rows.`);
