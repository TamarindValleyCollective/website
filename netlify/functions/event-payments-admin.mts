// Netlify Function (v2 API) backing the internal event-payments dashboard
// (src/pages/internal/event-payments.astro) — per-event registrations/
// cancellations/money-collected, plus the ability to actually trigger a
// cancellation refund through Razorpay's API (see RAZORPAY.md's "Event
// payment tracking" section). Lists come from event_payments
// (scripts/lib/event-payments-db.mjs, TVC ERP Supabase project); refunds go
// straight to Razorpay's REST API (netlify/functions/lib/razorpay.ts) —
// their MCP server has no refund-creation tool, only fetch/list ones.
//
// Auth follows the exact pattern whatsapp-admin.mts/accommodation-admin.mts
// already established: Google Sign-In client-side, this Function verifies
// the ID token itself (google-id-token.mjs) against the same "core team"
// allow-list photo-pool.mts/whatsapp-admin.mts use
// (PHOTO_POOL_ALLOWED_EMAILS_SHEET_ID) — reused rather than standing up a
// third Sheet, since real money movement is at least as sensitive as
// WhatsApp/photo access and belongs to the same staff bracket.
import {
  listPaymentsForEvent,
  getPaymentById,
  recordRefundInitiated,
  requestCancellationIfNew,
} from '../../scripts/lib/event-payments-db.mjs';
import { createRefund } from './lib/razorpay';
import { getAllowedEmails } from '../../scripts/lib/google-drive.mjs';
import { verifyGoogleIdToken } from '../../scripts/lib/google-id-token.mjs';

const RESEND_API_URL = 'https://api.resend.com/emails';
const FROM = 'Tamarind Valley Collective <noreply@tvc.farm>';
const NOTIFY_CC = ['core-team@tvc.farm', 'stay@linger.in'];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function formatAmount(amountPaise: number, currency: string): string {
  const amount = amountPaise / 100;
  return currency === 'INR' ? `₹${amount.toLocaleString('en-IN')}` : `${amount.toLocaleString('en-IN')} ${currency}`;
}

type AuthResult = { ok: true; email: string } | { ok: false; status: 401 | 403 | 500; error: string };

// Same short-cache rationale as whatsapp-admin.mts/photo-pool.mts: an admin
// adding a row to the allow-list Sheet takes effect almost immediately,
// without hitting the Sheets API on every poll.
const ALLOWED_EMAILS_TTL_MS = 2 * 60 * 1000;
let cachedAllowedEmails: { emails: string[]; expiresAt: number } | null = null;

async function getCachedAllowedEmails(): Promise<string[]> {
  if (cachedAllowedEmails && cachedAllowedEmails.expiresAt > Date.now()) {
    return cachedAllowedEmails.emails;
  }
  const sheetId = process.env.PHOTO_POOL_ALLOWED_EMAILS_SHEET_ID;
  if (!sheetId) throw new Error('Missing PHOTO_POOL_ALLOWED_EMAILS_SHEET_ID');
  const emails = await getAllowedEmails(sheetId);
  cachedAllowedEmails = { emails, expiresAt: Date.now() + ALLOWED_EMAILS_TTL_MS };
  return emails;
}

