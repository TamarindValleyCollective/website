// What a member may change about THEMSELVES through the portal. Deliberately
// small: contact details freely, everything that defines membership (name,
// household, house, plots) only through the core team (admin editing, or later a
// reviewed change request). Email is the sign-in identity, so changing it needs
// a re-verification step that isn't built yet and is not accepted here.
//
// Pure: netlify/functions/members-me.mts validates with this, then writes.
import { normalizeMobileNumber } from './phone.mjs';

const fail = (error) => ({ ok: false, error });

// body: { phone?: string|null, directoryVisible?: boolean }
//   phone: a string replaces it, null (or empty) removes it, absent leaves it.
export function validateProfileEdit(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return fail('Nothing to do.');
  const unknown = Object.keys(body).filter((k) => k !== 'phone' && k !== 'directoryVisible');
  if (unknown.length) return fail('You can change your mobile number and your directory listing here. Ask the core team to change anything else.');

  const edit = {};
  if ('phone' in body && body.phone !== undefined) {
    if (body.phone === null || (typeof body.phone === 'string' && body.phone.trim() === '')) edit.phone = null;
    else if (typeof body.phone !== 'string') return fail('Mobile number must be text.');
    else {
      const n = normalizeMobileNumber(body.phone);
      if (!n) return fail("That doesn't look like a valid mobile number. Use 10 digits for India. From another country, start with + and the country code, like +44 7911 123456.");
      edit.phone = n;
    }
  }
  if ('directoryVisible' in body && body.directoryVisible !== undefined) {
    if (typeof body.directoryVisible !== 'boolean') return fail('Directory listing must be on or off.');
    edit.directoryVisible = body.directoryVisible;
  }
  if (Object.keys(edit).length === 0) return fail('Nothing to change.');
  return { ok: true, edit };
}

// For the audit log: which fields changed, never their values (a phone number is
// personal data). The directory setting is not personal, so its value is kept.
export function profileAuditDetail(edit) {
  return {
    fields: Object.keys(edit),
    ...('directoryVisible' in edit ? { directoryVisible: edit.directoryVisible } : {}),
  };
}
