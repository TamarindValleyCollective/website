// Family members an owner adds to their own unit through the portal. Up to FAMILY_LOGIN_LIMIT family members
// can sign in per unit without anyone's approval; a further one is only a request the core team decides.
// A family member can sign in and use the unit (see, and later book stays), but never edits the unit's story,
// land documents or who is in the unit: that stays with the owners (members-me.mts checks the role).
//
// Pure: netlify/functions/members-me.mts validates with this, then writes.
import { normalizeMobileNumber } from './phone.mjs';

export const FAMILY_LOGIN_LIMIT = 2;
// Open requests per unit, so the core team's queue can't be filled by one household.
export const FAMILY_PENDING_LIMIT = 5;

const fail = (error) => ({ ok: false, error });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// body: { fullName: string, email: string, phone?: string|null }. The email is how they sign in (Google), so it is required.
export function validateFamilyAdd(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return fail('Nothing to do.');
  if (Object.keys(body).some((k) => !['fullName', 'email', 'phone'].includes(k))) return fail('Name, email and an optional mobile number are all we need.');
  if (typeof body.fullName !== 'string' || body.fullName.trim() === '') return fail('Enter their name.');
  const fullName = body.fullName.trim().replace(/\s+/g, ' ');
  if (fullName.length > 100) return fail('That name is too long.');
  if (typeof body.email !== 'string' || !EMAIL.test(body.email.trim()) || body.email.trim().length > 200) return fail('Enter the Google email they will sign in with.');
  const edit = { fullName, email: body.email.trim().toLowerCase(), phone: null };
  if (body.phone !== undefined && body.phone !== null && !(typeof body.phone === 'string' && body.phone.trim() === '')) {
    const n = typeof body.phone === 'string' ? normalizeMobileNumber(body.phone) : null;
    if (!n) return fail("That doesn't look like a valid mobile number. Use 10 digits for India. From another country, start with + and the country code, like +44 7911 123456.");
    edit.phone = n;
  }
  return { ok: true, edit };
}

// body: { personId: uuid }
export function validateFamilyRemove(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body) || typeof body.personId !== 'string' || !UUID.test(body.personId)) return fail('Nothing to do.');
  return { ok: true, personId: body.personId };
}

// body: { personId, fullName?, email?, phone? }: only what is present changes. An absent or empty email or mobile
// keeps what is on file (an owner is never sent a family member's email or mobile, so there is nothing to prefill).
export function validateFamilyUpdate(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body) || typeof body.personId !== 'string' || !UUID.test(body.personId)) return fail('Nothing to do.');
  const { personId, ...rest } = body;
  const given = Object.fromEntries(Object.entries(rest).filter(([, v]) => typeof v !== 'string' || v.trim() !== ''));
  if (Object.keys(given).length === 0) return fail('Nothing to change.');
  if (Object.keys(given).some((k) => !['fullName', 'email', 'phone'].includes(k))) return fail('You can change their name, email and mobile number.');
  const edit = {};
  if ('fullName' in given) {
    if (typeof given.fullName !== 'string') return fail('Enter their name.');
    edit.fullName = given.fullName.trim().replace(/\s+/g, ' ');
    if (edit.fullName.length > 100) return fail('That name is too long.');
  }
  if ('email' in given) {
    if (typeof given.email !== 'string' || !EMAIL.test(given.email.trim()) || given.email.trim().length > 200) return fail('Enter the Google email they will sign in with.');
    edit.email = given.email.trim().toLowerCase();
  }
  if ('phone' in given) {
    const n = typeof given.phone === 'string' ? normalizeMobileNumber(given.phone) : null;
    if (!n) return fail("That doesn't look like a valid mobile number. Use 10 digits for India. From another country, start with + and the country code, like +44 7911 123456.");
    edit.phone = n;
  }
  return { ok: true, personId, edit };
}

// Added straight away while the unit has room; otherwise it becomes a request (and a unit with too many open ones is refused).
export function familyAddOutcome({ familyLogins, pendingRequests }) {
  if (familyLogins < FAMILY_LOGIN_LIMIT) return 'add';
  if (pendingRequests < FAMILY_PENDING_LIMIT) return 'request';
  return 'full';
}
