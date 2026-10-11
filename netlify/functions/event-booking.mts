// Netlify Function (v2 API) backing EventBookingForm.astro — the reusable
// "request a spot" flow any event can opt into (see content.config.ts's
// `razorpayReferenceId` field and EventDetailView.astro).
//
// Booking is approval-gated (2026-10-11): a guest who books online without
// understanding where the farm is, or what to expect, ended up refunded. So
// this function no longer creates a Razorpay Payment Link. It:
//   1. checks the event's base Payment Link is still open (and reads the
//      price, so a closed event can't collect requests),
//   2. saves the request as `pending` in event_booking_requests,
//   3. pages Linger staff (WhatsApp + email) with a tokenised approve link,
//      and emails the guest that someone will confirm with them first.
// Linger speak to the guest, then approve — event-booking-approval.mts is
// what mints the Payment Link and sends it to the guest.
import { getEventPrice, RegistrationClosedError } from './lib/booking-link';
import { notifyApprovers, sendRequestAcknowledgement } from './lib/booking-notify';
import { countActivePaymentsForEmail } from '../../scripts/lib/event-payments-db.mjs';
import { createBookingRequest, hasPendingRequest } from '../../scripts/lib/booking-requests-db.mjs';

interface BookingPayload {
  referenceId?: string;
  eventDate?: string;
  name?: string;
  email?: string;
  phone?: string;
  attendeeCount?: number;
  // The WhatsApp-updates checkbox. Only an explicit true counts as consent.
  whatsappOptIn?: boolean;
  confirmDuplicate?: boolean;
  botField?: string;
}

const MAX_ATTENDEES = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  let payload: BookingPayload;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }

  // Honeypot, matching enquiry.mts's convention — a real submitter never
  // sees or fills this field. Silent success rather than an error, so a bot
  // can't tell its submission was dropped.
  if (payload.botField) return jsonResponse({ requested: true });

  const referenceId = (payload.referenceId ?? '').trim();
  const eventDate = (payload.eventDate ?? '').trim();
  const name = (payload.name ?? '').trim();
  const email = (payload.email ?? '').trim();
  const phone = (payload.phone ?? '').trim();
  const attendeeCount = Math.trunc(Number(payload.attendeeCount));
  const whatsappOptIn = payload.whatsappOptIn === true;

  if (!referenceId || !name || !email || !phone) {
    return jsonResponse({ error: 'name, email, and phone are required' }, 400);
  }
  if (!EMAIL_RE.test(email)) {
    return jsonResponse({ error: 'That email address doesn’t look right' }, 400);
  }
  if (!Number.isFinite(attendeeCount) || attendeeCount < 1 || attendeeCount > MAX_ATTENDEES) {
    return jsonResponse({ error: `Number of people must be between 1 and ${MAX_ATTENDEES}` }, 400);
  }

  let eventTitle: string;
  try {
    ({ eventTitle } = await getEventPrice(referenceId));
  } catch (err) {
    if (err instanceof RegistrationClosedError) {
      return jsonResponse({ error: 'Online registration for this event is no longer open' }, 409);
    }
    console.error('[event-booking] Failed to fetch base payment link', err);
    return jsonResponse({ error: 'Could not look up this event — try again shortly' }, 502);
  }

  // Surface an already-paid booking under this exact (event, email) before
  // a second request goes to Linger. Not a hard block — a second group under
  // the same email is legitimate — so the browser gets one chance to confirm.
  if (!payload.confirmDuplicate) {
    let existingCount = 0;
    try {
      existingCount = await countActivePaymentsForEmail(referenceId, email);
    } catch (err) {
      // Non-fatal: proceed as if there's no prior booking.
      console.error('[event-booking] Failed to check for an existing booking', err);
    }
    if (existingCount > 0) {
      return jsonResponse({ duplicateWarning: true, existingCount });
    }
  }

  // A double-click or a resubmit while Linger haven't yet acted: one request,
  // one page to Linger.
  try {
    if (await hasPendingRequest(referenceId, email)) return jsonResponse({ requested: true });
  } catch (err) {
    console.error('[event-booking] Failed to check for a pending request', err);
  }

  let saved;
  try {
    saved = await createBookingRequest({
      eventReferenceId: referenceId,
      eventTitle,
      eventDate: DATE_RE.test(eventDate) ? eventDate : null,
      name,
      email,
      phone,
      attendeeCount,
      whatsappOptIn,
    });
  } catch (err) {
    console.error('[event-booking] Failed to save booking request', err);
    return jsonResponse({ error: 'Could not send your request — try again shortly' }, 502);
  }

  const summary = {
    event_title: eventTitle,
    event_date: DATE_RE.test(eventDate) ? eventDate : null,
    name,
    email,
    phone,
    attendee_count: attendeeCount,
    whatsapp_opt_in: whatsappOptIn,
  };
  // Best-effort: the request is saved, so a notification hiccup must not tell
  // the guest their request failed. Both helpers swallow their own errors.
  await Promise.all([notifyApprovers(summary, saved.token, saved.request.id), sendRequestAcknowledgement(summary)]);

  return jsonResponse({ requested: true });
};

export const config = {
  path: '/api/event-booking',
};
