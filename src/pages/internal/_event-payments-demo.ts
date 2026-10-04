// Dev-only demo data for /internal/event-payments — `astro dev`, then open
// /internal/event-payments?demo. Loaded only behind `import.meta.env.DEV`
// in event-payments.astro, so a production build never includes it (the
// leading underscore keeps Astro from routing this file as a page).
//
// Why it exists: the real API (netlify/functions/event-payments-admin.mts)
// can't run locally — Netlify masks the Sensitive-flagged Supabase
// service-role key on read — so without this there's no way to see the
// dashboard with data outside production. Also what the admin-guide
// screenshots are taken from.
//
// It stubs window.fetch for /api/event-payments-admin/* only: bookings are
// dummy people, and refunds just change this in-memory state — nothing
// reaches Razorpay or Supabase. Aggregates mirror handleBookings()'s
// formulas so the numbers behave like the real thing.
//
// Fees are illustrative (2% MDR + 18% GST on UPI/card, 1.9% + GST on
// netbanking), not Razorpay's actual rate card.

type Status = 'paid' | 'requested' | 'refund_initiated' | 'refund_failed' | 'refunded';

interface DemoRow {
  id: string;
  name: string;
  email: string;
  contact: string;
  attendees: number;
  amount: number;
  method: string;
  fee: number | null;
  feeTax: number | null;
  createdAt: string;
  cancellationRequestedAt: string | null;
  refundAmount: number | null;
  refundedAt: string | null;
  refundFee: number | null;
  settledAt: string | null;
  refundSettledAt: string | null;
}

const SETTLEMENT_ID = 'setl_DEMO00000001';

// 2% MDR + 18% GST on it, in paise — Razorpay reports the combined figure
// as `fee` and the GST part as `tax`.
function fee(amount: number, rate = 0.02): { fee: number; feeTax: number } {
  const mdr = Math.round(amount * rate);
  const tax = Math.round(mdr * 0.18);
  return { fee: mdr + tax, feeTax: tax };
}

function row(partial: Partial<DemoRow> & Pick<DemoRow, 'id' | 'name' | 'email' | 'attendees' | 'method' | 'createdAt'>): DemoRow {
  const amount = partial.amount ?? partial.attendees * 225000;
  return {
    contact: '+91 98450 00000',
    amount,
    fee: null,
    feeTax: null,
    cancellationRequestedAt: null,
    refundAmount: null,
    refundedAt: null,
    refundFee: null,
    settledAt: null,
    refundSettledAt: null,
    ...partial,
  };
}

const rows: DemoRow[] = [
  row({ id: 'demo-a', name: 'Asha Rao', email: 'asha.rao@example.com', attendees: 2, method: 'upi', ...fee(450000), createdAt: '2026-09-24T09:12:00Z', settledAt: '2026-09-26T07:35:00Z' }),
  row({ id: 'demo-b', name: 'Bhavya Iyer', email: 'bhavya.iyer@example.com', attendees: 1, method: 'card', ...fee(225000), createdAt: '2026-09-24T11:40:00Z', settledAt: '2026-09-26T07:35:00Z', cancellationRequestedAt: '2026-09-27T05:00:00Z', refundAmount: 168750, refundedAt: '2026-09-27T09:20:00Z', refundFee: 0, refundSettledAt: '2026-09-29T07:35:00Z' }),
  row({ id: 'demo-c', name: 'Chetan Kumar', email: 'chetan.k@example.com', attendees: 3, method: 'upi', ...fee(675000), createdAt: '2026-09-25T06:05:00Z', settledAt: '2026-09-29T07:35:00Z' }),
  row({ id: 'demo-d', name: 'Deepa Menon', email: 'deepa.menon@example.com', attendees: 1, method: 'netbanking', ...fee(225000, 0.019), createdAt: '2026-09-26T13:30:00Z', settledAt: '2026-09-29T07:35:00Z', cancellationRequestedAt: '2026-10-01T04:10:00Z' }),
  row({ id: 'demo-e', name: 'Asha Rao', email: 'asha.rao@example.com', attendees: 1, method: 'upi', ...fee(225000), createdAt: '2026-09-28T10:00:00Z', settledAt: '2026-09-30T07:35:00Z' }),
  row({ id: 'demo-f', name: 'Farah Khan', email: 'farah.khan@example.com', attendees: 2, method: 'card', createdAt: '2026-10-01T08:45:00Z' }),
];

function statusFor(r: DemoRow): Status {
  if (r.refundedAt) return 'refunded';
  if (r.cancellationRequestedAt) return 'requested';
  return 'paid';
}

