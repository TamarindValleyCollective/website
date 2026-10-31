// Which WhatsApp conversations a given screen may show. The inbox is one shared set of conversations keyed by phone
// number; a "scope" narrows it to the people a particular module has a right to talk to (the guests on a stay, later
// perhaps a vendor list). Pure helpers only: the access check that uses them is netlify/functions/lib/whatsapp-scope.ts.
import { normalizeMobileNumber } from './phone.mjs';

/** 'all' is the whole inbox (the WhatsApp module); the others narrow it to one module's contacts. */
export const INBOX_SCOPES = ['all', 'stays'];

/** @param {string | null | undefined} raw @returns {'all' | 'stays' | null} null when the name is not a known scope */
export function parseScope(raw) {
  if (raw == null || raw === '') return 'all';
  return INBOX_SCOPES.includes(raw) ? /** @type {'all' | 'stays'} */ (raw) : null;
}

/** A mobile number as typed or stored, in the form conversations use (wa_phone: country code and digits, no plus). */
export function waPhoneFromMobile(raw) {
  const e164 = normalizeMobileNumber(raw ?? '');
  return e164 ? e164.replace(/^\+/, '') : null;
}

/** @param {Array<string | null | undefined>} mobiles */
export function phoneSet(mobiles) {
  return new Set(mobiles.map(waPhoneFromMobile).filter(Boolean));
}

/** @template {{ wa_phone: string }} T @param {T[]} conversations @param {Set<string> | null} phones null = unrestricted */
export function filterToScope(conversations, phones) {
  return phones ? conversations.filter((c) => phones.has(c.wa_phone)) : conversations;
}
