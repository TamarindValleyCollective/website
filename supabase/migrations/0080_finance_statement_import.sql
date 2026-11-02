-- Finance module, session 03: statement import (docs/finance/sessions/03-statement-import.md).
--
-- Applied to TVC ERP on 2026-11-02 (recorded as finance_statement_import). Number note: 0079 is taken by the open session-04 PR (finance parties), so this is 0080;
-- the two touch different tables and can be applied in either order.
--
--   * fin_import_batches: one row per imported FILE. A bank statement comes as one file per year, and each year is its
--     own batch with its own period, opening and closing balance, so the chain can be checked across year boundaries.
--     `source` is where the lines came from ('axis_statement' now; a bank API would add its own value in a later
--     migration). The file hash is unique, so the same file is never imported twice.
--   * fin_bank_lines: the bank's lines. Facts: never updated, never deleted (trigger).
--   * fin_upi_lines: the Paytm export's rows. Only `bank_line_id` may change, once, when the matching bank line arrives.
--   * fin_store_bank_batch / fin_store_upi_batch / fin_link_upi_lines: do the writes in ONE transaction each, so a file is
--     stored whole or not at all, and thousands of lines go in without row-by-row round trips. service_role only.
--   * fin_entities.circle_tag: the Paytm tag that marks a UPI-circle payment (default "Pocket Money").
--   * fin_entities.paytm_since: the day the entity's account started being used on Paytm. A bank UPI debit before it will
--     never have a Paytm row, and the import summary says so instead of listing it as missing. Seeded 2026-08-31.
--
-- Same posture as 0077: server only. RLS on with no policies; anon/authenticated revoked. Money is bigint paise.
-- Public repository: nothing here is a real account number, name or amount.

alter table fin_entities add column circle_tag text not null default 'Pocket Money';
alter table fin_entities add column paytm_since date;
update fin_entities set paytm_since = date '2026-08-31';

create table fin_import_batches (
  id uuid primary key,
  entity_id uuid not null references fin_entities (id),
  source text not null check (source in ('axis_statement', 'paytm_upi')),
  -- The account a bank statement belongs to. Null for a Paytm export, which can span several accounts.
  bank_account_id uuid references fin_bank_accounts (id),
  file_name text not null,
  file_hash text not null,
  -- Key of the raw file in the private R2 bucket (finance/imports/<id>.xlsx).
  r2_key text not null,
  -- The period the file says it covers, and (bank statements) its opening and closing balance.
  period_from date,
  period_to date,
  opening_paise bigint,
  closing_paise bigint,
  first_line_date date,
  last_line_date date,
  inserted_count integer not null default 0,
  duplicate_count integer not null default 0,
  ignored_count integer not null default 0,
  ignored_total_paise bigint not null default 0,
  failed_count integer not null default 0,
  -- Whether this file's own balance chain held (always true for a stored bank statement; null for Paytm).
  chain_held boolean,
  -- What the planner reported about this file's neighbours: chain_ok / gap / overlap entries. Dates and counts only.
  boundaries jsonb not null default '[]',
  failed_rows jsonb not null default '[]',
  imported_by uuid references staff_users (id),
  created_at timestamptz not null default now(),
  unique (entity_id, file_hash)
);
create index fin_import_batches_account_idx on fin_import_batches (bank_account_id, period_from);

create table fin_bank_lines (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references fin_entities (id),
  bank_account_id uuid not null references fin_bank_accounts (id),
  batch_id uuid not null references fin_import_batches (id),
  tran_date date not null,
  value_date date not null,
  narration text not null,
  direction text not null check (direction in ('debit', 'credit')),
  amount_paise bigint not null check (amount_paise >= 0),
  balance_paise bigint not null,
  -- The 12-digit UPI reference from a UPI/P2A|P2M/<ref>/ narration; joins the line to a Paytm row.
  upi_rrn text check (upi_rrn ~ '^[0-9]{12}$'),
  -- Account, date, narration, direction, amount and the running balance (+ order among exact repeats). Unique, so a
  -- later overlapping download can only add lines not already held.
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  unique (entity_id, dedupe_key)
);
create index fin_bank_lines_account_date_idx on fin_bank_lines (bank_account_id, tran_date);
create index fin_bank_lines_rrn_idx on fin_bank_lines (upi_rrn) where upi_rrn is not null;
create index fin_bank_lines_batch_idx on fin_bank_lines (batch_id);

