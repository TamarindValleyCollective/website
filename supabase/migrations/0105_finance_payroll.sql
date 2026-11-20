-- Finance session 09a: payroll runs and the salary bulk-payment batch (docs/finance/sessions/09-payroll.md).
-- Applied to TVC ERP on 2026-11-17 (as finance_payroll). Do not edit it now; a change is a new migration.
--
-- 09a records and pays a month's salary; 09b (attendance, rates, advances) comes later, so the optional columns on a line
-- (agreed pay, days worked, advance deducted) exist now only so nothing has to be re-entered then.
--
--   * fin_employees: a party who is paid a salary, with an employee number assigned automatically. A party of kind 'employee'.
--   * fin_payment_batches: the generated bank file for one run (kind 'salary'; 'vendor' is reserved for session 08's bulk file). Holds
--     the file's hash and private-R2 key, never the file or any account number. Status moves forward only.
--   * fin_payroll_runs: one month. draft -> confirmed (the farm manager, who entered it) -> file_generated (the preparer) ->
--     approved (a different director, who approves at the bank) -> settled (the bank debit is matched). A run can be cancelled
--     before it is approved.
--   * fin_payroll_lines: one person in one run. Holds a SNAPSHOT of the payee account paid (the account row, its last four and its
--     fingerprint) so a later account change cannot rewrite what was paid; the net in whole rupees; and the bank reference
--     (<YYYY>-<Mon>-Employee-<nnn>, with Bonus- before Employee for a bonus run) that ties the line to the file.
--
-- Regenerating: the portal rejects a past payment date, so a file not uploaded by its date is dead. The run goes back from
-- file_generated to confirmed (its batch is set to cancelled, which only the function does, and only before upload), the date is
-- changed, and the file is generated again; lines may be re-snapshotted then because the guard allows it in 'confirmed'.
--
-- Rules enforced here, not only in the screens: the preparer cannot approve (maker is not checker); the net is whole rupees; a
-- person appears once per run; a reference appears once per run; money is bigint paise.
--
-- Same posture as the other fin_ tables (0077): RLS on with no policies, anon/authenticated revoked, service role only.
-- Public repository: nothing here is a real name, number or amount.

create table fin_employees (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references fin_entities (id),
  party_id uuid not null references fin_parties (id),
  -- The employee number: assigned on insert as the next number up (below), never reused (a person who leaves stays here, inactive), and it
  -- is the 'nnn' in the file's reference column. A number may be given explicitly only to carry over an old one.
  roll_no text not null check (roll_no ~ '^[1-9][0-9]{0,5}$'),
  active boolean not null default true,
  created_by uuid references staff_users (id),
  created_at timestamptz not null default now(),
  unique (entity_id, party_id)
);
create unique index fin_employees_roll_idx on fin_employees (entity_id, roll_no);
create function fin_employees_assign_roll() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.roll_no is null then
    perform pg_advisory_xact_lock(hashtext('fin_employees_roll:' || new.entity_id::text));
    select (coalesce(max(roll_no::int), 0) + 1)::text into new.roll_no from public.fin_employees where entity_id = new.entity_id;
  end if;
  return new;
end;
$$;
create trigger fin_employees_assign_roll before insert on fin_employees for each row execute function fin_employees_assign_roll();

create table fin_payment_batches (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references fin_entities (id),
  kind text not null check (kind in ('vendor', 'salary')),
  status text not null default 'file_generated' check (status in ('file_generated', 'uploaded', 'approved_at_bank', 'settled', 'cancelled')),
  -- The bank's mode for column A of the file: N (NEFT) or I.
  payment_mode text not null default 'N' check (payment_mode in ('N', 'I')),
  payment_date date not null,
  total_paise bigint not null check (total_paise > 0),
  line_count integer not null check (line_count > 0),
  -- SHA-256 of the file as generated, and its key in the private R2 bucket (finance/payroll/<id>.xlsx).
  file_hash text not null check (file_hash ~ '^[0-9a-f]{64}$'),
  r2_key text not null,
  prepared_by uuid not null references staff_users (id),
  prepared_at timestamptz not null default now(),
  uploaded_at timestamptz,
  -- The second director, who approves in the bank's portal and marks it here. Never the preparer.
  approved_by uuid references staff_users (id),
  approved_at timestamptz,
  -- The one bank debit that settled the batch.
  bank_line_id uuid references fin_bank_lines (id),
  settled_at timestamptz,
  created_at timestamptz not null default now(),
  check (approved_by is null or approved_by <> prepared_by),
  check ((approved_by is null) = (approved_at is null)),
  check (status not in ('approved_at_bank', 'settled') or approved_by is not null),
  check ((status = 'settled') = (bank_line_id is not null and settled_at is not null))
);
create unique index fin_payment_batches_bank_line_idx on fin_payment_batches (bank_line_id) where bank_line_id is not null;

create table fin_payroll_runs (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references fin_entities (id),
  -- First day of the salary month.
  month date not null check (extract(day from month) = 1),
  -- A month holds one salary run and any number of differently named bonus runs (e.g. 'Diwali Bonus'; the Oct 2025 files had both).
  run_type text not null default 'salary' check (run_type in ('salary', 'bonus')),
  label text check (label is null or length(label) between 2 and 40),
  status text not null default 'draft' check (status in ('draft', 'confirmed', 'file_generated', 'approved', 'settled', 'cancelled')),
  payment_mode text not null default 'N' check (payment_mode in ('N', 'I')),
  -- Defaults to the 1st of the following month; kept on the run so the file and the validation agree.
  payment_date date not null,
  entered_by uuid not null references staff_users (id),
  confirmed_by uuid references staff_users (id),
  confirmed_at timestamptz,
  -- The preparer (a director) who generated the file; the batch holds the same person.
  prepared_by uuid references staff_users (id),
  batch_id uuid references fin_payment_batches (id),
  approved_by uuid references staff_users (id),
  approved_at timestamptz,
  settled_at timestamptz,
  cancelled_reason text check (cancelled_reason is null or length(cancelled_reason) between 3 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((run_type = 'bonus') = (label is not null)),
  check (approved_by is null or approved_by <> prepared_by),
  check (status not in ('confirmed', 'file_generated', 'approved', 'settled') or (confirmed_by is not null and confirmed_at is not null)),
  check (status not in ('file_generated', 'approved', 'settled') or (prepared_by is not null and batch_id is not null)),
  check (status not in ('approved', 'settled') or (approved_by is not null and approved_at is not null)),
  check ((status = 'settled') = (settled_at is not null)),
  check ((status = 'cancelled') = (cancelled_reason is not null))
);
-- One live run per month per type and name; a cancelled run does not block a fresh one.
create unique index fin_payroll_runs_month_idx on fin_payroll_runs (entity_id, month, run_type, coalesce(label, '')) where status <> 'cancelled';

create table fin_payroll_lines (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references fin_payroll_runs (id),
  employee_id uuid not null references fin_employees (id),
  -- Whole rupees, as paise. This settles the rounding of the payout, not of any per-day rate.
  net_paise bigint not null check (net_paise > 0 and net_paise % 100 = 0),
  -- Optional inputs 09b will use; entered only if the farm manager wants them kept.
  agreed_pay_paise bigint check (agreed_pay_paise is null or agreed_pay_paise > 0),
  days_worked numeric(4, 1) check (days_worked is null or (days_worked >= 0 and days_worked <= 31)),
  advance_deducted_paise bigint check (advance_deducted_paise is null or advance_deducted_paise >= 0),
  -- Snapshot of the payee account paid, taken when the file is generated. Null until then.
  party_account_id uuid references fin_party_accounts (id),
  account_last4 text check (account_last4 is null or length(account_last4) = 4),
  account_fingerprint text,
  -- <YYYY>-<Mon>-Employee-<nnn> (<YYYY>-<Mon>-Bonus-Employee-<nnn> for a bonus run), nnn being the person's employee number; assigned when the file is generated and written to column I.
  reference text,
  -- The allocation created when the bank debit is matched (one per person, source 'payroll').
  allocation_id uuid references fin_allocations (id),
  -- Set when the bank returns this one payment; the refund is that person's allocation reversed.
  returned_at timestamptz,
  created_at timestamptz not null default now(),
  unique (run_id, employee_id),
  check ((party_account_id is null) = (account_fingerprint is null and account_last4 is null)),
  check (reference is null or reference ~ '^[0-9]{4}-[A-Z][a-z]{2}-(Bonus-)?Employee-[0-9]{3,6}$')
);
create unique index fin_payroll_lines_reference_idx on fin_payroll_lines (run_id, reference) where reference is not null;
create index fin_payroll_lines_employee_idx on fin_payroll_lines (employee_id);

-- Once the file is generated the amounts, and the account snapshot, are history: only the allocation link and a return may
-- be set afterwards. Lines are never deleted once their run has left draft.
create function fin_payroll_lines_guard() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  run_status text;
begin
  select status into run_status from public.fin_payroll_runs where id = coalesce(new.run_id, old.run_id);
  if tg_op = 'DELETE' then
    if run_status <> 'draft' then
      raise exception 'a payroll line cannot be deleted once the run has been confirmed';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    if run_status <> 'draft' then
      raise exception 'lines can only be added to a draft run';
    end if;
    return new;
  end if;
  if run_status not in ('draft', 'confirmed')
     and (new.net_paise is distinct from old.net_paise
          or new.employee_id is distinct from old.employee_id
          or new.run_id is distinct from old.run_id
          or new.party_account_id is distinct from old.party_account_id
          or new.account_last4 is distinct from old.account_last4
          or new.account_fingerprint is distinct from old.account_fingerprint
          or new.reference is distinct from old.reference) then
    raise exception 'a payroll line is fixed once the file has been generated';
  end if;
  return new;
end;
$$;
create trigger fin_payroll_lines_guard_trg
  before insert or update or delete on fin_payroll_lines
  for each row execute function fin_payroll_lines_guard();

alter table fin_employees enable row level security;
alter table fin_payment_batches enable row level security;
alter table fin_payroll_runs enable row level security;
alter table fin_payroll_lines enable row level security;
revoke all on fin_employees, fin_payment_batches, fin_payroll_runs, fin_payroll_lines from anon, authenticated;
revoke all on function fin_payroll_lines_guard() from public, anon, authenticated;
revoke all on function fin_employees_assign_roll() from public, anon, authenticated;
