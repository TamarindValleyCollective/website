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

export type MemberSession = {
  personId: string;
  name: string;
  // Households this person may sign in for (can_login = true), in a stable order.
  householdIds: string[];
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

export async function requireMember(req: Request): Promise<MemberAuthResult> {
  const verified = await verifyStaffToken(req);
  if (!verified.ok) return verified;

  try {
    const people = await select('member_people', `email=eq.${encodeURIComponent(verified.email)}&active=eq.true&select=id,full_name&limit=2`);
    if (people.length !== 1) return { ok: false, status: 403, error: NOT_INVITED }; // none, or (never expected) ambiguous
    const person = people[0];
    const links = await select('member_household_members', `person_id=eq.${person.id}&can_login=eq.true&select=household_id&order=household_id`);
    if (links.length === 0) return { ok: false, status: 403, error: NOT_INVITED };
    return { ok: true, member: { personId: person.id, name: person.full_name, householdIds: links.map((l: any) => l.household_id) } };
  } catch (err) {
    console.error('[member-access] lookup failed', err);
    return { ok: false, status: 500, error: 'Server error' };
  }
}
