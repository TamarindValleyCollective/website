-- Clears the "Extension in Public" security advisory: btree_gist (0005) and
-- pg_trgm (0007) were created with no schema, so they landed in public and
-- put roughly 200 helper functions and operators there, callable by anon
-- through the Data API. Move both to the extensions schema, where Supabase
-- keeps pgcrypto and uuid-ossp.
--
-- Safe for what exists today: the GiST exclusion constraints and indexes
-- (tent and guest stay overlap, stay_range) and the trigram index on
-- accommodation_people.name bind their operator classes by OID, so they keep
-- working. No function or Netlify code calls an extension function or
-- operator by name (checked 2026-10-24). A new function that does must
-- schema-qualify it (extensions.similarity(...)) or include extensions in its
-- search_path; the postgres role already has it on its default path.
create schema if not exists extensions;
alter extension btree_gist set schema extensions;
alter extension pg_trgm set schema extensions;
