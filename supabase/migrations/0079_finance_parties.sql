-- Finance module, session 04: parties and payee accounts (docs/finance/sessions/04-parties-and-payees.md).
--
--   * fin_parties: everyone TVC pays or receives from (members, vendors, employees ...). A member party may link to a
--     household.
--   * fin_party_accounts: bank or UPI details for a party. Never overwritten: a change is a new `unverified` row and
--     the old one of that method becomes `superseded`. The full details are AES-256-GCM encrypted (account_enc, keyed
--     separately from the TOTP and member-payout keys); only the last four characters are kept in the clear, plus a
--     keyed fingerprint so two parties sharing one account can be flagged without decrypting anything.
--
-- Same posture as the other fin_ tables (0077): RLS on with no policies, anon/authenticated revoked, service role only.
-- Public repository: nothing here is a real name, number or UPI id.

create table fin_parties (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references fin_entities (id),
  kind text not null check (kind in ('member', 'vendor', 'employee', 'customer', 'bank', 'government', 'director', 'other')),
  name text not null check (length(name) between 2 and 120),
  -- Set for a member party; null otherwise.
  household_id uuid references member_households (id),
  active boolean not null default true,
  created_by uuid references staff_users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (household_id is null or kind = 'member')
);
create index fin_parties_entity_name_idx on fin_parties (entity_id, lower(name));
create unique index fin_parties_household_idx on fin_parties (household_id) where household_id is not null and active;

create table fin_party_accounts (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references fin_entities (id),
  party_id uuid not null references fin_parties (id),
  method text not null check (method in ('bank', 'upi')),
  -- JSON of the details (account + ifsc, or upi), encrypted. Never returned by a list endpoint.
  details_enc text not null,
  -- Last four characters of the account number (or UPI handle); the only part shown without the step-up.
  last4 text not null check (length(last4) = 4),
  -- Keyed HMAC of the account number / UPI id, for shared-account detection. Never returned by any endpoint.
  fingerprint text not null,
  status text not null default 'unverified' check (status in ('unverified', 'verified', 'superseded')),
  -- Null when the row came from the operator import script.
  created_by uuid references staff_users (id),
  created_at timestamptz not null default now(),
  verified_by uuid references staff_users (id),
  verified_at timestamptz,
  superseded_at timestamptz,
  check ((status = 'verified') = (verified_at is not null and verified_by is not null) or status = 'superseded'),
  check ((status = 'superseded') = (superseded_at is not null))
);
create index fin_party_accounts_party_idx on fin_party_accounts (party_id);
create index fin_party_accounts_fingerprint_idx on fin_party_accounts (fingerprint) where status <> 'superseded';

-- Details are never overwritten and rows are never deleted: only the status may move forward
-- (unverified -> verified -> superseded, or unverified -> superseded), with its timestamp and who.
create function fin_party_accounts_guard() returns trigger
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
     or new.created_at is distinct from old.created_at then
    raise exception 'payee details are never overwritten; add a new row';
  end if;
  if old.status = 'superseded' and new.status <> 'superseded' then
    raise exception 'a superseded account cannot be brought back';
  end if;
  if old.status = 'verified' and new.status = 'unverified' then
    raise exception 'verified details cannot become unverified';
  end if;
  return new;
end;
$$;
create trigger fin_party_accounts_guard_trg
  before update or delete on fin_party_accounts
  for each row execute function fin_party_accounts_guard();

alter table fin_parties enable row level security;
alter table fin_party_accounts enable row level security;
revoke all on fin_parties, fin_party_accounts from anon, authenticated;
revoke all on function fin_party_accounts_guard() from public, anon, authenticated;
