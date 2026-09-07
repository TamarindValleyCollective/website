-- Backs the block/unblock action in /internal/whatsapp (see
-- netlify/functions/whatsapp-admin.mts's handleBlock). The real block lives
-- with Meta (Cloud API's POST/DELETE /{phone-number-id}/block_users, which
-- makes Meta silently drop future inbound messages from that number before
-- they ever reach whatsapp-webhook.mts) — this column just mirrors that
-- state locally so the admin UI can show a "Blocked" badge without a live
-- Graph API round-trip on every conversation-list poll.
alter table whatsapp_conversations add column is_blocked boolean not null default false;
alter table whatsapp_conversations add column blocked_at timestamptz;
