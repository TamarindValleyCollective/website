---
target: TVC events pages (detail, index, 3bs1h hub, homepage banner)
total_score: 21
max_score: 32
na_heuristics: 7,10
p0_count: 2
p1_count: 1
timestamp: 2026-09-06T02-18-12Z
slug: src-components-views-eventdetailview-astro
---
Method: dual-agent (A: design review sub-agent · B: detector/browser-evidence sub-agent)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | Booking form and interest-form give no visible pending/success/error state on submit |
| 2 | Match System / Real World | 3 | Correct farm-specific language throughout; "Add to calendar" on a not-yet-booked event is a slightly odd first action |
| 3 | User Control and Freedom | 3 | Filters/view toggles are reversible; no "clear all filters" when two chip groups are active together |
| 4 | Consistency and Standards | 2 | Melagiri's CTA is a headed, bounded `.cta.card` with a price recap; 3Bs&1H's new CTA is a bare, unheaded form — two idioms for the same "book via partner" job |
| 5 | Error Prevention | 3 | Honeypot present; no double-submit guard on the new booking form (unlike the interest-widget, which disables its button) |
| 6 | Recognition Rather Than Recall | 3 | Tags/dates/countdowns are visible in-context on `/events`; the booking form at the bottom of the detail page doesn't restate the date or price tier a visitor read 2 screens up |
| 7 | Flexibility and Efficiency | n/a | Low-frequency, near-one-time-visit surface — power-user accelerators don't meaningfully apply |
| 8 | Aesthetic and Minimalist Design | 3 | Clean single-column pages; the past-event "interest widget" carries more visual weight than its "nice-to-have" role warrants |
| 9 | Error Recovery | 2 | Interest-form's fetch failure path leaves the form silently as-is with no visible error message |
| 10 | Help and Documentation | n/a | Appropriate to skip for a marketing/booking flow |
| **Total** | | **21/32** | **Acceptable (66%)** |

## Design Specificity Verdict

**LLM assessment:** Mostly authored for TVC, not generic. The 3Bs&1H sub-brand (cream reversed wordmark chosen specifically for contrast against the hero photo scrim, the four-creature icon row, "Linger" named as hospitality partner, majjige/tamarind-juice arrival detail, Ram Bhetta trek, iNaturalist citizen-science callout) couldn't be reskinned for another org without real rework. The events-index countdown treatment and the 3bs1h hub's "stack completed editions into one card" logic both show real domain thought, not template defaults. Where it slips into generic-events-page territory: "Add to calendar" is boilerplate identical to any Eventbrite/Meetup listing, and the newly-added booking CTA — while functionally routed to Linger — is visually the same undifferentiated `BookingInquiry` card used verbatim on `CampingView.astro`, resetting to "default TVC form" right after a page that spent a full viewport building sub-brand identity.

**Deterministic scan:** The static CLI scan (`detect.mjs`) returned **zero findings** across all four target files — no structural anti-patterns at the source level. The browser-injected scan (which sees computed styles/contrast against the live DOM) found several warnings, but most are either sitewide, deliberate conventions rather than defects, or false positives:
- **False positive, confirmed by inspection:** "low-contrast" flags on the hero `h1`/eyebrow (e.g. "1.1:1 — text #ffffff on #faf7ee") on all three hero pages. The detector is reading the *page's* cream background color, not the actual rendered stack — `PageHero.astro` deliberately layers a dark gradient scrim over the photo specifically so this white text stays legible (there's already a code comment about choosing the cream/reversed 3bs1h mark for the same reason). My own earlier screenshots confirm the text reads clearly in practice. Not a real issue.
- **Likely intentional, not a defect:** `cream-palette`, `overused-font` (Inter, 88-100% of text), and `kicker-above-heading`, all flagged sitewide on `body` — these describe the site's actual, consistent design system, not an accident.
- **Real, minor:** `undersized-ui-text` on `/events`' two filter-group labels, `tiny-text` on the 3bs1h hub's photo-credit chip, and `all-caps-body` on the eyebrow labels — small type-scale nits worth a pass but not urgent.
- **Confirmed clean:** `WhatsNextBanner.astro` (the homepage banner) had zero findings in both the static scan and a targeted in-browser check scoped to just its markup.

**Visual overlays:** Both sub-agents successfully injected the live detector into the browser and read back console output, but their tabs have since been closed (each sub-agent cleans up after itself) — there's no overlay left open for you to look at right now. If useful, this can be re-run standalone later.

## Overall Impression

The bones are good — this is a site with a genuinely distinct sub-brand and some thoughtful information-architecture calls (edition-stacking, countdown-first upcoming cards). The gap is that the page doesn't resolve into a confident close: it spends a full viewport building "this is special, only 20 people" energy, then ends on a bare, unbranded form that could belong to any farm-stay site. The single biggest opportunity is treating the *end* of the event page — not just the hero — as part of the sub-brand experience, since that's where money/contact info actually changes hands.

## What's Working

1. **The 3Bs&1H sub-brand identity is real craft, not decoration.** The cream (reversed) mark was deliberately chosen over the green ink specifically because green loses contrast on the hero photo scrim — that's a judgment call, documented in the code, that most template-driven sites never make.
2. **The events-index "Upcoming" treatment correctly answers the user's actual question.** Large countdown numerals ("27 days to go") organize the page by "can I still make this," which is the real decision a visitor is making — this is deliberate, not a template default. (The sort-order bug that had this ranked wrong — a Nov event shown above an Oct one — is fixed as of this session; confirmed the corrected `upcoming` array also feeds the homepage banner and the page's own schema.org `ItemList` correctly.)
3. **The 3bs1h hub's edition-stacking avoids a common events-page failure mode.** Folding 4+ near-identical past editions into one "stack" card (rather than cluttering the past-events grid with duplicates) is a real, reasoned trade-off — the code comments show it was a deliberate call, and it's paying off visually.

