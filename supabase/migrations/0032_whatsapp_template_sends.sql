-- Delivery tracking for outbound WhatsApp TEMPLATE messages (see
-- netlify/functions/lib/whatsapp-send.ts). Meta's Send API answers "accepted"
-- before it tries to deliver; whether the guest's phone actually received it
-- comes later as a webhook `statuses` event (sent → delivered → read, or
-- failed with a reason), handled in whatsapp-webhook.mts.
--
-- Deliberately separate from whatsapp_messages: those rows belong to
-- conversations shown in /internal/whatsapp, and an outbound template row
-- there would mark the thread unread and trip the stale-alert digest.
-- The full phone number is NOT stored — only the last 4 digits, enough to
-- tell sends apart; the booking (event_payment_id) holds who it was for.
create table whatsapp_template_sends (
  id uuid primary key default gen_random_uuid(),
  wa_message_id text not null unique,
  template text not null,
  -- The booking this notification was about, when there is one (the staff
  -- enquiry alert has none). No foreign key: deleting test bookings must not
  -- be blocked by, or cascade into, delivery history.
  event_payment_id uuid,
  recipient_last4 text,
  status text not null default 'accepted'
    check (status in ('accepted', 'sent', 'delivered', 'read', 'failed')),
  error_code text,
  error_message text,
  status_at timestamptz,
  created_at timestamptz not null default now()
);

create index whatsapp_template_sends_booking_idx on whatsapp_template_sends (event_payment_id);

-- Same posture as the other whatsapp_* tables: service-role only.
alter table whatsapp_template_sends enable row level security;
