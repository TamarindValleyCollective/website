# 09 Payroll

**Depends on:** 04, 05 (06 for history). **Parallel with:** 08, 10, 12.

## Goal
Compute salaries from attendance, get them confirmed and approved by two people, generate the bank's
bulk-payment file, and split the single bank debit automatically.

## Decisions (2026-11-05, with the owner)
- **Built in this finance module**, not in the separate ERP: it reuses parties, verified payee accounts and the ledger. The
  ERP's employee policy and financial-operations documents remain the requirements source.
- **Split in two.** **09a** records and pays the run: the farm manager enters each person's *net* amount for the month in the
  app, a director reviews, the farm manager confirms, the file is generated, and the bank debit is matched. **09b** adds
  attendance and the pay arithmetic. 09b waits for the policy gaps the employee policy lists (rounding, work on a weekly
  off, what counts as full attendance, advances); until then the farm manager keeps working the pay out in his own sheet
  and 09a records the result, with optional fields for agreed pay, days worked and advance deducted so nothing needs
  re-entering later.
- **People (roles, no names here):** the farm manager enters and confirms; the preparer (a director) reviews and generates the
  file; a second director approves in the bank's portal and is also an approver in the app (`approve-payroll`, never the
  preparer). Salary pages are for these three only.
- **Today's process this replaces:** the farm manager fills a shared sheet (one tab per month, one row per person), the preparer
  copies it into a local Excel file for the bank's bulk portal, sends a screenshot of the uploaded batch to the farm manager for
  confirmation, then asks the second director to approve in the bank's maker-checker.
- **Why the confirmation step exists:** a bank merger changed a payee's account while the old number stayed in the file; the money
  left and was never credited. So the file may use only *verified* payee accounts, the confirmation lists exactly what will be
  in the file (accounts as last four digits), and "account changed since the last run" is shown loudly.
- **Facts to design for:** the bank settles the batch as ONE debit (the ledger already holds it as one allocation per person on
  that line, entered by hand from the tracker); the statement narration does not say "salary", so match on the total and the
  date window, never the text; a payment date that differs from the processing date makes the portal reject the whole batch, so
  validate it; two people can share one bank account (two parties on one payee account); a returned payment is a refund of that
  one person's allocation.
- **Build order for 09a:** (1) import the existing monthly tabs as history runs, which also gives the salary allocations their
  party; (2) the run screens and the file export; (3) settlement matching and returns.
