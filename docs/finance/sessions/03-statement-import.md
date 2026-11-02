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

## Needs from Sharath
**A real, current bank statement download** (and say which format he downloads), with a few lines changed if he prefers. This is the
main blocker. Also confirm the registered account label text the Paytm export uses.

## Docs to update
`FINANCE.md`, `ARCHITECTURE.md`.

## Start prompt
> Read `docs/finance/README.md`, `DESIGN.md` and `sessions/03-statement-import.md`. I will give you a real Axis statement file and a Paytm export; copy them into an empty folder outside the repo, never commit them, and build only invented fixtures. Build session 03 test-first.

## Done
_Fill in at the end of the session._
