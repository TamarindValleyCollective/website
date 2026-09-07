---
target: events pages (hub + detail)
total_score: 28
max_score: 36
na_heuristics: 10
p0_count: 0
p1_count: 2
timestamp: 2026-09-07T10-46-14Z
slug: events-pages-hub-detail
---
Method: dual-agent (A: design-review sub-agent · B: detector/browser-evidence sub-agent)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Live "estimated total" updates instantly and hides for indeterminate "10+" — but the booking form itself has no "sending…" state on submit |
| 2 | Match System / Real World | 4 | Farm-native vocabulary ("Request to book," Kannada terms used unglossed) throughout |
| 3 | User Control and Freedom | 3 | Filter chips toggle off, view toggle works; no explicit "clear filters" on `/events` |
| 4 | Consistency and Standards | 3 | Button styling consistent site-wide, but the form CTA (filled `.button`) and WhatsApp CTA (plain text link) now carry very different visual weight for two paths the copy calls equal |
| 5 | Error Prevention | 3 | HTML5 required fields, honeypot, capped counters; no inline validation beyond native browser tooltips |
| 6 | Recognition Rather Than Recall | 4 | Sticky "at a glance" sidebar keeps price/date visible through the whole scroll — genuine strength |
| 7 | Flexibility and Efficiency | 3 | `autocomplete` attributes present, sensible dropdown caps — scored (not n/a) since form-completion is a real task here |
| 8 | Aesthetic and Minimalist Design | 3 | Clean per-section, but accommodation + facilities galleries add real scroll distance between decision and form |
| 9 | Error Recovery | 2 | The past-event "I'm interested" widget has try/catch + button re-enable; the booking form (higher stakes) has no failure path at all |
| 10 | Help and Documentation | n/a | Persuade-mode surface; WhatsApp effectively is the help channel, which matters for the CTA finding below |
| **Total** | | **28/36** | **Good (77.8%)** |

## Design Specificity Verdict

**Design review**: This reads as genuinely authored for TVC, not a templated events page with a farm skin. Kannada terms appear unglossed ("majjige"), the 3Bs&1H sub-brand carries its own creature-icon hero treatment, and the site deliberately avoids "Book Now" in favor of "Request to book"/"Send booking request" because fulfillment really is human-mediated through the hospitality partner Linger. Code comments trace design decisions to real usability findings (the "at a glance" sidebar exists because "the price is a repeat/almost hidden" was flagged in a prior session) — evidence-based, not decorative.

**Deterministic scan**: The CLI detector (`detect.mjs`) returns a clean `[]` against `EventsIndexView.astro`, `EventDetailView.astro`, and `BookingInquiry.astro` because `.impeccable/config.json` already documents and suppresses the site's deliberate choices (Fraunces/Inter pairing, the cream palette, a blockquote `side-tab` convention). Re-running with `--no-config` surfaces exactly one finding — that same `side-tab` rule on `EventDetailView.astro:512`, already explained in-repo as a markdown-blockquote pattern, not an AI-card tell. The browser-injected scan (which can't see that config) flags more: 15 anti-patterns on `/events` and 5 on the 3Bs&1H edition-6 detail page — low-contrast (4×/3×), undersized UI text (10.88px on "Filter by type"/"Length" labels, below the 11px floor), tight leading, a thin-border-plus-wide-shadow card pattern, `overused-font`, and `kicker-above-heading`. Cross-referenced against the config and the design review: `overused-font`/`cream-palette`/`kicker-above-heading` are documented, intentional brand choices (the eyebrow-above-heading pattern — "VISIT US" over a page title — is used consistently site-wide, not a one-off AI tell), so treat those three as false positives. The `low-contrast` hits land on hero headline/kicker text set over a photographic hero image; the detector likely measured against the page's flat background color rather than the actual photo pixels beneath the text — plausible but worth a manual contrast check rather than taking at face value. The `undersized-ui-text` finding, though, lines up with the design review's independent finding of un-grouped filter chips on `/events` — two different methods converging on the same real problem area (see Priority Issues below).

## Overall Impression

The bones are good and the voice is real — this doesn't feel like a stock events template. The main gap is a mismatch between what the copy promises and what the layout delivers: the booking note tells visitors the form and WhatsApp are equal paths, but the current layout (including the change just shipped this session, moving the WhatsApp CTA below the form) gives one a filled button and the other a small, plain-text line that's also short of the 44px touch-target floor on mobile. That's the single biggest opportunity — not a redesign, a rebalancing.

## What's Working

- **Sticky "at a glance" sidebar**: solves a documented real problem (price previously buried mid-scroll) using data the page already has, not a new asset — traceable, evidence-based design, and it's the strongest single element on the detail page.
- **Honest CTA language**: "Request to book"/"Send booking request" instead of "Book Now" matches the actual human-fulfilled booking model rather than implying instant checkout.
- **Brand voice sustained into edge cases**: even the 404 page keeps the farm's voice ("a goat probably knocked the trail marker loose"), which is a level of consistency most sites skip.

## Priority Issues

