-- Payment method + Razorpay's actual fee per booking (see
-- netlify/functions/razorpay-webhook.mts, scripts/reconcile-event-payment-fees.mjs,
-- netlify/functions/event-payments-admin.mts). Corrects "Net collected" on
-- the admin dashboard, which until now was gross minus refunds only — it
-- never subtracted Razorpay's own cut, so it overstated what TVC actually
-- banks per booking.
--
-- payment_method is captured synchronously at payment_link.paid time
-- (payment.entity.method is always present on a captured payment).
-- fee_amount is NOT — Razorpay's fee (MDR) is locked in at capture but the
-- `fee`/`tax` fields on the Payment entity aren't reliably populated by the
-- time our webhook fires, so fee_amount/fee_reconciled_at are filled in
-- later by scripts/reconcile-event-payment-fees.mjs polling
-- GET /payments/:id once Razorpay has actually computed them. A row with
-- fee_reconciled_at still null hasn't been checked yet (or Razorpay hadn't
-- computed the fee at last check) — event-payments-admin.mts's netCollected
-- treats an unreconciled row as contributing zero fee (net is provisionally
-- high for it) rather than guessing a percentage, and the dashboard
-- surfaces the unreconciled count so that's visible rather than silent.
--
-- fee_amount is the combined fee+tax Razorpay actually charged (paise) —
-- never a computed/assumed percentage (varies by payment method; confirmed
-- empirically to NOT be a flat rate, see the reconciliation-scenarios
-- planning notes). Deliberately no settlement_id/settled_at yet: linking a
-- specific payment to the specific settlement batch/UTR it landed in needs
-- Razorpay's separate Settlement Reconciliation report, not the plain
-- Payment entity this migration's columns are sourced from — a real
-- follow-up, not done here.
alter table event_payments
  add column payment_method text,
  add column fee_amount integer,
  add column fee_reconciled_at timestamptz;
