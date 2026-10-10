-- Lets staff decline a guest's cancellation request (e.g. it falls outside
-- the /refund-policy window) instead of leaving it as "requested" forever —
-- see netlify/functions/event-payments-admin.mts (POST /decline).
-- A declined row is still a live booking: it can later be refunded (change
-- of mind, or the event itself being cancelled), at which point the normal
-- refund statuses take precedence over "declined".
alter table event_payments
  add column cancellation_declined_at timestamptz,
  add column cancellation_declined_by text,
  add column cancellation_decline_reason text;
