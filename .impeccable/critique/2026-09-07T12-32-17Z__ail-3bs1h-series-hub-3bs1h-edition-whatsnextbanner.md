---
target: events pages (index, detail, 3bs1h series hub, 3bs1h edition, WhatsNextBanner)
total_score: 27
max_score: 36
na_heuristics: 7
p0_count: 0
p1_count: 2
timestamp: 2026-09-07T12-32-17Z
slug: ail-3bs1h-series-hub-3bs1h-edition-whatsnextbanner
---
Method: dual-agent (A: design review sub-agent · B: detector/browser-evidence sub-agent)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Filter chips update instantly, but filter controls sit below Upcoming — toggling changes content off-screen with no in-view confirmation |
| 2 | Match System/Real World | 4 | Plain language throughout; local terms used naturally |
| 3 | User Control and Freedom | 3 | "All" chip resets cleanly; grid/timeline toggle reversible |
| 4 | Consistency and Standards | 2 | Melagiri's CTA is a bare external Google Form; 3bs1h/Camping use the native BookingInquiry component — same page template, two different booking experiences |
| 5 | Error Prevention | 3 | Required fields, capped counts, "10+" correctly hides rather than showing garbage |
| 6 | Recognition Rather Than Recall | 4 | Text-labeled throughout; sticky sidebar keeps price/CTA in view |
| 7 | Flexibility and Efficiency | n/a | Booking/marketing surface, not a power-user tool |
| 8 | Aesthetic and Minimalist Design | 3 | Mostly clean; 14-chip ungrouped filter row, stray hashtag line on Melagiri, mobile photo-credit collision on 3bs1h hub |
| 9 | Error Recovery | 2 | Interest-widget's fetch failure is silently swallowed (catch(() => {})) — no visible error message |
| 10 | Help and Documentation | 3 | Site-wide AI chat + WhatsApp fallback both function as real help channels |
| **Total** | | **27/36** | **Good (75%)** |

## Design Specificity Verdict

**LLM assessment:** Authored, not generic — the 3Bs&1H sub-brand (icon row, cream/green ink variants, naming-origin story, "stack card" for repeat editions) couldn't be dropped onto an unrelated site. Slips toward generic at Melagiri's CTA, which punts to an anonymous, unbranded Google Form.

