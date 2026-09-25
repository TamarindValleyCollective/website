// Netlify Function (v2 API) backing EventBookingForm.astro — the reusable
// "pay online, for N people" flow any event can opt into (see
// content.config.ts's `razorpayReferenceId` field and EventDetailView.astro).
//
// An event using this flow has ONE hand-created Payment Link (e.g. via the
// Razorpay MCP, same as every link in RAZORPAY.md's table) whose amount is
// the trusted per-person price, and whose reference_id is what the event's
// frontmatter points at. That link is never paid directly. This function:
//   1. looks that base link up by reference_id to read the per-person price,
//   2. multiplies by the attendee count the visitor submitted,
//   3. creates a fresh, one-off Payment Link for that total, carrying enough
//      in `notes` (baseReferenceId, event, attendeeCount) for
//      razorpay-webhook.mts to record the payment against the right event
//      with no per-event code of its own, and
//   4. returns its short_url for the browser to redirect to.
//
// No new event needs a code change here — just its own base Payment Link
// and a `razorpayReferenceId` in its content file pointing at it.
import { createHash } from 'node:crypto';
import { fetchBasePaymentLink, fetchPaymentLinksByReferenceId, createPaymentLink } from './lib/razorpay';
import { countActivePaymentsForEmail } from '../../scripts/lib/event-payments-db.mjs';

interface BookingPayload {
  referenceId?: string;
  eventDate?: string;
  name?: string;
  email?: string;
  phone?: string;
  attendeeCount?: number;
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
  if (payload.botField) return jsonResponse({ url: null });

  const referenceId = (payload.referenceId ?? '').trim();
  const eventDate = (payload.eventDate ?? '').trim();
  const name = (payload.name ?? '').trim();
  const email = (payload.email ?? '').trim();
  const phone = (payload.phone ?? '').trim();
  const attendeeCount = Math.trunc(Number(payload.attendeeCount));

  if (!referenceId || !name || !email || !phone) {
    return jsonResponse({ error: 'name, email, and phone are required' }, 400);
  }
  if (!EMAIL_RE.test(email)) {
    return jsonResponse({ error: 'That email address doesn’t look right' }, 400);
  }
  if (!Number.isFinite(attendeeCount) || attendeeCount < 1 || attendeeCount > MAX_ATTENDEES) {
    return jsonResponse({ error: `Number of people must be between 1 and ${MAX_ATTENDEES}` }, 400);
  }

  let base;
  try {
    base = await fetchBasePaymentLink(referenceId);
  } catch (err) {
    console.error('[event-booking] Failed to fetch base payment link', err);
    return jsonResponse({ error: 'Could not look up this event’s price — try again shortly' }, 502);
  }

  if (base.status !== 'created') {
    // Registration for this event has closed (link paid/cancelled/expired
    // some other way) or was never actually opened for direct payment.
    return jsonResponse({ error: 'Online registration for this event is no longer open' }, 409);
  }

  const eventTitle = base.notes?.event ?? base.description ?? referenceId;
  const totalAmount = base.amount * attendeeCount;

  // Surface an already-paid booking under this exact (event, email) before
  // money moves a second time, rather than only discoverable afterward on
  // the admin dashboard. Not a hard block — a guest can legitimately book
  // again (e.g. a second group under the same email) — so the browser gets
  // one chance to say "yes, this is intentional" (confirmDuplicate) before
  // a link is actually created.
  if (!payload.confirmDuplicate) {
    let existingCount = 0;
    try {
      existingCount = await countActivePaymentsForEmail(referenceId, email);
    } catch (err) {
      // Non-fatal: proceed as if there's no prior booking rather than block
      // a real registration over a lookup hiccup.
      console.error('[event-booking] Failed to check for an existing booking', err);
    }
    if (existingCount > 0) {
      return jsonResponse({ duplicateWarning: true, existingCount });
    }
  }

  // Deterministic per (event, email) — not a random suffix — so a guest who
  // double-clicks Pay, or hits back and resubmits before finishing checkout,
  // is handed the *same* still-open Payment Link instead of a fresh one
  // (checked just below), rather than minting a new charge target every
  // submit. Payment Link reference_id caps at 40 chars.
  const emailHash = createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 8);
  const bookingReferenceId = `${referenceId.slice(0, 30)}-${emailHash}`;

  let link;
  try {
    const candidates = await fetchPaymentLinksByReferenceId(bookingReferenceId);
    // Reuse only a still-unpaid link for the exact same booking (attendee
    // count, hence amount) — anything else (already paid, expired, or the
    // guest changed the count since their last attempt) falls through to
    // minting a fresh link rather than risk handing back a link for the
    // wrong amount or one nobody can pay anymore.
    link = candidates.find((l) => l.status === 'created' && l.notes?.attendeeCount === String(attendeeCount));
  } catch (err) {
    console.error('[event-booking] Failed to check for a pending payment link', err);
  }

  if (!link) {
    try {
      link = await createPaymentLink({
        amount: totalAmount,
        currency: base.currency,
        description: `${eventTitle} — ${attendeeCount} ${attendeeCount === 1 ? 'person' : 'people'}`,
        referenceId: bookingReferenceId,
        notes: {
          baseReferenceId: referenceId,
          event: eventTitle,
          attendeeCount: String(attendeeCount),
          primaryContactName: name,
          primaryContactEmail: email,
          primaryContactPhone: phone,
          // Best-effort: a malformed/missing value (an older cached page, a
          // tampered request) just leaves the eventual event_payments row's
          // event_date null, same as any booking made before this field
          // existed — never worth failing the booking over.
          ...(DATE_RE.test(eventDate) ? { eventDate } : {}),
        },
        customerName: name,
        customerEmail: email,
        customerContact: phone,
        expireBy: base.expire_by,
      });
    } catch (err) {
      console.error('[event-booking] Failed to create per-booking payment link', err);
      return jsonResponse({ error: 'Could not start your booking — try again shortly' }, 502);
    }
  }

  return jsonResponse({ url: link.short_url });
};

export const config = {
  path: '/api/event-booking',
};
