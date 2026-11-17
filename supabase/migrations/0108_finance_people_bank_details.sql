-- Finance session 09a: bank details on a people-change request (docs/finance/sessions/09-payroll.md, "Plan for the next slices"). NOT APPLIED.
--
-- The employee gives their bank details to the farm manager, so he enters them on the joining request, and can raise a request to change them
-- (a third kind, 'bank_change'). The details are encrypted with the same key as a payee account, with only the last four digits readable, and
-- the passbook or cheque photo that proves they are the employee's own is held privately next to them. They are kept ONLY while the request is
-- open: approving it attaches them to the person's Party as an unverified payee account (with the photo as evidence on that account), and
-- declining or withdrawing it discards them. A second copy is never kept (a check constraint, not only the function).
--
--   * kind 'bank_change': the employee, the new details, and the day the new account starts (the 1st after the first salary month it is
--     for); the old account stays payable until then and the new one cannot be paid until someone else verifies it (see 0079).
--
-- Same posture as the other fin_ tables (0077): RLS on with no policies, anon/authenticated revoked, service role only (the table already is).
-- Public repository: nothing here is a real name, number or amount.

alter table fin_people_requests drop constraint fin_people_requests_kind_check;
alter table fin_people_requests add constraint fin_people_requests_kind_check check (kind in ('join', 'leave', 'bank_change'));

alter table fin_people_requests
  -- JSON of the bank details, encrypted; never returned by any endpoint. last4 is the only readable part.
  add column details_enc text,
  add column last4 text check (last4 is null or length(last4) = 4),
  -- bank_change: the first day the new account is paid from.
  add column effective_on date check (effective_on is null or extract(day from effective_on) = 1),
  -- Key and type of the photo of the passbook or cancelled cheque, in the private bucket.
  add column proof_key text,
  add column proof_mime text;

alter table fin_people_requests
  add constraint fin_people_requests_bank_change_shape check (kind <> 'bank_change' or (employee_id is not null and details_enc is not null and effective_on is not null and person_name is null and start_month is null and last_month is null and agreed_pay_paise is null)),
  add constraint fin_people_requests_details_pair check ((details_enc is null) = (last4 is null)),
  add constraint fin_people_requests_leave_no_bank check (kind <> 'leave' or (details_enc is null and effective_on is null)),
  add constraint fin_people_requests_join_no_effective check (kind <> 'join' or effective_on is null),
  add constraint fin_people_requests_proof_pair check ((proof_key is null) = (proof_mime is null) and (proof_key is null or details_enc is not null)),
  -- Once decided, withdrawn or declined, the request no longer holds the details or the photo.
  add constraint fin_people_requests_details_while_open check (status = 'requested' or (details_enc is null and proof_key is null));

-- One open change of bank details per person.
create unique index fin_people_requests_open_bank_idx on fin_people_requests (employee_id) where kind = 'bank_change' and status = 'requested';
