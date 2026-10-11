// Netlify Function (v2 API) behind /approve-booking — where Linger staff
// approve or decline a booking request after speaking to the guest (see
// event-booking.mts, which creates the request and sends this page's link on
// WhatsApp and email).
//
// Auth is the link itself: a 256-bit random token, stored only as a hash, in
// a link sent to the approvers. GET only *reads* (WhatsApp and mail clients
// prefetch links, so a GET must never approve anything); the decision is a
// POST from a button on the page. Approving is what creates the Razorpay
// Payment Link and sends it to the guest.
import { getOrCreateBookingLink, RegistrationClosedError, PAYMENT_LINK_VALID_HOURS } from './lib/booking-link';
import { sendPaymentLinkToGuest, sendDeclineToGuest } from './lib/booking-notify';
import { getRequestByToken, claimDecision, releaseDecision, recordPaymentLink } from '../../scripts/lib/booking-requests-db.mjs';

const TOKEN_RE = /^[0-9a-f]{64}$/;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

// Only what the approver needs to see; never the token hash or other rows.
function publicView(row: any) {
  return {
    status: row.status,
    eventTitle: row.event_title,
    eventDate: row.event_date,
    name: row.name,
    email: row.email,
    phone: row.phone,
    attendeeCount: row.attendee_count,
    paymentLinkUrl: row.status === 'approved' ? row.payment_link_url : null,
    paymentLinkSent: Boolean(row.payment_link_sent_at),
  };
}

export default async (req: Request): Promise<Response> => {
  if (req.method === 'GET') {
    const token = new URL(req.url).searchParams.get('token') ?? '';
    if (!TOKEN_RE.test(token)) return jsonResponse({ error: 'Not found' }, 404);
    try {
      const row = await getRequestByToken(token);
      if (!row) return jsonResponse({ error: 'Not found' }, 404);
      return jsonResponse(publicView(row));
    } catch (err) {
      console.error('[booking-approval] Failed to look up request', err);
      return jsonResponse({ error: 'Could not look up this request' }, 502);
    }
  }

  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  let body: { token?: string; action?: string; note?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }
  const token = body.token ?? '';
  if (!TOKEN_RE.test(token)) return jsonResponse({ error: 'Not found' }, 404);
  if (body.action !== 'approve' && body.action !== 'decline') return jsonResponse({ error: 'action must be approve or decline' }, 400);

  let row;
  try {
    row = await getRequestByToken(token);
  } catch (err) {
    console.error('[booking-approval] Failed to look up request', err);
    return jsonResponse({ error: 'Could not look up this request' }, 502);
  }
  if (!row) return jsonResponse({ error: 'Not found' }, 404);
  // Already decided (by someone else, or a double-tap): show the outcome, change nothing.
  if (row.status !== 'pending') return jsonResponse({ ...publicView(row), alreadyDecided: true });

  const note = typeof body.note === 'string' ? body.note.slice(0, 500) : null;

  if (body.action === 'decline') {
    let claimed;
    try {
      claimed = await claimDecision(row.id, 'declined', note);
    } catch (err) {
      console.error('[booking-approval] Failed to record decline', err);
      return jsonResponse({ error: 'Could not record that — try again' }, 502);
    }
    if (!claimed) return jsonResponse({ ...publicView(await getRequestByToken(token)), alreadyDecided: true });
    await sendDeclineToGuest(claimed);
    return jsonResponse(publicView(claimed));
  }

  // Approve. Claim first so two people tapping at once can't mint two links.
  let claimed;
  try {
    claimed = await claimDecision(row.id, 'approved', note);
  } catch (err) {
    console.error('[booking-approval] Failed to record approval', err);
    return jsonResponse({ error: 'Could not record that — try again' }, 502);
  }
  if (!claimed) return jsonResponse({ ...publicView(await getRequestByToken(token)), alreadyDecided: true });

  let link;
  try {
    link = await getOrCreateBookingLink({
      referenceId: claimed.event_reference_id,
      eventDate: claimed.event_date,
      name: claimed.name,
      email: claimed.email,
      phone: claimed.phone,
      attendeeCount: claimed.attendee_count,
      whatsappOptIn: claimed.whatsapp_opt_in,
    });
  } catch (err) {
    // Nothing was sent to the guest: put the request back so Approve can be retried.
    await releaseDecision(claimed.id).catch((e: unknown) => console.error('[booking-approval] Failed to release claim', e));
    if (err instanceof RegistrationClosedError) {
      return jsonResponse({ error: 'Online registration for this event has closed, so a payment link can’t be created.' }, 409);
    }
    console.error('[booking-approval] Failed to create payment link', err);
    return jsonResponse({ error: 'Could not create the payment link — try again shortly' }, 502);
  }

  const sent = await sendPaymentLinkToGuest(claimed, { url: link.short_url, amount: link.amount, currency: link.currency });
  try {
    await recordPaymentLink(claimed.id, { linkId: link.id, linkUrl: link.short_url, sent });
  } catch (err) {
    console.error('[booking-approval] Failed to record payment link', err);
  }

  return jsonResponse({
    ...publicView({ ...claimed, payment_link_url: link.short_url, payment_link_sent_at: sent ? new Date().toISOString() : null }),
    validHours: PAYMENT_LINK_VALID_HOURS,
  });
};

export const config = {
  path: '/api/booking-approval',
};
