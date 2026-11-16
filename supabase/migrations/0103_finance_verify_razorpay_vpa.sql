-- Finance module: a UPI ID can be verified by Razorpay's UPI ID lookup (docs/finance/FINANCE.md, "UPI ID names").
-- NOT YET APPLIED to TVC ERP. Apply, then check: a verified row may carry verification_method = 'razorpay_vpa', and any other value
-- is still refused.
--
-- fin_party_accounts.verification_method says how a verifier checked a payee's details (0082, 0094). This adds one more answer,
-- 'razorpay_vpa': the registered name Razorpay gave for the UPI ID (kept in fin_vpa_names, 0102) is recorded as the name the bank showed
-- (verified_name). It needs no screenshot, so the guard trigger asks for nothing extra; the person who entered the details still cannot be
-- the one who verifies them (canVerifyAccount). Only the constraint changes.

alter table fin_party_accounts drop constraint if exists fin_party_accounts_verification_method_check;
alter table fin_party_accounts
  add constraint fin_party_accounts_verification_method_check
    check (verification_method in ('cancelled_cheque', 'test_transfer', 'invoice', 'bank_name_check', 'payment_made', 'razorpay_vpa', 'other'));
