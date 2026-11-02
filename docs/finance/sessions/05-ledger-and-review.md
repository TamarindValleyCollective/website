# 05 Ledger & review

**Depends on:** 03 and 04. **Unblocks:** 06, then everything else. This replaces the two tabs Sharath fills in every month.

## Goal
Turn bank lines into explained ledger entries: allocations, splits, rules, the review queue and period close.

## Read first
`DESIGN.md` (Ledger, Allocation and review, Period close, Principles); the sessions 03 and 04 notes in this folder.

## In scope
- Tables `fin_allocations`, `fin_vouchers` (table only), `fin_rules`; the "allocations sum to the line" posting trigger.
- Ledger screen: unallocated first; filters by date, account, party, category, state; an allocation editor with
  a **split** view (add rows until the remainder is zero) and bulk apply.
- Rules engine (pure, tested): match narration pattern, payee ID, remark keywords, direction, amount range;
  produce party, category, nature; flag `needs_review` per rule. UPI remarks seed `nature`.
- Review queue and the flags in DESIGN.md: unexplained, circle payment to a requester's own name, new or
  changed payee account, reimbursement without a bill.
- Reimbursement handling: a payment to the requester's own party is a reimbursement, category from the remark.
- Periods: `period` on every allocation; close a month; override needs `close-period` and a reason.
- Refund/reversal allocation (`reverses_allocation_id`).

## Out of scope
Importing history (06), vouchers capture UI (08), payroll-generated allocations (09), dashboards (07).

## Deliverables
Migration; rules engine and posting logic with tests; ledger and review screens; `FINANCE.md`.

## How to verify
- Tests: posting refuses a sum mismatch; a split of one debit into many posts; a reversal nets to zero; a closed
  period rejects without the capability; rules precedence; flags fire as specified.
- Load invented lines and walk a month end to end.

## Needs from Sharath
Sign-off on the category list and on which rule results should always be reviewed.

## Docs to update
`FINANCE.md`, `ARCHITECTURE.md`.

## Start prompt
> Read `docs/finance/README.md`, `DESIGN.md` and `sessions/05-ledger-and-review.md`, plus the notes in sessions 03 and 04. Build session 05 test-first with the tdd skill, starting from the posting trigger and the rules engine.

## Done
_Fill in at the end of the session._
