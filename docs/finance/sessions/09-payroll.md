# 09 Payroll

**Depends on:** 04, 05 (06 for history). **Parallel with:** 08, 10, 12.

## Goal
Compute salaries from attendance, get them confirmed and approved by two people, generate the bank's
bulk-payment file, and split the single bank debit automatically.

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
