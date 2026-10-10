# WhatsApp message templates to submit

The site can send WhatsApp **template** messages (the only kind allowed outside the 24-hour
customer-service window — see `WHATSAPP.md`). The code is deployed but **sends nothing until a
template is approved by Meta and its name is added to `WHATSAPP_APPROVED_TEMPLATES`**. The wording
below is the single source of truth in `netlify/functions/lib/whatsapp-templates.ts`; once Meta
approves a template its text is frozen, so changing wording means submitting a new template name.

## How to submit (WhatsApp Manager)

1. business.facebook.com → **WhatsApp Manager** → the "Tamarind Valley Collective" account →
   **Message templates** → **Create template**.
2. **Category: Utility** (not Marketing). **Language: English** (code `en`).
3. **Name:** exactly as below (lowercase, underscores). **Body:** paste the text exactly,
   including the `{{1}}`-style variables. No header, footer or buttons.
4. For each variable, give the **sample** value shown (Meta requires examples).
5. Submit. Approval is usually minutes to a day; the status shows in the same screen (and our
   webhook already receives `message_template_status_update`).

## The five templates

| Name | Variables | Sent when |
|---|---|---|
| `tvc_event_cancelled` | 1 first name · 2 event · 3 reason sentence · 4 refund amount | "Cancel event" refunds each booking (to the guest) |
| `tvc_refund_initiated` | 1 first name · 2 refund amount · 3 event | a single refund is started from the dashboard |
| `tvc_refund_processed` | 1 first name · 2 refund amount · 3 event | a refund is confirmed processed |
| `tvc_cancellation_declined` | 1 first name · 2 event · 3 note | staff decline a cancellation request |
| `tvc_staff_enquiry_alert` | 1 form type · 2 name · 3 message | a membership/general enquiry is submitted (to staff) |

### `tvc_event_cancelled`
```
Hi {{1}}, we're sorry — {{2}} has been cancelled. {{3}} A refund of {{4}} has been started to your original payment method and should reach you within a few business days. Questions? Reply here or email core-team@tvc.farm.
```
Samples: `Asha` · `Foraging Day` · `Heavy rain is forecast and the forest trails will not be safe.` · `₹2,250`

### `tvc_refund_initiated`
```
Hi {{1}}, we've started a refund of {{2}} for your booking for {{3}}. It should reach your original payment method within a few business days. Questions? Reply here or email core-team@tvc.farm.
```
Samples: `Asha` · `₹2,250` · `Foraging Day`

### `tvc_refund_processed`
```
Hi {{1}}, your refund of {{2}} for {{3}} has been processed and sent to your original payment method. Depending on your bank it can take a few more business days to show up. Questions? Reply here or email core-team@tvc.farm.
```
Samples: `Asha` · `₹2,250` · `Foraging Day`

### `tvc_cancellation_declined`
```
Hi {{1}}, thanks for your cancellation request for {{2}}. We're not able to cancel this booking under our cancellation and refund policy, so it stays confirmed. {{3}} If your plans have changed, reply here or email core-team@tvc.farm and we'll talk it through.
```
Samples: `Asha` · `Foraging Day` · `The event is less than 48 hours away.`

