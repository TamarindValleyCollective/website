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
  // Razorpay's list endpoints use "payment_links" as the collection key here
  // (not "items" - that's the shape of some of their other list endpoints,
  // e.g. orders/payments; confirmed against the real API, see PR fixing this).
  const data = (await res.json()) as { payment_links: RazorpayPaymentLink[] };
  if (data.payment_links.length === 0) {
    throw new Error(`No Payment Link found with reference_id "${referenceId}"`);
  }
  if (data.payment_links.length > 1) {
    throw new Error(`Multiple Payment Links found with reference_id "${referenceId}" — expected exactly one`);
  }
  return data.payment_links[0];
}

// Same lookup as fetchBasePaymentLink, but for a per-booking link
// (event-booking.mts's idempotency guard, see that function's comment). A
// per-booking reference_id is only *usually* one-to-one with a link — an
// email that already has a paid booking and starts a genuinely separate one
// gets a second link under the same deterministic reference_id (Razorpay
// doesn't enforce reference_id uniqueness), so unlike fetchBasePaymentLink
// this never throws on the count: zero and "more than one" are both normal,
// expected shapes here, and the caller decides what to do with whichever
// ones come back.
export async function fetchPaymentLinksByReferenceId(referenceId: string): Promise<RazorpayPaymentLink[]> {
  const res = await fetch(`${API_BASE}/payment_links?reference_id=${encodeURIComponent(referenceId)}`, {
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) {
    throw new Error(`Razorpay fetch payment_links failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { payment_links: RazorpayPaymentLink[] };
  return data.payment_links;
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

export interface RazorpayPaymentDetail {
  id: string;
  amount: number;
  currency: string;
  method: string;
  captured: boolean;
  // Paise, Razorpay's own cut — both null until Razorpay has actually
  // computed them, which doesn't reliably happen by the time
  // payment_link.paid fires (see scripts/reconcile-event-payment-fees.mjs,
  // which polls this endpoint after the fact rather than trusting the
  // webhook payload for these two fields).
  fee: number | null;
  tax: number | null;
}

// GET /payments/:id — used only by scripts/reconcile-event-payment-fees.mjs
// to poll for the fee/tax the payment_link.paid webhook payload doesn't
// reliably carry yet (see that script). Everything else in this file reads
// from the webhook payload or a Payment Link, not this endpoint.
export async function fetchPayment(paymentId: string): Promise<RazorpayPaymentDetail> {
  const res = await fetch(`${API_BASE}/payments/${paymentId}`, {
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) {
    throw new Error(`Razorpay fetch payment failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as RazorpayPaymentDetail;
}

export interface RazorpayRefund {
  id: string;
  amount: number;
  status: string;
  payment_id: string;
}

// Issues a refund against an already-captured payment (see
// event-payments-admin.mts) — Razorpay's own MCP server exposes fetch/list
// tools for refunds but no way to create one, so this goes straight to
// their REST API like every other call in this file. `amount` is always
// sent explicitly (paise): Razorpay treats an omitted amount as "refund the
// full payment", but the caller here always computes one (a
// /refund-policy tier suggestion or an admin override), so passing it
// explicitly avoids relying on that default.
export async function createRefund(params: {
  paymentId: string;
  amount: number;
  notes?: Record<string, string>;
}): Promise<RazorpayRefund> {
  const res = await fetch(`${API_BASE}/payments/${params.paymentId}/refund`, {
    method: 'POST',
    headers: { Authorization: authHeader(), 'content-type': 'application/json' },
    body: JSON.stringify({ amount: params.amount, speed: 'normal', notes: params.notes }),
  });
  if (!res.ok) {
    throw new Error(`Razorpay create refund failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as RazorpayRefund;
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
