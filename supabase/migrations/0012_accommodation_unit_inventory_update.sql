-- Renames the tent inventory's ids from location-named
-- (malabar-1/banyan/portable-N) to generic TentNN, matching
-- scripts/lib/accommodation.mjs's 2026-08-31 inventory update (9 units, 22
-- people, up from 8/20 - the ninth unit, Tent09, is the only genuinely new
-- physical tent added). Unlike the earlier accommodation migrations, this
-- one touches live data, not just schema: existing bookings' tent_id has to
-- be rewritten to the new ids or their tent assignment would silently point
-- at a value the new check constraint rejects.
--
-- The old id -> new id mapping (confirmed against Sharath's original
-- numbered unit list so no existing booking's tent gets reassigned to the
-- wrong physical unit):
--   malabar-1  -> Tent01 (Malabar Hut Fixed (N))
--   malabar-2  -> Tent02 (Malabar Hut Fixed (S))
--   portable-2 -> Tent03 (Malabar Hut Portable)
--   banyan     -> Tent04 (Banyan Hut Fixed)
--   portable-3 -> Tent05 (Banyan Hut Portable)
--   portable-4 -> Tent06 (Upper Bamboo Hut)
--   portable-5 -> Tent07 (Lower Bamboo Hut)
--   portable-1 -> Tent08 (Campground Portable)
--   (new)      -> Tent09 (Campground Portable) - never referenced by any
--                 existing row, so it needs no UPDATE, only the widened
--                 check constraint below.

-- Drop the old constraint before the rewrite so mid-update rows (already on
-- a TentNN id, not yet all of them) can't transiently violate it.
alter table accommodation_tent_assignments
  drop constraint accommodation_tent_assignments_tent_id_check;

update accommodation_tent_assignments set tent_id = case tent_id
  when 'malabar-1' then 'Tent01'
  when 'malabar-2' then 'Tent02'
  when 'portable-2' then 'Tent03'
  when 'banyan' then 'Tent04'
  when 'portable-3' then 'Tent05'
  when 'portable-4' then 'Tent06'
  when 'portable-5' then 'Tent07'
  when 'portable-1' then 'Tent08'
  else tent_id
end
where tent_id in ('malabar-1', 'malabar-2', 'banyan', 'portable-1', 'portable-2', 'portable-3', 'portable-4', 'portable-5');

alter table accommodation_tent_assignments
  add constraint accommodation_tent_assignments_tent_id_check
  check (
    tent_id in ('Tent01', 'Tent02', 'Tent03', 'Tent04', 'Tent05', 'Tent06', 'Tent07', 'Tent08', 'Tent09')
  );
