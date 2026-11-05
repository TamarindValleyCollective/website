# Odoo accounting: ideas for the TVC finance ledger

Survey done 2026-11-05 in Sharath's live Odoo (`syntropic.odoo.com`, SYNTROPIC Farm Management Pvt Ltd, dark mode),
read-only. Purpose: pick which ideas to bring to `/internal/finance/ledger/` (backlog: GitHub issue #533, ledger
rebuilt in PR #532). Nothing here is built. Per the usual flow: mockup artifact with a Current/New switch first.

Not compared yet: our current ledger code (local `main` was behind origin, pull first), the Odoo entry
Other Info tab, bank reconciliation widget, Customers/Vendors flows (we have no invoices), Settings.

## What Odoo has (menu map)

- **Dashboard**, **Customers** (Invoices, Credit Notes, Payments, Batch Payments, Products, Customers),
  **Vendors** (Bills, Refunds, Payments, Batch Payments, Products, Vendors).
- **Accounting**: Transactions (Journal Entries, PAN Entity, Transfers, Analytic Items); Assets & Liabilities
  (Assets, Loans); Closing (Reconcile, Tax Returns, Lock Dates).
- **Review**: Control (Journal Items, Journal Audit); Audit (Working Files); Inventory (Depreciation Schedule,
  Loans Analysis); Regularization (Deferred Expenses, Deferred Revenues); Logs (Audit Trail).
- **Reporting**: Statements (Balance Sheet, P&L, Cash Flow); Ledgers (General Ledger, Trial Balance);
  Partner (Partner Ledger, Aged Receivable, Aged Payable); Tax (Fiscal Report, Tax Report);
  Management (Invoice Analysis, Analytic Report, Executive Summary).
- **Configuration**: Chart of Accounts, Taxes, Journals, Currencies, Fiscal Positions, Multi-Ledger, Cash Roundings,
  Checks, Asset Models; Payment Terms, Follow-up Levels; Payment Providers/Methods; Analytic Distribution Models,
  Analytic Accounts, Analytic Plans.

## Ideas, grouped by how well they fit us

### A. List, search, filter (biggest gap, likely first)

1. **One search box with chips.** Active filters are removable chips inside the field. One dropdown holds three
   columns: Filters, Group By, Favorites.
2. **Preset filters by kind**: Unposted/Posted, Reversed, Manual; by journal type (Sales, Purchases, Bank, Cash,
   Misc); Date and Invoice Date as filters with period choices.
3. **Group By**: Partner, Journal, Status, Payment Method, Date (day/month/quarter/year), plus a Custom Group on
   any field. For us: project, unit, party, account, month, year.
4. **Favorites** ("Save current search"): named filter+group combos. Maps to our saved drafts idea.
5. **Pager and bulk select**: "1-80 / 265", checkbox on every row, bulk actions on the selection.
6. **Column picker** at the right of the header; **view switcher** (list, kanban, activity) top right.
7. **Dense list**: ~27px rows, right-aligned amounts, small green status pill (Posted), muted zero amounts.

### B. Journal Items view (the line-level ledger)

8. **Left group-by sidebar** ("All / 1 / 2" counters) beside the list.
9. **Attachment preview panel** on the right ("Choose a line to preview its attachments"), collapsible with `>>`.
   Good fit for receipts/bills next to a ledger line.
10. **Matching column** showing reconciliation state per line.
11. **Debit / Credit columns** with the full narration as the label (bank text kept verbatim).

### C. Entry detail page

12. **Statusbar** Draft -> Posted, with **Reverse Entry** and **Reset to Draft** buttons (no silent edit of a posted
    entry; a reversal is the correction).
13. **Chatter** on the right: Send message, Log note, Activity. OdooBot logs "Journal Entry created" and keeps the
    raw bank-feed payload as a message. Fits an audit trail per entry plus notes for the core team.
14. **Tabs** Journal Items / Other Info, balanced totals shown under the lines.
15. **Smart button** ("1 Bank Transaction") linking the entry to its source statement line.
16. **Record pager** "1 / 80" to step through the filtered list from inside a record.

### D. Control and closing

17. **Lock Dates** dialog: Lock Sales, Lock Purchases, Lock Tax Return, Lock Everything (exceptions allowed for
    some users), and an irreversible **Hard Lock**. Links to our past-change approvals (stays) and to a month-close.
    Currently nothing is locked in Odoo either.
18. **Reconcile screen** ("Journal items to reconcile"): grouped by account then partner with expandable rows,
    Residual column, **Auto-reconcile** button. Relevant to payment reconciliation (see memory:
    `project_payment_reconciliation_scenarios`).
19. **Journal Audit** and **Audit Trail** (a log of changes) under Review.
20. **Banner**: "There are unposted Journal Entries prior or included in this period" on the report.

### E. Reports

21. **General Ledger**: accounts as expandable rows, columns Debit / Credit / Balance for the chosen period, "Result
    Brought Forward" row, Total row. Header controls: period picker, All Journals, Analytic, Posted Entries
    toggle, currency. **PDF and XLSX export** buttons top-left. Negative balances in red.
22. **Trial Balance**, **Partner Ledger**, **Aged Payable** (maps to our parties, payables to vendors).
23. **Analytic accounts and plans** (cost centres / projects): our Farm Project and unit allocations are the same
    idea. Odoo's "Analytic Items" list had no data here, so it is only a menu-level reference.
24. **Executive Summary** and **Analytic Report** as management views. We have dashboards planned (issue #533).

### F. Probably not for us

- Customer invoicing, credit notes, batch payments, follow-up levels, payment terms and providers, tax returns,
  fiscal positions, multi-ledger, cash roundings, deferred revenue, assets/depreciation/loans (the Assets list
  here only holds Odoo's sample rows: "Import your fixed assets' original data").

## Observations about this Odoo instance

- 265 posted bank entries in "AXIS Bank (Corporate)" (`BNK2/25-26/xxxx`), Jul-Aug 2025, imported via the Yodlee
  bank feed. Each entry has two lines: the real account vs `100202 Bank Suspense Account`.
- The Bank Suspense Account balance is large and negative in the General Ledger, so most entries are still
  uncategorised. That is the same job our ledger does with allocations.
- Two items sit open under Reconcile (a Debtors vs Local Services pair for one person).

## Suggested order for the next session

1. Pull `main`, read the current ledger page and `docs/finance/*`, compare with section A.
2. Mockup artifact (Current/New switch) of search+chips+Group By+Favorites on the ledger.
3. Then decide on B9 (receipt preview panel) and C12-C13 (reverse instead of edit, per-entry notes/audit).
4. D17 (lock a closed month) and E21 (General Ledger style report with XLSX export) as follow-ons.
