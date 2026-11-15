-- Finance module: UPI operators (docs/finance/FINANCE.md, "UPI operators" and "Channels").
-- NOT YET APPLIED to TVC ERP. Tested on the real data on 2026-11-15 inside a transaction that was rolled back: all 128 UPI rows and the one
-- delegate got the operator, the link-only trigger was enabled again, the table was RLS-on with no anon/authenticated read, and a batch with
-- no operator was refused. Apply, then check: both tables RLS-on with no anon/authenticated grants; every fin_upi_lines and
-- fin_delegates row has an operator; fin_store_upi_batch refuses a batch with no operator.
--
-- All UPI payments go out through the UPI setup of one of the account's operators (the people who can add the account to their UPI apps).
-- Each operator's UPI payments are either made by the operator directly or by the delegates of that operator's UPI circle. Until now nothing said
-- WHOSE UPI a payment went through (the Paytm and BHIM exports are in the operator's name, and the row never recorded which operator).
-- This adds the operator: to each UPI row, set when its file is imported (the import asks whose UPI the file is, with a suggestion), and to each
-- delegate (a delegate belongs to one operator's circle).
--
-- Operators are people the finance module knows by a name an admin types; no name or number is in this repository. The one operator created
-- here is a placeholder ("First operator") that every UPI row and delegate held so far is assigned to, because they all came from the first
-- operator's UPI; an admin renames it on the UPI page. `signatures` remembers what an operator's exports looked like (the Paytm export's account
-- list, the BHIM sender id), so the next file with the same signature is suggested to that operator. It is a suggestion; the import always asks.
--
-- fin_upi_lines is link-only (a trigger refuses any change but bank_line_id), so the backfill disables that trigger for the one update and
-- turns it back on in the same transaction.

create table fin_upi_operators (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references fin_entities (id),
  display_name text not null check (length(display_name) between 2 and 60),
  signatures text[] not null default '{}',
  created_by uuid references staff_users (id),
  created_at timestamptz not null default now(),
  unique (entity_id, display_name)
);
alter table fin_upi_operators enable row level security;
revoke all on fin_upi_operators from anon, authenticated;

-- the first operator: everything held so far is theirs
insert into fin_upi_operators (entity_id, display_name)
select id, 'First operator' from fin_entities order by created_at limit 1;

alter table fin_upi_lines add column operator_id uuid references fin_upi_operators (id);
alter table fin_upi_lines disable trigger fin_upi_lines_link_only;
update fin_upi_lines set operator_id = (select id from fin_upi_operators order by created_at limit 1) where operator_id is null;
alter table fin_upi_lines enable trigger fin_upi_lines_link_only;
alter table fin_upi_lines alter column operator_id set not null;
create index fin_upi_lines_operator_idx on fin_upi_lines (operator_id);

alter table fin_delegates add column operator_id uuid references fin_upi_operators (id);
update fin_delegates set operator_id = (select id from fin_upi_operators order by created_at limit 1) where operator_id is null;
alter table fin_delegates alter column operator_id set not null;
create index fin_delegates_operator_idx on fin_delegates (operator_id);

-- Same function as 0088, taking the operator whose UPI the file is (required) and storing it on every row.
create or replace function fin_store_upi_batch(p_batch jsonb, p_lines jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare
  inserted integer;
begin
  if (p_batch->>'operator_id') is null then
    raise exception 'a UPI batch needs the operator whose UPI it is';
  end if;
  insert into fin_import_batches (
    id, entity_id, source, bank_account_id, file_name, file_hash, r2_key, period_from, period_to, first_line_date, last_line_date,
    inserted_count, duplicate_count, ignored_count, ignored_total_paise, failed_count, chain_held, boundaries, failed_rows, imported_by
  ) values (
    (p_batch->>'id')::uuid, (p_batch->>'entity_id')::uuid, coalesce(p_batch->>'source', 'paytm_upi'), null, p_batch->>'file_name', p_batch->>'file_hash', p_batch->>'r2_key',
    (p_batch->>'period_from')::date, (p_batch->>'period_to')::date, (p_batch->>'first_line_date')::date, (p_batch->>'last_line_date')::date,
    (p_batch->>'inserted_count')::integer, (p_batch->>'duplicate_count')::integer, (p_batch->>'ignored_count')::integer,
    (p_batch->>'ignored_total_paise')::bigint, (p_batch->>'failed_count')::integer, null, '[]', coalesce(p_batch->'failed_rows', '[]'),
    (p_batch->>'imported_by')::uuid
  );
  insert into fin_upi_lines (entity_id, batch_id, bank_account_id, paid_at, paid_time, details, counterparty, account_label, direction, amount_paise, upi_ref, order_id, remarks, tag, is_circle, ignored, ignored_reason, app, operator_id)
  select (p_batch->>'entity_id')::uuid, (p_batch->>'id')::uuid, l.bank_account_id, l.paid_at, l.paid_time, l.details, l.counterparty, l.account_label,
         l.direction, l.amount_paise, l.upi_ref, l.order_id, l.remarks, l.tag, l.is_circle, l.ignored, l.ignored_reason, coalesce(l.app, 'paytm'), (p_batch->>'operator_id')::uuid
  from jsonb_to_recordset(p_lines) as l(bank_account_id uuid, paid_at date, paid_time time, details text, counterparty text, account_label text, direction text, amount_paise bigint, upi_ref text, order_id text, remarks text, tag text, is_circle boolean, ignored boolean, ignored_reason text, app text);
  get diagnostics inserted = row_count;
  return inserted;
end;
$$;
revoke all on function fin_store_upi_batch(jsonb, jsonb) from public, anon, authenticated;
grant execute on function fin_store_upi_batch(jsonb, jsonb) to service_role;
