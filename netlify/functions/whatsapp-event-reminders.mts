// Netlify scheduled function (daily, 09:00 IST) — sends the "see you
// tomorrow" WhatsApp reminder (template tvc_event_reminder) to every guest
// booked for an event happening tomorrow. See WHATSAPP.md.
//
// Safe to ship dormant: sendWhatsAppTemplate sends nothing until the template
// is approved and listed in WHATSAPP_APPROVED_TEMPLATES, and then releases the
// claim so the booking isn't marked reminded. Each booking is claimed
// atomically before sending (claimReminder), so an overlapping or re-run
// invocation can't remind a guest twice; a failed send releases the claim so
// the next run retries. Bookings that are refunded or mid-refund (including
// every booking of a cancelled event) are never selected.
import { listBookingsDueReminder, claimReminder, releaseReminderClaim } from '../../scripts/lib/event-payments-db.mjs';
import { sendWhatsAppTemplate, cleanTemplateParam, firstNameOf, formatEventDate } from './lib/whatsapp-send';

const IST_OFFSET_MS = 330 * 60_000;

// Tomorrow's calendar date in IST, as YYYY-MM-DD.
function tomorrowInIst(now: Date): string {
  return new Date(now.getTime() + IST_OFFSET_MS + 24 * 3600_000).toISOString().slice(0, 10);
}

export default async (): Promise<Response> => {
  const eventDate = tomorrowInIst(new Date());
  let due: Array<Record<string, any>>;
  try {
    due = await listBookingsDueReminder(eventDate);
  } catch (err) {
    console.error('[whatsapp-event-reminders] Failed to query bookings', err);
    return new Response('Failed to query bookings', { status: 500 });
  }

  const tally = { sent: 0, skipped: 0, failed: 0, alreadyClaimed: 0 };
  for (const booking of due) {
    try {
      if (!(await claimReminder(booking.id))) {
        tally.alreadyClaimed++;
        continue;
      }
      const result = await sendWhatsAppTemplate({
        template: 'tvc_event_reminder',
        to: booking.payer_contact,
        isTest: booking.mode === 'test',
        bookingId: booking.id,
        params: [cleanTemplateParam(firstNameOf(booking.payer_name), 60), cleanTemplateParam(booking.event_title, 120), formatEventDate(booking.event_date)],
      });
      tally[result]++;
      if (result !== 'sent') await releaseReminderClaim(booking.id);
    } catch (err) {
      tally.failed++;
      console.error(`[whatsapp-event-reminders] Booking ${booking.id} failed`, err);
      await releaseReminderClaim(booking.id).catch(() => {});
    }
  }

  console.log('[whatsapp-event-reminders]', eventDate, JSON.stringify(tally));
  return new Response(JSON.stringify({ ok: true, eventDate, due: due.length, ...tally }), { status: 200 });
};

export const config = {
  schedule: '30 3 * * *', // 03:30 UTC = 09:00 IST
};
