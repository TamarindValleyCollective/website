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
- **The Axis statement covers the whole life of the account (from inception)**, so it is large. Import every
  line (bank lines are immutable facts, and one balance chain from the first line is the strongest integrity
  check there is), but the history load (session 06) only allocates FY 2024-25 onward. The importer must
  handle thousands of rows within a function's time limit (batch the inserts) and show the first and last date.
  Decide with Sharath if the upload should accept a later, overlapping download and skip lines already held
  (the `dedupe_key` rule already requires this).
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
_Fill in at the end of the session._
