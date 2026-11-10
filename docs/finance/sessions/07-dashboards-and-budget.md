# 07 Dashboards & budget

**Depends on:** 06 and 02 (the approved mockup). The first thing Sharath sees that was hard to do in the sheets.

## Goal
Cashflow, budget vs actual, the circle gauge and data health, on real data, plus the budget itself.

## Read first
`DESIGN.md` (Dashboards); the approved mockup and its "agreed changes" in session 02's Done section;
`/internal/usage` for the shell; the `dataviz` skill.

## In scope
- Tables `fin_budget_years`, `fin_budget_lines` with revisions and monthly phasing; import the existing budget
  plan for the current year (script, dry-run first); a budget editor for `configure`.
- SQL views or a read function producing each metric exactly as DESIGN.md defines it; one place for the formulas.
- Screens: Cashflow (with runway), Budget vs actual (budget, actual, committed, remaining, run-rate estimate),
  UPI circle month-to-date vs ₹15,000, Data health. Chart colours from `--tvc-*` tokens; works in dark mode.
- Export of any table to CSV.

## Out of scope
Maintenance (10), sinking fund and revenue (12), auditor pages (11).

## Deliverables
Migration; metric logic with tests on invented ledgers; screens; `FINANCE.md` definitions.

## How to verify
Tests for runway, period vs cash grouping, reversals netting, and calendar-month cap. Compare each figure with
the sheet for FY 2025-26 and explain any difference. Check both appearances and phone width.

## Needs from Sharath
Review against the sheet's numbers.

## Docs to update
`FINANCE.md`, `ARCHITECTURE.md`.

## Start prompt
> Read `docs/finance/README.md`, `DESIGN.md`, `sessions/07-dashboards-and-budget.md`, and the approved mockup notes in session 02. Build session 07 test-first; write the metric definitions once and reuse them.

## Done
**First slice, 2026-11-10 (draft PR).** Built test-first and tested; not yet seen in a browser with a real sign-in.

- Decisions confirmed by the owner before starting: runway is bank balance ÷ average monthly *spending* (not net outflow); the budget is grouped by the
  presentation's heads (Company, Farm, Projects, Investment); the member view of some of these figures is a **preview feature** for chosen homes, not open to everyone.
- Built: migration `0098` (heads on categories, `is_salary`, budget versions and lines, approval function) **not yet applied**, tested rolled back against the
  real database; `finance-metrics.mjs` (the formulas, once); `GET /api/finance-admin/dashboard`; the page `/internal/finance/dashboard/` with the year selector.
  See `FINANCE.md`, "Dashboards", for the rules and the tests.
- **Not built yet:** the budget editor and the import of the existing plan (so the Budget view is empty until a budget exists), CSV export, the member-portal
  preview (a `finance` member feature for chosen homes), a select for a category's head on the Rules page, and the Maintenance and Advances views (sessions 10
  and 09). **Committed** is a total, not per budget line, because a payment request carries no category.
- **Before merging:** apply `0098` (the code tolerates it missing, so order is not critical); open the page signed in on the deployed or local site and compare
  the figures with the sheet for FY 2025-26, explaining any difference (this is the brief's "how to verify" and needs the owner).
