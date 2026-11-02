-- Finance module, session 04: merging two parties that are really one payee (docs/finance/FINANCE.md, "Merging").
--
-- Account rows are immutable (0079) and keep the party they were entered under, so a merge does not move anything: the
-- duplicate is marked `merged_into` the main party. The directory then shows one party holding both sets of accounts,
-- and reviews them together (a bank merger leaves a payee with an old and a new account). Nothing is deleted, and a
-- merge can be undone by clearing the column. No chains: the target must not itself be merged, and a party that others
-- were merged into cannot be merged away.

alter table fin_parties add column merged_into uuid references fin_parties (id);
alter table fin_parties add constraint fin_parties_not_merged_into_self check (merged_into is null or merged_into <> id);
create index fin_parties_merged_into_idx on fin_parties (merged_into) where merged_into is not null;

create function fin_parties_merge_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.merged_into is not null and new.merged_into is distinct from old.merged_into then
    if old.merged_into is not null then
      raise exception 'this party is already merged';
    end if;
    if exists (select 1 from public.fin_parties t where t.id = new.merged_into and t.merged_into is not null) then
      raise exception 'cannot merge into a party that is itself merged';
    end if;
    if exists (select 1 from public.fin_parties o where o.merged_into = new.id) then
      raise exception 'other parties were merged into this one';
    end if;
  end if;
  return new;
end;
$$;
create trigger fin_parties_merge_guard_trg
  before update of merged_into on fin_parties
  for each row execute function fin_parties_merge_guard();
revoke all on function fin_parties_merge_guard() from public, anon, authenticated;
