// Single source of truth for the outbound WhatsApp message templates. The
// `body` text here is exactly what gets submitted to Meta for approval in
// WhatsApp Manager > Message templates (see docs/whatsapp-templates.md) — a
// template's wording is fixed once approved, so changing it means submitting
// a new template, not editing this. `samples` are the example values Meta
// requires at submission.
//
// All are category UTILITY (transactional), language English ("en").
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
} as const;

export type WhatsAppTemplateName = keyof typeof WHATSAPP_TEMPLATES;
