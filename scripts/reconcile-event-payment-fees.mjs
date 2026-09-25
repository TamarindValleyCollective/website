#!/usr/bin/env node
// Backfills event_payments.fee_amount with the actual fee+tax Razorpay
// charged per booking (see supabase/migrations/0024_event_payments_fees.sql,
// netlify/functions/event-payments-admin.mts's netCollected calculation).
//
// Not done inside razorpay-webhook.mts: Razorpay's Payment entity `fee`/
// `tax` fields aren't reliably populated by the time payment_link.paid
// fires, so this instead polls GET /payments/:id for every row that hasn't
// been checked yet, `OLDER_THAN_HOURS` after it was paid (giving Razorpay
// time to actually compute the fee) — a row whose fee still comes back null
// just stays unreconciled for the next run, no error.
//
// Razorpay's fee is a sunk cost from the moment of capture, unaffected by
// any later refund (see RAZORPAY.md / the reconciliation-scenarios planning
// notes) — so this never needs to re-check a row once fee_amount is set,
// refunded or not.
//
// Requires RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET and SUPABASE_URL/
// SUPABASE_SERVICE_ROLE_KEY (same "TVC ERP" project as the rest of this
// module) as environment variables — same as any other Netlify Function
// here, so `netlify env:exec -- node scripts/reconcile-event-payment-fees.mjs`
// picks them up locally without hand-copying them.
//
// Usage: node scripts/reconcile-event-payment-fees.mjs [--dry-run]
import { listUnreconciledPayments, recordFeeReconciled } from './lib/event-payments-db.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const OLDER_THAN_HOURS = 6;
const API_BASE = 'https://api.razorpay.com/v1';

function authHeader() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) throw new Error('Missing RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET');
  return `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;
}

async function fetchPaymentFee(paymentId) {
  const res = await fetch(`${API_BASE}/payments/${paymentId}`, { headers: { Authorization: authHeader() } });
  if (!res.ok) throw new Error(`Razorpay fetch payment failed: ${res.status} ${await res.text()}`);
  const payment = await res.json();
  // Both null until Razorpay has actually computed them — that's the normal
  // "not ready yet" case this script is built to tolerate, not an error.
  if (payment.fee == null || payment.tax == null) return null;
  return payment.fee + payment.tax;
}

async function main() {
  const cutoff = new Date(Date.now() - OLDER_THAN_HOURS * 60 * 60 * 1000).toISOString();
  const rows = await listUnreconciledPayments(cutoff);
  console.log(`${rows.length} payment(s) due for fee reconciliation (paid before ${cutoff}).`);

  let reconciled = 0;
  let stillPending = 0;
  for (const row of rows) {
    let feeAmount;
    try {
      feeAmount = await fetchPaymentFee(row.razorpay_payment_id);
    } catch (err) {
      console.error(`  ${row.razorpay_payment_id}: failed to fetch — ${err instanceof Error ? err.message : err}`);
      continue;
    }
    if (feeAmount == null) {
      stillPending += 1;
      continue;
    }
    console.log(`  ${row.razorpay_payment_id}: fee+tax = ₹${(feeAmount / 100).toFixed(2)}`);
    if (!DRY_RUN) await recordFeeReconciled(row.id, feeAmount);
    reconciled += 1;
  }

  console.log(`Done. Reconciled ${reconciled}, still pending at Razorpay ${stillPending}${DRY_RUN ? ' (dry run — nothing written)' : ''}.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
