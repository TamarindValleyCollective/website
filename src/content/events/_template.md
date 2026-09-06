---
# HOW TO USE THIS FILE
#
# To publish a new upcoming event:
#   1. Copy this file and rename the copy to something like
#      2026-03-15-your-event-name.md (the filename becomes the event's URL).
#   2. Fill in the fields below with the real event's details.
#   3. Delete the "draft: true" line (or change it to "draft: false").
#      Until you do, this event stays hidden from the site no matter what
#      the date says - that's what keeps this template itself invisible.
#   4. Write the full event description below the second "---" line, in
#      plain text/Markdown (blank line between paragraphs).
#
# You can leave this file as-is for the next event too - just repeat the
# steps above whenever a new one needs to go live.

title: "YYYY: Mon DD - Event Name"
date: 2026-01-01
excerpt: "A one-to-two sentence summary shown on the event card and in link previews. Keep it under ~250 characters."
organizer: ""
tags: []
draft: true
# If this event has a fixed price, list every tier here - one row per
# price line in the "at a glance" sidebar, `amount` shown bold and `label`
# plain. Include a free-for-some-age-group row if that applies (see the
# second example row below). Leave the whole field out for a fully free
# event. Don't also restate any of this in a heading below (e.g.
# "## What's included — INR 1,900") - the sidebar is the one place price
# lives now, so the body only needs "## What's included" plus a bullet list.
# price:
#   - amount: "INR 1,900"
#     label: "per person"
#   - amount: "Free"
#     label: "children under 10"
---

Full event description goes here - what the event actually is, in a
paragraph or two.

Standard section order for the rest of the body (keep every event reading
the same way, not each one improvised): the write-up above, then
**## Schedule** (a Time/Activity table - see any 3Bs&1H edition for the
two-day format, or the Melagiri event for single-day), then
**## What's included** (a bullet list), then any event-specific extras
(what to carry, logistics, etc.), then the registration/booking
call-to-action last, at the very bottom.

If you set `price` above, that call-to-action must be wrapped with
`id="cta"` (e.g. `<div class="cta card" id="cta">`), so the sidebar's
"Book now" button has something to jump to.
