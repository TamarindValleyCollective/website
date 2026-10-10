// Out-of-hours auto-reply for inbound WhatsApp messages (used by
// whatsapp-webhook.mts). Dormant unless WHATSAPP_AUTOACK_ENABLED=true.
//
// The reply is a free-form text, which Meta allows because the guest just
// messaged us (inside the 24-hour window). It only says we're away and when
// we're back; it never tries to answer the question, so a wrong guess can't
// reach a guest.

// Staff hours in IST, "HH:MM-HH:MM", configurable via WHATSAPP_AUTOACK_HOURS.
const DEFAULT_HOURS = '09:00-19:00';
const IST_OFFSET_MINUTES = 330;

export function parseHours(spec: string | undefined): { open: number; close: number } {
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec((spec ?? DEFAULT_HOURS).trim());
  const fallback = { open: 9 * 60, close: 19 * 60 };
  if (!m) return fallback;
  const open = Number(m[1]) * 60 + Number(m[2]);
  const close = Number(m[3]) * 60 + Number(m[4]);
  return open < close && close <= 24 * 60 ? { open, close } : fallback;
}

// True when `now` falls outside the staffed window, in IST.
export function isOutsideHours(now: Date, spec?: string): boolean {
  const { open, close } = parseHours(spec);
  const istMinutes = (((now.getUTCHours() * 60 + now.getUTCMinutes() + IST_OFFSET_MINUTES) % 1440) + 1440) % 1440;
  return istMinutes < open || istMinutes >= close;
}

function formatClock(minutes: number): string {
  const h24 = Math.floor(minutes / 60);
  const mm = minutes % 60;
  const suffix = h24 >= 12 ? 'pm' : 'am';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return mm === 0 ? `${h12} ${suffix}` : `${h12}:${String(mm).padStart(2, '0')} ${suffix}`;
}

export function autoAckText(spec?: string): string {
  const { open } = parseHours(spec);
  return (
    `Thanks for messaging Tamarind Valley Collective 🌿\n\n` +
    `Our team is away right now and will reply when we're back at ${formatClock(open)} IST. ` +
    `For directions and visit details, see https://tvc.farm/visit.\n\n` +
    `(This is an automated message.)`
  );
}

// Inbound types worth acknowledging. Reactions, statuses and unsupported
// payloads aren't someone waiting for an answer.
export function shouldAutoAck(messageType: string): boolean {
  return ['text', 'button', 'interactive', 'image', 'audio', 'video', 'document', 'location', 'contacts', 'sticker'].includes(messageType);
}
