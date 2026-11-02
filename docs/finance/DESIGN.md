# Finance module: design

Status: **design draft, 2026-11-02. Nothing is built.** Decisions come from the planning
conversation with Sharath on 2026-11-02, from the "TVC Spend Summary" workbook and the two
payment/salary workbooks it sits beside, from sample Axis Bank, Paytm and auditor material, and
from TVC's own Finance Operations process document (a private Google Doc). Open items are at the
end. How to work through the build, one Claude session at a time, is in [README.md](README.md).

**This is a public repository.** No person's name, bank account number, UPI ID, salary, vendor
or amount belongs in these files, in tests or in fixtures. Describe people by role ("the farm
manager", "a director"), and build test data from invented values. Real files go only to the
private R2 bucket or the database.

## Goal

Replace the Google Sheets that run TVC's finances with a separate **finance module** in the TVC
ERP backend, so that:

1. Bank statements and UPI statements are uploaded once and become a reconciled ledger, instead
   of being copied between tabs and labelled by hand.
2. Payments are requested, approved, paid and reconciled in one place, with the bill attached when
   the money is spent.
3. Salary is computed from attendance, approved by two people, uploaded to the bank as a bulk
   file, and the single bank debit splits itself into one entry per person.
4. Directors can see cashflow, budget against actuals for the financial year, maintenance
   collections and the sinking fund without building a pivot table.
5. Auditors can answer their own questions from a read-only workspace and take an export for the CA.

Non-goals (for now): being the statutory books (the CA keeps those in Tally or Zoho; this module
feeds them); GST filing; a live bank feed (Odoo was tried and abandoned when its bank connection
broke, so statement files are the primary path); paying money directly from the app.

## Decisions

| Area | Decision | Why |
|---|---|---|
| Statutory books | The CA keeps them; the module exports to them. | Avoids rebuilding accounting, GST and TDS. |
| Bank link | Upload statement files; no dependency on a live feed. | Odoo's feed broke and the tool was dropped. |
| Ledger shape | One immutable **bank line** has one or more **allocations**. | A bulk salary debit must split into per-person entries without editing the bank record. |
| Accounting basis | Cash ledger plus an **accounting period** on each allocation. | Auditors ask for cut-off (March salary paid in April). |
| Nature of expense | Every allocation carries a plain-language **nature**. | Auditors ask for it on listed payments. |
| Category type | The type (opex, capex, ...) belongs to the **category**, not the row. | Today "Farm Expenses" appears as Opex, Capex and blank. |
| Bills | Captured when the money is spent, with an in-app scanner. | Auditors ask for invoices the farm manager holds. |
| UPI circle | The Paytm export is a third import; its UPI reference number joins it to the bank line. | Matched 58 of 59 rows in a real sample; the one miss was a ₹1 mandate row. |
| Circle cap | ₹15,000 per **calendar month**, counted from the "Pocket Money" tag. | Confirmed by Sharath; the tag is the only circle signal in the export. |
| Other banks in a UPI export | Keep only the registered account label; show the ignored count and total. | Confirmed by Sharath; a personal credit-card payment must not enter the ledger. |
| Payments to the farm manager's own name | Allowed from the circle, but always **flagged for review**. | Flexibility with oversight. |
| Reimbursements | A director paying the farm manager is a reimbursement for cash he spent; category comes from his remark; a bill is expected. | Example: a temple donation paid in cash. |
| Salary | Agreed monthly pay ÷ the month's working days × days worked, minus advances. Maker, confirmer, checker. | Matches today's process and the past wrong-account loss. |
| Payee details | New or changed bank details stay **unverified** until an approver confirms; never overwritten. | A bank merger once sent a salary to a dead account. |
| New vendors | The farm manager adds them himself (NEFT mostly, UPI sometimes), from phone or computer. | Saves a round trip through WhatsApp. |
| History | Load FY 2024-25 onward. Older years stay in the sheets. | Matches the current tracker and payroll workbooks. |
| Access | `finance` is its own module, granted per person, not to every core member. | Confirmed by Sharath. |
| Entities | Every table carries `entity_id`. | A Society may be formed later. |
| GST | Not registered; build GST-ready (no hard-coded "no tax"). | On the roadmap. |
| BHIM sync | The Apps Script that reads BHIM PDFs is switched off once the Paytm import is live. | The circle moved to Paytm on 31 Aug 2026. |

## What it replaces

| Today | Becomes |
|---|---|
| "Axis Bank Transactions" tab | Imported **bank lines** (immutable). |
| "Funds Transfer Tracker" tabs, "Accounts Master", Lookups | **Allocations**, **parties**, **categorisation rules**. |
| "Funds Transfer Requests" sheet and the WhatsApp ping | **Payment requests** with bills attached. |
| BHIM UPI log and its Apps Script | **UPI lines** from the Paytm export. |
| Payroll workbooks (one per FY) and the roster | **Payroll runs** and an attendance roster; the bank's bulk-payment file is generated. |
| "Budget Plan" tabs | **Budget** per financial year, with revisions. |
| "Maintenance" tabs | Maintenance **dues** and collections (see Integrations). |
| "Sinking Fund Status" | **Fixed deposit** register. |
| Pivot tabs, summaries | **Dashboards**. |
| Bills in Drive and with the farm manager | **Vouchers** in the private R2 bucket. |

Left alone: the patta tabs (land records, already in the members module), event costing (comes
from event payments), and FY 2020-21 to 2023-24 (archive).

## Principles

1. **Bank lines are facts.** Imported once, never edited. Corrections are new allocations.
2. **Allocations explain a line.** The allocations of a line sum to its amount; a line is
   unallocated, partly allocated or allocated. Salary, split payments and refunds all use this one idea.
3. **Date and period are different.** `tran_date` is when the bank moved the money; `period` is the
   month the cost belongs to. Reports say which they use.
4. **Money is `bigint` paise.** Never floats.
5. **Nothing is silently dropped.** Ignored UPI rows, duplicate lines and failed rows are counted
   and listed on the import summary.
6. **Server only.** Like `staff_users`, tables have RLS on with no policies and `anon` and
   `authenticated` revoked; Netlify Functions read them with the service role.
7. **Sensitive fields are write-only to most roles.** Bank account numbers and UPI IDs of payees
   are masked everywhere except where an approver verifies or exports a payment file.
8. **Everything that changes money or access is audited**, in an append-only log.

## Access

Finance is two modules in the existing registry (`netlify/functions/lib/staff-registry.ts`), so it
reuses `staff_module_roles`, the Access screen, MFA and audit logging.

| Module | Role | Who | Capabilities |
|---|---|---|---|
| `finance` | `admin` | Directors (approvers) | everything below |
| `finance` | `user` | Finance operators the directors choose | `view`, `import`, `allocate`, `request` |
| `finance` | `read_only` | Viewers; **auditors** (with an expiry) | `view` only |
| `finance-requests` | `user` | The farm manager (requester) | raise requests, add vendors, scan bills, enter payroll inputs; **no** ledger access |

Capabilities in `finance`: `view`, `import`, `allocate` (split, categorise, resolve review),
`request`, `approve` (payments, `admin`), `approve-payroll` (a second `admin`, never the preparer),
`verify-payee` (`admin`), `close-period` (`admin`), `configure` (`admin`: categories, budget, rules,
roles of the circle tag), `export`.

Rules the code must enforce, not the UI:

- **Maker is not checker.** Whoever prepares a payroll batch cannot approve it; whoever raises a
  request cannot approve it.
- **Approving and verifying a payee** needs the MFA step-up already built for super admins.
- **Masking.** `staff-masking.ts` hides personal names from `read_only` because that role was
  imagined as an auditor of conversations. Finance auditors *need* payee names but not payee bank
  details, so finance defines its own field classes: names visible to `view`, payee account numbers
  and UPI IDs visible only to `verify-payee`/`export` holders and only in the verification and
  file-generation screens.
- **Auditors** are people with a `read_only` grant and an `expires_at`. That column does not exist on
  `staff_module_roles` today; adding it is part of the access session. Every auditor view and
  export is written to the audit log.
- **Members** do not use the staff model. A member sees their own maintenance dues through the member
  portal's own session (see Integrations).

## Data model

All tables are in the TVC ERP Supabase project, prefix `fin_`, each with `entity_id`, `created_at`
and, where a person acts, a `staff_users.id` (never an email). Names below are the intent; the
migration sessions finalise columns.

### Reference

- `fin_entities`: the legal entity (today one).
- `fin_bank_accounts`: label (for example "Axis current"), `upi_label` (the text the Paytm export
  uses for that account), last four digits only, `kind` (`bank`, `fd_parent`, `cash`).
  A `cash` account has lines entered by hand and never imported, so cash needs no special case.
- `fin_categories`: name, `type` (`opex`, `capex`, `project`, `revenue`, `member_contribution`,
  `sinking_fund`, `interest`, `tax`, `reimbursement`, `transfer`), `budget_head` flag, `active`.
- `fin_parties`: `kind` (`member`, `vendor`, `employee`, `customer`, `bank`, `government`,
  `director`, `other`), display name, optional link to a member household, `active`.
- `fin_party_accounts`: bank (account, IFSC) or UPI (VPA) details, `status` (`unverified`,
  `verified`, `superseded`), `created_by`, `verified_by`, `verified_at`. **History is kept; a change
  creates a new unverified row.** Account numbers are encrypted at rest (as the MFA secrets are).
- `fin_periods`: entity, financial year, month, `status` (`open`, `closed`), who closed it.
- `fin_audit_log`: append-only, like `staff_audit_log`; actions, ids and counts, never raw PII.

### Imports

- `fin_import_batches`: source (`axis_statement`, `paytm_upi`), file hash (unique, so the same file is
  never imported twice), the raw file's R2 key, period covered, counts (inserted, duplicate,
  ignored, failed), and for bank statements whether the **balance chain** held.
