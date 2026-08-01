# Kannada / Tamil translation review

Every Kannada (`kn`) and Tamil (`ta`) string on this site is an **AI-drafted first pass** —
natural-sounding, but not reviewed by a native speaker. Visitors see a small notice banner on
every `kn`/`ta` page saying so (`src/components/TranslationNotice.astro`), controlled by
`src/i18n/reviewStatus.ts`.

**To clear a locale for production**: once a native speaker has read through everything listed
below for that language and fixed anything wrong, flip its flag in `src/i18n/reviewStatus.ts`
(`TRANSLATION_REVIEWED.kn` / `.ta`) to `true`. The notice banner disappears site-wide for that
locale immediately — no other code changes needed. Review Kannada and Tamil independently; one
can go live before the other.

## Known gaps (not yet translated at all — flag to the reviewer, don't just review these blind)

- **`src/components/JourneyTimelineStandalone.astro`** (Our Journey page, `/our-journey`) — the
  actual year-by-year narrative (the era poem, yearly summaries, month-by-month entries) is
  still **English-only** in both `kn` and `ta`. Only the component's structural UI (nav, section
  headers, lightbox/carousel controls, month names) was translated — the historical prose itself
  was judged too large to translate in the same pass and is follow-up work.
- **`src/components/views/PeopleView.astro`** (`/people`) — the 53 member-family bios were left
  in English in all locales, by deliberate choice: most are a one-line employer/job-title
  namedrop ("Works for VMware") with little actual prose to translate, and about 20 of the 53
  have no bio at all. Section headings, intros, CTAs, and all 5 local-staff bios (which have
  fuller prose) **are** translated.
- **`src/components/biodiversity/BiodiversityExplorer.astro`** — one minor tooltip
  (`title="Open full-size photo"` on the detail-panel photo link) was left untranslated.
- **Privacy, Terms, Refund Policy, and the 404 page** (`/privacy`, `/terms`, `/refund-policy`,
  `/404`) are **intentionally English-only** — an explicit scope decision, not a gap. They have no
  `kn`/`ta` versions at all and don't need review.
- **`/people/partners/ananas`** (`AnanasProjectView.astro`) — the whole page is English-only,
  same situation as the Our Journey yearly narrative above: real prose worth translating
  eventually, just not blocking the page shipping. No `kn`/`ta` route exists yet.

## What to review

### Shared site chrome (appears on every page)
- `src/i18n/kn.ts`, `src/i18n/ta.ts` — nav labels, footer, language switcher, cookie-consent
  banner, search UI, chat widget UI, weather-widget strings, form field labels (name/email/phone/
  message/submit), principle names.
- `src/utils/weather.ts` — `CODE_LABELS_KN`/`CODE_LABELS_TA` (weather condition names shown on
  the header chip and the Weather page).
- `netlify/functions/chat.mts` — the chat assistant is instructed to reply in the visitor's
  language; spot-check a few Kannada/Tamil conversations for natural phrasing.

### Pages (each has an English/Kannada/Tamil version at the same path, `kn`/`ta` prefixed)
- Home (`/`), About (`/about`), The Design (`/about/design`)
- People (`/people`) — **except the 53 member bios, see Known gaps above**
- Our Journey (`/our-journey`) — **except the yearly narrative, see Known gaps above**
- In Pictures (`/in-pictures`), Biodiversity (`/ecosystem`), Weather (`/ecosystem/geography`)
- Resource Centre (`/resource-centre`)
- Events (`/events` and every `/events/<slug>` detail page — 20 events × 2 languages)
- Visit (`/visit`), Day Visit, Overnight Camping, Host an Event (+ thanks), Trekking Trails,
  How to Reach, and the shared Visit inquiry thanks page
- Join the Collective (`/join`)
- Contact (`/contact` + thanks)
- Community Outreach (`/people/community-outreach` + its one post)

### Content collection frontmatter/body
- `src/content/photos/*.md` — `caption_kn`/`caption_ta` on all 96 photos.
- `src/content/partners/*.md` — `title_kn`/`excerpt_kn`/`title_ta`/`excerpt_ta` on all 5 partners
  (brand names were phonetically transliterated rather than translated — check these read
  naturally, not just accurately).
- `src/content/community-outreach/kn/`, `src/content/community-outreach/ta/` — 1 post,
  full translated body.
- `src/content/events/kn/`, `src/content/events/ta/` — 20 events, full translated bodies
  (headings, tables, blockquotes, CTAs). Note: a couple of source events contain a pre-existing
  typo ("INT" instead of "INR" before an amount) that was preserved as-is in translation rather
  than silently corrected — worth fixing in the English source separately, not a translation bug.

## How to spot-check quickly

`npm run dev` (or `astro dev --background`), then visit any English page and use the language
switcher (top-right of the nav) to jump to its Kannada/Tamil equivalent — it lands on the same
page, not the homepage. Every `kn`/`ta` page also carries the draft-notice banner described above
as a visual reminder while this checklist is still open.
