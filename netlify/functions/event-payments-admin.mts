// Netlify Function (v2 API) backing the internal event-payments dashboard
// (src/pages/internal/event-payments.astro) — per-event registrations/
// cancellations/money-collected, plus the ability to actually trigger a
// cancellation refund through Razorpay's API (see RAZORPAY.md's "Event
// payment tracking" section). Lists come from event_payments
// (scripts/lib/event-payments-db.mjs, TVC ERP Supabase project); refunds go
// straight to Razorpay's REST API (netlify/functions/lib/razorpay.ts) —
// their MCP server has no refund-creation tool, only fetch/list ones.
//
// Auth: Google Sign-In client-side; requireStaff (lib/staff-access.ts)
// verifies the ID token and checks the caller's role in the "event-payments"
// module — `view` to read bookings, `refund` (admin only) to move money.
// Migrated 2026-10 from the shared "core team" Sheet allow-list.
//
// Privacy: a payer's email and phone number never leave this Function (the
// page sees only whether each is on file); refunds and the refund email look
// them up server-side. The payer's name is masked for read-only roles. The
// staff member is recorded by id, not email, in `refunded_by` and in the
// notes sent to Razorpay. Every refund is audit-logged before any money moves.
import {
  listPaymentsForEvent,
  getPaymentById,
  recordRefundInitiated,
  requestCancellationIfNew,
  declineCancellationRequest,
  confirmRefundProcessed,
} from '../../scripts/lib/event-payments-db.mjs';
import { createRefund, fetchBasePaymentLink, cancelPaymentLink } from './lib/razorpay';
import { sendRefundFailureAlert, failureFromRow } from './lib/refund-alert';
import { routeEmail } from './lib/email-routing';
import { sendRefundCompletedEmail } from './lib/refund-completed-email';
import { sendWhatsAppTemplate, cleanTemplateParam, firstNameOf, asSentence } from './lib/whatsapp-send';
import { requireStaff, logStaffAction, type StaffGrant } from './lib/staff-access';
import { canSeeNames, maskName } from './lib/staff-masking';
import { roleHasCapability, type Capability } from './lib/staff-registry';

const RESEND_API_URL = 'https://api.resend.com/emails';
const FROM = 'Tamarind Valley Collective <noreply@tvc.farm>';
const NOTIFY_CC = ['core-team@tvc.farm', 'stay@linger.in'];

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function formatAmount(amountPaise: number, currency: string): string {
  const amount = amountPaise / 100;
  return currency === 'INR' ? `₹${amount.toLocaleString('en-IN')}` : `${amount.toLocaleString('en-IN')} ${currency}`;
}

