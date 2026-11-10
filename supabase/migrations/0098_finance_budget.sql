-- Finance module, session 07: the yearly budget and the heads the dashboards report by (docs/finance/sessions/07-dashboards-and-budget.md).
-- NOT YET APPLIED to TVC ERP. Nothing in the app reads these tables until the dashboard code is deployed, and the dashboard code
-- tolerates a year with no budget, so applying this first is safe.
--
-- Two decisions made while mocking the dashboards (2026-11-10):
--   * The budget is reported by the heads the community's yearly presentation uses: Company, Farm, Projects, Investment. A category
--     belongs to one head (`fin_categories.head`); an allocation that names a project always counts under Projects. The Opex/Capex/
--     Project buckets of DESIGN.md stay as the category *type*, a second view of the same money.
--   * Salary is shown on its own in the spending charts and as a share of spending, so a category can be flagged `is_salary`.
--
-- Tables
--   * fin_budget_years: one row per financial year and version. A version is a draft until approved; approving it supersedes the
--     previous approved version, so the year-end can be compared with the original plan. Versions are never edited once approved.
--   * fin_budget_lines: a line is one category (Opex, Capex, a revenue stream, maintenance) or one project, with an annual amount
--     in paise and an optional monthly phasing (12 amounts, April first, that must add up to the annual amount).
-- Nothing here is a real name or amount.

alter table fin_categories
  add column head text check (head in ('company', 'farm', 'projects', 'investment')),
  add column is_salary boolean not null default false;

-- The generic seeded categories (0078). The directors can change a head on the Rules page once it offers it; until then these are
-- the defaults the dashboards use. Categories that are not spending (revenue, member maintenance, interest, reimbursement,
-- transfer) have no head: the dashboards place them by type.
update fin_categories set head = 'company' where name in ('Professional fees', 'Bank charges', 'Income tax', 'GST');
update fin_categories set head = 'farm'
  where type in ('opex', 'tax') and head is null and name not in ('Professional fees', 'Bank charges', 'Income tax', 'GST');
update fin_categories set head = 'projects' where type = 'capex';
update fin_categories set head = 'investment' where type = 'sinking_fund';
update fin_categories set is_salary = true where name = 'Salaries';

create function fin_sum_paise(amounts bigint[]) returns bigint
language sql immutable as $$ select coalesce(sum(a), 0) from unnest(amounts) as a $$;

create table fin_budget_years (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references fin_entities (id),
  -- Named by the year it starts (April 2026 - March 2027 = 2026), like fin_periods.
  financial_year smallint not null,
  version smallint not null default 1 check (version >= 1),
  status text not null default 'draft' check (status in ('draft', 'approved', 'superseded')),
  approved_on date,
  note text check (note is null or length(note) <= 300),
  created_by uuid references staff_users (id),
  created_at timestamptz not null default now(),
  unique (entity_id, financial_year, version),
  check ((status = 'draft') = (approved_on is null) or status = 'superseded')
);
-- At most one approved version per year: the live one.
create unique index fin_budget_years_one_live on fin_budget_years (entity_id, financial_year) where status = 'approved';

create table fin_budget_lines (
  id uuid primary key default gen_random_uuid(),
  budget_year_id uuid not null references fin_budget_years (id) on delete cascade,
  -- A line is a category or a project, never both. A category line counts only allocations that name no project.
  category_id uuid references fin_categories (id),
  project_id uuid references fin_projects (id),
  label text not null check (length(btrim(label)) between 1 and 120),
  -- One line of explanation shown beside the line on the dashboard and in the presentation.
  comment text check (comment is null or length(comment) <= 200),
  annual_paise bigint not null check (annual_paise >= 0),
  -- Optional phasing: 12 amounts, April first. When present it must add up to the annual amount.
  monthly_paise bigint[] check (monthly_paise is null or (array_length(monthly_paise, 1) = 12 and fin_sum_paise(monthly_paise) = annual_paise)),
  sort_order smallint not null default 0,
  created_at timestamptz not null default now(),
  check ((category_id is not null) <> (project_id is not null))
);
create unique index fin_budget_lines_category_uniq on fin_budget_lines (budget_year_id, category_id) where category_id is not null;
create unique index fin_budget_lines_project_uniq on fin_budget_lines (budget_year_id, project_id) where project_id is not null;
create index fin_budget_lines_year_idx on fin_budget_lines (budget_year_id, sort_order);

-- Lines of an approved or superseded version are frozen; a change is a new version.
create function fin_budget_lines_guard() returns trigger
language plpgsql set search_path = public as $$
declare
  year_status text;
begin
  select status into year_status from fin_budget_years where id = coalesce(new.budget_year_id, old.budget_year_id);
  if year_status is distinct from 'draft' then
    raise exception 'an approved budget is never edited; start a new version';
  end if;
  return coalesce(new, old);
end;
$$;
create trigger fin_budget_lines_guard_trg before insert or update or delete on fin_budget_lines
  for each row execute function fin_budget_lines_guard();

-- Approve a draft: it becomes the live version and the previous live version is superseded, in one step. An empty budget cannot
-- be approved.
create function fin_approve_budget(p_year_id uuid, p_actor uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  yr record;
begin
  select id, entity_id, financial_year, status into yr from fin_budget_years where id = p_year_id for update;
  if not found then
    raise exception 'no such budget version';
  end if;
  if yr.status <> 'draft' then
    raise exception 'only a draft can be approved';
  end if;
  if not exists (select 1 from fin_budget_lines where budget_year_id = p_year_id) then
    raise exception 'a budget with no lines cannot be approved';
  end if;
  update fin_budget_years set status = 'superseded'
    where entity_id = yr.entity_id and financial_year = yr.financial_year and status = 'approved';
  update fin_budget_years set status = 'approved', approved_on = current_date where id = p_year_id;
end;
$$;

alter table fin_budget_years enable row level security;
alter table fin_budget_lines enable row level security;
revoke all on fin_budget_years, fin_budget_lines from anon, authenticated;
-- fin_sum_paise is a pure helper used by a check constraint, so it keeps its default execute right (a check runs as the caller).
revoke all on function fin_budget_lines_guard() from public, anon, authenticated;
revoke all on function fin_approve_budget(uuid, uuid) from public, anon, authenticated;
grant execute on function fin_approve_budget(uuid, uuid) to service_role;
