// Sends an approved WhatsApp message TEMPLATE through the Cloud API — the only
// kind of message allowed outside the 24-hour customer-service window, which
// is where every guest/staff notification here falls (see WHATSAPP.md). Never
// throws: a notification must never break the booking/refund/enquiry action it
// rides along with, so every failure is logged and reported as 'failed'.
//
// Safe to ship before the templates are approved: nothing is sent unless the
// template's name is listed in WHATSAPP_APPROVED_TEMPLATES (comma-separated),
// which gets set once Meta has approved it. Test-mode bookings are only ever
// sent to WHATSAPP_TEST_NUMBER (and skipped when that isn't set), never to
// the guest's number.
import { normalizeMobileNumber } from '../../../scripts/lib/phone.mjs';
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

function approvedTemplates(): Set<string> {
  return new Set((process.env.WHATSAPP_APPROVED_TEMPLATES ?? '').split(',').map((s) => s.trim()).filter(Boolean));
}

export async function sendWhatsAppTemplate(opts: {
  template: WhatsAppTemplateName;
  // Raw number as typed by the guest (any common format) — normalized here.
  to: string | null | undefined;
  params: string[];
  isTest?: boolean;
}): Promise<'sent' | 'skipped' | 'failed'> {
  try {
    if (!approvedTemplates().has(opts.template)) return 'skipped';

    const expected = (WHATSAPP_TEMPLATES[opts.template].body.match(/\{\{\d+\}\}/g) ?? []).length;
    if (opts.params.length !== expected) {
      console.error(`[whatsapp-send] ${opts.template} expects ${expected} params, got ${opts.params.length}`);
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
          name: opts.template,
          language: { code: 'en' },
          components: [{ type: 'body', parameters: opts.params.map((text) => ({ type: 'text', text })) }],
        },
      }),
    });
    if (!res.ok) {
      console.error(`[whatsapp-send] ${opts.template} failed`, res.status, await res.text());
      return 'failed';
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
