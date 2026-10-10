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
  // Internal: sent to TVC staff, not guests.
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
  // Internal: sent to TVC staff, not guests.
  tvc_staff_enquiry_alert_v2: {
    header: 'New website enquiry',
    footer: 'TVC website · internal alert',
    body: '📩 New *{{1}}* enquiry received on the TVC website.\n\n👤 *From:* {{2}}\n💬 *Message:* {{3}}\n\nPlease reply to them from the contact inbox or the enquiries sheet.',
    samples: ['membership', 'Asha Rao', 'I would like to know more about joining the collective.'],
  },
} as const;

export type WhatsAppTemplateName = keyof typeof WHATSAPP_TEMPLATES;
