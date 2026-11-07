-- Finance: a note on a payment, beside the wording the bank or the UPI app gave it (which is never changed).
-- One note per payment, shared by the UPI row and its bank line: the key is the 12-digit UPI reference for a UPI payment
-- ('upi:<reference>', so it is the same before and after the two are joined), else the bank line ('bank:<id>').
-- Editing replaces the note; clearing it deletes the row. Each change is written to fin_audit_log by the function.

create table fin_payment_notes (
  key text primary key check (key ~ '^(upi:[0-9]{12}|bank:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
  entity_id uuid not null references fin_entities (id),
  note text not null check (length(note) between 1 and 300),
  updated_by uuid references staff_users (id),
  updated_at timestamptz not null default now()
);

alter table fin_payment_notes enable row level security;
revoke all on fin_payment_notes from anon, authenticated;
