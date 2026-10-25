# Accommodation calendar — redesign plan

Status: **design draft, 2026-10-25. Nothing in this plan is built.** It comes from a design review of
the current calendar (`/internal/accommodation-calendar`), a Current/New mockup, and Sharath's answers
about how stays will work once Linger sells TVC accommodation. The partner API itself is in
`PARTNER-API.md`; this plan is about the calendar's design and the data and permissions it needs. This is
a public repo: **no commercial terms (rates, revenue splits, settlement) and no member or guest details
belong here.** Those live in the private design docs.

## How stays will work

- **Linger** is the guest-facing front end for several properties, TVC among them. It curates the
  experience, sets expectations, and directs the guest to a specific property by their needs.
- Inside TVC a guest is placed in one of two kinds of accommodation:
  - **TVC-common units** (tents, bamboo huts, pitch tents). **Madhavan** manages these.
  - **Member housing.** A member lists either their **whole home** or **one room** of a home they live
    in. A house is fixed as one or the other (decided 2026-10-25), under a direct contract with Linger.
- **Who manages what:**
  - TVC-common units: Madhavan.
  - A **whole home**: Madhavan manages it on the member's behalf and **approves** each request.
  - A **room**: the **member** manages it and accepts or declines each request.
- **Members manage their units only through the member portal** (members.tvc.farm). They never use
  the admin calendar or `/internal`. Madhavan's calendar is the admin tool; a member's "My room" or
  "My home" screen is the member portal's. They share the booking data and the grid components, not the
  screens or the permissions.
- TVC runs the guest's stay either way (food, farm tour), so Madhavan needs to *see* every stay,
  including in homes he does not manage.
- All communication with guests goes through the member portal, not direct contact. A member sees a
  guest's **name, age group, gender and preferences**, never a phone number or email.

## Decisions (2026-10-25)

| Area | Decision |
|---|---|
| Listing shape | A house is a whole home or a room, fixed per house. No rooms-versus-whole-home blocking is needed now; keep the schema able to add it. |
| Madhavan and member rooms | **View only.** He cannot change a member-managed room's availability or bookings. |
| Whole homes | Madhavan manages and approves. |
| Member rooms | The member accepts. The member chooses, in the member portal, between **auto-reject (the default)**, ask me each time, and auto-accept, and sets the dates the room is open. |
| Auto-reject | A room on auto-reject is **not offered**: Linger's availability shows those nights as unavailable, so no request is made only to be refused. |
| Guest details a member sees | Name, age group, gender, preferences. No contact details. |
| Scale | 53 member units. Not all will list; the calendar must stay usable if most do. |

## Roles: who can do what

| | Madhavan | The member | Linger (API) |
|---|---|---|---|
| TVC-common units | Edit, assign tents, see guests | Nothing | Hold, confirm |
| Whole home | Edit, approve, see guests | See their own home and its stays | Hold, confirm |
| Room | **View only**, see guests | Set mode and open dates, accept or decline, see guests | Hold, confirm (when offered) |

A member's column is what they can do in the member portal. For a whole home they see its stays and
requests read-only there, because Madhavan manages it for them. Permissions are by **unit**, not by booking
type as today. Madhavan holds a grant on the units TVC
manages; a member holds one on their own listing; Linger's key is scoped to the units it has been granted.

## Booking lifecycle

`hold` (expires) → `awaiting approval` (a whole home: Madhavan; a room on "ask me": the member, who has
24 hours, after which it is declined) → `confirmed` → `cancelled`. A room on auto-accept goes straight
to `confirmed` inside the open dates; on auto-reject it never gets a request. Every booking keeps its
source (Linger, direct, event, member's own), Linger's reference, the unit's owner and manager at the
time, and an audit trail of who changed what.

## Screens

1. **Madhavan's calendar** (week and month). One bar per booking, with its name and head count, coloured
   by kind (guest stay, event, member visit; closed and waiting states are hatched or dashed). Group
   labels are small and collapsible, not solid bands. Today, jump to a date, weekend tint, whole-farm
   closure as one banner. A **"Needs you" strip** holds tent bookings that still need a physical tent and
   whole-home requests to approve.
2. **Member homes in that calendar** are not one row each. They are summarised in one "Homes open to
   book" row (how many are free each night); only homes with a booking in view get a row; a search finds
   any home by name, farm number or cluster. Rows he cannot edit say "View only".
3. **Arrivals** (Madhavan): who arrives where over the next week, with guest names, age group, gender and
   preferences, and the head count for each night, in TVC units and member homes alike.
4. **My room** (member portal): the request setting, the open dates, requests to answer, guests by name
   and preferences, a message thread with TVC about a stay, and the room's own calendar.
5. **The Day view** stays as it is; it already shows who is where.

## What has to change in the data

- **Units come from the database, not code.** The calendar still reads `ACCOMMODATION_UNITS` and
  hardcoded `tent_id` constraints; `accommodation_units` (migration `0060`) exists. Move the calendar and
  the booking functions onto it first. Add who manages each unit, whether it is a whole home or a room,
  and its cluster (member homes only).
- **Bookings** gain a status, a source and external reference, the unit's owner and manager when it was
  made, and approval records. Today a booking simply exists.
- **Member listing settings**: the request mode (default auto-reject) and the open dates, per listing.
- **Unit-scoped grants** replace the "allowed booking types" scope for the accommodation module.
- **A message thread per stay** between the member and TVC.

## Build order

1. **Grid redesign** (Madhavan's calendar). No backend change: it uses the bookings that exist today and
   has value on its own. Includes the member-homes summary row once member homes exist as units.
2. **Units as data, unit-scoped grants, and the manager and listing-shape fields.**
3. **Booking states, "Needs you", approvals and the Arrivals view**, alongside partner API phase 2
   (holds and confirm).
4. **My room** in the member portal, alongside partner API phase 4 (windows, auto-accept, change
   requests).
5. **Message thread** per stay.

## Open questions

- Does "ask me each time" need a shorter answer window than 24 hours for Linger's guest experience?
- Can a member block dates in "My room" for their own use, and does Madhavan see why? (Assumed: they can,
  and he sees "blocked" only.)
- If a member switches from "ask me" to "auto-reject" while requests are waiting, are those declined or left?
- What can a member do after accepting: cancel? Who is told, and is there a limit?
- Does a whole-home approval by Madhavan need the member's sign-off, or only a notice to them?
