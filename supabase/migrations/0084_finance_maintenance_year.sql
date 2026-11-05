-- Finance module, session 06: what a member-maintenance payment is FOR (docs/finance/sessions/06-history-load.md).
-- Applied to TVC ERP on 2026-11-05 (recorded as finance_maintenance_year); checked afterwards: both columns nullable, the format check and
-- the index present, fin_save_allocations carries the new fields and is still service-role only, existing data unchanged.
--
-- A maintenance payment does not always arrive in the financial year it belongs to: members sometimes pay a previous year's maintenance late.
-- The tracker's label says which year ("Maintenance (24-25)"), and that must survive, so the payment can be set against that member's
-- outstanding for THAT year and the outstanding is reported correctly (session 10 builds the dues and statements on top of this).
--
--   * fin_allocations.maintenance_year: the maintenance year a payment is for, named like the financial year ('2024-25'). It is separate
--     from `period`, which stays the month the money moved (cash basis plus cut-off) however late it was.
--   * fin_allocations.household_id: the member household the payment is against (the payer is not always the household's own member party).
--   * fin_save_allocations carries both (same signature; the app, which does not set them yet, passes nothing and gets null).
--
-- Both are set when a row is inserted and, like everything else on a posted row, then frozen: re-attributing a payment is a reversal and a new
-- allocation. Nothing here is a real name, number or amount.

alter table fin_allocations add column household_id uuid references member_households (id);
alter table fin_allocations add column maintenance_year text check (maintenance_year ~ '^[0-9]{4}-[0-9]{2}$');
create index fin_allocations_household_idx on fin_allocations (household_id, maintenance_year) where household_id is not null;

create or replace function fin_save_allocations(p_line_id uuid, p_rows jsonb, p_actor uuid, p_post boolean, p_override boolean default false)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  line record;
  total bigint;
  closed_month date;
  saved integer;
begin
  select id, entity_id, amount_paise into line from fin_bank_lines where id = p_line_id for update;
  if not found then
    raise exception 'no such bank line';
  end if;
  if exists (select 1 from fin_allocations where bank_line_id = p_line_id and posted_at is not null) then
    raise exception 'this line is already posted; reverse an allocation to correct it';
  end if;

  select min(r.period) into closed_month
    from jsonb_to_recordset(p_rows) as r(period date)
    join fin_periods p on p.entity_id = line.entity_id and p.month = r.period and p.status = 'closed';
  if closed_month is not null and not p_override then
    raise exception 'that month is closed';
  end if;

  delete from fin_allocations where bank_line_id = p_line_id and posted_at is null;

  insert into fin_allocations (entity_id, bank_line_id, party_id, category_id, project_id, amount_paise, period, nature, remarks, source,
                               rule_id, review_state, review_reason, reverses_allocation_id, reversal_reason, household_id, maintenance_year, created_by)
  select line.entity_id, p_line_id, r.party_id, r.category_id, r.project_id, r.amount_paise, r.period, r.nature, r.remarks, r.source,
         r.rule_id, coalesce(r.review_state, 'ok'), r.review_reason, r.reverses_allocation_id, r.reversal_reason, r.household_id, r.maintenance_year, p_actor
  from jsonb_to_recordset(p_rows) as r(party_id uuid, category_id uuid, project_id uuid, amount_paise bigint, period date, nature text,
                                       remarks text, source text, rule_id uuid, review_state text, review_reason text,
                                       reverses_allocation_id uuid, reversal_reason text, household_id uuid, maintenance_year text);
  get diagnostics saved = row_count;

  if p_post then
    select coalesce(sum(amount_paise), 0) into total from fin_allocations where bank_line_id = p_line_id;
    if total <> line.amount_paise then
      raise exception 'the allocations must add up to the line before it can be posted';
    end if;
    update fin_allocations set posted_at = now() where bank_line_id = p_line_id and posted_at is null;
  end if;
  return saved;
end;
$$;

revoke all on function fin_save_allocations(uuid, jsonb, uuid, boolean, boolean) from public, anon, authenticated;
grant execute on function fin_save_allocations(uuid, jsonb, uuid, boolean, boolean) to service_role;
