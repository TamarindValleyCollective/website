-- READ-ONLY. Run in the TVC ERP SQL editor; copy the single result cell (the JSON) into a file
-- OUTSIDE this repo (it holds real names and story text), then:
--   node scripts/preview-unit-stories.mjs --in /path/outside/the/repo/units.json --out /path/outside/the/repo/preview.txt
-- One entry per unit that has at least one story row: its farm plot and its people's per-person
-- member_stories rows, exactly what the backfill to one-story-per-unit would merge.
select jsonb_pretty(coalesce(jsonb_agg(u order by u.farm_unit), '[]'::jsonb)) as units
from (
  select
    h.id as household_id,
    h.farm_unit,
    jsonb_agg(
      jsonb_build_object(
        'label', p.full_name,
        'person_id', s.person_id,
        'status', s.status,
        'draft', s.draft,
        'draft_public', s.draft_public,
        'submitted', s.submitted,
        'submitted_public', s.submitted_public,
        'submitted_at', s.submitted_at,
        'approved', s.approved,
        'approved_public', s.approved_public,
        'approved_at', s.approved_at,
        'updated_at', s.updated_at
      )
      order by p.full_name
    ) as rows
  from member_households h
  join member_household_members m on m.household_id = h.id
  join member_people p on p.id = m.person_id
  join member_stories s on s.person_id = p.id
  group by h.id, h.farm_unit
) u;
