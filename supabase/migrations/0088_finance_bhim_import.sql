-- Finance: the BHIM UPI history (a PDF) is a second source of UPI rows beside the Paytm export.
-- Rows land in fin_upi_lines like Paytm's, tagged with the app they came from, and are joined to bank lines by the same
-- 12-digit reference. Nothing else about fin_upi_lines changes.

alter table fin_import_batches drop constraint fin_import_batches_source_check;
alter table fin_import_batches add constraint fin_import_batches_source_check check (source in ('axis_statement', 'paytm_upi', 'bhim_upi'));

-- Which UPI app the row came from. Every row held before this migration is Paytm's.
alter table fin_upi_lines add column app text not null default 'paytm' check (app in ('paytm', 'bhim'));
create index fin_upi_lines_app_paid_idx on fin_upi_lines (app, paid_at);

-- Same function as 0080, taking the batch source ('paytm_upi' when absent) and each line's app.
create or replace function fin_store_upi_batch(p_batch jsonb, p_lines jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare
  inserted integer;
begin
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
  insert into fin_upi_lines (entity_id, batch_id, bank_account_id, paid_at, paid_time, details, counterparty, account_label, direction, amount_paise, upi_ref, order_id, remarks, tag, is_circle, ignored, ignored_reason, app)
  select (p_batch->>'entity_id')::uuid, (p_batch->>'id')::uuid, l.bank_account_id, l.paid_at, l.paid_time, l.details, l.counterparty, l.account_label,
         l.direction, l.amount_paise, l.upi_ref, l.order_id, l.remarks, l.tag, l.is_circle, l.ignored, l.ignored_reason, coalesce(l.app, 'paytm')
  from jsonb_to_recordset(p_lines) as l(bank_account_id uuid, paid_at date, paid_time time, details text, counterparty text, account_label text, direction text, amount_paise bigint, upi_ref text, order_id text, remarks text, tag text, is_circle boolean, ignored boolean, ignored_reason text, app text);
  get diagnostics inserted = row_count;
  return inserted;
end;
$$;
revoke all on function fin_store_upi_batch(jsonb, jsonb) from public, anon, authenticated;
grant execute on function fin_store_upi_batch(jsonb, jsonb) to service_role;
