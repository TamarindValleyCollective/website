---
target: "UPI page: Name, Party and UPI ID columns, row and toolbar buttons, reviewed-add dialog"
total_score: 23
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 4
target_identity: "file:/Users/sharathjeppu/Documents/GitHub/website/.claude/worktrees/finance-vpa-name-suggest/src/pages/internal/finance/upi.astro"
target_fingerprint: "sha256:635c7724fb3a5990eb73cdcfc8722faf747baff1a4e062aabca5a88a13a6a136"
target_path: /Users/sharathjeppu/Documents/GitHub/website/.claude/worktrees/finance-vpa-name-suggest/src/pages/internal/finance/upi.astro
timestamp: 2026-11-16T12-06-34Z
slug: src-pages-internal-finance-upi-astro
---
# Critique: UPI page (src/pages/internal/finance/upi.astro)

Method: dual-agent (A: design review of the source, B: detector and lint; browser overlay skipped, the live page is behind Google sign-in).

## Answer to the open question
Keep "Add ID" in the Party column, not the UPI ID column, and move the buttons out of the data cells into one sticky "Next step" column (Look up, Add and Add ID never co-occur on a row). The UPI ID column is hidden by default and masked for many viewers, so an action tied to it is invisible to the people who need it; the decision is about the register, so its status stays in Party.

## Design Health Score: 23/40 (Acceptable)

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 3 | Results are a vanishing toast; an added person never shows as unverified on the row |
| 2 | Match with the real world | 2 | "ID not on file" does not say whose file; "No name on file" appears in two columns |
| 3 | User control and freedom | 3 | Review dialog is good; a billed lookup shows no cost cue and cannot be undone |
| 4 | Consistency and standards | 2 | "Tick/untick" breaks the project vocabulary; red used for a normal state; row buttons in data cells |
| 5 | Error prevention | 2 | Entries keyed by name or party, not UPI ID, so two people can merge |
| 6 | Recognition over recall | 2 | Must remember which of Paid to / Name / Party is authoritative |
| 7 | Flexibility and efficiency | 3 | Chips and bulk add good; both toolbar buttons ignore the current filter |
| 8 | Aesthetic and minimalist design | 2 | 11 default columns; Name and Party often repeat Paid to |
| 9 | Error recovery | 2 | "Name differs" and "No name on file" are dead ends; skip reasons vanish in a toast |
| 10 | Help and documentation | 2 | Explanations are hover-only titles |

Design specificity: the old layer is well authored for this product; the new layer is less so (three overlapping "who is this" columns, buttons inside cells, a dialog with no styling of its own: `.party-sheet` has no CSS rule).

## What's working
1. Row states come from one tested module (UPI ID first, name second).
2. Billed calls are explicit buttons, capped at 25, stopping at the first failure.
3. The reviewed add works per person with editable name and kind.

## Priority issues
- [P1] Colour severity is inverted: "Not in Parties" is a red pill while "Name differs" is amber; red also means "Not in the statement" next door. Fix: neutral for "Not in Parties" and "ID not on file", amber for "Name differs", red for money states only.
- [P1] The masking is cosmetic: "Paid to" still carries the full ID, is searchable, filterable from the cell menu, and is the phone card title. Fix: mask it on the same rule; label masked cells for screen readers.
- [P1] The add dialog fails on a phone (name field about 60px) and never shows which ID is attached. Fix: widen, stack rows on phones, show the masked ID, button "Add 3 people" disabled at zero.
- [P1] Entries can merge: keyed by name or party, so two IDs for one party, or two people with one registered name, become one entry carrying only the first row's ID. Fix: key on the UPI ID.
- [P2] Name and Party repeat each other: merge into one Payee column with the register state as a small pill.

## Persona red flags
- Alex: toolbar buttons ignore the filter ("Add 14" after filtering to one vendor); shared bulk bar unused.
- Sam: every Look up button has the same accessible name; meaning lives in hover-only titles; masked IDs read as bullets.
- Jordan: cannot tell the order (look up, add, someone else verifies); "Party", "ID not on file", "unverified" never explained; no cost cue on the billed lookup.

## Minor observations
- Pre-existing, from the detector: the attention notice's 4px side stripe (line 852) is a side-tab warning; it carries meaning (orange or red), low severity.
- Phone cards: no Party state, no buttons, no masked ID; an unlooked-up payee shows the full raw ID as the title.
- Dialog wording: "untick" / "Tick at least one" should be "Deselect" / "Select at least one".
- Rows with a button are about 46px against about 37px.
- `border-radius: 6px` is a literal (use `--radius-sm`).
- `npm run lint:css` passes.

## Questions to consider
- Should Look up simply happen for rows on demand and drop its own button?
- Is "Add to Parties" really a per-row decision, or a bulk review by someone who never looks at amounts?
- Why can't the second admin verify from this row in one step, since both names are shown?
