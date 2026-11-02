# 04 Parties & payees

**Depends on:** 01. **Runs in parallel with:** 03. **Unblocks:** 05, 08, 09.

## Goal
One directory of everyone TVC pays or receives from, with payee bank details that are verified, never
overwritten and never casually visible.

## Read first
`DESIGN.md` (fin_parties, fin_party_accounts, Access masking, Risks); `staff-masking.ts`; how MFA secrets
are encrypted (`staff-mfa-crypto.ts`) and reuse that approach; the member tables (to link member parties).

## In scope
- Tables `fin_parties`, `fin_party_accounts` (status, history, encrypted account numbers, `verified_by`).
- Directory page: search, add, edit name/kind, add new bank or UPI details (always `unverified`), supersede old details.
- Verification screen for `verify-payee` holders with MFA step-up: shows details once, to confirm.
- Import of the existing beneficiary and account lists into parties **as a script run by an operator**,
  all details `unverified` until confirmed; link member parties to households; employees are parties of kind `employee`.
- Duplicate-detection: two parties sharing one account number is flagged, not blocked.
- Audit every create, change and verification.

## Out of scope
Payment requests (08), payroll (09), allocation.

## Deliverables
Migration; encryption helper with tests; directory and verification screens; import script (dry-run by default); `FINANCE.md`.

## How to verify
- Tests: changing details creates a new unverified row and keeps the old one; account numbers never appear in
  responses to roles without `verify-payee`, in logs, or in the audit `detail`; a shared account is flagged.
- Local run with invented parties.

## Needs from Sharath
Review of the imported party list and which of the shared-account cases are intended.

## Docs to update
`FINANCE.md`, `ARCHITECTURE.md`.

## Start prompt
> Read `docs/finance/README.md`, `DESIGN.md` and `sessions/04-parties-and-payees.md`. Build session 04 test-first. Do not put any real account numbers in the repo; the import script takes real files from outside the repo.

## Done
**Built 2026-11-02** on branch `finance-04-parties` (test-first; 63 finance tests pass).

- Migration `0079_finance_parties.sql`, `scripts/lib/finance-parties.mjs` (rules), `finance-party-import.mjs` (import planner),
  `netlify/functions/lib/finance-parties.ts` (routes), `encryptFinanceText`/`fingerprintFinanceText` in `staff-mfa-crypto.ts`,
  the `/internal/finance/parties/` page, and the operator script `scripts/import-fin-parties.mjs`. Details in [FINANCE.md](../FINANCE.md).

**Verified:** unit tests for the rules, the planner and the encryption; an endpoint test driving the real function through
`requireStaff` (changed details keep the old row, no number in responses or audit rows, reveal and verify need the step-up,
a reveal that cannot be logged returns nothing, the enterer cannot verify, shared accounts flagged). The migration's guard
trigger and constraints were exercised in a throwaway local Postgres (overwrite, delete, un-verify, revive and double
household link are all refused). `npm run lint:css` and `astro check` are clean for the new files.

**Real lists (dry run, 2026-11-02):** the existing details are in four partial places: the `Axis Bank Registered Accounts` tab
(no IFSC), the `Accounts (2022-23)` tab, the `Fund Transfer Request` tab of the Funds Transfer Requests workbook, and
`Axis Bank Beneficiaries.xlsx` (the bank's own export, with IFSC; read from a copy saved as a Google Sheet, which turned a
few long account numbers into scientific notation). A local dry run of the planner on all four, merged in that order,
gave 123 parties and 118 accounts (114 bank accounts with an IFSC, 3 without), 12 rows with bad details, 1 shared-account
case, and 102 accounts that appear under different names in different lists (the first list's name wins). Nothing was
written; the numbers came from reading the sheets with a read-only key and printing counts only.

**Not verified:** the page has not been rendered in a browser or tried signed in; the import script's `--apply` path and its
reading of the real sheet have not been run (no credentials or real sheet here, and the real column layout has not been
seen: the loose header matching is an assumption); migration `0079` has not been applied to TVC ERP; nothing was tested
with a real step-up token from a browser.

**Left for Sharath / next steps:** share the beneficiary sheet with the service account and run the dry run, then review the
shared-account cases and the party list; apply `0079` before merging; try the page locally with `netlify dev --port 8888`;
the farm manager's add-vendor screen is session 08.
