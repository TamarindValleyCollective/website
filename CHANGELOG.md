# Change Log

> **Keep this file up to date.** Whenever a change discussed here is committed and pushed to
> `main`, add an entry in the same change: date/time, who requested it, what was asked, and
> what was actually changed (with the commit hash(es)). Newest entries go at the top. See the
> note in `AGENTS.md`.
>
> Scope: this log tracks changes requested through and implemented by the AI assistant. It is
> not a full replacement for `git log` — teammates' own commits made outside that workflow
> aren't itemized here.

---

### 2026-07-19 — Give every page a photo hero, matching Our Journey's style; fix the Biodiversity picture
**Requested by:** Sharath Jeppu

**Ask:** "The picture in teh hero banner looks nice on the Our Journey page. Can this be made
consistant across all the other pages. Also, choose a better picture for biodiversity. The
poster does not render well in a landscape orientation."

**Change:** `PageHero` has always supported two variants: a photo hero (image + scrim + white
title text, as used on Our Journey) and a flat "plain" hero with no photo. 13 pages were still on
the plain variant — `about`, `contact` and `contact/thanks`, `ecosystem`, `ecosystem/geography`,
`ecosystem/partners`, `events`, `in-pictures`, `join`, `resource-centre`, `visit`,
`visit/camping`, `visit/day-visit`, and `our-journey/community-outreach`. Gave each a photo,
reusing the image the homepage already associates with that destination wherever one existed
(e.g. `visit/camping` now uses the same sunflower photo its homepage "Spend the night" card links
through to), so the teaser and the landing page always agree — the same pattern Our Journey
itself already followed. Also set each page's `BaseLayout` `image`/`imageWidth`/`imageHeight` to
match, improving social-sharing previews along the way.

The old Biodiversity hero source was `events/2024-12-21-3bs-and-1h-biodiversity-walk/hero.jpg` —
a portrait (1080×1375) event poster with its title, schedule, and pricing baked into the image as
text. Cropped into a wide landscape banner via `object-fit: cover`, most of that text was lost.
Replaced it with a real landscape photo (1384×1038) of a forest watering hole, and updated the
homepage's Biodiversity thumbnail to match.

**Commits:** `a9d3a14`

---

### 2026-07-19 — Nest Timeline, Community Outreach, and Design under Our Journey; fix duplicate content across pages
**Requested by:** Sharath Jeppu

**Ask:** Across three follow-up messages: "The Our Journey and Timeline can be collapsed into one
section under journey instead of having a separate section for timeline"; "The community outreach
section can also be collapsed into this instead appearing seperate. Also, remove the section of
what the future holds"; and "There are duplicate content in different sections. for example,
resource centre and our journey both lead to the community outreach section. Can you identify
such inconsistencies and fix them?"

**Change:** Timeline and Community Outreach were separate top-level Explore nav items and
homepage cards despite being entirely children of Our Journey — and unlike their sibling
`/our-journey/design`, neither was even nested in its URL. Moved both to `/our-journey/timeline`
and `/our-journey/community-outreach`, delisted them from the top-level Explore nav dropdown and
the homepage's Explore grid (each is still reachable via its card on the Journey page itself), and
added redirects from the old `/timeline` and `/community-outreach` URLs (including individual
outreach post slugs). Removed the empty "What the future holds" `Pending` stub from the Journey
page. Extended the same de-listing to "The Design," found to have the identical problem.

A follow-up audit for duplicate/miscategorized content (prompted by noticing Resource Centre and
Our Journey both linking to Community Outreach) found: Resource Centre was fully re-listing every
Community Outreach post as its own card grid instead of linking to the now-canonical listing page
— replaced with a one-line teaser and link. `visit.astro`'s "What to expect" section carried a
near-verbatim copy of the land-layout paragraph that's the whole point of `/our-journey/design` —
shortened to a link. The homepage and About page each hardcoded the same "Core principles" list
independently, risking drift — extracted both into `src/data/principles.ts` so they render from
one source, and added a link from the homepage section to `/about` for the fuller treatment.