## Priority Issues

**[P0] Booking CTA has no heading, no price recap, and no tier selector, despite two priced tiers existing**
*Why it matters:* A visitor who just scrolled through two days of schedule to reach the form has to recall, unaided, which of the two tiers applies (deck-based/bamboo hut ₹3,500 vs campground/DIY ₹3,200) — there's no field to record that choice at all. `CampingView.astro`'s own booking form solves exactly this with a `packageOptions` dropdown; the 3bs1h wiring just doesn't pass it.
*Fix:* Wrap the CTA in a heading ("Book your spot") + one-line price recap, and pass `packageOptions` with the two tiers so the choice is captured, not left to a free-text field.
*Suggested command:* `/impeccable layout`

**[P0] "Add to Calendar" and the booking CTA bookend the page with no relationship to each other**
*Why it matters:* These are the only two actionable elements on the page, and they sit at opposite ends — calendar at the very top (before any content), booking form at the very bottom (after all of it). Calendaring an event you haven't committed to attending is an odd thing to lead with, and right now it reads as the page's primary CTA by virtue of position alone.
*Fix:* Either (a) demote Add-to-Calendar to a secondary, text-link-style action and offer it prominently only *after* a successful booking, or (b) keep it at the top but visually subordinate it, and add a "Book your spot ↓" anchor near it that jumps straight to the real CTA.
*Suggested command:* `/impeccable layout`

**[P1] Events-index filter panel exposes 15+ ungrouped tag chips at once**
*Why it matters:* A first-time visitor deciding "is anything upcoming relevant to me" is shown the same amount of decision surface as someone trying to browse nine years of past events — the two Upcoming cards above the fold already answer the more common question, but the filter panel competes for attention as if it's equally urgent. Confirmed visually: all content tags + 3 duration chips render with equal visual weight, no grouping or counts.
*Fix:* Sort chips by frequency (most-used first) or visually de-emphasize the filter panel relative to the Upcoming section, so it reads as "explore the archive" rather than "decide what to do next."
*Suggested command:* `/impeccable distill`

**[P2] Homepage banner shows exactly one upcoming event; you asked to show multiple**
*Why it matters:* `WhatsNextBanner.astro` is deliberately a thin, glanceable strip — its actual strength is that it doesn't compete with the homepage's real fork ("Explore, or engage") directly below it. Converting it to a card row would out-compete that section for a homepage visitor who hasn't opted into "tell me about events" yet; `/events` already has a well-built multi-event "Upcoming" section, so duplicating that pattern at homepage scale is redundant.
*Fix direction:* Keep it a strip, but let it cycle through the next 2-3 events (carousel dots or a lightweight "+2 more" affordance) instead of converting to a grid — preserves the low-commitment, glanceable quality while surfacing that more than one thing is coming up.
*Suggested command:* `/impeccable shape`

**[P3] No cancellation/refund terms on 3Bs&1H pages, unlike its sibling Melagiri event**
*Why it matters:* Melagiri explicitly states refund/transfer terms; neither 3bs1h edition does, even though money changes hands (₹3,200–3,500/person) and the single-gender tent-sharing policy is spelled out in detail elsewhere on the same page. Silence here, right before asking for contact info, reads as a small trust gap relative to its own sibling page.
*Fix:* Add one sentence mirroring Melagiri's pattern, sourced from Linger's actual policy.
*Suggested command:* `/impeccable clarify`

## Persona Red Flags

**Jordan (confused first-timer):** Lands on the edition page from a shared link with zero context for what "3Bs&1H" means. The hub page's explanatory eyebrow ("TVC's recurring biodiversity walk") never appears on the edition page itself — Jordan sees a tiny "PART OF 3BS&1H →" caps link and has to read into the body paragraph to learn the acronym expands to Birds, Butterflies, Bees & Herps, even though four icons representing exactly that sit right in the hero.

**Casey (distracted mobile user):** Skims to the bottom hoping for a one-tap "book now," and instead meets a 6-field form (name, email, phone, people, dates, message) requiring real typing before any commitment signal. The past-event "interest" widget asks for just one optional field — the jump in friction from "low-effort interest" to "high-effort booking" is steep exactly where a mobile, time-pressed visitor has the least patience.

## Minor Observations

- The booking form's "Preferred dates" field is free text — but a 3bs1h edition has exactly one fixed date, already shown in the hero. This field is a straight carry-over from `CampingView.astro`'s flexible-dates use case and doesn't make sense here; worth either hiding it for fixed-date events or repurposing it (e.g. "which tier?" note).
- Detector-confirmed, low-priority type-scale nits: `/events`' two "Filter by …" labels render undersized; the 3bs1h hub's photo-credit chip ("Indian Silverbills at TVC, photographed by...") is flagged as tiny-text; eyebrow labels are all-caps at a size where that can read as shouting at small sizes.
- The interest-widget's count area has no loading state while its `fetch()` resolves — briefly blank on a slow connection.
- The 3bs1h hub's explicit "used with permission, iNaturalist" photo credit is a nice, uncommon bit of rights diligence worth preserving as a pattern for future photo use (including the new edition-6 ant-nest photo, whose license/reuse permission is still unconfirmed — see earlier note).

## Provocative Questions

1. If Add-to-Calendar gets demoted until after booking, is there any reason for it to exist on an *unbooked* event at all — or was it more of a "we had the code, so we shipped it" addition?
2. Is there a single shared source of truth for "what's the next bookable thing," now that the homepage banner, the events-index Upcoming section, and the new booking CTA all independently compute it — or are these three surfaces one future edit away from drifting out of sync?
