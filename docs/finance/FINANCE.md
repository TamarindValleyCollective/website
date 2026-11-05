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
| 03 Statement import | Built on branch `finance-03-statement-import` (draft PR). Migration `0080` **applied to TVC ERP on 2026-11-02**. |
| 04 Parties & payees | Built on branch `finance-04-parties` (draft PR). Migration `0079` **applied to TVC ERP on 2026-11-02** (recorded as `finance_parties`); checked afterwards: both tables empty, RLS on, no anon/authenticated grants, guard trigger present. |
| 05 Ledger & review | **In progress** on branch `worktree-finance-05-ledger` (draft PR). Slice 1 built: posting rules, rules engine, review flags, migration `0083` (**NOT yet applied**). Endpoints and screens not built. |
| 02, 06-13 | Not started |

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
  details). Details are AES-256-GCM encrypted (`details_enc`, own key derived from `FINANCE_PAYEE_KEY`, or from `STAFF_MFA_KEY` if that is not set; see "Keys" below); the clear columns
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
- **Comparing a payee's accounts.** A bank merger leaves a payee with an old and a new number, and a one-digit difference is easy
  to miss. In a payee's sheet, the last four digits of accounts of the same kind are compared and **the characters that differ
  are shown in red** (needs no extra access). "Compare full numbers" (`verify-payee` + the unlock) reveals every account of that
  payee at once, one audit entry each, and shows the full numbers and IFSC codes right-aligned (so different lengths line up at
  the end) with the differences in red, for 30 seconds. The comparison itself is `markDiff` in `scripts/lib/finance-diff.mjs`.
  The list and the sheet still never carry a full number unless a verifier asks for it.
- **Verifying: how it was checked (migration `0082_finance_verification_evidence.sql`).** `POST /accounts/:id/verify {method, note}` needs
  a method (cancelled cheque or bank letter, a small test transfer that arrived, an invoice or bill, or other with a note) and
  records it with who and when. The database refuses a verification without a method and any later change to the evidence; the
  note may not carry an account number, UPI id or IFSC (the same filter as the audit log), and only the method goes in
  `fin_audit_log`. The account then shows "Verified by X on date · method". Details verified before this migration show
  "Method not recorded". The sheet shows "3 of 118 to verify" and **Verify and open next**. **Migration 0082 must be applied
  before the code that sends the method is deployed.**
- **The Overview ("Needs you").** `GET /overview` returns `attention`: payees to verify (parties with an unverified live account),
  payees needing review, statement gaps, Paytm payments with no bank line and Paytm payments waiting, the last import date and
  counts of parties and bank accounts. Counts and labels only: no names, numbers or fingerprints. Each row links into the
  filtered Parties list (`?filter=unverified|review|verified`) or Import.
- **The Parties list.** Status chips with counts (All / Needs review / Unverified / Verified) filter the list; a quiet dot shows each
  payee's state so "Needs review" is the one loud signal; the kind is changed in place (the list also has it on phones, in the
  sheet). Add party defaults to Vendor.
- **Merging (migration `0081_finance_party_merge.sql`, applied to TVC ERP on 2026-11-02).** Two parties that are really one payee (often a bank merger: an old
  and a new account) are merged by a director with the step-up: `POST /parties/:id/merge {into}`. Nothing is moved or deleted,
  because account rows are immutable: the duplicate gets `merged_into = main party`, is hidden from the list, and the main party
  shows, and is reviewed over, both sets of accounts (so an old and a new bank account are flagged together until the old one is
  retired). Rules (also enforced by a database trigger): no chains, not into itself, a party others were merged into cannot be
  merged away, and a member linked to a household cannot be merged away. `POST /parties/:id/unmerge` undoes it (no screen yet).
  Entering details on a main party sees the accounts of its merged duplicates. **Later sessions must treat a merged party as its
  main party** (`foldMerged` / `merged_into`) when matching payments, requests and payroll to a payee.
- **Keys.** Payee details are encrypted under `FINANCE_PAYEE_KEY` (32+ random bytes, base64) when it is set, otherwise under
  `STAFF_MFA_KEY`. The finance key is separate on purpose: Netlify secrets can be set but never read back, so a key you did not
  keep a copy of cannot be reused by a script, and rotating the MFA key would lock every TOTP secret and member payout detail.
  Generate it once (`openssl rand -base64 32`), keep it in the team's password manager, and set it in Netlify as a secret for
  all scopes including Functions; the import script needs the same value in the shell (`read -s FINANCE_PAYEE_KEY; export
  FINANCE_PAYEE_KEY`). **Losing it makes stored payee details unreadable** (they must be re-entered). A value that is set but too
  short is refused, never replaced by the other key. Do not change it once payees are imported.
  To confirm a key can open what is stored, run `netlify dev:exec -- node scripts/check-fin-parties-decrypt.mjs` with the key
  in the shell: it decrypts every account and compares the last four and the fingerprint with what is stored, printing counts only
  (exit 1 on any mismatch). The page's reveal and verify need the MFA step-up, which only works on the deployed site (its
  signing key is a Netlify secret that is not available locally).
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
  `POST /parties/:id/review`, `/merge`, `/unmerge`, `POST /accounts/:id/reveal`, `/verify`, `/retire`. Page: `/internal/finance/parties/`.
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

