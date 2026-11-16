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
| 05 Ledger & review | **Merged (PR #529).** Posting rules, rules engine, ledger and rules screens, period close. Migration `0083` **applied to TVC ERP on 2026-11-05** (recorded as `finance_ledger`). |
| 06 History load | **Loaded on 2026-11-05** (PR #530, migration `0084` applied): 1,031 allocations on 783 bank lines. Still open: the 2023-24 tracker tab, party on the history rows with none (the "No party" chip lists them), project details for the Farm Project placeholders (issue #531). |
| 05/06 follow-up: the new ledger | **Draft PR #532.** The ledger page is rebuilt (TanStack Table and Virtual; every line fetched once, searched and sorted in the browser; cards on phones; saved drafts; undo; a line sheet that can set a maintenance unit and year) and replaces the first version at `/internal/finance/ledger/`; faster list, Paytm line, "No party" chip and flags. Critique 22 → 26 → 30 → 27 / 40 over four rounds (reviewers vary by about 3). No migration. Not yet tried on the real ledger. |
| 08 Payment requests & bills | First slice **merged (PR #567, 2026-11-07)**. Migrations `0092` and `0093` **applied 2026-11-07**; the old sheet's 186 records are loaded. See "Payment requests and spend logs" below. |
| 02 Dashboard mockup | Reviewed by the owner; shipped in the same PR as session 07 (`docs/finance/mockups/dashboards.html`, invented data). |
| 07 Dashboards & budget | **In progress, draft PR #587.** Migration `0098` **applied 2026-11-10**; `0099` (budget editing) **applied 2026-11-10**. Metrics, endpoint, the dashboard page and the budget editor are built; the budget import, CSV export and the member preview are next. See "Dashboards" and "The budget editor" below. |
| 09-13 | Not started |

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
  "Method not recorded". The sheet shows "3 of 118 to verify" and **Mark as verified and open next** (the row button is "Check details…", which only opens the sheet; "Mark as verified" in the sheet is the action). **Migration 0082 must be applied
  before the code that sends the method is deployed.**
- **Duplicate names.** Adding a party whose name is already in the directory answers 409 `DUPLICATE_NAME` with the matches
  (`findSimilarParties`: case, spacing, punctuation and "Pvt Ltd"/"M/s"/"and" are ignored; inactive and merged parties are not
  offered). It is a warning: the page lists them and the button becomes "Add anyway" (`confirmDuplicate: true`), because two
  real payees can share a name. The farm manager's add-vendor route (`/vendors`) is stricter and refuses outright, with
  `existingId`, since that user cannot merge. The database has no unique rule on names; **Merge into…** cleans up afterwards.
- **Renaming.** A party's name is a label (what is typed in the transfer sheet and searched), so **Rename…** in the party sheet changes
  it any time (`PATCH /parties/:id {name}`, `allocate`); everything points at the party by id, so nothing else changes. A name another
  live party has gets the same 409 `DUPLICATE_NAME` warning as adding, with **Merge into this one…** (opens Merge with that party
  chosen) and "Use this name anyway" (`confirmDuplicate: true`); the party's own other spellings never clash with itself. A member
  party shows a note that its name is matched to the member records.
- **Add IFSC.** Bank details loaded without an IFSC (the operator's lists have no IFSC column) show **Add IFSC…** (verifier + the
  unlock): `POST /accounts/:id/ifsc {ifsc}`. The account number is read on the server and never sent back; the old row is superseded
  and a new unverified row with the IFSC starts, for **that account only** and with no date, so no retired row is left behind.
  The new row keeps the old row's creator (none for a loaded row), because the number is not new and a verifier may still confirm
  it; who typed the IFSC is in the audit log (`finance.payee_ifsc_added`), and the IFSC is checked against evidence when verifying.
- **Evidence: screenshots against an account (migration `0094_finance_payee_evidence.sql`, **applied to TVC ERP on 2026-11-08**, recorded as `finance_payee_evidence`).** Two
  verify methods keep a screenshot against that one account: **Bank's payee-name check** (the bank's own "Name as per Payee Bank" screen,
  which proves whose account it is; a transfer success screen shows only the label that was typed) and **Payment made** (the transfer
  success screen, which proves money reached it). The sheet shows the file beside the details on record; the person ticks that the last four
  and the IFSC (or the UPI id's last four and its @ part) match, and for the name check types the name the bank showed (`verified_name`,
  kept on the account next to the party's label and searchable; "This looks like the party label" is a hint from `namesResemble`, never a
  block). Files: `POST /accounts/:id/evidence` (multipart `file`, `kind` payment | name_check | other; verifier + unlock; JPEG, PNG,
  WebP or PDF up to 4 MB, at most 6 per account, only before verifying), stored in the private R2 bucket under `finance/vouchers/` with
  a row in `fin_party_account_files`; `GET /accounts/:id/evidence` lists them and `GET /evidence/:id` shows one (verifier + unlock, each
  view logged); the list carries only counts. The database refuses to verify by either method without its file (and the name), and never
  changes the name, the files or the method afterwards. The audit log gets the kind and ids, never the name or the files.
  The migration was tested on the real database inside a transaction that always rolls back, then applied; checked afterwards: the
  table and column exist, the method check lists the two new methods, RLS is on with no anon/authenticated grants, both guard
  triggers are present, and the 128 existing accounts (2 verified) were untouched. The code still reads the new column and table
  with a fallback, so a database without 0094 keeps working for the old methods.
  Not built yet: reading the screenshot automatically (extract blind, then compare with what is on record), and confirming a payment
  against the imported statement (the UPI reference is already on the UPI lines).
- **Loading the old sheet's screenshots (`scripts/import-fin-evidence.mjs`, operator script, run once, not deployed).** The transfer sheet
  keeps a screenshot per transfer as a picture placed over the row, which the Sheets API cannot return, so the script reads the sheet's
  **.xlsx export** (held in memory only) and takes each picture from the row it is anchored on (`scripts/lib/finance-evidence-import.mjs`,
  tested on an invented workbook). The row's account number is matched to a saved account by the same keyed fingerprint the payee import
  uses (an 8-digit old number is also tried with its padded zero), so a picture lands on the exact account it paid; a picture whose
  number matches no saved account, or more than one (a shared account), is skipped and counted, never guessed. They are filed as
  `payment` evidence and **nothing is verified by it**: a director opens an account's evidence and marks it verified as usual. A picture
  is stored under an id taken from its content (`finance/vouchers/<id>.<ext>`), so re-running adds nothing and the same screenshot is
  never filed twice. Dry run by default; it prints counts only (never a name, number or picture). `netlify dev:exec -- node
  scripts/import-fin-evidence.mjs --sheet <spreadsheetId> [--apply]`; it needs the payee key, the service-role key, the Drive
  service account and, for `--apply`, the R2 keys (the script names whichever is missing). Per-account limits of the app (six files) do
  not apply to it, so an account paid many times can hold many. Not done by it: attaching each screenshot to its payment request
  (a separate step), and reading the screenshots.
- **Bank and UPI are separate accounts.** A party can hold both: each is its own `fin_party_accounts` row (`method` bank or upi),
  verified, retired and superseded on its own. A new bank account only supersedes the live bank row, never the UPI one.
- **IFSC lookup.** `GET /ifsc/:code` (any `finance` view role) asks Razorpay's free public IFSC directory
  (`ifsc.razorpay.com`) and returns the bank, branch and city. The payee form shows it under the IFSC field as it is typed
  ("No bank branch has this IFSC code" if none), and the verify sheet shows it beside the revealed code. It proves the branch
  exists, not that the account does or whose it is. Only the IFSC is sent; a failed lookup shows nothing and never blocks saving.
  **Checking the account holder's name has no free service**: a penny-drop (a paid API such as RazorpayX validation) is the
  only automated way. Free options stay manual: the name a UPI app shows for a UPI id, the beneficiary name in net banking,
  or the "small test transfer" verify method.
- **The Overview ("Needs you").** `GET /overview` returns `attention`: payees to verify (parties with an unverified live account),
  payees needing review, statement gaps, Paytm payments with no bank line and Paytm payments waiting, the last import date and
  counts of parties and bank accounts. Counts and labels only: no names, numbers or fingerprints. Each row links into the
  filtered Parties list (`?filter=unverified|review|verified`) or Import.
- **The Parties list.** Now the shared admin table, in the Ledger's format (`scripts/lib/data-table-engine.mjs` engine on TanStack `table-core`, `data-table.mjs` pure pieces, `data-table-ui.mjs` DOM,
  `src/styles/data-table.css`; see docs/design-language.md, "Data tables"): a search box that holds chips, with Filters (Needs review,
  Unverified, Verified, No payment details, No evidence attached, Bank's name differs, Possible duplicate, Kind is Other, Inactive), Group by
  (Kind by default, Status, First letter) and Favorites (kept in the browser, per account); a filter box under every column header in the Ledger's
  syntax (`^word`, `=word`, `!word`, `>1000`, `2026-10`); sortable columns Name, Kind (changed in place), Accounts, Status, Name at the bank
  (orange when it differs from ours), Evidence (files attached), Last activity (the latest line either way, with which way it was), Paid in total, Received in total; cards on phones. Everything is searched and sorted in the
  browser. Last activity, Paid in total and Received in total come from posted, non-reversal allocations (payments out and money in counted separately; a failure there only blanks those columns). Two chips, *We have paid them* and *We have received from them*, find a party by which way money has gone. Ticking rows
  opens a bulk bar: Set kind, Merge (exactly two ticked: the one without payment details merges into the other, through the usual merge
  sheet and its step-up), Mark inactive, Mark active; each is the existing `PATCH /parties/:id` per party (so each keeps its own rules and audit entry), run five at a time with the count shown as it goes, so changing a hundred parties takes seconds. The usual job, "turn all the Others into Vendors": filter to *Kind is Other*, tick the box in the header (every party shown), choose *Set kind*; Vendor is preselected, and parties linked to a household stay members. The bar of ticked rows sticks to the bottom of the table's own column (it must not span the whole window: it once slid under the left rail and hid *Set kind*). A dot shows each payee's state so
  "Needs review" is the one loud signal. Add party defaults to Vendor.
- **Suggested changes** (`GET /parties` returns `suggestions`; rules in `scripts/lib/finance-party-suggestions.mjs`, pure and tested). Only
  typed or booked evidence is used, never a screenshot: the name the bank showed when an account was verified (`verified_name`), the other
  parties' names, and what a party's posted payments were booked under. *Merge* (names match allowing one slip per eight letters, or one bank
  name fits both; never two members, never a member linked to a household away), *Rename* (our label is a spelling or a shortening of the
  verified bank name; never a member, never to a name another party has), *Kind* (only "Other", and only when at least two payments and 80% of
  them agree: Salaries to Employee, opex/capex to Vendor, revenue receipts to Customer, tax to Government). Accepting a rename or a kind calls
  `PATCH /parties/:id`; accepting a merge opens the normal merge sheet. Dismissals are remembered in the browser. Reading screenshots with a
  vision model was considered and left out (it would send payee images to an external model); it is the natural next step if typed names are
  too few.
- **Merging (migration `0081_finance_party_merge.sql`, applied to TVC ERP on 2026-11-02).** Two parties that are really one payee (often a bank merger: an old
  and a new account) are merged by a director with the step-up: `POST /parties/:id/merge {into}`. Nothing is moved or deleted,
  because account rows are immutable: the duplicate gets `merged_into = main party`, is hidden from the list, and the main party
  shows, and is reviewed over, both sets of accounts (so an old and a new bank account are flagged together until the old one is
  retired). Rules (also enforced by a database trigger): no chains, not into itself, a party others were merged into cannot be
  merged away, and a member linked to a household cannot be merged away. `POST /parties/:id/unmerge` undoes it (no screen yet).
  **The merge sheet** shows both parties side by side (kind, payment details with last four and verified state, the bank's name, evidence, lines in the books, paid and last paid) and the person chooses which one stays: "Keep this one" on either card, with a sentence saying what will be hidden and what will show under which. A suggestion or two ticked rows open it with both already there (the suggestion's choice is preselected); from one party's sheet it first asks for the other. A party linked to a household, or one that already holds merged parties, cannot be the one merged away: its card is the one that must stay, and the sheet says why.
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
  A gap is not reported on a side where a held period already covers the file's first or last day (a download starting inside
  the held year overlaps it; it does not leave a hole before it).
- **Preview of the delta.** Before confirming, each file row shows the in/out totals and the balance after, and a **Review N lines**
  button that opens a wide pop-out (the shared `.sheet` dialog) with every line it would add: date, narration, debit, credit and,
  for bank statements, the running balance. The pop-out's Import button is the page's Import button (it imports every file that is
  ready, and says so in its label); Escape or a click outside closes it. On a phone it is full-screen and each line is a small card.
  Preview mode only, capped at 500 lines (the pop-out says so); the commit response carries counts only, never narrations.
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

### BHIM history, origin of a line and the UPI page (branch `finance-upi-circle-bhim`, migration `0088`, **applied 2026-11-07**)

Before the circle moved to Paytm (31 Aug 2026) it ran on BHIM. The BHIM "Transaction History" PDF is now a third file type beside
the Axis Excel statement and the Paytm Excel export (`FILE_TYPES` in `lib/finance-import.ts` is the read-only record of which file
types the importer knows; each batch stores its `source`: `axis_statement`, `paytm_upi`, `bhim_upi`).

- **Reading the PDF.** `unpdf` gives one text line per transaction; `scripts/lib/finance-bhim.mjs` parses it (pure, tested). Only
  successful `PAY` rows are stored; a `FAILURE` row moved no money, so it is counted and shown on the preview but not stored. A row
  that cannot be read is listed with its line number, never dropped.
- **Account.** A UPI app can be linked to several banks and pay from any, so the file cannot always say. A row that names its
  account (`XXXX…0099` → `0099`) is placed on the registered account with those last four digits; a row that names none (a circle
  payment) is stored **with no account**, and its account is read from the bank line it is joined to by reference (the UPI
  page does this at read time; `fin_upi_lines` is link-only, so the row itself never changes). A row naming a bank account that is not
  registered (a personal account: some statements include them) is **left out and counted, never stored**, and the rest of the file
  imports; the file is **blocked** (`account_not_registered`) only when the rows that name an account name none that is registered, so a
  payment is never put on a wrong account. A row with no bank line yet shows "account not known yet".
- **Direction and the delegated reading (checked against the bank statement, 2026-11-07).** DR/CR is *not* the direction of the money
  (`bhimDirection`, `bhimIsCircle` in `finance-upi-plan.mjs`). A row that names **no bank and is marked CR** is a delegated (UPI Circle)
  payment and is a bank **debit**; a row naming the bank and marked **DR** is a payment out (a debit); a row naming the bank and marked
  **CR** is money coming **in** (a credit) and is stored as a credit, never as a delegated payment. The first version of the importer
  stored every row as a debit.
- **Same table, one more column.** Rows go into `fin_upi_lines` with `app` (`bhim` | `paytm`, existing rows are `paytm`), the same
  unique reference (so a payment in both files is stored once) and the same join to bank lines. Raw PDFs are kept in R2 as `.pdf`.
- **Channel ("origin") of a bank line** (`scripts/lib/finance-origin.mjs`, derived at read time, not stored). A line has two
  independent facts: the **account** it hit and the **channel** it came through. `CHANNELS` is the registry (label, `kind`:
  `upi_app | bulk | gateway | card | bank`, `flows`: in/out); `RULES` are the narration readings, first match wins. Today: `bhim` /
  `paytm` (a joined UPI row names the app), `paypro` (a NEFT **debit** shaped `NEFT/<number>/<number>/` with no payee: agreed with
  Sharath 2026-11-07), `gateway` (a **credit** narrated `Razorpay…`: the payment gateway paying out; only one, a test, has appeared so
  far, so real settlements are unverified), `card` (`POS/`, `ECOM PUR/`, and `VISA MERCH Refund`), `upi_unknown` (a UPI narration with no
  BHIM or Paytm row) and `bank` (everything else: net banking, NEFT, IMPS, charges). **To add a channel** (a POS terminal, a second
  gateway): one `CHANNELS` entry and, if the bank's narration identifies it, one rule; a channel with a statement of its own is
  identified by the joined row instead. No POS terminal exists today, so none is defined. Each reading is an inference from
  narrations, not a label from the bank. The ledger shows it as the **Origin** column (sortable, searchable, a filter chip and Group By;
  on phone cards a label under the narration), with the account under it once there is more than one account (also a Group By field and
  searchable), and in the line sheet. Not built: reconciling gateway settlements to the individual online payments (the gateway's
  settlement report would join like the UPI exports do).
- **UPI page** `/internal/finance/upi/` (`GET /upi-lines`, `lib/finance-upi-view.ts`, pure rules in `finance-upi-circle.mjs`): a
  sortable table of every UPI row (date, paid to, amount, app, **paid by**, account, state against the statement, reference), with
  filters by app, paid by and state. *Paid by* is **Direct** (an operator of the account paid in their own app) or **Delegate**
  (a delegated payment, "UPI Circle": a delegate pays with a spend right and limit the operator gave them; only the account's
  operators can add the account to their UPI apps, and there can be several delegates, each with their own limit). Every download
  is in the operator's name, so a file never says *which* delegate paid: see **Delegates** below for how that is worked out.
  State: *in the ledger* / *waiting for the statement* / *not in the statement*. Delegated spend per calendar month is shown per
  delegate against that delegate's limit (the default is `CIRCLE_CAP_PAISE`, Rs 15,000, a constant), and so is the count of bank UPI
  debits that no BHIM/Paytm row explains. Code and the database still say `is_circle` for "delegated".
- **Delegates** (migration `0100`, **applied 2026-11-15**; `lib/finance-delegates.ts`, pure rules in `finance-delegates.mjs`). Neither the
  Paytm export nor the BHIM file says which delegate paid. The Paytm app's receipt screen does: it shows `Paid for <number>`, the
  delegate's number. So a delegate is known by that **number**, typed once by an admin (`configure`) on the UPI page, with an optional
  name, the date they started, an optional end date and an optional monthly limit (empty = the default). Everywhere a delegate is shown
  it is the **name when there is one, otherwise the number**; adding a name later changes every record. A delegated payment is
  attributed in this order: (1) an explicit pick an admin made for that payment (`fin_upi_delegate_links`, keyed by the 12-digit UPI
  reference like payment notes, because `fin_upi_lines` is link-only and never edited); (2) the one delegate who was **active that
  day**, automatically (so today, with one delegate, every delegated payment from their start date is theirs without anyone doing
  anything); (3) otherwise it is left open: **ambiguous** when two or more were active (the UPI page's *Needs a delegate* filter and a
  banner list them, and the Paid by cell becomes a select, `allocate`), or **none** when nobody was active that day (shown as "no
  delegate yet", counted in its own bucket in the monthly gauge). A pick can be taken back ("Let the dates decide"). The picks and the
  dates are never copied onto the UPI row, so changing a delegate's dates re-attributes every payment that was not picked by hand. A
  spend logged on the Requests page as paid by a delegate names one too (`fin_payment_requests.delegate_id`, only allowed when
  `paid_via` is `delegate`): the one picked, else the only one active on that day. The number and name are personal data: they live in
  the database only (the tables are service-role only), never in the repository, and the audit entries carry counts and field names,
  never the number or name. Not built: reading delegate numbers off receipt screenshots (decided against: nobody will upload each
  receipt), per-delegate rows in the dashboard's circle gauge (it still shows the monthly total), and showing the delegate in the
  ledger.
- **UPI operators** (migration `0101`, **applied 2026-11-15**, after a test on the real data inside a rolled-back transaction; checked afterwards: all 128 UPI rows and the one delegate the first operator, left the link-only trigger on, locked the table to the service role and refused a
  batch with no operator; `lib/finance-upi-operators.ts`, pure rules in `finance-upi-operators.mjs`). All UPI payments go out through the UPI setup of
  one of the account's **operators** (the people who can add the account to their UPI apps); each is either made by the operator **directly** or by a
  **delegate** in that operator's UPI circle, and either operator may have delegates. Nothing recorded *whose* UPI a payment went through, because the
  Paytm and BHIM exports are in the operator's name and never say which. So now: an operator is a name an admin types on the UPI page (*Operators*:
  add, rename; the migration creates one placeholder, "First operator", that every existing UPI row and delegate belongs to, to be renamed); each UPI
  row carries its operator (`fin_upi_lines.operator_id`, set when its file is imported) and each delegate belongs to one operator's circle
  (`fin_delegates.operator_id`: filled in when there is one operator, chosen in the dialog when there are several). **The import asks, every time**:
  once operators exist, each UPI file in the preview has a *Whose UPI is this?* choice and cannot be imported without one (the other files go in).
  The choice is preselected from a **suggestion** only: a file has a signature (a short hash of what it looks like: the accounts a Paytm export's
  Summary names, the sender id that pays most of a BHIM history; never the labels themselves), remembered for the operator it was confirmed as, so the
  next file that looks the same is suggested to them, and with one operator that operator is suggested; with two operators and a layout nobody has
  had, nothing is suggested. When the operators upload their own files, the same question tells whose file it is. A circle payment can only belong to a
  delegate of its own operator's circle (`attribute`). Before the migration was applied there were no operators and everything worked without them (the code still tolerates that). Not built: reading the operator off the file itself (neither export names them).
- **Notes and links between the ledger and the UPI page** (migration `0089`, **applied 2026-11-07**). The bank's or the app's wording is never
  changed. A **note** sits beside it: one per payment, in `fin_payment_notes`, keyed `upi:<12-digit reference>` for a UPI payment (so a UPI
  row and its bank line share one note, before and after they are joined) or `bank:<line id>` otherwise. It is shown and edited in the
  UPI table (a Note column, prefilled with the Paytm remark when no note was written; saving stores it as the note) and in the ledger
  (under the narration, and a Note field in the line sheet). Writing one needs `allocate` (`POST /payment-note`,
  `lib/finance-notes.ts`, rules in `finance-notes.mjs`): at most 300 characters, no account number, UPI id or IFSC, an empty note clears
  it, and the audit entry (`finance.payment_note_set`) is written first and holds the length, never the text. **Links both ways:** in the
  ledger the Origin of a BHIM or Paytm payment links to that payment in the UPI table (`/internal/finance/upi/?ref=<reference>`, and the
  line sheet has the same link); in the UPI table a payment joined to a bank line has *Open in the ledger*
  (`/internal/finance/ledger/?line=<line id>`, which opens the line sheet). The UPI table has no separate Debit / credit column: the amount carries the sign and colour (docs/design-language.md, "Amounts"), and a credit's row has a green stripe.
  The UPI payments table is the shared admin table (docs/design-language.md, "Data tables"): the old App / Paid by / Bank statement buttons are
  chips in the search box's Filters list (chips of one group are alternatives, so BHIM and Paytm shows both; groups combine), every column has a filter
  box, Group by defaults to Month (also App, Paid by, Account, Bank statement), Favorites are kept per account in the browser, and it shows cards on
  a phone. A `?ref=` link fills the search box. The list is cut at 500 rows with a note; filters narrow it. "Show them" on the delegate queue turns on
  the *Needs a delegate* chip. Choosing the delegate and writing a note still happen in the row, as before.
  The page opens on the table: only what needs doing sits above it, as slim notices that appear when they apply (payments needing a delegate, with "Show them"; UPI payments in the bank with no BHIM or Paytm row; a month over the delegated allowance). Delegated spend by month, Operators and Delegates are collapsed panels below the table; each heading carries a one-line summary (the latest month and whether it is over, the operator names, how many delegates are active).
  Other channels (Paypro, gateway, card) have no page of their own to link to yet.
- **Source badges** (migration `0090`, **applied 2026-11-07**). The Origin column shows small badges for the records that vouch for a line:
  its bank (always), then the BHIM or Paytm app when a UPI row is joined, Paypro or Razorpay when the narration says so
  (`sourcesOf` in `finance-origin.mjs`). The badges live in a table, `fin_source_badges` (key, label, short label, kind, `logo_url`,
  sort, active): a badge shows its logo once `logo_url` is set (a path on this site or a full URL) as a small icon in a circle with no border (as a payment app's receipt does; the name is on hover), else its short name as quiet text, so a
  logo is swapped, or a bank added, by editing a row, with no code change. There is no admin screen for the table yet: change it in
  the database. Each bank account carries its own bank badge (`fin_bank_accounts.badge_key`, chosen when the account is added on the
  Import page), so Bank 2 shows its own logo. BHIM and Paytm badges link to that payment in the UPI table.
  Logos live in `public/finance-badges/` (Axis, Paytm as SVG; BHIM and Razorpay as PNG; the BHIM one is the BHIM arrows mark that Sharath supplied on 2026-11-07 (resized to 128px high, transparent; the BHIM name and mark belong to NPCI, and it is used here only to label a payment source on an internal admin screen); the Razorpay one is from Razorpay's logo pack) and are pointed at by migration `0091` (applied 2026-11-07, before the PR merged, as the "Migrations applied" check requires; until the deploy carries the files a badge shows its label text instead of the image). Paypro and the
  generic bank badge have no logo and stay text. Swapping one: add the file and update the row's `logo_url`.
- **Cross-references: what exists and what each still needs.** *Ledger → UPI* and *UPI → ledger* are built (above). *Paypro:* there is
  no Paypro record to link to (the bank only shows a batch line); it needs the Paypro batch file or the payroll/payment-request
  sessions (08/09) to exist first. *Razorpay settlement:* the payments module already stores `settlement_id`, `settlement_utr` and
  `settled_at` per payment, so a gateway credit can be matched to a settlement (by the settlement's UTR in the narration if the bank
  prints one, else by net amount and date, and only a unique match is shown); that is designed but **not built or verified**: the
  statement holds only one test credit and no payment is settled yet. Do it with the first real settlement in hand.
- **Reversed payments** (no migration). A UPI payment that fails after the bank took the money is reversed by a credit for the same
  amount that carries the **same 12-digit UPI reference** as the debit (seen on a real statement: three failed payments to one payee on
  one day, each followed by such a credit). `scripts/lib/finance-reversals.mjs` pairs them: same reference, same amount, opposite
  direction, the credit dated the same day or up to 7 days after, oldest first, each line used once; a refund from the payee arrives under
  a new reference and is never paired. On the real ledger it finds exactly three pairs among 272 UPI lines, and no others. Both lines of a
  pair show a "Reversed by the credit of ..." / "Reverses the payment of ..." note in the ledger (click it to open the other line), the line
  sheet explains it, there is a **Reversal** filter chip, and a reversed payment is left out of "bank UPI payments with no BHIM or Paytm
  record" on the UPI page and the Import page. The two lines are still allocated separately (the reports net them by direction); linking
  the credit's allocation to the debit's as a formal reversal (`reverses_allocation_id`) is not done.
- **Not done:** an Account filter *chip* in the ledger (Group By, search and the line sheet cover it), and the dashboards, period
  close and the Overview's statement-gap check have not been checked for a second bank account.

## Ledger (session 05, migration `0083_finance_ledger.sql`, applied 2026-11-05)

Pages `/internal/finance/ledger/` (the Ledger, with the review queue and the months) and `/internal/finance/rules/` (rules,
categories, the requester); routes in `lib/finance-ledger.ts`. `0083` is applied (checked afterwards: three tables empty, RLS on, no
`anon`/`authenticated` grants, four functions service-role only, three guard triggers, existing data unchanged: 1,376 bank lines,
122 parties, 29 categories). The pages need it, so a deploy of this code is safe now. Not yet tried by a person on the real lines.

- **Posting rule** (`scripts/lib/finance-allocation.mjs`, repeated in the database). A bank line has one or more allocations; each
  amount is positive whole paise and its direction is the line's. A line is *unallocated*, *partly allocated* or *allocated*. Saved
  rows are drafts (`posted_at` null) until they add up to the line exactly, then every row is posted in one step. Posted rows are
  frozen except their review fields; a line already posted is corrected by a reversal, never by editing.
- **Refunds and corrections.** A reversal is a row on a line that moves money the other way, with `reverses_allocation_id` and a
  reason. It must reverse a posted, non-reversal allocation and never more than is left of it, and it takes its category and party
  from the original. Reports net by direction.
- **Periods.** `period` is the first day of a month and defaults to the line's month; a salary paid in May can sit in April. A
  closed month refuses a save unless the person holds `close-period` and gives a reason (`periodWriteDecision`); the database
  refuses unless the app passes `p_override`. A month closes (`close-period`) only when every line dated in it is posted and no
  allocation in it waits for review; otherwise the answer says how many.
- **Rules** (`finance-rules.mjs`, table `fin_rules`, page Rules). A matcher is a set of conditions that must all hold (narration
  text, any of some remark keywords, direction, amount range); one with no condition never matches. Lowest priority number wins, ties
  go to the older rule. A rule gives party, category, a nature template (`{counterparty}`, `{remark}`) and `needs_review`. With no
  rule, the nature (what it was for) is suggested from, best first: what a matched **Approval** (payment request or spend log) says it
  was for, then the remark typed in the UPI app itself (kept whole: only an empty, generic or letterless remark is dropped), then the
  remark in the bank's narration (which keeps a stricter filter: bank names and branch codes are not wording). A rule with its own
  wording template wins over all three. A payment to the requester's own party is a reimbursement. The party
  of a line is guessed only from an exact name match (Paytm counterparty, then the UPI narration); two parties with one name give none.
  A UPI-id condition is in the engine but not offered: the Paytm import keeps no UPI id.
- **Review flags** (`reviewReasons`): nothing explains the line; a circle payment to the requester's own party; a payment to a party
  whose live account is unverified (a party with no account on record is not flagged); a reimbursement with no bill (there is no
  bill capture yet, so every reimbursement is flagged until session 08); a rule marked always-review. Flags are worked out by the
  server when rows are saved, from the same rules the screen showed. The person who entered a flagged row cannot mark it checked
  (a director can).
- **The Rules page tables** (rules, and categories) are the shared admin table (docs/design-language.md, "Data tables"). Rules stay in the order they run
  (Priority, lowest first) and show When, the category, party, wording, how often each was used and On / Off; chips for On / Off, Payments out / Money in,
  Always reviewed, Names a party, Not used yet; Group by Category, Party, State or Direction. Categories group by Kind as before, with a Rules count and a
  "No rule uses it" chip. Clicking a row (or Change) opens the same sheets as before; Turn on / Turn off is unchanged. Only a director can change either.
- **The requester** is `fin_entities.requester_party_id`, set on the Rules page by a director.
- **Categories can be merged or split later.** Rename, add and retire work at any time. `fin_merge_category` moves every allocation,
  rule and project line to another category of the **same type** (so no budget figure changes) and retires the old one.
  `fin_recategorise_allocations` moves chosen allocations (splitting a category); changing type asks for confirmation. These two
  are the only way a posted allocation's category changes (a session setting the guard trigger looks for), and both are audited.
  The merge is on the Rules page; recategorising has a route (`POST /categories/recategorise`) but no screen yet.
  A third narrow exception (migration 0086): `fin_set_allocation_party` gives a posted allocation a party only when it has none
  (never replacing one, never on a refund); `POST /allocations/{id}/party`, audited as `finance.allocation_party_set`, and a closed
  month needs close-period and a reason. In bulk, `GET /ledger/missing-parties` proposes a party for every posted line without one (read from the
  narration and the Paytm name by `proposeMissingParty`, only a certain match: exactly one party, and the two names agree when both exist; a category that needs
  no party is skipped) and `POST /allocations/parties` applies the ticked ones through `fin_set_allocation_parties` (one audit entry for the batch). The ledger's
  "Fill N missing parties" button opens the list; its "Choose for the rest" step (also in that response: `payees`, `noName`) groups every
  line no certain match covers by the payee the bank names (`payeeOf`; one row per unit for maintenance), offers `candidateParties` as the best
  match and a unit's residents first, and applies one chosen party to all of that payee's lines through the same `POST /allocations/parties`. A
  maintenance payee cannot be added there (members come from the member records); lines with no name in the narration are left for the line sheet. The posted-line sheet offers it as "Add party", and double-clicking the party cell of such a line edits it in the table row.
- **The Ledger is a table** (docs/finance/FINANCE.md, "The table", below). Filter chips (To allocate, To review, All) with counts and a
  search; a checkbox on every line, shift-click for a range; category, party and wording are cells you edit in place; a bar for what
  to do to the selected lines; posting is a separate, confirmed step. A line that needs splitting, a refund or a review decision opens
  in a sheet (click its narration). Months close at the bottom. Verified in a browser (desktop, dark appearance) with invented data; not
  yet with real data, the light appearance or a phone.
- **Audit.** Every save, review decision, rule and category change, period close and recategorisation is written to `fin_audit_log`
  first, with ids and counts only (never a name, narration or amount); if it cannot be written nothing changes.
- **Scale, and the 1,000-row cap.** Supabase's API returns at most 1,000 rows per request whatever `limit` is asked for. The first
  version asked for 10,000 and silently showed only 1,000 of the 1,376 lines (found the first time it was opened on real data). Every
  read of lines or allocations now goes through `rowsAll` in `lib/finance-ledger.ts`, which pages 1,000 at a time in a stable order;
  never use `limit=` above 1000 there. The endpoint test's fake database enforces the same cap, with tests at 1,376 lines and 1,200
  posted allocations. The list still works each line's state out in the function (a few thousand lines is fine); move it into SQL
  before the ledger reaches tens of thousands of rows.
- **Database guards** (checked on a throwaway local Postgres, 2026-11-05): a short sum cannot be posted, an over-sum cannot be
  saved, a split posts, a posted row cannot be changed or deleted, a reversal needs the opposite direction and cannot exceed what is
  left or be reversed itself, a closed month refuses without the override, a merge refuses across types, and the functions run for
  `service_role` only.
- **Tables and functions** (`0083`): `fin_rules`, `fin_allocations`, `fin_vouchers` (table only; capture is session 08),
  `fin_entities.requester_party_id`, `fin_save_allocations`, `fin_close_period`, `fin_merge_category`, `fin_recategorise_allocations`.
- **Tests:** `finance-allocation`, `finance-rules`, `finance-ui` (pure) and `finance-ledger-endpoint` (the real function through
  `requireStaff` with Supabase stubbed: posting, splits, closed months, flags, maker-is-not-checker, refunds, period close, batch posting,
  rules, categories, the requester).

## Suggestions (session 05 follow-up: a category, a party and "what it was for" for every line)

`scripts/lib/finance-suggest.mjs` (pure, tested in `finance-suggest.test.mjs` with invented narrations in the real statement's
shapes), used by `lib/finance-ledger.ts`. It only proposes; a person posts, and nothing is created or posted without a click.

- **Where the clues come from, strongest first:** (1) a rule a director wrote; (2) what was posted before for the same party or the
  same name in the same direction (3 or more earlier postings, 80% or more to one category, is confident; fewer is fairly sure or a
  guess; a coin toss suggests no category); (3) the bank's own entries, matched to a category by name (service charges and the tax on
  them to Bank charges, interest to Interest income, ATM cash to Petty cash; a renamed or retired category is simply not suggested);
  (4) the narration: the counterparty's name and the remark the payer typed (the Paytm remark when there is one).
- **Reading a narration** (`parseNarration`): UPI (name is the 4th part, payer's remark the 6th), net-banking NEFT and RTGS (the payee is
  the part after the transaction reference), IMPS, internal transfers, card payments (merchant), and the bank's own entries. A remark is
  ignored if it looks like a bank name, an IFSC, a generic word or fewer than three characters.
- **Party:** an exact match to the register (case, punctuation and "Pvt Ltd" ignored), or the shortened form a bank prints (every word
  is the start of a distinct word of exactly one party's name). Two parties that fit, or one short word, match no one.
- **A name that is not in the register** is offered as a **new party** (vendor for a payment out, customer for money in). In the editor
  the add-party form opens by itself, pre-filled; "Add a new party…" in any party picker does the same. It uses the existing create-party
  route (needs `allocate`), warns if the name is already there, and adds the party to every picker in the sheet. Bank details are added
  and verified later on the Parties page.
- **In the table** each unallocated line shows its suggestion as an italic ghost value in the cell, with a tick to accept it ("Fill in the
  suggestions on this page" and "Accept suggestions" fill every empty cell at once; nothing is posted). A suggested NEW party is never
  added in bulk: the tick in that Party cell adds them to the register. A suggested party reads the way it will be recorded, kind first, like the party field once it is chosen (`Vendors › Test Fuels`; a new one `Vendors › Test Fuels (new)`, as a vendor for money out and a customer for money in): `suggestedPartyText` in `finance-picker-nodes.mjs`. The new payee's name is the bank's own text, as shown; it is not re-cased or spell-checked. Every party shown in a line reads that way too, posted, drafted or suggested (`partyShown` in the page), so a line looks the same before and after it is recorded; the column search, Filter to and Group by still use the plain name. The line's sheet explains the suggestion in plain words
  ("4 earlier payments like this were all Materials and supplies").
- **It improves as you post:** each posted line teaches the next. Loading the sheet's history (session 06) will teach it far more at once.
- **Not done:** suggestions are not yet turned into rules with one click; the amount (a repeating figure such as a rent or a salary) is
  not a clue yet; merchants on cards are only matched to the register by name.

### UPI ID names (migration `0102_finance_vpa_names.sql`, **applied 2026-11-16**)

A UPI payment to a person often shows only their UPI ID, so the suggested new party reads like `Vendors › q000111222@ybl on PhonePe (new)`.
Razorpay's validate-VPA call says whose ID it is, so the suggestion can be the person's name instead.

- **Where:** `scripts/lib/finance-vpa.mjs` (pure: find a UPI ID in text, pick the IDs still to ask about, read Razorpay's answer),
  `suggest()` takes `vpaNames` (lowercase ID to registered name), `lib/finance-ledger.ts` (`lookupVpaNames`, `vpaAnswers`) and
  `validateVpa` in `lib/razorpay.ts`. Tests: `finance-vpa.test.mjs`, `finance-vpa-endpoint.test.mjs`, three more in `finance-suggest.test.mjs`.
- **Cache:** every answer is kept in `fin_vpa_names` (ID, whether it exists, the name, live or test key, who asked, when), so an ID is asked
  about **once**. RLS on, no anon/authenticated grant. Only answers from live keys are used; a test-key answer is kept and ignored.
- **It never runs by itself.** The call is billed by Razorpay (the price is not confirmed), so the ledger toolbar shows **Look up N UPI names**
  while unallocated lines still carry a bare UPI ID and the person may allocate. One click asks about at most 25 IDs
  (`POST /api/finance-admin/vpa-names`, needs `finance` / `allocate`), stops at the first failure and says why, and the page then reloads.
  IDs already asked about, with or without a name, are not offered again.
- **The UPI page (`/internal/finance/upi/`) has the same button and two columns.** The ledger suggestion reads a UPI row's "Paid to", so looking
  names up there names every linked ledger line too (one saved answer per ID; the ledger and the UPI page ask the same endpoint). **Name** (shown
  by default) is the registered name when looked up, else the name the app showed, else "Not looked up yet" / "No name on file" for a UPI ID.
  **UPI ID** (hidden until turned on in Columns) is the ID found in "Paid to"; it follows the masking rule for payee UPI IDs (`payeeFieldVisibility`):
  in full for holders of `verify-payee` or `export`, otherwise `p••••@bank`, while the name is shown to anyone who can view. Both are derived per
  request by `vpaFieldsFor` and never stored: the UPI rows are locked after import. The existing "Paid to" column still shows the app's raw text,
  ID included, to anyone who can view (unchanged). `GET /upi-lines` returns `upiId`, `vpaName`, `vpaState` (`named`/`asked`/`new`/null) per row
  and `canSeeUpiIds`; before migration `0102` it answers with every ID as `new`.
- **The UPI table's Party column says whether each person is in Parties** (`scripts/lib/finance-upi-parties.mjs`, `partyStateFor`, tested in
  `finance-upi-parties.test.mjs` and `finance-vpa-verify-endpoint.test.mjs`). The match is by **UPI ID first** (a party holding that ID, compared by
  the keyed fingerprint, never decrypted), the name only checking it. States: **In Parties** (ID on a party and Razorpay's name fits it, or a plain
  app name matches one party), **In Parties, name not checked** (ID on a party, not looked up), **Name differs** (ID on a party but Razorpay's
  registered name does not fit the party's name or the name the bank showed when verified: shown with both names, to review and, if the party is
  wrong, rename on the Parties page), **ID not on file** (no party holds the ID but the registered name matches one), **Not in Parties**, **Not
  looked up yet**, **No name on file**. "Fits" is the same `namesResemble` the verify sheet uses (honorifics, company suffixes and brackets
  ignored; one name inside the other). Filter chips: Not in Parties, Name differs, ID not on file, In Parties; Group by Party.
- **Reviewed add (`POST /upi-lines/add-parties`, `finance` / `allocate`).** The toolbar button **Add N to Parties** (one entry per person, not
  per payment) opens a list: tick who to add, edit the name and kind (a debit's person is a vendor by default, a credit's a customer; never a
  member). Confirming adds each person to Parties with their UPI ID attached as **unverified** details (a second admin verifies it), and attaches
  an ID to the party whose name matches ("ID not on file"). The server works out each row's need from its own data and does only what that state
  allows, so a name typed on the page cannot add someone the lookup has not named; a party with a similar name already is skipped with the reason.
  Rows for the same person are done once. Audit: `finance.upi_parties_added` with counts, plus the usual `finance.party_created` and
  `finance.payee_added` (ids and the method only). Nothing is auto-added: a person always reviews the list.
- **What changes in a suggestion:** with a name on file, the register is searched for it first (an exact or shortened match suggests that
  party, "The UPI ID is registered to "X", which matches Y in the register"); otherwise the name, in readable case, is the new party to add.
  With no name on file (the ID has no linked bank account, or does not exist) the line reads as before. Nothing is created or posted until a
  person accepts.
- **Accepting a looked-up name attaches the UPI ID as evidence-backed, unverified details.** The new party is created with the ID as an
  **unverified** UPI payment detail (the suggestion carries `newPartyVpa`, only when a lookup supplied the name). Nothing is auto-verified:
  a different admin with `verify-payee` (the person who adds details cannot verify them, `canVerifyAccount`) opens the verify sheet, where a
  UPI account now offers a method **"Razorpay UPI ID lookup (registered name)"** (`razorpay_vpa`, migration `0103`; bank accounts do not).
  One click: the server takes the registered name from the saved answer, or asks Razorpay once, and records it as the name the bank showed
  (`verified_name`). The name is Razorpay's, never typed or sent by the page; with no registered name, no live key or a failed call it is
  refused with the reason and the details stay unverified. Needs the MFA step-up like every verification. Code: `lib/finance-vpa.ts`
  (`registeredNameOf`), `verifyPayeeAccount`, `verifyMethodsFor` in `finance-parties.mjs`; tests: `finance-vpa-verify-endpoint.test.mjs`.
- **Audit:** `finance.vpa_names_looked_up` with a count and the key mode, never an ID or a name; verifying logs `finance.payee_verified` with
  the method `razorpay_vpa` and no ID or name.
- **Account setup:** Razorpay support enabled `/v1/payments/validate/vpa` on the live account on 2026-11-16 (before that it answered 400
  "URL not found"). The account's per-call charge is still unconfirmed; check the Razorpay dashboard before looking up in volume.
- **Not done:** a lookup is not offered from the Parties page (the verify sheet does ask Razorpay once when no answer is kept); migration `0103` was **applied 2026-11-16**; no auto-verify rule (a director decision); bank accounts are not checked this way
  (Razorpay's bank-account validation is a RazorpayX product and is not set up).

## The table (the Ledger's list view, session 05 follow-up)

> **Update (2026-11-05):** the page no longer asks the server to search or sort: it fetches every line once (`GET /api/finance-admin/ledger/all`) and applies the same rules from `scripts/lib/finance-columns.mjs` in the browser. The server's `GET /ledger` list route and its column handling remain (tested), but nothing uses them now; remove them in a later change once the new page has been used on real data. The notes below under "After the first UX audit" describe the current page.

Modelled on how ServiceNow lists work, because the sheet's convenience was selecting many lines and giving them details at once.

- **Rows and cells.** One row per bank line: date, narration (click it to open the line), amount, **category**, **party**, **what it was
  for**, status. Those three cells are editable in place on an unallocated line; a posted line shows what it was allocated to, read-only.
  Status: *Needs details*, *Suggested* (an empty cell has a suggestion), *Ready* (category and wording filled), *To review*, *Partly*,
  *Allocated*.
- **Drafts.** What you type is a draft that lives in the page only; a warning appears if you try to leave with unposted drafts. Posting
  is the second step: **"Post N ready"** (the bar) asks first, then posts the ready lines, each in full. Two steps by decision: filling
  cells is reversible, posting is not. Drafts are also kept in the browser and offered back on the next visit; **Fill them in again**
  restores them, selects the ready ones and turns on the **Filled in, not posted** status filter. That filter and **Needs a reason**
  (a category or party but no wording yet) are in Filters, so you can see which lines carry something not yet posted. Server-side
  drafts without wording are not possible yet: the database requires wording on every allocation row. A cell that holds your draft (category, party or wording, typed, applied, accepted or restored) has a white box with a green outline and the tooltip "Yours, not posted yet" (also hidden text in the cell, so a screen reader and a phone get it); suggestions stay grey italic. In the card layout the grey line under a line's date reads "Yours: category · party" instead. The "N lines are filled in but not posted yet" note has **Discard these**: after a confirm it clears every unposted draft (category, party, wording, and the maintenance year/unit picks), on the page and in the browser's saved copy, and offers Undo (toast or Ctrl+Z for two minutes). It only touches drafts: it makes no request to the server, skips any line that has been posted, and leaves posted lines exactly as they are. Two tabs of one account share the browser's drafts: a save keeps what another tab stored and lays its own on top, so neither wipes the other. *Fill N missing parties* is a toolbar button beside *Fill in the confident suggestions* (it writes to the ledger), not a chip in the search box, and the progress line leads with the queues (left to allocate, to review, posted without a party) before "Showing X of N"; each non-empty queue is a button that shows just those lines (press again to show every line). A payment out whose bank narration says UPI but that has no BHIM or Paytm record linked to it is marked **No UPI record** in the Origin cell (in the card layout, at the end of the grey line), counted as "N UPI payments with no UPI record" in the progress line, and has a **UPI, no UPI record** status filter. Money in is not flagged: no UPI app record is expected for it. Column names match everywhere on the page: **Paid to / from**, **Bank narration**, **What it was for** (column search, sort list, Group by and the Rules page).
- **Selecting.** A checkbox on every editable line; the header checkbox selects the page; shift-click selects the run between two
  lines. Lines that cannot be edited here (already posted, partly allocated, waiting for review) cannot be ticked.
- **The bar** appears under the table when lines are selected and sticks to the bottom of the screen, as three labelled steps: **1 · Set
  for all** (category, party and what it was for, then *Apply to N lines*, strong only once a box is filled), **2 · Or use suggestions**
  (*Accept suggestions*: fills empty cells only, never replaces what you set) and **3 · Post** (*Post N ready*, with why it is off beside
  it). The top line counts selected, ready and those needing what it was for, with *Show those* (turns on the *Needs a reason* filter),
  and *Clear*. The bar is a green-tinted band with a green top edge, so it reads as the place to act and not as more table. The page keeps space under the table so the bar never covers the last rows, and a toast (with its Undo) is lifted above the bar. On a phone the bar is compact (category and party side by side, the helper notes hidden except Post's reason and the guess warning). The *Accept suggestions* note says how many of the selected lines rest on a guess.
- **Apply to the others.** Change a cell on a line that is one of several selected and the bar asks "Apply this to the other N
  selected lines too?" (Apply to all / Only this line).
- **Keyboard.** Enter in a wording cell moves to the next line's wording cell.
- **Posting many.** `POST /api/finance-admin/ledger/post` takes up to 15 lines, each `{ lineId, categoryId, partyId, nature }`; the amount
  is always the line's. It reads the lookups, rules and accounts once for the batch, writes an audit row before each save, and returns
  `{ posted, flagged, failed: [{ lineId, error }] }`: a line that cannot be posted (already posted, a closed month, a retired category,
  a party not in the register) is reported and does not stop the others. The page sends 10 at a time and shows progress; failed lines
  keep their draft, stay selected, and show the reason in red. This replaced the earlier one-category "bulk" sheet and the server-side
  "post the confident suggestions" route.
- **Sorting.** Click any heading to sort the whole ledger by it (not just the rows on screen); click again to flip. A first click sorts date
  and amount newest and biggest first, the text columns A to Z. Empty cells always go last, so sorting by Category brings the filled ones
  to the top. Status sorts in working order: to review, to allocate, partly, allocated. Ties break by newest date then id, so paging a
  sorted list never repeats or skips a line.
- **Search under each heading** (date, narration, amount, category, party, wording), applied by the server to every line, combined with
  the chips and the narration search box, and shown as a breadcrumb of removable conditions ("To allocate > Category != Bank charges").
  What can be typed (`scripts/lib/finance-columns.mjs`, hover a box for the same list):
  - text columns: `word` contains; `=word` exactly; `!=word` is not; `^word` starts with; `!word` does not contain; `=` alone is empty;
    `!=` alone is not empty. Any case.
  - amount, in rupees: `2500`, `>2500`, `>=`, `<`, `<=`, `!=2500`, `1000..3000`.
  - date: `2026-10` or `oct` (matches the ISO date or the day-and-month label), `>2026-10-15` (also `>=`, `<`, `<=`, `=`),
    `2026-10-01..2026-10-31`.
  - Category, party and wording match what a posted line was allocated to or, while it is unposted, what is suggested for it. So
    `Category = Bank charges` finds the lines that look like bank charges, and they can be selected and filled in together; `Category =`
    finds the lines with nothing suggested.
  - A condition that cannot be understood is not applied: the box turns red and the reason shows in the breadcrumb row (nothing is
    quietly ignored). The chips' counts are for the lines that remain after the conditions, so they say how many of THESE still need you.
- **Not done:** column chooser, grouping by month, saved filters, a Status search box (the chips cover it); drafts are not saved on the
  server (the earlier `Save draft` of the sheet still is).

### Member parties (LIVE 2026-11-06: migration `0085` applied, backfill run)
- **The idea:** every person in the member records has a party, linked to them and to their household, so a payer is chosen from members (not typed) and the unit follows. It also
  stops a member being added by accident, and later lets the category narrow the party list (Member money shows members first).
- **The model:** one party per **person**, not per household (the people who pay are individuals; the household is where the payment is booked). Migration `0085_finance_member_parties.sql`
  (**applied 2026-11-06**, by hand in the SQL editor) adds `fin_parties.person_id` (unique among active parties, kind `member` only) and turns the one-party-per-household index into a plain one.
- **The plan:** `scripts/lib/finance-member-parties.mjs` (tested on invented data) matches existing parties to people by normalised name; it never merges, renames or re-kinds. A person with no
  party gets one; a same-named member party is linked; same-named people, same-named parties, a same-named party of another kind, and member parties that match nobody are listed for a person.
  `scripts/backfill-member-parties.mjs` is a dry run by default (counts, and `--out` for a worklist kept out of the repo); `--apply` writes, with `--canary N` first.
- **Dry run 2026-11-06:** 102 people (101 active) in 53 households, 123 active parties of which 7 are kind member. It would create 97, link 4, skip 1 inactive; 3 member parties matched no person
  (bank-printed names that differ from the member records). With a person's answers for those three (`--answers party,person` lines, kept out of the repo) it would create 94, link 7,
  skip 1 inactive, and leave nothing undecided.
- **Run 2026-11-06:** a canary (2 links, 2 creates) was checked, then the full run: **94 created, 7 linked, 0 failed**. The one inactive person (in no household) was left out on purpose. Checked afterwards:
  101 member parties linked to the 101 active people, each with a unit that matches a real household membership; no active person without a party; no duplicate member names; no member party left unlinked;
  the 118 other active parties untouched (that count includes 2 merged-away ones); linked parties kept their names and bank details. Four bank names differ from the member record and were linked through a
  person's answers (a full name, a name with a title, a label with "TVC", and a short name). Two audit entries (`finance.member_parties_backfilled`, counts only).
  **Left to do:** add the `finance_member_parties` row to the migration history (the SQL editor does not record it) so the CI check passes.
- **Afterwards:** `0085` also adds a trigger on `member_household_members`: whoever puts a person into a household (the portal's family request, the admin member screen, an approved request, the
  import) gets a party if they have none (or an unlinked same-named member party is linked), and their party's household follows them if they move. It never renames or deletes, and it swallows its own
  failures so it can never block adding a member. **Removal:** taking someone out of a household (or marking them inactive) changes nothing in finance: their party stays active with the unit it last
  had, since an ex-member can still pay arrears and old payments must keep matching; a hard delete of the person row only clears the party's `person_id` (`on delete set null`). Someone removed and
  later re-added as a new person record gets a new party (the old one is linked to the old record): merge the two on the Parties page. Both triggers are applied but **not yet seen working on a real family-member add or removal**: check the first one.
- **Built in the ledger (2026-11-06; four commits on `finance-ledger-search-chips`, not pushed, and later work uncommitted):** the category and party fields are **linked pickers** (`docs/linked-picker.md`): one field, one level at a time,
  a row marked ⟹ opens the next level with the levels above kept on screen, and typing searches only the rows being shown. Category: **category > year > unit** for maintenance (the payment date's year first; the payer's own unit first in the unit
  list, marked, never filled in), **category > project** for a capital purchase (also pickable as it is). Party: **kind > party** (Members, Vendors... , All parties); it opens on the kind that goes with the category (`partyKindsFor`), or for a
  unit's maintenance on **People in that unit**; inside Members and People in this unit the add row is replaced by "Members come from the member records". After choosing a category the party field opens by itself. A maintenance line is not ready
  without a unit ("Needs unit" pill, Post disabled). The bar for many lines uses the same two pickers, where Maintenance and each year can also be picked as they are (unit/year left to each line). `POST /ledger/post` items carry
  `householdId`, `maintenanceYear` and `projectId`. Adding a party by typing can no longer make a member (the kind is not offered). The trees are built in `scripts/lib/finance-picker-nodes.mjs` (tested); the picker's rules in
  `scripts/lib/linked-picker-core.mjs` (tested). `combo()` (flat lists in the line sheet, Rules and Parties) is a thin wrapper over the same component.
- **Where the links come from:** real relationships (party kind, a member's unit through `household_id`, a unit's people through `member_household_members`, an allocation's project) are read from the data. Two links are **conventions in code**, because
  the tables have no relationship for them: *category type -> what goes under it* (maintenance: year and unit; capital: project) and *category type -> party kinds* (`partyKindsFor`). Making those data (columns on `fin_categories`, editable
  on the Rules page) is the next step if wanted.
- **Finding a unit by a member's name:** the Unit picker lists each unit with the people living in it beside it and matches on their names (`unitOptions`, the lookups carry each unit's active people); the search box also finds a posted
  line by the people of the unit it was posted to. **Back-filling:** on 2026-11-06 all 178 posted maintenance allocations (all from the history load) already had a unit and a year, so there is nothing to back-fill. For lines still being
  described, the bar's **Accept suggestions** also takes a member payer's own unit for maintenance lines (the automatic "Fill in the confident suggestions" does not, since the payer can be anybody); the bar's year and unit set many lines
  at once. A posted allocation's unit and year are frozen (a reversal and a new allocation corrects them); if a missing one ever appears, a narrowly-scoped audited "set the unit" function is the way, not editing rows.
- **Not built / limits:** the unit, year and project chosen on a line are not kept across a refresh and are not covered by Undo (the party and category still are); the line sheet's pickers do not have the kind chips;
  the server does not refuse a `member` party created through the API without a household (only the screens stop offering it).
- **Still to do:** add the `finance_member_parties` row to the migration history; watch the triggers on the first real family-member add and removal; keep unit, year and project across a refresh and in Undo;
  kind chips in the line sheet's party picker; refuse a `member` party without a household on the server; decide about the one inactive person (no household) if old payments from them turn up.

### How a line is described (the hierarchy, also in the ledger's Help panel)
- **What it was:** category group (`fin_categories.type`: Member money, Running costs, Capital purchases, Income, Taxes…) -> category -> for **Maintenance** the maintenance year (`fin_allocations.maintenance_year`, April-March, starts as the year of the date),
  for a **capital purchase** an optional project (`project_id`). Categories themselves are flat (no parent column); the group is the type.
- **Who:** party kind (`fin_parties.kind`) -> party -> for a **member** their unit (`household_id`). The category type suggests the kinds (`partyKindsFor` in `finance-search.mjs`: member money -> members; revenue -> customers and members;
  running costs and capital -> vendors and employees; tax -> government; interest and transfers -> banks; reimbursements -> employees, directors, members; **maintenance -> no limit**, since anybody can pay it); the person can always widen to all parties.
- **Unit (maintenance):** required, and decided before the payer: year, then **which unit's maintenance**, then who paid. Anybody can pay a unit's maintenance (a member, a relative, a company), so the unit is never assumed from the payer: a current
  member's own unit is only *suggested* (grey, with a tick; `defaultUnitFor`), and the party list puts the chosen unit's people first. A maintenance line with no unit is not ready to post in the ledger (and would go to review as `no_unit` on the server).
- **The narration** is the evidence, not a column by default (hover, open line, date, Columns).

### Search chips, Group By and Favorites (idea 1 of `odoo-inspiration.md`, issue #550)
- **One search box.** Every condition is a chip inside it that you can take off with its × (or Backspace on an empty box). Typing filters live; **Enter** keeps the
  words as a chip, and several word chips must all appear. The arrow opens a panel with three columns: **Filters**, **Group by**, **Favorites**.
  The four old status buttons are now Status chips (To allocate, To review, No party, Allocated); `?filter=review` and the like still open on that chip, `?filter=all` on none.
- **Filters.** Status, Money (in / out) and Date (this month, last month, this quarter, this financial year, April to March). Options of one kind are alternatives, kinds combine
  with "and". The panel shows how many of all the lines each option holds. The search under each column heading still works and combines with the chips.
- **Group by.** Category, Party, Unit, Month, Year, Financial year (April to March, headed "FY 2026-27"), Account, Origin or Status, up to two levels. A heading shows its line count and net (money in minus money out), and clicking it closes it. Groups are
  ordered newest first for months, years and financial years and biggest first otherwise, "No ..." last; sorting orders the lines inside a group. Lines in a closed group are not "showing" for bulk
  actions (select, fill in suggestions, post). The virtual list now holds items (headings and lines); `lines` is only the lines that are showing.
- **Cell and header menus.** Right-click a cell (or long-press it on a tablet; the phone's cards have none) for **Filter to "value"**, **Filter out "value"** and **Group by** that column; it types the condition (`=Fuel`, `!=Fuel`, `=118`) into that column's search box under the heading, so it shows there, in the "Searching:" line, and comes off there. Each sortable heading has a ▾ (or right-click it): **Sort ascending / descending** and **Group by** (Date: Month, Year, Financial year; Origin, Category, Paid to / from, Status: themselves). A Year or Financial year goes outside the grouping already there (Financial year, then Month); anything else goes inside, as in the search box. Over a link, a button, a field or selected text the browser's own menu is left alone, except on the date, category, party and narration buttons, which are the cell's text. The menus are one shared module with the other admin tables (`scripts/lib/admin-menu.mjs`); the Ledger keeps its own filtering, sorting and grouping (`finance-columns.mjs`, `finance-search.mjs`).
  **From the keyboard:** once **Tab** reaches the table, one cell is the cursor (the table's only Tab stop; the tick column is not a cell); the arrow keys, Home, End, Ctrl+Home / Ctrl+End and Page Up / Page Down move it, and it scrolls to a line that is not on the page yet (the list is virtual, so only the nearby lines exist until you get there). The **Menu key or Shift+F10** opens the cell's menu under it (also from the date, category, party and narration buttons, which are the cell's text); Escape gives the cell its focus back, and choosing an item keeps the cursor where it was after the lines are redrawn. **Enter** on a cell does what clicking it does: the date opens the line, a category or party opens the line for editing and puts you in the field. The cursor's logic is `scripts/lib/cell-nav.mjs` (tested), shared with the other admin tables; a phone's cards have none.
- **Favorites.** A named set of chips, words and grouping. Kept in this browser per account (`tvc-ledger-favorites:<email>`), not on the server; saving under an existing name replaces it.
- **Where it lives:** the pure rules (filters, periods, grouping, favorites) are `scripts/lib/finance-search.mjs`, tested in `finance-search.test.mjs`; the page only draws them.
- **Quiet rows (the mockup's look).** A line at rest is one row of text: Date, Amount, Paid to / from, Category, Status. The bank's **narration is not a column**: it is the
  evidence the suggestions come from, so it shows on hover (desktop, a short delay, text only), under the fields when a line is open, in the line sheet (click the date), or as
  a last column if it is shown from the **Columns** button. **What it was for** is a column too (off by default) with the typed, restored or posted wording, or the suggestion in grey italics; it sorts and has a column search like the others.
  **Columns** (the icon beside the search box) is the same menu as on the other admin tables (`scripts/lib/admin-columns-menu.mjs`, saved layout and reset in `data-table.mjs`): show or hide a column, move it earlier or later, Reset to default. The default is Date, Origin, Amount, Paid to / from, Category, Status, with What it was for and Bank narration hidden. Paid to / from and Category are edited in their cells, so they can move but not hide (their boxes are greyed); the tick column stays first. The layout is per account in this browser (`tvc-ledger-columns:<email>`; an account that had switched on the older Bank narration or What it was for toggles keeps them on, read once from their old keys). The grid's columns are generated from the visible ones (`--ledger-cols`), the headings and search boxes are drawn in the layout's order, and each row's cells are re-ordered to match, so the Tab order is what you see. Hiding a column also drops the search typed under it, and a sort on it goes back to Date, newest first. The heading's ▾ has **Hide column** too. A phone shows cards, so it has no Columns button. The fields (category and party selects, the ✓ to accept a suggestion, and the wording box on its own
  line) appear when a line is ticked, has an error, or is opened by clicking its category or party; they close again when focus leaves. Filling in suggestions does not open rows. The
  search under each heading is always shown on the wide table (there is no button for it; it is hidden on a phone, where the headings are). On a phone a line is the date and amount, then category and party in one grey line and the status.
- **Not done:** a Compact toggle and other columns in the picker, Project as a group (a line does not carry its project name), favorites on the server.

### After the first UX audit (2026-11-05)
- **Paytm under the narration.** What the UPI report says about a payment (who, and the remark typed) shows as a second line under the
  narration, so nobody opens the line to see it; a UPI-looking narration with no match says "No Paytm record for this payment". The report
  only starts on 2026-04-26, so older lines have none. Of the 156 UPI-style bank lines since then, 90 had no match in the first look: not yet explained.
- **Who paid, and which unit.** The party is the payer or payee (maintenance can be paid by anybody, for example another organisation);
  the household (shown as `F-01 · H-10`) and the maintenance year show under the category of a posted line, and are what the unit's
  outstanding is worked from. A posted line whose category should name a party but has none shows a red "No party" and is counted by the
  **No party** chip. Bank charges, interest and transfers need none (`partyNeeded`, `scripts/lib/finance-rules.mjs`). New saves with no party
  go to review (`no_party`). Nothing was changed in the posted history: the 591 allocations the history load left without a party are
  found through the chip, not flagged in bulk.
- **Speed.** A list load made about 13 database requests of 200-500 ms each, one after another (2-4 s). Pages of a big table are now asked
  for together, independent reads start together, and the reference data (categories, parties, projects, rules, account states, bank
  accounts, households) is kept for 10 s per instance and dropped on any write through `/api/finance-admin`
  (`cached` / `clearLedgerCache`, `netlify/functions/lib/finance-ledger.ts`). Measured against the real database: about 2.0 s cold, 1.0 s warm.
  Column searches and sorts were still about 1 s each because every one re-read every bank line and allocation. The lines, allocations,
  Paytm links and the suggestion index are now kept for 10 s too, so a search or sort is 40-90 ms and only the first read after 10 s idle
  (or after a write) pays the full 1-2 s. Any write through `/api/finance-admin` drops the cache, and the pages add `fresh=1` to the first
  list read after a write, because another warm instance may not have seen it. Anything that writes behind the function's back (the
  history load, a script) shows up within 10 s.
  **The new ledger after the second review (26/40, five P1s fixed):** the status pill sits under the amount (no Status column), so Category,
  Party and What it was for are wide enough to read; below 1,240px the page is a list of cards (the table needs about 1,000px beside the shell);
  a line under the progress says "a tick only fills a field in; nothing is saved until you tick the lines and press Post", and a note
  says how many lines are filled in but not posted, with a button to tick them; the previous calendar month's status (what is left, or
  Close month when it is done) sits above the table; text boxes and selects have a visible focus ring; sorting and the chips keep focus.
  **Months live in the table (2026-11-06):** the ledger opens on every line, grouped by month, newest first (a chip only when the address asks for one,
  e.g. `?filter=review`). Each month heading shows its state (what is left to allocate or review, Ready to close, or a lock for a closed month) and,
  for someone who can close months, a Close month button once nothing is left. A closed month starts folded away, and a Fold all / Unfold all button beside the chips folds every month at once. The separate Months list under the
  table is gone; the strip above the table still names the previous month's status.
  **Then the P2s:** bulk changes (Fill in the suggestions, Accept suggestions, Apply to selected, the apply-to-others prompt) can be undone from
  the toast, and say how many lines already hold a different value before replacing it; the "Suggested" pill's hover text says what is suggested
  and how sure the app is; the Party column reads "Paid to / from" (cards say "Paid to" or "Received from"); in the line sheet Month, Refund of
  and Project sit behind one "Month or project" expander (refunds open it); the grid has `aria-colcount`, the selection count and the
  "Showing X of N" result are announced from fixed live regions, not the rebuilt bar or the changing progress line; a post updates the lines at once
  and the full list comes down quietly afterwards; the phone bar follows the shell's tab bar and phone targets are 44px; the Rules page has
  finger-sized buttons and a 24px checkbox. Not changed: the grid still scrolls to the top when a search or sort changes (the list is a new list).
  **Third round (30/40, six P1s fixed):** what is typed but not posted is kept in this browser (category, party and wording per line, never an
  amount; flushed when the page is hidden) and offered back on the next visit with Restore or Discard; the list shows the narration without the
  bank's long reference numbers (full text on hover and in the sheet); on a phone the progress line, hint, tips and sort sit behind "More" (the first
  line starts about 170px higher); "Fill in the confident suggestions" fills only high and medium confidence, a weak one shows as "A guess" and is left
  for a person; after a post keyboard focus goes to the line that took the posted one's place; Ctrl+Z (Cmd+Z) undoes the last bulk change for two
  minutes, so undo no longer depends on a toast.
  **Closing round:** a post that loses its connection sends nothing more, marks nothing posted, says how many were not confirmed and refreshes from the
  server; Post cannot be pressed twice while it runs; Undo skips lines posted since; on a phone the More button carries the "N left" count; touch screens of
  any width get 44px targets; the Rules page's small buttons are now really 44px on a phone (the shell's `main .button--small` rule has one more specificity
  point than a plain `.rules .button--small`, so page rules for it must be `main .<page>.section .button--small`).
  The page also asks "Also set category X on the other N selected lines?" when a ticked line's cell is changed, and Alt+Up / Alt+Down
  move to the same cell on the line above or below.
  **The unit and year of maintenance can now be set.** `fin_allocations.household_id` and `maintenance_year` (migration 0084) were read
  by the page but nothing could write them. The line sheet (both pages) shows **Unit** and **Maintenance year** when the category is
  maintenance (year defaults to the financial year of the payment); the save endpoint validates them (the unit must exist, the year looks
  like `2025-26`), a refund copies them from what it undoes, and maintenance saved with no unit goes to review (`no_unit`). The line's
  detail and the lookups carry the units (`households`). The ledger page has the same line sheet (split into rows, refund picker,
  review decisions, add a party).
  **That cache is not reliable under `netlify dev`**, which does not keep a Function's memory between requests: every list call was still
  about 3 s there. So the ledger page does not ask the server to search at all: `GET
  /api/finance-admin/ledger/all` returns every line once (about 2 s cold, 0.8 MB), with what each was posted to or is suggested
  (`effective`), and the chips, narration search, column conditions and sort run in the browser over them with the same
  `scripts/lib/finance-columns.mjs` (a search is about 150 ms, most of it the typing delay). Both pages now show "Updating…" and dim the
  table while a request is in flight, and the progress line names what is being searched and any condition it cannot read.

## History load (session 06, in progress)

Operator script `scripts/load-fin-history.mjs` (a dry run unless `--apply`; run with `netlify dev:exec -- node scripts/load-fin-history.mjs --sheet <id>`),
pure rules in `scripts/lib/finance-history.mjs` (tested on invented rows). Counts only are ever printed. **Nothing has been written to the ledger yet.**

- **Source.** The workbook "TVC Spend Summary" (the sheet id is passed in, never kept here). The tab "Funds Transfer Tracker (2024-27)" has one row
  per payment: date, to, from, mode, amount, the bank's narration copied in ("Transaction Particulars"), DR/CR, and the labels **Details**
  and **Type**, **Remarks**, and the sheet's own Year and Month (the month the cost belongs to, used as the allocation's period). The yearly
  "TVC 20xx-20xx" workbooks owned by the stay partner are that partner's own operating books, not the ledger's source.
- **The bank lines already exist** (statement import, session 03), so the load creates **allocations on existing lines**, never lines.
- **Matching, four passes over what the earlier ones left:** (1) same date, direction and amount, identical candidates paired by how alike their
  narrations are; (2) rows split by hand (a salary batch) whose day's total equals one bank line; (3) the bank's 12-digit reference on another
  date; (4) same direction and amount within 5 days. Approximate matches (3 and 4) are loaded but sent to review. A line is never used twice.
- **Label mapping** (decided 2026-11-05): Salary → Salaries; Farm Expenses, Event Expense, Miscelleaneous, Parking Charges → Operational and
  miscellaneous; Groceries, Bank Charges, Petty Cash, Insurance → same-named; Telecom Charges, Power → Utility bills; Online Services → Software and
  subscriptions; Visit/Camp Revenue → Hospitality receipts; Event Revenue → Event receipts; Taxes, Land Tax → Land and local taxes; **CBDT Tax and Tax
  Refund → Income tax (CBDT taxes are direct taxes)**; Interest Earned → Interest income; FD Investment → Sinking fund deposits; CS and CA/CS Charges →
  Professional fees; Donations → Operational and miscellaneous when paid out (Other income only if received); **Farm Capex → Structures and infrastructure (a default, counted and flagged)**. A row with no Details
  is left unallocated for a person (92 of them), as is any label the load does not know.
- **Member maintenance keeps the year it is FOR.** "Maintenance (24-25)" becomes category Member maintenance with `maintenance_year` 2024-25 (migration
  `0084`, **applied 2026-11-05**), while `period` stays the month the money moved. A member sometimes pays an earlier year late (13 payments in the first dry run), and the
  year is what lets it be set against that year's outstanding. The payer's **household** is found from the "From" name against member names, taken from the member records AND the sheet's *Member Master*
  tab (name and Farm Unit #, tied to a household by farm unit; the sheet lists spouses the records do not): a full name or the shortened form the bank
  prints, or a couple written "First & First" (the one household that has the most of them; a tie finds none). 137 of 178 found a household; the other
  41 come from only 14 distinct names. They are loaded without a household and listed in a worklist file (one line per name, with candidate farm
  units); `--households answers.csv` reads back the farm unit a person fills in, and an answer beats any guess. Session 10 (the dues) builds on this.
- **Farm Project → the Project bucket.** Each such row names a placeholder project for its financial year, "Farm projects (details to add)", status
  proposed, created by `--apply`, under the category Structures and infrastructure. **TODO (Sharath asked to be reminded): record the real projects
  (owner, approval date, planned breakdown) and move these allocations onto them.** Allocations are frozen once posted, so moving one is a reversal and a
  new allocation, or a purpose-built re-attribution; decide which when the projects exist.
- **Salary batches** become one allocation per person on the one bank line, the party found from the "To" name against the register.
- **Dry run on the real tracker (5 Nov 2026):** 1,178 usable rows from April 2024 (one row has no amount); 1,123 (95.3%) matched; **783 bank lines would
  get 1,031 allocations**; 92 matched lines have no label and stay unallocated; 55 tracker rows and 25 bank lines have no match (39 Salary, 15 Online
  Services rows; about half the lines are payments newer than the tracker). A party was found in the register for 440 allocations (the rest have none).
- **Applying.** `--apply` needs migration `0084` (applied 2026-11-05; the script checks, and refuses otherwise). It saves one bank line at a time through
  `fin_save_allocations` (posted, source `import`, no actor), skips any line that already has allocations (so a re-run changes nothing), carries on past a
  failure, and writes one counts-only audit row (`finance.history_loaded`). **`--canary` first:** it loads only the first line of each kind (a plain line, a
  salary-style group, a maintenance payment with a household, a Farm Project line, an approximate match), so the first real write exercises every path and can
  be checked in the ledger before the rest; the full run then skips those lines. **Canary run 2026-11-05: 5 bank lines, 14 allocations, no failures.** Checked afterwards in
  TVC ERP: all posted, source `import`, no actor; every line adds up to its bank line; a salary batch became 10 allocations on one line; a maintenance payment for 2023-24
  carried its year and a household; the Farm Project line created the placeholder project for FY 2024 (status proposed); one approximate match was sent to review;
  every period is the first of a month and within one month of the bank date; one counts-only audit row was written (its detail shows the whole plan's counts, not
  just the canary's). **Full load run 2026-11-05: 778 more lines, 0 failed.** In total **1,031 allocations on 783 bank lines**, all posted (source `import`), every line adding up to its
  bank line, ₹2,34,94,151 loaded; 178 maintenance rows each with a year and a household (2023-24: 12, 2024-25: 64, 2025-26: 55, 2026-27: 47); 21 Farm Project rows on placeholder
  projects for FY 2024, 2025 and 2026; 8 sent to review; 440 with a party in the register. 117 bank lines since April 2024 are still unallocated (92 with no label in the tracker,
  25 the tracker does not mention). Per category the counts equal the plan's. **Corrected the same day:** the 3 "Donations" rows were payments OUT (₹30,000) that the load had filed under Other
  income; they were moved to Operational and miscellaneous with `fin_recategorise_allocations` (one audit row, `finance.allocations_recategorised`), and the mapping now
  files a paid-out donation as an expense. Posted allocations cannot be deleted, so a wrong load can only be
  corrected by reversals: that is why the canary comes first, and why a purpose-built, audited "unload imports" function (import-sourced allocations only) was
  proposed to Sharath.
- **Pre-load audit (5 Nov 2026, counts only):** every planned line adds up to its bank line; the tracker's total equals loaded + unlabeled + no-bank-line
  exactly; all 845 one-to-one matches have agreeing narrations; every allocation's month is within one month of its bank date; every category exists and is
  active. Refunds load as ordinary allocations the other way (20 money-out lines under income-like categories, 21 money-in under cost categories), not as
  reversals, so reports must net by direction.
- **Not built:** the reconciliation of module totals against the sheet's own summary tabs by month and category; rules are not seeded (the hidden
  "Lookups" tab holds only payment-mode keywords, and the suggestion engine learns from the loaded history instead); the 2023-24 tracker tab and the
  older years (the ledger holds 476 bank lines before April 2024; the same script takes `--tab` and `--since`).

## Payment requests and spend logs (session 08, first slice, migration `0092_finance_payment_requests.sql`, **applied 2026-11-07**)

One table, `fin_payment_requests`, holds two kinds of record with the same fields (rules in `scripts/lib/finance-requests.mjs`, server in
`lib/finance-requests.ts`, routes in `finance-admin.mts`):

- a **request**, raised before paying: payee (a saved party), amount, mode (NEFT, UPI, IMPS, RTGS), purpose, needed-by, optional "paid in cash,
  reimburse me" (which needs a bill before it can be approved). Flow: `submitted` -> `approved` / `rejected` -> `paid` (set when a payment is matched) or `cancelled`.
- a **log**, a spend already made by UPI (a UPI Circle delegate or a direct payment) recorded afterwards by whoever paid: payee (saved party or a
  name as typed), amount, date, direct or delegate, optional 12-digit UPI reference, purpose, a photo of the payment. It needs no approval (stored as `paid`).
  A log (or request) whose payee is the requester party (Settings, `requester_party_id`) is flagged for review; another person clears it.
- `fin_vouchers` (from 0083) gains `request_id` and `kind` (`bill` | `payment_screenshot`). Files go to the private R2 prefix `finance/vouchers/`
  (JPEG, PNG, WebP or PDF, checked by their first bytes, 4 MB each) and are read back only through `GET /vouchers/:id` (the person who raised the record, or `finance` view).

**Who may do what.** Raising, logging, attaching a file and adding a vendor: `finance-requests` (the farm manager) **or** `finance` `request`;
holding `finance-requests` opens nothing else (tested, including that it is not treated as a `finance` role when checking who may attach a file).
The list of every record needs `finance` view; matching and clearing a flag need `allocate`; approving needs `approve` **and** the MFA step-up;
whoever raised a request can never approve or reject it (`decide`, `makerIsNotChecker`). Every change writes `fin_audit_log` first (ids and field names only).
Submitting a request emails `core-team@` (best effort; WhatsApp not used). A new vendor added by a requester is an unverified party; an approver verifies it on Parties.

**Pulled, not copied.** A record's purpose is shown on the UPI page (the Note column) and in the ledger (under the narration, italic "For: ..."; the
line sheet's note box starts with it) as the default wording until a person writes a payment note, exactly like a Paytm remark; the payment note
(`fin_payment_notes`) stays the manual override. `loadPurposes()` looks a payment up by UPI reference, UPI row or bank line.

**How a record is matched.** Exactly, by the 12-digit reference (a log typed with it, or loaded from the old sheet), joining the UPI row and the bank
debit that carry it, only when the amount agrees (a reference with a different amount is flagged, never linked; a reversal credit is not the
payment). No reference: `proposeMatches` suggests a UPI row (within 3 days) and/or bank debit (a UPI log within 3 days, a NEFT request up to 21 days
after approval) of the same amount, better when the payee name is in the row, and when a word of the record's purpose (four letters or more, not a common one) is in the UPI remark or the narration (`description matches`); the Approvals page highlights those words, the amount and the day; a person accepts one (`POST /requests/:id/match`, which re-reads the
statement row and re-checks amount and direction; accepting marks a request paid on the statement date). Linked automatically only when there is no doubt (`autoMatchPicks`): a record whose ONE suggested payment is wanted by no other record (two candidate payments for the record, a UPI row and a separate bank line included, or one payment suiting two records, leaves everything as a suggestion for a person). The Approvals page asks for this when it loads: the list reports `autoPending` (a read never writes) and the page then calls `POST /requests/auto-match` (`allocate`), which re-checks each against the statement exactly as accepting a suggestion does, writes the audit entry `finance.request_auto_matched` first, and leaves `matched_by` empty: that is how an automatic match is told from one a person made (`matched: 'auto'` against `'accepted'`; a link loaded from the old sheet also has no person, so it reads as automatic). A match without a reference, automatic or by a person, can be undone with **Unmatch**; unmatching stamps the person on the record (`matched_by` stays set with no link), and such a record is never matched automatically again, though it is still offered as a suggestion and can be matched by hand. No migration. **One link is enough** (`deriveLinks`): a UPI row is joined to its bank line, so a record linked on either side is linked on both; the other side is derived (never stored twice), a payment already taken on either side is not offered or accepted for another record, and the Approvals page's **Match** column shows a pill for each place the payment is tied (`UPI`, `Bank`), each a link to that payment on the UPI page or that line in the ledger. An approved request
unmatched for 14 days is counted on the Approvals page.

**How it was paid.** A request may be paid another way than asked (asked for NEFT, paid by UPI), so every record is offered both UPI rows and bank lines
to match, and the Approvals page has a **Method** column: the method of the payment it is tied to (`fulfilledVia`), else what was asked in grey (the
tooltip says so), with a small orange "asked for NEFT" when they differ. A UPI row names its app ("UPI, Paytm"); otherwise the bank's narration says,
read off the real statements from its first two segments: `NEFT/...`, `IMPS/...`, `UPI/...`, and internet banking as `INB/NEFT/...` (most NEFT payments) or `INB/IFT/...` (an internal transfer); card lines are "Card"; the
rest (GST, charges) are "Bank transfer". The old sheet never recorded a method, so records loaded from it have none (`mode` is null; migration `0093`, **applied 2026-11-07**,
cleared the NEFT placeholder the first load wrote from the 164 requests). Old-sheet rows carry a small `*` beside the date and a footnote under the table.

**Pages.** `/internal/finance-requests/` (the requester's, built for a phone: ask for a payment, record a spend, add a vendor, attach a photo, see their
own records, cancel) and `/internal/finance/requests/` (nav "Approvals": to approve, to match, to review, all; approve behind the unlock, reject with a reason, accept a suggested match, open the files).

**Both tables are the shared admin table** (docs/design-language.md, "Data tables"). Approvals opens on the first view that has something in it (To approve, To
match or To review; these three are alternatives, so two together show both), and has chips for Requests / Logged spends, Approved / Paid / Rejected /
Cancelled, Matched / Not matched, Amount differs and From the old sheet; column filters; Group by Month, Status, Payee, Kind or Requester; Favorites per
account. The suggested payments open as a full-width row under the record; a record just acted on stays, highlighted, until a filter changes; the Actions
column stays in view while the table scrolls sideways. On a phone each record is a card holding the same cells. The requester's page has the same table
over their own records (status chips, Needs a bill). Nothing about who may do what changed.

**History load (operator script, run once).** `scripts/load-fin-requests-history.mjs --sheet <id> [--apply]` (dry run by default; counts only are printed):
the old sheet's "Fund Transfer Request" tab becomes already-paid requests and its "UPI Circle Transactions" tab becomes logs (`source = 'history'`, no requester).
Rules: failure/expired rows moved no money and are skipped; a row naming a bank account that is not a registered one is skipped; a row naming our bank and CR is money in
and is skipped; a row naming no bank is a delegated payment out; references are padded to 12 digits; rows without a purpose are skipped. A row links to a saved
party by the account number's fingerprint, then by an exact name that is unique; otherwise the typed name is kept. Account numbers are fingerprinted, never stored or printed here.
Running it again adds nothing. Checked against the real sheet read-only (parse only, no write): the columns and formats are as the parser expects.

**Daily sync (Netlify scheduled function, 07:00 IST).** `netlify/functions/finance-requests-sheet-sync.mts` runs the same code as the script
(`scripts/lib/finance-requests-sheet-sync.mjs`, tested with invented rows) every morning, so rows people add to the sheet after the first load keep arriving
(this supersedes "nothing is read from the sheet at run time": the sheet is still being filled in). **Insert-only:** a row already loaded is skipped (matched by date and amount, counted, since names and purposes are edited after loading; and only rows without a reference dated within 7 days of the latest loaded one are considered, because older sheet rows differ from the database in date or amount in about 44 cases, so a wider match would load duplicates; a late entry dated earlier than that is missed); a row
*edited* after it was loaded is not updated, and a row that was pending and later completes is picked up then. Needs `FIN_REQUESTS_SHEET_ID` in Netlify (without
it the function logs and does nothing) and the sheet shared with the Drive service account. A run that adds rows writes one `finance.requests_sheet_synced`
audit row (a count); a failed run writes `finance.requests_sheet_sync_failed` (no sheet content) and a 500 in the function log. **Not verified:** a real run
(the variable is not set yet, and the function deploys with the next merge to main).

**Not built yet (next):** the bill scanner (edge detection, crop, multi-page) and the vision reading of vendor, date, amount and UPI reference off a bill or screenshot (the files are
attached as plain photos today, and the reference is typed); approver-queue polish; per-delegate spend limits (built with the delegates, see **Delegates** under the UPI page); a vendor bulk file;
payment links from the ledger's Paypro/bank lines to a request. **Not verified:** the pages in a browser on a real phone, the upload to R2, the approval email, and the loader's `--apply`.

## Dashboards (session 07, migration `0098_finance_budget.sql`, **applied 2026-11-10**)

Page `/internal/finance/dashboard/` (Finance › Dashboard), five views for one financial year switched at the top: **Overview**, **Cashflow**,
**Budget vs actual**, **UPI circle**, **Data health**. Designed in the session 02 mockup (`docs/finance/mockups/dashboards.html`).
Every figure comes from `GET /api/finance-admin/dashboard?fy=2026` (`lib/finance-dashboard.ts`; needs `finance` / `view`; an auditor's visit is
written to `fin_audit_log` as `finance.dashboard_viewed` and refused if it cannot be). The formulas live once, in `scripts/lib/finance-metrics.mjs`;
the page draws from `scripts/lib/finance-dashboard-view.mjs` (pure, tested) using the `--tvc-chart-*` tokens.

- **Two views, never mixed on a screen.** *Cash view* (Cashflow) groups by the bank line's date. *Period view* (Budget vs actual) groups by the
  allocation's `period`, so a March salary paid in April is March's. Only **posted** allocations count; a draft explains nothing yet.
- **Cashflow.** Per month: money in and out as the bank saw it, the closing balance (each account's opening implied by its first line, plus every
  movement, summed), maintenance against other money in, and money out split into salary, farm and household, projects, company, sinking fund and
  *not yet explained* (the part of a line nobody has allocated), so the groups always add up to the bank's figure. A refund is money in here; the period
  view nets it against the spending.
- **Groups and heads.** `groupOf`: the sinking fund first, then anything naming a project (a project's pay counts under the project), then salary, then
  the category's head. `fin_categories.head` (`company`, `farm`, `projects`, `investment`) and `is_salary` are set by `0098` for the seeded categories by
  name; a category with no head shows as "Not in any head". There is no screen to change a head yet (the Rules page needs a select).
- **Runway** = bank balance ÷ the average monthly *spending* (out, less the sinking fund) of the last six complete months, with the sinking fund
  added as a second figure. It deliberately ignores money still to come: maintenance arrives in lumps, so a net figure would swing with every
  collection. Fewer than six months uses what exists; no spending gives "not enough yet". A closed year's runway is as at 31 March, and the window may
  reach back into the previous year.
- **Budget vs actual.** Lines come from the live (approved) version of the year's budget, or the newest draft when none is approved. Actuals net refunds.
  A category line counts only allocations that name no project; a project line counts the ones that name it. Spending with no line is listed as *not
  budgeted* and still counted in the totals. Only the farm's running costs get a year-end estimate (actual ÷ share of the year gone), labelled as an
  estimate; status: on track up to the budget, watch to 110%, over pace beyond; a closed year says within, slightly over or over. **Committed** (approved
  requests the bank has not shown yet) is one total, not per line: a payment request has no category.
- **UPI circle.** The spend rule is `finance-upi-circle.mjs` (a circle payment out, per calendar month, against the ₹15,000 cap); the dashboard adds
  how much of the month is gone, and an estimate of the day the cap runs out at this month's pace.
- **Data health.** Counts and dates only: bank lines not fully explained, approved requests waiting for a bank line, plus the overview's counts (payees
  to verify, entries held for review, statement gaps). It always describes today and says so on a closed year.
- **Budget tables (`0098`).** `fin_budget_years` (one row per year and version: draft → approved → superseded; at most one approved per year) and
  `fin_budget_lines` (a category or a project, an annual amount, optional 12-month phasing that must add up, a comment). Lines of an approved
  version are frozen; `fin_approve_budget` approves a draft and supersedes the previous live version in one step. All RLS-on, service role only.
  Tested on 2026-11-10 against the real database inside a transaction that was rolled back, then **applied the same day** (recorded as
  `finance_budget`) and checked: heads set on 21 categories and none left without one among the spending categories, one category flagged as salary,
  an empty or malformed budget refused, an approved budget frozen, a second version superseding the first, anonymous reads refused, RLS on with no
  anon/authenticated grants. The dashboard tolerates a database without `0098` (a year with no budget, every category's spending under "other").
- **Tests:** `finance-metrics` (the formulas), `finance-dashboard-view` (formatting, charts, tiles), `finance-dashboard-endpoint` (the real function
  through `requireStaff` with Supabase stubbed: access, drafts not counted, a year with no budget, a database without `0098`, auditor logging, no names in
  the response). The page's client script was also run in a DOM against a mocked response for an open and a closed year, all five views.
- **Not built yet:** the import of the existing plan (a dry-run script, run by the operator from the private sheet); the Maintenance and Advances
  views (sessions 10 and 09: the mockup shows their shape); the member-portal preview of some of these figures (to be a preview feature for chosen
  homes, not open to everyone); CSV export of a table. **Not verified:** the page in a browser with a real sign-in, on a phone, and against the real ledger.

## Channels (the dashboard's Channels tab, `/internal/finance/dashboard/#channels`, no migration)

The cashflow, and the channels it moves through, from the real ledger. One picture, read left to right: **money in → the accounts → money out**.
Each side is grouped by **Channel** (what the ledger already calls an origin: Bank direct, Paypro, the payment gateway, the debit card, and **UPI**)
or by **Purpose** (what the money was for: salary, farm and household, projects, company; on the way in: maintenance, everything else), and the
two sides are chosen separately. A band is as wide as the money in it, and a box as tall. A dot on a box means lines there have no category yet.

Decided 2026-11-15, after a first version drew channels, purposes, projects and delegates as circles in a force graph and was rejected. The design
follows the products that do this well (Monarch's Cash Flow, Mercury's money-movement breakdown): a shallow flow, a time strip, one grouping
switch, and a drill-down to the lines, rather than every dimension as another column. Purposes are a grouping, not boxes of their own; projects are
not a channel, so they appear only as the single "Projects" purpose.

- **Drilling in slides the picture along.** Click a box on the money-out side and the picture **slides left**, so its breakdown opens to the right;
  a box on the money-in side slides it **right**, opening to the left. Click a row and it slides one level further, to that row's lines (a card of
  the largest eight, each date opening that line in the Ledger). The crumbs, *Back*, Esc, the faded account, or the same box again go back;
  *See every line* shows the box's lines rather than one row's. (The details were first placed under the diagram and were missed, then pinned to
  the screen; sliding the picture itself replaced both.) A band opens the box at its outer end.
- **Every box opens by its natural breakdown, not by date** (`breakdownOf`): Projects by project, Salary by employee (who it was paid to),
  Maintenance by who paid it, every other purpose by category, a channel by what its money was for, **UPI by the person behind each payment**. Each row shows its lines and
  amount and adds up to the box. Project and purpose breakdowns come from the cube in the browser; person, category and UPI person need the lines, so
  `GET /channels/breakdown?by=party|category|delegate|operator` groups them on the server (a person merged into another counts as the one they were merged into).
  That is the one place a name leaves the server, to people who may view finance and, for an auditor, with the visit logged.
- **UPI is one channel, opened as a tree.** BHIM, Paytm and UPI-with-the-app-unknown are apps of one UPI channel (`UPI_APPS`, from the channel
  kind in `finance-origin.mjs`), so the picture has one UPI box (*UPI (All)*). All UPI payments go out through an operator's UPI setup, so it opens
  **by operator** (*Whose UPI*), then, inside an operator, **by person**: *Direct* and each delegate of that operator's UPI circle (*UPI circle ·
  <name or number>*, and *UPI circle · no delegate yet* for a circle payment no delegate is chosen for), **whichever app each used** (the app is on
  the lines), then the lines. Each row's money rolls up into the one above, so the rows always add up to their parent. Without operators recorded it opens by person at once. The drill is as deep as the tree (`drillDims`, `layoutDrill`): one more column and
  one more slide per level.
- **Fixed deposits are an account.** They are not money out: putting money into one is a **transfer** from one account to another, and money
  brought back is a transfer the other way. So they are a box in the accounts column, after the bank accounts, as tall as what they hold (the
  balance at the end of the period, from `fdBalance`, or what moved if that is more), with *Held ₹… at <month> end* under it. A transfer is a
  green loop between the two boxes (out to the right going in, to the left coming back); a bank account's box counts it in what came into or
  left it, so *Kept* still adds up. The figures above the picture keep it apart: **Received**, **Spent**, **Net moved into fixed deposits**,
  **Left in the accounts** (received less spent less what moved), and the month strip leaves it out. Click the deposits or a transfer for the
  lines moved. All deposits are one box for now.
- **Another bank account** is another box in the accounts column, in the order the accounts were added, each with its own bands in and out and its
  own *Kept*; the channels and purposes are shared, so a band shows which account it passes through. **Not built:** a payment from one of your
  accounts to another is, in the ledger today, money out of one and money in to the other. Telling them apart needs the ledger to mark such lines
  as transfers (a transfer category on both legs, or an automatic match of equal and opposite amounts a day or two apart, confirmed by an admin);
  the transfer band and the totals already work for any pair of accounts once the lines are marked.
- **Period.** Presets (This month, Last month, Last 3 months, Year to date; a closed year says Whole year), exact **From/To** months, and a **month
  strip** of received and spent for each month: click a month, drag across several, shift-click to extend; clicking the only chosen month goes back
  to the year. Ranges are whole months. **Compare with the period before** adds the change under each figure against the same number of months
  straight before; when the year does not reach back that far it says so once. Year-on-year comparison needs the previous year's data and is not
  built.
- **Delegates** are their own card under the picture (each person's month against their limit, "No delegate yet" for unattributed payments), not
  part of the flow: they are recorded from the UPI records and are not bank-statement lines, so putting them in would make the totals differ
  between groupings.
- **Data.** `GET /api/finance-admin/channels?fy=2026` (`lib/finance-channels.ts`; needs `finance` / `view`, an auditor's visit is logged and
  refused if it cannot be, like the dashboard) returns the year summed once into a small aggregate (`channelCube` in
  `scripts/lib/finance-channels.mjs`): one cell per month, account, channel, direction and purpose, with the amount and the number of lines. The
  channel is `originOf()` (the ledger's rule, from the narration and the joined UPI row's app) and the purpose is `groupOf()` (the dashboard's
  rule: sinking fund, then a project, then salary, then the category's head), so the totals agree with the Cashflow tab. What nobody has
  categorised is `other`, flagged, so each direction always adds up to the bank lines. The browser draws any period and grouping of it without
  asking again (`flowOf`). It carries no narrations, UPI references or party names.
- **The lines behind a box, band or row.** `GET /api/finance-admin/channels/lines?fy=&months=&dir=&channel=&purpose=&account=&fd=&project=&party=&category=&delegate=&operator=`
  sums the same pieces (`channelPieces`), so the count and amount agree with the figure on the box (`none` means nothing named; `channel=upi`
  means any UPI app; `delegate=own` is Direct). It returns the number of lines, the amount and the largest eight (date, account, channel, purpose, project, person,
  category, amount and the line's id, which the date links to in the Ledger). No narrations. `specOf` turns a click into the filter and
  `cellMatches` applies it, and a test checks that for every box and band, in every grouping, the lines add up to its figure.
- **Drawing.** `scripts/lib/finance-channels-view.mjs`: the layout is pure and tested (`layoutFlow`: one scale for the whole picture, the outer
  columns ordered by where their money goes so bands cross as little as possible, transfers last on a box; `layoutDrill`: the breakdown column and
  the lines card on the same scale, and how far to slide); the SVG, the camera (a CSS transition on one group, off under reduced motion), the month
  strip and the clicks are small DOM code on top. No library. Colours are the `--tvc-chart-*` tokens, so both appearances work. On a phone the
  picture scrolls sideways inside its card. A table of the same figures sits under it.
- **Not built yet.** Marking transfers between bank accounts (above), exact days rather than whole months (the aggregate is per month; per day is a
  modest change), year-on-year comparison, one box for each deposit or by bank or maturity, deposit interest as a third green band, delegates
  under their UPI app inside the flow, planned boxes for things that do not exist yet (a second bank, a POS terminal, Google Pay: they appear when
  the data does), a Ledger link that opens with the same filters applied (today each line opens on its own). A POS terminal would count under Debit
  card until it has a channel of its own.
- **Tests.** `finance-channels.test.mjs` (the aggregate, the months and presets, totals that reconcile to the bank, the flow in every grouping,
  the deposits as an account with transfers, UPI and its apps, that each side adds up, that every click ties to the figure on it, the breakdowns),
  `finance-channels-view.test.mjs` (one scale, no overlapping boxes, bands inside their boxes, transfers as loops, the drill-down columns and how
  far the picture slides) and `finance-channels-endpoint.test.mjs` (the real function with Supabase stubbed: grants, validation, the money tying
  to the bank lines, drafts not counted, the lines and breakdowns behind a box, merged people, delegate attribution, a database without the
  delegate tables, no narration leaving the server, the audit).

## The budget editor (session 07, page `/internal/finance/budget/`, migration `0099_finance_budget_editing.sql`, **applied 2026-11-10**)

Finance › Budget. Routes in `lib/finance-budget.ts` on `finance-admin.mts`: `GET /budget?fy=&v=` (everyone with `view`), `POST /budget/versions`
(start a draft), `POST /budget/versions/:id/lines` (save), `/approve`, `/discard` (all need `configure`, which is admin-only). A category's head and
salary flag are set with `PATCH /categories/:id {head, isSalary}`, the route categories are already edited through.

- **Versions.** A year has versions: a *draft* is edited, saved and approved; approving it makes it the *live* budget and supersedes the previous live
  version, which stays on record, so the year-end can be compared with the original plan. An approved version is never edited (the database refuses);
  a change is a new version, started by copying the live budget, last year's, or nothing. One draft per year at a time. Planning is allowed from last year
  to next year.
- **The grid.** Every category, and each project of the year (never an event), is a row under its head with an amount box: typing an amount makes a
  line, leaving it blank means no line, so nothing can be duplicated or forgotten. A row shows last year's live amount and what the ledger says has been
  spent this year (period view), so the plan is written beside the facts. A name and a comment can be added per row (the comment is shown beside the line
  on the dashboard). Transfers and reimbursements are not budgeted; a retired category appears only if it already has a line. A spending category with no
  head offers a picker ("Count it under") that sets its head. Totals (money out, money in, surplus or shortfall) follow the typing.
- **Amounts.** Typed in rupees (`12,34,567`, `1,234,567`, `₹ 1,500`, `2500.50` all read; `12 lakh` or `-5` are marked on the row, never guessed) and stored
  as whole paise. Rules: `scripts/lib/finance-budget.mjs`, shared by the page and the function.
- **Safety.** Every write is audited first (`finance.budget_draft_started`, `_saved`, `_approved`, `_discarded`; ids, year, version and line counts only,
  never a label or an amount); if the audit cannot be written nothing changes. A bad save changes nothing and marks the lines to fix. The save and the copy
  are database functions (`fin_save_budget_lines`, `fin_start_budget_draft`) so they happen whole or not at all. The page asks before leaving with unsaved
  changes and before approving or discarding.
- **Migration `0099`** (one partial unique index for one draft per year, and the two functions, service role only): tested on 2026-11-10 against the real
  database inside a rolled-back transaction: the first version is 1, a save replaces the lines and trims text, a bad save leaves the old lines, a second
  draft and a save to an approved version are refused, copying within a year keeps project lines and copying to another year keeps only category lines, a
  missing source is refused, anonymous callers are refused. Applied the same day (recorded as `finance_budget_editing`) and checked: both functions and the index present, only the service role can run the functions, no budget rows touched. A database without it answers a start or a save with 503 and a plain message ("needs a database update (migration 0099)"), not "Server error".
- **Tests:** `finance-budget` (the rules, the grid, the input reading, 20), `finance-budget-endpoint` (the real function: who may read and change, a bad
  save changes nothing, audit first and without labels or amounts, approve and supersede, discard, a database without the tables, the category head), and
  `finance-routes` (every handled route is declared in `config.path`). The page's client script was run in a DOM against a stateful mock API through the
  whole flow: read-only, start, type, a bad amount, save, a server error on a row, approve, discard, leaving with changes, an empty year, a reader, a head picker.
- **Not built yet:** monthly phasing (the table and API keep it; the editor has no screen for it), the import of the existing plan, a diff between two
  versions, and the editor in a browser with a real sign-in or on a phone.
