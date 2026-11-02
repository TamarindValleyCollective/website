# 08 Payment requests & bills

**Depends on:** 04, 05 (and 06 for real data). **Parallel with:** 09, 10, 12.

## Goal
Replace the transfer-request sheet and the WhatsApp ping: the farm manager raises a request from his
phone or computer, adds new vendors, scans the bill; an approver approves; the request is matched to the bank line.

## Read first
`DESIGN.md` (Payment requests, fin_vouchers, Access `finance-requests`); the sessions 04 and 05 notes;
`contract-storage.ts` (R2); `whatsapp-send.ts` and the template list for notifications.

## In scope
- `fin_payment_requests` and its status flow; the requester-only screens under `finance-requests`
  (mobile first): choose a payee or **add a new vendor** (unverified), amount, mode (NEFT or UPI), purpose, bill.
- **Bill scanner:** camera capture with edge detection and crop, multi-page, upload to private R2 as image/PDF;
  optional extraction of vendor, date and amount for the requester to confirm (Anthropic vision through the
  existing server key, never client-side). Works with the file picker on a computer.
- Approver queue: verify an unverified payee (session 04 screen), approve or reject with a reason, MFA step-up.
- Matching: when a bank line arrives, propose a matching approved request (amount, date, payee) and create the
  allocation with the nature from the request; unmatched approved requests age on data health.
- Notification to the approver on submit (email; WhatsApp only with an approved template).
- Reimbursement requests (cash spent by the requester) require a bill.

## Out of scope
Paying from the app; a vendor bulk file (note it as a follow-up); payroll.

## Deliverables
Migration; matching logic with tests; requester and approver screens; scanner component; `FINANCE.md`.

## How to verify
Tests for the status flow, maker≠checker, matching, and that a requester cannot read the ledger. Try the scanner on a real phone
(this is the part most likely to fail) and on a computer.

## Needs from Sharath
The farm manager trying it; a decision on whether approvals also email or WhatsApp.

## Docs to update
`FINANCE.md`, `ARCHITECTURE.md` (new Anthropic call, R2 prefix), `WHATSAPP.md` if a template is added.

## Start prompt
> Read `docs/finance/README.md`, `DESIGN.md`, `sessions/08-payment-requests-and-bills.md`, and the notes from sessions 04 and 05. Build session 08 in a new worktree. Test the scanner on a real phone before calling it done.

## Done
_Fill in at the end of the session._
