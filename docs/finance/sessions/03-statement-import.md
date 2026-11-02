# 03 Statement import

**Depends on:** 01. **Runs in parallel with:** 04. **Unblocks:** 05.

## Goal
Upload the bank statement and the Paytm UPI export together; get immutable bank lines and UPI lines,
linked by UPI reference, with an honest import summary. No ledger yet.

## Read first
`DESIGN.md` (Imports, Statement import, Risks); the existing bank-statement sheet columns in `FINANCE.md`;
`UPI-SYNC.md` (what the old sync did and why it is being replaced); `contract-storage.ts` for R2.

## In scope
- Tables: `fin_import_batches`, `fin_bank_lines`, `fin_upi_lines`.
- **Parser for the bank statement** (format confirmed from a real sample; one parser per format
  version) and **parser for the Paytm export** (two sheets: Summary and Passbook Payment History;
  columns: date, time, details, counterparty ID, account, amount, UPI reference, order ID, remarks, tag, comment).
- Dedupe by file hash and by `dedupe_key`; the balance-chain check; extraction of the UPI reference
  from narrations (`UPI/P2A|P2M/<12 digits>/…`); linking by reference; unmatched rows stay "awaiting bank".
- UPI rule: keep only rows whose account label matches a bank account's `upi_label`; list ignored rows
  (count and total) on the summary; compute `is_circle` from a configurable tag.
- Upload page and function: drop both files, see the summary, nothing is committed until confirmed.
- Raw files stored in private R2.

## Out of scope
Allocations, categories, parties, rules, history load (06).

## Deliverables
Migration; pure parsers in `scripts/lib/` with tests on **invented** fixtures in the real layouts; the
upload function and page; `FINANCE.md` section.

## How to verify
- Tests: same file twice imports nothing the second time; two identical same-day lines both import;
  a broken balance chain is reported, not guessed; other-bank UPI rows are ignored and counted; a
  Paytm row dated after the last bank line stays awaiting and links after the next bank import.
- With a real anonymised file, run locally and compare counts to the sheet.

## What Sharath has told us (2026-11-02)
- **Both files will be Excel (`.xlsx`).** The repo has no Excel-reading dependency today. Choose one deliberately
  (a maintained reader, or a small reader of the file format) and say why in the PR; keep it server-side only.
  Excel dates may arrive as serial numbers or as text, and amounts as numbers or text with commas: handle each
  and test them on invented fixtures.
