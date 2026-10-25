# Accommodation: units as data — step 2 plan

Status: **plan, 2026-10-26. Nothing in this plan is built.** It is step 2 of `docs/plans/accommodation-calendar.md`.
This is a public repo: no commercial terms and no member or guest details belong here.

## Goal

Make the list of bookable units live in the database instead of in code, so that adding a member's room or
retiring a tent is a data change and not a code change. Nothing visible changes for Madhavan in this step.
Everything later depends on it: types Linger can book, units a member offers, the Units screen for super
admins, and the manager rule that makes member-managed units view-only for Madhavan.

## What exists today (checked against the live database, 2026-10-26)

- `accommodation_units` (migration `0060`) exists with 14 rows. It is **read only by the partner API**.
  The admin calendar does not read it.
- The admin calendar, the stay notices and the WhatsApp guest messages read the constant
  `ACCOMMODATION_UNITS` in `scripts/lib/accommodation.mjs`.
- The database also hardcodes the unit list in two places:
  - a `CHECK` on `accommodation_tent_assignments.tent_id` listing the 14 ids;
  - the functions `accommodation_create_booking` and `accommodation_update_booking`, which spell out every
    unit id to apply a whole-farm closure to all of them. No other function hardcodes units.
- The no-double-booking rule is an `EXCLUDE USING gist (tent_id WITH =, stay_range WITH &&)`. It works for
  any unit id, so it does not change.
- Live data is small: 1 booking, 7 tent assignments, 14 units, 0 pools, 3 partner keys, 0 grants.
- Nothing in the database depends on `accommodation_units` beyond its two indexes: no views, row-level
  policies, triggers or functions reference it, so replacing the `active` column is safe at the database level.
- Only the partner API's own tables care about "pools" today (`accommodation_unit_pools`, empty).

## Decisions this plan makes

1. **A type is a pool.** The partner API already has pools: "units sold by quantity while TVC assigns the
   physical unit" is exactly how Linger will book a type. So the types in the calendar plan (Tents, Bamboo
   huts, Bring your own tent, 1 bedroom, 1 BHK, 2 BHK, 3 BHK) become rows in `accommodation_unit_pools`, and
   each unit's `pool_id` is its type. No new table. The UI says "type"; the table keeps its name.
2. **One status per unit**: `rentable`, `paused` or `offboarded`, replacing the `active` flag. `active` stays
   as a generated column (`status <> 'offboarded'`) so the partner code keeps working untouched.
3. **Who manages a unit** is a column (`manager`: `tvc` or `member`), and a member unit's shape is a column
   (`listing_shape`: `whole` or `room`). Madhavan edits only units whose manager is `tvc`.
4. **Permissions for members are not staff grants.** A member's authority over their unit comes from being the
   owner (`owner_farm_unit`), through the member portal, in step 3. This step only adds the staff-side rule.
5. **The admin API serves the unit list from the database**, and the page builds its tents picker from that
   response. The constant becomes seed data and test fixtures only.

## The migration (sketch, `0065_accommodation_units_as_data.sql`)

Additive except for two replacements (the `CHECK` and two functions), and written so the current app keeps working
before and after it is applied.

```sql
-- types are pools
alter table accommodation_unit_pools
  add column owner_type text not null default 'tvc' check (owner_type in ('tvc','member')),
  add column sort_order integer not null default 0;
insert into accommodation_unit_pools (id, name, owner_type, sort_order) values
  ('tent','Tents','tvc',1), ('hut','Bamboo huts','tvc',2), ('byot','Bring your own tent','tvc',3),
  ('1br','1 bedroom','member',4), ('1bhk','1 BHK','member',5), ('2bhk','2 BHK','member',6), ('3bhk','3 BHK','member',7);
update accommodation_units set pool_id = case when group_name = 'Bamboo Huts' then 'hut'
  when kind = 'byot' then 'byot' else 'tent' end;

-- unit status, manager, shape, tags, Madhavan's note
alter table accommodation_units
  add column status text not null default 'rentable' check (status in ('rentable','paused','offboarded')),
  add column manager text not null default 'tvc' check (manager in ('tvc','member')),
  add column listing_shape text check (listing_shape in ('whole','room')),
  add column cluster text,
  add column tags text[] not null default '{}',
  add column note text;
update accommodation_units set status = case when active then 'rentable' else 'offboarded' end;
alter table accommodation_units drop column active;
alter table accommodation_units add column active boolean generated always as (status <> 'offboarded') stored;
-- a member unit has a shape and a type from a member type; a TVC unit has neither
alter table accommodation_units add constraint accommodation_units_member_shape
  check ((owner_type = 'member') = (listing_shape is not null));

-- the CHECK on tent_id becomes a foreign key
alter table accommodation_tent_assignments drop constraint accommodation_tent_assignments_tent_id_check;
alter table accommodation_tent_assignments add constraint accommodation_tent_assignments_unit_fk
  foreign key (tent_id) references accommodation_units (id) on update restrict on delete restrict;

-- create_booking / update_booking: the farm-closure branch reads the unit ids from the table
--   v_tent_ids := array(select id from accommodation_units where active);
-- (the rest of both functions is copied unchanged from the live definitions)
```

