---
target: accommodation-calendar booking form
total_score: 30
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
timestamp: 2026-09-10T15-59-37Z
slug: src-pages-internal-accommodation-calendar-astro
---
Method: dual-agent (A: general-purpose agent ae50c3fe · B: general-purpose agent ac7a21a3)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Good live feedback (occupancy dots, "Full (3)"), but no save-success confirmation and no aria-live on capacity changes |
| 2 | Match System / Real World | 4 | Real farm vocabulary throughout — named tents, "Linger booking," context-sensitive copy |
| 3 | User Control and Freedom | 2 | Escape/backdrop/X all silently wipe a filled form with zero confirmation — verified live |
| 4 | Consistency and Standards | 3 | Strong overall; Preferences field breaks its own "always-visible label" rule once opened |
| 5 | Error Prevention | 4 | The mobile-number conflict UI ("Same person — fix name?" / "Different guest") is genuinely excellent |
| 6 | Recognition Rather Than Recall | 4 | Persistent field captions, guest name-typeahead reusing past records |
| 7 | Flexibility and Efficiency | 2 | No shortcuts, no duplicate/bulk actions — every booking costs the same clicks as the first ever made |
| 8 | Aesthetic and Minimalist Design | 3 | Disciplined progressive disclosure; occupancy dots visually faint |
| 9 | Error Recovery | 3 | Inline validation is specific and immediate; generic fallback on unexpected errors is weak |
| 10 | Help and Documentation | 2 | No onboarding for an infrequent Linger user; documentation is inline-copy-only and inconsistently applied |
| **Total** | | **30/40** | **Good** |

## Design Specificity Verdict

**LLM assessment**: Clearly authored for TVC's actual operation, not generic CRUD — real tent names, a booking-type vocabulary that encodes real business relationships (Linger, member-stay, private retreat), and copy that changes meaning by context (the Label hint literally reads differently for a Tent closure vs. a stay).

**Deterministic scan**: detect.mjs returned a clean exit 0 with zero findings. Worth real caveats, not a clean bill of health — every substantive issue below (mobile overflow, touch-target sizing, discard-without-confirmation, missing focus trap) is a runtime/computed-style/behavioral problem, entirely outside what a static pattern-scanner can see.

## Overall Impression

Real craft in it — the mobile-number-disambiguation flow and the single-active-tent-expansion model are both the product of someone thinking hard about a real recurring problem. The single biggest opportunity: that care stops at the mobile viewport — two independent testing methods (direct visual+coordinate measurement, and a computed-style audit) each separately found real mobile defects. Convergent evidence, not one assessor's opinion.

## What's Working

1. **Mobile-number-conflict disambiguation** — "Same person — fix the name?" vs. "Different guest, same number" resolves a real farm-specific data problem with a human choice instead of a silent guess.
2. **Single-active-tent expansion** (activeTentId) — collapses every other guest-mode tent to a one-line summary while one is being filled in; a deliberate fix for a real "too cluttered" complaint.
3. **The collapsible-group legend keyboard pattern** — confirmed working by both assessments independently: tabindex=0, role="button", aria-expanded toggling correctly, both Enter and Space firing the handler, sane tab order.

## Priority Issues

**[P1] Mobile touch targets and layout are broken across the whole booking modal**
- Why it matters: At 390px width, six categories of control (group-legend pills, "+ Guest," remove-guest "✕," tent checkboxes, "Family Booking" checkbox, modal close button) all measure well under 44×44px (smallest: Family Booking checkbox at 116×16px). The site's global chat-widget bubble (z-index 100) also overlaps the second tent row's "+ Guest" button (z-index 90) by ~15px — a tap aimed at "+ Guest" can silently open marketing chat instead.
- Fix: Raise touch-target sizing to ~44×44px minimum at mobile widths; suppress the chat widget while the booking modal is open.
- Suggested command: /impeccable adapt

**[P1] No confirmation before discarding a filled-in form**
- Why it matters: Backdrop click, X, and Escape all call resetForm() unconditionally — verified live, Escape mid-entry instantly wipes the form. Punishes the fast, repeat-entry workflow the farm manager actually uses.
- Fix: Track dirty state and gate the three discard paths behind a "Discard changes?" confirmation only when dirty.
- Suggested command: /impeccable harden

**[P1] The Start date/Nights row overflows the modal by 18px at 390px width, with no visible scroll affordance**
- Why it matters: .card.booking-modal-panel has scrollWidth 406 vs clientWidth 388 — the Nights field is scrolled out of view by default, recoverable only via a scrollbar touch browsers hide. Someone on a phone could miss changing Nights and record the wrong stay length.
- Fix: Stack Start date/Nights into a single column below a mobile breakpoint.
- Suggested command: /impeccable adapt

**[P2] The modal has no focus management**
- Why it matters: document.activeElement stays <body> after opening the modal, no focus trap, background nav stays tabbable behind role="dialog" aria-modal="true".
- Fix: Focus the first field/heading on open, trap Tab/Shift+Tab, return focus to the triggering button on close.
- Suggested command: /impeccable harden

**[P2] "Family Booking" has no explanatory copy, unlike every sibling checkbox**
- Why it matters: "Exclusive use" and "Farm on Vacation" both carry an inline hint; "Family Booking" — which silently caps a tent at 1 recorded guest — doesn't.
- Fix: Add the same .hint-inline pattern already used elsewhere.
- Suggested command: /impeccable clarify

## Persona Red Flags

**Alex (impatient power user)**: Escape-wipes-everything is the sharpest risk. Chat-widget mobile overlap will read as "the app randomly opened chat" mid-task. No keyboard-submit shortcut or quick-duplicate path.

**Sam (keyboard/screen-reader dependent)**: The collapsible-group pattern passes on direct behavioral testing by both assessments. But the modal fails Sam at the door: no focus moves on open, nothing traps Tab. Guest cards' "Guest 1/2/3" numbering is CSS-counter-only with no backing aria-label.

## Minor Observations

- Color contrast is not a problem: white-on-#3d6e52 pill text and the #3d6e52 occupancy dots both measure 5.91:1, passing WCAG AA; dots carry correct aria-labels, correctly removed in closure mode.
- Zero console errors/warnings across the full interaction flow.
- No success toast after saving.
- Guest-row remove buttons are all identically labeled aria-label="Remove guest" with no guest number appended.

## Questions to Consider

- Does "Family Booking" need to be a checkbox at all — the code's own comment admits a booking that ends up with exactly 1 guest already fully captures the outcome?
- Does this internal, sign-in-gated admin tool need the public site's chat widget at all?
- What if Escape had two speeds — first press blurs any open native control, only a second press closes the modal?