- **The upload file's layout (read from a real file, 2026-11-05; the file itself stays outside the repo).** No header row; data
  starts in row 1, one row per person, columns A to L (M to O blank). A: payment mode, `N`. B: amount in **whole rupees** (a number).
  C: payment date as **text** `dd-mm-yyyy` (the 1st of the following month). D: beneficiary name. E: beneficiary account number,
  stored as a **number**. F: beneficiary e-mail. G: narration `<Mon YYYY> Salary`. H: the company's debit account number, the same
  on every row (**not stored by the ledger, which keeps only last four digits: it needs a server-side setting**). I: reference
  `<YYYY>-<Mon>-Employee-<nnn>` (a sequence per row). J: beneficiary IFSC. K: a constant, `10`. L: `Salary for <Mon YYYY>`. Columns P
  to S of the working sheet (a reference account and IFSC, and `-1` flags where they differ from E and J) are the preparer's own
  account-change check; they are not part of the upload and were empty in the file read, so the check flagged every row.
  Observed slips the generator removes: the tab name, the file name and the narration disagreed about the month (a file named for
  one month held the next month's run), because the month is typed in three places today.
- **Design consequences:** the net amount is entered in whole rupees (this settles the rounding of the payout, not of the
  per-day rate); the generator writes C as text and E as a number (an account starting with 0 would lose it, so such an account
  is written as text and flagged); G, I and L come from the month, never typed.
- **Confirmed by the owner (2026-11-05):** the portal accepts the file as laid out, and the generator writes columns A to L only (the
  helper columns are not part of it). `K` is always `10`: keep it as a setting, with no meaning needed. `A` is the payment mode:
  `N` (NEFT) by default and always so far; the other value the portal offers is `I`. So the run carries a payment mode that
  defaults to `N`, and the generator accepts `N` or `I` only. Not confirmed: whether the transfer method chosen at upload
  overrides column A; the export must not assume either way (the preparer still checks it in the portal as today).

## Plan for the next slices of 09a (2026-11-17, with the owner; nothing here is built yet)
Agreed after the first run screens were reviewed. Order of work, each its own commit and test-first:

1. **Automatic employee numbers.** Today the number is typed by hand and only sorts the list, and the reference in column I uses the
   row's position in that month's file, so one person's number can change month to month. Instead: the number is assigned on
   adding a person to payroll (next number, never reused, shown read-only), and column I uses it. *Open question for the owner:* in the
   files uploaded to the bank today, is the last part of the reference a permanent employee number or the row count? If permanent,
   seed the existing people with their current numbers when the history is imported.
2. **People-change requests** (a table and three request kinds, in the style of the payment requests the farm manager already
   uses). The farm manager decides who joins and leaves, so each change starts with him; a director signs it off, because a joiner
   or a changed account is money going out. Adding the person as a Party stays a separate step done by someone else, and adding
   them to payroll stays a separate step done by a director.
   - **Joining:** the farm manager raises it (name, role, start month, agreed monthly pay, the account and IFSC the employee gave
     him). An admin creates the Party (kind employee) and the details attach to it. A director approves and the person goes
     on payroll from the start month. The agreed pay is what the 09b calculation will read.
   - **Leaving:** the farm manager picks a person on payroll, the last month to pay and an optional reason. A director approves;
     the person drops out of the new-month form after that month (a final month with a hand-entered amount is still possible).
     History and past runs are untouched. The payroll page then prompts that the Party can be deactivated.
   - **Change of bank details:** the farm manager enters the new account and the month it starts from. The old account stays in
     use until the new one is verified, so salary never goes to an unchecked account. A different person verifies it, never the
     requester; a director for a change, an admin may verify a new joiner. The existing "account changed since the last run" warning
     still shows for the first month. Every change is written to the audit log and alerts the directors.
   - Today deactivating a Party does nothing to payroll, and nothing turns an employee off. Until this is built, treat both as gaps. As
     a safety net, even without a request: payroll shows "inactive in Parties but still on payroll" with the names, and a line for a
     deactivated Party blocks the file until it is removed or the Party is reactivated.
3. **Bank details entered by the farm manager.** The employee gives the details to him, so he may enter them at joining and request a
   change. He sees only the last four digits afterwards, never the full number. To catch typos the account number is asked twice and
   the IFSC shows its bank and branch at once. A new or changed account needs a photo of the passbook or a cancelled cheque (the
   proof the details are the employee's own), stored privately with the payee evidence. Entering the details does not make
   them the account that is paid: only a check by someone else does.
4. **Name from the bank, when a method exists.** If bank-account validation is automated, show the bank's registered name beside
   the masked number when the farm manager adds an account, compare it with the Party's name (a mismatch is flagged for the checker,
   not blocked), and run the same check on every line just before the file is made (a failed or unavailable check blocks the
   file; this is the live check `payrollBlockers` is waiting for). Do not build it until the owner reports a working method and
   provider; leave a "name from bank" field, empty, on the new-account step and one hook in `payrollBlockers`. Known limits: it is a
   paid per-check service, some providers send a test credit, not every bank returns a name.
5. **Evidence of the bank's confirmation.** After "I uploaded it to the bank" the preparer may attach a screenshot of the batch
   as the bank shows it (it lists each line with its status). It is the only proof from a system TVC does not control, and it reuses
   the private evidence storage. Later it could be read to tick lines against the run, which gives settlement matching a head start.
   The screenshot holds real names and account numbers: private storage only, never the repo.
6. **File drop instead of keying.** The farm manager may drop his usual monthly sheet (Excel or CSV) instead of typing amounts;
   the page previews it matched to people by number or name, flags the unmatched, and one confirm creates the draft. Same pattern as
   the statement import. Needs the layout of his sheet, shown with invented names, before it is built.

**Decisions after reading the history of uploaded files (2026-11-17, with the owner).**
- **Run type (built, same branch):** a month holds one *salary* run plus any number of *bonus* runs, each with a name ("Diwali Bonus"), because Oct 2025 had a
  salary file and a bonus file. `fin_payroll_runs.run_type`/`label` (migration `0105`, still unapplied, so edited in place); the unique index is per month, type
  and name. A bonus is worded as the old files were ("<Mon YYYY> <name>", "<name> for <Mon YYYY>", reference `YYYY-Mon-Bonus-Employee-nnn`) and defaults to paying
  today. The reference is built in one function, `lineReference`, used by the file and by the line snapshot.
- **Employee numbers are seeded from the 2023-25 set** (the same ten people carried `1, 3-10, 12` every month for about 18 months; two numbers belong to people
  who left and are never reused). From Apr 2025 the sheet drifted (renumbered 1..N by row in some months, gaps in others), and since Dec 2025 it is `1..10` by row,
  so one person's number changed. The seed maps each current person to their 2023-25 number, to be confirmed by the owner when the history is imported.
- **The bank's newer bulk-payment system is out of scope.** Axis offers one that is better integrated with its banking application, but it needs reorganising the
  process to avoid mistakes and has not been tried. One file in the history (Jan 2026, 29 columns with headers) is an early look at its template; ignore it. The
  generator keeps writing the layout above.
- **Inconsistencies in the old files are not blockers and are removed by the generator, going forward:** the month typed in several places and disagreeing (a file
  named for one month holding another month's sheet name or references, at least four times); month names in the reference varying (`March` and `Mar`, and `Sep-Emp`
  in 2023); three versions of Oct 2024 and a "Copy" of Sep 2025; a Sep 2026 file that is really the Oct batch (identical, same references); one month
  (Aug 2026) with no file; one file (Jun 2026) whose amounts are formulas with no stored values.

**What the files and the ledger say about what was actually uploaded (read 2026-11-17; the files and amounts stay outside the repo).** Each file's total was matched
to a bank debit of exactly that amount.
- Every file's total appears as exactly one bank debit, so each month's batch was uploaded and paid at the file's amount. Where several versions of a file share one total (the
  three Oct 2024 versions, the Sep 2025 original and its copy, the Sep 2026 and Oct 2026 files), only one debit exists: only one was uploaded. For Oct 2024 it is the
  version whose payment date matches the bank date; the other two carry an earlier date and were stale.
