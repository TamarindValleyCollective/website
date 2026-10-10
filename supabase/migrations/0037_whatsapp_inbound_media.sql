-- Which media an inbound WhatsApp message carried (photo, voice note, video,
-- document, sticker), so the inbox can show it. Only Meta's media id and
-- descriptors are stored, never the file: whatsapp-admin.mts fetches the file
-- from Meta on demand (Meta keeps it about 30 days).
--
-- NOT auto-applied: apply to the "TVC ERP" project before deploying (the
-- webhook's message insert would fail on a media message otherwise).
alter table whatsapp_messages
  add column media_id text,
  add column media_kind text check (media_kind in ('image', 'audio', 'video', 'document', 'sticker')),
  add column media_mime text,
  add column media_filename text;
