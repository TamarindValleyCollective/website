-- Finance module, session 01: foundation and access (docs/finance/DESIGN.md).
--
--   * staff_module_roles.expires_at: an optional end for a grant, used for auditors. requireStaff refuses a grant once
--     it has passed (netlify/functions/lib/staff-access.ts). Null = no end, which is every existing row.
--   * The reference tables every later finance session builds on: entity, bank accounts, categories, periods and an
--     append-only audit log. Imports, the ledger, requests and payroll come in later migrations.
--
-- Same posture as the staff tables (0028): server only. RLS is on with no policies and anon/authenticated are revoked,
-- so only the Netlify Functions (service_role) can read or write. Money columns, when they arrive, are bigint paise.
-- Every table carries entity_id so a second legal entity (a Society) can be added later without a rewrite.
-- Public repository: nothing below is a real account number, name or amount; categories are generic heads and the
-- list is a draft for the directors to confirm.

alter table staff_module_roles add column expires_at timestamptz;

create table fin_entities (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table fin_bank_accounts (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references fin_entities (id),
  label text not null,
  -- The text the Paytm UPI export uses for this account; matches an export row to the account.
  upi_label text,
  -- Last four digits only. The full number is never stored here.
  last4 text check (last4 ~ '^[0-9]{4}$'),
  -- A `cash` account has lines entered by hand and never imported.
  kind text not null check (kind in ('bank', 'fd_parent', 'cash')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (entity_id, label)
);

create table fin_categories (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references fin_entities (id),
  name text not null,
  -- The type belongs to the category, not to a ledger row.
  type text not null check (type in ('opex', 'capex', 'project', 'revenue', 'member_contribution', 'sinking_fund', 'interest', 'tax', 'reimbursement', 'transfer')),
  -- Whether the category is a line in the budget.
  budget_head boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (entity_id, name)
);

create table fin_periods (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references fin_entities (id),
  -- First day of the month the period covers.
  month date not null check (extract(day from month) = 1),
  -- The Indian financial year the month falls in, named by the year it starts (April 2025 - March 2026 = 2025).
  financial_year smallint not null,
  status text not null default 'open' check (status in ('open', 'closed')),
  closed_by uuid references staff_users (id),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (entity_id, month),
  check ((status = 'closed') = (closed_at is not null))
);

create table fin_audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  entity_id uuid references fin_entities (id),
  actor_id uuid references staff_users (id),
  action text not null,
  -- What the action was about (a table row id, an import, a period); not a foreign key, since it can point anywhere.
  target text,
  -- Ids, counts and field names only. Never account numbers, UPI IDs, names or amounts.
  detail jsonb
);
create index fin_audit_log_at_idx on fin_audit_log (at desc);

-- Append-only: the log is only useful if it can't be quietly edited.
create function fin_audit_log_immutable() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'fin_audit_log is append-only';
end;
$$;
create trigger fin_audit_log_no_update_delete
  before update or delete on fin_audit_log
  for each row execute function fin_audit_log_immutable();

alter table fin_entities enable row level security;
alter table fin_bank_accounts enable row level security;
alter table fin_categories enable row level security;
alter table fin_periods enable row level security;
alter table fin_audit_log enable row level security;
revoke all on fin_entities, fin_bank_accounts, fin_categories, fin_periods, fin_audit_log from anon, authenticated;
revoke all on function fin_audit_log_immutable() from public, anon, authenticated;

-- Seed: one entity, and a draft category list for the directors to confirm (session 01 asks whether it matches how
-- they think about heads). Types follow the design's list; "Farm Expenses" is no longer Opex in one row and Capex in another.
insert into fin_entities (name) values ('Syntropic Farm Management Pvt Ltd');

insert into fin_categories (entity_id, name, type, budget_head)
select e.id, c.name, c.type, c.budget_head
from fin_entities e
cross join (values
  ('Farm operations',               'opex',                true),
  ('Farm staff salaries',           'opex',                true),
  ('Utilities and connectivity',    'opex',                true),
  ('Repairs and maintenance',       'opex',                true),
  ('Professional and legal fees',   'opex',                true),
  ('Software and subscriptions',    'opex',                true),
  ('Bank charges',                  'opex',                false),
  ('Insurance',                     'opex',                true),
  ('Hospitality costs',             'opex',                true),
  ('Events costs',                  'project',             true),
  ('Infrastructure and construction','capex',              true),
  ('Equipment and vehicles',        'capex',               true),
  ('Land and development',          'capex',               true),
  ('Hospitality receipts',          'revenue',             true),
  ('Event receipts',                'revenue',             true),
  ('Produce and other sales',       'revenue',             true),
  ('Member maintenance',            'member_contribution', true),
  ('Member contributions',          'member_contribution', true),
  ('Sinking fund deposits',         'sinking_fund',        false),
  ('Interest income',               'interest',            false),
  ('Taxes and statutory dues',      'tax',                 true),
  ('Reimbursements',                'reimbursement',       false),
  ('Transfers between accounts',    'transfer',            false)
) as c(name, type, budget_head)
where e.name = 'Syntropic Farm Management Pvt Ltd';