create table fin_upi_lines (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references fin_entities (id),
  batch_id uuid not null references fin_import_batches (id),
  -- Null for an ignored row (an account that is not one of ours).
  bank_account_id uuid references fin_bank_accounts (id),
  paid_at date not null,
  paid_time time,
  details text,
  counterparty text,
  account_label text not null,
  direction text not null check (direction in ('debit', 'credit')),
  amount_paise bigint not null check (amount_paise > 0),
  upi_ref text not null check (upi_ref ~ '^[0-9]{12}$'),
  order_id text,
  remarks text,
  tag text,
  -- A payment out carrying the entity's circle tag.
  is_circle boolean not null default false,
  ignored boolean not null default false,
  ignored_reason text,
  -- The bank line with the same reference, once its statement has been imported. Null = awaiting the bank statement.
  bank_line_id uuid references fin_bank_lines (id),
  created_at timestamptz not null default now(),
  unique (entity_id, upi_ref),
  check (not ignored or bank_line_id is null)
);
create index fin_upi_lines_paid_at_idx on fin_upi_lines (paid_at);
create index fin_upi_lines_awaiting_idx on fin_upi_lines (upi_ref) where bank_line_id is null and not ignored;
create index fin_upi_lines_batch_idx on fin_upi_lines (batch_id);

-- Bank lines are facts: no edits, no deletes.
create function fin_bank_lines_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'fin_bank_lines is append-only';
end;
$$;
create trigger fin_bank_lines_no_update before update or delete on fin_bank_lines
  for each row execute function fin_bank_lines_immutable();

-- A UPI row may only gain its bank_line_id (once). Nothing else about it changes.
create function fin_upi_lines_link_only() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'fin_upi_lines rows are never deleted';
  end if;
  if (to_jsonb(new) - 'bank_line_id') is distinct from (to_jsonb(old) - 'bank_line_id') then
    raise exception 'only bank_line_id of a fin_upi_lines row may change';
  end if;
  if old.bank_line_id is not null and new.bank_line_id is distinct from old.bank_line_id then
    raise exception 'a UPI row is already linked to a bank line';
  end if;
  return new;
end;
$$;
create trigger fin_upi_lines_link_only before update or delete on fin_upi_lines
  for each row execute function fin_upi_lines_link_only();

