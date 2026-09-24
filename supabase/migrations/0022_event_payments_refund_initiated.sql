-- Splits "a refund was initiated" from "Razorpay confirmed it processed" —
-- see netlify/functions/event-payments-admin.mts and razorpay-webhook.mts.
-- Razorpay is the source of truth for whether money actually moved:
-- initiating a refund (from our own admin page, or from the Razorpay
-- dashboard directly) only ever sets refund_initiated_at + refund_status
-- to Razorpay's initial status; refunded_at is set only once the
-- refund.processed webhook confirms it, never optimistically at
-- initiation time.
alter table event_payments
  add column refund_initiated_at timestamptz;
