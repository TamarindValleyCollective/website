// Netlify Function (v2 API) — Razorpay's webhook endpoint, subscribed to
// payment_link.paid, refund.created, refund.processed, and refund.failed
// (configured in the Razorpay dashboard, Settings > Webhooks; see
// RAZORPAY.md's setup notes).
// Records every event payment and emails a branded receipt, with zero
// per-event code: everything it needs (which event, how many people)
// travels in the Payment Link's own `notes`, set either by hand when a base
// link is created (see RAZORPAY.md's table) or by event-booking.mts when it
// creates a per-booking link on top of one.
//
// Payments made by paying a base link directly (no EventBookingForm/
// event-booking.mts involved — e.g. the very first links created before
// this flow existed) are also recorded correctly: notes.baseReferenceId is
// simply absent, so this falls back to the link's own reference_id, and
// attendeeCount defaults to 1.
//
// Also syncs refunds back to event_payments regardless of where they were
// initiated — event-payments-admin.mts's own refund action already writes
// the row directly, but a refund issued straight from the Razorpay
// dashboard (or any other API caller) would otherwise never reach our
// records. recordRefund()'s refunded_at=is.null guard makes handling both
// paths safe: whichever one reaches Supabase first wins, the other is a
// no-op.
import { verifyWebhookSignature } from './lib/razorpay';
import {
  recordPaymentIfNew,
  markReceiptSent,
  getPaymentByRazorpayId,
  recordRefundInitiated,
  confirmRefundProcessed,
  markRefundFailed,
} from '../../scripts/lib/event-payments-db.mjs';
import { buildReceiptSubject, buildReceiptHtml } from './lib/payment-receipt';

const RESEND_API_URL = 'https://api.resend.com/emails';
const FROM = 'Tamarind Valley Collective <noreply@tvc.farm>';
// Every receipt is CC'd to TVC's shared inbox and Linger (TVC's hospitality/
// logistics partner — already the notify address on the visit-inquiry form,
// see EventDetailView.astro's 3bs1h comment) so a payment is visible to
// whoever needs to act on it without the guest having to forward anything.
// Not per-event configurable yet — every event using this flow so far routes
// through the same two parties; revisit if that stops being true.
const RECEIPT_CC = ['core-team@tvc.farm', 'stay@linger.in'];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

interface RazorpayPaymentEntity {
  id: string;
  amount: number;
  currency: string;
  email?: string;
  contact?: string;
}

interface RazorpayPaymentLinkEntity {
  id: string;
  reference_id: string | null;
  description: string | null;
  notes?: Record<string, string>;
  amount: number;
  currency: string;
}

interface RazorpayRefundEntity {
  id: string;
  amount: number;
  payment_id: string;
  status: string;
}

interface RazorpayWebhookPayload {
  event: string;
  payload: {
    payment_link?: { entity: RazorpayPaymentLinkEntity };
    payment?: { entity: RazorpayPaymentEntity };
    refund?: { entity: RazorpayRefundEntity };
  };
}

async function sendReceiptEmail(params: {
  to: string;
  eventTitle: string;
  amount: number;
  currency: string;
  attendeeCount: number;
  payerName?: string | null;
  paymentId: string;
  paidAt: Date;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('[razorpay-webhook] RESEND_API_KEY is not set — cannot send receipt');
    return;
  }
  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: FROM,
      to: [params.to],
      cc: RECEIPT_CC,
      subject: buildReceiptSubject(params),
      html: buildReceiptHtml(params),
    }),
  });
  if (!res.ok) {
    throw new Error(`Resend send failed: ${res.status} ${await res.text()}`);
  }
}

// Common lookup step for all three refund events below — Razorpay's refund
// entity carries the original payment_id, not our own row id.
async function findRowForRefund(payload: RazorpayWebhookPayload): Promise<{ row: any; refund: RazorpayRefundEntity } | Response> {
  const refund = payload.payload.refund?.entity;
  if (!refund) {
    console.error(`[razorpay-webhook] ${payload.event} payload missing refund entity`);
    return jsonResponse({ error: 'Malformed payload' }, 400);
  }

  let row;
  try {
    row = await getPaymentByRazorpayId(refund.payment_id);
  } catch (err) {
    console.error('[razorpay-webhook] Failed to look up payment for refund sync', err);
    return jsonResponse({ error: 'Failed to reach the payment store' }, 500);
  }
  if (!row) {
    // A refund against a payment this table never recorded (e.g. one of the
    // hand-linked Payment Links documented separately in RAZORPAY.md, paid
    // and refunded entirely outside this module) — nothing to sync.
    return jsonResponse({ ok: true, skipped: 'no matching event_payments row' });
  }
  return { row, refund };
}