- `fin_bank_lines`: account, `tran_date`, `value_date`, narration, `direction`, `amount_paise`,
  `balance_paise`, `upi_rrn` (the 12-digit reference pulled from the narration when present),
  `dedupe_key` (unique: account, date, narration, amount, direction and the running balance, which
  tells apart identical same-day lines such as bank charges).
- `fin_upi_lines`: paid_at, counterparty name and VPA, account label, amount, direction,
  `upi_ref` (unique), `order_id`, `remarks`, `tag`, `ignored` and `ignored_reason`, and
  `bank_line_id` once matched. Unmatched rows stay "awaiting bank statement" and link on a later
  import. `is_circle` comes from the configurable tag rule, default tag "Pocket Money".

### Ledger

- `fin_allocations`: `bank_line_id`, `party_id`, `category_id`, `amount_paise`, `period` (first day of
  the month), `nature` (plain language), `remarks`, `source` (`rule`, `manual`, `upi_remark`,
  `request`, `payroll`, `import`), optional links to a payment request, payroll line, household and
  maintenance year, `review_state` (`ok`, `needs_review`, `flagged`) with `review_reason`,
  `reverses_allocation_id` (refunds, corrections), `posted_at`.
  A trigger refuses to post a line whose allocations do not sum to its amount.
- `fin_vouchers`: R2 key, page count, mime, optional `extracted` JSON (vendor, date, amount read from
  the scan), attached to an allocation or a payment request.
