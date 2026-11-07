# Finance module: how to build it

The design is in [DESIGN.md](DESIGN.md). It is too large for one Claude session, so it is split
into the session briefs below. Each brief is self-contained: start a **new** session for each one,
paste its "Start prompt", and let it read the design and the previous sessions' notes from this
folder. Do not carry one long conversation across several of them; the repository, not the
conversation, is the memory.

**This is a public repository.** No names (other than roles), account numbers, UPI IDs, salaries,
vendors or amounts in code, tests, fixtures, screenshots or docs. Use invented data. Real
statements go to the private R2 bucket or the database, never the repo.

## Order and dependencies

```
 01 Foundation & access ──┬── 03 Statement import ──┐
                          │                         ├── 05 Ledger & review ── 06 History load ── 07 Dashboards ──┐
                          └── 04 Parties & payees ──┘                              │                              │
 02 Dashboard mockup (no dependency; run any time before 07)                       ├── 08 Payment requests & bills ┤
                                                                                   ├── 09 Payroll ─────────────────┤
                                                                                   ├── 10 Maintenance ─────────────┤
                                                                                   └── 12 Treasury & obligations ──┤
                                                              11 Auditor workspace (after 05, better after 08) ─────┤
                                                                                                         13 Cutover ┘
```

Sessions 03 and 04 can run in parallel after 01. Sessions 08, 09, 10 and 12 can run in parallel
after 06, each in its own worktree and branch, because they touch different tables. Session 02 can
run at any time. Run 13 last.

| # | Session | Needs from Sharath | Ships on its own |
|---|---|---|---|
| 01 | [Foundation & access](sessions/01-foundation-and-access.md) | Who gets which finance grant | Yes (an empty, secured module) |
| 02 | [Dashboard mockup](sessions/02-dashboard-mockup.md) | Review and choose | Yes (a mockup, no backend) |
| 03 | [Statement import](sessions/03-statement-import.md) | A real Axis statement file | Yes (imports, no ledger) |
| 04 | [Parties & payees](sessions/04-parties-and-payees.md) | Review of the party list | Yes |
| 05 | [Ledger & review](sessions/05-ledger-and-review.md) | Category list sign-off | Yes (replaces the two tabs) |
| 06 | [History load](sessions/06-history-load.md) | Time to check differences | Yes (data) |
| 07 | [Dashboards & budget](sessions/07-dashboards-and-budget.md) | Review against the sheet | Yes |
| 08 | [Payment requests & bills](sessions/08-payment-requests-and-bills.md) | The farm manager trying it | Yes |
| 09 | [Payroll](sessions/09-payroll.md) | The bank's bulk-file template | Yes |
| 10 | [Maintenance](sessions/10-maintenance.md) | Decision on due visibility | Yes |
| 11 | [Auditor workspace](sessions/11-auditor-workspace.md) | The CA's export format | Yes |
| 12 | [Treasury & obligations](sessions/12-treasury-and-obligations.md) | Base of the partner share | Yes |
| 13 | [Cutover](sessions/13-cutover.md) | A month-end to compare | n/a |

## Rules every session follows

1. **Read first:** `AGENTS.md`, `docs/finance/DESIGN.md`, this README's status table, and the brief.
   Read the ADRs and existing code the brief names. Check `supabase/migrations/` for the next number.
2. **Work in a worktree** and open a draft PR. Never push to `main`.
3. **Test-first for money rules** (use the `tdd` skill): the allocation sum, the balance chain, dedupe,
   payroll arithmetic, period locks, maker-is-not-checker. Put pure logic in `scripts/lib/*.mjs`
   with `*.test.mjs` beside it, as the repo does.
4. **Migrations are not auto-applied.** Say in the PR which numbers need applying, and apply them
   before the code that needs them is merged.
5. **Docs in the same change:** add `FINANCE.md` (created by session 01) updates, `ARCHITECTURE.md`
   for new functions or services, and the `CHANGELOG/YYYY-MM.md` line when merged to `main`.
6. **Design language:** use the admin shell and `--tvc-*` tokens (`npm run lint:css`); mock up risky
   screens first.
7. **End by updating the status table below** and the brief's "Done" section with what was built,
   what was verified and how, and what is left, so the next session starts from facts.

## Status

| # | State | Notes |
|---|---|---|
| 00 | Design written 2026-11-02 | `DESIGN.md` and these briefs |
| 01 | Built 2026-11-02, draft PR (`finance-01-foundation`) | Registry modules, grant expiry, reference tables, overview endpoint and page. Migration `0077` applied 2026-11-02. See [FINANCE.md](FINANCE.md). |
| 03 | Built 2026-11-02, draft PR (`finance-03-statement-import`) | Yearly Axis files (any number, any order, chain checked across years) and the Paytm export; preview then confirm. Migration `0080` applied 2026-11-02; real statements and Paytm export imported and verified the same day (PRs #525, #526). See [FINANCE.md](FINANCE.md). |
| 04 | Built 2026-11-02, draft PR (`finance-04-parties`) | Parties directory, encrypted payee accounts, reveal/verify behind the step-up, shared-account flags, operator import from a Google Sheet. Migration `0079` **applied 2026-11-02**. See [FINANCE.md](FINANCE.md). |
| 04 follow-up | Design-review changes, draft PR #528 | Admin navigation by blocks, needs-you Overview, verification work queue and evidence (migration `0082`, applied 2026-11-02), states, Import regrouped. See [FINANCE.md](FINANCE.md). |
| 05 | Built 2026-11-05, draft PR #529 (`worktree-finance-05-ledger`) | Posting rules, rules engine and review flags, ledger and rules screens, bulk apply, refunds, period close, category merge. Migration `0083` **applied 2026-11-05**. See [FINANCE.md](FINANCE.md). |
| 05 follow-up | BHIM import, origin column, UPI page, branch `finance-upi-circle-bhim` | Migrations `0088` **applied 2026-11-07**, `0089` (payment notes) **applied 2026-11-07**, `0090` (source badges) **applied 2026-11-07** (the ledger reads `fin_upi_lines.app`, so it must stay applied before this merges). See [FINANCE.md](FINANCE.md). |
| 06 | In progress, branch `worktree-finance-06-history` | The tracker is matched to the bank lines (dry run: 95.3% of rows). Mapping and the apply step are next. See [FINANCE.md](FINANCE.md). |
| 08 | Brief updated 2026-11-07, not started | Requests also covers logging a spend already made; purposes are pulled from here into the UPI page and ledger; the old sheet's history is loaded once. See the brief. |
| 02, 07, 09-13 | Not started | |
