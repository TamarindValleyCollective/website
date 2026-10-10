// Netlify Function (v2 API) backing src/pages/cancel-booking.astro — a
// guest-initiated CANCELLATION REQUEST, not an automatic refund. TVC's
// refund policy (/refund-policy) has day-before-event tiers a human needs
// to apply, and actually returning money is a deliberate, separate action
// taken by hand in the Razorpay dashboard once someone's checked the
// booking against that policy — this function only records that a guest
// asked and tells TVC + Linger, the same "request, human follows up" shape
// booking itself already uses (BookingInquiry.astro's forms).
//
// GET  ?paymentId=pay_xxx  -> booking summary, for the page to render before
//                             the guest confirms (so they see what they're
//                             cancelling, not just a bare confirm button).
// POST {paymentId}         -> records the request (once) and emails TVC +
//                             Linger + the guest.
//
// Reusable the same way razorpay-webhook.mts is: nothing here is specific
// to Foraging Day or any other one event.
import { getPaymentByRazorpayId, requestCancellationIfNew } from '../../scripts/lib/event-payments-db.mjs';
import { sendStaffAlert, escapeHtml } from './lib/refund-alert';

const RESEND_API_URL = 'https://api.resend.com/emails';
const FROM = 'Tamarind Valley Collective <noreply@tvc.farm>';
const NOTIFY_CC = ['core-team@tvc.farm', 'stay@linger.in'];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function formatAmount(amountPaise: number, currency: string): string {
  const amount = amountPaise / 100;
  return currency === 'INR' ? `₹${amount.toLocaleString('en-IN')}` : `${amount.toLocaleString('en-IN')} ${currency}`;
}

async function sendCancellationEmail(params: {
  payerEmail: string;
  eventTitle: string;
  amount: number;
  currency: string;
  attendeeCount: number;
  paymentId: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('[cancel-booking] RESEND_API_KEY is not set — cannot send notification');
    return;
  }
  const html = `<!doctype html>
<html><head><meta charset="utf-8" /></head>
<body style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:#22291f;">
  <p>We've received a cancellation request for <strong>${params.eventTitle}</strong> (${params.attendeeCount} ${params.attendeeCount === 1 ? 'person' : 'people'}, ${formatAmount(params.amount, params.currency)}, payment ${params.paymentId}).</p>
  <p>TVC will follow up by email or WhatsApp shortly with next steps, per our <a href="https://tvc.farm/refund-policy">cancellation &amp; refund policy</a>.</p>
</body></html>`;
  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: FROM,
      to: [params.payerEmail],
      cc: NOTIFY_CC,
      subject: `Cancellation request received — ${params.eventTitle}`,
      html,
    }),
  });
  if (!res.ok) {
    throw new Error(`Resend send failed: ${res.status} ${await res.text()}`);
  }
}

export default async (req: Request): Promise<Response> => {
  if (req.method === 'GET') {
    const paymentId = new URL(req.url).searchParams.get('paymentId');
    if (!paymentId) return jsonResponse({ error: 'paymentId is required' }, 400);

    let payment;
    try {
      payment = await getPaymentByRazorpayId(paymentId);
    } catch (err) {
      console.error('[cancel-booking] Failed to look up payment', err);
      return jsonResponse({ error: 'Could not look up this booking' }, 502);
    }
    if (!payment) return jsonResponse({ error: 'Booking not found' }, 404);

    return jsonResponse({
      eventTitle: payment.event_title,
      amount: payment.amount,
      currency: payment.currency,
      attendeeCount: payment.attendee_count,
      alreadyRequested: Boolean(payment.cancellation_requested_at),
    });
  }

  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  let body: { paymentId?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }
  const paymentId = (body.paymentId ?? '').trim();
  if (!paymentId) return jsonResponse({ error: 'paymentId is required' }, 400);

  let payment;
  try {
    payment = await getPaymentByRazorpayId(paymentId);
  } catch (err) {
    console.error('[cancel-booking] Failed to look up payment', err);
    return jsonResponse({ error: 'Could not look up this booking' }, 502);
  }
  if (!payment) return jsonResponse({ error: 'Booking not found' }, 404);

  let recordedNow: boolean;
  try {
    recordedNow = await requestCancellationIfNew(payment.id);
  } catch (err) {
    console.error('[cancel-booking] Failed to record cancellation request', err);
    return jsonResponse({ error: 'Could not record your request' }, 502);
  }

  // Separate from the guest's acknowledgment below (which only reaches TVC
  // as a CC, and not at all if the guest has no email on file): an
  // explicit "someone needs to act" alert, since the email promises the
  // guest a follow-up that nothing else triggers.
  if (recordedNow) {
    try {
      await sendStaffAlert(
        `Action needed: cancellation request — ${payment.event_title}`,
        `<!doctype html><html><head><meta charset="utf-8" /></head><body style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:#22291f;">
  <p>A guest has asked to cancel their booking for <strong>${escapeHtml(payment.event_title)}</strong> (${payment.attendee_count} ${payment.attendee_count === 1 ? 'person' : 'people'}, ${formatAmount(payment.amount, payment.currency)}, payment ${escapeHtml(paymentId)}).</p>
  <p>They've been told TVC will follow up. Review it on <a href="https://tvc.farm/internal/event-payments">the Event Payments dashboard</a> — the refund form there suggests an amount under the <a href="https://tvc.farm/refund-policy">refund policy</a>.${payment.payer_email ? '' : ' <strong>This guest has no email on file</strong>, so they got no acknowledgment — contact them directly.'}</p>
</body></html>`,
      );
    } catch (err) {
      console.error('[cancel-booking] Failed to send staff alert', err);
    }
  }

  if (recordedNow && payment.payer_email) {
    try {
      await sendCancellationEmail({
        payerEmail: payment.payer_email,
        eventTitle: payment.event_title,
        amount: payment.amount,
        currency: payment.currency,
        attendeeCount: payment.attendee_count,
        paymentId,
      });
    } catch (err) {
      // The request is already recorded — a failed notification email
      // shouldn't block the guest from seeing "request received"; logged
      // for manual follow-up instead (same reasoning as
      // razorpay-webhook.mts's receipt-email failure handling).
      console.error('[cancel-booking] Failed to send cancellation notification email', err);
    }
  }

  return jsonResponse({ ok: true, alreadyRequested: !recordedNow });
};

export const config = {
  path: '/api/cancel-booking',
};