- `fin_rules`: priority, matcher (narration pattern, payee VPA, remark keywords, direction, amount
  range), result (party, category, nature template, `needs_review`), `hit_count`, `active`. Seeded
  from the 2024-27 tracker.

### Workflows

- `fin_payment_requests`: requester, party and party account, amount, `mode` (`neft`, `upi`, `imps`,
  `rtgs`), purpose, suggested category, `needed_by`, status (`draft`, `submitted`, `approved`,
  `paid`, `rejected`, `cancelled`), approver, `bank_line_id` once matched.
- `fin_payment_batches`: `kind` (`vendor`, `salary`), the generated bank file (hash, R2 key), status
  (`draft`, `file_generated`, `uploaded`, `approved_at_bank`, `settled`), preparer, checker.
- `fin_employees`: party, roll number, active; `fin_salary_terms`: employee, agreed monthly pay,
  `effective_from` (revisions keep history); `fin_attendance`: employee, date, value (1, 0.5, 0);
  `fin_holidays`: date, name; `fin_advances`: employee, amount, monthly deduction, balance.
- `fin_payroll_runs`: month, working days, status, preparer, confirmer, checker, batch;
  `fin_payroll_lines`: run, employee, a **snapshot** of the payee account used, days worked, rate,
  gross, advance deduction, other adjustments, net, and the bank reference
  (`YYYY-Mon-Employee-NNN`) that ties the line to the bank file.
