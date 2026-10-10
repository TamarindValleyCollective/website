-- Three small additions for the WhatsApp features added 2026-10-10 (see
-- WHATSAPP.md). NOT auto-applied: run this against the "TVC ERP" project
-- before deploying the code that uses it (the webhook's upsert would fail
-- on the unknown referral columns otherwise).

-- 1. Click-to-WhatsApp attribution. When a conversation starts from an ad or
--    an Instagram/Facebook entry point, Meta attaches a `referral` object to
--    the first message (whatsapp-webhook.mts). Stored once per conversation,
--    and only overwritten by a later referral, never cleared by a plain
--    message.
alter table whatsapp_conversations
  add column referral_source_type text,   -- 'ad' | 'post'
  add column referral_source_id text,     -- Meta ad / post id
  add column referral_source_url text,    -- the ad or post URL
  add column referral_headline text,
  add column referral_at timestamptz;

-- 2. Out-of-hours auto-reply. Rate limit: at most one auto-reply per
--    conversation per 12 hours (whatsapp-webhook.mts).
alter table whatsapp_conversations
  add column last_auto_ack_at timestamptz;

-- 3. Pre-event reminder (whatsapp-event-reminders.mts). Set when the
--    reminder is claimed so a re-run or overlap can never send it twice;
--    cleared again if the send itself fails.
alter table event_payments
  add column whatsapp_reminder_sent_at timestamptz;