// refund.created — the refund now exists at Razorpay, but Razorpay is the
// source of truth for whether it actually completes, not the mere fact of
// its creation, so this only ever marks the row "refund initiated"
// (recordRefundInitiated), never "refunded". Mainly matters for a refund
// started directly in the Razorpay dashboard: event-payments-admin.mts's
// own refund action already calls recordRefundInitiated synchronously
// right after its Razorpay API call succeeds, so this arriving afterward
// for that same refund is just a no-op confirmation (its own is.null guard
// handles that).
async function handleRefundCreated(payload: RazorpayWebhookPayload): Promise<Response> {
  const found = await findRowForRefund(payload);
  if (found instanceof Response) return found;
  const { row, refund } = found;

  try {
    const recordedNow = await recordRefundInitiated(row.id, {
      razorpayRefundId: refund.id,
      amount: refund.amount,
      status: refund.status,
      // 'razorpay (dashboard)' rather than an admin's email — this path is
      // what actually fires for a refund started directly in the Razorpay
      // dashboard; there's no signed-in admin here to attribute it to.
      refundedBy: 'razorpay (dashboard)',
    });
    return jsonResponse({ ok: true, recorded: recordedNow });
  } catch (err) {
    console.error('[razorpay-webhook] Failed to record refund initiation', err);
    return jsonResponse({ error: 'Failed to record refund' }, 500);
  }
}

// refund.processed — Razorpay's own confirmation that the refund actually
// completed. This is the only place refunded_at gets set.
async function handleRefundProcessed(payload: RazorpayWebhookPayload): Promise<Response> {
  const found = await findRowForRefund(payload);
  if (found instanceof Response) return found;
  const { row, refund } = found;

  try {
    const confirmedNow = await confirmRefundProcessed(row.id, refund.id, refund.status);
    return jsonResponse({ ok: true, confirmed: confirmedNow });
  } catch (err) {
    console.error('[razorpay-webhook] Failed to confirm processed refund', err);
    return jsonResponse({ error: 'Failed to record refund' }, 500);
  }
}