-- Store one bank statement file: the batch row and all its new lines, in one transaction. p_batch carries the batch
-- fields (see the keys below); p_lines is an array of line objects. Returns the number of lines inserted.
create function fin_store_bank_batch(p_batch jsonb, p_lines jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare
  inserted integer;
begin
  insert into fin_import_batches (
    id, entity_id, source, bank_account_id, file_name, file_hash, r2_key, period_from, period_to, opening_paise, closing_paise,
    first_line_date, last_line_date, inserted_count, duplicate_count, ignored_count, ignored_total_paise, failed_count,
    chain_held, boundaries, failed_rows, imported_by
  ) values (
    (p_batch->>'id')::uuid, (p_batch->>'entity_id')::uuid, 'axis_statement', (p_batch->>'bank_account_id')::uuid,
    p_batch->>'file_name', p_batch->>'file_hash', p_batch->>'r2_key', (p_batch->>'period_from')::date, (p_batch->>'period_to')::date,
    (p_batch->>'opening_paise')::bigint, (p_batch->>'closing_paise')::bigint, (p_batch->>'first_line_date')::date,
    (p_batch->>'last_line_date')::date, jsonb_array_length(p_lines), (p_batch->>'duplicate_count')::integer, 0, 0, 0,
    true, coalesce(p_batch->'boundaries', '[]'), '[]', (p_batch->>'imported_by')::uuid
  );
  insert into fin_bank_lines (entity_id, bank_account_id, batch_id, tran_date, value_date, narration, direction, amount_paise, balance_paise, upi_rrn, dedupe_key)
  select (p_batch->>'entity_id')::uuid, (p_batch->>'bank_account_id')::uuid, (p_batch->>'id')::uuid,
         l.tran_date, l.value_date, l.narration, l.direction, l.amount_paise, l.balance_paise, l.upi_rrn, l.dedupe_key
  from jsonb_to_recordset(p_lines) as l(tran_date date, value_date date, narration text, direction text, amount_paise bigint, balance_paise bigint, upi_rrn text, dedupe_key text);
  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

-- Store one Paytm export: the batch row and its new rows (kept and ignored), in one transaction.
create function fin_store_upi_batch(p_batch jsonb, p_lines jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare
  inserted integer;
begin
  insert into fin_import_batches (
    id, entity_id, source, bank_account_id, file_name, file_hash, r2_key, period_from, period_to, first_line_date, last_line_date,
    inserted_count, duplicate_count, ignored_count, ignored_total_paise, failed_count, chain_held, boundaries, failed_rows, imported_by
  ) values (
    (p_batch->>'id')::uuid, (p_batch->>'entity_id')::uuid, 'paytm_upi', null, p_batch->>'file_name', p_batch->>'file_hash', p_batch->>'r2_key',
    (p_batch->>'period_from')::date, (p_batch->>'period_to')::date, (p_batch->>'first_line_date')::date, (p_batch->>'last_line_date')::date,
    (p_batch->>'inserted_count')::integer, (p_batch->>'duplicate_count')::integer, (p_batch->>'ignored_count')::integer,
    (p_batch->>'ignored_total_paise')::bigint, (p_batch->>'failed_count')::integer, null, '[]', coalesce(p_batch->'failed_rows', '[]'),
    (p_batch->>'imported_by')::uuid
  );
  insert into fin_upi_lines (entity_id, batch_id, bank_account_id, paid_at, paid_time, details, counterparty, account_label, direction, amount_paise, upi_ref, order_id, remarks, tag, is_circle, ignored, ignored_reason)
  select (p_batch->>'entity_id')::uuid, (p_batch->>'id')::uuid, l.bank_account_id, l.paid_at, l.paid_time, l.details, l.counterparty, l.account_label,
         l.direction, l.amount_paise, l.upi_ref, l.order_id, l.remarks, l.tag, l.is_circle, l.ignored, l.ignored_reason
  from jsonb_to_recordset(p_lines) as l(bank_account_id uuid, paid_at date, paid_time time, details text, counterparty text, account_label text, direction text, amount_paise bigint, upi_ref text, order_id text, remarks text, tag text, is_circle boolean, ignored boolean, ignored_reason text);
  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

-- Link UPI rows to bank lines: p_links is [{ "upi_id": ..., "bank_id": ... }]. Only rows not yet linked and not ignored.
create function fin_link_upi_lines(p_links jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare
  linked integer;
begin
  update fin_upi_lines u set bank_line_id = l.bank_id
  from jsonb_to_recordset(p_links) as l(upi_id uuid, bank_id uuid)
  where u.id = l.upi_id and u.bank_line_id is null and not u.ignored;
  get diagnostics linked = row_count;
  return linked;
end;
$$;

alter table fin_import_batches enable row level security;
alter table fin_bank_lines enable row level security;
alter table fin_upi_lines enable row level security;
revoke all on fin_import_batches, fin_bank_lines, fin_upi_lines from anon, authenticated;
revoke all on function fin_bank_lines_immutable(), fin_upi_lines_link_only() from public, anon, authenticated;
revoke all on function fin_store_bank_batch(jsonb, jsonb), fin_store_upi_batch(jsonb, jsonb), fin_link_upi_lines(jsonb) from public, anon, authenticated;
grant execute on function fin_store_bank_batch(jsonb, jsonb), fin_store_upi_batch(jsonb, jsonb), fin_link_upi_lines(jsonb) to service_role;
