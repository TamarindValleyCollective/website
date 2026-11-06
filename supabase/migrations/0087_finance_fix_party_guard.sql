-- Finance: fix the allocation guard from 0086.
--
-- 0086 added to the list of frozen-exempt columns with `skip || 'party_id'`. With an array on the left Postgres reads the
-- quoted text as an array literal, so every call to fin_set_allocation_party(ies) failed with
-- `malformed array literal: "party_id"`, and the same line for `category_id` would have broken merging and recategorising
-- categories. Both are now written as one-element arrays. Behaviour is otherwise exactly as 0086 described: party_id may
-- change only from empty to a party inside fin_set_allocation_party(ies), category_id only inside the recategorise functions,
-- and nothing else on a posted allocation changes.
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
    if current_setting('fin.recategorise', true) = 'on' then skip := skip || array['category_id']; end if;
    if current_setting('fin.setparty', true) = 'on' and old.party_id is null and new.party_id is not null then
      skip := skip || array['party_id'];
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
