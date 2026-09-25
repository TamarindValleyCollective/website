// Data-access layer for the event_payments table (see
// supabase/migrations/0018_event_payments.sql,
// 0019_event_payments_cancellation.sql,
// 0020_event_payments_refunds.sql, 0021_event_payments_mode.sql,
// 0022_event_payments_refund_initiated.sql) in the "TVC ERP" Supabase
// project.
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
 * @param {{ eventReferenceId: string, eventTitle: string, razorpayPaymentId: string, razorpayPaymentLinkId: string, amount: number, currency: string, attendeeCount?: number, payerName?: string | null, payerEmail?: string | null, payerContact?: string | null, mode: 'test' | 'live', eventDate?: string | null, paymentMethod?: string | null }} params
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
  mode,
  eventDate,
  paymentMethod,
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
        mode,
        event_date: eventDate ?? null,
        payment_method: paymentMethod ?? null,
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

// How many *other* real, still-standing bookings this email already has for
// this event — event-booking.mts's duplicate-payment guard (see that
// function's comment) checks this before creating a new per-booking Payment
// Link, so a guest who already paid can be warned before paying a second
// time rather than only discoverable afterward on the admin dashboard.
// Excludes refunded rows (money already given back — no longer a live
// duplicate) and test-mode rows (never a real charge); case-insensitive,
// matching how event-payments-admin.mts flags duplicates in the dashboard.
/**
 * @param {string} eventReferenceId
 * @param {string} email
 * @returns {Promise<number>}
 */
