// Single source of truth for the outbound WhatsApp message templates. The
// `body` text here is exactly what gets submitted to Meta for approval in
// WhatsApp Manager > Message templates (see docs/whatsapp-templates.md) — a
// template's wording is fixed once approved, so changing it means submitting
// a new template, not editing this. `samples` are the example values Meta
// requires at submission.
//
// All are category UTILITY (transactional), language English ("en").
//
// Each v1 template has a `_v2` successor with the same variables in the same
// order, plus a text header, a footer, *bold* key facts and a few emoji (see
// docs/whatsapp-templates.md). Header and footer are static text, so sending
// needs no extra components. sendWhatsAppTemplate (whatsapp-send.ts) uses the
// `_v2` template once it's in WHATSAPP_APPROVED_TEMPLATES and the v1 until
// then, so call sites keep using the v1 names and nothing breaks while Meta
// approves the new ones.
export const WHATSAPP_TEMPLATES = {
  tvc_event_cancelled: {
    body: "Hi {{1}}, we're sorry — {{2}} has been cancelled. {{3}} A refund of {{4}} has been started to your original payment method and should reach you within a few business days. Questions? Reply here or email core-team@tvc.farm.",
    samples: ['Asha', 'Foraging Day', 'Heavy rain is forecast and the forest trails will not be safe.', '₹2,250'],
  },
  tvc_refund_initiated: {
    body: "Hi {{1}}, we've started a refund of {{2}} for your booking for {{3}}. It should reach your original payment method within a few business days. Questions? Reply here or email core-team@tvc.farm.",
    samples: ['Asha', '₹2,250', 'Foraging Day'],
  },
  tvc_refund_processed: {
    body: 'Hi {{1}}, your refund of {{2}} for {{3}} has been processed and sent to your original payment method. Depending on your bank it can take a few more business days to show up. Questions? Reply here or email core-team@tvc.farm.',
    samples: ['Asha', '₹2,250', 'Foraging Day'],
  },
  tvc_cancellation_declined: {
    body: "Hi {{1}}, thanks for your cancellation request for {{2}}. We're not able to cancel this booking under our cancellation and refund policy, so it stays confirmed. {{3}} If your plans have changed, reply here or email core-team@tvc.farm and we'll talk it through.",
    samples: ['Asha', 'Foraging Day', 'The event is less than 48 hours away.'],
  },
  // Internal: sent to TVC admins, not guests.
  tvc_staff_enquiry_alert: {
    body: 'New {{1}} enquiry received on the TVC website from {{2}}. Their message: {{3}} Please reply to them from the contact inbox or the enquiries sheet.',
    samples: ['membership', 'Asha Rao', 'I would like to know more about joining the collective.'],
  },
  tvc_event_cancelled_v2: {
    header: 'Event cancelled',
    footer: 'Tamarind Valley Collective',
    body: "Hi {{1}}, we're sorry — *{{2}}* has been cancelled. 😔\n\n{{3}}\n\n💸 *Refund:* {{4}} has been started to your original payment method and should reach you within a few business days.\n\nQuestions? Just reply here or email core-team@tvc.farm.",
    samples: ['Asha', 'Foraging Day', 'Heavy rain is forecast and the forest trails will not be safe.', '₹2,250'],
  },
  tvc_refund_initiated_v2: {
    header: 'Refund started',
    footer: 'Tamarind Valley Collective',
    body: "Hi {{1}}, we've started a refund for your booking. 💸\n\n💰 *Refund:* {{2}}\n🎟️ *Event:* {{3}}\n\nIt should reach your original payment method within a few business days.\n\nQuestions? Just reply here or email core-team@tvc.farm.",
    samples: ['Asha', '₹2,250', 'Foraging Day'],
  },
  tvc_refund_processed_v2: {
    header: 'Refund processed',
    footer: 'Tamarind Valley Collective',
    body: 'Hi {{1}}, your refund has been processed and sent to your original payment method. ✅\n\n💰 *Refund:* {{2}}\n🎟️ *Event:* {{3}}\n\nDepending on your bank it can take a few more business days to show up.\n\nQuestions? Just reply here or email core-team@tvc.farm.',
    samples: ['Asha', '₹2,250', 'Foraging Day'],
  },
  tvc_cancellation_declined_v2: {
    header: 'About your cancellation request',
    footer: 'Tamarind Valley Collective',
    body: "Hi {{1}}, thanks for your cancellation request for *{{2}}*. We're not able to cancel this booking under our cancellation and refund policy, so it stays confirmed. ✅\n\n📝 {{3}}\n\nIf your plans have changed, just reply here or email core-team@tvc.farm and we'll talk it through.",
    samples: ['Asha', 'Foraging Day', 'The event is less than 48 hours away.'],
  },
  // Internal: sent to TVC admins, not guests.
  tvc_staff_enquiry_alert_v2: {
    header: 'New website enquiry',
    footer: 'TVC website · internal alert',
    body: '📩 New *{{1}}* enquiry received on the TVC website.\n\n👤 *From:* {{2}}\n💬 *Message:* {{3}}\n\nPlease reply to them from the contact inbox or the enquiries sheet.',
    samples: ['membership', 'Asha Rao', 'I would like to know more about joining the collective.'],
  },
  // Booking happy path (added 2026-10-10). New names, not v1/v2 successors.
  // `buttons` are static (a fixed URL, or a quick reply) so sending needs no
  // button components; they only matter at submission time.
  tvc_booking_confirmed: {
    header: 'Booking confirmed',
    footer: 'Tamarind Valley Collective',
    body: "Hi {{1}}, you're all set! ✅\n\n🎟️ *Event:* {{2}}\n📅 *Date:* {{3}}\n👥 *Guests:* {{4}}\n💰 *Paid:* {{5}}\n\nA receipt is on its way to your email. Tap below for directions to the farm, or just reply here with any questions.",
    samples: ['Asha', 'Foraging Day', 'Saturday, 10 October 2026', '2', '₹4,500'],
    buttons: [{ type: 'url', text: 'Get directions', url: 'https://tvc.farm/visit/how-to-reach' }],
  },
  tvc_event_reminder: {
    header: 'See you tomorrow!',
    footer: 'Tamarind Valley Collective',
    body: "Hi {{1}}, a quick reminder that *{{2}}* is on *{{3}}*. 🌿\n\nWe're looking forward to having you at the farm. The route can be tricky, so please check the directions before you set out. If anything has come up, tap below or reply here and we'll help.",
    samples: ['Asha', 'Foraging Day', 'Saturday, 10 October 2026'],
    buttons: [
      { type: 'url', text: 'Get directions', url: 'https://tvc.farm/visit/how-to-reach' },
      { type: 'quick_reply', text: 'I need help' },
    ],
  },
  // Approval-gated booking (added 2026-10-11): the request goes to Linger
  // admins, and the payment link goes to the guest only after they approve.
  // Internal: sent to the booking approvers (WHATSAPP_BOOKING_APPROVER_NUMBERS).
  tvc_booking_approval_request: {
    header: 'New booking request',
    footer: 'TVC website · internal alert',
    body: '🎟️ New booking request for *{{1}}*.\n\n👤 *Guest:* {{2}}\n👥 *People:* {{3}}\n📞 *Phone:* {{4}}\n\nPlease speak to them first, then approve or decline here:\n{{5}}\n\nThe payment link is only sent once you approve.',
    samples: ['Foraging Day', 'Asha Rao', '2', '+91 98765 43210', 'https://tvc.farm/approve-booking?token=abc123'],
  },
  tvc_booking_payment_link: {
    header: 'Complete your booking',
    footer: 'Tamarind Valley Collective',
    body: 'Hi {{1}}, thanks for speaking with us! Your booking for *{{2}}* is approved. ✅\n\n📅 *Date:* {{3}}\n👥 *People:* {{4}}\n💰 *Total:* {{5}}\n\nPlease pay within 48 hours to confirm your spot:\n{{6}}\n\nQuestions? Just reply here or email core-team@tvc.farm.',
    samples: ['Asha', 'Foraging Day', 'Saturday, 10 October 2026', '2', '₹4,500', 'https://rzp.io/rzp/abc123'],
  },
  // Accommodation allocation notices (added 2026-10-12): sent by admins from the
  // accommodation calendar once an allocation is finalized (stay-notify.ts).
  // Member stays only for now. {{2}} is the tent(s) the guest is in.
  tvc_stay_confirmed: {
    header: 'Your stay is confirmed',
    footer: 'Tamarind Valley Collective',
    body: "Hi {{1}}, your stay at the farm is confirmed. ✅\n\n🏕️ *Where:* {{2}}\n📅 *Check-in:* {{3}}\n📅 *Check-out:* {{4}}\n\nTap below for directions, or just reply here with any questions.",
    samples: ['Asha', 'Malabar Hut Fixed Tent (N)', 'Saturday, 1 November 2026', 'Monday, 3 November 2026'],
    buttons: [{ type: 'url', text: 'Get directions', url: 'https://tvc.farm/visit/how-to-reach' }],
  },
  tvc_stay_updated: {
    header: 'Your stay has changed',
    footer: 'Tamarind Valley Collective',
    body: "Hi {{1}}, there's been a change to your stay at the farm. 🔄\n\n🏕️ *Where:* {{2}}\n📅 *Check-in:* {{3}}\n📅 *Check-out:* {{4}}\n\nThis replaces what we told you before. Questions? Just reply here or email core-team@tvc.farm.",
    samples: ['Asha', 'Banyan Hut Fixed Tent', 'Saturday, 1 November 2026', 'Monday, 3 November 2026'],
  },
  tvc_stay_cancelled: {
    header: 'Your stay is cancelled',
    footer: 'Tamarind Valley Collective',
    body: "Hi {{1}}, your stay at the farm from *{{2}}* has been cancelled. 😔\n\nIf you weren't expecting this, or you'd like to rebook, just reply here or email core-team@tvc.farm and we'll sort it out.",
    samples: ['Asha', 'Saturday, 1 November 2026'],
  },
  // Internal: sent to TVC admins (WHATSAPP_STAFF_ALERT_NUMBERS), not guests.
  tvc_stay_staff_alert: {
    header: 'Stay allocation',
    footer: 'TVC website · internal alert',
    body: '🏕️ Stay allocation *{{1}}* for *{{2}}*.\n\n📅 *Dates:* {{3}}\n👥 *Guests:* {{4}}\n\nGuests with a mobile or email on file were messaged from the accommodation calendar.',
    samples: ['confirmed', 'Asha Rao', '1 Nov 2026 to 3 Nov 2026', 'Asha (Malabar Hut Fixed Tent (N)), Ravi (Banyan Hut Fixed Tent)'],
  },
} as const;

export type WhatsAppTemplateName = keyof typeof WHATSAPP_TEMPLATES;
