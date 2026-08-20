-- WhatsApp reply admin page (see WHATSAPP.md, ARCHITECTURE.md). Applied to
-- the "TVC ERP" Supabase project (mljavkvkxdejvpzadnrp) — table names are
-- whatsapp_-prefixed since that project is shared/multi-purpose.
create extension if not exists pgcrypto;

create table whatsapp_conversations (
  id uuid primary key default gen_random_uuid(),
  wa_phone text not null unique,          -- digits as Meta sends them (message.from / contact.wa_id), no leading '+'
  display_name text,
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table whatsapp_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references whatsapp_conversations(id) on delete cascade,
  direction text not null check (direction in ('inbound', 'outbound')),
  body text not null,
  wa_message_id text,                     -- Meta's message id (inbound messages[].id, outbound Send API response id)
  status text not null default 'received' check (status in ('received', 'sent', 'failed')),
  error_message text,                     -- set when status='failed' (e.g. Meta's 24h-window rejection), shown in the UI
  created_at timestamptz not null default now()
);

-- Idempotency: Meta documents at-least-once webhook delivery with retries on
-- non-2xx and occasional duplicates even on 2xx. A partial unique index +
-- ignore-duplicates upsert on insert (see scripts/lib/supabase.mjs) turns a
-- re-delivered webhook into a no-op instead of a duplicate row.
create unique index whatsapp_messages_wa_message_id_key
  on whatsapp_messages (wa_message_id) where wa_message_id is not null;

create index whatsapp_messages_conversation_id_created_at_idx
  on whatsapp_messages (conversation_id, created_at);
create index whatsapp_conversations_last_message_at_idx
  on whatsapp_conversations (last_message_at desc);

alter table whatsapp_conversations enable row level security;
alter table whatsapp_messages enable row level security;
-- No policies: RLS enabled with zero policies denies all access to
-- anon/authenticated roles (standard, documented Supabase/PostgREST
-- behavior). Only the service_role key — used exclusively server-side by
-- Netlify Functions, never shipped to the browser — bypasses RLS.
