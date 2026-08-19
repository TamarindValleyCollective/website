# WhatsApp

> **Keep this file up to date.** Whenever what we actually do with WhatsApp changes — the Cloud
> API integration goes live, a new webhook/template is added, the AISensy account's status
> changes, etc. — update this file in the same change. See the note in `AGENTS.md`.

## What we actually do with WhatsApp today

The site's only live WhatsApp touchpoints are plain `wa.me` click-to-chat links — the Friends of
TVC group invite, the `/contact` and booking-inquiry links (see `ARCHITECTURE.md`). There is no
WhatsApp Business Platform integration in the codebase yet: no API keys, no webhooks, no
server-side calls from `netlify/functions/`.

## AISensy account (existing, not the chosen integration path)

TVC has an AISensy account (project "Syntropic Farm Management Private Limited", Free Forever
plan) predating this effort. As of 2026-08-19:

- **WhatsApp Business API status: PENDING** — the one remaining onboarding step is "Apply for
  WhatsApp Business API" via a "Continue With Facebook" button (Meta OAuth linking), not yet
  completed.
- **Templates**: 6 total. One real, approved template — `meeting_feedback_message` (TVC Monthly
  Meeting feedback, with Excellent/Satisfactory/Not satisfied quick-reply buttons, approved
  2026-01-03). Five rejected generic e-commerce/onboarding-wizard templates from 2025-12-25
  (`cart_drop_without_incentive`, `cart_drop_with_incentive_sku`, `cart_drop_with_incentive`,
  `order_information`, `sample_template_message`) — not tailored to TVC, not usable.
- **Contacts**: 9 contacts loaded (several tagged "Member"), but no messages ever sent/received
  through the account — looks like an imported list, not conversation history.
- **AI Agent** (Agent Studio): not configured.
- **Free-plan API access**: only the basic API Campaign Key (template-triggered outbound send,
  `POST backend.aisensy.com/campaign/t1/api/v2`) is available for free. **Project API Keys** and
  **Project Webhooks** — the pieces needed for a real two-way, site-triggered integration — are
  gated behind the PRO plan (₹3,040/month and up).

**Decision**: go directly against Meta's WhatsApp Cloud API instead of paying for AISensy PRO.
The Cloud API itself and its webhooks are free at the platform level (Meta only charges
per-message once outside a free service/utility window); AISensy's PRO gate would just be paying
for API access Meta gives away for free. The AISensy account is left as-is (not deleted, not
progressed) — its one approved template and pending Meta application are not part of the chosen
path.

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
  Verified**. It was provisioned via AiSensy as tech provider (payment method is currently an
  AiSensy Communications Private Limited credit line) but it's owned by TVC's own business, not
  AiSensy's — usable as the WABA for a direct integration.
- **Phone numbers already attached to this WABA**: two Meta-auto-provisioned `+1 555-xxx` test
  numbers (display name rejected, not usable for production), and **`+91 80 6252 4957`**
  (India, Bangalore), named "Tamarind Valley Collective," status **Unverified** — the real
  candidate production number, just needs the OTP verification step done.
- **No Meta Developer app** and **no System User** exist yet in this Business Manager — these
  are the actual remaining work, not the business/WABA/verification setup the original checklist
  assumed would be needed from scratch.

This significantly shortens phases 1–3: skip straight to app creation, phone number
verification, and system-user token generation below.

One thing already checked off from the original assumption too: `LEGAL_ENTITY_NAME` in
`src/data/site-facts.ts` matches the Business Manager's legal name exactly, avoiding Meta's most
common verification-rejection reason (name mismatch) — moot now since verification is already
done, but confirms nothing needs fixing there.

### Phase 1 — Meta app (minutes)

- [x] Meta Business Manager exists for Syntropic Farm Management Private Limited — confirmed
      2026-08-19.
- [x] App created 2026-08-19: **"TVC Site Messaging"**, App ID `1272328798239463`
      (app name "TVC WhatsApp Integration" was rejected — Meta blocks trademarked terms like
      "WhatsApp" in app names), Business-type, "Connect with customers through WhatsApp" use
      case, linked to Syntropic Farm Management Private Limited.
- [x] WhatsApp product added as part of app creation.
- [ ] In API Setup ("Step 2. Production setup" under the "Connect on WhatsApp" use case), point
      it at the **existing WABA** (`1546242986597983` — "Tamarind Valley Collective") — the
      in-app "Add phone number" flow looked like it would spin up a new default WABA instead of
      reusing the existing one, so this needs the WhatsApp Manager route (see Phase 3) rather
      than the API Setup wizard directly.
- [x] Phone Number ID recorded for the existing candidate number: `929386003589539` (for
      `+91 80 6252 4957`). WABA ID: `1546242986597983`.

