# Accommodation calendar — redesign plan

Status: **design draft, 2026-10-25. Nothing in this plan is built.** It comes from a design review of
the current calendar (`/internal/accommodation-calendar`), a Current/New mockup, and Sharath's answers
about how stays will work once Linger sells TVC accommodation. The partner API itself is in
`PARTNER-API.md`; this plan is about the calendar's design and the data and permissions it needs. This is
a public repo: **no commercial terms (rates, revenue splits, settlement) and no member or guest details
belong here.** Those live in the private design docs.

## How stays will work

- **Linger** is the guest-facing front end for several properties, TVC among them. It curates the
  experience, sets expectations, checks TVC's availability and blocks it for a guest.
- TVC has two kinds of accommodation:
  - **TVC-common units** (tents, bamboo huts, pitch tents), managed by **Madhavan**.
  - **Member units**, offered by members: the **whole unit** or **a single room**. A unit is fixed as one
    or the other.
- Members manage their units **only through the member portal** (members.tvc.farm). They never use the
  admin calendar or `/internal`. Madhavan's calendar is the admin tool; a member's screen is the portal's.
  They share booking data and grid components, not screens or permissions.
- TVC runs the guest's stay either way (food, farm tour), so Madhavan needs to *see* every stay.
- All communication with guests goes through the member portal. A member sees a guest's **name, age
  group, gender and preferences**, never a phone number or email.

### Workflow for a member unit

1. The member says in the member portal that they want to offer a unit to Linger: whole unit or a room.
2. Linger is told, talks to the member and signs a contract. Terms are the same for every member and vary
   only by size, so a member unit has one of four **types**: *1 bedroom* (a room), *1 BHK*, *2 BHK*,
   *3 BHK*.
3. Once the contract is signed, the **admin team enables the unit as rentable**. Only then is it
   allocatable.
4. Linger gets a guest, checks availability by type, and blocks one.
5. **Madhavan allocates a specific unit** of that type, helped by a recommendation (below).
6. Who answers depends on who manages the unit: Madhavan for TVC units and for a whole unit the member has
   **delegated** to TVC; the member for a room or an undelegated unit, according to the unit's **request
   mode**.
7. The member, or their delegate, can **block dates** when the unit is unavailable.

## Decisions (2026-10-25)

| Area | Decision |
|---|---|
| Listing shape | Whole unit or single room, fixed per unit. No whole-versus-room blocking is needed now; keep the schema able to add it. |
| What Linger books | **A type**, not a specific unit. Madhavan allocates the unit. |
| Recommendation | For each request the system suggests specific units with reasons. Madhavan decides; he can dismiss a suggestion or pick any eligible unit. |
| Types | TVC: tents, bamboo huts (and bring-your-own-tent slots). Members: 1 bedroom, 1 BHK, 2 BHK, 3 BHK. Terms attach to the type. |
| Who answers a request | Whoever manages the unit, following the unit's request mode. |
| Request mode | Chosen by the member in the portal: **auto-reject (the default)**, ask me each time, auto-accept. Ask-me-each-time has 24 hours, then it is declined and returns to Madhavan. |
| Auto-reject | The unit is **not offered**: it counts as unavailable and is never suggested. |
| Madhavan and member-managed units | **View only.** He cannot change their availability or bookings. |
| Enabling a unit | The admin team does it, after the contract is signed, and sets the type and whether a whole unit is delegated. |
| Guest details a member sees | Name, age group, gender, preferences. No contact details. |
| Scale | 53 member units. Not all will be rentable; the calendar must stay usable if most are. |

## How the recommendation works

Hard rules first, then ranking, always with reasons Madhavan can read:

1. **Eligible**: the right type, rentable and not paused, not on auto-reject, not blocked, free for every
   night, and big enough.
2. **Ranked by**: how many of the guest's stated preferences the unit matches (from tags on the unit,
   such as *kitchen*, *ground floor*, *pets ok*, *quiet*, *view*); then **fair share**, favouring members
   with fewer stays this season than the average for that type; then, for TVC units, the tightest fit.
3. **Madhavan's own knowledge** the system cannot have: a private note on each unit (road noise in the
   monsoon, a particular host) shown with the suggestion, and the ability to dismiss ("not this one") and
   to override.
4. The panel also says **what happens next** for each choice: confirmed at once, confirmed because the
   member auto-accepts, or sent to the member for an answer.

Later, free-text preferences could be matched with a model; the first version uses plain tags so the
reasons are exact. If a member declines, the request returns to Madhavan with the reason.

## Roles: who can do what

