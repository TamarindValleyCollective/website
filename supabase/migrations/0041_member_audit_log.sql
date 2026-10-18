-- Member portal, step 2: an audit trail for changes members make to their own
-- record through the portal (members.tvc.farm). Staff changes already go to
-- staff_audit_log (0028); members are not staff, so they get their own table.
--
-- Same shape and rules as staff_audit_log: append-only, and `detail` must never
-- hold personal data (names, emails, phone numbers): only which fields changed.
-- A member's own row is the actor; the row is kept (set null) if that person is
-- ever deleted, so the history survives.
--
-- Access is server-side only (Netlify Functions with the service_role key). RLS
-- is on with no policies and anon/authenticated are revoked, as for every other
-- member_* table.

create table member_audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_person_id uuid references member_people (id) on delete set null,
  action text not null,
  detail jsonb
);
create index member_audit_log_at_idx on member_audit_log (at desc);
create index member_audit_log_actor_idx on member_audit_log (actor_person_id);

-- Append-only: the log is only useful if it can't be quietly edited. Deleting a
-- person sets actor_person_id to null, which is the one permitted update.
create function member_audit_log_immutable() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and new.id = old.id and new.at = old.at and new.action = old.action
     and new.detail is not distinct from old.detail
     and new.actor_person_id is null then
    return new; -- the person was deleted; only the actor link is cleared
  end if;
  raise exception 'member_audit_log is append-only';
end;
$$;
create trigger member_audit_log_no_update_delete
  before update or delete on member_audit_log
  for each row execute function member_audit_log_immutable();

alter table member_audit_log enable row level security;
revoke all on member_audit_log from anon, authenticated;
revoke all on function member_audit_log_immutable() from public, anon, authenticated;
