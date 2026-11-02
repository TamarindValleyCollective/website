# Finance module: working reference

What is actually built and how it behaves, kept current as sessions land. The intent and the full data
model are in [DESIGN.md](DESIGN.md); how to build it is in [README.md](README.md). If this file and
`DESIGN.md` disagree about what exists, this file is right and the design is the plan.

**Public repository: no names, account numbers, UPI IDs, salaries or amounts here.** Roles only.

## Status

| Session | State |
|---|---|
| 01 Foundation & access | Built on branch `finance-01-foundation` (draft PR). Migration `0077` **applied to TVC ERP on 2026-11-02**. |
| 01 follow-up | `0078_finance_categories_and_projects.sql` **applied to TVC ERP on 2026-11-02**. |
| 04 Parties & payees | Built on branch `finance-04-parties` (draft PR). Migration `0079` **applied to TVC ERP on 2026-11-02** (recorded as `finance_parties`); checked afterwards: both tables empty, RLS on, no anon/authenticated grants, guard trigger present. |
| 02, 03, 05-13 | Not started |

## Access

Two modules in the staff registry (`netlify/functions/lib/staff-registry.ts`), granted on the Access screen
like any other, per person. A super admin has no implicit finance access.

| Module | Role | Capabilities |
|---|---|---|
| `finance` | `admin` (directors) | all ten |
| `finance` | `user` (finance operators) | `view`, `import`, `allocate`, `request` |
| `finance` | `read_only` (viewers, auditors) | `view` |
| `finance-requests` | `user` / `admin` | `raise`, `add-vendor`, `scan-bill`, `payroll-input` |

`finance` capabilities: `view`, `import`, `allocate`, `request`, `approve`, `approve-payroll`,
`verify-payee`, `close-period`, `configure`, `export`. The last six are admin-only.

- `finance-requests` is a separate module on purpose: `requireStaff(req, 'finance', ...)` looks up the role in
  `finance` only, so holding `finance-requests` opens nothing in the ledger. (Tested.)
- **Auditors** are `read_only` grants with an end date. The Access screen shows "Ends 3 Dec 2026" beside a
  read-only role; the date is the last day, to the close of that day in India time, at most 13 months ahead.
  Only `read_only` can carry one. An expired grant is refused with the same 403 as no grant, is hidden from the
  person's tool list, and is checked on every request (not cached). Setting or clearing it is audited.
- **Auditor visits are logged.** Opening the overview as `read_only` writes `finance.overview_viewed` to
  `fin_audit_log`; if the log cannot be written the page is refused.
- **Masking.** `payeeFieldVisibility(capabilities)` in `scripts/lib/finance-access.mjs`: names are visible to
  anyone with `view`; payee account numbers and UPI IDs only to holders of `verify-payee` or `export`.
  `maskAccountNumber` ("•••• 0123") and `maskUpiId` ("p••••@bank") are there for the screens that need a masked form.
  No payee data exists yet; later sessions apply these in their responses.
- **Maker is not checker.** `makerIsNotChecker(...personIds)` returns true only if every person is known and all
  differ. Later sessions call it server-side for payment approval and payroll (preparer, confirmer, checker).

## Tables (migration `0077_finance_foundation.sql`)

`fin_entities`, `fin_bank_accounts` (last four digits only), `fin_categories` (the type sits on the category),
`fin_periods` (one row per month, open or closed), `fin_audit_log` (append-only by trigger). All RLS-on with no
policies and `anon`/`authenticated` revoked: only the Netlify Functions, using the service role, can touch them.
Seeded: one entity and a **draft** category list (23 generic heads) for the directors to confirm.
Also adds `staff_module_roles.expires_at`.

## Migration 0078 (applied 2026-11-02)