- The bank settles a month about 1 to 4 days after the file's payment date (a weekend or holiday). One batch (Mar 2025) was paid early, on the 28th.
- **Bank debits with no file in the folder:** three bulk salary debits in the ledger (Jul 2026, Sep 2026, Oct 2026) have no matching file. Sep 2026 and Oct 2026 are the
  Aug and Sep salaries: their files are missing, or were never saved, and the file named Sep is the Oct batch. The Jul 2026 debit is the Jun file, whose amounts are
  formulas with no stored value, so it could not be compared.
- **Bank debits matching a file but with no allocation at all in the ledger (10):** six from before the tracker (Sep 2023 to Mar 2024 files) and four inside it (the
  Dec 2024, Jul 2025, Mar 2026 and Oct 2026 batches). These are gaps for the history import or settlement matching to fill. The Oct 2026 one is the latest batch.
- **Salary payments made outside the bulk file:** the ledger holds several single-person "Salaries" debits near month ends that appear in no file (Aug 2024, Mar 2025, Jun 2025 x5,
  Aug 2025, Nov 2025, Mar 2026): advances or one-offs paid another way. Payroll covers the bulk file only; these stay as they are, or become a later "off-cycle" run type.
- **Period convention (decided 2026-11-17, the owner): the salary month.** Settling a batch gives each person's allocation `period` = the salary month (a batch
  for Apr paid on 1 May sits in April), as this brief always said. The history already in the ledger was entered the other way, under the *payment* month, so the
  history import must either re-period those allocations or leave them and flag the difference; decide that when the import is built. A bonus run takes the month
  it is for, in the same way.

**Polish from the first review (small):** disable "Make the bank file" with a reason when someone's account cannot be paid; the
Finance menu has both "Payroll" and the older "Salaries" and both pages are headed "Salaries", so rename one pair to tell them apart;
two console errors on the pages (a 404 not traced yet, and a blocked sign-in script in the headless check).

**Still unverified:** the real downloaded `.xlsx` has not been confirmed to open in Excel. The structure tests clean as a zip, and a file
was opened in Excel on 2026-11-17; the result is not recorded here yet. The first "corrupt file" report came from the preview's stub
download, not from the generator.

## Read first
`DESIGN.md` (Payroll, fin_employees and related tables, Access); the sessions 04 and 05 notes; the payroll
workbook layout as described in `FINANCE.md`.

## In scope
- Tables `fin_employees`, `fin_salary_terms` (with history), `fin_attendance`, `fin_holidays`, `fin_advances`,
  `fin_payroll_runs`, `fin_payroll_lines`, `fin_payment_batches` (kind `salary`).
