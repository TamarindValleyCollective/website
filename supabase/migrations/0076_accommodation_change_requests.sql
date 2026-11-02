-- Changes to the past, proposed by people who may not make them directly.
--
-- Anything that rewrites the past is a retrospective change: editing or cancelling a stay that has already ended, or
-- adding one that began before today (a backfill). Only a super admin does that directly. Anyone else who can edit that
-- kind of booking (the Linger team, and module admins too) submits it with a justification: it is stored here as a
-- request, and nothing changes until a super admin approves it. Only super admins decide; that is enforced in the
-- function (accommodation-admin.mts), not here.
--
-- kind 'update': booking_id is the stay to change and payload is the proposed booking. kind 'create': booking_id is null
-- and payload is the whole new booking. kind 'delete': booking_id is the stay to cancel (payload is empty); once the
-- cancel is approved the booking is gone, so booking_id goes null and the request row stays as the record.
--
-- Approving applies the request through the normal accommodation_update_booking / create / delete functions, so the
-- conflict checks and the audit trail work exactly as for any other edit; rejecting just closes the request.
--
-- payload: the proposed booking, the same fields POST /api/accommodation-admin/bookings/update takes (it can hold guest
-- contact details, like the booking itself, so this table is service-role only: RLS on, no policy, no grants).
--
-- Additive and backwards compatible; not auto-applied on merge. Rollback: drop table accommodation_change_requests.

create table accommodation_change_requests (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'update' check (kind in ('update', 'create', 'delete')),
  booking_id uuid references accommodation_bookings (id) on delete set null,
  payload jsonb not null,
  reason text not null check (length(btrim(reason)) > 0),
  requested_by text not null,
  requested_by_name text,
  requested_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  decided_by text,
  decided_at timestamptz,
  decision_note text,
  check (kind <> 'create' or booking_id is null)
);

create index accommodation_change_requests_status_idx on accommodation_change_requests (status, requested_at);
create index accommodation_change_requests_booking_idx on accommodation_change_requests (booking_id);

alter table accommodation_change_requests enable row level security;
revoke all on accommodation_change_requests from anon, authenticated;
