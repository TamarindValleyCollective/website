-- Drops the per-person story tables. Stories are one per UNIT (member_unit_stories, 0049) and have been
-- live that way since 2026-10-21; no code reads or writes these two tables any more.
--
-- DESTRUCTIVE and not reversible: this removes the rollback path to per-person stories (the switch that
-- made it possible is gone from the code too). Apply it by hand in the TVC ERP SQL editor, and only AFTER
-- the code that stopped using these tables has been merged and deployed. member_unit_stories,
-- member_unit_story_assessments, member_cards and member_settings are untouched (the unused
-- `unit_stories` row in member_settings is harmless and stays).

drop table if exists member_story_assessments;
drop table if exists member_stories;
