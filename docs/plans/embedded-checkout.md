# Plan: take event payments inside tvc.farm (Razorpay embedded Checkout)

**Status:** proposed, not started (written 2026-10-10). Backlog: see the umbrella issue linked
from the GitHub issue list (label `feature-request`, title starts "Embedded checkout").

## Goal

A guest books an event without leaving tvc.farm. Today `EventBookingForm.astro` posts to
`event-booking.mts`, which creates a one-off Razorpay **Payment Link** and the browser is
redirected to `razorpay.com`. After this work the same form opens Razorpay's **Checkout popup**
on top of the event page, and the guest lands on an in-page confirmation.

Non-goals: building our own card form (that would put card data on our page and in PCI scope —
Checkout keeps it inside Razorpay's iframe); changing refunds, receipts, fee reconciliation or the
admin dashboard; localizing the form (still English-only, as today).

## How it works today

1. Each opted-in event has one hand-made **base Payment Link** (reference_id =
   `razorpayReferenceId` in the event's frontmatter). It is never paid; it is the trusted
   per-person price, and its `status` is the "registration open" flag.
2. `event-booking.mts` reads the base link, multiplies by headcount, creates a per-booking
   Payment Link (notes: baseReferenceId, event, attendeeCount, primaryContactName/Email/Phone,
   eventDate) and returns `short_url`. A duplicate-email warning and a reuse-the-open-link guard
   sit in front of that.
3. `razorpay-webhook.mts` handles `payment_link.paid`, records the row in `event_payments`
   (idempotent on `razorpay_payment_id`), sends the receipt, and alerts staff if the base link
   was already closed. Refund webhooks and everything after are keyed on the payment id.

## Target design

| Concern | Decision |
|---|---|
| Price + open/closed | **Unchanged.** Keep the base Payment Link as the source of truth. Event cancellation still closes it (`cancelPaymentLink`), so "registration closed" keeps working for free. |
| Per-booking charge | Replace the per-booking Payment Link with a Razorpay **Order** created server-side: `amount` = base amount × headcount, `receipt` = our booking id, `notes` = the same fields the link carried plus `source: "embedded-checkout"`. Only the server sets the amount. |
| Checkout | `EventBookingForm.astro` loads `https://checkout.razorpay.com/v1/checkout.js` on first submit, opens it with `order_id`, `key` (public key id), and `prefill` from the form. |
| Confirming | The popup's success handler posts `{order_id, payment_id, signature}` to a new `verify-payment` function that checks the HMAC (`order_id|payment_id`, key secret) and returns "paid". That is for the on-page confirmation only. **The webhook stays the system of record**, exactly as now. |
| Recording | `razorpay-webhook.mts` also handles `order.paid`, reading `order.notes`. Orders without `source: "embedded-checkout"` are ignored, because every Payment Link payment also creates an internal order and would otherwise be recorded twice with different notes. `recordPaymentIfNew` is already idempotent on the payment id. |
| Idempotency | Drop the "reuse an open link" guard; an unpaid Order is harmless and the popup is modal, so double-submits are far less likely. Keep the duplicate-email warning. |
| Database | `event_payments.razorpay_payment_link_id` is `NOT NULL`. Add `razorpay_order_id` (nullable, indexed) and make the link id nullable in one migration. **Migrations are not auto-applied to TVC ERP — apply it explicitly and verify before merging code that depends on it.** |
| Rollout | Feature flag per event in frontmatter (`checkout: "embedded"`), default `"link"`. Prove it on `fake-test-event`, then one real event, then flip the default. The Payment Link path stays until the last step. |

## Things easy to miss

- **`Permissions-Policy: payment=()`** in `netlify.toml` blocks the Payment Request API (Google
  Pay etc.) inside Checkout. It needs `payment=(self "https://checkout.razorpay.com" "https://api.razorpay.com")`
  (exact origins to verify live).
- **CSP is generated** by `scripts/generate-csp.mjs`, not hand-written. Add Razorpay's origins to
  `script-src` (checkout.razorpay.com), `frame-src` (api.razorpay.com, checkout.razorpay.com),
  `connect-src` (api.razorpay.com, lumberjack.razorpay.com), and `img-src`/`style-src` if the
  popup needs them. Razorpay's published list is the starting point; verify against the real
  popup in test mode with the console open, as was done for GA4.
- **Mobile.** On phones Checkout may leave the page for UPI apps or 3-D Secure and come back. Use
  `redirect: false` + the handler where it works, and a `callback_url` fallback to a confirmation
  page that looks the booking up by order id. Needs a spike on real devices.
- **Webhook subscription.** Test and Live each have their own webhook config in the Razorpay
  dashboard; `order.paid` has to be ticked in both. The test-mode webhook also reaches
  production (see `paymentMatchesKeyMode`), which the new handler inherits.
- **Order expiry.** Payment Links inherited `expire_by` from the base link; Orders don't expire.
  Check the base link's status at order-creation time (as now) and again in the webhook's late-payment
  alert.
- **Docs that must change with the code:** `ARCHITECTURE.md` (diagram and webhook list),
  `RAZORPAY.md` (how an event opts in, the Orders API usage, the new webhook event),
  `CHANGELOG/`, and the privacy/terms pages if they describe the payment hand-off.

## Work breakdown (each is a GitHub issue under the umbrella)

1. **Spike: Checkout on mobile and in test mode** — settle handler vs `callback_url`, confirm the
   CSP/Permissions-Policy origins, confirm `order.paid` payload shape. Output: a short note
   appended to this file.
2. **Migration: `razorpay_order_id` on `event_payments`** — nullable link id, new indexed column;
   applied and verified on TVC ERP.
3. **Orders helpers in `lib/razorpay.ts`** — `createOrder`, `fetchOrder`, signature verification
   helper, unit tests with a mocked Razorpay.
4. **`event-booking.mts`: create an Order behind the flag** — returns `{orderId, amount, keyId, ...}`
   instead of `{url}` when the event is `embedded`; keeps the duplicate-email warning.
5. **Webhook: handle `order.paid`** — records from order notes, ignores non-embedded orders,
   idempotent, same receipt/alert behaviour; tests for the double-delivery and Payment-Link-order cases.
6. **`verify-payment` function** — signature check, no side effects beyond a boolean.
7. **`EventBookingForm.astro`: open Checkout** — lazy-load the script, prefill, success/dismiss/failure
   states, in-page confirmation, accessible focus handling.
8. **Security headers: CSP + Permissions-Policy** — `generate-csp.mjs` and `netlify.toml`, verified in
   a browser against the real popup.
9. **Pilot on `fake-test-event`, then one real event** — test-mode run-through (book, receipt,
   cancel, decline, refund), then a live ₹ payment on a real event with a refund.
10. **Docs and changelog** — `ARCHITECTURE.md`, `RAZORPAY.md`, privacy/terms check, changelog entry.
11. **Make embedded the default and retire per-booking links** — only after the pilot; remove the
    link-creation path and its reuse guard once nothing uses it.

Order: 1 → (2, 3 in parallel) → 4, 5, 6 → 7 → 8 → 9 → 10 → 11. Item 8 can start as soon as the
spike names the origins; it must land before 9.

## Risks

- A missed webhook subscription means payments succeed but nothing is recorded: the receipt and the
  dashboard row both depend on `order.paid`. The pilot must check this in both modes, and the
  `verify-payment` result must never be treated as the record.
- Double recording if the `source` marker check is wrong. Covered by an explicit test.
- A CSP that is too tight silently blocks the popup on some browsers; test Safari and an Android
  browser, not just desktop Chrome.
- Reverting: the flag defaults to the Payment Link path, so rollback is one frontmatter value per
  event, not a deploy.
