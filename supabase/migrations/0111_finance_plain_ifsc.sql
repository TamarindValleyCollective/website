-- Finance: the IFSC code of a bank payee account gets its own plain column.
--
-- Until now the IFSC lived only inside details_enc, encrypted together with the account number. An IFSC names a bank branch and is public;
-- only the account number needs the key. A plain column lets lists, checks and the payroll page show and match it without decrypting anything
-- (and on a machine that does not hold the key). details_enc still carries the IFSC as before, so nothing that reads it changes, and the
-- encrypted copy stays the one the bank file is built from.
--
-- Like the rest of a payee row the new column is never overwritten (the guard from 0094 is replaced below with one extra rule). The one
-- exception is filling an EMPTY ifsc once, for rows that existed before this column: fin_backfill_party_account_ifsc, which the operator
-- script scripts/backfill-fin-ifsc.mjs calls with the value decrypted from details_enc. New rows get the column from the app and the import.
-- Public repository: nothing here is a real name, number or amount.

alter table fin_party_accounts
  add column ifsc text check (ifsc is null or ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$');

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
     or (new.ifsc is distinct from old.ifsc
         and not (old.ifsc is null and new.ifsc is not null and coalesce(current_setting('fin.backfill_ifsc', true), '') = 'on'))
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
  if new.status = 'verified' and old.status <> 'verified' then
    if new.verification_method is null then
      raise exception 'say how the details were checked';
    end if;
    if new.verification_method = 'payment_made'
       and not exists (select 1 from public.fin_party_account_files f where f.account_id = new.id and f.kind = 'payment') then
      raise exception 'attach the transfer screenshot first';
    end if;
    if new.verification_method = 'bank_name_check'
       and (new.verified_name is null
            or not exists (select 1 from public.fin_party_account_files f where f.account_id = new.id and f.kind = 'name_check')) then
      raise exception 'attach the bank''s name-check screen and type the name it showed';
    end if;
  end if;
  if old.verification_method is not null
     and (new.verification_method is distinct from old.verification_method or new.verification_note is distinct from old.verification_note) then
    raise exception 'how the details were verified is never changed';
  end if;
  if old.status = 'verified' and new.verified_name is distinct from old.verified_name then
    raise exception 'the name the bank showed is never changed once verified';
  end if;
  return new;
end;
$$;

-- Fills an empty ifsc on existing rows, one value per row, in one transaction. A row that already has one, or is not a bank account, is left
-- alone; the count of rows actually changed is returned. Only the service role may call it.
create function fin_backfill_party_account_ifsc(p_ids uuid[], p_ifscs text[]) returns integer
language plpgsql security definer set search_path = public as $$
declare
  changed integer := 0;
  n integer;
  i integer;
begin
  if coalesce(array_length(p_ids, 1), 0) <> coalesce(array_length(p_ifscs, 1), 0) then raise exception 'one IFSC for each account'; end if;
  perform set_config('fin.backfill_ifsc', 'on', true);
  for i in 1 .. coalesce(array_length(p_ids, 1), 0) loop
    update fin_party_accounts set ifsc = p_ifscs[i]
      where id = p_ids[i] and method = 'bank' and ifsc is null;
    get diagnostics n = row_count;
    changed := changed + n;
  end loop;
  perform set_config('fin.backfill_ifsc', 'off', true);
  return changed;
end;
$$;

revoke all on function fin_backfill_party_account_ifsc(uuid[], text[]) from public, anon, authenticated;
grant execute on function fin_backfill_party_account_ifsc(uuid[], text[]) to service_role;
