// Generic mobile-number normalization, not tied to any one form. Plain ESM
// (not TypeScript), same reasoning as google-drive.mjs/accommodation.mjs -
// both Netlify Functions (bundled by esbuild) and Astro pages/components
// (via Vite) can import this directly, with no risk of a TS-file
// cross-boundary import failing to resolve in either bundler.
//
// Built on libphonenumber-js rather than hand-rolled regex (accommodation.mjs's
// prior implementation, replaced 2026-09-29) - real numbering-plan data
// catches formats regex kept needing manual patches for (a country code
// typed without '+', the "00" international-dialling prefix, a leading
// trunk '0'), and correctly distinguishes mobile from landline per country
// instead of a generic "N to M digits" guess. The '/mobile' entrypoint
// specifically ships metadata for mobile-capable numbers only, so a
// landline is rejected exactly as it should be, not just as "the wrong
// length".
import { parsePhoneNumberFromString } from 'libphonenumber-js/mobile';

// Normalizes a mobile number to E.164 (+<country code><digits>). `raw` can
// carry its own country code (with a leading '+', or the "00" international
// prefix some countries use instead) in any common spacing/punctuation
// style; without one, `defaultCountry` (an ISO 3166-1 alpha-2 code) is
// assumed - callers collecting mostly-Indian guests/customers pass 'IN'
// (the default), a form for a different audience would pass its own.
// Returns null for empty input (the field is typically optional) or
// anything that doesn't parse as a real, valid mobile number for its
// country, so callers can tell "not provided" apart from "provided but
// invalid" and reject the latter rather than silently dropping it.
export function normalizeMobileNumber(raw, defaultCountry = 'IN') {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let parsed;
  try {
    parsed = parsePhoneNumberFromString(trimmed, defaultCountry);
  } catch {
    return null;
  }
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number;
}