async function authenticate(req: Request): Promise<AuthResult> {
  const authHeader = req.headers.get('authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return { ok: false, status: 401, error: 'Sign-in required' };

  const clientId = process.env.PUBLIC_GOOGLE_CLIENT_ID;
  if (!clientId) {
    console.error('Missing PUBLIC_GOOGLE_CLIENT_ID');
    return { ok: false, status: 500, error: 'Server misconfigured' };
  }

  let email: string;
  try {
    const payload = await verifyGoogleIdToken(token, { audience: clientId });
    email = String(payload.email).toLowerCase();
  } catch (err) {
    console.error('ID token verification failed', err);
    return { ok: false, status: 401, error: 'Invalid or expired session' };
  }

  try {
    const allowed = await getCachedAllowedEmails();
    if (!allowed.includes(email)) {
      return { ok: false, status: 403, error: 'This Google account is not authorized to view event payments' };
    }
  } catch (err) {
    console.error('Failed to check the staff allow-list', err);
    return { ok: false, status: 500, error: 'Server misconfigured' };
  }

  return { ok: true, email };
}

// Razorpay is the source of truth for whether a refund actually completed —
// refunded_at is only ever set by razorpay-webhook.mts's refund.processed
// handler (confirmRefundProcessed), never by initiation itself. A row counts
// as cancelled/refunded once that's set; "requested" surfaces a guest ask
// still waiting on an admin to act, distinct from a plain "paid" row with no
// request at all. See the 0020/0022 migration comments.
function statusFor(row: any): 'paid' | 'requested' | 'refund_initiated' | 'refund_failed' | 'refunded' {
  if (row.refunded_at) return 'refunded';
  if (row.refund_status === 'failed') return 'refund_failed';
  if (row.refund_initiated_at) return 'refund_initiated';
  if (row.cancellation_requested_at) return 'requested';
  return 'paid';
}

// `mode` is set at webhook time (razorpay-webhook.mts) from whichever
// Razorpay key actually processed the payment — deterministic, not a guess.
// A row with no mode recorded (shouldn't happen post-migration 0021, but
// defensive against any gap) is treated as real rather than hidden: showing
// an uncertain row is a smaller mistake than hiding a real registration.
function isTestPayment(row: any): boolean {
  return row.mode === 'test';
}

async function handleBookings(url: URL): Promise<Response> {
  const eventReferenceId = url.searchParams.get('eventReferenceId')?.trim();
  if (!eventReferenceId) return jsonResponse({ error: 'eventReferenceId is required' }, 400);
  const includeTest = url.searchParams.get('includeTest') === '1';

  let allRows: any[];
  try {
    allRows = await listPaymentsForEvent(eventReferenceId);
  } catch (err) {
    console.error('Failed to list event_payments', err);
    return jsonResponse({ error: 'Failed to reach the payment store' }, 502);
  }

  const testPaymentCount = allRows.filter(isTestPayment).length;
  const rows = includeTest ? allRows : allRows.filter((r) => !isTestPayment(r));

  // Flags rows sharing a payer_email with another still-live (non-refunded)
  // row in this same event — surfaces a guest who ended up with two paid
  // bookings (accidental resubmit, or a real "I paid but nothing happened"
  // retry) directly in the table instead of only being discoverable by
  // opening every row and comparing emails by eye. Not itself a merge
  // action — the remedy is the existing per-row refund flow, on whichever of
  // the flagged rows the admin decides shouldn't stand.
  const liveEmailCounts = new Map<string, number>();
  for (const r of rows) {
    if (!r.payer_email || r.refunded_at) continue;
    const key = String(r.payer_email).toLowerCase();
    liveEmailCounts.set(key, (liveEmailCounts.get(key) ?? 0) + 1);
  }
  const isDuplicate = (r: any) => Boolean(r.payer_email) && !r.refunded_at && (liveEmailCounts.get(String(r.payer_email).toLowerCase()) ?? 0) > 1;

  const bookings = rows.map((r) => ({
    id: r.id,
    razorpayPaymentId: r.razorpay_payment_id,
    payerName: r.payer_name,
    payerEmail: r.payer_email,
    payerContact: r.payer_contact,
    attendeeCount: r.attendee_count,
    amount: r.amount,
    currency: r.currency,
    createdAt: r.created_at,
    eventDate: r.event_date,
    cancellationRequestedAt: r.cancellation_requested_at,
    refundInitiatedAt: r.refund_initiated_at,
    refundedAt: r.refunded_at,
    refundAmount: r.refund_amount,
    refundStatus: r.refund_status,
    refundedBy: r.refunded_by,
    status: statusFor(r),
    isTest: isTestPayment(r),
    isDuplicate: isDuplicate(r),
    paymentMethod: r.payment_method,
    feeAmount: r.fee_amount,
  }));

  const grossCollected = rows.reduce((sum, r) => sum + r.amount, 0);
  const totalRefunded = rows.reduce((sum, r) => sum + (r.refunded_at ? (r.refund_amount ?? 0) : 0), 0);
  // Razorpay's fee is a sunk cost from the moment of capture — charged
  // regardless of whether the booking later got refunded (see
  // supabase/migrations/0024_event_payments_fees.sql) — so every row with a
  // known fee_amount counts here, not just still-live ones.
  const totalFees = rows.reduce((sum, r) => sum + (r.fee_amount ?? 0), 0);
  const unreconciledFeeCount = rows.filter((r) => r.fee_amount == null).length;

  return jsonResponse({
    bookings,
    testPaymentCount,
    aggregates: {
      bookingCount: rows.length,
      totalAttendees: rows.reduce((sum, r) => sum + (r.attendee_count ?? 1), 0),
      grossCollected,
      totalRefunded,
      totalFees,
      // Provisionally high for any row whose fee_amount is still null (see
      // scripts/reconcile-event-payment-fees.mjs) rather than guessing a
      // percentage — unreconciledFeeCount below is what tells the dashboard
      // (and the admin reading it) that this number isn't final yet.
      netCollected: grossCollected - totalRefunded - totalFees,
      unreconciledFeeCount,
      cancelledCount: rows.filter((r) => r.refunded_at).length,
      pendingRequestCount: rows.filter((r) => r.cancellation_requested_at && !r.refunded_at).length,
    },
  });
}

async function sendRefundEmail(params: {
  payerEmail: string;
  eventTitle: string;
  refundAmount: number;
  currency: string;
  paymentId: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('[event-payments-admin] RESEND_API_KEY is not set — cannot send refund notification');
    return;
  }
  const html = `<!doctype html>
<html><head><meta charset="utf-8" /></head>
<body style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:#22291f;">
  <p>We've started a refund of <strong>${formatAmount(params.refundAmount, params.currency)}</strong> for your booking for <strong>${params.eventTitle}</strong> (payment ${params.paymentId}).</p>
  <p>It's being processed by Razorpay now and should reach your original payment method within a few business days.</p>
  <p>Questions? Reply to this email or reach us at <a href="mailto:core-team@tvc.farm">core-team@tvc.farm</a>.</p>
</body></html>`;
  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: FROM,
      to: [params.payerEmail],
      cc: NOTIFY_CC,
      subject: `Refund initiated — ${params.eventTitle}`,
      html,
    }),
  });
  if (!res.ok) {
    throw new Error(`Resend send failed: ${res.status} ${await res.text()}`);
  }
}

