// Internal "a refund didn't go through" alert — goes to TVC's shared inbox
// and Linger only, never the guest (the guest-facing refund emails live in
// event-payments-admin.mts). Used for the three ways a refund can fail:
// Razorpay rejecting the API call (e.g. insufficient balance), and the
// async refund.failed webhook. A bulk "Cancel event" sends ONE alert listing
// every failure rather than one per booking.

import { routeEmail } from './email-routing';
import { EMAIL_COLORS, escapeHtml, formatAmount, renderStaffEmail } from './email-layout';

const RESEND_API_URL = 'https://api.resend.com/emails';
const FROM = 'Tamarind Valley Collective <noreply@tvc.farm>';
const ALERT_TO = ['core-team@tvc.farm'];
const ALERT_CC = ['stay@linger.in'];

export interface RefundFailure {
  eventTitle: string;
  payerName: string | null;
  attendeeCount: number;
  paidAmount: number; // paise
  currency: string;
  paymentId: string;
  isTest?: boolean;
  // Razorpay's own message when the API call was rejected; absent for the
  // async refund.failed webhook, which carries no reason.
  error?: string;
}

export { escapeHtml, formatAmount };

export async function sendRefundFailureAlert(failures: RefundFailure[], context: { bulk: boolean; succeeded?: number }): Promise<void> {
  if (failures.length === 0) return;
  const items = failures
    .map(
      (f) => `<li style="margin-bottom:10px;">
        <strong>${escapeHtml(f.payerName ?? 'Unknown guest')}</strong> — ${escapeHtml(f.eventTitle)}, ${f.attendeeCount} ${f.attendeeCount === 1 ? 'person' : 'people'}, paid ${formatAmount(f.paidAmount, f.currency)}<br>
        <span style="font-family:ui-monospace,monospace; font-size:12px;">${escapeHtml(f.paymentId)}</span><br>
        <span style="color:${EMAIL_COLORS.danger};">${escapeHtml(f.error ?? 'Razorpay reported the refund as failed after accepting it.')}</span>
      </li>`,
    )
    .join('');
  const intro = context.bulk
    ? `<p>${failures.length} refund${failures.length === 1 ? '' : 's'} failed during the event cancellation${context.succeeded !== undefined ? ` (${context.succeeded} succeeded)` : ''}. No money has moved for the bookings below, and these guests have <strong>not</strong> been emailed — the others in the batch have, so please sort these out soon.</p>`
    : failures[0].error
      ? `<p>Razorpay rejected a refund, so no money has moved. The guest has not been emailed.</p>`
      : `<p>Razorpay accepted a refund and then reported it as failed. The guest was already told it was initiated, so they'll be waiting on it.</p>`;
  const html = `${intro}
  <ul style="padding-left:18px;">${items}</ul>
  <p style="margin-bottom:0;">Common fix for "insufficient balance": top up the Razorpay account balance, then retry from <a href="https://tvc.farm/internal/event-payments">the Event Payments dashboard</a> (for a full-event cancellation, run "Cancel event" again — it only retries bookings that aren't already refunded).</p>`;

  await sendStaffAlert(`⚠️ ${failures.length} refund${failures.length === 1 ? '' : 's'} failed — ${failures[0].eventTitle}`, html, failures.every((f) => f.isTest));
}

// Internal alert to TVC's shared inbox + Linger — never the guest. `bodyHtml`
// is just the inner content; it's wrapped in the branded staff shell here. Also used
// for non-refund "someone needs to act" alerts (guest cancellation requests,
// a payment that landed after an event was cancelled).
export async function sendStaffAlert(subject: string, bodyHtml: string, isTest = false): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('[refund-alert] RESEND_API_KEY is not set — cannot send staff alert');
    return;
  }
  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: FROM, html: renderStaffEmail(bodyHtml), ...routeEmail(isTest, { to: ALERT_TO, cc: ALERT_CC, subject }) }),
  });
  if (!res.ok) {
    throw new Error(`Resend send failed: ${res.status} ${await res.text()}`);
  }
}

export function failureFromRow(row: any, error?: string): RefundFailure {
  return {
    eventTitle: row.event_title,
    payerName: row.payer_name ?? null,
    attendeeCount: row.attendee_count,
    paidAmount: row.amount,
    currency: row.currency,
    paymentId: row.razorpay_payment_id,
    isTest: row.mode === 'test',
    error,
  };
}
