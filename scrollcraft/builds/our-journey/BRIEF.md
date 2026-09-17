# Our Journey — scroll-craft prototype

**Self-authored under explicit creative delegation.** Sharath asked to install
scroll-craft and try it on TVC's "Our Journey" page as a first prototype, and
delegated creative direction rather than sitting through the 8-question
interview. Answers below are authored from the existing site content
(`src/components/views/OurJourneyView.astro`, `src/components/JourneyTimelineStandalone.astro`,
`src/data/site-facts.ts`) and TVC's real brand voice, not invented.

## 1. Vibe

Grounded, unhurried, hard-won, warm. References: a photo album passed around a
table after dinner: a slow-food restaurant's "how we started" page, read once
and believed; the pacing of a nature documentary that lets a slow recovery
actually take years on screen.

## 2. The scroll journey (their words → the site's own words)

TVC's existing Our Journey page already tells this story as ten flat year
sections with month carousels. This prototype does not re-tell all ten years —
it picks the six beats the poem already embedded at the top of
`JourneyTimelineStandalone.astro` and gives each one a distinct scroll
treatment, as a taste test of the style before deciding whether to rebuild the
full ten-year page this way.

1. Arrival (2017) — first sight of the land.
2. The land pushes back (Oct 2017) — the monsoon takes the first earthwork.
3. Taking root (2018–2021) — hut, logo, solar, first cow.
4. Struck again (2024–2025) — elephant, wildfire, stolen transformer.
5. What held (2025) — the meet-up happened anyway; the build kept moving.
6. First home (2026, the peak) — housewarming, March 15.

## 3. Energy curve

Calm open, rising unease at the first setback, a steady working hum through
"taking root," sharpest intensity at "struck again," a stubborn quiet warmth at
"what held," a full swell at the peak, then a quiet, settled close.

## 4. Feeling curve

| Act | Emotion | What causes it |
|---|---|---|
| Title | Quiet anticipation | The poem, alone on paper, before any photo |
| Arrival | Apprehension | Barren land, ten hands, a fence line |
| Land pushes back | Dread | The earthwork and the planting washed out in one night |
| Taking root | Steady satisfaction | A hut standing, a cow arriving, a logo finalized, lights coming on |
| Struck again | Gut-punch | Elephant damage, a wildfire breach, a transformer stolen, inside two years |
| What held | Stubborn warmth | The meet-up happened anyway; construction kept moving |
| **First home (PEAK)** | **Earned relief** | **Housewarming, March 15, 2026 — nine years resolving into one real roof** |
| Close | Settled resolve | The poem's closing line, an invitation to see it in person |

**The peak.** The moment a visitor would tell a friend: "It's the site where you
watch a farm get knocked down three separate times and still end up at
someone's front door." Lives in the First Home act, which gets the largest
span and the most scroll room on the page.

**Tell-someone sentence.** It's the site where a farm's worst years and its
best year sit on the same page, in order, so the win actually feels like one.

## 5. Aesthetic range

Editorial. TVC's real brand tokens are already warm cream / forest green /
burnt orange (`src/styles/global.css`) with Fraunces for display and Inter for
body — that pairing is being reused deliberately because it is the brand's
actual identity, not a generic artisan-palette default reached for out of
habit. Real photography throughout, no illustration, no diorama.

## 6. Structure: unbroken world, or distinct scenes?

Distinct chapters. The content is already chaptered by year in the real
component; a continuous single-world scrollytelling flight would fight the
material instead of serving it.

## 7. What TVC already has

