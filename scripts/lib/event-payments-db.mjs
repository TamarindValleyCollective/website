// Data-access layer for the event_payments table (see
// supabase/migrations/0018_event_payments.sql,
// 0019_event_payments_cancellation.sql,
// 0020_event_payments_refunds.sql) in the "TVC ERP" Supabase project.
// Mirrors supabase.mjs/accommodation-db.mjs's hand-rolled PostgREST style
// (no @supabase/supabase-js) and reuses supabase.mjs's restHeaders for the
// same service_role auth. Used by netlify/functions/razorpay-webhook.mts
// and netlify/functions/cancel-booking.mts.
import { restHeaders } from './supabase.mjs';

function supabaseUrl() {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error('Missing SUPABASE_URL');
  return url;
}

// Idempotent insert keyed on razorpay_payment_id (see the migration's unique
// index) — a re-delivered payment_link.paid webhook for a payment already
// recorded returns an empty array here (nothing inserted) rather than an
// error, which the caller uses as the "already processed, skip the receipt
// email too" signal instead of a separate exists-check-then-insert
// round-trip (the same race a plain read-then-write would have under
// concurrent retries).
/**
 * @param {{ eventReferenceId: string, eventTitle: string, razorpayPaymentId: string, razorpayPaymentLinkId: string, amount: number, currency: string, attendeeCount?: number, payerName?: string | null, payerEmail?: string, payerContact?: string }} params
 * @returns {Promise<{ id: string } | null>} the inserted row, or null if razorpayPaymentId was already recorded
 */
export async function recordPaymentIfNew({
  eventReferenceId,
  eventTitle,
  razorpayPaymentId,
  razorpayPaymentLinkId,
  amount,
  currency,
  attendeeCount,
  payerName,
  payerEmail,
  payerContact,
}) {
  const res = await fetch(`${supabaseUrl()}/rest/v1/event_payments?on_conflict=razorpay_payment_id`, {
    method: 'POST',
    headers: restHeaders({ Prefer: 'resolution=ignore-duplicates,return=representation' }),
    body: JSON.stringify([
      {
        event_reference_id: eventReferenceId,
        event_title: eventTitle,
        razorpay_payment_id: razorpayPaymentId,
        razorpay_payment_link_id: razorpayPaymentLinkId,
        amount,
        currency,
        attendee_count: attendeeCount ?? 1,
        payer_name: payerName ?? null,
        payer_email: payerEmail ?? null,
        payer_contact: payerContact ?? null,
      },
    ]),
  });
  if (!res.ok) {
    throw new Error(`Supabase insert into event_payments failed: ${res.status} ${await res.text()}`);
  }
  const rows = await res.json();
  return rows[0] ?? null;
}

// Marks a recorded payment's receipt as sent — called after the Resend
// email succeeds, so a webhook retry that reaches recordPaymentIfNew again
// (impossible for the same payment once inserted, but kept explicit here
// for anyone reading this file) can tell a receipt already went out.
export async function markReceiptSent(id) {
  const res = await fetch(`${supabaseUrl()}/rest/v1/event_payments?id=eq.${id}`, {
    method: 'PATCH',
    headers: restHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify({ receipt_sent_at: new Date().toISOString() }),
  });
  if (!res.ok) {
    throw new Error(`Supabase update to event_payments failed: ${res.status} ${await res.text()}`);
  }
}

// Looks a payment up by Razorpay's own payment id — the identifier a
// receipt email's cancel-booking link carries (see payment-receipt.ts).
// Razorpay payment ids are high-entropy and never displayed anywhere
// public except to the payer themselves, so treating one as a bearer
// token for "which booking is this" is the same trust level a card
// statement reference or an order-confirmation link already has - not a
// substitute for real auth if this flow ever needs one (e.g. letting a
// guest see *all* their bookings), but fine for "act on the one booking
// named in a link only its own payer received."
/**
 * @param {string} razorpayPaymentId
 * @returns {Promise<{ id: string, event_title: string, amount: number, currency: string, attendee_count: number, payer_email: string | null, created_at: string, cancellation_requested_at: string | null } | null>}
 */
