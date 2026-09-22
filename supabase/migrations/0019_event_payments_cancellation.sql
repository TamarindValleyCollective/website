-- Guest-initiated cancellation requests (see netlify/functions/
-- cancel-booking.mts, src/pages/cancel-booking.astro). Deliberately just a
-- timestamp, not a real cancellation/refund workflow: TVC's refund policy
-- (/refund-policy) has day-before-event tiers a human needs to apply, and
-- actually moving money back is a separate, human-approved action taken
-- directly in the Razorpay dashboard - this column only records that a
-- guest asked, so cancel-booking.mts can notify core-team@tvc.farm + Linger
-- and tell a guest who clicks the link twice "already requested" instead of
-- notifying twice.
alter table event_payments
  add column cancellation_requested_at timestamptz;
