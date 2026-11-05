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
**In progress (started 2026-11-05, branch `worktree-finance-06-history`, PR #530).** Built: `scripts/lib/finance-history.mjs` (tracker parser, four-pass
matcher, label mapping, allocation planner, apply orchestrator, all tested), the command `scripts/load-fin-history.mjs` (dry run, `--apply`, `--out` review
file) and migration `0084_finance_maintenance_year.sql` (maintenance year and household on allocations; **applied to TVC ERP on 2026-11-05**, checked afterwards).
Dry run on the real tracker: 95.3% of rows matched, 783 bank lines would get 1,031 allocations. **Nothing has been written to the ledger.**

Decisions (Sharath, 2026-11-05): the default label mapping, with Farm Project in the Project bucket (placeholder project per year, details to be added
later), member maintenance keeping its year and finding the payer's household, CBDT tax as Income tax. Details in [FINANCE.md](../FINANCE.md), "History load".

Canary run 2026-11-05 (5 lines, 14 allocations), then the full load the same day (783 lines, 1,031 allocations, 0 failed), both verified in the database; three "Donations" rows were then moved from Other income to Operational and miscellaneous.

Still to do: run `--apply`; the month-by-category reconciliation report; load FY 2023-24 if wanted; then the
placeholder-project TODO and the 41 maintenance payments (14 names) that need a household from a person (`--households`).

Deviation from the brief: it says the script creates bank lines and allocations; the bank lines were imported from the statements in session 03, so
this load only matches the tracker to them and creates allocations. Rules are not seeded from the sheet (see FINANCE.md).
