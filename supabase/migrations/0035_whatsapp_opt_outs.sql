-- Numbers that have asked us to stop WhatsApp messages by replying STOP
-- (whatsapp-webhook.mts). Checked by lib/whatsapp-send.ts before EVERY
-- template send, whatever the booking says, so it also covers guests who ticked
-- the booking checkbox earlier and later changed their mind. A START reply
-- deletes the row.
--
-- Keyed on the E.164 number ("+919876543210") rather than a booking: one
-- person can have many bookings, and the number is what Meta messages.
--
-- NOT auto-applied: apply to the "TVC ERP" project BEFORE deploying the code —
-- the sender fails closed (sends nothing) when this table can't be read.
create table whatsapp_opt_outs (
  phone text primary key,
  source text not null default 'stop_reply',
  created_at timestamptz not null default now()
);

-- Same posture as the other whatsapp_* tables: service-role only.
alter table whatsapp_opt_outs enable row level security;