Replaces the placeholder categories with the list in the file (29 generic heads, from the structure of the sheet's
"Lists" tab), drops `project` as a category type, and adds `fin_projects` and `fin_project_lines`. See DESIGN.md,
"Budget buckets" and "Projects". Equity is deliberately left out. Nothing references the placeholder categories yet,
so replacing them was safe. Checked after applying: 29 categories (opex 13, capex 4, revenue 4, tax 3, one each of member contribution, sinking fund, interest, reimbursement, transfer), the type check no longer allows `project`, RLS on for both new tables, no anon/authenticated grants.

## Endpoints and pages

- `GET /api/finance-admin/overview` (needs `finance` / `view`): entity name, your role and capabilities, what
  you may see unmasked, counts of accounts, categories and open months, `hasData: false`.
- `/internal/finance/`: shows "No data yet", the counts and your access.
- `/internal/finance-requests/`: a placeholder so a granted person's tile leads somewhere.

## Tests

`node --test scripts/lib/finance-*.test.mjs` (also run by the `Finance tests` GitHub Action). The first covers expiry, the capability matrix, masking and maker-is-not-checker;
the second drives the real function through `requireStaff` with Google and Supabase stubbed (needs `npm ci`
for esbuild, and Node 22.18+ or newer, which imports the registry `.ts` directly).

## Parties and payees (session 04, migration `0079_finance_parties.sql`)

- **Tables.** `fin_parties` (kind, name, optional household for a member, active) and `fin_party_accounts` (bank or UPI
  details). Details are AES-256-GCM encrypted (`details_enc`, own key derived from `STAFF_MFA_KEY`); the clear columns
  are the last four characters and a keyed fingerprint used to find two parties sharing one account. A trigger refuses to
  edit or delete a row's details; only the status may move forward (unverified, verified, superseded).
- **Change = new row.** Entering different details adds a new `unverified` row and marks the party's live row of the same
  method `superseded` (kept, still decryptable for investigation). The same details again change nothing. Until a director
  verifies the new row, the party has no verified account of that method, so later sessions cannot pay it.
- **Who can do what.** `view` reads the directory (names, kind, "ending 0123", status, shared flag). `allocate` adds and
  edits parties and enters details. `verify-payee` (directors) reveals full details and verifies them, both behind the MFA
  step-up (the "Unlock editing" on the page); the person who entered details cannot verify them (details loaded by the
  import script have no creator, so any verifier may confirm those).
- **Never in responses, logs or audit.** List responses are built field by field and carry no ciphertext, fingerprint or
  number. `fin_audit_log.detail` is checked before writing and a number, UPI id or IFSC makes the write fail. Revealing is
  written to the audit log first; if that fails nothing is returned. Audit actions: `finance.party_created`,
  `party_updated`, `payee_added`, `payee_changed`, `payee_revealed`, `payee_verified`, `parties_imported`.
- **Shared accounts** are flagged on both parties ("Shared account") and never blocked.
- **Retiring accounts (why this exists).** Money was once sent to an old account that never reached the payee and never came
  back. So an account has two dates: `valid_from` (first day it may be paid) and `retired_on` (first day it must **not** be
  paid). **`accountPayableOn(account, day)` in `scripts/lib/finance-parties.mjs` is the one rule: payable only when
  verified, started and not retired. Every payment path (requests in session 08, payroll in 09, any bulk file) must call it
  and refuse otherwise.** `todayIST()` gives today's date in India.
  - *Retire* (`POST /accounts/:id/retire {on, reason}`): `verify-payee` + the step-up. A past date is allowed (it stopped
    working before anyone knew). A retirement can be moved **earlier, never later or cleared** (also enforced by a database
    trigger), and a replaced account cannot be retired. The audit log gets the date only; the free-text reason stays on
    the row.
  - *Change on a date* (`POST /parties/:id/accounts` with `effectiveOn`): `verify-payee` + the step-up. The old account stays
    payable until that day and is retired from it; the new one is unverified and starts that day. Without a date the old
    details are replaced at once (anyone who may enter details can do this), so nothing is paid to that payee until the new
    details are verified.
  - A retired or soon-to-retire account is shown as such, and an already retired account cannot be verified.
