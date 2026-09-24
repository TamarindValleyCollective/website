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
  recordRefund,
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

// A row counts as cancelled once refunded_at is set — cancellation_
// requested_at alone (0019) only means a guest asked; see the 0020
// migration comment. "requested" surfaces a guest ask still waiting on an
// admin to act, distinct from a plain "paid" row with no request at all.
function statusFor(row: any): 'paid' | 'requested' | 'refunded' {
  if (row.refunded_at) return 'refunded';
  if (row.cancellation_requested_at) return 'requested';
  return 'paid';
}

async function handleBookings(url: URL): Promise<Response> {
  const eventReferenceId = url.searchParams.get('eventReferenceId')?.trim();
  if (!eventReferenceId) return jsonResponse({ error: 'eventReferenceId is required' }, 400);

  let rows: any[];
  try {
    rows = await listPaymentsForEvent(eventReferenceId);
  } catch (err) {
    console.error('Failed to list event_payments', err);
    return jsonResponse({ error: 'Failed to reach the payment store' }, 502);
  }

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
    cancellationRequestedAt: r.cancellation_requested_at,
    refundedAt: r.refunded_at,
    refundAmount: r.refund_amount,
    refundStatus: r.refund_status,
    refundedBy: r.refunded_by,
    status: statusFor(r),
  }));

  const grossCollected = rows.reduce((sum, r) => sum + r.amount, 0);
  const totalRefunded = rows.reduce((sum, r) => sum + (r.refunded_at ? (r.refund_amount ?? 0) : 0), 0);

  return jsonResponse({
    bookings,
    aggregates: {
      bookingCount: rows.length,
      totalAttendees: rows.reduce((sum, r) => sum + (r.attendee_count ?? 1), 0),
      grossCollected,
      totalRefunded,
      netCollected: grossCollected - totalRefunded,
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
  <p>We've issued a refund of <strong>${formatAmount(params.refundAmount, params.currency)}</strong> for your booking for <strong>${params.eventTitle}</strong> (payment ${params.paymentId}).</p>
  <p>It should reach your original payment method within a few business days, per Razorpay's usual refund timelines.</p>
  <p>Questions? Reply to this email or reach us at <a href="mailto:core-team@tvc.farm">core-team@tvc.farm</a>.</p>
</body></html>`;
  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: FROM,
      to: [params.payerEmail],
      cc: NOTIFY_CC,
      subject: `Refund issued — ${params.eventTitle}`,
      html,
    }),
  });
  if (!res.ok) {
    throw new Error(`Resend send failed: ${res.status} ${await res.text()}`);
  }
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
  if (amount > row.amount) {
    return jsonResponse({ error: 'Refund amount cannot exceed the amount paid' }, 400);
  }

  let refund;
  try {
    refund = await createRefund({
      paymentId: row.razorpay_payment_id,
      amount,
      notes: { refundedBy: adminEmail, ...(reason ? { reason } : {}) },
    });
  } catch (err) {
    console.error('Failed to create Razorpay refund', err);
    return jsonResponse({ error: 'Razorpay rejected the refund — no money has moved' }, 502);
  }

  // The refund is real at this point — a failure past here only affects our
  // own records/notifications, so it's logged rather than surfaced as if
  // the refund itself failed (same asymmetry as whatsapp-admin.mts's
  // Meta-succeeded-but-local-write-failed handling).
  try {
    await recordRefund(id, {
      razorpayRefundId: refund.id,
      amount: refund.amount,
      status: refund.status,
      refundedBy: adminEmail,
    });
  } catch (err) {
    console.error('Refund succeeded on Razorpay but failed to record locally', err);
  }

  if (!row.cancellation_requested_at) {
    requestCancellationIfNew(id).catch((err) => console.error('Failed to backfill cancellation_requested_at', err));
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

  return jsonResponse({ ok: true, refund: { id: refund.id, amount: refund.amount, status: refund.status } });
}

export default async (req: Request): Promise<Response> => {
  const auth = await authenticate(req);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);

  const url = new URL(req.url);

  if (url.pathname === '/api/event-payments-admin/bookings' && req.method === 'GET') return handleBookings(url);
  if (url.pathname === '/api/event-payments-admin/refund' && req.method === 'POST') return handleRefund(req, auth.email);

  return jsonResponse({ error: 'Not found' }, 404);
};

export const config = {
  path: ['/api/event-payments-admin/bookings', '/api/event-payments-admin/refund'],
};
