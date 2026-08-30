---
target: src/pages/internal/accommodation-calendar.astro
total_score: 23
max_score: 40
na_heuristics: 
p0_count: 2
p1_count: 3
timestamp: 2026-08-30T09-35-56Z
slug: src-pages-internal-accommodation-calendar-astro
---
Method: dual-agent (A: design review · B: detector + browser evidence)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2/4 | Saving a booking gives zero success confirmation — form silently clears, grid re-renders; only failures get visible text. |
| 2 | Match System / Real World | 3/4 | Genuinely farm-specific vocabulary (tent names, "via Linger," "booked direct"), undercut by raw enum leakage ("casual-stay" as a title) and `NA` as a gender default. |
| 3 | User Control and Freedom | 3/4 | Good escape hatches (Cancel edit, "Never mind," "different guest" override) confirmed live; no undo after a real delete, but the reason-required gate substitutes. |
| 4 | Consistency and Standards | 1/4 | Edit (safe) and Cancel (destructive) render as visually identical buttons; delete-confirm reuses the same green as every "save" action; six Type options use four different label grammars. |
| 5 | Error Prevention | 4/4 | Strongest heuristic here — live tent-conflict disabling before submit, capacity-capped guest rows, inline mobile-format validation, identity-conflict interception, all confirmed live. |
| 6 | Recognition Rather Than Recall | 3/4 | Name/mobile typeahead and "Past stays" panel remove real recall burden; docked because guest-row fields have no persistent `<label>`, only placeholder text that vanishes once filled. |
| 7 | Flexibility and Efficiency | 1/4 | Clicking an occupied/closed grid cell opens it for editing, but free cells get no handler at all — no way to start a new booking from a date you're already looking at. |
| 8 | Aesthetic and Minimalist Design | 2/4 | The grid itself is restrained; the form is a flat, undifferentiated 10+ field scroll, and the orange-button bleed-through adds unintended visual noise. |
| 9 | Error Recovery | 3/4 | Where errors surface they're specific and actionable (exact reason required, exact mobile-format expectation). |
| 10 | Help and Documentation | 1/4 | Low-stakes for a single-user internal tool, but existing hint text is sometimes actively wrong for the state it's shown in (see Minor Observations). |
| **Total** | | **23/40** | **Acceptable** |

## Design Specificity Verdict

**LLM assessment:** The domain model is genuinely bespoke, not generic CRUD wearing a farm skin — real tent names with real live capacity checks, TVC-specific booking types, and a guest-identity system built to solve a named, real problem (two people sharing one phone number, resolved with a human-in-the-loop "same person or different guest?" prompt rather than a silent merge). Where it stops feeling authored is the *interface* layer: every button the client script builds at runtime renders the marketing site's solid orange CTA color, confirmed live via computed style (`rgb(247,133,32)`) — not a deliberate choice, a scoping accident (see Priority Issues). And when the model leaks into copy, it leaks as code: a booking with no Label shows its raw type slug ("casual-stay") as its title, confirmed live on the booking card, the grid tooltip, and the guest's own past-stays history.

**Deterministic scan:** The static-source CLI detector (`detect.mjs`) found zero findings in the `.astro` file itself. The live, DOM-based detector (injected into the authenticated page) reported 6 anti-patterns, but all 6 are on shared site chrome — the global header/footer text and the floating chat widget's border/shadow, the page's cream background, and body-level font-usage — not this page's own markup. None of the 6 are specific to the accommodation-calendar feature; they'd fire identically on any page using the shared layout, so they're discounted from this page's own critique.

**Live confirmation:** I re-verified the headline finding directly against the authenticated app myself before including it here — `Edit`/`Cancel` buttons in the booking list compute to `background-color: rgb(247, 133, 32)` with no `data-astro-cid-*` attribute, versus the statically-rendered "← Prev" button, which correctly gets `rgb(255, 255, 255)` and carries the scoping attribute. I also independently reproduced the mobile month-nav overflow at a real phone width (390px): `document.body.scrollWidth` (588px) exceeds `clientWidth` (485px), and the Week/Month toggle buttons are pushed off-screen with no visual hint they exist.

