# 08 Payment requests & bills

**Depends on:** 04, 05 (and 06 for real data). **Parallel with:** 09, 10, 12.

## Goal
Replace the transfer-request sheet and the WhatsApp ping: the farm manager raises a request from his
phone or computer, adds new vendors, scans the bill; an approver approves; the request is matched to the bank line.

## Read first
`DESIGN.md` (Payment requests, fin_vouchers, Access `finance-requests`); the sessions 04 and 05 notes;
`contract-storage.ts` (R2); `whatsapp-send.ts` and the template list for notifications.
Also the sections of `FINANCE.md` on the UPI page, payment notes, reversed payments and source badges (built after
this brief was first written; the decisions below depend on them), and `UPI-SYNC.md`.

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

## Decisions added 2026-11-07 (these change the scope above)

The recipient and purpose of a payment must **live in this module** and the UPI page and the ledger **pull them from here**.
They are not imported from the old Google Sheet by a one-off screen: that would make a second source of truth.

1. **Two kinds of record, one set of fields** (payee or recipient, amount, mode, purpose, bill or payment screenshot):
   - a **request**, raised before paying and approved (the flow above);
   - a **log** of a spend already made: a delegated (UPI Circle) payment or a direct UPI payment, recorded afterwards by
     whoever paid, with recipient, purpose and a screenshot of the payment. A log needs no approval; a log whose recipient
     is the requester's own party is flagged for review, as a circle payment to the requester already is.
2. **Pull, don't import.** A request or log is matched to a UPI row and a bank line and its purpose then shows on the UPI page
   and in the ledger (as the default wording, in italics, until a person writes a payment note: the same behaviour as a
   Paytm remark, see the payment-note rules in `FINANCE.md`). The payment note (`fin_payment_notes`, keyed on the UPI
   reference) stays as the manual override and is not replaced.
3. **How a match is made.** Exactly, by the 12-digit UPI reference when the log has it: typed, or read off the screenshot by the
   same vision call as the bill extraction (the requester confirms it). Otherwise propose a match by amount, date and payee
   and let a person accept it; never link on a guess. The reference joins a log to its UPI row and to its bank line, so one
   record serves both pages. A bank line the bank reversed (see "Reversed payments" in `FINANCE.md`) needs no log.
4. **History is loaded into this module once**, as already-paid historical requests and logs, from the two tabs of the old
   transfer-request sheet (one holds NEFT-style requests: date, payee, amount, bank details, purpose, status, reference;
   the other holds delegated UPI payments: recipient, comment and a screenshot). Do it with an operator script, not a
   screen: the sheet is read through the service account in the global Google instructions, a pure parser lives in
   `scripts/lib` with tests on **invented** rows, and nothing from the real sheet (names, amounts, references, counts) goes into
   the repository, a PR, a commit message or a doc. Known quirks: the sheet drops leading zeros from references (pad to 12
   digits); rows whose status is a failure moved no money and are skipped; rows paid from a bank account that is not the
   company's (a personal account) are skipped; the sheet's direction column is not the direction of the money (a row with no
   bank named is a delegated payment out). Matching on load uses the exact reference first. Bank details in the legacy tab
   are payee account numbers: they go to the encrypted payee accounts of session 04, never into notes or the audit log.
5. **Who paid.** Every UPI download is in the operator's name, so no file says which delegate paid. A log records the delegate
   (a field), and the spend allowance can later be counted per delegate. Do not build the per-delegate limit here; do store
   who paid.
6. **Order of work.** First slice: the data model, raising a request and logging a spend, the one-time history load, matching to
   UPI rows and bank lines, and showing the purpose on the UPI page and the ledger. The bill scanner and the approver
   queue polish come after, and the scanner still needs a real phone to verify.

Where things stand when this session starts: the UPI page and payment notes are live; the ledger and the UPI page link to
each other by UPI reference; this module is still a placeholder page.

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
> Read `docs/finance/README.md`, `DESIGN.md`, `sessions/08-payment-requests-and-bills.md`, and the notes from sessions 04 and 05. Also read `FINANCE.md` on the UPI page, payment notes and reversed payments, and the "Decisions added 2026-11-07" in the brief. Build session 08 in a new worktree. Test the scanner on a real phone before calling it done.

## Done
**First slice built 2026-11-07** (branch `finance-08-requests`, draft PR). Migration `0092` was checked in a rolled-back block, then **applied to TVC ERP on 2026-11-07** (recorded as `finance_payment_requests`; afterwards: table empty, RLS on, no anon/authenticated grants, voucher columns present).
Built: `fin_payment_requests` (requests and logs, one set of fields) and voucher support; the requester page and the approvals page; raise, log, add vendor, attach a file, approve with the unlock, reject with a reason, cancel, accept a suggested match, unmatch, clear the own-party flag; exact-reference matching; the purpose pulled into the UPI page and the ledger; the one-time history loader. Details and the access rules are in `FINANCE.md`.
Verified: unit tests for validation, the status flow, maker-is-not-checker, matching, planning and the sheet parser; endpoint tests through the real function for access (the farm manager's module opens nothing in finance; a requester cannot attach to someone else's record, which caught a real bug), audit-before-write, the step-up and file sniffing; stylelint. The loader's parser was run read-only against the real sheet (counts only).
Not verified: the pages in a browser or on a phone; R2 upload and download; the approval email; the loader's `--apply`; the ledger and UPI page with real linked records.
Left: the bill scanner and vision extraction (needs a real phone), approver-queue polish, a decision on whether approvals also email or WhatsApp, the farm manager trying it.
