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
_Fill in at the end of the session._
