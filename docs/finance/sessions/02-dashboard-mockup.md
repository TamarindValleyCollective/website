# 02 Dashboard mockup

**Depends on:** nothing (design only). **Run before:** 07. Can run alongside any other session.

## Goal
A reviewed mockup of the finance dashboards, so session 07 builds something Sharath has already approved.
Follow the project habit: review, then an artifact mockup with a Current/New switch, then build.

## Read first
`DESIGN.md` (Dashboards, Auditor workspace); the admin design rules in `AGENTS.md`; `src/layouts/StaffLayout.astro`;
`/internal/usage` as the nearest existing dashboard; the `dataviz` and `apple-design` skills.

## In scope
- Mock each dashboard with **invented** data: Cashflow, Budget vs actual, Maintenance collections,
  UPI circle gauge, Sinking fund, Revenue, Obligations, Data health, and the auditor "nature of
  expenses" page.
- Light and dark appearance; phone and desktop widths.
- A single page of "decisions to confirm": which numbers lead, what the one-glance summary shows, what is a table versus a chart.

## Out of scope
Real data, any backend, migrations.

## Deliverables
A published artifact (private) and the source HTML under `docs/finance/mockups/`, plus a short list of
agreed changes in this brief's "Done" section.

## How to verify
Sharath reviews each screen, particularly on his phone, and approves or lists changes.

## Needs from Sharath
Review time. Which two or three numbers matter most when he opens the page.

## Start prompt
> Read `docs/finance/README.md`, `DESIGN.md` and `sessions/02-dashboard-mockup.md`. Build the dashboard mockup with invented data as a private artifact, using the dataviz skill, and iterate with me. Do not touch the backend.

## Done
Built 2026-11-10 and reworked twice after review. Scope is the four screens session 07 builds (Overview, Cashflow
with runway, Budget vs actual, Data health, plus the UPI circle), and two views added in review because both move
cash: **Maintenance** (collections) and **Advances** (employee advances and their recovery). Sinking fund,
Revenue, Obligations and the auditor "nature of expenses" page were **not** mocked.

- Source: [`mockups/dashboards.html`](../mockups/dashboards.html). Every figure is invented and deliberately not
  close to any real figure. Also published as a private artifact.
- The budget view follows the structure of how the budget is presented to members (heads, lines with a comment,
  income, maintenance, summary, financial status, next-year contribution per household). Only the structure was
  used; no real line, comment or amount is in the repo.
- A header selector switches the financial year for every view; "Member view" previews what the member portal
  would show.

**Agreed so far:** the owner approved the first version ("Looks good") and then asked for the year selector,
salaries, advances, maintenance collections and the member view. The reworked version needs another review; the
decisions below are the mockup's defaults and are listed on its Decisions tab.
1. The Overview leads with four numbers: runway, budget used, bank balance with the month's movement, items
   needing attention; below them, money still owed to the farm (maintenance pending, advances to recover).
2. Runway is the bank balance divided by average monthly *spending* of the last six complete months, leaving out
   sinking-fund transfers. It replaces the design document's "net outflow" definition because maintenance arrives
   in lumps. **Confirmed by the owner 2026-11-10;** DESIGN.md is updated in the session 07 PR.
3. The budget is grouped by the presentation's heads (Company, Farm, Projects, Investment), not the design
   document's Opex/Capex/Project buckets. **Confirmed by the owner 2026-11-10;** DESIGN.md is updated in the session 07 PR.
4. Salary is its own colour in spending charts and carries a share of spending on every budget line.
5. Maintenance view: collected against expected, against last year at the same point, how late the pending dues
   are, clusters, and the households still to pay (house numbers only), plus how many months of spending the
   pending amount equals.
6. Advances view: given, agreed monthly recovery, recovered, left, when it clears; an advance with no recovery
   agreed or a missed recovery goes to Data health and the Overview. Until payroll (session 09) exists an approver
   records recoveries against the advance.
