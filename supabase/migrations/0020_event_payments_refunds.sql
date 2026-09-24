-- Admin-triggered refunds (see netlify/functions/event-payments-admin.mts,
-- src/pages/internal/event-payments.astro). cancellation_requested_at
-- (0019) keeps meaning "a guest asked" via the public /cancel-booking flow;
-- these columns record what actually happened to the money, whether
-- triggered from that guest request or an admin cancelling proactively.
-- A row counts as "cancelled" in aggregates once refunded_at is set, not
-- merely cancellation_requested_at.
alter table event_payments
  add column razorpay_refund_id text,
  add column refund_amount integer,        -- paise, may be less than `amount` (partial refund)
  add column refund_status text,           -- Razorpay's own refund status, e.g. 'processed'/'pending'
  add column refunded_at timestamptz,
  add column refunded_by text;             -- admin's Google account email, for audit
