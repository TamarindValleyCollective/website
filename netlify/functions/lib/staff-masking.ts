// Server-side masking for the internal admin Functions (issue #89). Masking
// has to happen in the Function's response, not the page: anything sent to
// the browser is visible in devtools whatever the UI draws.
//
// Field classes (each module's Function applies them in its response mapper):
//   * contact details (email, phone) — never sent to the browser at all, for
//     any role. Staff can act on them (a reply is sent to the number) but not
//     read them; replacing one is a write-only form field.
//   * personal names — sent in full to roles that operate the module
//     (`admin`, `user`) and masked for `read_only` (auditors).
//   * free-form content people wrote (message bodies) — sent to any role that
//     can `view`, since that content is the module's whole purpose.
import type { Role } from './staff-registry';

// Names stay visible only where the role needs them to do the job.
export function canSeeNames(role: Role): boolean {
  return role !== 'read_only';
}

// "priya.raman@tvc.farm" -> "p••••@tvc.farm". Keeps the first character of the
// local part and the domain, so it identifies the account to someone who
// already knows it without spelling out the address. The dots are capped (as
// in maskName) so the length of the local part isn't given away either.
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '•'.repeat(4);
  const local = [...email.slice(0, at)];
  return `${local[0]}${'•'.repeat(Math.min(Math.max(local.length - 1, 3), 4))}${email.slice(at)}`;
}

// "Priya Raman" -> "P•••• R••••". Keeps the first letter of each word (so
// an auditor can still tell threads apart) and caps the dots so the length
// doesn't give the name away. Uses code points, not UTF-16 units, so Kannada
// and Tamil names aren't split mid-character.
export function maskName(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const chars = [...word];
      return chars[0] + '•'.repeat(Math.min(chars.length - 1, 4));
    })
    .join(' ');
}
