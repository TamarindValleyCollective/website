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
**Built 2026-11-05** on branch `worktree-finance-05-ledger` (draft PR #529). Migration `0083_finance_ledger.sql` was **applied to TVC ERP on 2026-11-05**.

What exists: `finance-allocation.mjs` and `finance-rules.mjs` (pure, tested); `lib/finance-ledger.ts` with its routes in
`finance-admin.mts`; the Ledger page (to allocate, to review, all; split editor; refunds; bulk apply; months and close) and the Rules
page (rules, categories with merge, the requester); the Overview's "Needs you" counts. Details in [FINANCE.md](../FINANCE.md), "Ledger".

Verified: unit tests, an endpoint test through the real function, the migration's guards on a throwaway Postgres, and the pages in a
browser against invented data. **Not verified:** a person working real lines through the screens, the light appearance, or a phone. Running locally against the real database with real sign-in since 2026-11-05.

Deviations from the brief: `fin_vouchers` is a table only, so "reimbursement without a bill" flags every reimbursement until session 08;
a UPI-id rule condition is not offered (the Paytm import keeps no UPI id); recategorising a category's entries has a route but no screen.

Added after the first look at real data: suggestions for every line (category, party, wording) from the narration, the register and what was posted before, one-click "post the confident ones", and adding a new party from the editor. See FINANCE.md, "Suggestions".

Needs from Sharath: which rule results should always be reviewed (today only the five flags, plus a per-rule switch), and a trial run on
one real month before 06 loads history.