function bookingsResponse(eventDate: string | null) {
  const liveEmailCounts = new Map<string, number>();
  for (const r of rows) if (!r.refundedAt) liveEmailCounts.set(r.email, (liveEmailCounts.get(r.email) ?? 0) + 1);

  const bookings = [...rows]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((r) => ({
      id: r.id,
      razorpayPaymentId: `pay_DEMO000000000${r.id.slice(-1).toUpperCase()}`,
      // Same shape the real API sends: a display label plus on-file flags,
      // never the email or phone themselves.
      payerLabel: r.name,
      hasEmail: Boolean(r.email),
      hasPhone: Boolean(r.contact),
      attendeeCount: r.attendees,
      amount: r.amount,
      currency: 'INR',
      createdAt: r.createdAt,
      eventDate,
      cancellationRequestedAt: r.cancellationRequestedAt,
      refundInitiatedAt: r.refundedAt,
      refundedAt: r.refundedAt,
      refundAmount: r.refundAmount,
      refundStatus: r.refundedAt ? 'processed' : null,
      status: statusFor(r),
      isTest: false,
      isDuplicate: !r.refundedAt && (liveEmailCounts.get(r.email) ?? 0) > 1,
      paymentMethod: r.method,
      feeAmount: r.fee,
      feeTax: r.feeTax,
      refundFee: r.refundFee,
      settlementId: r.settledAt ? SETTLEMENT_ID : null,
      settledAt: r.settledAt,
      refundSettledAt: r.refundSettledAt,
    }));

  const sum = (pick: (r: DemoRow) => number) => rows.reduce((total, r) => total + pick(r), 0);
  const grossCollected = sum((r) => r.amount);
  const totalRefunded = sum((r) => (r.refundedAt ? (r.refundAmount ?? 0) : 0));
  const totalFees = sum((r) => r.fee ?? 0);
  const totalRefundFees = sum((r) => r.refundFee ?? 0);
  const methods = new Map<string, { method: string; count: number; gross: number; reconciledGross: number; fees: number; feeTax: number }>();
  for (const r of rows) {
    const m = methods.get(r.method) ?? { method: r.method, count: 0, gross: 0, reconciledGross: 0, fees: 0, feeTax: 0 };
    m.count += 1;
    m.gross += r.amount;
    if (r.fee != null) {
      m.reconciledGross += r.amount;
      m.fees += r.fee;
      m.feeTax += r.feeTax ?? 0;
    }
    methods.set(r.method, m);
  }

  return {
    canRefund: true,
    bookings,
    testPaymentCount: 0,
    aggregates: {
      bookingCount: rows.length,
      totalAttendees: sum((r) => r.attendees),
      grossCollected,
      totalRefunded,
      totalFees,
      totalFeeTax: sum((r) => r.feeTax ?? 0),
      feesOnRefunded: sum((r) => (r.refundedAt ? (r.fee ?? 0) : 0)),
      totalRefundFees,
      feesByMethod: [...methods.values()].sort((a, b) => b.gross - a.gross),
      netCollected: grossCollected - totalRefunded - totalFees - totalRefundFees,
      unreconciledFeeCount: rows.filter((r) => r.fee == null).length,
      settledNet: sum((r) => (r.settledAt ? r.amount - (r.fee ?? 0) : 0)) - sum((r) => (r.refundSettledAt ? (r.refundAmount ?? 0) + (r.refundFee ?? 0) : 0)),
      unsettledCount: rows.filter((r) => !r.settledAt || (r.refundedAt && !r.refundSettledAt)).length,
      settlementCount: 1,
      cancelledCount: rows.filter((r) => r.refundedAt).length,
      pendingRequestCount: rows.filter((r) => r.cancellationRequestedAt && !r.refundedAt).length,
    },
  };
}

function refund(r: DemoRow, amount: number) {
  r.refundAmount = amount;
  r.refundedAt = new Date().toISOString();
  r.refundFee = 0;
  r.cancellationRequestedAt ??= r.refundedAt;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Signs in as a demo admin and serves dummy data for every /api/event-payments-admin call. */
export function installEventPaymentsDemo(storageKey: string, eventDateFor: (referenceId: string) => string | null) {
  const payload = btoa(JSON.stringify({ email: 'demo-admin@tvc.farm' })).replace(/=+$/, '');
  sessionStorage.setItem(storageKey, `demo.${payload}.demo`);

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), location.origin);
    if (!url.pathname.startsWith('/api/event-payments-admin')) return realFetch(input, init);
    await new Promise((resolve) => setTimeout(resolve, 250));

    if (url.pathname.endsWith('/bookings')) {
      return json(bookingsResponse(eventDateFor(url.searchParams.get('eventReferenceId') ?? '')));
    }
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (url.pathname.endsWith('/bulk-refund')) {
      const eligible = rows.filter((r) => !r.refundedAt);
      for (const r of eligible) refund(r, Math.round(r.amount * body.fraction));
      return json({ succeeded: eligible.length, attempted: eligible.length, results: eligible.map((r) => ({ id: r.id, ok: true })) });
    }
    if (url.pathname.endsWith('/refund')) {
      const r = rows.find((candidate) => candidate.id === body.id);
      if (!r) return json({ error: 'Booking not found' }, 404);
      refund(r, body.amount);
      return json({ ok: true, refund: { id: `rfnd_${r.id}`, amount: body.amount, status: 'processed' } });
    }
    return json({ error: 'Not handled in demo mode' }, 404);
  };
}
