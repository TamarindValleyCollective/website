# 09 Payroll

**Depends on:** 04, 05 (06 for history). **Parallel with:** 08, 10, 12.

## Goal
Compute salaries from attendance, get them confirmed and approved by two people, generate the bank's
bulk-payment file, and split the single bank debit automatically.

## Decisions (2026-11-05, with the owner)
- **Built in this finance module**, not in the separate ERP: it reuses parties, verified payee accounts and the ledger. The
  ERP's employee policy and financial-operations documents remain the requirements source.
- **Split in two.** **09a** records and pays the run: the farm manager enters each person's *net* amount for the month in the
  app, a director reviews, the farm manager confirms, the file is generated, and the bank debit is matched. **09b** adds
  attendance and the pay arithmetic. 09b waits for the policy gaps the employee policy lists (rounding, work on a weekly
  off, what counts as full attendance, advances); until then the farm manager keeps working the pay out in his own sheet
  and 09a records the result, with optional fields for agreed pay, days worked and advance deducted so nothing needs
  re-entering later.
- **People (roles, no names here):** the farm manager enters and confirms; the preparer (a director) reviews and generates the
  file; a second director approves in the bank's portal and is also an approver in the app (`approve-payroll`, never the
  preparer). Salary pages are for these three only.
- **Today's process this replaces:** the farm manager fills a shared sheet (one tab per month, one row per person), the preparer
  copies it into a local Excel file for the bank's bulk portal, sends a screenshot of the uploaded batch to the farm manager for
  confirmation, then asks the second director to approve in the bank's maker-checker.
- **Why the confirmation step exists:** a bank merger changed a payee's account while the old number stayed in the file; the money
  left and was never credited. So the file may use only *verified* payee accounts, the confirmation lists exactly what will be
  in the file (accounts as last four digits), and "account changed since the last run" is shown loudly.
- **Facts to design for:** the bank settles the batch as ONE debit (the ledger already holds it as one allocation per person on
  that line, entered by hand from the tracker); the statement narration does not say "salary", so match on the total and the
  date window, never the text; a payment date that differs from the processing date makes the portal reject the whole batch, so
  validate it; two people can share one bank account (two parties on one payee account); a returned payment is a refund of that
  one person's allocation.
- **Build order for 09a:** (1) import the existing monthly tabs as history runs, which also gives the salary allocations their
  party; (2) the run screens and the file export; (3) settlement matching and returns.
- **Still needed:** one real file the bank's portal accepts, or its template (the sheet has no header row; what the payment-mode
  code and the reference code mean must come from the bank's layout).

## Read first
`DESIGN.md` (Payroll, fin_employees and related tables, Access); the sessions 04 and 05 notes; the payroll
workbook layout as described in `FINANCE.md`.

## In scope
- Tables `fin_employees`, `fin_salary_terms` (with history), `fin_attendance`, `fin_holidays`, `fin_advances`,
  `fin_payroll_runs`, `fin_payroll_lines`, `fin_payment_batches` (kind `salary`).
- **Pure payroll arithmetic** (tested to death): rate = agreed pay ÷ working days; pay = rate × days worked;
  holidays are paid but reduce working days; Sunday off; half day 0.5; a worker present every working day earns a
  paid day the next month; advances deducted at the agreed monthly amount; other adjustments (bonus).
- Attendance entry on a phone-friendly grid for the requester; import of the existing roster for the current year.
- Run states: draft, **confirmed** by the requester, **file generated** by the preparer, **approved** by a different
  director at the bank, **settled** when the bank line is matched.
- **Bulk file generator** in the bank's layout (from the real template), with date validation and a guard that
  blocks generation if any payee's details changed since last run and are unverified.
- Settlement matching: one bank debit ↔ one batch; the per-line reference creates one allocation per person with
  `period` = salary month, source `payroll`.
- Salary working report per FY (also used by session 11).

## Out of scope
Payslips, PF or TDS, leave policies beyond the paid-day rule, other pay schemes.

## Deliverables
Migration; payroll logic and file generator with tests; screens; `FINANCE.md`.

## How to verify
Recompute three real months from the workbook and match to the rupee (with the real inputs kept outside the repo). Tests: leap
month, a month with many holidays, half days, an advance running out, a changed payee blocks generation, preparer cannot approve, a settled run
creates allocations with the right period.

## Needs from Sharath
**The bank's bulk-upload template** (or a sample file) and the date rules; the roster for the current year.

## Docs to update
`FINANCE.md`, `ARCHITECTURE.md`.

## Start prompt
> Read `docs/finance/README.md`, `DESIGN.md`, `sessions/09-payroll.md`, and the notes from sessions 04 and 05. Build session 09 test-first with the tdd skill, starting from the pure payroll arithmetic. Real salary figures and the real template stay outside the repo.

## Done
_Fill in at the end of the session._
