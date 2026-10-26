// Who may use the member portal (members.tvc.farm), and which households they
// can see. Sign-in is Google, verified exactly as for admins (signature,
// audience, expiry, verified email; tvc.farm / syntropic.in addresses must also
// come from our Workspace): verifyStaffToken in staff-access.ts. Google proves
// WHO someone is; the register decides whether they are INVITED:
//
//   * the verified email must belong to an active member_people row, and
//   * that person must have `can_login` on at least one household. Nobody has
//     it until an admin invites them (a database trigger caps it at two
//     people per household).
//
// Everyone else gets the same 403, whether the email is unknown, inactive or
// simply not invited yet, so the response never says which people exist.
//
// A member only ever sees households they can_login on. This is the boundary
// that keeps the register private: members-me.mts reads only those households.
import { restHeaders } from '../../../scripts/lib/supabase.mjs';
import { verifyStaffToken } from './staff-access';
import { PRIVACY_NOTICE_VERSION } from '../../../scripts/lib/member-privacy.mjs';
import { pictureUpdate } from '../../../scripts/lib/member-google-picture.mjs';

export type MemberSession = {
  personId: string;
  name: string;
  // Households this person may sign in for (can_login = true), in a stable order.
  householdIds: string[];
  // Their role in each of those households (owner, family or non_owner). Family members sign in with fewer rights.
  roles: Record<string, string>;
  // The privacy notice version they last acknowledged (null = never); see member-privacy.mjs.
  privacyVersion: number | null;
};

export type MemberAuthResult =
  | { ok: true; member: MemberSession }
  | { ok: false; status: 401 | 403 | 500; error: string };

const NOT_INVITED = 'This account has not been invited to the member portal yet. Please contact the core team.';

async function select(table: string, query: string): Promise<any[]> {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error('Missing SUPABASE_URL');
  const res = await fetch(`${url}/rest/v1/${table}?${query}`, { headers: restHeaders() });
  if (!res.ok) throw new Error(`${table} select failed: ${res.status}`);
  return res.json();
}

// The profile picture Google shows for the member is kept so the core team can recognise them on the admin register.
// Written only once they have accepted a privacy notice that says so (a refresh, or a clearing if they removed it
// from Google), and only after the change is logged, as for every change to a member's record. A failure here never
// stops sign-in: the picture just stays as it was.
async function keepPicture(person: { id: string; privacy_notice_version: number | null; google_picture_url: string | null }, seen: string | null): Promise<void> {
  const change = pictureUpdate({ stored: person.google_picture_url, seen, acceptedVersion: person.privacy_notice_version, requiredVersion: PRIVACY_NOTICE_VERSION });
  if (!change.write) return;
  try {
    const url = process.env.SUPABASE_URL;
    if (!url) return;
    const log = await fetch(`${url}/rest/v1/member_audit_log`, { method: 'POST', headers: restHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify({ actor_person_id: person.id, action: 'member.google_picture', detail: { fields: ['google_picture_url'], cleared: change.value === null } }) });
    if (!log.ok) return;
    await fetch(`${url}/rest/v1/member_people?id=eq.${person.id}`, { method: 'PATCH', headers: restHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify({ google_picture_url: change.value }) });
  } catch (err) {
    console.error('[member-access] could not keep the Google picture', err);
  }
}

// Everything /api/members-me/home shows, as the database function member_home_bundle (migration 0073) returns it.
export type MemberHomeBundle = {
  person: { id: string; full_name: string; privacy_notice_version: number | null; google_picture_url: string | null; tour_seen_through: number | null };
  links: { household_id: string; role: string | null }[];
  households: any[];
  memberships: any[];
  plots: any[];
  house_pattas: any[];
  notes: any[];
  docs: any[];
  family_pending: number;
  people: any[];
};

// requireMember plus the home page's data in ONE database round trip, for the sign-in path where the wait is felt.
// Same rules as requireMember: the same 403 for anyone not invited, and the same picture keep. If the database function
// is missing (not applied yet) or fails, this is requireMember alone and the caller reads the data the old way.
export async function requireMemberWithHome(req: Request): Promise<MemberAuthResult & { bundle?: MemberHomeBundle }> {
  const verified = await verifyStaffToken(req);
  if (!verified.ok) return verified;
  const url = process.env.SUPABASE_URL;
  if (!url) return requireMember(req);
  let bundle: MemberHomeBundle | null;
  try {
    const res = await fetch(`${url}/rest/v1/rpc/member_home_bundle`, { method: 'POST', headers: restHeaders(), body: JSON.stringify({ p_email: verified.email }) });
    if (!res.ok) throw new Error(`member_home_bundle failed: ${res.status}`);
    bundle = await res.json();
  } catch (err) {
    console.error('[member-access] home bundle unavailable, using separate reads', err);
    return requireMember(req);
  }
  if (!bundle) return { ok: false, status: 403, error: NOT_INVITED };
  const { person, links } = bundle;
  await keepPicture({ id: person.id, privacy_notice_version: person.privacy_notice_version, google_picture_url: person.google_picture_url }, verified.googlePicture);
  return {
    ok: true,
    member: { personId: person.id, name: person.full_name, householdIds: links.map((l) => l.household_id), roles: Object.fromEntries(links.map((l) => [l.household_id, l.role ?? 'owner'])), privacyVersion: person.privacy_notice_version ?? null },
    bundle,
  };
}

export async function requireMember(req: Request): Promise<MemberAuthResult> {
  const verified = await verifyStaffToken(req);
  if (!verified.ok) return verified;

  try {
    const people = await select('member_people', `email=eq.${encodeURIComponent(verified.email)}&active=eq.true&select=id,full_name,privacy_notice_version,google_picture_url&limit=2`);
    if (people.length !== 1) return { ok: false, status: 403, error: NOT_INVITED }; // none, or (never expected) ambiguous
    const person = people[0];
    const links = await select('member_household_members', `person_id=eq.${person.id}&can_login=eq.true&select=household_id,role&order=household_id`);
    if (links.length === 0) return { ok: false, status: 403, error: NOT_INVITED };
    await keepPicture(person, verified.googlePicture);
    return { ok: true, member: { personId: person.id, name: person.full_name, householdIds: links.map((l: any) => l.household_id), roles: Object.fromEntries(links.map((l: any) => [l.household_id, l.role ?? 'owner'])), privacyVersion: person.privacy_notice_version ?? null } };
  } catch (err) {
    console.error('[member-access] lookup failed', err);
    return { ok: false, status: 500, error: 'Server error' };
  }
}
