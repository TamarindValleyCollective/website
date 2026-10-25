# Member units: offer, onboard, manage — step 3 plan

Status: **plan, 2026-10-26. Step 3a is being built alongside this plan; step 3b is not started.** It is step 3 of
`docs/plans/accommodation-calendar.md` and builds on `docs/plans/accommodation-units-as-data.md` (step 2, live).
This is a public repo: no commercial terms and no member or guest details belong here.

## Goal

Let a member offer their unit to Linger, let the super admin onboard and offboard units, and let the member
manage their own unit afterwards, all on the data model step 2 put in place. Two halves:

- **3a, the admin side:** the offers table, the super admin's **Units** screen (pipeline and all units), and the
  settings a unit carries. Nothing member-facing.
- **3b, the member side:** **My rental** in the member portal (offer, track, then request mode, blocked dates,
  stays) and the notice to Linger.

## How a member relates to a unit

- A household is one farm unit (`F-12`), and a household has one house, so a household offers **at most one
  unit**. The unit's id is the farm unit (`F-12`), and `owner_farm_unit` carries the same value (made unique in
  3a). Whole unit or single room is a property of that unit, fixed when it is enabled.
- **Only an owner who can sign in** may offer or manage the unit (a household's `owner` role with `can_login`). A
  family member who can sign in sees nothing of it.
- The member's authority comes from the household, not from a staff grant. The member functions look the unit up by
  the household's farm unit, so a member can only ever reach their own.

## The flow, mapped to data

1. **Offer.** The member chooses whole unit or room (and size for a whole unit, and whether they want TVC to manage
   it). This writes a row in a new `member_unit_offers` table with status `interested`; no unit exists yet.
2. **Linger is told** and talks to the member; the contract is outside this system.
3. **Enable.** The super admin sees the offer in **Units → Pipeline**, confirms the type (1 bedroom, 1 BHK,
   2 BHK, 3 BHK) and whether TVC manages it, and enables it. That creates the unit (status `rentable`, request mode
   **auto-reject**) and marks the offer `enabled`. Only now can it be allocated.
4. **Manage.** The member sets the request mode (auto-reject by default, ask me each time, auto-accept), blocks
   dates, and sets whether the unit stays open when the farm is closed. A member whose whole unit TVC manages sees
   it read-only: Madhavan answers requests.
5. **Pause, resume, offboard** are the super admin's. Offboarding is refused while the unit has future bookings.
   A member cannot offboard; blocking dates covers being away.

## Data (migration `0067`, 3a)

- **`member_unit_offers`**: `id`, `household_id`, `requested_by` (person), `shape` (`whole` or `room`), `type_id`
  (the member type the member asked for; the admin may change it), `delegate_to_tvc`, `status` (`interested`,
  `enabled`, `withdrawn`, `declined`), timestamps, and the admin who decided. One open offer per household.
- **`accommodation_units.request_mode`** (`reject`, `ask`, `auto`; default `reject`): how a member-managed unit
  treats a request. Meaningful only when the member manages the unit.
- **Unique `owner_farm_unit`** on `accommodation_units`.
- A **blocked period is a booking**, not a new table: a `unit-closure` booking on the member's unit. It reuses the
  conflict check (a member cannot block nights a guest already holds), shows in the calendar as closed, makes the
  unit unavailable to the partner API, and is audited by the existing booking audit log. The member endpoint creates
  and deletes these on the member's behalf.
- The partner API treats a **member-managed unit on auto-reject as not offered**: unavailable every night and not
  counted in its type's size. (A unit TVC manages is unaffected.)

## The Units screen (3a)

`/internal/units`, **super admins only**, under Admin. Reads need a signed-in super admin; every change needs the same
second-factor step-up as the Access page. Each change is written to the audit log before it is made, and refused if
the log cannot be written. Tabs:

- **Pipeline**: offers waiting; enable (pick type and delegation) or decline; the rentable and paused counts.
- **All units**: search, filter by type and owner; pause, resume, offboard (with the future-bookings check), and edit
  a unit's **tags**, **cluster** and the farm manager's private **note**, which the allocation recommendation reads.
- "Add a TVC unit" is not in this step.

## My rental (3b)

- `GET/POST /api/members-me/rental`, in the existing member function: the state (not offered, interested,
  rentable), the offer form, withdraw, request mode, stay-open flag, and the unit's blocked dates and stays.
- Guests on a stay show **name, age group, gender and preferences only**, never contact details.
- **The notice to Linger** when an offer is made (decision below).
- The member's statement is not in this step; it needs the settlement ledger (partner API phase 3).

## Decisions made here (change any of them)

| Area | Decision |
|---|---|
| Unit id | The farm unit, `F-12`. One unit per household. |
| Who may offer | A household owner who can sign in. |
| Writes on the Units screen | Super admin plus the same step-up as Access. |
| Blocked dates | `unit-closure` bookings, so they reuse conflicts, audit and availability. |
| Who changes delegation | The super admin, at enable time or later; the member only asks. |
| Who offboards | The super admin only. |

## Decisions I need before 3b

- **Who is told when a member makes an offer, and how?** My suggestion: an email to the core team and to Linger's
  stay address (the one already used for stay notices), naming the farm unit, whole or room, size and whether TVC
  should manage it, plus the member's name and sign-in email so Linger can get in touch. The member agrees to that
  when they press the button, and the wording says so. Say if Linger should get less, or a different address.
- **Should a member see why a request was declined by Madhavan or the system?** Not needed until step 4.

## Build order and rollout

1. **3a**: migration `0067` (apply by hand first), the units function, the Units page, the partner rule, tests.
2. **3b**: member endpoints, My rental, the notice.
3. Each is its own PR. The migration is backwards compatible with the live app.

## Testing

Scratch Postgres from the real chain for the migration (offers uniqueness, the unique unit per household, the
default request mode); the units function's rules as unit tests (enable, pause, offboard with and without future
bookings, tags); the partner rule as pure-function tests; the page in the dev server with mocked responses.
