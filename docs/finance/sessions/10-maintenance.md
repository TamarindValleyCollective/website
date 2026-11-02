# 10 Maintenance

**Depends on:** 05 (06 for history). **Parallel with:** 08, 09, 12. Touches the member portal, so read its plan carefully.

## Goal
Maintenance dues and collections per household per year, linked to bank payments, visible to approvers
as a collections dashboard and to each member as their own dues.

## Read first
`DESIGN.md` (Maintenance, Integrations); `docs/plans/member-portal.md` (it defines `maintenance_years` and
`maintenance_dues`, not yet built); `src/pages/members/` and the members functions; `project_member_*` decisions where relevant.

## Decide first (blocks the session)
The portal plan says payment status, including who is overdue, is named and visible to **all members**; the
finance decision is that members see **their own dues only**. Ask Sharath which holds before building anything visible to members.

## In scope
- `maintenance_years` (financial year, flat amount per member or per household as decided, due date, grace) and
  `maintenance_dues` (household × year, derived status), designed once here and used by the portal.
- Proration for part-year members from the joining date (flat amount per member).
- Link bank payments: allocations carry household and year; a payment can cover several years; underpayment and
  overpayment are shown, not hidden.
- Collections dashboard: due, collected, outstanding, percent paid, ageing, by cluster; list of outstanding for approvers.
- **Member's own dues** in the member portal (their session, not the staff model), with the payment details and reference.
- A dues **statement** for a household that can be issued on sale (outstanding balance disclosure).
- Reminders as a draft list for approvers (sending is a follow-up).

## Out of scope
Online payment of maintenance, auto-matching beyond a suggestion, reminders sent automatically.

## Deliverables
Migration; dues and proration logic with tests; the dashboard; the portal "my dues" card; `FINANCE.md`; update the member-portal plan.

## How to verify
Tests for proration, multi-year payments, overpayment, and that a member cannot see another household's dues. Reconcile FY 2025-26
collected to the sheet.

## Needs from Sharath
The visibility decision above; the due date and grace; the per-year amount.

## Docs to update
`FINANCE.md`, `docs/plans/member-portal.md`, `ARCHITECTURE.md`.

## Start prompt
> Read `docs/finance/README.md`, `DESIGN.md`, `sessions/10-maintenance.md`, and `docs/plans/member-portal.md`. First ask me the member-visibility question, then build session 10 test-first.

## Done
_Fill in at the end of the session._