7. Dashboards show house and employee numbers only; names stay in the directory and payroll. **Exception, decided 2026-11-15:** a UPI Circle delegate shows as on the UPI page, their name if one has been set, otherwise their number.
8. Member view: Overview (own household's maintenance instead of the attention list), Cashflow, Budget vs actual,
   Maintenance totals with a card for the member's own household. Hidden: Advances, other households' dues, Data
   health, UPI circle, the draft next-year plan. **Decided 2026-11-10: the member view is a preview feature for chosen homes, not open to everyone yet.**
9. Estimates only for the farm's running costs; "committed" means approved but not yet matched to a bank line;
   Cashflow is the cash view and Budget vs actual the period view; every chart has a table view or tooltips.
10. Financial year selector in the header; a closed year shows final figures; Data health always describes today.
11. Data health items that block a month close: unverified payees in use, bank lines with no category, advances
    with no recovery agreed, a broken balance chain.
12. **Channels** (admin only, added 2026-11-15; mockup tab only, nothing built): **only money channels** drawn as a network you can zoom and
    move around in, like a knowledge graph. Every circle is a channel: the accounts (the current accounts and the fixed deposits held
    outside them), the channels money passes through (payment gateway, POS terminal, bulk payments, card, each UPI app, plain bank
    transfers) and the delegates, who pay through an operator's UPI app. What the money was *for* (salary, farm and household,
    projects, company, sinking fund; maintenance or stays on the way in) is **not a channel, so it is a filter** (Spent on / Received
    for, with all projects or one project): choose it and the same circles show only that money, through the channels it used (decided
    2026-11-15; an earlier version drew those as circles, which mixed things that are not channels into the map). Each channel's panel
    lists what it was used for, and clicking a row applies the filter. Circles are sized by amount (area), joined by straight links as
    thick as the money flowing through them, with the figure inside where it fits. It starts as simply as it can: **Tidy**
    arrangement (the order is found by trying every possibility, so as few links as possible cross: none with Main links, and with
    All links only the one crossing that cannot be avoided, because both UPI apps connect to both accounts. It is then placed three
    ways, plain columns, an arc around the main account, or a **ring around it**, and the crossing-free layout that gathers each busy
    circle's links around it wins (the main account in the middle with its channels all around it, the deposits beyond the transfers
    they feed, the delegates beyond their UPI app), unless that would shrink the picture by more than 15%, which leaves no dead space
    around the hub; **drag a circle and the
    others re-order around it as you carry it, then it settles into the nearest slot that keeps the links uncrossed**, staying in its own
    column, since accounts, channels and delegates mean different things; Organic is the freeform alternative, where dragging pulls the
    others along and crossings are not prevented), **Main links** (each circle's strongest link and the big flows; selecting or hovering a circle shows all of
    its links; All links shows everything) and idle channels hidden (Show idle channels brings them back). Scroll or pinch to zoom, drag
    the background to move, Fit arranges everything again; what is written under a circle depends on the zoom relative to the fitted
    view. Click a circle for its details; the + or - on a circle opens or closes what hangs off it; Zoom to this focuses on a circle and
    its connections. Other filters: period (year to date, last three months, this month; a closed year has only the year), one account
    (including the fixed deposits), needs attention only, hide planned, hide delegates, and a search that highlights matches and zooms
    to them; a count says how many circles are shown and Reset clears them. A ! badge marks what needs attention and dashed means
    planned. A Money out / Money in switch changes the direction. **Fixed deposits** are their own green circle outside the current
    accounts: money goes in and the interest comes back by bank transfer; today they are one circle, and each deposit would be its own
    once deposits are recorded (bank, amount, rate, maturity). The channels add up to the bank statement and a table view says so and
    shows what each channel was used for (made-up affinities fitted so every row and column adds up; the real figures would come from
    the ledger's allocations; delegates' spend is not split by purpose, so a purpose filter hides them). On a phone it is the same
    canvas (pinch to zoom) with the panel below. Earlier versions had boxes with every figure inside, circles in strict columns, and an
    organic network with circles for where the money went; a Sankey was rejected (it mixes money in and out and tangles as channels
    are added). Boxes for things not built (the ICICI account, the POS terminal, Google Pay) are dashed and marked Planned so the
    structure does not change when they arrive. Today a POS terminal counts under Debit card and a second person's Paytm cannot be
    told apart from the first: that needs an operator record.

**For session 07 and the sessions after it:** figures are in lakh in tiles and charts, full rupees for the
circle and advances; budget bars scale to 130% of each line's budget with a tick at the budget; status pills
always carry an icon and a label. Maintenance (session 10) and advances (session 09) now have a proposed
dashboard shape to build to, once the decisions above are confirmed. Nothing here was checked against real figures; that comparison is session 07's job.
