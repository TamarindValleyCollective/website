-- Fee tally + settlement tracking for event payments (see
-- scripts/reconcile-event-payment-fees.mjs, netlify/functions/event-payments-admin.mts,
-- RAZORPAY.md). TVC absorbs Razorpay's MDR rather than passing it on to
-- guests, and MDR differs by payment method — so the dashboard needs a
-- real per-method tally of what was charged, split into MDR vs GST, plus
-- what actually reached the bank.
--
-- Corrects 0024's fee_amount semantics: Razorpay's Payment entity `fee` is
-- documented as "Fee (including GST)" and `tax` as "GST charged for the
-- payment" — i.e. tax is already inside fee. 0024's reconcile script stored
-- fee + tax, double-counting GST. From here on:
--   fee_amount = Razorpay `fee` (MDR + GST, the total TVC actually paid)
--   fee_tax    = Razorpay `tax` (the GST portion; MDR = fee_amount - fee_tax)
--
-- Settlement columns come from Razorpay's Settlement Reconciliation report
-- (GET /settlements/recon/combined), which lists each payment and refund
-- with the settlement batch it was netted into. A refund is its own line in
-- that report (debit), with its own fee — zero for a normal-speed refund,
-- non-zero for an instant refund — hence refund_fee/refund_fee_tax.
alter table event_payments
  add column fee_tax integer,              -- paise, GST portion of fee_amount
  add column settlement_id text,           -- setl_xxx the payment was settled in
  add column settled_at timestamptz,
  add column settlement_utr text,          -- bank UTR; null for a settlement that netted to zero
  add column refund_fee integer,           -- paise, Razorpay's charge for the refund itself (incl. GST)
  add column refund_fee_tax integer,       -- paise, GST portion of refund_fee
  add column refund_settlement_id text,    -- setl_xxx the refund debit was settled in
  add column refund_settled_at timestamptz;

-- Re-queue every already-reconciled row so the corrected script re-fetches
-- fee/tax from Razorpay rather than trusting a possibly double-counted
-- fee_amount. Only one live row existed at the time (tax 0, so unaffected
-- in practice), but this keeps the column's meaning uniform.
update event_payments set fee_reconciled_at = null where fee_tax is null;
