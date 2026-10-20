# Member portal (members.tvc.farm) — design

Status: **design draft, 2026-10-18. Step 1 of the build order (register, import, staff review
screen) is built; the rest is not.** Decisions come from Sharath's answers in the planning
conversation; open items are at the end. This is a public repo: no member names, contact details
or land records belong in it (see "Private data" below).

## Goal

A login-gated area for TVC members holding the non-public information about their farm unit and
house, letting them book their own stays, and showing maintenance payment status. It **replaces
the "TVC Spend Summary" workbook** (Member Master, Farm/House Patta Details, Maintenance tabs) as
the source of truth for member data after a one-time import.

## Decisions

| Area | Decision |
|---|---|
| Hosting | Section of the existing Netlify site, served on `members.tvc.farm` by host-based routing. No second site. |
| Language | English only, permanently. No kn/ta. |
| Login | Google and Apple; magic link or passkey as fallback. No Facebook. Emails are preloaded and members are invited; they can sign up any time. |
| Logins per unit | Max 2 (member + spouse/partner/co-owner). Children/others are future scope. |
| Memberships | A person can belong to more than one household; a household can include non-owners. |
| Edits | Members edit contact details freely. Name, ownership and plot data change only via admin approval. Admins fill data gaps; missing data shows as "not available yet". |
| Visibility | Members see their own data in full. Directory is opt-out. Own pattas in full; other households show farm no., area, cluster only. Admins see everything. Payment status (including who is overdue) is named and visible to all members. |
| Support | Super admins. Disputes go to the core team. |
| Rollout | Small v1, pilot with 5-6 members, paper/WhatsApp fallback. First-login privacy notice naming Syntropic Farm Management Pvt Ltd. |

## Data model (Supabase, TVC ERP project)

All tables get RLS; members read only through server functions, never directly.

- `member_households` — one per farm unit: `farm_unit` (`F-01`..`F-53`, unique), `house_no` (nullable: a household with no house built yet has none), `cluster`, `unit_type`.
- `member_people` — `full_name`, `email` (login identity), `phone` (nullable), `directory_visible` (default true), `auth_user_id`.
- `member_household_members` — person ↔ household, `role` (`owner` | `family` | `non_owner`), `can_login`. A trigger enforces max 2 `can_login` rows per household.
- `member_plots` — per farm unit: patta no., reference no., survey no., area (ha, acres), settlement, `patta_issue` flag. 80 rows are imported; some units have none yet.
- `member_house_pattas` — house patta records; most are still blank in the source sheet.
- `member_household_notes` — per-household flags such as a patta issue (built in step 1).
- `member_change_requests` — proposed edit to a protected field; admin approve/reject; audited.
- `maintenance_years` — `fy_start` (e.g. 2026), `amount_inr`, `due_date` (default 30 June of the FY start year), `grace_days` (default 0). Amount is per-year configuration.
- `maintenance_dues` — household × year: `amount_due`, `amount_paid`, `paid_on`, `reference`, `status` (derived: paid / pending / overdue after `due_date` + grace). History for earlier years is loaded as data arrives; gaps stay empty.
- `member_stays` — links to the existing accommodation tables (`accommodation_bookings`, guests, notices) with a member booking type. Member's own family stays are free; guests carry a price from config.
- `portal_settings` — admin config: guest discount (flat, v1), VPA, bank account number and IFSC, reminder wording.

