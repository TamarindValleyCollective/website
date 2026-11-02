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
_Fill in at the end of the session._
