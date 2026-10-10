// "Who is this person?" for a phone number: their paid event bookings (Event
// Payments) and their stays (Accommodation), gathered in one place. Used by the
// WhatsApp inbox's guest panel today, and written so a future Guests page can call
// the same thing without going through the WhatsApp function.
//
// There is no shared guest table yet: each module stores people its own way (event
// bookings keep the number as the guest typed it, accommodation keeps a normalized
// number on a person record), so this matches on the normalized E.164 number. A
// guest who was entered without a number, or with a different one, can't be matched,
// and people are never merged on name alone (accommodation's own rule).
//
// This module does no access checks: the caller decides which sections the viewer's
// role may see (`payments` / `accommodation`) and passes them in. It never returns a
// phone number, email or any other contact detail.
import { listRecentPaymentsForContactMatch } from '../../../scripts/lib/event-payments-db.mjs';
import { listTemplateSendsForBookings } from '../../../scripts/lib/supabase.mjs';
import { searchGuests, listStaysForPerson } from '../../../scripts/lib/accommodation-db.mjs';
import { normalizeMobileNumber } from '../../../scripts/lib/phone.mjs';
import { formatAmount } from './email-layout';
import { maskName } from './staff-masking';
import { bookingStatus, messageSummary, shapeStay, type BookingRow } from './whatsapp-guest';

export interface GuestContext {
  eventBookings: { visible: boolean; error?: boolean; items: unknown[] };
  stays: { visible: boolean; error?: boolean; people: unknown[] };
}

export async function loadGuestContext(opts: {
  e164: string;
  // May the viewer see Event Payments data?
  payments: boolean;
  // May the viewer see Accommodation data, and if so, in full names or masked?
  accommodation: false | { seeNames: boolean };
}): Promise<GuestContext> {
  const result: GuestContext = {
    eventBookings: { visible: opts.payments, items: [] },
    stays: { visible: opts.accommodation !== false, people: [] },
  };

  // Each section is independent: one module being down must not hide the other.
  await Promise.all([
    (async () => {
      if (!opts.payments) return;
      try {
        const rows = await listRecentPaymentsForContactMatch();
        const mine = rows.filter((r: any) => normalizeMobileNumber(r.payer_contact) === opts.e164).slice(0, 10);
        const sends = await listTemplateSendsForBookings(mine.map((r: any) => r.id));
        result.eventBookings.items = (mine as Array<BookingRow & { id: string }>).map((r) => ({
          eventTitle: r.event_title,
          eventDate: r.event_date,
          attendees: r.attendee_count ?? 1,
          amount: formatAmount(r.amount, r.currency),
          isTest: r.mode === 'test',
          status: bookingStatus(r),
          whatsappOptIn: r.whatsapp_opt_in,
          messages: messageSummary(sends.filter((s: any) => s.event_payment_id === r.id)),
        }));
      } catch (err) {
        console.error('[guest-context] Failed to load event bookings', err);
        result.eventBookings.error = true;
      }
    })(),
    (async () => {
      if (opts.accommodation === false) return;
      const { seeNames } = opts.accommodation;
      try {
        const people = (await searchGuests({ query: '', mobileNumber: opts.e164 })).slice(0, 5);
        result.stays.people = await Promise.all(
          people.map(async (p: any) => {
            const found = await listStaysForPerson(p.id);
            return { name: seeNames ? p.name : maskName(p.name ?? ''), stays: (found?.stays ?? []).slice(0, 6).map(shapeStay) };
          }),
        );
      } catch (err) {
        console.error('[guest-context] Failed to load stays', err);
        result.stays.error = true;
      }
    })(),
  ]);

  return result;
}