// The actual work of refunding one already-looked-up row — shared by
// handleRefund (one booking, from the per-row form) and handleBulkRefund
// (every eligible booking in an event, from the "cancel entire event"
// action). Validation of *which* row is eligible and *how much* to refund
// happens in each caller, since the two have different rules (a single
// admin-typed override vs. a uniform fraction applied across many rows).
async function refundOneBooking(row: any, amount: number, adminEmail: string, reason: string | undefined): Promise<{ ok: true; refund: { id: string; amount: number; status: string } } | { ok: false; error: string }> {
  let refund;
  try {
    refund = await createRefund({
      paymentId: row.razorpay_payment_id,
      amount,
      notes: { refundedBy: adminEmail, ...(reason ? { reason } : {}) },
    });
  } catch (err) {
    console.error('Failed to create Razorpay refund', err);
    // createRefund() throws Razorpay's own human-readable `error.description`
    // when the response has that shape (e.g. "Your account does not have
    // enough balance to carry out the refund operation...", hit for real
    // 2026-09-25 refunding a pre-settlement payment) — surface that instead
    // of a generic message, so the admin knows *why* and what to do about
    // it, not just that money didn't move.
    const reason = err instanceof Error ? err.message : 'Unknown error';
    return { ok: false, error: `Razorpay rejected the refund — no money has moved. ${reason}` };
  }

  // The refund is real at this point — a failure past here only affects our
  // own records/notifications, so it's logged rather than surfaced as if
  // the refund itself failed (same asymmetry as whatsapp-admin.mts's
  // Meta-succeeded-but-local-write-failed handling). This only ever records
  // *initiation* — refunded_at gets set later, by razorpay-webhook.mts's
  // refund.processed handler, once Razorpay itself confirms completion.
  try {
    await recordRefundInitiated(row.id, {
      razorpayRefundId: refund.id,
      amount: refund.amount,
      status: refund.status,
      refundedBy: adminEmail,
    });
  } catch (err) {
    console.error('Refund succeeded on Razorpay but failed to record locally', err);
  }

  if (!row.cancellation_requested_at) {
    requestCancellationIfNew(row.id).catch((err) => console.error('Failed to backfill cancellation_requested_at', err));
  }

  if (row.payer_email) {
    try {
      await sendRefundEmail({
        payerEmail: row.payer_email,
        eventTitle: row.event_title,
        refundAmount: refund.amount,
        currency: row.currency,
        paymentId: row.razorpay_payment_id,
      });
    } catch (err) {
      console.error('Refund succeeded but failed to send notification email', err);
    }
  }

  return { ok: true, refund: { id: refund.id, amount: refund.amount, status: refund.status } };
}