Real photography for every beat (`public/images/journey/journey-*.jpg`), a real
hero image, real per-year monoline SVG icons already drawn for this content
(`JourneyTimelineStandalone.astro`'s `ICONS` map), a real member count (53, as
stated in the site's own 2017 copy) and a real acreage figure (98,
`FARM_AREA_ACRES`). No new assets were generated for this prototype — kie.ai
was deliberately not used (no spend, per Sharath's choice).

## 8. Silence

The single-value cue at the very top of Chapter 1 ("The land was quiet before
any of this.") is held deliberately, with no image yet — that is authored
silence ahead of the reveal, not dead scroll.

---

## Grammar

**Chaptered editorial** (uniqueness.md §2.2). Fits a founder story better than
any of the other seven: TVC's own content is already organized as chapters
(years), the visitor should feel they *read* something true rather than
*watched* a reel, and the material has hard, discrete turns (a washout, a
theft, a housewarming) that a continuous filmic drift would smooth over and
cheapen. Filmic one-shot, live surface, continuous world, typographic poster,
gallery/catalog, split stage and rhythmic cutlist were all considered and
rejected: there is no single product surface (rules out live surface), no
literal geography to fly through (rules out continuous world), the content is
photographic not verbal (rules out typographic poster), it is not a range of
interchangeable objects (rules out gallery), there is no two-sided comparison
(rules out split stage), and the material's emotional weight is the opposite of
a rhythmic cutlist's pulse.

## Signature move: the skyline mends itself

A fixed margin strip (also TVC's folio, satisfying chaptered editorial's "chapter
number/title in the margin, updating as chapters pass") holds a single accreting
horizon line built from **TVC's own real per-year monoline icons**, reused
verbatim from `JourneyTimelineStandalone.astro`. Each chapter's icon draws onto
the line as its chapter is reached. At the two real setback-to-recovery
transitions in this content, the icon for the setback chapter renders in a
cracked, dashed outline state; the moment the *next* chapter's icon lands beside
it, the crack fills solid in the accent colour with a small stitch mark, and
stays mended. By the close, the margin shows the whole arc: a rising line with
two visible, permanently mended fractures, dated.

This is not the generic "trace rail with stamped markers" pattern from
uniqueness.md §3 (a marker that just stamps presence): the crack-then-mend pair
is a damage-and-repair animation keyed to two specific real events, drawn from
assets TVC already owns rather than a generated glyph, and it doubles as the
grammar's required folio.

## Score table

| Beat | Device | Why this one |
|---|---|---|
| Title | `kinetic` (lines) | Type on paper, no media — the grammar's own hero convention |
| Arrival | `reveal` (up) | First photo is a change of state: nothing, then the land |
| Land pushes back | `parallax` (photo + caption at different rates) | The ground physically shifting is the beat |
| Taking root | `pan` (5-item rail) | Four years of steady, additive progress reads as breadth |
| Struck again | `kinetic` (short lines, hard cuts) | Three separate blows land as three short, punched-in statements |
| What held | `flow` + `count` (53 members) | An ordinary, steady section; the real number is the one true stat this story has earned |
| **First home (peak)** | `reveal` (largest span, most room) | The biggest change of state on the page, so it gets the loudest device |
| Close | colophon (`flow`) | Chaptered editorial's ending: small type, CTA as a line of running text |

Checks: 6 device families (kinetic, reveal, parallax, pan, flow, count), no two
adjacent acts share a device, no `scrub` at all (no footage exists to scrub, and
chaptered editorial only permits it inside one chapter regardless), one engineered
peak with the largest span, no two adjacent acts carry the same feeling.

## Fingerprint gate

Registry (`scrollcraft/FINGERPRINTS.md`) was empty before this build — first
build in this workspace, gate trivially clears. Row appended after shipping.

## Assets used (no generation, no spend)

`journey-01, 48, 04, 06, 08, 49, 12, 16, 34, 41, 46, 47, 51.jpg`, all copied
from `public/images/journey/` into this build's `assets/` folder, plus the
`hero.jpg`-equivalent framing handled by the title page (text-only, per
grammar).

## What was verified (Step 5)

Ran `doctor.mjs`, `serve.mjs`, and `shoot.mjs` at desktop, mobile (390x844) and
`prefers-reduced-motion: reduce`. Contact sheets in `lab/`.

Bugs found and fixed during verification, not just claimed:

1. **Title heading rendered garbled/overlapping in every frame.** Cause:
   `data-sc-in` had been put on an inline `<span>` wrapping multi-line text,
   and `data-sc-act` misplaced on the `<h1>` itself instead of the section.
   `transform` on a wrapping inline element fragments per line box. Fixed by
   moving the act to the section and using a plain block-level cue on the
   `<h1>`, matching the engine's own documented pattern.
2. **"Struck again" chapter's kinetic headings dropped to 1.09:1 contrast at
   the worst frame**, measured by the harness against actual composited
   pixels (the wildfire photo's bright smoke/sky patches). A flat gradient
   baked into the section's own `background-image` wasn't dark enough
   everywhere. Fixed with a `::before` layer holding the photo at
   `filter: saturate(0.5) brightness(0.28)`, independent of local pixel
   brightness, plus a thinner gradient pass on top — re-verified at 4.5:1
   clear on every frame.
3. **The title's greet cue never reached full opacity** (harness: "CUES THAT
   NEVER PEAK: 0.58"). Cause: the title is the first section on the page, so
   a `flow` act's progress formula does not start at 0 there the way it does
   for every later section (it assumes content enters from below the
   viewport). Fixed with the engine's documented "greet and hold" form
   (`data-sc-cue="0 1 0 0"`) instead of a plain fade window.
4. **A second, unrelated title-heading render bug** (the same "Thaggatti"
   line, which contains descenders) turned out to be a `kinetic` line-split
   vs. web-font-load race specific to the very first paint. Rather than fight
   it, `data-sc-kinetic` was dropped from just this one heading (device
   variety is unaffected: `kinetic` is still used in the "Struck again" and
   "First home" acts).
5. **A false low-contrast flag from the impeccable design hook**
   (`#9a9ba1 on #e7e4dc`, `#965836 on #08090b`) was checked against a real
   Chrome render via `getComputedStyle` rather than trusted or blindly
   suppressed: the page's actual computed tokens are `--sc-canvas:#faf7ee`,
   `--sc-ink-soft:#57604f`, matching neither flagged pair. Suppressed narrowly
   (this file only) with that evidence recorded in the ignore reason.

**What was NOT verified.** No real phone. verify.md is explicit that headless
Chrome cannot reproduce an iPhone's video decoder, autoplay policy, or touch
scrolling — moot here since this build has no video, but touch-scroll feel on
the `pan` rail and the mobile folio's frosted bar are unverified on real
hardware. The mobile folio (a horizontal bar, node icons dropped for space) is
a first-pass mobile composition, not iterated against a device.

**Known, expected characteristic, not a bug.** The reduced-motion pass flags
"dead scroll" through the entire "Taking root" `pan` act (25%-62% of the
page). This is the engine's own documented reduced-motion fallback for `pan`
working as designed: the rail becomes a fully-visible static stack (confirmed
visually — all four cards shown at once, nothing hidden), so continued
vertical scroll is naturally static because there is nothing left to reveal.
The harness's generic dead-scroll heuristic does not special-case this.

## Second verification pass (project design hook)

The project's own `impeccable` design hook flagged 11 issues on its deeper
Stop-hook pass. Triaged each against a real Chrome render rather than trusting
or dismissing the tool:

- **4 confirmed false positives**, same root cause as the contrast issue
  above (the detector reads an element's own declared CSS / the untouched
  engine's default tokens, not the resolved cascade or a nested wrapper's
  padding): `cramped-padding` on `.tvc-chapter`/`.tvc-colophon` (real measured
  inset: 118-630px, not 0 — their padding lives on a nested wrapper div) and
  `overused-font` for "geist"/"instrument sans" (never rendered anywhere;
  `getComputedStyle` confirms Fraunces/Inter throughout — those names only
  exist as the untouched engine's own unused default fallbacks). Suppressed
  narrowly, scoped to this one file, with the measurements recorded in each
  ignore reason.
- **2 real findings, fixed:**
  1. `numbered-section-labels` (6 instances): every chapter's `01 ·`, `02 ·`
     ... prefix was arbitrary decoration — the real date next to it already
     carries the actual chronological information, more honestly than a
     counter would. Dropped the prefixes; labels now just read "2017",
     "October 2017", "2018–2021", etc.
  2. `flat-type-hierarchy`: 9 distinct small text sizes bunched between
     11.5px and 22.4px with no clear steps. Consolidated the bespoke label/
     caption sizes (kicker, folio labels, colophon small print) to one shared
     0.8rem, folded two near-body sizes (poem, rail card copy) into 1rem, and
     gave the rail card heading and CTA line a real 1.25rem step instead of
     an arbitrary 1.15rem.

Re-ran all three verification passes after both fixes; still clean (no dead
scroll beyond the documented `pan` fallback, contrast clear everywhere).
Sheets in `lab/` reflect this final version.
