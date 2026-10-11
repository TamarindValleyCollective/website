-- Approval-gated event booking (see netlify/functions/event-booking.mts,
-- event-booking-approval.mts, ARCHITECTURE.md). A guest's "Request a spot"
-- submission lands here as `pending`; Linger staff talk to the guest, then
-- approve from a tokenised link sent on WhatsApp, which is what creates the
-- Razorpay Payment Link. NOT applied automatically — apply to the "TVC ERP"
-- project before merging.
create table event_booking_requests (
  id uuid primary key default gen_random_uuid(),
  event_reference_id text not null,        -- base Payment Link reference_id, same key as event_payments.event_reference_id
  event_title text not null,
  event_date date,
  name text not null,
  email text not null,
  phone text not null,
  attendee_count integer not null check (attendee_count between 1 and 10),
  whatsapp_opt_in boolean not null default false,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'declined')),
  -- sha256 of the random token in the approve link; the token itself is never stored.
  approval_token_hash text not null,
  decided_at timestamptz,
  decision_note text,                      -- staff-only, never shown to the guest
  payment_link_id text,                    -- plink_xxx, set on approval
  payment_link_url text,
  payment_link_sent_at timestamptz,        -- null if neither WhatsApp nor email reached the guest
  created_at timestamptz not null default now()
);

create unique index event_booking_requests_token_hash_key
  on event_booking_requests (approval_token_hash);
create index event_booking_requests_event_idx
  on event_booking_requests (event_reference_id, status);

alter table event_booking_requests enable row level security;
-- No policies: service_role (server-side Netlify Functions) only, same as event_payments.