### Phase 2 — Business verification

- [x] Already verified (12 Jul 2025) — confirmed 2026-08-19. Nothing to do here.

### Phase 3 — Phone number + permanent access token

- [x] **Production phone number decided and verified**, 2026-08-19: **`+91 80 4110 9754`**
      (landline, Bangalore) — Sharath's choice, added to the existing WABA
      (`1546242986597983`) via WhatsApp Manager → Phone numbers → Add phone number. Phone
      Number ID: `1241370129064258`. Verified via voice call (landline, so SMS wasn't an
      option) — status moved from Unverified straight to **Pending** (verification done, now
      awaiting final activation). `+91 80 6252 4957`, the old unrecognized placeholder number,
      was left alone/untouched.
- [x] Business profile set for the new number: display name "Tamarind Valley Collective"
      (status **In review**), category "Other" (no farming/community category exists),
      description "Tamarind Valley Collective is a farming collective at tvc.farm.", website
      `https://www.tvc.farm/`. Per WhatsApp's display name guidelines, a name matching how the
      business is actually branded on its website should qualify — added the website field
      specifically to reinforce that link ahead of review, since the same name was rejected on
      the other numbers. Outcome not yet known as of 2026-08-19.
  - Note: the browser's `type` action twice silently dropped characters/spaces when writing the
    description in one long burst (e.g. "collective" → "collectiv", missing spaces between
    words) — worth typing in short chunks and zooming in to verify when editing text fields on
    this Meta UI in future sessions, rather than trusting a single long `type` call.
- [ ] In Business Settings → **Users → System Users**, create a System User with the **Admin**
      role. **Blocked as of 2026-08-19**: creating one fails with a generic "You chose an invalid
      system user name. Please choose another" error regardless of the name tried (tried three
      different names, including a plain generic one) — points away from the name itself and
      toward an account-level restriction. Security Centre shows **0 of 2 people have two-factor
      authentication enabled** on this business portfolio, which is a common reason Meta silently
      blocks sensitive actions like this. Sharath is handling 2FA himself; retry system user
      creation once that's done.
- [ ] Assign that System User to both the app (`1272328798239463`, "TVC Site Messaging") and the
      existing WABA (`1546242986597983`).
- [ ] Generate a **permanent access token** for the System User, scoped to just:
  - `whatsapp_business_messaging`
  - `whatsapp_business_management`
- [ ] Hand the token to Claude (or set it directly) as a Netlify environment variable — never
      commit it to the repo. Same handling as `ANTHROPIC_API_KEY` / the Google service-account
      keys already used by other functions.
- [ ] Check whether messages sent via the new app still bill against the existing AiSensy credit
      line on the WABA, or whether a direct payment method needs adding in Payment settings —
      unresolved as of 2026-08-19, worth confirming before real send volume.

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
- [ ] Update `ARCHITECTURE.md`'s function list and diagram once this function is live, per the
      standing instruction in `CLAUDE.md`.

## Business Manager account hardening (2026-08-19, alongside the checklist above)

Sharath asked for help with the Security Centre's "Action needed" list on the Syntropic Farm
Management Private Limited Business Manager, since the System User blocker pointed at 2FA
coverage there. Findings and actions:

- **Trusted domains**: `tvc.farm` and `syntropic.in` were already listed as approved domains —
  nothing to add.
- **Ad account peer approval**: not touched — requires knowing how TVC's ad account/ads are
  actually managed, which wasn't established; not a blocker for the WhatsApp work either way.
- **Users with a public email domain**: flagged `sharathjeppu@gmail.com` (Sharath's own login)
  and `rajeshinf@yahoo.com` (Rajesh Kumar Thiagarajan). Did **not** remove either outright.
  Instead, invited **`sharath@syntropic.in`** with Full access ("Everything") as a replacement
  for the gmail account — currently **"Needs approval"** since Meta requires another full-access
  admin to approve full-control invitations; Rajesh is the only other full-access user, so he's
  the one who needs to approve it (and *not* be removed himself in the meantime, or nobody could
  approve it). Sharath also separately invited `contact@tvc.farm`. `sharathjeppu@gmail.com`
  stays in place until both new accounts are confirmed active — removing it first risks locking
  Sharath out before the replacement works.
- **2FA**: Sharath is enabling this himself; System User creation should be retried once done.

## Open decisions (not yet made)

- What the first real trigger is: an internal staff alert on new Visit/general-enquiry form
  submissions, a customer-facing confirmation, or something else.
- Whether to reuse the AISensy-approved `meeting_feedback_message` content/intent for a
  Meta-native UTILITY template, or start fresh.