## Statement import (session 03)

**Live.** Real data imported 2026-11-02: 1,376 bank lines (2022 to 2 Nov 2026, chain verified) and 66 Paytm rows, all linked. Known gap for session 05: same-day line order is not stored.

Page `/internal/finance/import/`; routes in `finance-admin.mts` (`GET /imports`, `POST /imports/preview`, `POST /imports/commit`,
`POST /bank-accounts`). Needs `import` (finance user or admin) to upload and `configure` (admin) to register an account.

- **Files.** The Axis statement is one Excel file per calendar year from the start of the account; upload several at once or one
  at a time, in any order. The Paytm UPI export is one Excel file. Each file is its own batch (`fin_import_batches`, unique file
  hash, raw file kept in private R2). The same file is never imported twice.
- **Per-year checks.** Each file's balance chain must hold from its opening balance, and the bank's own footer totals must agree.
  Across years, one year's closing balance must equal the next year's opening balance (a mismatch blocks the file). A gap between
  years is shown with its dates and closes when the missing year arrives; nothing is guessed.
- **Overlap.** A later download of a period already held adds only lines not held (`dedupe_key`: account, date, narration,
  direction, amount, running balance, order among exact repeats). It must agree with what is held, or it is blocked.
- **Paytm.** Only rows whose account label equals a bank account's `upi_label` are kept; the rest are ignored but counted with
  their total. `is_circle` = a payment out whose tag matches `fin_entities.circle_tag` ("Pocket Money"). Rows join bank lines by
  the 12-digit UPI reference when amount and direction agree; a Paytm row after the last bank line waits for the next statement.
  Bank UPI debits before `fin_entities.paytm_since` have no Paytm row and are reported as such.
  A Paytm file where **no row** is on a registered account (no account yet, or a wrong label) is **blocked**, not stored as all-ignored; register the account with its Paytm label first.
- **Tables (migration `0080`, applied 2026-11-02).** `fin_import_batches`, `fin_bank_lines` (append-only), `fin_upi_lines` (only
  `bank_line_id` may change), functions `fin_store_bank_batch`, `fin_store_upi_batch`, `fin_link_upi_lines` (service role only),
  and `circle_tag` / `paytm_since` on `fin_entities`.
- **Code.** Parsing and planning are pure and separate (`scripts/lib/finance-*.mjs`); storing goes through an `ImportStore`.
  A bank API would feed the same planning/storing step; none is built.
- **Audit.** `finance.import_committed` (counts only) is written before anything is stored; `finance.bank_account_added`.

## Ledger (session 05, slice 1: logic and migration only)

**Not live.** No endpoint or screen yet; migration `0083_finance_ledger.sql` is **not applied** to TVC ERP. Apply it before
any code that reads `fin_allocations` is merged.

- **Posting rule** (`scripts/lib/finance-allocation.mjs`, mirrored in the database). A bank line has one or more allocations; each
  amount is positive whole paise and its direction is the line's. A line is *unallocated*, *partly allocated* or *allocated*. Saved
  rows are drafts (`posted_at` null) until they add up to the line exactly, then every row is posted in one step. Posted rows are
  frozen except their review fields; a line already posted is corrected by a reversal, never by editing.
- **Refunds and corrections.** A reversal is a row on a line that moves money the other way, with `reverses_allocation_id` and a
  reason. It must reverse a posted, non-reversal allocation and never more than is left of it. Reports net by direction.
- **Periods.** `period` is the first day of a month and defaults to the line's month; a salary paid in May can sit in April. A
  closed month refuses a save unless the person holds `close-period` and gives a reason (`periodWriteDecision`); the database
  refuses unless the app passes `p_override`.
- **Rules** (`scripts/lib/finance-rules.mjs`, table `fin_rules`). A matcher is a set of conditions that must all hold (narration
  text, UPI id, any of some remark keywords, direction, amount range); one with no condition never matches. Lowest priority number
  wins, ties go to the older rule. A rule gives party, category, a nature template (`{counterparty}`, `{remark}`) and `needs_review`.
  With no rule, the farm manager's own UPI remark seeds the nature, and a payment to the requester's own party is a reimbursement.
- **Review flags** (`reviewReasons`): nothing explains the line; a circle payment to the requester's own party; a payment to an
  account that is new, changed or unverified; a reimbursement with no bill; a rule marked always-review.
- **Database guards** (checked on a throwaway local Postgres, 2026-11-04): a short sum cannot be posted, an over-sum cannot be
  saved, a split posts, a posted row cannot be changed or deleted, a reversal needs the opposite direction and cannot exceed what is
  left or be reversed itself, a closed month refuses without the override, and the functions run for `service_role` only.
- **Tables and functions** (`0083`): `fin_rules`, `fin_allocations`, `fin_vouchers` (table only; capture is session 08),
  `fin_save_allocations(line, rows, actor, post, override)`, `fin_close_period(entity, month, actor)`.
- **Still to build in this session:** the store and routes in `finance-admin.mts`, the Ledger and Review screens (split editor,
  bulk apply, rules page), reimbursement handling in the screens, period close, an endpoint test, and the `ARCHITECTURE.md` entry.
