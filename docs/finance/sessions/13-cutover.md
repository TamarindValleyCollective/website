# 13 Cutover

**Depends on:** all earlier sessions you intend to rely on. Run last.

## Goal
Run the module and the sheets side by side for a month-end, compare, then retire the tabs and the old sync.

## Read first
`DESIGN.md` (Cutover, Risks); `FINANCE.md`; all earlier Done sections; `UPI-SYNC.md`.

## In scope
- A **parallel-run checklist** for one month-end: upload both statements, allocate, run payroll, raise and pay requests,
  close the month, compare each figure with the sheet.
- A discrepancy log and fixes (rules, categories, parsers).
- After a clean month: switch off the BHIM Apps Script trigger (instructions for the operator), mark the old tabs read-only and
  rename them with an "archived" prefix, update `UPI-SYNC.md` to "retired", update `ARCHITECTURE.md`, the Access screen and `AGENTS.md`.
- A short runbook: the month-end routine, who does what, what to do when an import fails.

## Out of scope
New features. Anything found goes to a new GitHub issue.

## Deliverables
Checklist, discrepancy log, runbook in `FINANCE.md`, updated docs, issues for follow-ups.

## How to verify
Two consecutive clean comparisons (or a written reason for each difference); the farm manager and both directors have done their parts in the module.

## Needs from Sharath
A month-end to run, and the go-ahead to archive the tabs.

## Docs to update
`FINANCE.md`, `UPI-SYNC.md`, `ARCHITECTURE.md`, `AGENTS.md`, changelog.

## Start prompt
> Read `docs/finance/README.md`, `DESIGN.md` and `sessions/13-cutover.md`, and all earlier Done sections. Walk me through the parallel run; do not archive or switch anything off without my explicit go-ahead.

## Done
_Fill in at the end of the session._