export async function getPaymentByRazorpayId(razorpayPaymentId) {
  const res = await fetch(
    `${supabaseUrl()}/rest/v1/event_payments?razorpay_payment_id=eq.${encodeURIComponent(razorpayPaymentId)}&select=id,event_title,amount,currency,attendee_count,payer_email,created_at,cancellation_requested_at`,
    { headers: restHeaders() },
  );
  if (!res.ok) {
    throw new Error(`Supabase read from event_payments failed: ${res.status} ${await res.text()}`);
  }
  const rows = await res.json();
  return rows[0] ?? null;
}

// Records a cancellation request, but only the first time — a second call
// for an already-requested id is a no-op (returns false) so
// cancel-booking.mts can tell "just recorded" from "already had one on
// file" and only send the notification email once.
/**
 * @param {string} id row id from getPaymentByRazorpayId
 * @returns {Promise<boolean>} true if this call is the one that recorded the request
 */
export async function requestCancellationIfNew(id) {
  const res = await fetch(`${supabaseUrl()}/rest/v1/event_payments?id=eq.${id}&cancellation_requested_at=is.null`, {
    method: 'PATCH',
    headers: restHeaders({ Prefer: 'return=representation' }),
    body: JSON.stringify({ cancellation_requested_at: new Date().toISOString() }),
  });
  if (!res.ok) {
    throw new Error(`Supabase update to event_payments failed: ${res.status} ${await res.text()}`);
  }
  const rows = await res.json();
  return rows.length > 0;
}

// Single row lookup by its own id (not the Razorpay payment id) — used by
// event-payments-admin.mts's refund action, which the admin UI addresses by
// this row's id rather than the payment id it doesn't otherwise surface.
/**
 * @param {string} id
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function getPaymentById(id) {
  const res = await fetch(`${supabaseUrl()}/rest/v1/event_payments?id=eq.${encodeURIComponent(id)}&select=*`, {
    headers: restHeaders(),
  });
  if (!res.ok) {
    throw new Error(`Supabase read from event_payments failed: ${res.status} ${await res.text()}`);
  }
  const rows = await res.json();
  return rows[0] ?? null;
}

// Every booking row for one event, newest first — the source data for
// src/pages/internal/event-payments.astro's table and aggregates (see
// netlify/functions/event-payments-admin.mts).
/**
 * @param {string} eventReferenceId
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function listPaymentsForEvent(eventReferenceId) {
  const res = await fetch(
    `${supabaseUrl()}/rest/v1/event_payments?event_reference_id=eq.${encodeURIComponent(eventReferenceId)}&select=*&order=created_at.desc`,
    { headers: restHeaders() },
  );
  if (!res.ok) {
    throw new Error(`Supabase read from event_payments failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// Records a refund actually issued through Razorpay's API, but only the
// first time for a given row — guarded on refunded_at=is.null the same way
// requestCancellationIfNew guards cancellation_requested_at, so a
// double-click (or a retried request) can't record — or imply — a second
// refund against the same payment. The caller (event-payments-admin.mts)
// calls Razorpay first and only reaches this once that's confirmed to have
// succeeded, so "recorded" here always means "money actually moved." A
// proactive admin refund may not have gone through the guest-facing
// /cancel-booking request flow at all — the caller separately calls
// requestCancellationIfNew for the same id when that's the case, so the row
// reads as fully cancelled either way without this function overwriting an
// earlier guest-initiated timestamp itself.
/**
 * @param {string} id row id
 * @param {{ razorpayRefundId: string, amount: number, status: string, refundedBy: string }} params
 * @returns {Promise<boolean>} true if this call is the one that recorded the refund
 */
export async function recordRefund(id, { razorpayRefundId, amount, status, refundedBy }) {
  const res = await fetch(`${supabaseUrl()}/rest/v1/event_payments?id=eq.${id}&refunded_at=is.null`, {
    method: 'PATCH',
    headers: restHeaders({ Prefer: 'return=representation' }),
    body: JSON.stringify({
      razorpay_refund_id: razorpayRefundId,
      refund_amount: amount,
      refund_status: status,
      refunded_at: new Date().toISOString(),
      refunded_by: refundedBy,
    }),
  });
  if (!res.ok) {
    throw new Error(`Supabase update to event_payments failed: ${res.status} ${await res.text()}`);
  }
  const rows = await res.json();
  return rows.length > 0;
}
