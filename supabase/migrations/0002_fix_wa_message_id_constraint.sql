-- Fixes a bug in 0001: PostgREST's on_conflict=wa_message_id upsert (used by
-- scripts/lib/supabase.mjs's insertMessage) needs Postgres to infer a unique
-- constraint from the column list, and it can't do that against a *partial*
-- index — ON CONFLICT column inference only matches full unique constraints/
-- indexes. Every inbound message insert was failing with Postgres error
-- 42P10 ("there is no unique or exclusion constraint matching the ON
-- CONFLICT specification"), silently swallowed by whatsapp-webhook.mts's
-- try/catch, so conversations were created but no messages were ever saved.
--
-- Switching to a full (non-partial) unique index keeps the same practical
-- semantics as before: Postgres treats every NULL as distinct for
-- uniqueness, so multiple rows with wa_message_id = NULL are still allowed.
drop index if exists whatsapp_messages_wa_message_id_key;

create unique index whatsapp_messages_wa_message_id_key
  on whatsapp_messages (wa_message_id);