### `tvc_staff_enquiry_alert`
```
New {{1}} enquiry received on the TVC website from {{2}}. Their message: {{3}} Please reply to them from the contact inbox or the enquiries sheet.
```
(Meta rejected the first, shorter wording — "too many variables for its length"; a variable can't start or end the body. Submitted 2026-10-10 with this text.)
Samples: `membership` · `Asha Rao` · `I would like to know more about joining the collective.`

## Turning sending on (after Meta approves)

Set these in Netlify → Site configuration → Environment variables, then **redeploy** (functions
read env vars at deploy time):

| Variable | Value |
|---|---|
| `WHATSAPP_APPROVED_TEMPLATES` | comma-separated names that are approved, e.g. `tvc_refund_initiated,tvc_refund_processed` — add each as it's approved |
| `WHATSAPP_STAFF_ALERT_NUMBERS` | staff numbers for `tvc_staff_enquiry_alert`, comma-separated (any common format, e.g. `+91 98860 12670`) |
| `WHATSAPP_TEST_NUMBER` | optional: your own number. Test-mode bookings only ever WhatsApp this number (never the guest's); if unset they send nothing |
| `WHATSAPP_AUTOACK_ENABLED` | `true` turns on the out-of-hours auto-reply (off when unset). See "Out-of-hours auto-reply" below |
| `WHATSAPP_AUTOACK_HOURS` | optional staffed hours in IST, `HH:MM-HH:MM`; default `09:00-19:00`. Messages outside it get the auto-reply |

`WHATSAPP_PHONE_NUMBER_ID` and `WHATSAPP_ACCESS_TOKEN` are already set for the live integration.

## Behaviour to know

- A guest with no usable mobile number on file simply gets the email only.
- Free text (a refund reason, an enquiry message) is flattened to one line and truncated, because
  Meta rejects newlines in a variable. The guest-facing reason typed into "Cancel event" is shown in
  `tvc_event_cancelled` exactly as it is in the email.
- Failures are logged and never block the booking, refund or enquiry they ride along with.
- Sent template messages are not written into the `/internal/whatsapp` conversation list (that would
  bump conversations to "unread" and trigger the hourly stale-alert digest). Instead each one is
  tracked in `whatsapp_template_sends` (migration `0032`): Meta only says "accepted" when we send,
  and the later webhook `statuses` events move it through sent → delivered → read, or failed with
  Meta's reason. The Event Payments dashboard's booking detail shows a **WhatsApp** line per
  message. A **failed** guest message (typically a number that isn't on WhatsApp) emails staff once
  (`core-team@tvc.farm`, cc Linger; test bookings only `contact@tvc.farm`), since the guest then has
  the email only. Only the last 4 digits of the number are stored. Messages with no booking (the
  staff enquiry alert) are tracked but never trigger a failure email. A failure receipt that beats
  the send's own database insert is retried once after 2 seconds.

## v2 — headers, footers, bold key facts and emoji (2026-10-10)

The five templates above are **live**, and so are their `_v2` successors (approved and verified 2026-10-10). Each has a `_v2` successor with the **same variables in the
same order**, a plain-text **header**, a **footer**, `*bold*` key facts and a few emoji, so
messages scan like a small card instead of a paragraph. Submit these in WhatsApp Manager exactly as
for the originals (Utility, English, **Header: Text**, **Footer** filled in, no buttons), using the
same samples. They are sent automatically instead of the v1 once their `_v2` name is in
`WHATSAPP_APPROVED_TEMPLATES`; until then the v1 keeps sending, so nothing breaks while Meta
reviews. After all five are live, keep the v1 names in the list too (harmless) or remove them.

Switch-over: add each `_v2` name to `WHATSAPP_APPROVED_TEMPLATES` as it is approved, then
redeploy. Header and footer are static text, so the send code needs no extra components.

### `tvc_event_cancelled_v2`
Header: `Event cancelled` · Footer: `Tamarind Valley Collective`
```
Hi {{1}}, we're sorry — *{{2}}* has been cancelled. 😔

{{3}}

💸 *Refund:* {{4}} has been started to your original payment method and should reach you within a few business days.

Questions? Just reply here or email core-team@tvc.farm.
```
Samples: `Asha` · `Foraging Day` · `Heavy rain is forecast and the forest trails will not be safe.` · `₹2,250`

### `tvc_refund_initiated_v2`
Header: `Refund started` · Footer: `Tamarind Valley Collective`
```
Hi {{1}}, we've started a refund for your booking. 💸

💰 *Refund:* {{2}}
🎟️ *Event:* {{3}}

It should reach your original payment method within a few business days.

Questions? Just reply here or email core-team@tvc.farm.
```
Samples: `Asha` · `₹2,250` · `Foraging Day`

### `tvc_refund_processed_v2`
Header: `Refund processed` · Footer: `Tamarind Valley Collective`
```
Hi {{1}}, your refund has been processed and sent to your original payment method. ✅

💰 *Refund:* {{2}}
🎟️ *Event:* {{3}}

Depending on your bank it can take a few more business days to show up.

Questions? Just reply here or email core-team@tvc.farm.
```
Samples: `Asha` · `₹2,250` · `Foraging Day`

### `tvc_cancellation_declined_v2`
Header: `About your cancellation request` · Footer: `Tamarind Valley Collective`
```
Hi {{1}}, thanks for your cancellation request for *{{2}}*. We're not able to cancel this booking under our cancellation and refund policy, so it stays confirmed. ✅

📝 {{3}}

If your plans have changed, just reply here or email core-team@tvc.farm and we'll talk it through.
```
Samples: `Asha` · `Foraging Day` · `The event is less than 48 hours away.`

### `tvc_staff_enquiry_alert_v2`
Header: `New website enquiry` · Footer: `TVC website · internal alert`
```
📩 New *{{1}}* enquiry received on the TVC website.

👤 *From:* {{2}}
💬 *Message:* {{3}}

Please reply to them from the contact inbox or the enquiries sheet.
```
Samples: `membership` · `Asha Rao` · `I would like to know more about joining the collective.`

## Booking confirmation and reminder, with buttons (2026-10-10)

**Status:** both templates were submitted in WhatsApp Manager on 2026-10-10 (Utility, English).
`tvc_booking_confirmed` is **approved**; `tvc_event_reminder` is **pending**. Both names are already
in `WHATSAPP_APPROVED_TEMPLATES`. Add a name only once it is approved (an unapproved name makes
each send fail at Meta) and redeploy. If Meta recategorizes one as Marketing, request a review
(it's a transactional confirmation/reminder for an existing paid booking) rather than accepting it.

Two new templates (not v1/v2 pairs). Unlike the five above they carry **buttons**, so submit them
with the button rows shown. Both buttons are static (a fixed link, or a quick reply), so the send
code needs no button components. Category **Utility**, language **English**, **Header: Text**, footer filled in.

| Name | Variables | Sent when |
|---|---|---|
| `tvc_booking_confirmed` | 1 first name · 2 event · 3 date · 4 guests · 5 amount | a payment is recorded (`razorpay-webhook.mts`), alongside the receipt email |
| `tvc_event_reminder` | 1 first name · 2 event · 3 date | the day before the event, 09:00 IST (`whatsapp-event-reminders.mts`) |

### `tvc_booking_confirmed`
Header: `Booking confirmed` · Footer: `Tamarind Valley Collective`
Button: **Visit website** → URL `https://tvc.farm/visit/how-to-reach`, button text `Get directions`
```
Hi {{1}}, you're all set! ✅

🎟️ *Event:* {{2}}
📅 *Date:* {{3}}
👥 *Guests:* {{4}}
💰 *Paid:* {{5}}

A receipt is on its way to your email. Tap below for directions to the farm, or just reply here with any questions.
```
Samples: `Asha` · `Foraging Day` · `Saturday, 10 October 2026` · `2` · `₹4,500`

### `tvc_event_reminder`
Header: `See you tomorrow!` · Footer: `Tamarind Valley Collective`
Buttons: **Visit website** → `https://tvc.farm/visit/how-to-reach`, text `Get directions`; **Quick reply** `I need help`
```
Hi {{1}}, a quick reminder that *{{2}}* is on *{{3}}*. 🌿

We're looking forward to having you at the farm. The route can be tricky, so please check the directions before you set out. If anything has come up, tap below or reply here and we'll help.
```
Samples: `Asha` · `Foraging Day` · `Saturday, 10 October 2026`

When a guest taps **I need help**, it arrives as a normal inbound message in `/internal/whatsapp`
reading "[Tapped button] I need help".

**Reminder rules.** `whatsapp-event-reminders.mts` runs daily at 03:30 UTC (09:00 IST) and picks
bookings whose `event_date` is tomorrow (IST), not yet reminded, and not refunded or mid-refund — so a
cancelled event's guests are never reminded. Bookings with no `event_date` (made before that column
existed) get no reminder. Each booking is claimed (`event_payments.whatsapp_reminder_sent_at`, migration
`0033`) before sending, so it can't go twice; if the send fails, or the template isn't approved yet,
the claim is released and nothing is lost. Test-mode bookings go to `WHATSAPP_TEST_NUMBER` only.

## Out-of-hours auto-reply (2026-10-10)

Not a template: the guest has just messaged us, so a normal text is allowed. With
`WHATSAPP_AUTOACK_ENABLED=true`, a message that arrives outside `WHATSAPP_AUTOACK_HOURS` (IST) gets one
courtesy reply saying the team is away, when they're back, and a link to `tvc.farm/visit`. It never
tries to answer the question. At most one per conversation per 12 hours (`whatsapp_conversations.last_auto_ack_at`,
claimed atomically), never for reactions or for old messages replayed by a webhook retry, and recorded
in the thread as "[Auto-reply] …". Off by default.
