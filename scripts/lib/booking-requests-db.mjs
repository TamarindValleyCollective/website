// Data-access layer for event_booking_requests (see
// supabase/migrations/0038_event_booking_requests.sql). Same hand-rolled
// PostgREST style as event-payments-db.mjs.
import { createHash, randomBytes } from 'node:crypto';
import { restHeaders } from './supabase.mjs';

function supabaseUrl() {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error('Missing SUPABASE_URL');
  return url;
}

/**
 * @typedef {{ id: string, event_reference_id: string, event_title: string, event_date: string | null, name: string, email: string, phone: string, attendee_count: number, whatsapp_opt_in: boolean, status: 'pending' | 'approved' | 'declined', payment_link_id: string | null, payment_link_url: string | null, payment_link_sent_at: string | null }} BookingRequestRow
 */

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * @param {{ eventReferenceId: string, eventTitle: string, eventDate?: string | null, name: string, email: string, phone: string, attendeeCount: number, whatsappOptIn: boolean }} params
 * @returns {Promise<{ request: BookingRequestRow, token: string }>} token goes in the approve link; only its hash is stored
 */
export async function createBookingRequest(params) {
  const token = randomBytes(32).toString('hex');
  const res = await fetch(`${supabaseUrl()}/rest/v1/event_booking_requests`, {
    method: 'POST',
    headers: restHeaders({ Prefer: 'return=representation' }),
    body: JSON.stringify([
      {
        event_reference_id: params.eventReferenceId,
        event_title: params.eventTitle,
        event_date: params.eventDate ?? null,
        name: params.name,
        email: params.email,
        phone: params.phone,
        attendee_count: params.attendeeCount,
        whatsapp_opt_in: params.whatsappOptIn,
        approval_token_hash: hashToken(token),
      },
    ]),
  });
  if (!res.ok) throw new Error(`Supabase insert into event_booking_requests failed: ${res.status} ${await res.text()}`);
  const [row] = await res.json();
  return { request: row, token };
}

// A still-pending request for this (event, email), so a double-click or a
// resubmit doesn't page Linger twice. Compared in JS for the same wildcard
// reason as countActivePaymentsForEmail in event-payments-db.mjs.
/** @returns {Promise<boolean>} */
export async function hasPendingRequest(eventReferenceId, email) {
  const res = await fetch(
    `${supabaseUrl()}/rest/v1/event_booking_requests?event_reference_id=eq.${encodeURIComponent(eventReferenceId)}&status=eq.pending&select=email`,
    { headers: restHeaders() },
  );
  if (!res.ok) throw new Error(`Supabase read from event_booking_requests failed: ${res.status} ${await res.text()}`);
  const target = email.toLowerCase();
  return (await res.json()).some((r) => String(r.email ?? '').toLowerCase() === target);
}

/** @returns {Promise<BookingRequestRow | null>} */
export async function getRequestByToken(token) {
  const res = await fetch(
    `${supabaseUrl()}/rest/v1/event_booking_requests?approval_token_hash=eq.${hashToken(token)}&select=*`,
    { headers: restHeaders() },
  );
  if (!res.ok) throw new Error(`Supabase read from event_booking_requests failed: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  return rows[0] ?? null;
}

// Moves pending -> approved/declined exactly once: the status=eq.pending
// filter makes a double-click, or two Linger staff tapping at once, a no-op
// for the second caller (returns null), so only one payment link is minted.
/**
 * @param {string} id
 * @param {'approved' | 'declined'} status
 * @param {string | null} [note]
 * @returns {Promise<BookingRequestRow | null>} the updated row, or null if it was no longer pending
 */
export async function claimDecision(id, status, note) {
  const res = await fetch(`${supabaseUrl()}/rest/v1/event_booking_requests?id=eq.${id}&status=eq.pending`, {
    method: 'PATCH',
    headers: restHeaders({ Prefer: 'return=representation' }),
    body: JSON.stringify({ status, decided_at: new Date().toISOString(), decision_note: note ?? null }),
  });
  if (!res.ok) throw new Error(`Supabase update of event_booking_requests failed: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  return rows[0] ?? null;
}

// Puts a claimed request back to pending when the payment link couldn't be
// created, so admins can tap Approve again instead of the request being stuck.
export async function releaseDecision(id) {
  const res = await fetch(`${supabaseUrl()}/rest/v1/event_booking_requests?id=eq.${id}`, {
    method: 'PATCH',
    headers: restHeaders(),
    body: JSON.stringify({ status: 'pending', decided_at: null, decision_note: null }),
  });
  if (!res.ok) throw new Error(`Supabase release of event_booking_requests failed: ${res.status} ${await res.text()}`);
}

export async function recordPaymentLink(id, { linkId, linkUrl, sent }) {
  const res = await fetch(`${supabaseUrl()}/rest/v1/event_booking_requests?id=eq.${id}`, {
    method: 'PATCH',
    headers: restHeaders(),
    body: JSON.stringify({
      payment_link_id: linkId,
      payment_link_url: linkUrl,
      payment_link_sent_at: sent ? new Date().toISOString() : null,
    }),
  });
  if (!res.ok) throw new Error(`Supabase update of event_booking_requests failed: ${res.status} ${await res.text()}`);
}