// Razorpay is the source of truth for whether a refund actually completed —
// refunded_at is only ever set by razorpay-webhook.mts's refund.processed
// handler (confirmRefundProcessed), never by initiation itself. A row counts
// as cancelled/refunded once that's set; "requested" surfaces a guest ask
// still waiting on an admin to act, distinct from a plain "paid" row with no
// request at all. See the 0020/0022 migration comments.
function statusFor(row: any): 'paid' | 'requested' | 'declined' | 'refund_initiated' | 'refund_failed' | 'refunded' {
  if (row.refunded_at) return 'refunded';
  if (row.refund_status === 'failed') return 'refund_failed';
  if (row.refund_initiated_at) return 'refund_initiated';
  if (row.cancellation_declined_at) return 'declined';
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

type Mode = 'live' | 'test';

// The page shows exactly one mode at a time and every action acts only on
// that mode's rows — test and real bookings are never mixed. An unknown or
// missing value is 'live', the safe default.
function parseMode(value: unknown): Mode {
  return value === 'test' ? 'test' : 'live';
}

// Which Razorpay keys THIS server is running with. A test booking can only be
// refunded with test keys (and a live one with live keys), so an action on
// the other mode is refused up front with a clear message rather than
// failing row by row at Razorpay. In practice: test bookings are simulated
// by running locally with test keys, against the same database.
function serverMode(): Mode {
  return process.env.RAZORPAY_KEY_ID?.startsWith('rzp_test_') ? 'test' : 'live';
}

function modeMismatchError(mode: Mode): string {
  return mode === 'test'
    ? 'This server is using live Razorpay keys, so test bookings can’t be refunded here — nothing has changed. Run the dashboard locally with test keys (netlify dev) to simulate refunds.'
    : 'This server is using test Razorpay keys, so live bookings can’t be refunded here — nothing has changed.';
}

async function handleBookings(url: URL, staff: StaffGrant): Promise<Response> {
  const eventReferenceId = url.searchParams.get('eventReferenceId')?.trim();
  if (!eventReferenceId) return jsonResponse({ error: 'eventReferenceId is required' }, 400);
  const mode = parseMode(url.searchParams.get('mode'));

  let allRows: any[];
  try {
    allRows = await listPaymentsForEvent(eventReferenceId);
  } catch (err) {
    console.error('Failed to list event_payments', err);
    return jsonResponse({ error: 'Failed to reach the payment store' }, 502);
  }

  const testPaymentCount = allRows.filter(isTestPayment).length;
  const livePaymentCount = allRows.length - testPaymentCount;
  const rows = allRows.filter((r) => isTestPayment(r) === (mode === 'test'));

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

  const namesVisible = canSeeNames(staff.role);
  const bookings = rows.map((r) => ({
    id: r.id,
    razorpayPaymentId: r.razorpay_payment_id,
    // Name (masked for read-only roles) or an opaque "Payer XXXX". The
    // email and phone are never sent — only whether each is on file.
    payerLabel: r.payer_name
      ? namesVisible
        ? r.payer_name
        : maskName(r.payer_name)
      : `Payer ${String(r.id).slice(0, 4).toUpperCase()}`,
    hasEmail: Boolean(r.payer_email),
    hasPhone: Boolean(r.payer_contact),
    attendeeCount: r.attendee_count,
    amount: r.amount,
    currency: r.currency,
    createdAt: r.created_at,
    eventDate: r.event_date,
    cancellationRequestedAt: r.cancellation_requested_at,
    cancellationDeclinedAt: r.cancellation_declined_at,
    refundInitiatedAt: r.refund_initiated_at,
    refundedAt: r.refunded_at,
    refundAmount: r.refund_amount,
    refundStatus: r.refund_status,
    status: statusFor(r),
    isTest: isTestPayment(r),
    isDuplicate: isDuplicate(r),
    paymentMethod: r.payment_method,
    feeAmount: r.fee_amount,
    feeTax: r.fee_tax,
    refundFee: r.refund_fee,
    settlementId: r.settlement_id,
    settledAt: r.settled_at,
    refundSettledAt: r.refund_settled_at,
  }));

  const sum = (pick: (r: any) => number) => rows.reduce((total, r) => total + pick(r), 0);
  const grossCollected = sum((r) => r.amount);
  const totalRefunded = sum((r) => (r.refunded_at ? (r.refund_amount ?? 0) : 0));
  // Razorpay's fee is a sunk cost from the moment of capture — charged
  // regardless of whether the booking later got refunded, even when the
  // refund lands before the payment's settlement cycle (confirmed on the
  // first live refund, see supabase/migrations/0027_event_payments_fee_tax_settlement.sql)
  // — so every row with a known fee_amount counts here, not just still-live
  // ones. fee_amount already includes GST; fee_tax is the GST portion of it.
  const totalFees = sum((r) => r.fee_amount ?? 0);
  const totalFeeTax = sum((r) => r.fee_tax ?? 0);
  // What cancellations cost TVC on top of the refund itself: the MDR on
  // payments that were later refunded, which TVC absorbs rather than
  // deducting from the guest's refund by default.
  const feesOnRefunded = sum((r) => (r.refunded_at ? (r.fee_amount ?? 0) : 0));
  // Razorpay's charge for the refund itself — zero for normal-speed refunds,
  // non-zero for instant ones. Only known once the refund has settled.
  const totalRefundFees = sum((r) => r.refund_fee ?? 0);
  const unreconciledFeeCount = rows.filter((r) => r.fee_amount == null).length;

  // TVC absorbs MDR rather than passing it on, and the rate differs by
  // payment method — so the dashboard tallies fees per method, with the
  // effective rate computed only over payments whose fee is actually known.
  const methods = new Map<string, { method: string; count: number; gross: number; reconciledGross: number; fees: number; feeTax: number }>();
  for (const r of rows) {
    const method = r.payment_method ?? 'unknown';
    const m = methods.get(method) ?? { method, count: 0, gross: 0, reconciledGross: 0, fees: 0, feeTax: 0 };
    m.count += 1;
    m.gross += r.amount;
    if (r.fee_amount != null) {
      m.reconciledGross += r.amount;
      m.fees += r.fee_amount;
      m.feeTax += r.fee_tax ?? 0;
    }
    methods.set(method, m);
  }
  const feesByMethod = [...methods.values()].sort((a, b) => b.gross - a.gross);

  // What has actually reached (or been netted out of) TVC's bank account,
  // per Razorpay's settlement report: each settled payment contributes its
  // amount minus fee, each settled refund debits its amount plus refund fee.
  const settledNet =
    sum((r) => (r.settlement_id ? r.amount - (r.fee_amount ?? 0) : 0)) -
    sum((r) => (r.refund_settlement_id ? (r.refund_amount ?? 0) + (r.refund_fee ?? 0) : 0));
  const unsettledCount = rows.filter((r) => !r.settlement_id || (r.refunded_at && !r.refund_settlement_id)).length;
  const settlementIds = new Set(rows.flatMap((r) => [r.settlement_id, r.refund_settlement_id].filter(Boolean)));

  return jsonResponse({
    canRefund: roleHasCapability('event-payments', staff.role, 'refund'),
    bookings,
    mode,
    serverMode: serverMode(),
    testPaymentCount,
    livePaymentCount,
    aggregates: {
      bookingCount: rows.length,
      totalAttendees: rows.reduce((total, r) => total + (r.attendee_count ?? 1), 0),
      grossCollected,
      totalRefunded,
      totalFees,
      totalFeeTax,
      feesOnRefunded,
      totalRefundFees,
      feesByMethod,
      // Provisionally high for any row whose fee_amount is still null (see
      // scripts/reconcile-event-payment-fees.mjs) rather than guessing a
      // percentage — unreconciledFeeCount below is what tells the dashboard
      // (and the admin reading it) that this number isn't final yet.
      netCollected: grossCollected - totalRefunded - totalFees - totalRefundFees,
      unreconciledFeeCount,
      settledNet,
      unsettledCount,
      settlementCount: settlementIds.size,
      cancelledCount: rows.filter((r) => r.refunded_at).length,
      pendingRequestCount: rows.filter((r) => r.cancellation_requested_at && !r.cancellation_declined_at && !r.refunded_at).length,
    },
  });
}

async function sendRefundEmail(params: {
  payerEmail: string;
  eventTitle: string;
  refundAmount: number;
  paidAmount: number;
  currency: string;
  paymentId: string;
  refundId: string;
  attendeeCount: number;
  // Set only by the bulk "Cancel event" action: TVC called the event off,
  // so the email says so (and shows `reason`, which the admin typed on the
  // form knowing guests will read it) instead of reading like a guest-
  // initiated cancellation.
  eventCancelled?: boolean;
  reason?: string;
  isTest?: boolean;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('[event-payments-admin] RESEND_API_KEY is not set — cannot send refund notification');
    return;
  }
  const retained = params.paidAmount - params.refundAmount;
  const row = (label: string, value: string, bold = false) =>
    `<tr><td style="padding:4px 16px 4px 0; color:#57604f;">${label}</td><td style="padding:4px 0;${bold ? ' font-weight:600;' : ''}">${value}</td></tr>`;
  const html = `<!doctype html>
<html><head><meta charset="utf-8" /></head>
<body style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:#22291f;">
  ${
    params.eventCancelled
      ? `<p>We're sorry — we've had to cancel <strong>${params.eventTitle}</strong>.</p>${
          params.reason ? `<p style="white-space:pre-line;">${escapeHtml(params.reason)}</p>` : ''
        }<p>We've started a refund for your booking.</p>`
      : `<p>We've started a refund for your booking for <strong>${params.eventTitle}</strong>.</p>`
  }
  <table style="border-collapse:collapse; margin:12px 0;">
    ${row('Event', params.eventTitle)}
    ${row('People', String(params.attendeeCount))}
    ${row('Amount paid', formatAmount(params.paidAmount, params.currency))}
    ${row('Refund amount', formatAmount(params.refundAmount, params.currency), true)}
    ${retained > 0 ? row('Amount retained', `${formatAmount(retained, params.currency)} (per our <a href="https://tvc.farm/refund-policy">cancellation &amp; refund policy</a>)`) : ''}
    ${row('Refund initiated on', new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' }))}
    ${row('Payment ID', params.paymentId)}
    ${row('Refund ID', params.refundId)}
  </table>
  <p>It's being processed by Razorpay now and should reach your original payment method within a few business days.</p>
  ${params.eventCancelled ? '<p>We hope to host you at another TVC event soon — keep an eye on <a href="https://tvc.farm/events">tvc.farm/events</a>.</p>' : ''}
  <p>Questions? Reply to this email or reach us at <a href="mailto:core-team@tvc.farm">core-team@tvc.farm</a>.</p>
</body></html>`;
  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: FROM,
      html,
      ...routeEmail(Boolean(params.isTest), {
        to: [params.payerEmail],
        cc: NOTIFY_CC,
        subject: params.eventCancelled ? `${params.eventTitle} has been cancelled — your refund is on its way` : `Refund initiated — ${params.eventTitle}`,
      }),
    }),
  });
  if (!res.ok) {
    throw new Error(`Resend send failed: ${res.status} ${await res.text()}`);
  }
}

async function sendDeclineEmail(params: { payerEmail: string; eventTitle: string; reason?: string; paymentId: string; isTest?: boolean }): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('[event-payments-admin] RESEND_API_KEY is not set — cannot send decline notification');
    return;
  }
  const html = `<!doctype html>
<html><head><meta charset="utf-8" /></head>
<body style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:#22291f;">
  <p>Thank you for letting us know. We've reviewed your cancellation request for <strong>${params.eventTitle}</strong>, and unfortunately we're not able to cancel and refund this booking under our <a href="https://tvc.farm/refund-policy">cancellation &amp; refund policy</a>.</p>
  ${params.reason ? `<p style="white-space:pre-line;">${escapeHtml(params.reason)}</p>` : ''}
  <p>Your booking remains confirmed. If your plans have changed or you think we've got this wrong, reply to this email or reach us at <a href="mailto:core-team@tvc.farm">core-team@tvc.farm</a> and we'll be glad to talk it through.</p>
  <p style="font-size:13px; color:#57604f;">Payment ID ${escapeHtml(params.paymentId)}</p>
</body></html>`;
  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: FROM,
      html,
      ...routeEmail(Boolean(params.isTest), {
        to: [params.payerEmail],
        cc: NOTIFY_CC,
        subject: `Update on your cancellation request — ${params.eventTitle}`,
      }),
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
async function refundOneBooking(row: any, amount: number, staff: StaffGrant, reason: string | undefined, eventCancelled = false): Promise<{ ok: true; refund: { id: string; amount: number; status: string } } | { ok: false; error: string }> {
  // Logged *before* any money moves, and refused if the log can't be
  // written. Only ids and amounts — the free-text reason can contain
  // anything, so it is not copied into the audit log.
  try {
    await logStaffAction({
      actorId: staff.id,
      action: 'event-payments.refund_requested',
      module: 'event-payments',
      detail: { bookingId: row.id, amount, reasonProvided: Boolean(reason) },
    });
  } catch (err) {
    console.error('Failed to write staff audit log; refusing to refund', err);
    return { ok: false, error: 'Could not write the audit log — no money has moved.' };
  }

  let refund;
  try {
    refund = await createRefund({
      paymentId: row.razorpay_payment_id,
      amount,
      // The staff id, not their email: this note is stored by Razorpay.
      notes: { refundedBy: staff.id, ...(reason ? { reason } : {}) },
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
      refundedBy: staff.id,
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
        paidAmount: row.amount,
        currency: row.currency,
        paymentId: row.razorpay_payment_id,
        refundId: refund.id,
        attendeeCount: row.attendee_count,
        eventCancelled,
        reason: eventCancelled ? reason : undefined,
        isTest: row.mode === 'test',
      });
    } catch (err) {
      console.error('Refund succeeded but failed to send notification email', err);
    }
  }

  // WhatsApp alongside the email (a no-op until the templates are approved
  // and listed in WHATSAPP_APPROVED_TEMPLATES, and for a guest with no usable
  // number). A whole-event cancellation gets its own template, carrying the
  // admin's guest-facing reason.
  await sendWhatsAppTemplate(
    eventCancelled
      ? {
          template: 'tvc_event_cancelled',
          to: row.payer_contact,
          isTest: row.mode === 'test',
          params: [
            cleanTemplateParam(firstNameOf(row.payer_name), 60),
            cleanTemplateParam(row.event_title, 120),
            reason ? asSentence(reason) : 'We apologise for the inconvenience.',
            formatAmount(refund.amount, row.currency),
          ],
        }
      : {
          template: 'tvc_refund_initiated',
          to: row.payer_contact,
          isTest: row.mode === 'test',
          params: [cleanTemplateParam(firstNameOf(row.payer_name), 60), formatAmount(refund.amount, row.currency), cleanTemplateParam(row.event_title, 120)],
        },
  );

  // Razorpay's own create-refund response can already say 'processed' (test
  // mode refunds are instant, and so are some live ones). That IS Razorpay's
  // confirmation, so don't wait for a refund.processed webhook that may never
  // come (the test-mode webhook isn't subscribed to refund events) — confirm
  // now. confirmRefundProcessed is idempotent, so if the webhook also arrives
  // only one of the two flips the row and sends the "Refund processed" email.
  if (refund.status === 'processed') {
    try {
      const confirmedNow = await confirmRefundProcessed(row.id, refund.id, refund.status);
      if (confirmedNow && row.payer_email) {
        await sendRefundCompletedEmail({
          to: row.payer_email,
          eventTitle: row.event_title,
          refundAmount: refund.amount,
          currency: row.currency,
          paymentId: row.razorpay_payment_id,
          refundId: refund.id,
          isTest: row.mode === 'test',
        });
      }
      if (confirmedNow) {
        await sendWhatsAppTemplate({
          template: 'tvc_refund_processed',
          to: row.payer_contact,
          isTest: row.mode === 'test',
          params: [cleanTemplateParam(firstNameOf(row.payer_name), 60), formatAmount(refund.amount, row.currency), cleanTemplateParam(row.event_title, 120)],
        });
      }
    } catch (err) {
      console.error('Refund processed instantly but failed to confirm/notify', err);
    }
  }

  return { ok: true, refund: { id: refund.id, amount: refund.amount, status: refund.status } };
}

async function handleRefund(req: Request, staff: StaffGrant): Promise<Response> {
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
  if (parseMode(row.mode) !== serverMode()) return jsonResponse({ error: modeMismatchError(parseMode(row.mode)) }, 409);

  const outcome = await refundOneBooking(row, amount, staff, reason);
  if (!outcome.ok) {
    await sendRefundFailureAlert([failureFromRow(row, outcome.error)], { bulk: false }).catch((err) =>
      console.error('Failed to send refund failure alert', err),
    );
    return jsonResponse({ error: outcome.error }, 502);
  }
  return jsonResponse({ ok: true, refund: outcome.refund });
}

// Declines a guest's cancellation request: the booking stays confirmed, the
// guest is emailed (reason shown verbatim, so the form says it's guest-
// facing), and the row reads "declined" instead of waiting as "requested".
// Moves no money, but gated on the same `refund` capability as refunds since
// it's the same decision.
async function handleDecline(req: Request, staff: StaffGrant): Promise<Response> {
  let body: { id?: string; reason?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }
  const id = (body.id ?? '').trim();
  const reason = body.reason?.trim() || undefined;
  if (!id) return jsonResponse({ error: 'id is required' }, 400);

  let row: any;
  try {
    row = await getPaymentById(id);
  } catch (err) {
    console.error('Failed to look up event_payments row', err);
    return jsonResponse({ error: 'Failed to reach the payment store' }, 502);
  }
  if (!row) return jsonResponse({ error: 'Booking not found' }, 404);
  if (!row.cancellation_requested_at) return jsonResponse({ error: 'This booking has no cancellation request to decline' }, 409);
  if (row.cancellation_declined_at) return jsonResponse({ error: 'This request has already been declined' }, 409);
  if (row.refunded_at || row.refund_initiated_at) return jsonResponse({ error: 'A refund has already been started for this booking' }, 409);

  try {
    await logStaffAction({
      actorId: staff.id,
      action: 'event-payments.cancellation_declined',
      module: 'event-payments',
      detail: { bookingId: row.id, reasonProvided: Boolean(reason) },
    });
  } catch (err) {
    console.error('Failed to write staff audit log; refusing to decline', err);
    return jsonResponse({ error: 'Could not write the audit log — nothing has been changed.' }, 502);
  }

  let recordedNow: boolean;
  try {
    recordedNow = await declineCancellationRequest(row.id, { declinedBy: staff.id, reason });
  } catch (err) {
    console.error('Failed to record declined cancellation', err);
    return jsonResponse({ error: 'Could not record the decision' }, 502);
  }
  if (!recordedNow) return jsonResponse({ error: 'This request changed while you were deciding — refresh and check' }, 409);

  if (row.payer_email) {
    try {
      await sendDeclineEmail({ payerEmail: row.payer_email, eventTitle: row.event_title, reason, paymentId: row.razorpay_payment_id, isTest: row.mode === 'test' });
    } catch (err) {
      console.error('Decline recorded but failed to send notification email', err);
    }
  }
  await sendWhatsAppTemplate({
    template: 'tvc_cancellation_declined',
    to: row.payer_contact,
    isTest: row.mode === 'test',
    params: [cleanTemplateParam(firstNameOf(row.payer_name), 60), cleanTemplateParam(row.event_title, 120), reason ? asSentence(reason) : 'We hope you can still join us.'],
  });
  return jsonResponse({ ok: true, emailed: Boolean(row.payer_email) });
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
async function handleBulkRefund(req: Request, staff: StaffGrant): Promise<Response> {
  let body: { eventReferenceId?: string; fraction?: number; reason?: string; mode?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }

  const eventReferenceId = (body.eventReferenceId ?? '').trim();
  const fraction = Number(body.fraction);
  const reason = body.reason?.trim() || undefined;
  const mode = parseMode(body.mode);
  if (!eventReferenceId) return jsonResponse({ error: 'eventReferenceId is required' }, 400);
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) {
    return jsonResponse({ error: 'fraction must be greater than 0 and at most 1' }, 400);
  }
  if (mode !== serverMode()) return jsonResponse({ error: modeMismatchError(mode) }, 409);

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
  const eligible = allRows.filter((r) => !r.refunded_at && (!r.refund_initiated_at || r.refund_status === 'failed') && isTestPayment(r) === (mode === 'test'));

  // One audit entry for the event cancellation itself (each refund below
  // also logs its own). Refused if it can't be written, like the per-refund
  // log. Only ids and counts — the free-text reason isn't copied in.
  try {
    await logStaffAction({
      actorId: staff.id,
      action: 'event-payments.event_cancelled',
      module: 'event-payments',
      detail: { eventReferenceId, fraction, eligibleCount: eligible.length, mode, reasonProvided: Boolean(reason) },
    });
  } catch (err) {
    console.error('Failed to write staff audit log; refusing to cancel event', err);
    return jsonResponse({ error: 'Could not write the audit log — nothing has been changed.' }, 502);
  }

  // Close registration first, before any money moves, so nobody can book a
  // cancelled event while the refunds below are running. A failure here
  // doesn't block the refunds — it's reported back so the admin can close
  // the Payment Link by hand in the Razorpay dashboard. (Per-guest links
  // already created for someone mid-checkout stay payable; closing the base
  // link only stops new ones from being created.)
  let registration: { closed: boolean; note: string };
  if (mode === 'test') {
    // The event's base Payment Link is shared between test and real
    // bookings — simulating a cancellation must never close real
    // registration.
    registration = { closed: true, note: 'Test mode: online registration was left open.' };
  } else try {
    const base = await fetchBasePaymentLink(eventReferenceId);
    if (base.status === 'created') {
      await cancelPaymentLink(base.id);
      registration = { closed: true, note: 'Online registration closed.' };
    } else {
      registration = { closed: true, note: 'Online registration was already closed.' };
    }
  } catch (err) {
    console.error('Failed to close registration for cancelled event', err);
    registration = {
      closed: false,
      note: `Could not close online registration automatically (${err instanceof Error ? err.message : 'unknown error'}) — close the event's Payment Link in the Razorpay dashboard.`,
    };
  }

  const results: Array<{ id: string; ok: boolean; error?: string }> = [];
  const failedRows: Array<ReturnType<typeof failureFromRow>> = [];
  for (const row of eligible) {
    const amount = Math.round(row.amount * fraction);
    if (amount <= 0) {
      results.push({ id: row.id, ok: false, error: 'Computed refund amount is zero' });
      failedRows.push(failureFromRow(row, 'Computed refund amount is zero'));
      continue;
    }
    const outcome = await refundOneBooking(row, amount, staff, reason, true);
    results.push(outcome.ok ? { id: row.id, ok: true } : { id: row.id, ok: false, error: outcome.error });
    if (!outcome.ok) failedRows.push(failureFromRow(row, outcome.error));
  }

  // One summary alert for the whole batch, not one per failed booking.
  await sendRefundFailureAlert(failedRows, { bulk: true, succeeded: results.filter((r) => r.ok).length }).catch((err) =>
    console.error('Failed to send bulk refund failure alert', err),
  );

  return jsonResponse({
    ok: true,
    attempted: eligible.length,
    succeeded: results.filter((r) => r.ok).length,
    registration,
    results,
  });
}

