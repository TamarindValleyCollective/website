# WhatsApp

> **Keep this file up to date.** Whenever what we actually do with WhatsApp changes — the Cloud
> API integration goes live, a new webhook/template is added, etc. — update this file in the
> same change. See the note in `AGENTS.md`.

## What we actually do with WhatsApp today

The site's only live WhatsApp touchpoints are plain `wa.me` click-to-chat links — the Friends of
TVC group invite, the `/contact` and booking-inquiry links (see `ARCHITECTURE.md`). There is no
WhatsApp Business Platform integration in the codebase yet: no API keys, no webhooks, no
server-side calls from `netlify/functions/`. The integration is being built directly against
Meta's WhatsApp Cloud API (not through a third-party BSP) — see the checklist below.

## Direct Meta Cloud API integration — setup checklist

Four phases. Phases 1–3 need your own Meta/Facebook login and (for verification) business
documents — Claude can't do these. Once the app exists and a test number/token are available,
the webhook Netlify function (phase 4) can be built and tested against them in parallel with
business verification, which is the slow part.

**2026-08-19 update — most of phases 1–2 were already done, unrelated to this effort.** Walked
the Meta Business Suite with Sharath (business.facebook.com) and found:

- A Business Manager already exists — **"Syntropic Farm Management Private Limited"**
  (portfolio ID `193847045525749`), with the correct legal name, address, Tax ID
  (`U01120KA2022PTC161809`, matching `LEGAL_ENTITY_CIN`), and website (`tvc.farm`) already on
  file. No duplicate needed.
- **Business verification status: Verified** (12 Jul 2025). Phase 2 is done — no documents to
  upload, no waiting.
- A **WhatsApp Business Account already exists** under it — "Tamarind Valley Collective"
  (WABA ID `1546242986597983`), **Account status: Approved**, **Business verification:
  Verified**. It was provisioned via AiSensy as tech provider, but it's owned by TVC's own
  business, not AiSensy's. Its billing turned out to be locked to AiSensy's own credit line with
  no self-service way to detach it — this WABA was later abandoned in favor of a fresh one; see
  the 2026-08-19 pivot note below.
- **Phone numbers already attached to this WABA**: two Meta-auto-provisioned `+1 555-xxx` test
  numbers (display name rejected, not usable for production), and **`+91 80 6252 4957`**
  (India, Bangalore), named "Tamarind Valley Collective," status **Unverified** — the real
  candidate production number, just needs the OTP verification step done.
- **No Meta Developer app** and **no System User** exist yet in this Business Manager — these
  are the actual remaining work, not the business/WABA/verification setup the original checklist
  assumed would be needed from scratch.

This significantly shortens phases 1–3: skip straight to app creation, phone number
verification, and system-user token generation below.

**2026-08-19 update (later same day) — production number decided and display name
approved.** Checked WhatsApp Manager → Phone numbers directly:

- The candidate number changed from `+91 80 6252 4957` (unrecognized placeholder, never
  verified) to **`+91 80 4110 9754`** (India), now the only India number on the WABA — the old
  placeholder number is no longer listed.
- **Display name "Tamarind Valley Collective" is Approved** for this number (WhatsApp Manager →
  Phone numbers → this number → Profile tab shows the green "Approved" tag next to the name).
  Phone Number ID: `1241370129064258`.
- The number already shows up under the WABA's "WhatsApp accounts" overview with working
  message-delivery insights tracking (0 sent so far), and the Two-step verification tab's
  copy ("when registering your phone number with WhatsApp again") implies it's already
  registered — though the Phone numbers list still shows its row status as "Pending" (likely a
  quality-rating/messaging-tier state given zero send volume yet, not a registration blocker).
  Worth a quick re-check before Phase 4 go-live.
- The top-of-page "Your display names were rejected" banner is stale/account-level — it still
  refers to the two `+1 555-xxx` Meta test numbers, whose names remain **Rejected**; those
  numbers aren't part of the production path.

