-- Member portal sign-in in one round trip.
--
-- Opening the portal used to cost about five sequential REST calls from the Netlify function to Supabase (who is this
-- email, which households, then the household data, then the people in them, then the tour flag). Netlify and Supabase
-- can be an ocean apart, so each call is a long wait. This function does the same reads inside the database and
-- returns them as one JSON document: the person, their can_login links, and everything /api/members-me/home shows.
--
-- It reads exactly what requireMember (lib/member-access.ts) and handleHome (members-me.mts) read today, filtered the
-- same way (an active person with this exact email; only households they can_login on). It returns null when the email
-- is not an active, invited member, which the function turns into the same 403 as before. Only the service role can call
-- it: it looks a member up by email, so it must never be reachable with the public key.
--
-- Safe to apply before the app change that calls it; the app falls back to the old reads when this function is missing.
-- Not auto-applied on merge: apply this first, then merge the app change.
--
-- Rollback: drop function member_home_bundle(text);
create function member_home_bundle(p_email text)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_person member_people%rowtype;
  v_count integer;
  v_links jsonb;
  v_ids uuid[];
begin
  select count(*) into v_count from member_people where email = p_email and active;
  if v_count <> 1 then
    return null; -- none, or (never expected) ambiguous
  end if;
  select * into v_person from member_people where email = p_email and active;

  select coalesce(jsonb_agg(jsonb_build_object('household_id', household_id, 'role', role) order by household_id), '[]'::jsonb),
         array_agg(household_id order by household_id)
    into v_links, v_ids
    from member_household_members
   where person_id = v_person.id and can_login;
  if v_ids is null then
    return null;
  end if;

  return jsonb_build_object(
    'person', jsonb_build_object(
      'id', v_person.id,
      'full_name', v_person.full_name,
      'privacy_notice_version', v_person.privacy_notice_version,
      'google_picture_url', v_person.google_picture_url,
      'tour_seen_through', v_person.tour_seen_through
    ),
    'links', v_links,
    'households', (
      select coalesce(jsonb_agg(jsonb_build_object('id', h.id, 'farm_unit', h.farm_unit, 'house_no', h.house_no, 'cluster', h.cluster, 'unit_type', h.unit_type)), '[]'::jsonb)
        from member_households h where h.id = any (v_ids)
    ),
    'memberships', (
      select coalesce(jsonb_agg(jsonb_build_object('household_id', m.household_id, 'person_id', m.person_id, 'role', m.role, 'can_login', m.can_login)), '[]'::jsonb)
        from member_household_members m where m.household_id = any (v_ids)
    ),
    'plots', (
      select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'household_id', p.household_id, 'patta_no', p.patta_no, 'reference_no', p.reference_no, 'survey_no', p.survey_no, 'area_hectares', p.area_hectares, 'area_acres', p.area_acres, 'settlement', p.settlement, 'verification', p.verification, 'source_document_id', p.source_document_id)), '[]'::jsonb)
        from member_plots p where p.household_id = any (v_ids)
    ),
    'house_pattas', (
      select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'household_id', p.household_id, 'patta_no', p.patta_no, 'reference_no', p.reference_no, 'survey_no', p.survey_no, 'area_sq_ft', p.area_sq_ft, 'settlement', p.settlement, 'verification', p.verification, 'source_document_id', p.source_document_id)), '[]'::jsonb)
        from member_house_pattas p where p.household_id = any (v_ids)
    ),
    'notes', (
      select coalesce(jsonb_agg(jsonb_build_object('household_id', n.household_id, 'kind', n.kind)), '[]'::jsonb)
        from member_household_notes n where n.household_id = any (v_ids)
    ),
    'docs', (
      select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'household_id', d.household_id, 'land_type', d.land_type, 'status', d.status, 'extracted', d.extracted, 'created_at', d.created_at)), '[]'::jsonb)
        from member_land_documents d where d.household_id = any (v_ids)
    ),
    'family_pending', (
      select count(*) from member_family_requests r where r.household_id = any (v_ids) and r.status = 'pending'
    ),
    'people', (
      select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'full_name', q.full_name, 'email', q.email, 'phone', q.phone, 'active', q.active, 'directory_visible', q.directory_visible, 'google_picture_url', q.google_picture_url)), '[]'::jsonb)
        from member_people q
       where q.id in (select m.person_id from member_household_members m where m.household_id = any (v_ids))
    )
  );
end;
$$;

revoke all on function member_home_bundle(text) from public, anon, authenticated;
grant execute on function member_home_bundle(text) to service_role;
