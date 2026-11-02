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
_Fill in at the end of the session._
