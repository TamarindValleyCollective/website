# WhatsApp

> **Keep this file up to date.** Whenever what we actually do with WhatsApp changes — the Cloud
> API integration goes live, a new webhook/template is added, etc. — update this file in the
> same change. See the note in `AGENTS.md`.

## What we actually do with WhatsApp today

The site's only live WhatsApp touchpoints are plain `wa.me` click-to-chat links — the Friends of
TVC group invite, the `/contact` and booking-inquiry links (see `ARCHITECTURE.md`). There is no
WhatsApp Business Platform integration in the codebase yet: no webhooks, no server-side calls
from `netlify/functions/`. Phases 1–3 (Meta app, business verification, phone number + permanent
access token) are done as of 2026-08-19 — a `WHATSAPP_ACCESS_TOKEN` now exists on Netlify, unused
by any function yet. The integration is being built directly against Meta's WhatsApp Cloud API
(not through a third-party BSP) — see the checklist below; only Phase 4 (webhook + templates)
remains.

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
call is now correctly selected as the verification method. Rate-limit cooldown is **~1 hour**
per Sharath. **Next step**: once it clears, click "Resend code" with phone call selected —
Sharath needs to actually answer that call and read out the 6-digit code, Claude can't receive
audio. The new WABA's ID isn't known yet
(not confirmed until phone verification completes); display name approval status for the new
WABA is also unknown yet — it passed once already on the old WABA (2026-08-19, see above), which
is a good sign but not a guarantee it'll pass again on a fresh review.

The old WABA (`1546242986597983`) is left as-is, not deleted — its approved display name and
verified business status don't transfer, but there's no reason to touch it further.

**2026-08-19 update (decommissioning check) — migration not confirmed complete yet, don't touch
the old WABA.** Before considering the old WABA for cleanup, checked both WABAs' Phone numbers
tabs: `+91 80 4110 9754` still appears in **both**, each showing status **Pending**. Per
migration docs (360dialog's guide on WABA-to-WABA number migration — Meta doesn't publish its own
detailed migration-status page), a completed migration marks the number **"Transferred"** in the
*source* WABA, checked directly in WhatsApp Manager; ours still reads "Pending" there, not
"Transferred," so the migration likely hasn't fully finished on Meta's backend yet, even though
phone verification succeeded on the new WABA. **Decision: leave the old WABA (`1546242986597983`)
completely alone for now** — no access changes, no removing AiSensy as a partner, no deletion.
**Recheck its Phone numbers tab before any decommissioning work**: once that row flips to
"Transferred," it's safe to clean up (revoke apiuser's assignment there, remove AiSensy's partner
access, consider full decommissioning). Until then, touching it risks the phone number itself.

