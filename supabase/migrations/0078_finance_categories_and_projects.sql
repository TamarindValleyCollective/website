-- Finance module, session 01 follow-up: the category list as TVC's budget actually works, and projects.
-- Replaces the placeholder categories seeded by 0077 (nothing references them yet) after reading the structure of the
-- current Google Sheet (the "Lists" tab and the tracker's Details/Type columns). Public repository: only generic
-- heads and invented examples below; no vendors, people or amounts.
--
-- How the budget buckets work (docs/finance/DESIGN.md, "Buckets, categories and projects"):
--   * An allocation lands in one bucket. If it names a project the bucket is Project; otherwise it is the type of its
--     category (Opex, Capex, revenue ...). So `project` is no longer a category type.
--   * A category says what the money was for (nature). Small items the farm does not budget one by one (a sickle,
--     fence poles) are Opex by choosing an Opex category, not by a per-row decision.
--   * A project is an explicit, approved plan with an owner (a name) and a breakdown of planned amounts; an event is a
--     profit-and-loss view only (receipts against costs) with no approval or breakdown.
--   * Equity is deliberately not here (decided later, once the data is imported).

-- Nothing references fin_categories yet (no allocations exist), so the draft seed can be replaced outright. This comes
-- first because the old seed has a row of type 'project', which the stricter check below would reject.
delete from fin_categories;

-- 'project' is no longer a category type (a project is its own record).
alter table fin_categories drop constraint fin_categories_type_check;
alter table fin_categories add constraint fin_categories_type_check
  check (type in ('opex', 'capex', 'revenue', 'member_contribution', 'sinking_fund', 'interest', 'tax', 'reimbursement', 'transfer'));

insert into fin_categories (entity_id, name, type, budget_head)
select e.id, c.name, c.type, c.budget_head
from fin_entities e
cross join (values
  -- Opex: regular running costs, including small items set aside for in the yearly calculation
  ('Salaries',                       'opex',                true),
  ('Groceries',                      'opex',                true),
  ('Petty cash',                     'opex',                true),
  ('Materials and supplies',         'opex',                true),
  ('Tools and small equipment',      'opex',                true),
  ('Labour and contractors',         'opex',                true),
  ('Utility bills',                  'opex',                true),
  ('Software and subscriptions',     'opex',                true),
  ('Professional fees',              'opex',                true),
  ('Bank charges',                   'opex',                false),
  ('Rental services',                'opex',                true),
  ('Insurance',                      'opex',                true),
  ('Operational and miscellaneous',  'opex',                true),
  -- Capex: one-time purchases of lasting items
  ('Equipment and machinery',        'capex',               true),
  ('Power connection and electrical','capex',               true),
  ('Plantation and nursery',         'capex',               true),
  ('Structures and infrastructure',  'capex',               true),
  -- Revenue: by stream, each projected in the yearly budget
  ('Hospitality receipts',           'revenue',             true),
  ('Event receipts',                 'revenue',             true),
  ('Produce sales',                  'revenue',             true),
  ('Other income',                   'revenue',             true),
  -- Member money, tax, and movements that are not income or spend
  ('Member maintenance',             'member_contribution', true),
  ('Land and local taxes',           'tax',                 true),
  ('Income tax',                     'tax',                 true),
  ('GST',                            'tax',                 true),
  ('Sinking fund deposits',          'sinking_fund',        false),
  ('Interest income',                'interest',            false),
  ('Reimbursements',                 'reimbursement',       false),
  ('Transfers between accounts',     'transfer',            false)
) as c(name, type, budget_head)
where e.name = 'Syntropic Farm Management Pvt Ltd';

-- Projects and events. A project is planned, presented to the community and approved before the budget, has an owner
-- (a name only, not a sign-in) and a breakdown; budget vs actual is reported per project and per component. An event
-- is tracked for profit and loss only, so it has no owner, approval or breakdown.
create table fin_projects (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references fin_entities (id),
  name text not null,
  kind text not null check (kind in ('project', 'event')),
  -- The Indian financial year it belongs to, named by the year it starts (April 2025 - March 2026 = 2025).
  financial_year smallint not null,
  -- A name written on the project, for the reports. Not linked to anyone's account.
  owner_name text,
  approved_on date,
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'active', 'completed', 'cancelled')),
  notes text,
  created_at timestamptz not null default now(),
  unique (entity_id, financial_year, name),
  -- Only projects carry an owner and an approval; events do not.
  check (kind = 'project' or (owner_name is null and approved_on is null))
);

-- The planned breakdown of a project: each line has a planned amount (bigint paise) and the category the money
-- will be spent under, so a project's actuals can be compared line by line.
create table fin_project_lines (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references fin_projects (id) on delete cascade,
  name text not null,
  category_id uuid not null references fin_categories (id),
  planned_paise bigint not null check (planned_paise >= 0),
  sort_order smallint not null default 0,
  created_at timestamptz not null default now(),
  unique (project_id, name)
);

alter table fin_projects enable row level security;
alter table fin_project_lines enable row level security;
revoke all on fin_projects, fin_project_lines from anon, authenticated;