**[P1] WhatsApp CTA is now visually unequal to the form, despite copy that frames them as equal paths**
- *Why it matters*: The note above the booking form says "send your details to Linger by form or WhatsApp" — presenting two paths as interchangeable. But the form gets a filled `.button` and the WhatsApp CTA is a plain-text `.whatsapp-cta__link` line below it. A WhatsApp-first visitor (plausible for this market) scanning for a chat affordance can plausibly miss it, especially since this session's own change removed the bordered card that used to give it presence.
- *Fix*: Give `.whatsapp-cta__link` `.button--outline` styling for visual parity with the form's submit button, without reverting to the old two-column boxed layout — keep the below-form placement, just raise its weight to match its stated importance.
- *Suggested command*: `/impeccable layout`

**[P1] WhatsApp link fails the mobile touch-target floor and drops context for screen readers**
- *Why it matters*: `.whatsapp-cta__link` wraps only the icon + "Message us" — roughly 20px tall, well under the 44×44px minimum, and it excludes the leading "Prefer to talk first?" text. A screen reader navigating by link list announces only "Message us, link" with no context about what happens next.
- *Fix*: Pad the anchor (or wrap the full sentence including "Prefer to talk first?" inside the `<a>`, or add an `aria-label`) so both touch target and accessible name are complete.
- *Suggested command*: `/impeccable audit`

**[P2] Booking form has no submit/error state**
- *Why it matters*: `BookingInquiry.astro`'s form is a raw Netlify POST with no client-side feedback on submit — no "Sending…" state, no failure path if the request fails. This is the highest-stakes interaction on the page (heuristic 9 scored a 2 specifically because of this), and the codebase already has the pattern to fix it: `EventDetailView.astro`'s past-event "I'm interested" widget has a working try/catch + button re-enable it could mirror.
- *Fix*: Add a pending/disabled submit state and a visible failure message, reusing the existing interest-widget script pattern rather than inventing a new one.
- *Suggested command*: `/impeccable harden`

**[P2] Events hub filter chips: ungrouped and undersized**
- *Why it matters*: Two independent methods flagged the same area — the design review counted 12 content-tag chips in one unbroken row on `/events` with no secondary grouping (fails the ≤4-per-group chunking check), and the detector separately measured "Filter by type"/"Length" labels at 10.88px, under the 11px accessibility floor.
- *Fix*: Group chips (e.g. by category, or most-used-first with an overflow "more" control) and bump the undersized labels to at least 11px.
- *Suggested command*: `/impeccable layout`

**[P3] Long scroll distance between the booking decision and the form**
- *Why it matters*: Accommodation and facilities photo galleries sit between the schedule/pricing section and the booking form. The sidebar's "Request to book ↓" anchor mitigates this for visitors who click it, but not for someone scrolling manually who's already decided and now has to scroll past two galleries to act.
- *Fix*: Consider a secondary, lighter-weight CTA at the end of the galleries section for visitors who've already made up their mind, or tighten the gallery-to-form distance.
- *Suggested command*: `/impeccable layout`

## Persona Red Flags

**Casey (Distracted Mobile)**: The undersized "Message us" tap target (~20px) is exactly the failure mode this persona hits hardest — a thumb-tap on the smallest, plainest element on the page, on a one-handed connection that may already be shaky.

**Sam (Accessibility-Dependent)**: "Prefer to talk first?" isn't inside the `<a>`, so a screen-reader user navigating by link list hears only "Message us, link" — no context for what pressing it does or why they'd choose it over the form above.

**Jordan (Confused First-Timer)**: The 3Bs&1H edition hero shows the bare acronym "3Bs&1H — Edition 6" with four unlabeled creature icons; the actual expansion (Birds, Butterflies, Bees & Herps) only appears after scrolling past the hero, leaving a first-time visitor without the context for several seconds.

## Minor Observations

- `.button` text uses `--tvc-ink` (dark) on `--tvc-orange-cta` rather than white — a deliberate, already-correct fix for a contrast fail that would otherwise exist; good prior accessibility care worth preserving as a pattern.
- "Tap a photo to enlarge" is a small, easy-to-miss but well-placed micro-copy pattern on the accommodation gallery.
- The 3Bs&1H series routes at `/events/3bs1h/<edition>`, not `/events/<slug>` — a dev-testing footgun only (the site itself links correctly), not a live bug.
- `.card` (1px border + `--shadow-soft`, reused by the booking form, the "at a glance" sidebar, and gallery cards) is what the browser detector's `gpt-thin-border-wide-shadow` rule fired on; the measured value doesn't literally match "40px blur" anywhere in the codebase (the real value is 18px), so this is likely a detector overstatement rather than a real "AI slop" tell — but it's worth a deliberate look since the pattern is reused this widely.

## Questions to Consider

1. If the form and WhatsApp are genuinely equal paths, why does only one get a button?
2. Was the change from a boxed WhatsApp card to a plain line (shipped this session) driven by any usage signal, or a visual-taste call made without data?
3. Should the sidebar's "Request to book ↓" jump to a choice between form and WhatsApp, given the note above the form already frames it as one?
