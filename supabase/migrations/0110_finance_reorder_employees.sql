-- Finance payroll: the order of people on payroll can be changed.
--
-- The employee number is the position in the bank's upload file (the 'nnn' in the reference column), and it was only ever assigned by the
-- next number up. A director can now put people in the order they want: this function renumbers every employee 1..n in the order given.
-- All of them must be listed (people who left are inactive, not gone, and keep a place), so a number is never given twice. The numbers
-- are unique per entity, so the move goes through temporary numbers above any real one first. Runs already generated keep the reference
-- text they were given; only files made from now on use the new numbers. The app checks who may do this and audits the call.
-- Public repository: nothing here is a real name, number or amount.

create function fin_reorder_employees(p_ids uuid[]) returns integer
language plpgsql security definer set search_path = public as $$
declare
  ent uuid;
  total integer;
  i integer;
begin
  if coalesce(array_length(p_ids, 1), 0) = 0 then raise exception 'list the people in the order you want'; end if;
  if (select count(distinct x) from unnest(p_ids) as x) <> array_length(p_ids, 1) then raise exception 'a person was listed twice'; end if;
  select entity_id into ent from fin_employees where id = p_ids[1];
  if ent is null then raise exception 'unknown employee'; end if;
  perform pg_advisory_xact_lock(hashtext('fin_employees_roll:' || ent::text));
  select count(*) into total from fin_employees where entity_id = ent;
  if total <> array_length(p_ids, 1)
     or exists (select 1 from unnest(p_ids) as x where not exists (select 1 from fin_employees e where e.id = x and e.entity_id = ent)) then
    raise exception 'list every person on payroll, once each';
  end if;
  if total > 99999 then raise exception 'too many people'; end if;
  for i in 1 .. total loop
    update fin_employees set roll_no = (900000 + i)::text where id = p_ids[i];
  end loop;
  for i in 1 .. total loop
    update fin_employees set roll_no = i::text where id = p_ids[i];
  end loop;
  return total;
end;
$$;

revoke all on function fin_reorder_employees(uuid[]) from public, anon, authenticated;
grant execute on function fin_reorder_employees(uuid[]) to service_role;
