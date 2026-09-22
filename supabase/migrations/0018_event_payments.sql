-- Event payment tracking (see netlify/functions/razorpay-webhook.mts,
-- ARCHITECTURE.md). Applied to the "TVC ERP" Supabase project
-- (mljavkvkxdejvpzadnrp) — table name is event_payments, no series-specific
-- prefix, since this is meant to be one shared table every event's Razorpay
-- Payment Link webhooks land in, not a per-event/per-series table.
--
-- Deliberately event-agnostic: a row's only link back to "which event" is
-- event_reference_id/event_title, both read straight off the Payment Link's
-- own reference_id/notes.event (or description) at webhook time. Adding a
-- new event's payment link needs no schema change and no code change here —
-- just a sensible reference_id and notes.event on the link itself.
--
-- One booking can cover multiple people: the event's own Payment Link (the
-- one created by hand, e.g. via the Razorpay MCP) states the per-person
-- price and is never paid directly — event-booking.mts reads that price,
-- multiplies by the attendee count a visitor enters in EventBookingForm,
-- and creates a fresh per-booking Payment Link for the total (see that
-- function's own comments). event_reference_id here is always the base
-- event's reference_id (from that per-booking link's notes.baseReferenceId),
-- not the one-off per-booking link's own reference_id, so every booking for
-- one event groups together.
create table event_payments (
  id uuid primary key default gen_random_uuid(),
  event_reference_id text not null,       -- Payment Link's own reference_id, e.g. "foraging-day-2026-10-10"
  event_title text not null,              -- notes.event on the link, falling back to its description
  razorpay_payment_id text not null,      -- pay_xxx — the idempotency key (see unique index below)
  razorpay_payment_link_id text not null, -- plink_xxx
  amount integer not null,                -- paise, matches Razorpay's own unit (the TOTAL charged, not per-person)
  currency text not null default 'INR',
  attendee_count integer not null default 1,
  payer_name text,
  payer_email text,
  payer_contact text,
  receipt_sent_at timestamptz,            -- null if the receipt email failed/was skipped (no payer_email)
  created_at timestamptz not null default now()
);

-- Idempotency: Razorpay documents at-least-once webhook delivery with
-- retries on non-2xx and occasional duplicates even on 2xx (same reasoning
-- as whatsapp_messages_wa_message_id_key in 0001). An ignore-duplicates
-- upsert on insert (see scripts/lib/event-payments-db.mjs) turns a
-- re-delivered payment_link.paid webhook into a no-op — including skipping
-- the receipt email a second time — instead of a duplicate row/email.
create unique index event_payments_razorpay_payment_id_key
  on event_payments (razorpay_payment_id);

create index event_payments_event_reference_id_idx
  on event_payments (event_reference_id);

alter table event_payments enable row level security;
-- No policies: RLS enabled with zero policies denies all access to
-- anon/authenticated roles (standard, documented Supabase/PostgREST
-- behavior). Only the service_role key — used exclusively server-side by
-- the webhook Netlify Function, never shipped to the browser — bypasses RLS.
