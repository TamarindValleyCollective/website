---
title: "TEST ONLY — Fake Event"
date: 2027-12-31
excerpt: "A fake event for rehearsing bookings, refunds and cancellations in Razorpay test mode. Never shown on the site."
organizer: "TVC (internal testing)"
tags: []
draft: true
razorpayReferenceId: "fake-test-event"
price:
  - amount: "₹100"
    label: "per person"
---

Internal test fixture — see RAZORPAY.md ("Rehearsing bookings with the fake event"). `draft: true` keeps it off every public page, listing, and route; the only places it appears are the staff Event Payments dashboard dropdown (marked "(draft)") and, in `astro dev` only, `/internal/test-event/fake-test-event`.
