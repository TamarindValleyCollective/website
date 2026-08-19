# UPI Transaction Sync

> **Keep this file up to date.** Whenever how UPI transactions get tracked changes — the sync
> script, sheet layout, trigger cadence, or Drive folder — update this file in the same change.
> See the note in `AGENTS.md`.

## What this is

Not part of tvc.farm's website — a standalone Google Apps Script automation for TVC's internal
finance operations, keeping the "UPI Circle Transactions" tab of the "Funds Transfer Requests"
Google Sheet in sync with BHIM UPI transaction-statement PDFs. Documented here (in the website
repo) only because this is where TVC's other operational tooling docs
(`RAZORPAY.md`, `BUFFER.md`) already live.

## How it works

- **Source**: the BHIM app exports a transaction-history PDF, dropped into the "Bhim
  Transactions" Drive folder (`Finance/Bhim Transactions`, folder ID
  `1dC3MGJz1pyHSbK6v6iTJ9LOxFAp2mWOl`).
- **Script**: a bound Apps Script project ("BHIM UPI Sync") on the "Funds Transfer Requests"
  spreadsheet (ID `1Cfy2fALIDVGuK9YlsWfGDN0uLIrAPtqqbRutrruczI0`).
- **Trigger**: time-driven, every 5 minutes, calling `syncBhimPdfs()`. Apps Script has no native
  "watch this Drive folder" event trigger, so this is a poll — cheap on a quiet run since it
  skips any file whose (lastUpdated, size) fingerprint is already recorded in Script Properties.
- **Per run**: for each new/changed PDF, converts it to a temporary Google Doc via the Drive API
  (to get real text extraction, not OCR — these are text-layer PDFs) and deletes the temp doc
  after reading it; parses transaction lines; dedupes against existing rows by Payment
  ID/Reference Number; appends new rows; then re-sorts the whole "UPI Circle Transactions" tab
  by date/time ascending and rewrites it.
- **Logging**: a "Sync Log" tab on the same spreadsheet, capped at 500 rows.
- **Column scope**: only touches columns A:M (Date … Comments), pinned via `CONFIG.NUM_COLS =
  13` rather than `sheet.getLastColumn()`. Column N on that sheet holds stray in-cell
  payment-screenshot images with a blank header — `getValues()` returns those as a plain object
  that can't be written back, so touching N throws a generic `Service error: Spreadsheets` the
  moment a rewrite includes an image-bearing row. Never widen the column range without checking
  for this.

## History

- **2026-08-15**: original version was a local Python script (`sync_bhim_pdfs.py`) run by a
  macOS launchd agent (`com.tvc.bhim-sync`), watching the Drive-Desktop-mirrored folder locally
  via `WatchPaths`.
- **2026-08-18**: replaced with the Apps Script version above. The local version worked but
  raced Google Drive Desktop's File Provider sync — opening a PDF before it finished downloading
  threw `EDEADLK`, and `WatchPaths` retried every ~15s, sometimes for over 90 minutes before
  succeeding on a given file. Running server-side removes that race entirely, since Apps Script
  only ever sees complete files via the Drive API. Also fixed in the same change: transactions
  previously landed in append order, not chronological — the sort-and-rewrite step above was
  added, and along the way surfaced the column-N image bug described above. The old launchd job,
  its plist, and the local script files were removed once the new version was verified.

## What's NOT covered

Google Pay transactions against the same account — there's no clean way to filter Google Pay's
history down to just the TVC company UPI activity (mixed in with personal spend on the same
app/account). Still manual/unsolved; see the TVC Operations Process Document (Section 8) for the
full picture of UPI tracking gaps.
