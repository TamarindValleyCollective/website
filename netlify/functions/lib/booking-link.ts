// Creates the per-booking Razorpay Payment Link for an APPROVED booking
// request (see event-booking-approval.mts). Before the approval step existed
// this lived inline in event-booking.mts; the logic is unchanged, only moved.
//
// An event using this flow has ONE hand-created base Payment Link whose
// amount is the trusted per-person price and whose reference_id is what the
// event's frontmatter points at. That link is never paid directly: this reads
// its price, multiplies by the headcount, and mints a fresh one-off link for
// the total, carrying enough in `notes` (baseReferenceId, event,
// attendeeCount, ...) for razorpay-webhook.mts to record the payment with no
// per-event code.
import { createHash } from 'node:crypto';
import { normalizeMobileNumber } from '../../../scripts/lib/phone.mjs';
import { fetchBasePaymentLink, fetchPaymentLinksByReferenceId, createPaymentLink, type RazorpayPaymentLink } from './razorpay';

const MAX_BOOKINGS_PER_EMAIL = 20;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// How long the guest has to pay after approval. Long enough to cover a
// weekend, short enough that a spot isn't held indefinitely.
export const PAYMENT_LINK_VALID_HOURS = 48;

export class RegistrationClosedError extends Error {}

export interface BookingLinkParams {
  referenceId: string;
  eventDate?: string | null;
  name: string;
  email: string;
  phone: string;
  attendeeCount: number;
  whatsappOptIn: boolean;
}

export async function getEventPrice(referenceId: string): Promise<{ eventTitle: string; unitAmount: number; currency: string }> {
  const base = await fetchBasePaymentLink(referenceId);
  if (base.status !== 'created') throw new RegistrationClosedError();
  return { eventTitle: base.notes?.event ?? base.description ?? referenceId, unitAmount: base.amount, currency: base.currency };
}

export async function getOrCreateBookingLink(params: BookingLinkParams): Promise<RazorpayPaymentLink> {
  const { referenceId, eventDate, name, email, phone, attendeeCount } = params;
  const whatsappOptIn = params.whatsappOptIn ? 'yes' : 'no';

  const base = await fetchBasePaymentLink(referenceId);
  if (base.status !== 'created') throw new RegistrationClosedError();

  const eventTitle = base.notes?.event ?? base.description ?? referenceId;
  const totalAmount = base.amount * attendeeCount;

  // Never outlive the event's own registration window; Razorpay needs at
  // least 15 minutes of validity, so a window that has all but closed counts
  // as closed.
  const nowSec = Math.floor(Date.now() / 1000);
  let expireBy = nowSec + PAYMENT_LINK_VALID_HOURS * 3600;
  if (base.expire_by && base.expire_by < expireBy) expireBy = base.expire_by;
  if (expireBy - nowSec < 20 * 60) throw new RegistrationClosedError();

  // Deterministic per (event, email) — not a random suffix — so approving the
  // same booking twice hands back the *same* still-open Payment Link instead
  // of a fresh charge target. Payment Link reference_id caps at 40 chars.
  const emailHash = createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 8);
  // Razorpay refuses a second Payment Link with a reference_id that already
  // exists — even if the first was paid or expired — so booking n gets a
  // numeric suffix; the first keeps the original id. 26 + "-" + 8 + "-" + up
  // to 2 digits fits the 40-char cap.
  const bookingReferenceIdFor = (n: number) =>
    n === 1 ? `${referenceId.slice(0, 30)}-${emailHash}` : `${referenceId.slice(0, 26)}-${emailHash}-${n}`;

  let bookingReferenceId = bookingReferenceIdFor(1);
  for (let n = 1; n <= MAX_BOOKINGS_PER_EMAIL; n++) {
    const candidateId = bookingReferenceIdFor(n);
    const candidates = await fetchPaymentLinksByReferenceId(candidateId);
    const reusable = candidates.find(
      (l) => l.status === 'created' && l.notes?.attendeeCount === String(attendeeCount) && l.notes?.whatsappOptIn === whatsappOptIn,
    );
    if (reusable) return reusable;
    if (candidates.length === 0) {
      bookingReferenceId = candidateId;
      break;
    }
    // Taken by a paid/expired/different-size link — try the next number.
  }

  return createPaymentLink({
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
      // Recorded as event_payments.whatsapp_opt_in by razorpay-webhook.mts.
      whatsappOptIn,
      ...(eventDate && DATE_RE.test(eventDate) ? { eventDate } : {}),
    },
    customerName: name,
    customerEmail: email,
    // Razorpay rejects a contact with spaces or outside 8-14 characters, and
    // the form's own placeholder is "+91 98765 43210". Send E.164 when the
    // number parses, otherwise omit it rather than fail the whole approval
    // (the typed number is still in notes.primaryContactPhone).
    customerContact: normalizeMobileNumber(phone) ?? undefined,
    expireBy,
  });
}