export default async (req: Request): Promise<Response> => {
  const url = new URL(req.url);

  // Pick the route first so each one is gated by the capability it needs:
  // reading is `view`; both refund routes move real money and need `refund`.
  type Route = { capability: Capability<'event-payments'>; run: (staff: StaffGrant) => Promise<Response> };
  const route: Route | null =
    url.pathname === '/api/event-payments-admin/bookings' && req.method === 'GET'
      ? { capability: 'view', run: (staff) => handleBookings(url, staff) }
      : url.pathname === '/api/event-payments-admin/refund' && req.method === 'POST'
        ? { capability: 'refund', run: (staff) => handleRefund(req, staff) }
        : url.pathname === '/api/event-payments-admin/decline' && req.method === 'POST'
          ? { capability: 'refund', run: (staff) => handleDecline(req, staff) }
          : url.pathname === '/api/event-payments-admin/bulk-refund' && req.method === 'POST'
            ? { capability: 'refund', run: (staff) => handleBulkRefund(req, staff) }
            : null;
  if (!route) return jsonResponse({ error: 'Not found' }, 404);

  const auth = await requireStaff(req, 'event-payments', route.capability);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
  return route.run(auth.staff);
};

export const config = {
  path: ['/api/event-payments-admin/bookings', '/api/event-payments-admin/refund', '/api/event-payments-admin/decline', '/api/event-payments-admin/bulk-refund'],
};
