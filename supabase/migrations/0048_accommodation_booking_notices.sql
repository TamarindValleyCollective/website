-- Records that a member-stay booking's allocation has been "finalized" and
-- the guests told (accommodation-admin.mts -> lib/stay-notify.ts). One row per
-- booking; `snapshot` is exactly what the guests were last told, so a later
-- edit can be diffed against it ("changed since notified" -> send an update)
-- and a cancellation knows who to tell even if guests were swapped out since.
--
-- snapshot = { "startDate": "YYYY-MM-DD", "nights": n,
--              "assignments": [{ "personId": uuid, "tentId": text }] }
--
-- Cascades with the booking, so deleting a booking removes its notice; the
-- delete path reads the notice BEFORE deleting to send the cancellation.
--
-- NOT auto-applied: apply to the "TVC ERP" project before deploying the code.
create table accommodation_booking_notices (
  booking_id uuid primary key references accommodation_bookings (id) on delete cascade,
  snapshot jsonb not null,
  notified_at timestamptz not null default now(),
  notified_by text not null
);

alter table accommodation_booking_notices enable row level security;
