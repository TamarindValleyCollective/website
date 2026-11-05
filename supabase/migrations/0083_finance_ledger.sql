-- Finance module, session 05: the ledger (docs/finance/sessions/05-ledger-and-review.md). NOT yet applied to TVC ERP.
--
--   * fin_allocations: explain a bank line. A line has one or more; their amounts are always positive and the direction is
--     the line's. A line is posted when its allocations add up to it exactly; until then they are drafts that the same
--     person (or another) may replace. Once posted a row never changes except for its review fields: a correction is a
--     NEW row that reverses it (reverses_allocation_id, on a line that moves money the other way: a refund).
--   * fin_rules: priority-ordered categorisation rules (matcher JSON, see scripts/lib/finance-rules.mjs).
--   * fin_vouchers: the table only (bills); the capture screen is session 08.
--   * Three guards that do not trust the application: a deferred constraint trigger (the rows of a line never add up to
--     more than the line, and a posted line adds up to exactly the line), an immutability trigger (posted rows are
--     frozen apart from review fields) and a reversal trigger (opposite direction, never more than what is left).
--   * fin_save_allocations: replaces a line's draft rows with new ones and optionally posts, in one transaction, taking a
--     lock on the line so two people cannot post at once. A closed month needs p_override (the app has already checked
--     `close-period` and a reason; the database only refuses a closed month with no override).
--   * fin_close_period: marks a month closed.
--
-- Same posture as the other fin_ tables (0077): RLS on with no policies, anon/authenticated revoked, service role only.
-- Public repository: nothing here is a real name, number or amount.

create table fin_rules (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references fin_entities (id),
  -- Lower runs first; ties go to the older rule.
  priority smallint not null default 100 check (priority between 1 and 1000),
  -- narrationContains, payeeVpa, remarkKeywords[], direction, minPaise, maxPaise. All stated conditions must hold.
  matcher jsonb not null check (jsonb_typeof(matcher) = 'object' and matcher <> '{}'::jsonb),
  party_id uuid references fin_parties (id),
  category_id uuid not null references fin_categories (id),
  -- May use {counterparty} and {remark}. Empty = use the UPI remark.
  nature_template text not null default '',
  -- Lines this rule explains always go to the review queue.
  needs_review boolean not null default false,
  hit_count integer not null default 0,
  active boolean not null default true,
  created_by uuid references staff_users (id),
  created_at timestamptz not null default now()
);
create index fin_rules_entity_idx on fin_rules (entity_id, priority) where active;

create table fin_allocations (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references fin_entities (id),
  bank_line_id uuid not null references fin_bank_lines (id),
  party_id uuid references fin_parties (id),
  category_id uuid not null references fin_categories (id),
  -- Names a project (or event) when the money belongs to one; then the budget bucket is Project.
  project_id uuid references fin_projects (id),
  -- Always positive; the direction is the bank line's.
  amount_paise bigint not null check (amount_paise > 0),
  -- First day of the month the cost belongs to (cash basis plus cut-off).
  period date not null check (extract(day from period) = 1),
  nature text not null check (length(btrim(nature)) > 0),
  remarks text,
  source text not null check (source in ('rule', 'manual', 'upi_remark', 'request', 'payroll', 'import')),
  rule_id uuid references fin_rules (id),
  review_state text not null default 'ok' check (review_state in ('ok', 'needs_review', 'flagged')),
  -- Comma-separated reason keys (scripts/lib/finance-rules.mjs, REVIEW_REASONS); never a name or amount.
  review_reason text,
  reviewed_by uuid references staff_users (id),
  reviewed_at timestamptz,
  -- Set on a refund or correction: the earlier allocation this one undoes (in whole or part), and why.
  reverses_allocation_id uuid references fin_allocations (id),
  reversal_reason text,
  created_by uuid references staff_users (id),
  created_at timestamptz not null default now(),
  -- Null while a draft; set for every row of a line at the moment it is posted.
  posted_at timestamptz,
  check ((reverses_allocation_id is null) = (reversal_reason is null))
);
create index fin_allocations_line_idx on fin_allocations (bank_line_id);
create index fin_allocations_period_idx on fin_allocations (entity_id, period);
create index fin_allocations_party_idx on fin_allocations (party_id) where party_id is not null;
create index fin_allocations_review_idx on fin_allocations (review_state) where review_state <> 'ok';
create index fin_allocations_reverses_idx on fin_allocations (reverses_allocation_id) where reverses_allocation_id is not null;

create table fin_vouchers (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references fin_entities (id),
  allocation_id uuid references fin_allocations (id),
  -- Key of the scan in the private R2 bucket.
  r2_key text not null,
  page_count smallint not null default 1 check (page_count > 0),
  mime text not null,
  -- What was read from the scan (vendor, date, amount), when it was.
  extracted jsonb,
  created_by uuid references staff_users (id),
  created_at timestamptz not null default now()
);
create index fin_vouchers_allocation_idx on fin_vouchers (allocation_id) where allocation_id is not null;

-- ---- Guards -------------------------------------------------------------------------------------------------------

-- A posted row is frozen apart from its review fields. A draft may be deleted (replacing a draft); a posted row never.
create function fin_allocations_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if old.posted_at is not null then
      raise exception 'a posted allocation is never deleted; reverse it instead';
    end if;
    return old;
  end if;
  if old.posted_at is not null then
    if (to_jsonb(new) - 'review_state' - 'review_reason' - 'reviewed_by' - 'reviewed_at')
       is distinct from (to_jsonb(old) - 'review_state' - 'review_reason' - 'reviewed_by' - 'reviewed_at') then
      raise exception 'a posted allocation cannot be changed; reverse it instead';
    end if;
  elsif new.posted_at is null and old.posted_at is not null then
    raise exception 'a posted allocation cannot be un-posted';
  end if;
  return new;
