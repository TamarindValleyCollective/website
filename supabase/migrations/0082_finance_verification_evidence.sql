-- Finance module: how a payee's details were verified (docs/finance/FINANCE.md, "Verifying").
--
-- "Verified" has recorded who and when since 0079. This adds HOW: a method from a short list (cancelled cheque or bank
-- letter, a test transfer that arrived, an invoice, other) and an optional short note, so an auditor can see what a
-- verification rests on. The database enforces it: verifying details needs a method, and once recorded the evidence is
-- never changed. Details verified before this migration keep their who and when and show "Method not recorded".
-- The note is free text, so the app refuses account numbers, UPI ids and IFSC codes in it (finance-parties.mjs).

alter table fin_party_accounts
  add column verification_method text check (verification_method in ('cancelled_cheque', 'test_transfer', 'invoice', 'other')),
  add column verification_note text check (verification_note is null or length(verification_note) <= 200);

-- The same guard as 0079 (details are never overwritten; retirement rules), plus the evidence rules.
create or replace function fin_party_accounts_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'fin_party_accounts rows are never deleted';
  end if;
  if new.entity_id is distinct from old.entity_id
     or new.party_id is distinct from old.party_id
     or new.method is distinct from old.method
     or new.details_enc is distinct from old.details_enc
     or new.last4 is distinct from old.last4
     or new.fingerprint is distinct from old.fingerprint
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at
     or new.has_ifsc is distinct from old.has_ifsc
     or new.valid_from is distinct from old.valid_from then
    raise exception 'payee details are never overwritten; add a new row';
  end if;
  if old.retired_on is not null and (new.retired_on is null or new.retired_on > old.retired_on) then
    raise exception 'a retirement can only be moved earlier, never later or cleared';
  end if;
  if new.retired_on is distinct from old.retired_on and old.status = 'superseded' then
    raise exception 'a replaced account cannot be retired';
  end if;
  if old.status = 'superseded' and new.status <> 'superseded' then
    raise exception 'a superseded account cannot be brought back';
  end if;
  if old.status = 'verified' and new.status = 'unverified' then
    raise exception 'verified details cannot become unverified';
  end if;
  if new.status = 'verified' and old.status <> 'verified' and new.verification_method is null then
    raise exception 'say how the details were checked';
  end if;
  if old.verification_method is not null
     and (new.verification_method is distinct from old.verification_method or new.verification_note is distinct from old.verification_note) then
    raise exception 'how the details were verified is never changed';
  end if;
  return new;
end;
$$;
