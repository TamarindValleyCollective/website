-- Changes to past stays, proposed by people who may not make them directly.
--
-- A stay that has already ended can only be changed by an admin of the Stays tool. Anyone else who can edit that kind of
-- booking (the Linger team) submits the change with a reason: it is stored here as a request, and the booking stays as it
-- is until an admin approves it. Approving applies `payload` through the normal accommodation_update_booking, so the
-- conflict checks and the audit trail work exactly as for any other edit; rejecting just closes the request.
--
-- payload: the proposed booking, the same fields POST /api/accommodation-admin/bookings/update takes (it can hold guest
-- contact details, like the booking itself, so this table is service-role only: RLS on, no policy).
--
-- Additive and backwards compatible; not auto-applied on merge. Rollback: drop table accommodation_change_requests.

create table accommodation_change_requests (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references accommodation_bookings (id) on delete cascade,
  payload jsonb not null,
  reason text not null check (length(btrim(reason)) > 0),
  requested_by text not null,
  requested_by_name text,
  requested_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  decided_by text,
  decided_at timestamptz,
  decision_note text
);

create index accommodation_change_requests_status_idx on accommodation_change_requests (status, requested_at);
create index accommodation_change_requests_booking_idx on accommodation_change_requests (booking_id);

alter table accommodation_change_requests enable row level security;
