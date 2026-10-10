// STOP / START keyword handling for inbound WhatsApp messages (used by
// whatsapp-webhook.mts). A guest who replies STOP is added to
// whatsapp_opt_outs and gets no further template messages; START undoes it.
//
// Only an exact keyword counts (after trimming, lower-casing and dropping
// punctuation): "please stop calling me on this number" or "cancel my booking"
// are normal messages for staff, not opt-outs. "cancel" is deliberately NOT a
// keyword, since guests use it about their booking.

const STOP_WORDS = new Set(['stop', 'stop all', 'stop whatsapp', 'unsubscribe', 'opt out', 'optout', 'stop messages', 'stop messaging']);
const START_WORDS = new Set(['start', 'subscribe', 'resume', 'opt in', 'optin', 'start whatsapp']);

export function classifyKeyword(text: string | null | undefined): 'stop' | 'start' | null {
  const normalized = (text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (STOP_WORDS.has(normalized)) return 'stop';
  if (START_WORDS.has(normalized)) return 'start';
  return null;
}

export const STOP_REPLY =
  "You've been unsubscribed from WhatsApp booking updates from Tamarind Valley Collective, and we won't message you here again. " +
  "You'll still get any booking emails. Reply START any time to turn them back on.";

export const START_REPLY =
  "WhatsApp booking updates from Tamarind Valley Collective are back on for this number. Reply STOP any time to turn them off.";