async function handleRefund(req: Request, adminEmail: string): Promise<Response> {
  let body: { id?: string; amount?: number; reason?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }

  const id = (body.id ?? '').trim();
  const amount = Math.trunc(Number(body.amount));
  const reason = body.reason?.trim() || undefined;
  if (!id) return jsonResponse({ error: 'id is required' }, 400);
  if (!Number.isFinite(amount) || amount <= 0) {
    return jsonResponse({ error: 'amount must be a positive number of paise' }, 400);
  }

  let row: any;
  try {
    row = await getPaymentById(id);
  } catch (err) {
    console.error('Failed to look up event_payments row', err);
    return jsonResponse({ error: 'Failed to reach the payment store' }, 502);
  }
  if (!row) return jsonResponse({ error: 'Booking not found' }, 404);
  if (row.refunded_at) return jsonResponse({ error: 'This booking has already been refunded' }, 409);
  // A previously *failed* attempt can be retried (refund_status === 'failed'
  // with refunded_at still null) — anything else with an initiation on
  // record (pending/created, not yet confirmed either way) is still in
  // flight and shouldn't get a second, concurrent refund started against it.
  if (row.refund_initiated_at && row.refund_status !== 'failed') {
    return jsonResponse({ error: 'A refund is already in progress for this booking' }, 409);
  }
  if (amount > row.amount) {
    return jsonResponse({ error: 'Refund amount cannot exceed the amount paid' }, 400);
  }

  const outcome = await refundOneBooking(row, amount, adminEmail, reason);
  if (!outcome.ok) return jsonResponse({ error: outcome.error }, 502);
  return jsonResponse({ ok: true, refund: outcome.refund });
}

// Refunds every still-eligible booking for one event in a single admin
// action — a full-event cancellation (weather, low turnout) otherwise means
// working through the per-row refund form once per booking. `fraction`
// applies uniformly (e.g. 1 = full refund for everyone, the fair default
// when the cancellation is TVC's call rather than a guest's, so the
// day-before-event tiers in /refund-policy don't apply) — there's no
// per-row override here, unlike the single-booking flow's admin-editable
// amount; splitting that finely for a mass cancellation isn't worth the
// added review-step complexity. Runs sequentially against Razorpay's API
// (not in parallel) to keep failures isolated to the row that hit them
// rather than one one failure taking down a Promise.all batch.
async function handleBulkRefund(req: Request, adminEmail: string): Promise<Response> {
  let body: { eventReferenceId?: string; fraction?: number; reason?: string; includeTest?: boolean };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }

  const eventReferenceId = (body.eventReferenceId ?? '').trim();
  const fraction = Number(body.fraction);
  const reason = body.reason?.trim() || undefined;
  const includeTest = Boolean(body.includeTest);
  if (!eventReferenceId) return jsonResponse({ error: 'eventReferenceId is required' }, 400);
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) {
    return jsonResponse({ error: 'fraction must be greater than 0 and at most 1' }, 400);
  }

  let allRows: any[];
  try {
    allRows = await listPaymentsForEvent(eventReferenceId);
  } catch (err) {
    console.error('Failed to list event_payments', err);
    return jsonResponse({ error: 'Failed to reach the payment store' }, 502);
  }

  // Same eligibility as a single refund would require row-by-row: not
  // already refunded, and not already mid-flight on a still-live attempt
  // (a previously *failed* one is fair game to retry here too).
  const eligible = allRows.filter((r) => !r.refunded_at && (!r.refund_initiated_at || r.refund_status === 'failed') && (includeTest || r.mode !== 'test'));

  const results: Array<{ id: string; ok: boolean; error?: string }> = [];
  for (const row of eligible) {
    const amount = Math.round(row.amount * fraction);
    if (amount <= 0) {
      results.push({ id: row.id, ok: false, error: 'Computed refund amount is zero' });
      continue;
    }
    const outcome = await refundOneBooking(row, amount, adminEmail, reason);
    results.push(outcome.ok ? { id: row.id, ok: true } : { id: row.id, ok: false, error: outcome.error });
  }

  return jsonResponse({
    ok: true,
    attempted: eligible.length,
    succeeded: results.filter((r) => r.ok).length,
    results,
  });
}

export default async (req: Request): Promise<Response> => {
  const auth = await authenticate(req);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);

  const url = new URL(req.url);

  if (url.pathname === '/api/event-payments-admin/bookings' && req.method === 'GET') return handleBookings(url);
  if (url.pathname === '/api/event-payments-admin/refund' && req.method === 'POST') return handleRefund(req, auth.email);
  if (url.pathname === '/api/event-payments-admin/bulk-refund' && req.method === 'POST') return handleBulkRefund(req, auth.email);

  return jsonResponse({ error: 'Not found' }, 404);
};

export const config = {
  path: ['/api/event-payments-admin/bookings', '/api/event-payments-admin/refund', '/api/event-payments-admin/bulk-refund'],
};
