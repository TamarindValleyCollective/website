// Sends an approved WhatsApp message TEMPLATE through the Cloud API — the only
// kind of message allowed outside the 24-hour customer-service window, which
// is where every guest/staff notification here falls (see WHATSAPP.md). Never
// throws: a notification must never break the booking/refund/enquiry action it
// rides along with, so every failure is logged and reported as 'failed'.
//
// Safe to ship before the templates are approved: nothing is sent unless the
// template's name (or its `_v2` successor) is listed in WHATSAPP_APPROVED_TEMPLATES (comma-separated),
// which gets set once Meta has approved it. Test-mode bookings are only ever
// sent to WHATSAPP_TEST_NUMBER (and skipped when that isn't set), never to
// the guest's number.
import { normalizeMobileNumber } from '../../../scripts/lib/phone.mjs';
import { recordTemplateSend } from '../../../scripts/lib/supabase.mjs';
import { WHATSAPP_TEMPLATES, type WhatsAppTemplateName } from './whatsapp-templates';

const GRAPH_API_VERSION = 'v21.0';

// Meta rejects newlines, tabs and runs of 5+ spaces inside a template
// variable, and caps the length; free text (a guest-facing reason, an enquiry
// message) is flattened to fit. An empty value is replaced, since Meta
// rejects empty parameters too.
export function cleanTemplateParam(value: string | null | undefined, maxLength = 400): string {
  const flat = (value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  if (!flat) return '-';
  return flat.length > maxLength ? `${flat.slice(0, maxLength - 1).trimEnd()}…` : flat;
}

// A free-text reason is dropped into the middle of a template sentence
// ("…has been cancelled. {{3}} A refund of…"), so give it a full stop when the
// admin didn't type one — otherwise the two sentences run together.
export function asSentence(value: string | null | undefined, maxLength = 300): string {
  const text = cleanTemplateParam(value, maxLength);
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

export function firstNameOf(fullName: string | null | undefined): string {
  return fullName?.trim().split(/\s+/)[0] || 'there';
}

// "Saturday, 10 October 2026" from an event_payments.event_date ('YYYY-MM-DD').
// Parsed as a calendar date (UTC noon) so the weekday can't slip across a
// timezone boundary. Falls back to a neutral phrase for bookings that have no
// date on file (made before the column existed), since Meta rejects empty
// template parameters.
export function formatEventDate(isoDate: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate ?? '');
  if (!m) return 'the date on your booking';
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12)).toLocaleDateString('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function approvedTemplates(): Set<string> {
  return new Set((process.env.WHATSAPP_APPROVED_TEMPLATES ?? '').split(',').map((s) => s.trim()).filter(Boolean));
}

// Call sites name the v1 template; once its `_v2` successor (same variables,
// see whatsapp-templates.ts) is approved and listed, that one is sent instead.
function resolveTemplate(name: WhatsAppTemplateName): WhatsAppTemplateName {
  const v2 = `${name}_v2` as WhatsAppTemplateName;
  return v2 in WHATSAPP_TEMPLATES && approvedTemplates().has(v2) ? v2 : name;
}

export async function sendWhatsAppTemplate(opts: {
  template: WhatsAppTemplateName;
  // Raw number as typed by the guest (any common format) — normalized here.
  to: string | null | undefined;
  params: string[];
  isTest?: boolean;
  // The booking this message is about, so its delivery status can be shown
  // against it on the Event Payments dashboard.
  bookingId?: string | null;
}): Promise<'sent' | 'skipped' | 'failed'> {
  try {
    const template = resolveTemplate(opts.template);
    if (!approvedTemplates().has(template)) return 'skipped';

    const expected = (WHATSAPP_TEMPLATES[template].body.match(/\{\{\d+\}\}/g) ?? []).length;
    if (opts.params.length !== expected) {
      console.error(`[whatsapp-send] ${template} expects ${expected} params, got ${opts.params.length}`);
      return 'failed';
    }

    const target = opts.isTest ? process.env.WHATSAPP_TEST_NUMBER : opts.to;
    const e164 = normalizeMobileNumber(target ?? '');
    if (!e164) return 'skipped'; // no usable number on file (or no test number configured)

    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    if (!phoneNumberId || !accessToken) {
      console.error('[whatsapp-send] Missing WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN');
      return 'failed';
    }

    const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: e164.replace(/^\+/, ''),
        type: 'template',
        template: {
          name: template,
          language: { code: 'en' },
          components: [{ type: 'body', parameters: opts.params.map((text) => ({ type: 'text', text })) }],
        },
      }),
    });
    if (!res.ok) {
      console.error(`[whatsapp-send] ${template} failed`, res.status, await res.text());
      return 'failed';
    }
    // Meta only says "accepted" here; whether it reaches the phone arrives
    // later as a webhook status event (whatsapp-webhook.mts). Record the
    // wamid now so that event has a row to update. Best-effort: tracking must
    // never turn a sent message into a reported failure.
    try {
      const waMessageId = (await res.json())?.messages?.[0]?.id;
      if (waMessageId) {
        await recordTemplateSend({ waMessageId, template, eventPaymentId: opts.bookingId ?? null, recipientLast4: e164.slice(-4) });
      }
    } catch (err) {
      console.error('[whatsapp-send] Failed to record template send for delivery tracking', err);
    }
    return 'sent';
  } catch (err) {
    console.error(`[whatsapp-send] ${opts.template} threw`, err);
    return 'failed';
  }
}

// Staff alerts go to every number in WHATSAPP_STAFF_ALERT_NUMBERS
// (comma-separated); nothing is sent when it isn't set.
export async function sendStaffWhatsAppAlert(template: WhatsAppTemplateName, params: string[]): Promise<void> {
  const numbers = (process.env.WHATSAPP_STAFF_ALERT_NUMBERS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  await Promise.all(numbers.map((to) => sendWhatsAppTemplate({ template, to, params })));
}

// A free-form text reply. Only valid inside the 24-hour customer-service
// window, i.e. in response to a message the guest just sent (the auto-reply in
// whatsapp-webhook.mts). Never throws.
export async function sendWhatsAppText(
  toWaPhone: string,
  body: string,
): Promise<{ ok: true; waMessageId: string | null } | { ok: false; error: string }> {
  try {
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    if (!phoneNumberId || !accessToken) return { ok: false, error: 'Missing WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN' };
    const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: toWaPhone, type: 'text', text: { body } }),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data?.error?.message ?? `WhatsApp API error ${res.status}` };
    return { ok: true, waMessageId: data?.messages?.[0]?.id ?? null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