- `fin_budget_years`, `fin_budget_lines`: per financial year, category, annual amount and optional
  monthly phasing; each approved revision is a new version.
- `fin_obligations`: recurring bills (BSNL lines, power, domains, Workspace): payee, cadence, expected
  amount, next due, last paid allocation.
- `fin_accruals`: running payables, for example the hospitality partner's share (25% of receipts,
  accrued monthly), settled by an allocation.
- `fin_fixed_deposits`: last digits of the FD, principal, opened, rate, maturity date, maturity
  instruction, maturity amount, status, and the lines that created and closed it.

Maintenance dues are *not* duplicated here (see Integrations).

## Flows

### Statement import
Upload the Axis file and the Paytm file together. The importer stores the raw file, parses it,
extracts the UPI reference from narrations, drops duplicates by `dedupe_key`, checks that each line's
balance equals the previous balance plus or minus its amount, and links UPI rows to bank lines by
reference. The summary shows inserted, duplicate, ignored (with total), failed and awaiting-bank
counts, and the first and last date, so a stale sheet is obvious. It never deletes anything.

### Allocation and review
Rules propose party, category and nature; the farm manager's own UPI remarks ("Onion", "Gas stove
repair") seed the nature. Anything no rule explains, any circle payment to a party flagged as the requester, any
payment to a new or changed payee account, and any reimbursement without a bill lands in a **review
queue**. Salary and bulk lines are allocated by the payroll run, not by hand. Posting a line locks its
allocations; changing a posted allocation in a closed period needs `close-period` and a reason.

### Payment requests
The requester picks a saved payee or adds a new one (unverified), enters amount, mode and purpose,
and scans the bill. The approver is notified, verifies a new payee if needed, and approves. The
approver pays through net banking or UPI as today (or from a generated vendor bulk file) and the
request is matched to the bank line by amount, date and payee when the statement arrives.
Unmatched approved requests age on the data-health tile.

### Payroll
Monthly: the requester enters attendance and any adjustments; the system computes net pay with the
formula above (holidays are paid but shorten the working days; Sunday is the weekly off; a half day
is 0.5; a worker present every working day earns one paid day the next month; advances are deducted
at the agreed rate). The requester confirms the amounts; the approver prepares the bulk-payment file
in the bank's upload layout; a second director approves it as checker in the portal and marks it
approved here. A payee whose bank details changed since the last run is flagged and blocks file
generation until verified. When the statement shows one batch debit, the line's reference values
match the payroll lines and the allocations are created automatically, one per person, with the
period set to the salary month.

### Maintenance
See Integrations. Payments are allocated to a household and a year, not to a category named
"Maintenance (25-26)". Outstanding balances are visible to approvers and appear on a statement
that can be issued when a member sells.

### Hospitality partner share
Guest payments land in the bank account and are allocated to revenue. A monthly accrual books the
agreed share (25%) as a payable; the year-end invoice and its payment settle it. The base of the
25% (gross receipts or after fees) is an open question.

### Refunds
A refund is an allocation that reverses an earlier one, with a reason. Until a refund process is
agreed it is recorded by an approver; later it can start from an event or stay cancellation.

### Period close
An approver closes a month once the statement is reconciled. A closed period rejects new allocations
without `close-period`, and every override is logged with its reason.

## Dashboards

Defined once so the numbers match across screens. "Cash view" groups by `tran_date`; "period view"
by `period`.

- **Cashflow** (cash view): monthly inflow and outflow by category group, closing balance, and
  **runway** = latest balance ÷ the average monthly net outflow of the last six months, excluding
  transfers to the sinking fund; shown with and without fixed deposits.
- **Budget vs actual** (period view): per category for the chosen financial year: budget, actual,
  committed (approved requests not yet paid), remaining, and a run-rate projection labelled as an estimate.
- **Maintenance**: due, collected, outstanding, percent of households paid, ageing by months overdue,
  and by cluster.