## Overall Impression

**Given your stated focus — mobile usability and making this idiot-proof — I've resequenced the priority order below around that lens rather than general severity.** The single highest-leverage fix is almost certainly the button-color bug: every action on this page, safe or destructive, currently renders as a loud solid-orange marketing button, which is very likely the concrete thing behind "I'm not a fan of how this looks." Close behind it, on a real phone the calendar's view-mode toggle is currently unreachable — not cramped, *gone off-screen* — which fails "idiot-proof" outright for the one scenario you called out. The underlying data model and the error-prevention work (tent conflicts, capacity caps, guest-identity conflicts) are the strongest part of this build; the interface hasn't caught up to it yet.

## What's Working

1. **Type-conditional field visibility is a real, working progressive-disclosure system.** Switching the Type dropdown live-collapses the form correctly for all six types — down to a lean 4-field form for `farm-closure` — confirmed by screenshot, not just by reading the code.
2. **Live tent-conflict prevention was iterated from real usage, not designed in the abstract.** The code's own comments cite specific testing feedback for why an invisible warning became a visible one — this is a tool that's already been shaped by watching someone actually use it.
3. **The mobile-number identity-conflict flow** ("Same person — fix the name?" vs. "different guest, same number") solves a real, named data problem with a clear, low-friction human choice instead of a silent merge or silent duplicate.

## Priority Issues

**[P0] Every action button renders as the marketing site's solid orange CTA, indistinguishable from each other**
- **Why it matters**: `Edit`, `Cancel`, `+Guest`, the guest-row remove button, the mobile-conflict actions, and the reason-overlay buttons are all built at runtime via `innerHTML`/`createElement` — Astro's scoped-style attribute selector never reaches them, so they fall through to `global.css`'s site-wide `.button { background: var(--tvc-orange-cta) }`, meant for the marketing site's hero CTA. A safe action (Edit) and a destructive one (Cancel) are visually identical, and the whole page reads louder and less intentional than it was designed to. This is very likely the concrete thing behind "I'm not a fan of how this looks."
- **Fix**: Extend the `is:global` block's existing hover-only fix to also set the base state: give dynamically-built, non-primary buttons the page's own white-pill treatment, then deliberately differentiate destructive actions (Cancel, remove-guest) from neutral ones (Edit, +Guest) so they're not the same color as each other either.
- **Suggested command**: `/impeccable harden` (root cause is a CSS cascade/scoping bug), then `/impeccable polish`.

**[P0] The month-nav toolbar overflows at real phone widths, hiding the Day/Week/Month toggle off-screen entirely**
- **Why it matters**: Verified directly at 390px width (a real phone size): the page's `scrollWidth` (588px) exceeds `clientWidth` (485px) because `.month-nav`'s row (Prev, the month label, Next, and three toggle buttons) never wraps. The view-mode toggle isn't just cramped — it's pushed past the visible viewport with zero affordance that horizontal scroll would reveal it. Since you specifically care about mobile use, this is a hard failure, not a rough edge: a feature you asked for (day/week/month toggle) is currently unusable on a phone.
- **Fix**: Wrap `.month-nav` (`flex-wrap: wrap`) so the toggle drops to its own row under a breakpoint, or collapse it into a single compact control (e.g. a segmented control or `<select>`) below the date label on narrow screens.
- **Suggested command**: `/impeccable adapt`.

**[P1] The calendar grid and the booking form are disconnected — free cells aren't clickable**
- **Why it matters**: Clicking an occupied or closed cell opens it for editing, but empty cells get no click handler at all. To start a new booking, you have to remember the tent and date you were just looking at on the grid, then scroll down and re-enter both from memory in a separate form. This directly works against "idiot-proof" — it's an unnecessary chance to mis-transcribe a date, and it's worse on a phone where the form is a full scroll away from the grid you just tapped.
- **Fix**: Give free cells a click handler that opens the (reset) "New booking" form pre-filled with that tent checked and that date as Start date.
- **Suggested command**: `/impeccable layout`.

