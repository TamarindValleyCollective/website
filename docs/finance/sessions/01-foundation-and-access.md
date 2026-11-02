# 01 Foundation & access

**Depends on:** nothing. **Unblocks:** everything.

## Goal
An empty but secured finance module: the two registry modules, the access rules, the shared tables,
an audit log and a skeleton page, plus the project vocabulary.

## Read first
`AGENTS.md`; `DESIGN.md` (Access, Reference tables, Principles); `supabase/migrations/0028_staff_access.sql`;
`netlify/functions/lib/staff-registry.ts`, `staff-access.ts`, `staff-masking.ts`; `netlify/functions/staff-admin.mts`
and the Access page (`src/pages/internal/access.astro`); `usage-admin.mts` as the model of a small module.

## In scope
- Add `finance` and `finance-requests` to `MODULES` and `MODULE_INFO` with the capabilities in DESIGN.md.
- Add an optional `expires_at` to `staff_module_roles` (for auditors); make `requireStaff` honour it and
  show it on the Access screen. Add a finance masking policy (names visible, payee bank details hidden).
- Migration for the reference tables: `fin_entities`, `fin_bank_accounts`, `fin_categories`, `fin_periods`,
  `fin_audit_log` (append-only trigger, as `staff_audit_log`). RLS on, no policies, anon/authenticated revoked. Seed one entity and the
  agreed category list (from the 2024-27 tracker's "Details"/"Type", with type moved onto the category).
- A finance function with a `ping`/overview endpoint behind `requireStaff`, and `/internal/finance/`
  using `StaffLayout` that shows "No data yet".
- Maker-is-not-checker helper (pure function + tests) for later sessions.
- Create `FINANCE.md` (working reference, as `PARTNER-API.md`) and a short "Finance documentation"
  section in `AGENTS.md`.
- Start `CONTEXT.md` with the finance glossary (bank line, allocation, period, nature, party, voucher, circle) using the `domain-modeling` skill.

## Out of scope
Importing, ledger screens, requests, payroll, dashboards.

## Deliverables
Migration `00NN_finance_foundation.sql`; registry and access changes with tests; the skeleton function and page;
`FINANCE.md`; glossary.

## How to verify
- Unit tests for expiry, the capability matrix, masking and maker≠checker.
- With a test grant: the page loads for `finance` users, 403s for others, and a `finance-requests`
  user cannot reach `finance` endpoints. An expired grant is refused.
- `npm run lint:css`; `astro build`.

## Needs from Sharath
Who gets `finance` (directors), who is the requester, whether the category list matches how he thinks about heads.

## Docs to update
`ARCHITECTURE.md` (new function and tables), `FINANCE.md`, `AGENTS.md`, changelog on merge.

## Start prompt
> Read `docs/finance/README.md`, `DESIGN.md` and `sessions/01-foundation-and-access.md`, then build session 01 in a new worktree and open a draft PR. Follow the README rules. Ask me before applying any migration.

## Done
**Built (2026-11-02, branch `finance-01-foundation`, draft PR):**
- `finance` and `finance-requests` in `MODULES`/`MODULE_INFO` with the DESIGN.md capabilities. Admin-only: `approve`,
  `approve-payroll`, `verify-payee`, `close-period`, `configure`, `export`. `export` is admin-only because the
  design table gives `read_only` `view` only, though the auditor section mentions taking a CA export (open point).
- Migration `0077_finance_foundation.sql`: `staff_module_roles.expires_at`; `fin_entities`, `fin_bank_accounts`,
  `fin_categories`, `fin_periods`, `fin_audit_log` (append-only trigger), RLS on and no policies, anon/authenticated
  revoked; one entity and a **draft** list of 23 generic categories.
- `requireStaff`, `staff-me`, `staff-today` honour `expires_at` (checked per request, not cached). Access screen
  shows and sets the end date on read-only grants (`expiresOn` on `POST /api/staff-admin/roles`, audited).
- `finance-admin.mts` (`GET /api/finance-admin/overview`), `/internal/finance/`, a placeholder `/internal/finance-requests`,
  `netlify.toml` and `DOMAINS.md` entries, icons. Auditor visits are written to `fin_audit_log`, and refused if the
  log fails.
- `scripts/lib/finance-access.mjs`: expiry, `parseExpiry`, `makerIsNotChecker`, `payeeFieldVisibility`, masks.
- `docs/finance/FINANCE.md`, `CONTEXT.md` glossary, `ARCHITECTURE.md`, a `Finance tests` workflow.

**Verified:** 21 unit/endpoint tests pass (`node --test scripts/lib/finance-*.test.mjs`), including: a `finance-requests`
holder gets 403 from the finance endpoint, an expired auditor grant gets 403, a deactivated person gets 403, an
auditor visit is logged and refused if the log fails. `scripts/lib/admin-host-routes.test.mjs` 30/30. `npm run lint:css`
clean. `astro build` passes. **Not verified:** the pages in a browser with a real sign-in, the Access screen's new
date control. Migration 0077 was applied to TVC ERP after Sharath's go-ahead and checked (1 entity, 23 categories, RLS on, no anon grants, `expires_at` null on all grants).

**Follow-up 2026-11-02 (after reading the sheet's structure with Sharath):** the 23 placeholder categories were not
from the sheet. `0078` (applied 2026-11-02) replaces them with 29 heads shaped like the sheet's budget (Opex,
Capex, revenue streams, member maintenance, taxes, movements), makes projects and events first-class
(`fin_projects`, `fin_project_lines`), and drops `project` as a category type. Equity dropped for now. Decisions:
owner is just a name; events are profit-and-loss only; revenue is projected in the budget with maintenance as the
plug. Still open: the 2024-27 tracker file, to be shared at import.

**Left / decisions for Sharath (as first written):** who gets `finance` (directors) and who is the requester; confirm or edit the draft
category list (I did not read the private tracker); whether auditors should get `export`; the category seed lives in
the migration, so edits before applying are free. Real-money rules for later sessions are ready to import:
`makerIsNotChecker`, `payeeFieldVisibility`. Next: sessions 03 and 04 (can run in parallel).
