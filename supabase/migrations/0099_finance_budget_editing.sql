-- Finance module, session 07: what the budget editor needs (docs/finance/FINANCE.md, "Dashboards" and "The budget editor").
-- NOT YET APPLIED to TVC ERP. Additive: one index and two functions; nothing existing changes. The editor needs it to save (reading a budget
-- and the dashboards do not).
--
--   * One draft per financial year at a time (a partial unique index), so two people cannot be editing two drafts of the same year.
--   * fin_start_budget_draft: creates the next version of a year as a draft, optionally copying the lines of another version. Copying a
--     version of the SAME year keeps its project lines; copying from ANOTHER year keeps only category lines (a project belongs to one year).
--   * fin_save_budget_lines: replaces all lines of a draft in one step (a delete and an insert that either both happen or neither does),
--     and sets the version's note. Only a draft can be saved; an approved version is frozen by fin_budget_lines_guard (0098).
-- Both are service-role only, like fin_approve_budget. Nothing here is a real name or amount.

create unique index fin_budget_years_one_draft on fin_budget_years (entity_id, financial_year) where status = 'draft';

create function fin_start_budget_draft(p_entity uuid, p_fy smallint, p_from uuid, p_actor uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  next_version smallint;
  new_id uuid;
  src record;
begin
  select coalesce(max(version), 0) + 1 into next_version from fin_budget_years where entity_id = p_entity and financial_year = p_fy;
  insert into fin_budget_years (entity_id, financial_year, version, status, created_by)
    values (p_entity, p_fy, next_version, 'draft', p_actor)
    returning id into new_id;
  if p_from is not null then
    select id, entity_id, financial_year into src from fin_budget_years where id = p_from;
    if not found or src.entity_id <> p_entity then
      raise exception 'no such budget version to copy';
    end if;
    insert into fin_budget_lines (budget_year_id, category_id, project_id, label, comment, annual_paise, monthly_paise, sort_order)
      select new_id, l.category_id, l.project_id, l.label, l.comment, l.annual_paise, l.monthly_paise, l.sort_order
      from fin_budget_lines l
      where l.budget_year_id = p_from and (src.financial_year = p_fy or l.project_id is null);
  end if;
  return new_id;
end;
$$;

create function fin_save_budget_lines(p_year_id uuid, p_lines jsonb, p_note text, p_actor uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare
  yr record;
  saved integer;
begin
  select id, status into yr from fin_budget_years where id = p_year_id for update;
  if not found then
    raise exception 'no such budget version';
  end if;
  if yr.status <> 'draft' then
    raise exception 'only a draft can be edited';
  end if;
  delete from fin_budget_lines where budget_year_id = p_year_id;
  insert into fin_budget_lines (budget_year_id, category_id, project_id, label, comment, annual_paise, sort_order)
    select p_year_id, r.category_id, r.project_id, btrim(r.label), nullif(btrim(coalesce(r.comment, '')), ''), r.annual_paise, coalesce(r.sort_order, 0)
    from jsonb_to_recordset(p_lines) as r(category_id uuid, project_id uuid, label text, comment text, annual_paise bigint, sort_order smallint);
  get diagnostics saved = row_count;
  update fin_budget_years set note = nullif(btrim(coalesce(p_note, '')), '') where id = p_year_id;
  return saved;
end;
$$;

revoke all on function fin_start_budget_draft(uuid, smallint, uuid, uuid) from public, anon, authenticated;
revoke all on function fin_save_budget_lines(uuid, jsonb, text, uuid) from public, anon, authenticated;
grant execute on function fin_start_budget_draft(uuid, smallint, uuid, uuid) to service_role;
grant execute on function fin_save_budget_lines(uuid, jsonb, text, uuid) to service_role;
