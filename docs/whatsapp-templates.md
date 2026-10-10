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
  the email only. Only the last 4 digits of the number are stored.
