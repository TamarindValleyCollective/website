// Who may use the member portal (members.tvc.farm), and which households they
// can see. Sign-in is Google, verified exactly as for staff (signature,
// audience, expiry, verified email; tvc.farm / syntropic.in addresses must also
// come from our Workspace): verifyStaffToken in staff-access.ts. Google proves
// WHO someone is; the register decides whether they are INVITED:
//
//   * the verified email must belong to an active member_people row, and
//   * that person must have `can_login` on at least one household. Nobody has
//     it until a staff admin invites them (a database trigger caps it at two
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

// The profile picture Google shows for the member is kept so the core team can recognise them on the staff register.
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

export async function requireMember(req: Request): Promise<MemberAuthResult> {
  const verified = await verifyStaffToken(req);
  if (!verified.ok) return verified;

  try {
    const people = await select('member_people', `email=eq.${encodeURIComponent(verified.email)}&active=eq.true&select=id,full_name,privacy_notice_version,google_picture_url&limit=2`);
    if (people.length !== 1) return { ok: false, status: 403, error: NOT_INVITED }; // none, or (never expected) ambiguous
    const person = people[0];
    const links = await select('member_household_members', `person_id=eq.${person.id}&can_login=eq.true&select=household_id&order=household_id`);
    if (links.length === 0) return { ok: false, status: 403, error: NOT_INVITED };
    await keepPicture(person, verified.googlePicture);
    return { ok: true, member: { personId: person.id, name: person.full_name, householdIds: links.map((l: any) => l.household_id), privacyVersion: person.privacy_notice_version ?? null } };
  } catch (err) {
    console.error('[member-access] lookup failed', err);
    return { ok: false, status: 500, error: 'Server error' };
  }
}
