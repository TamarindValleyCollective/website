-- Records the event's own date *as it was when the guest paid* (see
-- netlify/functions/event-booking.mts, razorpay-webhook.mts,
-- src/pages/internal/event-payments.astro). event_reference_id/event_title
-- already capture "which event" but not "which date" — if an event gets
-- rescheduled after payments come in (already happened once, Foraging Day),
-- the refund-tier suggestion on the admin dashboard was computing days-until
-- off the event content file's *current* date, not the date the guest
-- actually booked against, unfairly shrinking their entitled tier.
--
-- Populated going forward via EventBookingForm's new eventDate prop, carried
-- through the per-booking Payment Link's notes.eventDate same as
-- attendeeCount. Null for any row recorded before this migration —
-- event-payments.astro falls back to the event's current content-file date
-- for those, same behavior as before.
alter table event_payments
  add column event_date date;
