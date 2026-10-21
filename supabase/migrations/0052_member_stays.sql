-- Member portal: members book their own stays (netlify/functions/members-me.mts,
-- /api/members-me/stays*). The booking itself is an ordinary `member-stay` row in
-- accommodation_bookings, created through the same accommodation_create_booking RPC the
-- admin calendar uses, so tent conflicts are still enforced by the EXCLUDE constraint.
-- The member does not choose tents: the booking is created with no tents and Madhavan allocates
-- them in the calendar. This table adds what the calendar does not know: which household booked
-- it, who clicked, who is coming (names and adult/child only; `party`), and how many are paying
-- guests (not family) for the pricing step. A booking with no tents yet is "waiting", and its
-- party_size is taken off what the next member is told is free.
--
-- portal_settings holds portal-wide values that admins change without a deploy. Seeded with
-- the guest discount (Sharath, 2026-10-21): paying guests get 20% off the guest rate.
-- Server-side only, like every member_* table: RLS on, no policies.
--
-- NOT auto-applied: apply to the "TVC ERP" project before deploying the code.

create table portal_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table portal_settings enable row level security;
revoke all on portal_settings from anon, authenticated;

insert into portal_settings (key, value) values ('guest_discount_percent', '20'::jsonb);

create table member_stays (
  booking_id uuid primary key references accommodation_bookings (id) on delete cascade,
  household_id uuid not null references member_households (id),
  requested_by uuid not null references member_people (id),
  party_size integer not null check (party_size >= 1),
  party jsonb not null,
  guest_count integer not null default 0 check (guest_count >= 0),
  created_at timestamptz not null default now()
);
create index member_stays_household_idx on member_stays (household_id);
alter table member_stays enable row level security;
revoke all on member_stays from anon, authenticated;