- **The Axis statement comes as one Excel file per calendar year, from the start of the account** (2022 onward; the
  current year's file runs to the download date). The importer accepts **several files at once or one at a time, in
  any order**, and treats **each year as its own batch** (own period, opening and closing balance, file hash). It
  checks the balance chain **across year boundaries**: one year's closing balance must equal the next year's opening
  balance, and a mismatch blocks the file being imported. It **reports any gap or overlap between years** (with the
  dates) **instead of guessing**: a gap is shown and closes when the missing year arrives; an overlap is only accepted
  when it agrees exactly with what is held. It still **skips lines already held** (`dedupe_key`), and the same file is
  never imported twice.
- **The Axis statement covers the whole life of the account (from inception)**, so it is large. Import every
  line (bank lines are immutable facts, and one balance chain from the first line is the strongest integrity
  check there is), but the history load (session 06) only allocates FY 2024-25 onward. The importer must
  handle thousands of rows within a function's time limit (batch the inserts) and show the first and last date.
  **Confirmed: the upload accepts a later, overlapping download** (a fresh statement each month) and adds only the
  lines not already held, using the `dedupe_key` rule. The summary says how many were new and how many were already there.
- **A bank API integration was planned but has not progressed**, so statement files are the path for now. Keep the
  door open: split the work into (1) parsing a file into plain normalised lines and (2) a source-independent step
  that dedupes, checks the balance chain and stores them, with the source (`axis_statement`, later perhaps
  `axis_api`) recorded on the batch. A future API feed would then call step 2 and reuse everything else. Do not
  build any API client or speculative code for it.
- **The Paytm export covers this financial year only**, because the company account has been used only
  since 31 Aug 2026. Earlier UPI debits (April to August 2026) have only the bank narration, so their UPI
  lines never exist and must not be reported as "awaiting bank" forever: say so on the summary.

## Needs from Sharath
**A real, current bank statement download and the Paytm export** (both Excel), with a few lines changed if he prefers.
This is the main blocker. Also confirm the registered account label text the Paytm export uses.

## Docs to update
`FINANCE.md`, `ARCHITECTURE.md`.

## Start prompt
> Read `docs/finance/README.md`, `DESIGN.md` and `sessions/03-statement-import.md`. I will give you a real Axis statement file and a Paytm export; copy them into an empty folder outside the repo, never commit them, and build only invented fixtures. Build session 03 test-first.

## Done
Built 2026-11-02 on branch `finance-03-statement-import` (draft PR). **Migration `0080_finance_statement_import.sql` is
written and NOT applied** (0079 belongs to the open session-04 PR; the two touch different tables and apply in either order).
Verified on a throwaway local Postgres only, never on TVC ERP.

**What exists**
- Step 1, parsing (pure, `scripts/lib/`): `finance-xlsx.mjs` (a small `.xlsx` reader on `fflate`: maintained, zero
  dependencies, server-side only; chosen over SheetJS, whose npm release is stale with known advisories),
  `finance-cells.mjs` (amounts and dates as text or numbers, never floats), `finance-axis-statement.mjs`,
  `finance-paytm.mjs`.
- Step 2, storing (pure, source-independent): `finance-import-plan.mjs` (per-year batches, the balance chain inside a file
  and across years, gaps, overlaps, dedupe) and `finance-upi-plan.mjs` (registered-account filter, ignored rows counted,
  circle flag, linking by reference, the awaiting / unmatched / predates-Paytm summary). A bank API would call step 2.
- `netlify/functions/lib/finance-import.ts` (orchestrates behind an `ImportStore`), `finance-import-store.ts` (Supabase),
  `finance-storage.ts` (private R2, `finance/imports/<batch>.xlsx`), routes in `finance-admin.mts`, page
  `/internal/finance/import/`.
- Tests (`node --test scripts/lib/finance-*.test.mjs`, run by the Finance tests Action): reader, cells, both parsers, the
  plan, the UPI plan, the full flow on an in-memory store, and the endpoint (access, preview writes nothing, audit before
  store). All fixtures are invented, built in the real layouts by `finance-fixtures.mjs`.

**Rules as built**
- Preview then confirm; commit re-plans from the database, so a stale preview cannot store anything the plan would refuse.
- A blocked file is skipped; the rest of the upload goes through. Blocked: unreadable, own chain broken (line reported),
  bank's footer totals disagree, year does not meet its neighbour, overlap that disagrees with what is held, account not
  registered. Reported but allowed: a gap between years.
- Overlap rule: every held line in the period must appear in the file as one run; a line not held may only be new if dated
  on or after the last day held.
- Each file is stored by one database function in one transaction (whole file or nothing); bank lines are immutable; a UPI
  row only ever gains its `bank_line_id`.
- Paytm rows on accounts other than a registered `upi_label` are ignored but counted with their total; ones with a
  reference are stored flagged, ones without are counted only. Bank UPI debits before `fin_entities.paytm_since`
  (seeded 2026-08-31) are reported as "will never have a Paytm row", not as missing.
- Needs a bank account registered first (last four digits plus the Paytm label): a director adds it on the import page.

**Checked on the real files** (read in place, never copied; counts only): five yearly files, 1,376 lines, every balance chain
holds inside each file and across all four year boundaries, bank footer totals agree, no gaps; shuffled upload, re-upload
and one-year-at-a-time all behave. Paytm: 72 rows, 66 on our account all link to a bank line by reference, 6 ignored.
**Not done:** applying the migration, registering the real account, and the real import into TVC ERP (waiting for the go-ahead);
the real R2 write was not exercised (stubbed in tests).