end;
$$;
create trigger fin_allocations_guard_trg before update or delete on fin_allocations
  for each row execute function fin_allocations_guard();

-- A reversal must undo something real: a posted allocation, on a line that moves money the other way, never more than
-- is left of it, and not itself a reversal.
create function fin_allocations_reversal_guard() returns trigger
language plpgsql set search_path = public as $$
declare
  orig record;
  this_dir text;
  already bigint;
begin
  if new.reverses_allocation_id is null then
    return new;
  end if;
  select a.id, a.amount_paise, a.posted_at, a.reverses_allocation_id, l.direction
    into orig
    from fin_allocations a join fin_bank_lines l on l.id = a.bank_line_id
    where a.id = new.reverses_allocation_id;
  if not found then
    raise exception 'the allocation being reversed does not exist';
  end if;
  if orig.posted_at is null then
    raise exception 'only a posted allocation can be reversed';
  end if;
  if orig.reverses_allocation_id is not null then
    raise exception 'a reversal cannot itself be reversed';
  end if;
  select direction into this_dir from fin_bank_lines where id = new.bank_line_id;
  if this_dir = orig.direction then
    raise exception 'a reversal must be on a line that moves money the other way';
  end if;
  select coalesce(sum(amount_paise), 0) into already
    from fin_allocations where reverses_allocation_id = new.reverses_allocation_id and id <> new.id;
  if already + new.amount_paise > orig.amount_paise then
    raise exception 'that is more than is left to reverse';
  end if;
  return new;
end;
$$;
create trigger fin_allocations_reversal_guard_trg before insert on fin_allocations
  for each row execute function fin_allocations_reversal_guard();

-- The rows of a line never add up to more than the line, and once any row is posted they all are and add up exactly.
-- Deferred, so a save that replaces a line's rows is judged when it finishes.
create function fin_allocations_sum_guard() returns trigger
language plpgsql set search_path = public as $$
declare
  line_id uuid := coalesce(new.bank_line_id, old.bank_line_id);
  line_amount bigint;
  total bigint;
  posted integer;
  drafts integer;
begin
  select amount_paise into line_amount from fin_bank_lines where id = line_id;
  select coalesce(sum(amount_paise), 0), count(*) filter (where posted_at is not null), count(*) filter (where posted_at is null)
    into total, posted, drafts
    from fin_allocations where bank_line_id = line_id;
  if total > line_amount then
    raise exception 'the allocations of a line cannot add up to more than the line';
  end if;
  if posted > 0 and (drafts > 0 or total <> line_amount) then
    raise exception 'a posted line must be allocated in full';
  end if;
  return null;
end;
$$;
create constraint trigger fin_allocations_sum_guard_trg after insert or update or delete on fin_allocations
  deferrable initially deferred for each row execute function fin_allocations_sum_guard();

-- ---- Writes -------------------------------------------------------------------------------------------------------

-- Replace the draft rows of one bank line with p_rows and, if p_post, post them (the rows must then add up to the line).
-- p_rows: [{ party_id, category_id, project_id, amount_paise, period, nature, remarks, source, rule_id, review_state,
--           review_reason, reverses_allocation_id, reversal_reason }]
-- p_override: the app has checked that the person holds close-period and gave a reason; without it a closed month refuses.
-- Returns the number of rows now on the line. A line that already has posted rows is refused: correct it by reversal.
create function fin_save_allocations(p_line_id uuid, p_rows jsonb, p_actor uuid, p_post boolean, p_override boolean default false)
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
                               rule_id, review_state, review_reason, reverses_allocation_id, reversal_reason, created_by)
  select line.entity_id, p_line_id, r.party_id, r.category_id, r.project_id, r.amount_paise, r.period, r.nature, r.remarks, r.source,
         r.rule_id, coalesce(r.review_state, 'ok'), r.review_reason, r.reverses_allocation_id, r.reversal_reason, p_actor
  from jsonb_to_recordset(p_rows) as r(party_id uuid, category_id uuid, project_id uuid, amount_paise bigint, period date, nature text,
                                       remarks text, source text, rule_id uuid, review_state text, review_reason text,
                                       reverses_allocation_id uuid, reversal_reason text);
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

-- Close a month (creating its row if no one has touched it yet). Closing again is a no-op.
create function fin_close_period(p_entity uuid, p_month date, p_actor uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  fy smallint := (case when extract(month from p_month) >= 4 then extract(year from p_month) else extract(year from p_month) - 1 end)::smallint;
begin
  insert into fin_periods (entity_id, month, financial_year, status, closed_by, closed_at)
  values (p_entity, p_month, fy, 'closed', p_actor, now())
  on conflict (entity_id, month) do update
    set status = 'closed', closed_by = excluded.closed_by, closed_at = excluded.closed_at
    where fin_periods.status <> 'closed';
end;
$$;

alter table fin_rules enable row level security;
alter table fin_allocations enable row level security;
alter table fin_vouchers enable row level security;
revoke all on fin_rules, fin_allocations, fin_vouchers from anon, authenticated;
revoke all on function fin_allocations_guard(), fin_allocations_reversal_guard(), fin_allocations_sum_guard() from public, anon, authenticated;
revoke all on function fin_save_allocations(uuid, jsonb, uuid, boolean, boolean), fin_close_period(uuid, date, uuid) from public, anon, authenticated;
grant execute on function fin_save_allocations(uuid, jsonb, uuid, boolean, boolean), fin_close_period(uuid, date, uuid) to service_role;
