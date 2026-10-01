#!/usr/bin/env node
// Two passes over live event_payments rows (see
// supabase/migrations/0024_event_payments_fees.sql and
// 0027_event_payments_fee_tax_settlement.sql,
// netlify/functions/event-payments-admin.mts's fee tally):
//
// 1. Fees — backfills fee_amount/fee_tax with what Razorpay actually
//    charged per booking. Not done inside razorpay-webhook.mts: Razorpay's
//    Payment entity `fee`/`tax` fields aren't reliably populated by the time
//    payment_link.paid fires, so this polls GET /payments/:id for every row
//    that hasn't been checked yet, `OLDER_THAN_HOURS` after it was paid — a
//    row whose fee still comes back null just stays unreconciled for the
//    next run, no error. Razorpay's `fee` already INCLUDES GST and `tax` is
//    the GST portion of it (their Payment entity docs), so fee_amount = fee
//    as-is — an earlier version stored fee + tax, double-counting GST.
//
//    Razorpay's fee is a sunk cost from the moment of capture, unaffected by
//    any later refund — confirmed on the first live refund (pay_TgKoHVIxQB8M1p,
//    refunded before its settlement cycle, still charged its full MDR) — so
//    this never re-checks a row once fee_amount is set.
//
// 2. Settlements — matches each payment and processed refund to the
//    Razorpay settlement batch it was netted into, via the Settlement
//    Reconciliation report (GET /settlements/recon/combined, one call per
//    month). A refund is its own debit line there with its own fee (zero for
//    a normal-speed refund, non-zero for instant), recorded as refund_fee.
//
// Requires RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET and SUPABASE_URL/
// SUPABASE_SERVICE_ROLE_KEY (same "TVC ERP" project as the rest of this
// module) as environment variables — same as any other Netlify Function
// here, so `netlify dev:exec -- node scripts/reconcile-event-payment-fees.mjs`
// would pick them up locally — except Netlify masks the Sensitive-flagged
// service-role key on read, so in practice run it via `gh workflow run
// reconcile-event-payment-fees.yml` (which has real repo secrets).
//
// Usage: node scripts/reconcile-event-payment-fees.mjs [--dry-run]
import { listUnreconciledPayments, recordFeeReconciled, listUnsettledPayments, recordSettlement } from './lib/event-payments-db.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const OLDER_THAN_HOURS = 6;
const API_BASE = 'https://api.razorpay.com/v1';
const RECON_PAGE_SIZE = 1000; // Razorpay's documented max for this report

function authHeader() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) throw new Error('Missing RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET');
  return `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;
}

async function razorpayGet(path) {
  const res = await fetch(`${API_BASE}${path}`, { headers: { Authorization: authHeader() } });
  if (!res.ok) throw new Error(`Razorpay GET ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function fetchPaymentFee(paymentId) {
  const payment = await razorpayGet(`/payments/${paymentId}`);
  // Both null until Razorpay has actually computed them — that's the normal
  // "not ready yet" case this script is built to tolerate, not an error.
  if (payment.fee == null || payment.tax == null) return null;
  return { feeAmount: payment.fee, feeTax: payment.tax, paymentMethod: payment.method ?? null };
}

async function reconcileFees() {
  const cutoff = new Date(Date.now() - OLDER_THAN_HOURS * 60 * 60 * 1000).toISOString();
  const rows = await listUnreconciledPayments(cutoff);
  console.log(`Fees: ${rows.length} payment(s) due for fee reconciliation (paid before ${cutoff}).`);

  let reconciled = 0;
  let stillPending = 0;
  for (const row of rows) {
    let fee;
    try {
      fee = await fetchPaymentFee(row.razorpay_payment_id);
    } catch (err) {
      console.error(`  ${row.razorpay_payment_id}: failed to fetch — ${err instanceof Error ? err.message : err}`);
      continue;
    }
    if (fee == null) {
      stillPending += 1;
      continue;
    }
    console.log(`  ${row.razorpay_payment_id} (${fee.paymentMethod}): fee ₹${(fee.feeAmount / 100).toFixed(2)} (incl. GST ₹${(fee.feeTax / 100).toFixed(2)})`);
    if (!DRY_RUN) await recordFeeReconciled(row.id, fee);
    reconciled += 1;
  }
  console.log(`Fees: reconciled ${reconciled}, still pending at Razorpay ${stillPending}.`);
}

// Every [year, month] from `from` through the current month, inclusive.
function monthsSince(from) {
  const months = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  const now = new Date();
  while (cursor <= now) {
    months.push([cursor.getUTCFullYear(), cursor.getUTCMonth() + 1]);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

async function fetchReconMonth(year, month) {
  const items = [];
  for (let skip = 0; ; skip += RECON_PAGE_SIZE) {
    const page = await razorpayGet(`/settlements/recon/combined?year=${year}&month=${month}&count=${RECON_PAGE_SIZE}&skip=${skip}`);
    items.push(...(page.items ?? []));
    if ((page.items ?? []).length < RECON_PAGE_SIZE) return items;
  }
}

async function reconcileSettlements() {
  const rows = await listUnsettledPayments();
  console.log(`Settlements: ${rows.length} payment(s) with an unsettled payment or refund.`);
  if (rows.length === 0) return;

  const byPaymentId = new Map(rows.filter((r) => !r.settlement_id).map((r) => [r.razorpay_payment_id, r]));
  const byRefundId = new Map(rows.filter((r) => r.razorpay_refund_id && r.refunded_at && !r.refund_settlement_id).map((r) => [r.razorpay_refund_id, r]));
  const earliest = new Date(Math.min(...rows.map((r) => Date.parse(r.created_at))));

  let matched = 0;
  for (const [year, month] of monthsSince(earliest)) {
    const items = await fetchReconMonth(year, month);
    for (const item of items) {
      if (!item.settled || !item.settlement_id) continue;
      const settledAt = new Date(item.settled_at * 1000).toISOString();
      if (item.type === 'payment' && byPaymentId.has(item.entity_id)) {
        const row = byPaymentId.get(item.entity_id);
        console.log(`  ${item.entity_id}: settled in ${item.settlement_id} at ${settledAt}`);
        if (!DRY_RUN) await recordSettlement(row.id, { settlement_id: item.settlement_id, settled_at: settledAt, settlement_utr: item.settlement_utr || null });
        byPaymentId.delete(item.entity_id);
        matched += 1;
      } else if (item.type === 'refund' && byRefundId.has(item.entity_id)) {
        const row = byRefundId.get(item.entity_id);
        console.log(`  ${item.entity_id}: refund settled in ${item.settlement_id} at ${settledAt}, refund fee ₹${((item.fee ?? 0) / 100).toFixed(2)}`);
        if (!DRY_RUN) {
          await recordSettlement(row.id, {
            refund_settlement_id: item.settlement_id,
            refund_settled_at: settledAt,
            refund_fee: item.fee ?? 0,
            refund_fee_tax: item.tax ?? 0,
          });
        }
        byRefundId.delete(item.entity_id);
        matched += 1;
      }
    }
  }
  console.log(`Settlements: matched ${matched}, still awaiting settlement ${byPaymentId.size + byRefundId.size}.`);
}

async function main() {
  await reconcileFees();
  await reconcileSettlements();
  if (DRY_RUN) console.log('Dry run — nothing written.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