export async function countActivePaymentsForEmail(eventReferenceId, email) {
  const res = await fetch(
    `${supabaseUrl()}/rest/v1/event_payments?event_reference_id=eq.${encodeURIComponent(eventReferenceId)}&payer_email=ilike.${encodeURIComponent(email)}&refunded_at=is.null&mode=eq.live&select=id`,
    { headers: restHeaders() },
  );
  if (!res.ok) {
    throw new Error(`Supabase read from event_payments failed: ${res.status} ${await res.text()}`);
  }
  const rows = await res.json();
  return rows.length;
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

// Rows whose actual Razorpay fee hasn't been checked yet — the work list for
// scripts/reconcile-event-payment-fees.mjs. Only rows old enough that
// Razorpay has plausibly finished computing fee/tax (the script itself
// applies the age cutoff via `olderThanIso`, passed in rather than computed
// here so the cutoff logic — and its comment — lives in one place).
/**
 * @param {string} olderThanIso created_at cutoff — only rows paid before this are due
 * @returns {Promise<Array<{ id: string, razorpay_payment_id: string }>>}
 */
export async function listUnreconciledPayments(olderThanIso) {
  const res = await fetch(
    `${supabaseUrl()}/rest/v1/event_payments?fee_reconciled_at=is.null&created_at=lt.${encodeURIComponent(olderThanIso)}&mode=eq.live&select=id,razorpay_payment_id`,
    { headers: restHeaders() },
  );
  if (!res.ok) {
    throw new Error(`Supabase read from event_payments failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// Records the real fee+tax Razorpay charged for one payment, once
// GET /payments/:id actually has it — see scripts/reconcile-event-payment-fees.mjs.
// Fee is a sunk cost from the moment of capture regardless of what happens
// after (refunded or not, see the reconciliation-scenarios planning notes),
// so this is never re-checked or reverted once recorded.
/**
 * @param {string} id row id
 * @param {number} feeAmount paise (Razorpay's fee + tax combined)
 * @returns {Promise<void>}
 */
export async function recordFeeReconciled(id, feeAmount) {
  const res = await fetch(`${supabaseUrl()}/rest/v1/event_payments?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: restHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify({ fee_amount: feeAmount, fee_reconciled_at: new Date().toISOString() }),
  });
  if (!res.ok) {
    throw new Error(`Supabase update to event_payments failed: ${res.status} ${await res.text()}`);
  }
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

// Records that a refund has been *initiated* — called by
// event-payments-admin.mts right after a successful Razorpay API call, and
// by razorpay-webhook.mts's refund.created handler for refunds started
// directly in the Razorpay dashboard (where there's no admin-page moment to
// record it from at all). Deliberately does NOT set refunded_at — Razorpay
// is the source of truth for whether a refund actually completed, not our
// own synchronous API response or the mere existence of a refund object, so
// this only ever produces a "refund initiated" state until
// confirmRefundProcessed() below hears otherwise.
//
// Guarded on refund_initiated_at=is.null OR the row's last attempt having
// failed, so: whichever of the two callers reaches Supabase first wins for
// a *first* attempt (same idempotent-update shape as
// requestCancellationIfNew — normally our own admin-triggered POST, since
// it happens synchronously right after the Razorpay call succeeds, well
// before that same event reaches us again via webhook); and a *retried*
// attempt after event-payments-admin.mts's own failed-attempt check
// overwrites the stale failed attempt's fields with the new one's.
/**
 * @param {string} id row id
 * @param {{ razorpayRefundId: string, amount: number, status: string, refundedBy: string }} params
 * @returns {Promise<boolean>} true if this call is the one that recorded the initiation
 */
export async function recordRefundInitiated(id, { razorpayRefundId, amount, status, refundedBy }) {
  const res = await fetch(
    `${supabaseUrl()}/rest/v1/event_payments?id=eq.${id}&or=(refund_initiated_at.is.null,refund_status.eq.failed)`,
    {
      method: 'PATCH',
      headers: restHeaders({ Prefer: 'return=representation' }),
      body: JSON.stringify({
        razorpay_refund_id: razorpayRefundId,
        refund_amount: amount,
        refund_status: status,
        refund_initiated_at: new Date().toISOString(),
        refunded_by: refundedBy,
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`Supabase update to event_payments failed: ${res.status} ${await res.text()}`);
  }
  const rows = await res.json();
  return rows.length > 0;
}

// The only place refunded_at gets set — called from razorpay-webhook.mts's
// refund.processed handler, i.e. only once Razorpay itself confirms the
// refund actually completed. This is what the dashboard's "cancelled"/net-
// collected stats key off, not initiation.
//
// Guarded on razorpay_refund_id matching the specific refund that was
// confirmed (not just "this row has some refund recorded") and
// refunded_at=is.null, so a retried/duplicate webhook delivery is a no-op
// and a stale confirmation for an old, superseded refund attempt can't
// clobber a newer one.
/**
 * @param {string} id row id
 * @param {string} razorpayRefundId the specific refund (rfnd_xxx) that was confirmed
 * @param {string} status Razorpay's own status string, e.g. 'processed'
 * @returns {Promise<boolean>} true if this call is the one that confirmed the row
 */
export async function confirmRefundProcessed(id, razorpayRefundId, status) {
  const res = await fetch(
    `${supabaseUrl()}/rest/v1/event_payments?id=eq.${encodeURIComponent(id)}&razorpay_refund_id=eq.${encodeURIComponent(razorpayRefundId)}&refunded_at=is.null`,
    {
      method: 'PATCH',
      headers: restHeaders({ Prefer: 'return=representation' }),
      body: JSON.stringify({ refund_status: status, refunded_at: new Date().toISOString() }),
    },
  );
  if (!res.ok) {
    throw new Error(`Supabase update to event_payments failed: ${res.status} ${await res.text()}`);
  }
  const rows = await res.json();
  return rows.length > 0;
}

// Records that an initiated refund actually failed — refunded_at was never
// optimistically set (see recordRefundInitiated above), so there's nothing
// to revert, just refund_status to update so the row stops reading as
// "in progress" and the admin can retry.
//
// Same razorpay_refund_id + refunded_at=is.null guard as
// confirmRefundProcessed: only applies to the specific attempt that failed,
// and never touches a row whose refund already confirmed processed.
/**
 * @param {string} id row id
 * @param {string} razorpayRefundId the specific refund (rfnd_xxx) that failed
 * @returns {Promise<boolean>} true if this call is the one that recorded the failure
 */
export async function markRefundFailed(id, razorpayRefundId) {
  const res = await fetch(
    `${supabaseUrl()}/rest/v1/event_payments?id=eq.${encodeURIComponent(id)}&razorpay_refund_id=eq.${encodeURIComponent(razorpayRefundId)}&refunded_at=is.null`,
    {
      method: 'PATCH',
      headers: restHeaders({ Prefer: 'return=representation' }),
      body: JSON.stringify({ refund_status: 'failed' }),
    },
  );
  if (!res.ok) {
    throw new Error(`Supabase update to event_payments failed: ${res.status} ${await res.text()}`);
  }
  const rows = await res.json();
  return rows.length > 0;
}