// refund.failed — the initiated refund didn't go through. refunded_at was
// never optimistically set (see handleRefundCreated above), so there's
// nothing to revert; this just flips refund_status so the row stops
// reading as "in progress" and an admin can retry.
async function handleRefundFailed(payload: RazorpayWebhookPayload): Promise<Response> {
  const found = await findRowForRefund(payload);
  if (found instanceof Response) return found;
  const { row, refund } = found;

  try {
    const recordedNow = await markRefundFailed(row.id, refund.id);
    return jsonResponse({ ok: true, recorded: recordedNow });
  } catch (err) {
    console.error('[razorpay-webhook] Failed to record refund failure', err);
    return jsonResponse({ error: 'Failed to record refund failure' }, 500);
  }
}

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('[razorpay-webhook] RAZORPAY_WEBHOOK_SECRET is not set');
    return jsonResponse({ error: 'Server misconfigured' }, 500);
  }

  // Raw body, read once, before JSON parsing — the signature is an HMAC
  // over these exact bytes (see whatsapp-webhook.mts's identical reasoning).
  const rawBody = await req.text();
  if (!verifyWebhookSignature(rawBody, req.headers.get('x-razorpay-signature'), webhookSecret)) {
    console.error('[razorpay-webhook] Signature verification failed');
    return jsonResponse({ error: 'Invalid signature' }, 401);
  }

  let payload: RazorpayWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }

  if (payload.event === 'refund.created') return handleRefundCreated(payload);
  if (payload.event === 'refund.processed') return handleRefundProcessed(payload);
  if (payload.event === 'refund.failed') return handleRefundFailed(payload);

  // Ack anything else (including refund.speed_changed, not acted on — it
  // doesn't change whether the refund completed) with 200 rather than
  // erroring — Razorpay retries non-2xx responses, and a future webhook
  // subscribed to more events shouldn't start failing here just because
  // this function hasn't caught up yet.
  if (payload.event !== 'payment_link.paid') {
    return jsonResponse({ ok: true, skipped: payload.event });
  }

  const paymentLink = payload.payload.payment_link?.entity;
  const payment = payload.payload.payment?.entity;
  if (!paymentLink || !payment) {
    console.error('[razorpay-webhook] payment_link.paid payload missing payment_link or payment entity');
    return jsonResponse({ error: 'Malformed payload' }, 400);
  }

  const notes = paymentLink.notes ?? {};
  const eventReferenceId = notes.baseReferenceId || paymentLink.reference_id || paymentLink.id;
  const eventTitle = notes.event || paymentLink.description || eventReferenceId;
  const attendeeCount = Number.parseInt(notes.attendeeCount ?? '1', 10) || 1;
  const payerName = notes.primaryContactName || null;
  // Prefer what the visitor actually typed into EventBookingForm (carried
  // through in notes, same as primaryContactName) over Razorpay's own
  // payment.entity.email/.contact — confirmed against real test-mode rows
  // that Razorpay's test/Quick Pay checkout substitutes its own
  // void@razorpay.com placeholder for email regardless of what was prefilled
  // via the Payment Link's customer.email, even though .contact (phone) came
  // through correctly. Falls back to the payment entity for Payment Links
  // paid directly without going through event-booking.mts (no notes at
  // all — e.g. the hand-linked links documented in RAZORPAY.md) and for
  // bookings made before this fallback existed.
  const payerEmail = notes.primaryContactEmail || payment.email || null;
  const payerContact = notes.primaryContactPhone || payment.contact || null;
  // Which mode actually processed this payment, so event-payments-admin.mts
  // can filter test payments out of the dashboard deterministically instead
  // of guessing from payer_email. Whichever key is active right now is the
  // one that authenticated this exact request — test-mode payments can only
  // ever be made against rzp_test_ keys in the first place. Defaults to
  // 'live' if the key is somehow unset, since hiding a real registration
  // would be worse than showing an uncertain one.
  const mode = process.env.RAZORPAY_KEY_ID?.startsWith('rzp_test_') ? 'test' : 'live';

  let recorded;
  try {
    recorded = await recordPaymentIfNew({
      eventReferenceId,
      eventTitle,
      razorpayPaymentId: payment.id,
      razorpayPaymentLinkId: paymentLink.id,
      amount: payment.amount,
      currency: payment.currency,
      attendeeCount,
      payerName,
      payerEmail,
      payerContact,
      mode,
    });
  } catch (err) {
    console.error('[razorpay-webhook] Failed to record payment', err);
    // Non-2xx so Razorpay retries — recordPaymentIfNew's on_conflict/
    // ignore-duplicates makes a retry safe even if this failure happened
    // after a partial write.
    return jsonResponse({ error: 'Failed to record payment' }, 500);
  }

  if (!recorded) {
    // Already recorded by an earlier delivery of this same webhook — the
    // receipt email already went out then too, so nothing left to do.
    return jsonResponse({ ok: true, duplicate: true });
  }

  if (payerEmail) {
    try {
      await sendReceiptEmail({
        to: payerEmail,
        eventTitle,
        amount: payment.amount,
        currency: payment.currency,
        attendeeCount,
        payerName,
        paymentId: payment.id,
        paidAt: new Date(),
      });
      await markReceiptSent(recorded.id);
    } catch (err) {
      // The payment is already recorded — a failed receipt email shouldn't
      // turn into a retried webhook (which recordPaymentIfNew would then
      // just no-op on anyway, never retrying the email). Logged for manual
      // follow-up instead.
      console.error('[razorpay-webhook] Failed to send receipt email', err);
    }
  } else {
    console.error(`[razorpay-webhook] Payment ${payment.id} has no email on file — receipt not sent`);
  }

  return jsonResponse({ ok: true });
};

export const config = {
  path: '/api/razorpay-webhook',
};