- **Pure payroll arithmetic** (tested to death): rate = agreed pay ÷ working days; pay = rate × days worked;
  holidays are paid but reduce working days; Sunday off; half day 0.5; a worker present every working day earns a
  paid day the next month; advances deducted at the agreed monthly amount; other adjustments (bonus).
- Attendance entry on a phone-friendly grid for the requester; import of the existing roster for the current year.
- Run states: draft, **confirmed** by the requester, **file generated** by the preparer, **approved** by a different
  director at the bank, **settled** when the bank line is matched.
- **Bulk file generator** in the bank's layout (from the real template), with date validation and a guard that
  blocks generation if any payee's details changed since last run and are unverified.
- Settlement matching: one bank debit ↔ one batch; the per-line reference creates one allocation per person with
  `period` = salary month, source `payroll`.
- Salary working report per FY (also used by session 11).

## Out of scope
Payslips, PF or TDS, leave policies beyond the paid-day rule, other pay schemes.

## Deliverables
Migration; payroll logic and file generator with tests; screens; `FINANCE.md`.

## How to verify
Recompute three real months from the workbook and match to the rupee (with the real inputs kept outside the repo). Tests: leap
month, a month with many holidays, half days, an advance running out, a changed payee blocks generation, preparer cannot approve, a settled run
creates allocations with the right period.

## Needs from Sharath
**The bank's bulk-upload template** (or a sample file) and the date rules; the roster for the current year.

## Docs to update
`FINANCE.md`, `ARCHITECTURE.md`.

## Start prompt
> Read `docs/finance/README.md`, `DESIGN.md`, `sessions/09-payroll.md`, and the notes from sessions 04 and 05. Build session 09 test-first with the tdd skill, starting from the pure payroll arithmetic. Real salary figures and the real template stay outside the repo.

## Done
**First slice of 09a, 2026-11-17 (branch `finance-09-payroll`, nothing pushed).**

Built:
- `scripts/lib/finance-payroll-file.mjs` (+ test, 20 passing): the bank bulk file in the layout above (columns A to L, no header),
  the payment-date validation, a one-sheet `.xlsx` writer (numbers as numbers, everything else text), and the guard that blocks
  generation when a payee account is not verified, not yet valid, retired or replaced and lists accounts that changed since the
  last run.
- Migration `0105_finance_payroll.sql`: `fin_employees`, `fin_payment_batches`, `fin_payroll_runs`, `fin_payroll_lines` with the
  status chain, maker-is-not-checker as a check constraint, whole-rupee nets, one live run per month, and a trigger that freezes a
  line once the file is generated.

Verified: the unit tests; the migration run on the real database inside a transaction that was rolled back (whole-rupee check,
duplicate person, second run for a month, preparer cannot approve, edit and delete refused after the file, RLS on), and
afterwards the tables did not exist. **Migration 0105 is not applied.**

**Run screens, 2026-11-17 (same branch):** `lib/finance-payroll.ts` and its routes, `scripts/lib/finance-payroll.mjs` (input rules, who may move a run, the
confirmation rows), the shared page component and two pages (directors, farm manager), nav entries, and 16 endpoint tests. Details in `FINANCE.md`, "Payroll".
Needs from Sharath before it can run for real: apply migration 0105, set `FINANCE_PAYROLL_DEBIT_ACCOUNT` in Netlify, grant the farm manager `finance-requests`, and add
the people as employee parties and then on the Payroll page. Not built yet: the history import, settlement matching and returns.

Decided 2026-11-17 (the owner): the portal accepts today or a future payment date and rejects a past one. So the generator refuses
only a past date, with no warning for a future one, and a file not uploaded by its payment date goes stale: regenerate it with a
new date (the run goes back from file generated to confirmed, the old batch is cancelled before upload, and the payee accounts are
snapshotted again).

Decided 2026-11-17 (the owner): the real risk with a payee account is a detail that was verified once and is no longer valid. The
right fix is to validate every payee account just before the file is generated, but there is no way to do that today (being
investigated separately). Until there is, `payrollBlockers` lets a verified account through and lists any account that changed since
the last run; that is a known gap, not a safeguard. When a live check exists it becomes one more check inside `payrollBlockers`, run
on every line at generation, and a failed or unavailable check should block the file.