- **Needs review.** Computed by `reviewFlags` and shown as a "Needs review" pill, a filter ("Needs review (n)") and a plain
  sentence per account: `multiple_live_accounts` (two or more bank accounts in use: what a bank merger looks like; retire the
  old one, or "Keep both: reviewed", which holds until a newer account is added), `missing_ifsc`, `shared_account`, and
  `no_replacement` (a retirement is set but no other account of that kind is left). Superseded accounts are history and never
  flagged; a UPI id is not a second bank account. Recording "keep both" is `POST /parties/:id/review` (`verify-payee` +
  step-up, audited as `finance.party_reviewed`).
- **Endpoints.** `GET/POST /api/finance-admin/parties`, `PATCH /parties/:id`, `POST /parties/:id/accounts`,
  `POST /parties/:id/review`, `POST /accounts/:id/reveal`, `/verify`, `/retire`. Page: `/internal/finance/parties/`.
- **Import.** `scripts/import-fin-parties.mjs --source <sheetId>::<range> [--source ...] [--apply]` reads the existing
  payee lists from Google Sheets shared with the Drive service account (ids and ranges are arguments, never in the repo).
  The details are spread over several partial lists, so several sources are given and **merged by account number**: the
  first source's name wins and blanks (IFSC, UPI id) are filled from later ones; two entries for one account inside the
  same list are kept apart so the shared-account flag still sees them. Dry run by default; it prints counts and line numbers
  only. A name column is required; kind, account number, IFSC, UPI id and farm unit are used when present, matched by loose
  header names (the layouts of the registered-accounts tab, the accounts tab, the funds-transfer requests and the bank's own
  beneficiary export are all recognised). Parties match on name + kind and accounts on fingerprint, so re-running adds
  nothing. Everything lands unverified. Rows with no kind column become kind `other` for review; member parties link by
  farm unit (`F-07`).
- **Name de-duplication.** Banks have merged, so one payee can appear with an old and a new account number, which the
  account-number merge cannot see. Names that are equal after normalising (case, accents, punctuation, a leading honorific,
  "&", "Private Limited" vs "Pvt Ltd") are the same party and keep all their accounts; a party with two or more bank accounts is
  reported as `multiple_accounts` (verify the current one). Looser matches (same words in another order, one name contained in
  another, a one-letter spelling slip) are **never merged automatically**, since two workers or relatives can have near-identical
  names: they are counted in the summary (`duplicateCandidates`) and `--review-out <path>` writes them, with names, bank code and
  last four, to a private file outside the repo (the script refuses a path inside it). Merging two parties after import is not
  built yet.
- **8-digit accounts.** Older accounts can be 8 digits. The import pads those with one leading zero to the 9-digit minimum
  (before lists are merged, so the same account in two lists still matches) and reports each as `padded_account`. The
  directory form still requires 9 to 18 digits. A padded number is a guess about the bank's format: check these when verifying.
- **No IFSC.** Some lists have none, and some have one that is not a valid IFSC (reported as `invalid_ifsc`, then treated as
  missing; a wrong account number is still refused). Such accounts import with an empty IFSC, are reported as `missing_ifsc`, and **cannot be
  verified** until someone enters the account again with its IFSC ("Add or change details"; the same number with a new IFSC
  counts as a change, and the old row is kept).
- **Not built yet:** linking an existing party to a household after the fact, merging duplicate parties, and the farm
  manager's add-vendor screen (`finance-requests`, session 08).

## Migration 0077

Applied to TVC ERP on 2026-11-02 (recorded as `finance_foundation`). Checked afterwards: 1 entity, 23 categories,
RLS on for all five `fin_*` tables, no `anon`/`authenticated` grants, `expires_at` present and null on every
existing grant. `requireStaff` selects `expires_at`, so the column has to exist before this code is deployed.

## Vocabulary

See `CONTEXT.md` at the repo root (bank line, allocation, period, nature, party, voucher, circle).
