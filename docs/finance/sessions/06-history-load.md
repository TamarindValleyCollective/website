# 06 History load

**Depends on:** 05. **Unblocks:** 07 and the parallel sessions (they need real data to feel right).

## Goal
Load FY 2024-25 to today into the module and prove it agrees with the sheet.

## Read first
`DESIGN.md` (Cutover); `FINANCE.md`; the notes from 03 to 05. Read the workbook with the service account
described in the operator's setup; the key is a secret and must never be printed.

## In scope
- A one-off, **dry-run-by-default** script outside the request path: reads the bank tab and the 2024-27
  tracker, creates bank lines and allocations, and carries each row's old type, details, remarks and period.
- Seeds `fin_rules` from the labelled history; maps old "Details" and "Type" to categories; creates the
  "Maintenance (YY-YY)" payments as allocations with a period, ready for session 10 to link to dues.
- Salary: expand the single-debit rows already split by hand; keep them as the sheet had them.
- A **reconciliation report**: totals by month and category in the module vs the sheet, with every difference
  listed and explained or fixed; unmapped and untyped rows listed for Sharath.
- Loads the Paytm history that exists (from 31 Aug 2026).

## Out of scope
Dashboards (07), anything before FY 2024-25.

## Deliverables
The script and its tests (on invented tables), the reconciliation report, and the loaded data in the TVC ERP
project (after Sharath approves a dry-run).

## How to verify
Reconciliation totals match to the rupee or each difference has a written reason. Re-running the script changes nothing.

## Needs from Sharath
Time to review the differences; decisions on untyped rows.

## Docs to update
`FINANCE.md` (what was loaded and what was not).

## Start prompt
> Read `docs/finance/README.md`, `DESIGN.md` and `sessions/06-history-load.md`. Write the history-load script as a dry run first. Never print the key file, account numbers, or the sheet contents; print counts and differences only.

## Done
_Fill in at the end of the session._
