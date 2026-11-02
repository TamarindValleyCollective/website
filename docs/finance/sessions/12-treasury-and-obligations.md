# 12 Treasury & obligations

**Depends on:** 05 (07 for the screens). **Parallel with:** 08, 09, 10.

## Goal
The smaller money items the sheets handle badly: the sinking fund, recurring bills, the hospitality partner's share, event receipts and refunds.

## Read first
`DESIGN.md` (fin_fixed_deposits, fin_obligations, fin_accruals, Hospitality partner share, Refunds); `PARTNER-API.md` (planned settlement ledger);
`RAZORPAY.md` and `event-payments-db.mjs`; the notes from 05 and 07.

## Decide first
The base of the partner's share (gross receipts or net of fees), whether it accrues monthly, and how it relates to the partner settlement ledger
(one source of truth). Ask Sharath.

## In scope
- **Fixed deposits** register with maturity calendar, interest earned and the lines that created and closed each deposit; import the current five-ish FDs.
- **Recurring obligations** (internet lines, power, domains, Workspace): expected amount and cadence, next due, matched to bank lines, overdue on data health.
- **Partner share accrual**: monthly accrual job, settled by the year-end payment; a payable shown on the dashboard.
- **Event and stay receipts**: read `event_payments`, show revenue by event, and reconcile Razorpay settlement credits to bank lines.
- **Refunds**: reversing allocation with reason; link to the original payment; list on data health.

## Out of scope
GST, TDS, partner statements (owned by the partner API work).

## Deliverables
Migration; accrual and maturity logic with tests; screens; `FINANCE.md`.

## How to verify
Tests for accrual arithmetic, maturity dates, a refund netting to zero, and matching of a settlement credit. Check against the sheet's sinking fund tab.

## Needs from Sharath
The decisions above.

## Docs to update
`FINANCE.md`, `RAZORPAY.md`, `PARTNER-API.md` if the ledger boundary changes, `ARCHITECTURE.md`.

## Start prompt
> Read `docs/finance/README.md`, `DESIGN.md` and `sessions/12-treasury-and-obligations.md`. First ask me the partner-share questions, then build session 12 test-first.

## Done
_Fill in at the end of the session._
