# 11 Auditor workspace

**Depends on:** 05; much better after 08 (bills) and 09 (salary working).

## Goal
Let the auditors answer their own questions: salary working, bills, nature of expenses, and a year pack for the CA.

## Read first
`DESIGN.md` (Auditor workspace, Access); the auditor request pattern in `FINANCE.md`; the notes from 05, 08 and 09.

## In scope
- Auditor grant: `read_only` with `expires_at` (from session 01), an invite flow, and an audit entry for every view and export.
- Pages: Salary working by FY (paid date vs salary month; March-paid-in-April view), Bill coverage, the
  **nature-of-expenses lookup** (paste or upload a list of payments, return nature, party and bill, highlight gaps).
- Year pack export: ledger by account, bank reconciliation, voucher index and a ZIP of bills, and the CA's CSV layout.
- Payee bank details stay hidden from auditors; names are visible.

## Out of scope
Statutory reports, GST, TDS.

## Deliverables
Pages and functions with tests for scoping (an auditor never gets payee bank details or write access, an expired grant fails); export format
documented in `FINANCE.md`.

## How to verify
Replay a real past audit email's three requests against FY 2025-26 data and check each is answerable in the workspace. Try the invite with a second
Google account.

## Needs from Sharath
**The CA's import format** (Tally or Zoho sample) and a willing auditor to try it.

## Docs to update
`FINANCE.md`, `ARCHITECTURE.md`.

## Start prompt
> Read `docs/finance/README.md`, `DESIGN.md` and `sessions/11-auditor-workspace.md`, and the notes from sessions 05, 08 and 09. Build session 11 test-first, starting with the scoping tests.

## Done
_Fill in at the end of the session._
