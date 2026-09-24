-- Records which Razorpay API mode actually processed a payment
-- (razorpay-webhook.mts computes this from whether RAZORPAY_KEY_ID starts
-- with rzp_test_ or rzp_live_ at the moment it handles the webhook), so
-- event-payments-admin.mts can filter test payments out of the dashboard
-- deterministically instead of guessing from payer_email (an earlier
-- version of this filter matched Razorpay's test-mode "quick pay" default
-- email, void@razorpay.com — plausible but never confirmed as a guaranteed,
-- documented Razorpay behavior, so replaced with this instead).
alter table event_payments
  add column mode text check (mode in ('test', 'live'));

-- Backfill: every row recorded before this migration was created while
-- proving this module out in Test Mode, before the switch to live keys
-- later the same day (2026-09-24) — see RAZORPAY.md's "Event payment
-- tracking (live)" section for that history. Confirmed against the actual
-- rows too (all five have payer_email = void@razorpay.com).
update event_payments set mode = 'test' where mode is null;
