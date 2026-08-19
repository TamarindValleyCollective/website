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

One thing already checked off: `LEGAL_ENTITY_NAME` in `src/data/site-facts.ts` is `Syntropic
Farm Management Private Limited`, matching the AISensy project name — so the site footer/legal
name should already agree with whatever goes into Meta Business Manager, avoiding Meta's most
common verification-rejection reason (name mismatch).

### Phase 1 — Meta app + WABA (minutes)

- [ ] Go to [business.facebook.com](https://business.facebook.com) and confirm/create the Meta
      Business Manager for Syntropic Farm Management Private Limited (an existing one may already
      exist from the AISensy onboarding — check before creating a duplicate).
- [ ] Go to [developers.facebook.com](https://developers.facebook.com), create a new
      **Business**-type app.
- [ ] Link the app to the Meta Business Manager from the step above.
- [ ] Add the **WhatsApp** product to the app.
- [ ] Meta auto-provisions a test WABA (WhatsApp Business Account), a test phone number, and
      temporary credentials — enough to send test messages same-day.
- [ ] Record the **Phone Number ID** and **WABA ID** shown in API Setup — needed for every future
      API call.

### Phase 2 — Business verification (days to weeks — start this immediately, it's the long pole)

- [ ] In Business Manager: **Business Settings → Security Center → Start Business Verification**.
- [ ] Upload documents matching the Business Manager profile exactly — Certificate of
      Incorporation, a utility bill, or a bank statement. (CIN `U01120KA2022PTC161809`, PAN
      `ABICS6243H` — see `src/data/site-facts.ts` — should back whatever's submitted.)
- [ ] Double check every detail (legal name, address) matches `LEGAL_ENTITY_*` in
      `src/data/site-facts.ts` and the live site footer character-for-character.
- [ ] Wait for approval. This gates *production* sending to real numbers beyond a handful of test
      recipients — nothing else in this checklist is blocked on it, so keep going.

### Phase 3 — Phone number + permanent access token

- [ ] Decide on a **dedicated production phone number** — once registered for the API it can no
      longer be used in the regular WhatsApp/Business consumer app. Confirm this number isn't
      currently active anywhere else before registering.
- [ ] In API Setup, register that number (SMS or voice OTP verification).
- [ ] In Business Settings → **Users → System Users**, create a System User with the **Admin**
      role.
- [ ] Assign that System User to both the app and the WABA from phase 1.
- [ ] Generate a **permanent access token** for the System User, scoped to just:
  - `whatsapp_business_messaging`
  - `whatsapp_business_management`
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
- [ ] Update `ARCHITECTURE.md`'s function list and diagram once this function is live, per the
      standing instruction in `CLAUDE.md`.

## Open decisions (not yet made)

- What the first real trigger is: an internal staff alert on new Visit/general-enquiry form
  submissions, a customer-facing confirmation, or something else.
- Whether to reuse the AISensy-approved `meeting_feedback_message` content/intent for a
  Meta-native UTILITY template, or start fresh.
