-- Finance session 09a: evidence of the bank's confirmation for a salary batch (docs/finance/sessions/09-payroll.md, "Plan for the next slices").
-- NOT APPLIED.
--
-- After the preparer uploads the bank file, the bank's portal shows the batch with each line and its status. A screenshot of that page is the
-- only proof from a system TVC does not control, and today it is also what the farm manager is sent to confirm. It is kept as a voucher of
-- kind 'payment_screenshot' (the same private storage, sniffing and viewing as a payment request's screenshot), now allowed to belong to a
-- payment batch. A voucher must still belong to something: an allocation, a payment request or a batch.
--
-- Same posture as the other fin_ tables (0077): RLS on with no policies, anon/authenticated revoked, service role only (fin_vouchers already is).
-- Public repository: nothing here is a real name, number or amount.

alter table fin_vouchers add column batch_id uuid references fin_payment_batches (id);
alter table fin_vouchers drop constraint fin_vouchers_owner;
alter table fin_vouchers add constraint fin_vouchers_owner check (allocation_id is not null or request_id is not null or batch_id is not null);
create index fin_vouchers_batch_idx on fin_vouchers (batch_id) where batch_id is not null;
