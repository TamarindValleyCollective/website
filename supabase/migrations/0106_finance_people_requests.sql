-- Finance session 09a: people-change requests (docs/finance/sessions/09-payroll.md, "Plan for the next slices").
-- Applied to TVC ERP on 2026-11-17 (as finance_people_requests). Do not edit it now; a change is a new migration.
--
-- The farm manager decides who joins and who leaves, so each change starts as a request from him and a director signs it off. Adding the
-- person as a Party stays a separate step done by someone else. Approving a joining request puts the person on payroll from the start
-- month (fin_employees, with the automatic number from 0105); approving a leaving request sets the last month to pay. Whoever raised a
-- request never decides it (a check constraint, not only the screen).
--
--   * fin_employees.start_month / last_month: the first and last month the person is paid by a run; null means no limit on that side
--     (everyone on payroll before this migration has neither). A leaver stays a row, so their number is never reused.
--   * fin_people_requests: kind 'join' (name, optional role and agreed monthly pay, start month) or 'leave' (the employee, the last
--     month to pay, an optional reason). Bank details are a later slice and are not collected here.
--
-- Same posture as the other fin_ tables (0077): RLS on with no policies, anon/authenticated revoked, service role only.
-- Public repository: nothing here is a real name, number or amount.

alter table fin_employees
  add column start_month date check (start_month is null or extract(day from start_month) = 1),
  add column last_month date check (last_month is null or extract(day from last_month) = 1),
  add constraint fin_employees_months_check check (start_month is null or last_month is null or last_month >= start_month);

create table fin_people_requests (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references fin_entities (id),
  kind text not null check (kind in ('join', 'leave')),
  status text not null default 'requested' check (status in ('requested', 'approved', 'rejected', 'cancelled')),
  -- Joining: who, in what role, from which month, at what agreed monthly pay (whole rupees, as paise).
  person_name text check (person_name is null or length(person_name) between 2 and 100),
  role_title text check (role_title is null or length(role_title) between 2 and 60),
  start_month date check (start_month is null or extract(day from start_month) = 1),
  agreed_pay_paise bigint check (agreed_pay_paise is null or (agreed_pay_paise > 0 and agreed_pay_paise % 100 = 0)),
  -- Leaving: the employee and the last month to pay. For a joining request this is set to the new employee when it is approved.
  employee_id uuid references fin_employees (id),
  last_month date check (last_month is null or extract(day from last_month) = 1),
  reason text check (reason is null or length(reason) <= 200),
  requested_by uuid not null references staff_users (id),
  decided_by uuid references staff_users (id),
  decided_at timestamptz,
  decision_note text check (decision_note is null or length(decision_note) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (kind <> 'join' or (person_name is not null and start_month is not null and last_month is null)),
  check (kind <> 'leave' or (employee_id is not null and last_month is not null and person_name is null and start_month is null and agreed_pay_paise is null)),
  check (kind <> 'join' or status = 'approved' or employee_id is null),
  check (kind <> 'join' or status <> 'approved' or employee_id is not null),
  check (decided_by is null or decided_by <> requested_by),
  check ((status in ('approved', 'rejected')) = (decided_by is not null and decided_at is not null))
);
-- One open leaving request per person.
create unique index fin_people_requests_open_leave_idx on fin_people_requests (employee_id) where kind = 'leave' and status = 'requested';
create index fin_people_requests_status_idx on fin_people_requests (entity_id, status, created_at desc);

alter table fin_people_requests enable row level security;
revoke all on fin_people_requests from anon, authenticated;