- **UPI circle**: month-to-date circle spend against ₹15,000 and the flagged payments.
- **Sinking fund**: deposits, maturity calendar, interest earned.
- **Revenue**: hospitality and event receipts, and the partner payable.
- **Obligations**: recurring bills, due and paid.
- **Data health**: unallocated lines, rows awaiting a bank line, unverified payees in use, flagged
  items, payments without a bill, last import dates, and whether the last statement's balance chain held.

## Auditor workspace

A page for the read-only role, built from the questions auditors actually send:

1. **Salary working** for a financial year, one row per person and month, with the paid date, the
   salary month, and a March-paid-in-April view.
2. **Bill coverage**: payments with and without a bill, and the bills themselves.
3. **Nature of expenses**: paste or upload a list of payments; the page returns each with its nature,
   party and bill, and highlights those still missing a nature.
4. **Year pack**: ledger by account, bank reconciliation, voucher index, and a CSV in the layout the CA
   asks for (to be agreed).

Access has an expiry and is logged.

## Integrations and boundaries

- **Member portal dues.** The member-portal plan defines `maintenance_years` and `maintenance_dues`
  (household × year), which are not built yet. The finance module should own and build them, linking
  payments through allocations, and expose a member's own dues to the portal. **Conflict to resolve:**
  the portal plan says payment status is named and visible to all members; this module's decision
  is that members see their own dues only. The two decisions need reconciling before maintenance is built.
- **Partner settlement ledger.** The partner API's planned phase 3 has a settlement ledger for the
  hospitality partner. The finance module's accrual and that ledger must be one source of truth, not two.
- **Event payments.** Razorpay-backed event receipts already live in `event_payments`. The finance
  module reads them for revenue and reconciles the settlement credits to bank lines rather than
  re-entering them. The process document describes Razorpay as idle, which is out of date.
- **R2.** Statements and vouchers use the private bucket and key-prefix pattern of `contract-storage.ts`.
- **Notifications.** New requests, approvals and flagged items use the existing email and WhatsApp
  channels; templates need Meta approval where outside the service window.
- **UPI sync script.** `UPI-SYNC.md` and the Apps Script are retired in the cutover session.

## Security and privacy

Service-role access only; RLS deny-all; payee account details encrypted; raw statements and bills in
private R2; no account numbers, UPI IDs or amounts in logs or in the audit log's `detail`; MFA step-up
for approvals; append-only audit log; maker is not checker; auditor grants expire.

## Cutover

1. Build and test on the 2024-27 data loaded into a **non-production** copy.
2. Load FY 2024-25 to today, rebuild the budget-vs-actual totals and compare them with the sheet's
   own totals; investigate every difference.
3. Run both for one full month-end (statement, payroll, requests), then one quarter if the month-end
   is clean.
4. Retire the tabs and the BHIM sync; update `ARCHITECTURE.md`, `UPI-SYNC.md` and the Access screen.

## Risks

- **Statement format drift.** Banks change export layouts. Mitigation: raw file kept, one parser per
  format version, the balance check, and a loud failure rather than a guess.
- **Paytm tag misuse.** The circle gauge trusts a user-editable tag. Mitigation: monthly review of
  untagged and unusual rows; the gauge says it is tag-based.
- **Paytm history.** The export only covers the period since the company account joined (31 Aug 2026);
  earlier UPI debits (April to August 2026) have only the bank narration.
- **Payee fraud or error.** Mitigated by unverified-until-confirmed, history, MFA for approval, and
  the payroll snapshot.
- **Scope.** This is large; the session plan keeps each piece shippable on its own.

## Open questions and items to confirm

1. **A real Axis download.** The statement format (CSV, XLSX or PDF) and its exact columns have not been
   seen in their original form, only as pasted into the sheet. The import session needs a real,
   anonymised sample.
2. **The bank's bulk-payment upload layout.** The payroll workbooks mirror it; the exact column order
   and date rules (a mismatched date rejects the batch) must be confirmed from the template.
3. **The CA's import format.** What Tally or Zoho wants.
4. **Member visibility of dues** (see Integrations).
5. **Base of the partner share** and whether it accrues monthly.
6. **Refund process** for stays and events.
7. **Who may be the second approver** other than the director who checks salary today.
8. **How auditors sign in** (a Google account, as everyone else does, or another method).
9. **Notification wording and channel** for requests and approvals.