**[P1] Raw type-enum values leak into human-facing titles whenever Label is left empty**
- **Why it matters**: A `casual-stay` booking with no Label literally shows "casual-stay" as its bold title — on the booking card, the grid-cell tooltip, and the guest's own "Past stays" history. Confirmed live. For a tool meant to be foolproof, showing internal code vocabulary in the exact spots meant to be most scannable undermines trust in whether the entry was even saved correctly.
- **Fix**: Either require Label for any booking type that has no other self-describing value, or map each type to a real display string as the fallback instead of the raw slug.
- **Suggested command**: `/impeccable clarify`.

**[P2] The "New booking" form is a single flat, undifferentiated scroll of 10+ fields**
- **Why it matters**: Beyond one `<fieldset>` border around Tents, Type/Label/Member/Exclusive/dates/Note/Reason all share identical styling with no grouping into "what/when/who/internal notes." On a phone this becomes a long thumb-scroll with no landmarks, compounding the disconnect from the grid above it (P1).
- **Fix**: Group fields into visually distinct clusters — even a lightweight background tint or micro-heading per cluster would give the form real hierarchy instead of a flat list.
- **Suggested command**: `/impeccable shape`.

## Persona Red Flags

**Jordan (first-timer, non-power-user)** — the closest fit to the tool's actual real-world user, a farm manager who isn't necessarily a confident computer user. Jordan would be tripped up by: guest-row fields that only carry placeholder text (no persistent `<label>` — confirmed via source), so once a field is filled there's no label left to confirm which column is which; the flat, unsignposted form (P2); and the raw-slug leak (P1) — if Jordan skips the optional-feeling Label field, he'll later see his own booking listed as "casual-stay" and reasonably wonder if he did something wrong.

**Casey (mobile)** — confirmed, not hypothetical, and squarely your stated concern: at a real phone width the month-nav overflows and hides the view-mode toggle entirely (P0). A farm manager checking or entering bookings from a phone on-site is a plausible everyday scenario for this exact tool, not an edge case to deprioritize.

**Sam (accessibility-dependent)** — guest-row inputs rely solely on placeholder text as their only accessible name (disappears on input, not a reliable substitute for assistive tech); grid cells communicate "booked / closed / free" via a hover-only `title` attribute on a non-focusable cell, which isn't reliably exposed to screen readers or touch devices at all.

## Minor Observations

- Gender select defaults to `NA` — developer shorthand where something like "Prefer not to say" would read more naturally in a guest register.
- Free and closed grid cells share the identical `·` glyph, distinguished only by background tint — occupied gets a distinct `●`, but free vs. closed don't get a shape difference from each other.
- The guest-typeahead dropdown floats directly over the "Preferences / allergies" field beneath it rather than pushing it down, visually merging the two controls.
- The "Mobile number (optional)" placeholder visibly truncates inside its own input at default guest-row width, even before typing.
- Six Type-dropdown options use four different parenthetical grammars ("via Linger" / "(linked)" / "/ retreat" / "(booked direct)" / "(repair, etc.)" / "(leave, repairs)").
- The "Label" field's hint — "(shown to you only, e.g. who's coming)" — stays unchanged for `unit-closure`/`farm-closure`, where "who's coming" doesn't apply.
- The live-detector's own console output said "4 anti-patterns found" but printed 6 distinct findings — a count/log mismatch in the detector tooling itself, not a design issue, but worth knowing before trusting its counts at face value.

## Questions to Consider

1. What if the grid *were* the form — tap any free cell to book, tap any occupied cell to edit — instead of keeping a fully separate "New booking" section that duplicates context you can already see two seconds above it? This would likely do more for "idiot-proof on mobile" than any individual polish pass.
2. This tool has exactly one real daily user. Is a full Google Sign-In + live-allow-list gate proportionate to that scale, or is that complexity (and the auth flakiness this very review kept running into) better spent making the core task faster?
3. If type slugs like `casual-stay` are meant purely as internal shorthand, why let them ever surface as a booking's human-facing title at all?
