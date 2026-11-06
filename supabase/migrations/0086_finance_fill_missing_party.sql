-- Finance: a posted allocation that has no party can be given one afterwards.
--
-- 0083 froze a posted allocation apart from its review fields (and its category inside the recategorise functions).
-- Some categories do not need a party, so a line could be posted without one and then never be completed. This adds one
-- narrow exception: party_id may change, but only from empty to a real party, and only inside fin_set_allocation_party
-- (a session setting the guard looks for). An existing party is never replaced here: that is still a reversal. The amount,
-- category, month and wording stay frozen. The app checks the closed-month rule and audits every call.
-- Public repository: nothing here is a real name, number or amount.

create or replace function fin_allocations_guard() returns trigger
language plpgsql set search_path = public as $$
declare
  skip text[] := array['review_state', 'review_reason', 'reviewed_by', 'reviewed_at'];
begin
  if tg_op = 'DELETE' then
    if old.posted_at is not null then
      raise exception 'a posted allocation is never deleted; reverse it instead';
    end if;
    return old;
  end if;
  if old.posted_at is not null then
    if current_setting('fin.recategorise', true) = 'on' then skip := skip || 'category_id'; end if;
    if current_setting('fin.setparty', true) = 'on' and old.party_id is null and new.party_id is not null then
      skip := skip || 'party_id';
    end if;
    if (to_jsonb(new) - skip) is distinct from (to_jsonb(old) - skip) then
      raise exception 'a posted allocation cannot be changed; reverse it instead';
    end if;
  elsif new.posted_at is null and old.posted_at is not null then
    raise exception 'a posted allocation cannot be un-posted';
  end if;
  return new;
end;
$$;

create function fin_set_allocation_party(p_id uuid, p_party uuid, p_actor uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare
  changed integer;
begin
  if not exists (select 1 from fin_parties where id = p_party) then raise exception 'choose a party in the register'; end if;
  perform set_config('fin.setparty', 'on', true);
  update fin_allocations set party_id = p_party
    where id = p_id and posted_at is not null and party_id is null and reverses_allocation_id is null;
  get diagnostics changed = row_count;
  perform set_config('fin.setparty', 'off', true);
  return changed;
end;
$$;

revoke all on function fin_set_allocation_party(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function fin_set_allocation_party(uuid, uuid, uuid) to service_role;