The functions are replaced by copying the **live** definitions (`pg_get_functiondef`) and changing only the
closure branch, not by retyping them from the repository's older migrations.

## App changes

- **`netlify/functions/lib/accommodation-units.ts`** (new): loads the unit list from the database with a short
  in-memory cache, and exposes lookups by id. Used by the admin function, the stay notices and the WhatsApp
  guest messages, which currently import the constant.
- **`accommodation-admin.mts`**: serve `units` and `types` from the database; validate `tentId` against it;
  **reject writes to a unit whose manager is `member`** with a clear message. Nothing is member-managed yet, so
  this changes no behaviour today.
- **`accommodation-calendar.astro`**: take `units` and `types` from the API response. The page builds the
  tents picker once at load, so it builds it again if the first response differs from the built-in fallback.
  The built-in list stays as a fallback only until the first load.
- **`scripts/lib/accommodation.mjs`**: the constant stays as seed data for tests and the demo. The sync test
  against `0060` (`partner-units.test.mjs`) is replaced by one that checks the seed in `0065` against the
  constant.
- **Docs**: `ARCHITECTURE.md`, `PARTNER-API.md` (types are pools; status), and the changelog.

## Deploy order, and why it is safe

1. **Apply `0065` to the live database first.** It is backwards compatible: the old app still sends only the
   14 ids that exist, the `FOREIGN KEY` accepts all of them, and the new closure branch produces the same list.
   The repository's migration check will flag the PR until this is done.
2. **Then merge the app change**, which starts reading the table. Merging does not apply migrations, which is
   why the order matters.
3. If the app change has to be reverted, the database stays as it is: the old app keeps working against it.

## Testing

- **Scratch Postgres 17** (installed locally) with the real chain of accommodation migrations plus `0065`:
  create, update and delete bookings; double-booking is still refused; a booking on a unit that does not
  exist is refused by the foreign key; a farm closure covers every active unit and **not** an offboarded one;
  converting `active` to a generated column keeps the partner reads working.
- **The live data**: run the migration inside a transaction on a copy of the 1 live booking and 7 assignments.
- **Unit tests**: the admin function's validation (unknown unit, a member-managed unit refused), the unit
  loader's cache, and the sync test above.
- **In the dev server** with the demo sign-in and mocked responses, as for step 1.

## Rollback

Everything the old app needs is preserved, so rollback is rarely needed. If it is: restore the `CHECK` from the
saved definition, restore the two functions from the dump taken before applying, and drop the added columns.
Take that dump (`pg_get_functiondef` for both functions, and the `CHECK` text) **before** applying, and keep it
in the PR description.

## Decisions I need

- **Does a whole-farm closure block member units?** Today "Farm on Vacation" closes every unit. With member
  units in the table it would also close members' homes. My default is **yes, every active unit**, because TVC
  cannot run the guest's stay while the farm is closed, and Linger would otherwise sell a stay TVC cannot serve.
  The alternative is TVC-managed units only, with a per-unit override.
- **`status` replacing `active`:** is a paused unit hidden from Linger's availability (my assumption: yes,
  shown as unavailable), and does it still count in the free-units totals in Madhavan's calendar (my
  assumption: no)? The partner API change for paused units belongs with its phase 2.
- **Who maintains tags** (kitchen, ground floor, quiet): not needed in this step, since the column is only
  added, but it decides the editor in step 3.

## Out of scope for this step

The Units screen, onboarding, "My rental", the allocation recommendation, holds, and any change to what Linger
sees. Those are steps 3 to 5 in the calendar plan.