**Deterministic scan:** detect.mjs returns zero findings with project config (one prior false positive on a blockquote border is already correctly suppressed via .impeccable/config.json). The browser-injected scan found more — most are a single systemic false positive (hero text flagged "low-contrast" because the checker reads body's cream background instead of PageHero.astro's photo+scrim, which sits as a CSS sibling, not an ancestor — same root cause hits the homepage's glass stat-cards), plus a text-overflow false positive on the breadcrumb ellipsis. Real, DOM-confirmed findings: filter-group labels at 10.88px, the 3bs1h hub's photo-credit chip at 11.52px/3.8:1 contrast, the "Upcoming" edition badge at 2.5:1 contrast, recurring 3.7-4.4:1 contrast on event-card date/duration text, and a skipped heading level (h1->h3) inside WhatsNextBanner.

**Visual overlays:** Successfully injected and confirmed user-visible (screenshot showed live bounding-box overlays on /events), but the tab is now closed.

## Overall Impression

The bones are genuinely good and several prior-review gaps are now fixed — the sticky at-a-glance sidebar with live pricing total, grouped/labeled filter chips, and "Add to Calendar" now correctly sequenced after the booking CTA. What's left is narrower and more mechanical: one real content gap (no refund policy on the higher-stakes 3bs1h pages), one real inconsistency (Melagiri's CTA breaks the site's own booking-form convention), a filter panel that has the right data but doesn't surface it, and a handful of accessibility-grade contrast/heading issues.

## What's Working

1. The sticky sidebar + live pricing total directly answers the prior critique's "price is hidden" finding.
2. Filter chips are now grouped and labeled, with live "Filtered to 'X'" text syncing both lists — a real fix over the previous flat 15+-chip wall.
3. The 3Bs&1H "stack card" folding repeat editions into one series link is a specific, considered IA decision.

## Priority Issues

**[P1] No cancellation/refund policy on 3Bs&1H edition pages**
Why it matters: A visitor committing Rs 3,200-3,500/person to an overnight, third-party-hosted (Linger) stay has to ask on WhatsApp to learn cancellation terms; Melagiri (lower stakes, single day) states its policy plainly.
Fix: add a short policy line to the sidebar/CTA area, sourced from Linger.

**[P1] Melagiri's booking CTA breaks the site's own convergence pattern**
Why it matters: same EventDetailView.astro renders two different booking experiences: 3bs1h/Camping use native BookingInquiry (tiers, live total, in-brand), Melagiri punts to an anonymous external Google Form.
Fix: migrate Melagiri onto BookingInquiry with its own packageOptions.

**[P2] Filter panel: 14 ungrouped chips, no visible prioritization, undersized labels**
Why it matters: chips are already sorted most-used-first server-side, but that signal never reaches the user; "Filter by type"/"Length" labels render at 10.88px.
Fix: show match counts or fold long-tail tags under "More"; bump label size.

**[P2] Filtering the events index gives no in-viewport feedback**
Why it matters: filter controls sit below Upcoming, so toggling changes content above the user's scroll position.
Fix: move filters above Upcoming or add a scroll/highlight cue.

**[P2] Recurring contrast failures on event cards**
Why it matters: date text (3.7:1), duration tag (4.4:1), and the 3bs1h "Upcoming" edition badge (2.5:1, white-on-orange) all fail WCAG AA's 4.5:1.
Fix: darken text or lighten backgrounds on these three recurring elements.

**[P2] 3Bs&1H hub photo-credit chip is undersized, low-contrast, and collides with hero text on mobile**
Why it matters: 11.52px at 3.8:1 contrast, and wraps into the hero intro at ~390px width.
Fix: increase size/contrast, constrain width or reflow under the photo at narrow breakpoints.

**[P3] Interest-widget silently swallows fetch failures**
Why it matters: catch(() => {}) means a failed submit just re-enables the button with no visible error.
Fix: show an inline error message on failure.

**[P3] WhatsNextBanner skips a heading level (h1->h3 inside .whats-next__text)**
Why it matters: semantic/accessibility gap.
Fix: correct the heading hierarchy.

**[P3] Melagiri event page shows a stray raw hashtag line as visible body copy**
Why it matters: "#Melagiri #Permaculture #FarmToTable #LocalNarratives" reads as a leftover social-caption artifact right below the CTA.
Fix: strip the trailing hashtag line from the Melagiri markdown body.

## Persona Red Flags

**Jordan (first-timer):** hits the 14-chip filter wall with no prioritization cue; on 3bs1h sees no refund info before "Request to book"; on Melagiri gets bounced to an unbranded Google Form.

**Casey (mobile):** the sticky sidebar genuinely helps, but the fixed AI-chat FAB crowds the same thumb-zone corner as WhatsApp and "Send booking request" — three chat-shaped affordances competing right at the decision moment.

**Riley (stress tester):** "10+" adults correctly hides the total rather than showing garbage (a pass); the interest-widget's silent catch is a real gap under a flaky connection.

## Minor Observations

- Melagiri's cover image is an explicit placeholder, visibly weaker than 3bs1h's real photo on the same Upcoming list.
- CampingView's free-text dates vs. 3bs1h's fixed hidden date field is correct, deliberate use of BookingInquiry's fixedDates prop — not an issue.
- Advisory-tier detector flags (cream-palette, overused-font, kicker-above-heading, em-dash overuse, line-length) are the same category already whitelisted elsewhere in the repo as deliberate brand choices — not filed as issues.
