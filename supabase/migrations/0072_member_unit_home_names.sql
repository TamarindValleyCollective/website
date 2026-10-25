-- A member's unit is a home, and is known by its house number (H-10) to the member, the admins, Madhavan and Linger
-- alike. Units enabled until now were named after the plot they stand on ("Home F-12"). Rename those to the house number.
-- The unit's id stays the farm number (F-12): it is a key the calendar, bookings and the partner API use, and is never
-- shown as a name. A household with no house number is left as it is (it cannot be enabled any more).
--
-- Data only; backwards compatible. Not auto-applied on merge. Rollback: set the names back to 'Home ' || owner_farm_unit.

update accommodation_units u
   set name = 'Home ' || h.house_no,
       short_name = 'Home ' || h.house_no
  from member_households h
 where u.owner_type = 'member'
   and u.owner_farm_unit = h.farm_unit
   and h.house_no is not null
   and u.name = 'Home ' || h.farm_unit;