**2026-08-19 update (later still) — new WABA phone verification complete.** Sharath answered
the verification phone call and confirmed the code. Checked WhatsApp Manager → Phone numbers on
the new WABA (asset ID `2166888700553540`, confirmed via Business Settings → WhatsApp accounts —
the same ID as the `asset_id` in the WhatsApp Manager URL): the "Phone number verification
required" banner is gone, and the number's status moved from **Unverified** to **Pending** — the
same terminal state the old WABA's number reached (a quality-tier/messaging-limit state from zero
send volume, not a registration blocker; see the 2026-08-19 update above). Display name
**"Tamarind Valley Collective" is Approved** on the new WABA too (confirmed banner + Profile tab).
Phone Number ID on the new WABA: **`1252670697930284`** (different from the old WABA's
`1241370129064258` — expected, IDs don't carry over between WABAs). Business Settings →
WhatsApp accounts confirms the new WABA: Account status **Approved**, Business verification
**Verified**, owned by Syntropic Farm Management Private Limited.

New gap found while there: the new WABA's Overview page shows a **"Missing valid payment
method"** alert — "Free tier conversations can only be initiated by your customers. You won't be
able to message customers until you've added a payment method." Expected, since ditching the
AiSensy shared credit line was the whole point of the pivot — this WABA has no billing attached
yet and needs its own payment method added before it can send customer-initiated messages. Also
confirmed only **Sharath Jeppu** has full access to the new WABA so far (Business Settings →
WhatsApp accounts → People tab) — the System User "apiuser" hasn't been assigned to it yet, so
that Phase 3 step below is still open.

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
      — see the 2026-08-19 pivot note above for why. New WABA ID confirmed 2026-08-19:
      **`2166888700553540`**.
- [x] Phone Number ID for `+91 80 4110 9754` on the **new** WABA confirmed 2026-08-19:
      **`1252670697930284`** (the old ID `1241370129064258` was on the abandoned WABA
      (`1546242986597983`) and didn't carry over, as expected).

### Phase 2 — Business verification

- [x] Already verified (12 Jul 2025) — confirmed 2026-08-19. Nothing to do here.

### Phase 3 — Phone number + permanent access token

- [x] **Decide the real production phone number.** `+91 80 4110 9754`, being migrated from the
      old AiSensy-provisioned WABA to the new one (see 2026-08-19 pivot note above).
- [x] **OTP/migration complete — 2026-08-19.** After the ~1 hour rate-limit cooldown, Sharath
      answered the verification phone call and read out the code. Confirmed in WhatsApp Manager:
      the "Phone number verification required" banner is gone and the number's status moved from
      Unverified to **Pending** (same terminal state the old WABA's number reached — a
      quality-tier state, not a registration blocker).
- [x] **Display name approval** — confirmed 2026-08-19: "Tamarind Valley Collective" is
      **Approved** on the new WABA too.
- [x] In Business Settings → **Users → System Users**, created a System User "apiuser" with the
      **Admin** role — 2026-08-19. Was blocked by a generic "invalid system user name" error
      until 2FA got enabled for the account admins (Security Centre → Two-factor authentication);
      once that was done, creation worked on the first retry with a plain name. System User ID:
      `61593713270653`.
- [x] Assigned that System User to the app (`1272328798239463`, "TVC Site Messaging") and the
      **old** WABA (`1546242986597983`, full access) — 2026-08-19.
- [x] **Re-assign the System User to the new WABA** (`2166888700553540`) — done 2026-08-19: via
      Business Settings → WhatsApp accounts → the new WABA → Assign people → apiuser (System
      user) → Full access ("Everything"). apiuser now shows 3 assigned business assets (the app
      plus both WABAs, old and new).
- [x] Generate a **permanent access token** for the System User. Done 2026-08-19: the request
      from earlier the same day (started against the old WABA, pending peer approval) turned out
      to already be approved by Rajesh Kumar Thiagarajan by the time we came back to it — System
      Users page showed "Access token generation approved." Generated the token after
      re-assigning apiuser to the new WABA above, so it now covers both WABAs' full access scope
      (not narrowed to just `whatsapp_business_messaging`/`whatsapp_business_management` — Meta's
      generation flow ties the token to the System User's current asset permissions, not a
      per-generation scope picker).
- [x] Hand the token to Claude (or set it directly) as a Netlify environment variable — never
      commit it to the repo. Done 2026-08-19: set as `WHATSAPP_ACCESS_TOKEN` on the `tvc-farm`
      Netlify site, scoped to Builds/Functions/Runtime with 5 deploy-context values, matching
      `ANTHROPIC_API_KEY`'s existing pattern. Sharath pasted the value directly into Netlify's UI
      himself — Claude navigated the browser and set up the field but never read or handled the
      raw token value (blocked by design from entering credentials).
- [x] **Add a payment method to the new WABA.** Done 2026-08-19: Sharath added a Visa card
      (···· 8866) via Business Settings → the new WABA → Preferences → Payment settings → Billing
      & payments → Add payment method (note: WhatsApp Manager's own "Payment configurations" side
      nav is a different feature — WhatsApp Pay for customer order payments, not this account
      billing). Now shows as the account's default payment method, own billing entirely separate
      from AiSensy's credit line (no credit line shows on this account at all) — the direct payoff
      of the pivot. A ₹3.00 card-verification charge went through and is processing a refund, as
      expected for this kind of card-add flow.

### Phase 4 — Webhook + templates (Claude builds this once phase 1–3 credentials exist)

- [x] **New Netlify function** `netlify/functions/whatsapp-webhook.mts` — done 2026-08-19.
      Handles Meta's GET verification handshake (`hub.mode`/`hub.verify_token`/`hub.challenge`)
      and POST requests carrying `messages`/`message_template_status_update` events, each
      verified via its `X-Hub-Signature-256` HMAC signature (Node's built-in `crypto`, no new
      dependency) before being trusted. Tested locally against `netlify dev` (port 8888, since
      the plain `astro dev` server on 4321 doesn't serve Netlify Functions) — both handshake
      outcomes (correct/wrong verify token) and both event types (a valid-signature message, a
      template-status update) behave as expected; missing-signature and wrong-signature POSTs
      correctly return 401. See `ARCHITECTURE.md`'s function-list entry for the full design
      rationale.
- [x] **Build a way to actually see incoming messages** — minimum viable version done 2026-08-19,
      built directly into the webhook function above rather than as a separate piece: every
      inbound message triggers a notification email to `contact@tvc.farm` via the Resend REST API
      (`scripts/send-member-update-email.mjs`'s existing pattern — the first Netlify Function to
      call Resend, previously only reached from the member-update GitHub Action). No way to
      *reply* yet — that still needs a lightweight admin page hitting the Send Message API, left
      for later since replying isn't blocking anything else in this checklist.
- [ ] **Not yet live** — three things still needed before real events reach the function:
      1. Set `WHATSAPP_VERIFY_TOKEN` (an arbitrary string we choose, not Meta-issued — can be
         generated and set directly), `WHATSAPP_APP_SECRET` (from the Meta App Dashboard's Basic
         Settings — a real secret, needs Sharath to reveal/paste it, same handling as
         `WHATSAPP_ACCESS_TOKEN`), and `RESEND_API_KEY` (exists only as a GitHub Actions secret
         today — needs adding as a Netlify env var too, also needs Sharath to paste it) on
         Netlify.
      2. Configure the webhook URL (`https://tvc.farm/api/whatsapp-webhook`) + the same verify
         token in the Meta App Dashboard (WhatsApp → Configuration → Configure Webhooks).
         Subscribe only to `messages` and `message_template_status_update` — skip `calls`,
         `flows`, `payment_configuration_update`.
      3. Deploy to production (push to `main`) so the function is actually reachable at that URL.
- [ ] Submit real templates in the **UTILITY** category (transactional — confirmations,
      notifications), not MARKETING — cleaner approval, longer free-window eligibility. First
      trigger decided 2026-08-19: an internal staff alert on new Visit/general-enquiry form
      submissions (see resolved decision below) — template content itself still needs drafting.
- [x] Update `ARCHITECTURE.md`'s function list and diagram once this function is live, per the
      standing instruction in `CLAUDE.md`. Done 2026-08-19 alongside the function itself (diagram
      node, external-service node for Meta's Cloud API, prose entry, status table row — marked
      🟡 "Built, verified locally" until the three not-yet-live items above are done).

## Open decisions (not yet made)

- What content the first UTILITY template should have (trigger is decided — see below) — a
  monthly-meeting-feedback-style template with quick-reply buttons worked well as a concept
  previously; worth deciding whether to reuse that idea or start fresh for an internal enquiry
  alert instead (e.g. `New {{1}} enquiry from {{2}} — {{3}}`).
- Whether/when to decommission the old AiSensy-provisioned WABA (`1546242986597983`) — blocked on
  confirming the phone number migration actually finished (see the 2026-08-19 decommissioning
  check above); recheck its Phone numbers tab for a "Transferred" status before doing anything.

## Resolved decisions

- **First outbound trigger (2026-08-19):** an internal staff alert on new Visit/general-enquiry
  form submissions — lower risk than a customer-facing message, internal-only, easier template
  approval. Not yet built — needs the UTILITY template above submitted and approved first, then
  wiring a WhatsApp send call into `netlify/functions/enquiry.mts` (or a new function) alongside
  its existing Sheet-append.
- **Incoming-message notification channel (2026-08-19):** email via Resend, reusing the existing
  setup rather than standing up Slack — see the webhook function above.
