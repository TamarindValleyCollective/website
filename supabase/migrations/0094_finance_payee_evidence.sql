-- Finance module: screenshots as evidence for a payee account (docs/finance/FINANCE.md, "Evidence").
--
-- Two new ways to verify an account, both with a screenshot kept against THAT account:
--   bank_name_check  the bank's own "Name as per Payee Bank" screen, which proves whose account it is (a typed label in a
--                    transfer sheet does not). The name the bank showed is kept on the account (`verified_name`) next to the
--                    party's label, which stays the name the party is searched by.
--   payment_made     the success screen of a transfer, which proves money reached that account.
-- The database refuses to mark an account verified by either method without its file (and, for the name check, the name), and
-- once verified neither the name nor the files can change. Files live in the private R2 bucket under finance/vouchers/ (the same
-- prefix as bills, read back only through the authenticated function); this table holds what they are and who attached them.
-- Public repository: nothing here is a real name, number or UPI id.
--
-- Apply this BEFORE the code that sends the new methods is used (the page keeps working without it for the old methods).

-- The default name Postgres gave the column check in 0082.
alter table fin_party_accounts drop constraint if exists fin_party_accounts_verification_method_check;

alter table fin_party_accounts
  add constraint fin_party_accounts_verification_method_check
    check (verification_method in ('cancelled_cheque', 'test_transfer', 'invoice', 'bank_name_check', 'payment_made', 'other')),
  add column verified_name text check (verified_name is null or length(verified_name) between 2 and 120);

create table fin_party_account_files (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references fin_entities (id),
  account_id uuid not null references fin_party_accounts (id),
  -- payment: the transfer success screen; name_check: the bank's payee-name screen; other: anything else worth keeping.
  kind text not null check (kind in ('payment', 'name_check', 'other')),
  r2_key text not null unique check (r2_key ~ '^finance/vouchers/[0-9a-f-]{36}\.(jpg|png|webp|pdf)$'),
  mime text not null check (mime in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  bytes integer not null check (bytes > 0),
  uploaded_by uuid references staff_users (id),
  created_at timestamptz not null default now()
);
create index fin_party_account_files_account_idx on fin_party_account_files (account_id);

-- Evidence is never edited or removed: a mistaken upload stays with the account it was attached to.
create function fin_party_account_files_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'evidence files are never changed or deleted';
end;
$$;
create trigger fin_party_account_files_guard_trg
  before update or delete on fin_party_account_files
  for each row execute function fin_party_account_files_guard();

-- The guard from 0082, plus: the two screenshot methods need their file (and the name), and the name never changes.
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

alter table fin_party_account_files enable row level security;
revoke all on fin_party_account_files from anon, authenticated;
revoke all on function fin_party_account_files_guard() from public, anon, authenticated;