Join key is the unit number `F-xx` from Member Master (it matches the vault). The patta tabs use a different farm numbering, and households can swap houses (two did, by mutual agreement, and Member Master still had the old numbers, so the import applies a private correction), so a patta row is scored against every household by name words, with the sheet's farm number then house number as tie-breakers. **Farm patta follows the farm plot; house patta follows the house.** A house patta still in a previous owner's name is flagged as needing a transfer. The portal must therefore record house assignment changes as an admin-approved, audited change with history (step 2's change requests), never a silent edit; stays and maintenance hang off the household, not the house.

## Member stories (replaces the "TVC Members: Your Story" Google Form)

Agreed 2026-10-20. One story per person, public-facing only: no separate members-only version.

- **Editing:** "Your story" page, one section per login in the household card (so partners no longer
  need hand-merging). Fields as on the form: what you do today, family, one-line "why TVC", photo,
  social link. Only name and the why line are required. Autosave draft, live card preview (reuses the
  `MembersView` card), status chip (Draft / In review / Live).
- **Check before you submit (member-approved, never automatic):** a "Review my story" step runs a
  spelling, grammar and framing pass and shows suggestions beside the member's own text. Framing
  covers third-person voice for the bio and family (house style; the why-TVC quote stays first
  person), tone against the rest of the site, and flagging children's names or photos of minors.
  The member accepts or rejects each suggestion, edits freely, and only then presses Submit. The
  model never rewrites silently and the submitted text is always what the member approved.
  Implemented as a Netlify function calling the existing Claude/Gemini setup (see `search-ai.mts`
  for the daily cap and fallback pattern; also log it in `USAGE.md`'s meters). Story text is sent to
  the model provider, so the privacy notice must say so. Per-member daily limit.
- **Review:** the core team still approves every public submission, including every edit to a live
  story; the old text stays live until the new one is approved. This keeps the promise on the guide
  page that nothing is published without a human. Reviewers now see a pre-checked story, so the
  queue is mostly approve/reject, not rewriting.
- **Publishing:** approved stories queue and go out in one batched build (Netlify credits; a
  few hours' lag is acceptable), exported from Supabase to the static Members page. The 53 existing
  cards are seeded as pre-approved starting stories and are claimed on first login.
- **Member directory (inside the portal):** logged-in members can browse every other member's
  profile, using the same card content as the public page; a household with no submitted story shows
  its existing one-line card. This is a deliberate extension of the visibility rule above (other
  households otherwise show farm no., area, cluster only) and is covered by the first-login privacy
  notice and the `directory_visible` opt-out.
- **Public website toggle (agreed 2026-10-20):** each story has a "Show on tvc.farm" switch, so a
  member can be in the portal directory without being on the public site. Approved stories are
  always visible to members; only those with the switch on go into the public export. Default is
  **off**, so nothing is public unless the member turns it on. The switch is on the submit step and
  stays editable afterwards. Turning it on, or editing the text of a story that is already public,
  goes through review; turning it off takes effect at the next batched publish (an admin can force
  an immediate build for removal requests). The seeded 53 cards keep their current public status.
  The review check and reviewers' queue apply to the story text either way, so a member-only story is
  still checked once and approved once.
- **Editor layout (chosen 2026-10-20 from a clickable prototype):** split view. Form on the left (what
  you do today, family, why TVC, photo, profile link), then the "Review my story" panel, then the
  "Show on tvc.farm" switch and a single "Check & submit" button. A sticky live preview of the card
  sits on the right (above the form on phones). "Check & submit" runs the check first if it hasn't
  been run, and submit stays blocked until each suggestion is accepted or dismissed. Not chosen: a
  one-question-at-a-time wizard and an edit-on-the-card layout.
- **Retires:** the Google Form and its name dropdown, the response Sheet, `check-member-story-responses.mjs`,
  and the member-update email Action (replaced by an admin approval queue and its own notification).
  `story-guide.astro` is replaced by in-portal help text.
- **Table:** `member_stories` (migration 0044), one row per person, a new table beside the register
  tables (FK to `member_people`; the register tables are unchanged). Three copies of the text, as jsonb
  `{ bio, family, why, social }`: `draft` (what the member is writing), `submitted` (the snapshot in
  review) and `approved` (live), so an edit never disturbs approved text; `status` draft | in_review |
  approved | rejected, `show_on_public_site` (default false; `draft_public`, `submitted_public`,
  `approved_public` per copy), `reviewer_note`, `reviewed_by`. Photos are not built yet; when they are,
  public-site photos must end up as the existing 400x400 JPEG (plus `photoFull`) beside the others, so
  they are stored at approval time, not left in a private bucket.
- **Built so far (2026-10-20, branch `member-stories-editor`):** the table, the "Your story" page
  (Editor A), the writing check (Anthropic via `lib/anthropic.ts`, plus fixed privacy checks),
  draft/save/submit endpoints in `members-me.mts`, and privacy notice v3 (names Anthropic).
  **Approval queue (branch `member-stories-queue`):** a panel on `/internal/members` listing stories in
  review with what changed against the approved copy; admins (`manage`) approve, or send back with a
  required note the member sees. Anything that publishes must read `approved`, not `status`: a rejected
  edit leaves the earlier approved text live.
  **Member directory (branch `member-directory`):** the portal's Directory lists the other members as
  households (name, farm plot, house number, cluster) with each person's approved story; opt-out via
  `directory_visible`; no contact details, land records or documents. Privacy notice v4.
  **Still to do:** seeding the 53 existing cards (needs a private person-to-card mapping; until then
  households with no approved story show only names), photos, and the batched export to the public
  Members page.

## Access and roles

- Reuse `staff_users` / `staff_module_roles` / audit log for admins and super admins. Add a `member_portal` module.
- Members are a separate identity class: sign-in succeeds only if the verified email matches a `member_people.email` with `can_login`. Unknown emails are refused with a "contact the core team" message.
- Sensitive columns (email, phone) follow the existing masking and write-only rules for staff; a member sees only their own.
- Every admin edit and approval is written to the audit log before the change.

## Stays

- Member books for own family: no limit, free. Notifies the member, Madhavan and the core-team email; updates the accommodation calendar. Email and WhatsApp (existing opt-in/opt-out flow).
- A member's guests are paid at a flat configurable discounted rate (outside Razorpay and Linger). The member supplies guest details at booking; guest WhatsApp uses the existing opt-in flow.
- Event priority: if an event covers a booked date, **nothing is cancelled automatically**. The clash is flagged to the core team and Madhavan for offline resolution.

## Maintenance and payment

- Financial year 1 April – 31 March. Members are expected to pay before the end of June of the FY's start year (default `due_date` = 30 June; no grace period). It is a per-year config so it can change.
- Every member sees named status for all households (paid / pending / overdue), matching the existing email/WhatsApp reminders.
- **Pay now:** a server-generated UPI QR plus a "Pay with UPI app" link for phones, built from
  `upi://pay?pa=<company UPI ID>&pn=Syntropic Farm Management&am=<amount>&tn=<ref>&tr=<ref>&cu=INR`. The UPI ID is stored in `portal_settings`, not in this repo.
  `<ref>` is unique, e.g. `TVC-MAINT-F27-2627` or `TVC-STAY-0042`. QR rendered with the existing `qrcode-generator` dependency. No Razorpay.
- **Bank transfer alternative:** for members who prefer NEFT/IMPS/RTGS (or a payment above their UPI limit), show the company's Axis Bank current account details (Syntropic Farm Management Pvt Ltd) next to the QR, with the same unique reference to quote in the remark. The account number and IFSC are stored in `portal_settings` (editable by super admins), **not committed to this repo**; they match the Axis account already used in the finance workbook.
- **Confirmation:** v1 is manual — Sharath marks a payment received. Later, match incoming credits by reference + amount + date from the Axis statement; unmatched go to a manual queue. The existing UPI sync reads BHIM PDFs, not credits to this VPA, so matching needs a new source.

## Import plan

1. Read Member Master, Farm/House Patta Details and Maintenance tabs (read-only, service account) and the vault person/place notes in `~/Documents/GitHub/docs`.
2. Normalise to the model above keyed on `F-xx`; produce a report of anomalies (blank house numbers, missing pattas, name mismatches) for admins to fix.
3. Known data fixes (a duplicated person, two swapped houses, a mis-filed cluster) are applied from a **private** `--fixes` JSON file, never from the repo. Emails sit inside Google people chips in Member Master and are read by `scripts/export-member-sheet.mjs`; most people have one, none has a phone number, so remaining contact details are collected at first login.
4. Load payment history from the yearly tabs; leave unknown years empty.
5. Freeze the workbook tabs once the portal is the source of truth.

## v1 build order

1. Schema + import + admin review screen (no member login yet). **Built 2026-10-18** (migration 0040, `scripts/import-members.mjs`, `/internal/members`); maintenance tables and history import moved to step 3 because the maintenance tabs have no unit number to join on.
1b. **Staff editing built 2026-10-18**: `edit` / `manage` capabilities on the `members` module and edit forms in the household dialog (names, write-only email and phone, membership, house/cluster, patta records), audited before each change. This is how data gaps are fixed before members are invited.
2. Member sign-in, allow-list, own profile and plot, contact edit, change requests, privacy notice.
   **First slice built 2026-10-18** (`/members/`, `members-me.mts`, migration 0041): Google sign-in for invited members only, the web-portal shell (left menu, unit chip, widget dashboard), My unit and household, and editing their own mobile number and directory listing; staff invite switch in the register. **Since built:** `members.tvc.farm` host routing (2026-10-18) and the first-login privacy notice (migration 0042; text and version in `scripts/lib/member-privacy.mjs`, shown before any data is released, re-read from the account menu). **Still to do in step 2:** Apple sign-in, the invitation email, change requests for protected fields, and a way to change a sign-in email safely.
3. Maintenance status (all members) + UPI QR + manual mark-paid.
4. Own-stay booking + notifications + event-clash flag + guest pricing.
5. Member stories: editor and writing check (built, see above), then approval queue, directory, photos and the public export. It can run alongside steps 3-4 as the first pilot feature.
6. Pilot with 5-6 members, then everyone.

### Land documents (built 2026-10-19, ahead of step 2's change requests)

Members upload their patta / land survey PDF; the details are read and either verify the record
already in the register or create a pending one for the core team. Decisions:

- **Template, not AI.** The two e-Services layouts (Integrated Land Record, chitta) are
  machine-generated and parse deterministically with `unpdf`; nothing is sent to a third party and the
  privacy notice needed no change. Anything unrecognised (scans, photos, sale deeds, encumbrance
  certificates) goes to the core team untouched.
- **What "verified" means:** the register's survey no. (and patta no. / area / owners where the
  document gives them) agree with a government extract the member uploaded. It is *not* checked
  against the e-Services server (the reference number on the page can be verified there by hand), so
  staff can open any document and the audit log records what was applied.
- **A-Register owner names are not readable** (damaged Tamil text), so a farm record verifies on
  survey/patta/area. A new entry is always held for the core team regardless.
- **Files live in a private Cloudflare R2 bucket**, not Supabase: they are rarely opened, R2 has 10 GB
  free and no download fees, and it keeps them off the Supabase free-tier quota. All access is through
  `land-doc-storage.ts`, so the store can change. The privacy notice (version 2) names Cloudflare.
- **Limits:** PDF 1 MB, photo 3 MB, 20 MB per household, 10 uploads a day. A PDF that isn't one of the
  two e-Services layouts is refused at upload and never stored, so unrelated large or junk files
  can't accumulate or reach the staff queue; only photos/scans (which can't be read) do.
- Verified rows carry `verification`, `verification_source` and the source document; a core team
  approval of a mismatch replaces the register's values with the document's.

Out of scope for v1: announcements, documents library, maintenance requests, polls, children as users, payment auto-matching, other languages.

## Open items

- The company UPI ID looks like a PhonePe-for-business handle. Test a small real payment to confirm the amount and reference carry through and that payers' apps don't cap it, and check the UPI per-transaction limit for ₹75,000 maintenance payments (the BHIM cap is a different account).
- "Pay before end of June" is read as 30 June of the FY start year; confirm that is what members expect.
- Host-based routing on the shared site: confirm cookie scoping so member sessions don't leak to the public site, and that the CSP and analytics stay off the portal pages.
- Stories: should a member be able to be in the directory but not on tvc.farm? Settled: yes, the "Show on tvc.farm" switch, default off.
- Stories: per-member and daily caps on the writing check are 10 and 300 a day; revisit once real use shows what members need.
- Docs to update when building: `ARCHITECTURE.md`, a new `MEMBERS.md`, `CONTEXT.md` glossary (Member, Household, Unit).

## Private data

The repo is public. The import's inputs and corrections are not: `tabs.json` (exported from the
workbook, contains emails) and the `--fixes` file (names real people and houses) live outside the
repo, as does the workbook id (`MEMBER_SHEET_ID`). Test fixtures use made-up people. Never commit
member names, contact details, patta numbers or the bank/UPI details.
