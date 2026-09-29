-- 0025 made "the same guest ends up with an identical name+mobile in two
-- different tents" a normal, allowed booking shape rather than a hard
-- error. That exposed a real bug one step earlier: editing an EXISTING
-- guest's mobile number (or name) to a value that makes it collide with a
-- DIFFERENT already-existing accommodation_people row (matched by the same
-- mobile_number + lower(name) that accommodation_people_mobile_name_key
-- enforces) hit that unique constraint directly, as a raw, unhandled
-- Postgres error surfaced straight to the admin ("duplicate key value
-- violates unique constraint..."), and rolled the whole save back.
-- Reproduced live (Sharath, 2026-09-29): a booking had two guests both
-- named "Arthi" in different tents from before 0025, one with a mobile
-- number on file and one without; filling in the second one's mobile to
-- match the first's failed this way when saved.
--
-- Byte-identical to 0015's version of accommodation_resolve_person except
-- the p_person_id branch: now checks for that exact collision first and,
-- if found, merges into the existing record (returns its id, folding in
-- any newly-supplied gender/preferences/email) instead of attempting an
-- UPDATE that the unique index would reject. The insert-path branch below
-- already had equivalent merge behavior via its own ON CONFLICT DO UPDATE -
-- this brings the update path (used whenever the client already has a
-- personId, i.e. an existing guest being edited) in line with it.
create or replace function accommodation_resolve_person(
  p_person_id uuid, p_name text, p_mobile_number text, p_gender text, p_preferences text, p_email text default null
) returns uuid language plpgsql as $$
declare
  v_id uuid;
  v_existing_id uuid;
begin
  if p_person_id is not null then
    select id into v_existing_id
    from accommodation_people
    where mobile_number = coalesce(p_mobile_number, (select mobile_number from accommodation_people where id = p_person_id))
      and lower(btrim(name)) = lower(btrim(coalesce(p_name, (select name from accommodation_people where id = p_person_id))))
      and mobile_number is not null
      and id <> p_person_id;

    if v_existing_id is not null then
      update accommodation_people
      set gender = coalesce(p_gender, gender), preferences = coalesce(p_preferences, preferences),
          email = coalesce(p_email, email), updated_at = now()
      where id = v_existing_id;
      return v_existing_id;
    end if;

    update accommodation_people
    set name = p_name, mobile_number = coalesce(p_mobile_number, mobile_number), gender = coalesce(p_gender, gender),
        preferences = coalesce(p_preferences, preferences), email = coalesce(p_email, email), updated_at = now()
    where id = p_person_id
    returning id into v_id;
    if v_id is null then
      raise exception 'Guest not found' using errcode = 'PT404';
    end if;
    return v_id;
  end if;

  if p_mobile_number is not null then
    insert into accommodation_people (name, mobile_number, gender, preferences, email)
    values (p_name, p_mobile_number, p_gender, p_preferences, p_email)
    on conflict (mobile_number, (lower(btrim(name)))) where mobile_number is not null
    do update set name = excluded.name, gender = coalesce(excluded.gender, accommodation_people.gender),
      preferences = coalesce(excluded.preferences, accommodation_people.preferences),
      email = coalesce(excluded.email, accommodation_people.email), updated_at = now()
    returning id into v_id;
    return v_id;
  end if;

  insert into accommodation_people (name, gender, preferences, email)
  values (p_name, p_gender, p_preferences, p_email)
  returning id into v_id;
  return v_id;
end;
$$;

alter function accommodation_resolve_person(uuid, text, text, text, text, text) set search_path = public, pg_temp;
