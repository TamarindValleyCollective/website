-- Jev (TypeSafe) reads of inbound WhatsApp messages, recorded in SHADOW mode:
-- nothing in the admin inbox or any guest-facing behaviour reads this table.
-- Its purpose is to compare Jev's read of a message with what admins actually
-- did (reply time, who replied) before deciding whether to act on it. See
-- WHATSAPP.md ("Jev message reads") and netlify/functions/whatsapp-webhook.mts.
--
-- One row per inbound message at most. Holds only Jev's answers, never message
-- text or phone numbers: the text stays in whatsapp_messages and is joined by
-- message_id, so deleting a conversation deletes its reads (on delete cascade).
-- Reply time is also derived by joining the next outbound message, so no
-- outcome columns are needed here.

create table whatsapp_message_assessments (
  message_id uuid primary key references whatsapp_messages(id) on delete cascade,
  -- Versioned model id (e.g. jev-1.14.0), never an alias, so reads from
  -- different model versions can be compared.
  model text not null,
  -- Version of the question set in scripts/lib/whatsapp-assess.mjs; bump it
  -- when a question's wording changes so old and new reads aren't mixed.
  question_version int not null,

  intent text not null,
  intent_confidence real,
  intent_probabilities jsonb,

  language text not null,
  language_confidence real,

  -- 0 (can wait) to 2 (needs a person right now); a probability-weighted score.
  urgency real not null,
  urgency_confidence real,

  -- Probability (0-1) that a person at TVC still needs to answer the message.
  needs_reply real not null,

  input_tokens int,
  latency_ms int,
  assessed_at timestamptz not null default now()
);

create index whatsapp_message_assessments_assessed_at_idx
  on whatsapp_message_assessments (assessed_at desc);

alter table whatsapp_message_assessments enable row level security;
-- No policies, like the other whatsapp_* tables: only the service_role key
-- (server-side Netlify Functions) can read or write.