One thing already checked off from the original assumption too: `LEGAL_ENTITY_NAME` in
`src/data/site-facts.ts` matches the Business Manager's legal name exactly, avoiding Meta's most
common verification-rejection reason (name mismatch) — moot now since verification is already
done, but confirms nothing needs fixing there.

**2026-08-19 update (pivot) — abandoning the AiSensy-provisioned WABA, starting a fresh one.**
The WABA above (`1546242986597983`) turned out to have a hard billing problem: its only payment
method is a "credit line" allocated from AiSensy (Meta bills AiSensy's entity directly — both
"Bill-to party" and "Sold-to party" are AiSensy Communications Private Limited — not TVC), and
its available credit already shows "Low." Tried every self-service angle to detach it: became a
finance editor, tried "Add payment method" (blocked — "You can't add a payment method because
you're using a shared credit line"), checked the credit line's own "..." menu (only "Edit," which
is just a PO-number field) and its details page (no disconnect control). There's no self-service
way to move this WABA off AiSensy's credit line — only AiSensy (who allocated it) or Meta support
could release it.

Decision: abandon that WABA rather than depend on AiSensy's cooperation. Started creating a
**brand-new WABA** via the same route previously avoided (Meta app → Connect on WhatsApp → Step 2
→ "Register your WhatsApp phone number" → "Add phone number" → "Create a WhatsApp Business
profile") — this time deliberately, since forking a new WABA is now the goal rather than a risk.
Reused the same business profile info (display name "Tamarind Valley Collective," category
Other, description "Tamarind Valley Collective is a farming collective at tvc.farm.") so it reads
identically to customers.

For the phone number, chose to **migrate** `+91 80 4110 9754` into the new WABA rather than get a
different number — typed the existing number into the new WABA's "Add your WhatsApp phone
number" step, and Meta accepted it and went straight to sending an OTP with no warning about it
already existing elsewhere, confirming this is being treated as a migration rather than a
conflict. Hit two problems getting the OTP itself: the number is a Bangalore landline (STD code
080) that can't receive SMS, and after the SMS attempt + an auto voice-call retry, Meta rate-
limited further code requests ("You have requested a verification code too many times"). Phone
call is now correctly selected as the verification method. **Next step**: once the rate limit
clears, click "Resend code" with phone call selected — Sharath needs to actually answer that
call and read out the 6-digit code, Claude can't receive audio. The new WABA's ID isn't known yet
(not confirmed until phone verification completes); display name approval status for the new
WABA is also unknown yet — it passed once already on the old WABA (2026-08-19, see above), which
is a good sign but not a guarantee it'll pass again on a fresh review.

The old WABA (`1546242986597983`) is left as-is, not deleted — its approved display name and
verified business status don't transfer, but there's no reason to touch it further.

### Phase 1 — Meta app (minutes)

- [x] Meta Business Manager exists for Syntropic Farm Management Private Limited — confirmed
      2026-08-19.
- [x] App created 2026-08-19: **"TVC Site Messaging"**, App ID `1272328798239463`
      (app name "TVC WhatsApp Integration" was rejected — Meta blocks trademarked terms like
      "WhatsApp" in app names), Business-type, "Connect with customers through WhatsApp" use
      case, linked to Syntropic Farm Management Private Limited.
- [x] WhatsApp product added as part of app creation.
- [x] In API Setup ("Step 2. Production setup"), created a **new WABA** via the wizard's "Create
      a WhatsApp Business profile" step, rather than pointing at the old AiSensy-provisioned one
      — see the 2026-08-19 pivot note above for why. New WABA's ID not yet known (confirmed once
      phone verification completes).
- [ ] Phone Number ID for `+91 80 4110 9754` on the **new** WABA — not yet known; the old ID
      `1241370129064258` was on the abandoned WABA (`1546242986597983`) and doesn't carry over.

### Phase 2 — Business verification

- [x] Already verified (12 Jul 2025) — confirmed 2026-08-19. Nothing to do here.

### Phase 3 — Phone number + permanent access token

- [x] **Decide the real production phone number.** `+91 80 4110 9754`, being migrated from the
      old AiSensy-provisioned WABA to the new one (see 2026-08-19 pivot note above).
- [ ] **OTP/migration in progress, blocked on rate limit — 2026-08-19.** Entered
      `+91 80 4110 9754` into the new WABA's phone-number step; Meta accepted it as a migration
      and sent an OTP. SMS failed (landline, can't receive SMS); an auto voice-call retry also
      failed; further attempts are now rate-limited ("You have requested a verification code too
      many times"). Phone call is selected as the method. **Next step**: once the limit clears,
      click "Resend code" — Sharath must answer the call himself and read out the 6-digit code,
      Claude can't receive audio.
- [ ] **Display name approval** — unknown yet for the new WABA (review happens after phone
      verification). It passed once already on the old WABA, which is a good sign but not a
      guarantee.
- [x] In Business Settings → **Users → System Users**, created a System User "apiuser" with the
      **Admin** role — 2026-08-19. Was blocked by a generic "invalid system user name" error
      until 2FA got enabled for the account admins (Security Centre → Two-factor authentication);
      once that was done, creation worked on the first retry with a plain name. System User ID:
      `61593713270653`.
- [x] Assigned that System User to the app (`1272328798239463`, "TVC Site Messaging") and the
      **old** WABA (`1546242986597983`, full access) — 2026-08-19. Needs re-assigning to the new
      WABA once it exists (System Users are Business Manager-level, so this one is reusable).
- [ ] Generate a **permanent access token** for the System User, scoped to just
      `whatsapp_business_messaging` and `whatsapp_business_management`. Started 2026-08-19 for
      the old WABA — needs a **peer approval** from another admin (Rajesh Kumar Thiagarajan)
      before it's issued, since a System User can't approve its own token request. Request is
      pending, expires in 7 days from 2026-08-19. Once the new WABA exists, redo this token
      generation scoped to it instead.
- [ ] Hand the token to Claude (or set it directly) as a Netlify environment variable — never
      commit it to the repo. Same handling as `ANTHROPIC_API_KEY` / the Google service-account
      keys already used by other functions.

### Phase 4 — Webhook + templates (Claude builds this once phase 1–3 credentials exist)

- [ ] New Netlify function (alongside `chat.mts`, `enquiry.mts`, `rainfall.mts`) as the webhook
      endpoint — handles Meta's GET verification handshake, then receives `messages` and
      `message_template_status_update` events over HTTPS.
- [ ] Configure the webhook URL + a verify token in the Meta App Dashboard (WhatsApp →
      Configuration → Configure Webhooks). Subscribe only to needed fields (`messages`,
      `message_template_status_update`; skip `calls`, `flows`, `payment_configuration_update`).
- [ ] Submit real templates in the **UTILITY** category (transactional — confirmations,
      notifications), not MARKETING — cleaner approval, longer free-window eligibility. First
      candidate: whatever trigger gets picked (see open decisions below).
- [ ] **Build a way to actually see and reply to incoming messages.** Meta provides no inbox of
      its own for Cloud API numbers — confirmed by checking every tab in WhatsApp Manager (no
      Messages/Inbox anywhere) and Meta's own docs ("the contents of any message... is
      communicated via webhook"). The webhook function above only receives messages; without
      this, they'd arrive with nowhere to see or answer them. Minimum viable version: route
      incoming messages to Slack/email and reply via a small script; a proper version would be a
      lightweight admin page hitting the Send Message API.
- [ ] Update `ARCHITECTURE.md`'s function list and diagram once this function is live, per the
      standing instruction in `CLAUDE.md`.

## Open decisions (not yet made)

- What the first real trigger is: an internal staff alert on new Visit/general-enquiry form
  submissions, a customer-facing confirmation, or something else.
- What content the first UTILITY template should have — a monthly-meeting-feedback-style
  template with quick-reply buttons worked well as a concept previously; worth deciding whether
  to reuse that idea or start fresh for whatever trigger gets picked.