Also found and flagged (not fixed, pending a decision): an orphaned `/ecosystem/products/[slug]`
route left over from an earlier "drop Produce" cleanup — its `products` content collection has no
files and nothing links to it.

**Commits:** `a72cf77`

---

### 2026-07-18 — Add a custom 404 page
**Requested by:** Rajesh Thiagarajan

**Ask:** "for the website we do not have a good 404 page. Please design a 404 page that is a bit
humorous (something like lost in the wilderness of the farm)."

**Change:** Added `src/pages/404.astro` — a wooden trail-signpost illustration (inline SVG, hand
built from the brand's green/orange/wood palette) with one arm pointing back to the farmhouse and
one to the trails, a bird perched on top, and a "404" tag dangling loose off a nail with a gentle
swing (respects `prefers-reduced-motion`). Copy leans into the farm/wilderness voice ("You've
wandered off the map," a goat-knocked-the-trail-marker joke) with CTAs back to `/` and
`/visit/trekking-trails`. Added an opt-in `noindex` prop to `BaseLayout.astro` so crawlers don't
index the dead end. Astro emits this as `dist/404.html` at the build root, which Netlify serves
automatically as the site's custom error page — verified locally that unmatched routes return a
404 status and that the production build produces the file in the right place.

**Commits:** `e446234`

---

### 2026-07-18 — Remove the Trees & Plants stub, move Geography & Weather to its own page
**Requested by:** Sharath Jeppu

**Ask:** "In the ecosystem page, delete the section on Trees & Plants since it is already covered
in the inaturalist integration. Also move the geography, landscape and weather into a new page.
This page will get more subsections later."

**Change:** Removed the "Trees & Plants" section from `/ecosystem` — it was an unfilled `Pending`
placeholder, and the content it was meant to cover (plants, trees) is already live in the
iNaturalist-backed biodiversity explorer above it. Moved "Geography, landscape & weather" (the
intro text, the monsoon-to-date stat tile, the monthly rainfall chart, and the full rainfall
table) to a new page at `/ecosystem/geography` — a new landing point for a section that's
expected to grow further subsections over time, rather than staying a subsection wedged into the
biodiversity page. `/ecosystem` now links out to it via a teaser card. Added the new page to the
shared Explore nav dropdown and site-map data, so it shows up in the nav and gets a correct
"Home / Explore / Geography & Weather" breadcrumb automatically. Fixed a bug caught along the
way: HTML entities like `&amp;` render correctly in plain template text but leak through
literally when passed via a component prop (e.g. `title="Geography &amp; Weather"`) — component
props need a literal `&` since Astro escapes those safely on its own.

**Commits:** `177051a`

---

### 2026-07-18 — Bigger overlapping timeline photo cards, a click-to-detail lightbox, and a smooth carousel
**Requested by:** Sharath Jeppu

**Ask:** "The picture tiles on the timeline page are too small especially on a large screen. Can
they be larger and the horizantal scroll be a carousal of overlapping pictures. The user should
also be able to click on a picture to see details and then exit easily." Followed by three rounds
of refinement: "The animation between the transition of overlapped pictures when is not smooth.
Can this be fixed?" and "One small change. For tiles that don't have a picture, have the text
rendered instead in the middle of the box."

**Change:** Reworked the per-year month carousel on `/timeline`. Cards grew from a fixed 300×260px
to a fluid `clamp(260px, 42vw, 620px)` × `clamp(220px, 30vw, 440px)`, so they scale up
meaningfully on large screens instead of capping out small. Cards now overlap via negative
margin into a fanned stack, with the focused card scaling up and brightening (and its neighbors
receding) as you scroll — tracked live every animation frame rather than only after scrolling
stops, so the effect sweeps continuously instead of popping in late. Clicking any photo opens a
new shared lightbox (full-size image, complete caption, prev/next through that year's photos,
closable via an X button, clicking outside, or Escape, with focus returned to the card on close);
on-card captions are now truncated to a teaser (3 lines) since the full text lives in the
lightbox. Cards with no photo for a month get centered text instead of a caption pinned to the
bottom, since there's no image to anchor it to.

Along the way, found that the arrow-button navigation was jumping instantly with no animation at
all — native `scrollTo({behavior:'smooth'})` was silently not animating on this track (not just
"getting fought" by `scroll-snap-type:mandatory` as previously assumed; verified it does nothing
even with snap disabled first). Replaced it with a hand-rolled `requestAnimationFrame` tween that
eases the scroll position directly, which can't be silently dropped, and which respects
`prefers-reduced-motion`. Verified on desktop and mobile — card sizing, the overlapping/fanning
motion, lightbox open/close/prev/next including on a no-photo-adjacent card, keyboard
(Enter/Space to open, arrows to navigate, Escape to close), and touch swipe not misfiring the
lightbox open.

**Commits:** `518ebdb`

---

### 2026-07-18 — Restructure the main nav into Explore/Engage, add breadcrumbs everywhere
**Requested by:** Sharath Jeppu

**Ask:** "Can the main nav be restructured based on how the website is now structred? I tend to
hit the brower back button after navigating to a page. It would be good to always have a website
map to navigate in and out of pages. Propose a solution to solve this" — a proposal was floated
(restructure the nav dropdowns to mirror Explore/Engage, add breadcrumbs to every page, and
expand the footer into a full sitemap), then "Build all three," followed by feedback after
seeing the built footer: "The footer is too big. Not really a fan. Is there a reason why it
makes sense to have all the pages listed in the footer?" — resolved by trimming the footer back
to just brand/blurb/social/copyright, since the nav dropdowns already list every page and don't
need a second copy of the same list.

**Change:** Added `src/data/site-map.ts` as a single source of truth for the site's Explore/
Engage link groups and path-prefix classification, so the nav, breadcrumbs, and any future
consumer can't drift out of sync with each other or with the homepage's own Explore/Engage
sections. Replaced the nav's old About TVC/Our Journey/Visit TVC/Biodiversity/Events/Contact
grouping with two dropdowns — Explore (10 items, two-column) and Engage (7 items) — matching the
homepage fork exactly, so the same map is visible (nav is sticky) no matter where you scroll on
any page. Added a new `Breadcrumbs` component, wired into `BaseLayout` so every page automatically
gets a `Home / Explore|Engage / {page title}` trail computed from the URL path and the page's own
title prop — no per-page wiring needed, and it works on dynamic slug pages (events, partners,
community outreach posts) for free. The middle breadcrumb segment links to `/#explore` or
`/#engage` on the homepage. Left the footer close to its original shape (brand, blurb, social
links, copyright) after the sitemap version proved redundant with the now-comprehensive nav.
Along the way, hit and resolved a stale Vite dev-server module cache that was serving an old
version of the footer's scoped CSS after the edit — a dev server restart cleared it; not a
production concern since a fresh `astro build` doesn't carry over stale in-memory HMR state.
Verified nav dropdowns, breadcrumb trails (including a dynamic event page), and the footer on
desktop and mobile.

**Commits:** `8cdff81`

---

### 2026-07-18 — Redesign the homepage around Explore/Engage, add a Joining the Collective page
**Requested by:** Sharath Jeppu

**Ask:** "I would like to redesign the landing page. Here's my thought process. There are
different levels of engagement Visit us (day trip) Stay with us (over night stay) Work with us
(conduct events, volunteer, etc) Join us (become a member) Also, People would like to explore or
engage. So the landing page should start with this. Exploration should link to all the
information sections of the website while engagement should lead to all CTA sections of the
website. No section should be missed in this process Can you mock up this to be an engaging
landing page. Mockup a couple of options to consider" — followed by picking "Concept A" (a
two-doors fork into Explore/Engage), then "I would like to add a section related to 'Become a
part of the collective'... it is unlikely that our community size will be more than what we are
today... The transaction will be directly between the seller and the buyer and the community
will only be involved in ensuring that the buyer has a full understanding of the ethos... The
process will involve engaging with atleast 2 of the existing members to understand this first,"
clarified as its own page rather than a homepage section, three copy revisions (softening
"expand membership" language, re-articulating the "talk to 2 members" step, and adding that TVC
isn't a financial investment — each member values it differently), and finally "Yes, go ahead
and build it."

**Change:** Replaced the homepage with a fork-first structure: a hero, then an "Explore, or
engage" choice between two doors. Explore leads to a 9-card grid covering every informational
page on the site (About, Our Journey, Timeline, In Pictures, Biodiversity, Community Outreach,
Resource Centre, Partners, Events). Engage leads to a 4-rung ladder — Day Visit, Overnight
Camping, Work with us (events & volunteering, linking to the existing `/visit` hub), and Join —
each rung visually escalating (white → green tint → orange tint) except the Join rung, which is
deliberately muted/quiet rather than continuing the escalation, since TVC isn't actively
recruiting. Kept the existing principles grid and closing quotes, condensing the former into a
lighter strip — this content existed only on the homepage and wasn't duplicated anywhere else on
the site. Built a new `/join` page with the honest membership explanation (community size is
effectively capped, spot transfers are private transactions directly between members with TVC
only ensuring the buyer understands the ethos, TVC isn't a financial investment and means
something different to each member, and joining starts with talking to at least 2 current
members) alongside real photos of two member families. Replaced the old thin `id="join"` section
on `/about` with a short teaser pointing to `/join` instead of straight to `/contact`. Verified
locally on desktop and mobile — hero, doors, explore grid, engage ladder, and the new `/join`
page all render with real site content and images.

**Commits:** `6c4ed07`

---

### 2026-07-18 06:58 — Redesign the Our Journey timeline as a full-bleed scrollytelling page
**Requested by:** Sharath Jeppu

**Ask:** "The current deployment of the timeline page is not engaging enough. At first glance
most people don't realize that they need to click to see the details. Can you design something
like the https://compsych.konpo.co" — followed by a round of comparing rendered options ("wouldn't
a full bleed year be better? ... Can you render both for me to compare?"), then "I like the
scrollytelling version better, and months as a lighter carousel within a year sounds
promising. Can you render and show?", a design tweak pasted in by the user, two more open
questions ("How will option 2 render if there is no picture? ... can the timeline markers be
more granular than a year"), and finally "lets build it."

**Change:** Replaced the click-a-year-dot-to-open-a-modal timeline with a full-viewport-per-year
page: a fixed sidebar index and progress rail track scroll position, and each year's months now
live as a swipeable in-section carousel instead of hidden behind a click — the small icon-dots
didn't read as clickable, and nothing hinted at the photos behind them. Reached this design
through several rounds of live-rendered Artifact comparisons (photo-tile cards vs. full-bleed
takeover, a scrollytelling structure, then months-as-carousel-within-a-year) before building it
for real, using the actual per-month photos and narration already in the data — not the
mockups' simplified one-photo-per-year placeholders. Months with no photo on file (July 2023,
the one real example) get a text-only card instead of an empty image. Removed the old
bounded-height page wrapper since this design scrolls naturally; footer and chat widget stay
reachable exactly as on every other page, just after a longer scroll. Along the way, fixed a
real bug where the carousel's arrow buttons did nothing — `scrollTo({behavior:'smooth'})` was
being silently cancelled by `scroll-snap-type:mandatory` on the same element, a known browser
conflict — by switching arrow-triggered scrolls to `behavior:'auto'`. Verified locally on desktop
and mobile: real photos render per month, the no-photo fallback, carousel arrows/swipe, sidebar
navigation, and footer/chat-widget reachability after scrolling through all 10 years.

Commit: `9945c29`

---

### 2026-07-18 06:12 — Render chat widget replies as formatted Markdown
**Requested by:** Sharath Jeppu

**Ask:** "Can the text formatting in the chat bot be richer. It is rendering plain text" — the
assistant's replies (bold, bullet/numbered lists, links) were showing as literal
`**`/`-`/`[text](url)` syntax instead of formatted content.

**Change:** `ChatWidget.astro` now parses the assistant's Markdown-style replies into real HTML
(bold, bulleted/numbered lists, links) instead of rendering them as plain text; user-typed
messages are unaffected. Because this text originates from an LLM response, it's treated as
untrusted input: everything is HTML-escaped before any tag is introduced, and link targets are
allow-listed to `https://`, `mailto:`, and relative site paths (external links additionally get
`target="_blank" rel="noopener noreferrer"`) — verified this blocks `<script>` injection and
`javascript:`/`data:` URL schemes. Verified end-to-end on a Netlify draft deploy (isolated from
production): bold, both list types, and both internal/external links all rendered correctly
against real assistant replies, with no console errors.

Commit: `5d7db87`

---

### 2026-07-18 05:29 — Activate the chat assistant's AI responses
**Requested by:** Sharath Jeppu

**Ask:** "I would like to enable the site chatbot with the anthropic key" — the chat widget and
its Netlify Function backend (`chat.mts`) were already built and deployed (see the 2026-07-16
09:32 entry below), but had been waiting on an `ANTHROPIC_API_KEY` to actually respond.

**Change:** Configuration only, no code change. Linked the local repo to the `tvc-farm` Netlify
site (ownership had recently moved to the `contact@tvc.farm` account), then set
`ANTHROPIC_API_KEY` as a Netlify environment variable (Builds/Functions/Runtime scope,
production context) via the Netlify dashboard. An initial key attempt was rejected by Anthropic
with `401 invalid x-api-key`; a second, freshly generated key also failed the same way at first
because the already-running function hadn't picked up the new value — triggering a fresh
`netlify deploy --prod` refreshed it. Verified end-to-end with live requests to both
`tvc.farm/api/chat` and the underlying `tvc-farm.netlify.app/api/chat`, confirming grounded
replies sourced from the site's own content (e.g. farm description, upcoming events).

No commit — this was a Netlify environment-variable/deploy change, not a source change.

---

### 2026-07-17 07:46 — Fix Foraging Day payment link
**Requested by:** Rajesh

**Ask:** "The 'Pay & register' link in the current upcoming event in 2026-08-01-foraging-day is
wrong. It should be 'https://rzp.io/rzp/Pry5rI8r'."

**Change:** The event page's "Pay & register" button pointed at an invalid/placeholder Razorpay
link (`rzp.io/rzp/ForageTVC`). Replaced with the correct link. Confirmed no other references to
the old link existed anywhere in the codebase, and checked the corrected URL is present in the
built HTML.

Commit: `66614ab`

---

### 2026-07-16 18:57 — Replace newsletter signup with "Friends of TVC" WhatsApp signup
**Requested by:** Rajesh

**Ask:** "We will not have a news letter. We can aonly collect name & phone number t add them to
a whatsapp group 'Friends of TVC'. Need a way to collect thes in place of newsletter sign up in
the contact us."

**Change:** Replaced the `/contact` page's email newsletter form with a "Join Friends of TVC"
form collecting name and phone number instead, kept on the same Netlify Forms plumbing (just
renamed the form to `friends-of-tvc`, swapped the single email field for name + phone fields).
Updated the `/contact/thanks` confirmation copy and `ARCHITECTURE.md`'s mentions of the
newsletter form to describe its new purpose (submissions get added to the "Friends of TVC"
WhatsApp group by hand — no automated WhatsApp integration). Verified the built form's `name`
attribute and hidden `form-name` field still match (required for Netlify's build-time form
detection) and checked both pages on desktop and mobile.

Commit: `36a98de`

---

### 2026-07-16 17:49 — Fix Biodiversity tile alignment
**Requested by:** Sharath Jeppu

**Ask:** "There is a tile alignment issue in the Biodiversity page. Align all the tiles to the
top."

**Change:** Found that the 4 observations (out of 109) with no photo on file rendered visibly
shorter than their photo-having row neighbors, and their caption ended up vertically centered
in the middle of the tile instead of flush at the top — a `<button>`'s content is centered by
default even under `display: block`. Fixed by setting `.obs-card` to `display: flex;
flex-direction: column; justify-content: flex-start;` in `BiodiversityExplorer.astro`. Verified
locally by loading all 109 observations and confirming each of the 4 affected tiles now sits
flush with its row's top edge.

Commit: `f5fed1f`

---

### 2026-07-16 17:33 — Improve the Our Journey timeline modal
**Requested by:** Sharath Jeppu

**Ask:** Three related requests in sequence: "In the page our journey so farm, the year and
the month gets lost while navigating across the pictures. Can they be made more prominent...
Show me locally first"; then "The month and year appear twice which is redundant. Just keep it
in the green header and centre it. Also within the same month if there are multiple pictures,
there are two separate sliders to scroll. Can this be unified?"; then "The narration also gets
lost in the display and users tend not to read it. Is there a way this can be improved?"; and
finally "the window is a little small on a large screen. Can this be fixed?"

**Change:** Made the modal header show a live, centered "Year / Month" readout (with a brief
highlight animation on change) as the single source of that information, removing the
duplicate text that used to also appear inside each slide. Flattened the nested per-month
photo carousel and the outer month track — previously two separate scrollers stacked on each
other — into one unified slider, one slide per photo. Moved each photo's narration onto the
photo itself as an overlaid caption bar instead of a separate text block above it, so it can't
be swiped past unseen. Scaled the modal's size with the viewport (up to 960×840) instead of a
flat 640×640 cap that looked small on large screens, leaving small windows and the mobile
bottom-sheet layout unaffected. Verified locally at each step (build + browser walkthroughs of
month/year transitions, year-boundary crossing, contain-fit images, no-photo months, and mobile
width) before committing.

Commit: `929659b`

---

### 2026-07-16 16:44 — Fix outdated favicon and link-preview logo
**Requested by:** Sharath Jeppu

**Ask:** "The logo that appears when we share site links and the favicon are incorrect. They
are an older version of orange. Can all these be replaced with the correct logo that we have
on the website?"

**Change:** `favicon-16.png`, `favicon-32.png`, and `apple-touch-icon.png` (also the
link-preview fallback image on platforms like WhatsApp) were still generated from the old
orange logo, while Nav/Footer/ChatWidget already used the current green logo mark. Regenerated
all three, plus two orphaned duplicate-size source files, from the current
`tvc-logo-mark.png`. Verified locally: dev server served the new files byte-identical to disk,
and the production build (`dist/`) picked up the corrected assets.

Commit: `0860bbc`

---

### 2026-07-16 16:33 — Fix missing side margins on mobile
**Requested by:** Sharath Jeppu

**Ask:** "In the mobile view, the pages seem to have no margins when displaying. It would be
good to have a small margin on both sides. Can you fix it?"

**Change:** Root cause: `.section`'s `padding` shorthand was declared after `.wrapper`'s in
`global.css`, so on the ~20 pages combining both classes (`class="section wrapper"`) it
silently overwrote `.wrapper`'s side padding entirely. Converted `.section`'s padding to
top/bottom-only longhand properties so it no longer clobbers `.wrapper`'s horizontal padding.
Verified on mobile and desktop widths before and after.

Commit: `c6d6ddf`

---

### 2026-07-16 15:18–15:25 — Newsletter signup live, architecture doc synced
**Requested by:** Sharath Jeppu

**Ask:** Follow-up "commit and push" for the newsletter form work, plus the standing
instruction to keep `ARCHITECTURE.md` in sync with every architecture-relevant change.

**Change:** Wired the Contact page newsletter form to Netlify Forms (`data-netlify`, honeypot
spam field, `/contact/thanks` confirmation page), confirmed it live in production, then updated
`ARCHITECTURE.md`'s status table to reflect the newsletter signup going live.

Commits: `4019fd6`, `34a4b90`

---

### 2026-07-16 15:18 — Rewrite architecture doc for the live site
**Requested by:** Sharath Jeppu

**Ask:** "the new website is now live on tvc.farm. Can you review and rewrite the Website
architecture document based on the current setup that is live?"

**Change:** Verified the live production setup directly (Netlify behind Cloudflare, chat
function deployed but not yet configured, newsletter form not yet deployed) and rewrote
`ARCHITECTURE.md` to precisely match what's actually running in production.

Commit: `6f488f7`

---

### 2026-07-16 13:23 — Add architecture documentation
**Requested by:** Sharath Jeppu

**Ask:** "Can you create an architecture diagram of the current setup of our website?
preferably as a word document" followed by "Can you also create a new markdown file with this
architecture design and store it on Github? Everytime there is a change, update this file."

**Change:** Produced a Word document with an embedded architecture diagram (delivered locally,
not in the repo) and created `ARCHITECTURE.md` with an equivalent Mermaid diagram covering
hosting, data flow, and external services. Added a standing instruction in `AGENTS.md` to keep
it updated with every architecture-relevant change.

Commit: `52089c1`

---

### 2026-07-16 10:36 — Fix WhatsApp/iMessage link previews
**Requested by:** Sharath Jeppu

**Ask:** Link previews on WhatsApp/iMessage were showing only the site logo instead of the
intended page image.

**Change:** Root cause: `og:image:width`/`og:image:height` were hardcoded to 1200×630
regardless of the actual image, so WhatsApp's crawler silently discarded the mismatched image
and fell back to the site icon. Added per-page `imageWidth`/`imageHeight` props matching each
hero image's real dimensions.

Commit: `e719a31`

---

### 2026-07-16 09:32 — Add a site-wide chat widget
**Requested by:** Sharath Jeppu

**Ask:** "I would like to build a chatbot for the website. The chatbot should only respond with
answers based on content on the website and nothing else. Use the website logo as the logo for
the chatbot." (Chose: Netlify hosting, a custom widget with a serverless LLM call, and the
Anthropic Claude API.)

**Change:** Built `ChatWidget.astro` (a floating widget using the site logo) plus a Netlify
Function (`chat.mts`) that calls the Anthropic Claude API server-side, grounded by a
build-time script (`build-chat-context.mjs`) that extracts the site's own page text into a
corpus so answers only draw from site content.

Commit: `56b6051`

---

### 2026-07-16 02:48 — Seamless month navigation across years
**Requested by:** Sharath Jeppu

**Ask:** "When I slide through the pictures on the time line, I would like the navigation to
also move through years seamlessly without having to close the pop up window."

**Change:** Reworked the timeline's month next/prev button logic so navigating past a year's
last or first month crosses seamlessly into the adjacent year without closing the modal
(previously the buttons were disabled at each year's boundary, blocking the click entirely).

Commit: `d5a82b0`

---

### 2026-07-15 22:52 — Remove former members from About page
**Requested by:** Sharath Jeppu

**Ask:** "in the about page, remove the member tile for Stataprana and Deb. They are no longer
a part of the community."

**Change:** Removed their entries from the About page member list.

Commit: `1489855`

---

### 2026-07-15 19:52–22:48 — Build the interactive "Our Journey" timeline
**Requested by:** Sharath Jeppu

**Ask:** "Can you create an interactive webpage depicted as a timeline from this content...
Default to a collapsed summary by year which the users can then expand to a month timeline...
There should be a summary narration for the year when it opens up with pictures by month...
Make sure that the render is mobile friendly as well," followed by several rounds of
refinement: rewrite the narration as a poem instead of plain prose, fix icon alignment and
whitespace, make the year dots more inviting to click, rebuild to exactly match a reference
file the user provided, add per-photo captions, structure the data around "eras" to scale for
the farm's 25th year, and wire the finished page into the "Our Journey" nav in place of the old
duplicate timeline.

**Change:** Built the era-based `JourneyTimelineStandalone` component (collapsible year view,
month drill-down, per-photo captions, monoline icons, poem-based landing copy) as a new
`/timeline` page, linked it into the "Our Journey" nav dropdown, removed the old duplicate
timeline implementation, and documented it in the README.

Commits: `4d02eb6`, `06a9ae1`, `00c8729`, `9bde12e`, `9d93d1b`
