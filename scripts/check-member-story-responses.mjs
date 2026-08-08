#!/usr/bin/env node
// Reads the "TVC Members: Your Story" response Sheet via the Sheets API
// instead of clicking through the Sheets UI, and reports which rows are
// new/updated since they were last folded into MembersView.astro - see
// the "Processed at" / "Notes" columns added to the Sheet on 2026-08-08.
// A row needs (re)processing whenever its Timestamp doesn't match its own
// "Processed at" value (blank counts as never processed) - editing a form
// response overwrites the same row and bumps its Timestamp, it doesn't
// append a new one, so this catches edits too, not just first submissions.
//
// Usage:
//   node scripts/check-member-story-responses.mjs            # list rows needing (re)processing
//   node scripts/check-member-story-responses.mjs mark <row>  # mark that row processed now
//
// Requires the same .env vars as the other google-drive.mjs scripts
// (GDRIVE_SERVICE_ACCOUNT_EMAIL/_PRIVATE_KEY). The Sheet must be shared
// with that service account as an Editor (needed for `mark`, not just
// reading) - see RAZORPAY.md-style docs note in ARCHITECTURE.md.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSheetValues, updateSheetValues } from './lib/google-drive.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const envPath = path.join(root, '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);

const SPREADSHEET_ID = '1rjl8AewOrHCD09_ffK3X6toq79mXvBu0rRkM2POEvKo';
const SHEET_NAME = 'Form responses 1';
const RANGE = `'${SHEET_NAME}'!A:L`;

// Column headers as the Form actually writes them, mapped to short keys -
// looked up by name rather than hardcoded letters so a reordered/renamed
// Form question doesn't silently misalign the data.
const COLUMNS = {
  timestamp: 'Timestamp',
  email: 'Email address',
  name: 'Name',
  today: 'What do you do today?',
  family: 'Family',
  whyTVC: 'In one sentence, why are you part of TVC?',
  more: "Anything more you'd like to share about what drew you in or what keeps you here",
  social: "LinkedIn (or another social profile, if you'd rather)",
  photo: 'Photo (only if missing or updating one)',
  consent: 'OK to publish your name, photo, quote, and link on the public TVC website?',
  processedAt: 'Processed at',
  notes: 'Notes',
};

async function loadRows() {
  const grid = await getSheetValues(SPREADSHEET_ID, RANGE);
  const [header, ...rows] = grid;
  const index = Object.fromEntries(
    Object.entries(COLUMNS).map(([key, label]) => [key, header.indexOf(label)])
  );
  return rows.map((row, i) => ({
    rowNumber: i + 2, // +1 for the header row, +1 for 1-indexing
    get: (key) => row[index[key]] ?? '',
  }));
}

function needsProcessing(row) {
  const timestamp = row.get('timestamp');
  const processedAt = row.get('processedAt');
  return Boolean(timestamp) && timestamp !== processedAt;
}

function printRow(row) {
  const consent = row.get('consent');
  console.log(`\nRow ${row.rowNumber} — ${row.get('name')} (${row.get('email')})`);
  console.log(`  Timestamp: ${row.get('timestamp')}`);
  console.log(`  Consent to publish: ${consent}${consent !== 'Yes' ? '  ⚠️  do not publish until this is Yes' : ''}`);
  console.log(`  What do you do today: ${row.get('today')}`);
  if (row.get('family')) console.log(`  Family: ${row.get('family')}`);
  console.log(`  Why TVC: ${row.get('whyTVC')}`);
  if (row.get('more')) console.log(`  Anything more: ${row.get('more')}`);
  if (row.get('social')) console.log(`  Social: ${row.get('social')}`);
  if (row.get('photo')) console.log(`  Photo: ${row.get('photo')}`);
}

async function list() {
  const rows = await loadRows();
  const pending = rows.filter(needsProcessing);
  if (pending.length === 0) {
    console.log('No new or updated responses since the last processed run.');
    return;
  }
  console.log(`${pending.length} response(s) need (re)processing:`);
  pending.forEach(printRow);
}

async function mark(rowNumber, note) {
  const rows = await loadRows();
  const row = rows.find((r) => r.rowNumber === rowNumber);
  if (!row) throw new Error(`No data row ${rowNumber} found`);
  await updateSheetValues(SPREADSHEET_ID, `'${SHEET_NAME}'!K${rowNumber}:L${rowNumber}`, [
    row.get('timestamp'),
    note ?? '',
  ]);
  console.log(`Marked row ${rowNumber} (${row.get('name')}) processed at ${row.get('timestamp')}.`);
}

const [command, ...args] = process.argv.slice(2);
if (command === 'mark') {
  const rowNumber = Number(args[0]);
  if (!rowNumber) throw new Error('Usage: node scripts/check-member-story-responses.mjs mark <row> [note]');
  await mark(rowNumber, args.slice(1).join(' '));
} else {
  await list();
}
