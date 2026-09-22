// Shared Razorpay REST helpers for event-booking.mts (creates a per-booking
// Payment Link) and razorpay-webhook.mts (verifies + parses the
// payment_link.paid callback). Hand-rolled fetch calls with Basic Auth,
// matching this repo's small-hand-rolled-client-over-heavy-SDK preference
// (see google-drive.mjs, scripts/lib/supabase.mjs) rather than adding the
// razorpay npm package for what's a handful of well-defined REST calls.
import { createHmac, timingSafeEqual } from 'node:crypto';

const API_BASE = 'https://api.razorpay.com/v1';

function authHeader(): string {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    throw new Error('Missing RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET');
  }
  return `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;
}

export interface RazorpayPaymentLink {
  id: string;
  reference_id: string | null;
  description: string | null;
  notes: Record<string, string>;
  amount: number;
  currency: string;
  status: string;
  short_url: string;
  expire_by?: number;
}

// Looks up the event's own hand-created Payment Link by its reference_id
// (e.g. "foraging-day-2026-10-10") to read the trusted per-person price off
// it — this link is the source of truth for price, never paid directly once
// EventBookingForm is wired up for an event. Throws if none is found, or if
// more than one is (reference_id is meant to be unique per event; see
// RAZORPAY.md's table of links created so far).
export async function fetchBasePaymentLink(referenceId: string): Promise<RazorpayPaymentLink> {
  const res = await fetch(`${API_BASE}/payment_links?reference_id=${encodeURIComponent(referenceId)}`, {
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) {
    throw new Error(`Razorpay fetch payment_links failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { items: RazorpayPaymentLink[] };
  if (data.items.length === 0) {
    throw new Error(`No Payment Link found with reference_id "${referenceId}"`);
  }
  if (data.items.length > 1) {
    throw new Error(`Multiple Payment Links found with reference_id "${referenceId}" — expected exactly one`);
  }
  return data.items[0];
}

export interface CreatePaymentLinkParams {
  amount: number;
  currency: string;
  description: string;
  referenceId: string;
  notes: Record<string, string>;
  customerName?: string;
  customerEmail?: string;
  customerContact?: string;
  expireBy?: number;
}

export async function createPaymentLink(params: CreatePaymentLinkParams): Promise<RazorpayPaymentLink> {
  const res = await fetch(`${API_BASE}/payment_links`, {
    method: 'POST',
    headers: { Authorization: authHeader(), 'content-type': 'application/json' },
    body: JSON.stringify({
      amount: params.amount,
      currency: params.currency,
      description: params.description,
      reference_id: params.referenceId,
      notes: params.notes,
      notify: { sms: false, email: false },
      ...(params.expireBy ? { expire_by: params.expireBy } : {}),
      ...(params.customerName || params.customerEmail || params.customerContact
        ? {
            customer: {
              name: params.customerName,
              email: params.customerEmail,
              contact: params.customerContact,
            },
          }
        : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`Razorpay create payment_link failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as RazorpayPaymentLink;
}

// Webhook signature verification (X-Razorpay-Signature: HMAC-SHA256 over the
// raw body, using the webhook secret chosen when the webhook was created in
// the Razorpay dashboard — see RAZORPAY.md's setup notes). Same shape as
// whatsapp-webhook.mts's verifySignature (Meta uses the same HMAC-over-raw-
// body scheme, just a different header name).
export function verifyWebhookSignature(rawBody: string, header: string | null, webhookSecret: string): boolean {
  if (!header) return false;
  const expected = createHmac('sha256', webhookSecret).update(rawBody, 'utf8').digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const providedBuf = Buffer.from(header, 'hex');
  return expectedBuf.length === providedBuf.length && timingSafeEqual(expectedBuf, providedBuf);
}
