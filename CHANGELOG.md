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