| | Madhavan | The member (portal) | Linger (API) |
|---|---|---|---|
| TVC-common units | Edit, allocate, see guests | Nothing | Blocks by type |
| Whole unit delegated to TVC | Edit, allocate, see guests | See its stays | Blocks by type |
| Room, or an undelegated unit | **View only**, see guests | Set mode, block dates, accept or decline, see guests | Blocks by type |

Permissions are by **unit**, not by booking type as today.

## Booking lifecycle

`hold` (expires) → `to allocate` (Linger confirmed a type, no unit yet) → `waiting for member` (if they ask
each time) → `confirmed` → `cancelled`. Every booking keeps its source, Linger's reference, the unit's
owner and manager at the time, and an audit trail.

## Screens

1. **Availability by type** (Madhavan). One row per type with the number of units free each night
   (about seven rows, not one per unit). Click a type to open its units, with one bar per booking showing
   its name and head count. Weekend tint, today edge, faint past, a whole-farm closure as one banner,
   hold and waiting as dashed. A **"Needs you" strip** lists requests to allocate, including ones a member
   declined.
2. **Allocate panel** (Madhavan). The recommendation above.
3. **Arrivals** (Madhavan). Who arrives where over the next week, with names, age group, gender and
   preferences, and a head count for each night, across TVC and member units.
4. **Onboarding** (admin). Members who offered a unit, waiting for the contract; enable as rentable with
   its type and delegation; paused units.
5. **My unit** (member portal). Status with Linger, the request mode, dates I'm not available, requests to
   answer, guests by name and preferences, a message thread with TVC, and the unit's own calendar.
6. **Unit page** (admin): type, owner, who manages it, tags, Madhavan's note, blocks and stays. Not
   mocked yet.
7. The **Day view** stays as it is.

## Where it lives: menus by person

The new screens are extra menu items in the portals people already use.

| Person | Portal | Menu change |
|---|---|---|
| A member | Member Portal | New **My rental**: offer a unit, track it with Linger, then request mode, blocked dates, requests, guests and their own statement. |
| Madhavan | Admin Portal | **Accommodation** replaces "Accommodation calendar": Availability by type, Arrivals, and the unchanged Day view. |
| Super admin | Admin Portal | New **Units** under Admin: the onboarding pipeline and a table of all units, with pause and offboard. Offboarding is blocked while a unit has future bookings. |
| Finance manager | Admin Portal | **Revenue** replaces "Event payments": Overview, Events (today's screen, unchanged), Stays (collected, fees, net and each party's share) and Settlements (what is due to Linger and to each member). |

Revenue and Settlements record, per stay, whether the unit was TVC's or a member's and the terms that
applied when it was confirmed, so a later change to terms does not rewrite history. Finance sees money,
not guest details. A private mockup of all four views exists; this plan is the record.

## What has to change in the data

- **Units come from the database, not code.** The calendar still reads `ACCOMMODATION_UNITS` and
  hardcoded `tent_id` constraints; `accommodation_units` (migration `0060`) exists. Move the calendar and
  booking functions onto it first. Add the type, who manages the unit, whole unit or room, the cluster,
  tags, Madhavan's note, and a rentable or paused status.
- **Types** as a table, carrying the fixed terms (private) and what Linger sees. The partner API's
  existing **pools** are the natural shape: a type is a pool, so Linger never sees which member's unit.
- **Bookings** gain a status, a source and external reference, the unit's owner and manager when made, and
  the allocation record (who allocated, what was suggested, what they chose).
- **Member listing settings**: the request mode (default auto-reject) and blocked dates, per unit.
- **A fair-share count** per unit and period, derived from bookings.
- **Unit-scoped grants** replace the "allowed booking types" scope for the accommodation module.
- **A message thread per stay** between the member and TVC.

## Build order

1. **Availability by type and the new grid** for Madhavan's calendar, on the units that exist today
   (types for tents and huts). No backend change beyond reading the type.
2. **Units as data, types, unit-scoped grants**, and the manager and listing-shape fields.
3. **Onboarding** and **member "My unit"**: offer a unit, enable it, set the mode, block dates.
4. **Holds, to-allocate requests, the recommendation and Arrivals**, alongside partner API phase 2.
5. **Declines returning to Madhavan, change requests**, alongside partner API phase 4.
6. **Message thread** per stay.

## Open questions

- Is 24 hours the right answer window for "ask me each time", given Linger's guest waiting?
- If a member switches to auto-reject while requests are waiting, are those declined or left?
- What can a member do after accepting: cancel? Who is told, and is there a limit?
- Which preference tags does Linger send, and who maintains the tags on each unit: the member, the admin
  team, or both?
- Should "fair share" count nights or stays, and over what period?
- Does Madhavan see why a member blocked dates, or only that it is blocked? (Assumed: only that it is.)
